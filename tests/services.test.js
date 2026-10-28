// Tests for the network clients: services/todoist.js, services/demo.js and services/claude.js run against
// FakeTransport (no network at all), and services/http.js runs against a throwaway server on 127.0.0.1.
import Soup from 'gi://Soup?version=3.0';

import {getLang, setLang} from '../extension/core/l10n.js';
import {Task} from '../extension/core/models.js';
import {utcString} from '../extension/core/dates.js';
import {
    ClaudeClient, ClaudeError, DEFAULT_CLAUDE_MODEL, buildBreakdownRequest, parseSteps,
} from '../extension/services/claude.js';
import {DemoService, demoEvents} from '../extension/services/demo.js';
import {SoupTransport} from '../extension/services/http.js';
import {TodoError, TodoistClient} from '../extension/services/todoist.js';
import {FakeTransport, sleep} from './helpers.js';

const BASE = 'https://api.todoist.com/api/v1/';
const ok = text => ({status: 200, text});
const todoist = script => {
    const transport = new FakeTransport(script);
    return {transport, client: new TodoistClient('tok', transport)};
};
// The first rejection of `promise`, or null when it resolves.
const caught = async promise => {
    try {
        await promise;
    } catch (e) {
        return e;
    }
    return null;
};

async function todoistUrls(t) {
    const tr = new FakeTransport([ok('{"results":[],"next_cursor":"c2"}'), ok('{"results":[],"next_cursor":null}')]);
    await new TodoistClient('tok', tr).activeTasks('today | overdue');
    t.eq(tr.calls[0].url, `${BASE}tasks/filter?limit=200&query=today%20%7C%20overdue`, 'filter query encoded');
    t.check(tr.calls[1].url.includes('cursor=c2'), 'follows the cursor');
    t.eq(tr.calls[1].url, `${BASE}tasks/filter?cursor=c2&limit=200&query=today%20%7C%20overdue`, 'query keys are sorted');
    t.eq(tr.calls.length, 2, 'stops when next_cursor is null');
    t.eq(tr.calls[0].headers.Authorization, 'Bearer tok', 'bearer token');
    t.eq(tr.calls[0].method, 'GET', 'a list is a GET');
    t.eq(tr.calls[0].body, null, 'a GET has no body');
    t.check(!('X-Request-Id' in tr.calls[0].headers), 'no request id on a GET');

    const plus = new FakeTransport([ok('{"results":[]}')]);
    await new TodoistClient('t', plus).activeTasks('#A+B');
    t.check(plus.calls[0].url.includes('%2B'), 'plus encoded');
    t.check(!plus.calls[0].url.includes('+'), 'no raw plus left in the url');

    const hard = new FakeTransport([ok('{"results":[]}')]);
    await new TodoistClient('t', hard).activeTasks('Việc & (a|b)');
    t.eq(hard.calls[0].url, `${BASE}tasks/filter?limit=200&query=Vi%E1%BB%87c%20%26%20(a%7Cb)`, 'unicode, ampersand and bar encoded');

    const done = new FakeTransport([ok('{"results":[]}')]);
    await new TodoistClient('t', done).completedTasks(new Date(Date.UTC(2026, 9, 24, 17, 0, 0)), new Date(Date.UTC(2026, 9, 25, 3, 0, 0, 500)));
    t.eq(done.calls[0].url,
        `${BASE}tasks/completed/by_completion_date?limit=200&since=2026-10-24T17%3A00%3A00Z&until=2026-10-25T03%3A00%3A00Z`,
        'completed tasks: since/until as UTC strings');

    const stats = new FakeTransport([ok('{}')]);
    await new TodoistClient('t', stats).stats();
    t.eq(stats.calls[0].url, `${BASE}tasks/completed/stats`, 'no query, no question mark');
}

async function todoistReading(t) {
    const page = JSON.stringify({
        results: [
            {id: '1', content: 'A', priority: 4, due: {date: '2026-10-25', string: 'today'}},
            {id: '2', content: 'B', checked: false, labels: ['x']},
        ],
        next_cursor: null,
    });
    const {client} = todoist([ok(page)]);
    const tasks = await client.activeTasks('today');
    t.eq(tasks.map(task => task.id), ['1', '2'], 'tasks read from results');
    t.check(tasks.every(task => task instanceof Task), 'results are Task objects');
    t.eq([tasks[0].priority, tasks[0].dueDay, tasks[1].labels], [4, '2026-10-25', ['x']], 'task fields read');

    const items = await todoist([ok('{"items":[{"id":"9","content":"I"}]}')]).client.activeTasks('x');
    t.eq(items.map(task => task.id), ['9'], 'items is used when there is no results');
    const both = await todoist([ok('{"results":[{"id":"1","content":"R"}],"items":[{"id":"9","content":"I"}]}')]).client.activeTasks('x');
    t.eq(both.map(task => task.id), ['1'], 'results wins over items');
    const none = await todoist([ok('{"next_cursor":null}')]).client.activeTasks('x');
    t.eq(none, [], 'neither results nor items is an empty list');

    // One task the app cannot read is skipped; the rest of the page still counts.
    const warnings = [];
    const mixed = await new TodoistClient('tok', new FakeTransport([
        ok('{"results":[{"id":"1","content":"A"},{"id":2,"content":"B"},{"id":"3"},{"id":"4","content":"D"}]}')]),
    {warn: message => warnings.push(message)}).activeTasks('x');
    t.eq(mixed.map(task => task.id), ['1', '4'], 'a task that cannot be read is skipped');
    t.eq(warnings, ['Todoist: skipped 2 task(s) that could not be read'], 'the skipped tasks are logged once, without task text');

    // Pages: collected in order, an empty cursor ends the list, ten pages at most.
    const two = await todoist([
        ok('{"results":[{"id":"1","content":"A"}],"next_cursor":"n1"}'),
        ok('{"results":[{"id":"2","content":"B"}],"next_cursor":""}'),
        ok('{"results":[{"id":"3","content":"C"}]}'),
    ]);
    t.eq((await two.client.activeTasks('x')).map(task => task.id), ['1', '2'], 'pages are joined in order');
    t.eq(two.transport.calls.length, 2, 'an empty next_cursor ends the paging');

    const endless = todoist(Array.from({length: 12}, () => ok('{"results":[{"id":"x","content":"c"}],"next_cursor":"n"}')));
    const many = await endless.client.activeTasks('x');
    t.eq(endless.transport.calls.length, 10, 'at most 10 pages');
    t.eq(many.length, 10, 'all tasks of the 10 pages are returned');
    t.check(!endless.transport.calls[0].url.includes('cursor='), 'the first page has no cursor');
    t.check(endless.transport.calls[9].url.includes('cursor=n'), 'the last page has the cursor');

    // A reply that is not a task page is an error, not an empty list.
    for (const [text, name] of [['not json', 'text that is not JSON'], ['[]', 'a JSON list'], ['null', 'null'],
        ['{"results":"x"}', 'results that is not a list']]) {
        const e = await caught(todoist([ok(text)]).client.activeTasks('x'));
        t.check(e instanceof TodoError && e.kind === 'http' && e.status === 200, `an unreadable page is an error: ${name}`);
    }

    // Stats.
    const stats = await todoist([ok('{"completed_count":7,"goals":{"daily_goal":3,"current_daily_streak":{"count":4}},"karma":12.5}')])
        .client.stats();
    t.eq(stats, {streak: 4, completedCount: 7, daysItems: [], dailyGoal: 3, karma: 12.5}, 'stats read');
    const badStats = await caught(todoist([ok('oops')]).client.stats());
    t.check(badStats instanceof TodoError, 'unreadable stats are a TodoError');

    // completedTasks reads the same page shape.
    const completed = await todoist([ok('{"items":[{"id":"7","content":"Done","completed_at":"2026-10-25T02:00:00Z"}]}')])
        .client.completedTasks(new Date(0), new Date(1000));
    t.eq(completed.map(task => task.completedAt), ['2026-10-25T02:00:00Z'], 'completed tasks read');
}

async function todoistWriting(t) {
    const tr2 = new FakeTransport([ok('{"id":"1","content":"A"}')]);
    const added = await new TodoistClient('tok', tr2).addTask({content: 'A', dueString: 'tomorrow', priority: 4, parentId: 'p'});
    t.eq(JSON.parse(tr2.calls[0].body), {content: 'A', priority: 4, due_string: 'tomorrow', due_lang: 'en', parent_id: 'p'}, 'add body');
    t.check(typeof tr2.calls[0].headers['X-Request-Id'] === 'string' && tr2.calls[0].headers['X-Request-Id'] !== '', 'request id on POST');
    t.eq([tr2.calls[0].method, tr2.calls[0].url, tr2.calls[0].headers['Content-Type']], ['POST', `${BASE}tasks`, 'application/json'],
        'add is a JSON POST to tasks');
    t.check(added instanceof Task && added.id === '1' && added.content === 'A', 'addTask returns the new Task');

    const plain = todoist([ok('{"id":"2","content":"B"}')]);
    await plain.client.addTask({content: 'B', priority: 1});
    t.eq(JSON.parse(plain.transport.calls[0].body), {content: 'B', priority: 1}, 'no due and no parent: only content and priority');

    for (const [text, name] of [['not json', 'text that is not JSON'], ['{"id":5,"content":"x"}', 'a task without a string id'], ['', 'an empty reply']]) {
        const none = await todoist([ok(text)]).client.addTask({content: 'C', priority: 1});
        t.eq(none, null, `addTask gives null when the reply cannot be read: ${name}`);
    }

    const quick = todoist([ok('{}')]);
    await quick.client.quickAdd('buy milk #Home p1');
    t.eq([quick.transport.calls[0].method, quick.transport.calls[0].url, JSON.parse(quick.transport.calls[0].body)],
        ['POST', `${BASE}tasks/quick`, {text: 'buy milk #Home p1'}], 'quickAdd');

    const w = todoist([{status: 204, text: ''}, {status: 204, text: ''}, ok('{}'), {status: 204, text: ''}]);
    await w.client.close('abc');
    await w.client.reopen('abc');
    await w.client.reschedule('abc', 'tomorrow');
    await w.client.delete('abc');
    const [close, reopen, reschedule, del] = w.transport.calls;
    t.eq([close.method, close.url, close.body], ['POST', `${BASE}tasks/abc/close`, null], 'close');
    t.eq([reopen.method, reopen.url, reopen.body], ['POST', `${BASE}tasks/abc/reopen`, null], 'reopen');
    t.eq([reschedule.method, reschedule.url, JSON.parse(reschedule.body)],
        ['POST', `${BASE}tasks/abc`, {due_string: 'tomorrow', due_lang: 'en'}], 'reschedule');
    t.eq([del.method, del.url, del.body], ['DELETE', `${BASE}tasks/abc`, null], 'delete');
    t.check(!('Content-Type' in close.headers), 'no content type without a body');
    const ids = w.transport.calls.map(call => call.headers['X-Request-Id']);
    t.check(ids.every(id => typeof id === 'string' && id !== '') && new Set(ids).size === ids.length, 'each write has its own request id');
    t.check(w.transport.calls.every(call => call.headers.Authorization === 'Bearer tok'), 'every request carries the token');

    const odd = todoist([ok('{}')]);
    await odd.client.close('a/b?c');
    t.eq(odd.transport.calls[0].url, `${BASE}tasks/a%2Fb%3Fc/close`, 'an id cannot change the path');
}

async function todoistErrors(t) {
    const fail = (script, run = c => c.close('1')) => caught(run(todoist(script).client));
    const e401 = await fail([{status: 401, text: ''}]);
    t.check(e401 instanceof TodoError && e401 instanceof Error && e401.name === 'TodoError' && e401.kind === 'unauthorized', '401');
    t.eq(e401.status, 401, '401 keeps the status');
    t.check((await fail([{status: 429, text: ''}]))?.kind === 'rateLimited', '429');
    t.check((await fail([{throws: 'offline'}]))?.kind === 'network', 'network');
    t.eq(await fail([{status: 200, text: ''}]), null, 'an empty 2xx reply to a write is fine');

    const long = 'x'.repeat(300);
    const e500 = await fail([{status: 500, text: long}]);
    t.eq([e500.kind, e500.status], ['http', 500], '500 is an http error with its status');
    t.eq(e500.body, 'x'.repeat(200), 'the body is cut to 200 characters');
    const e404 = await fail([{status: 404, text: 'nope'}]);
    t.eq([e404.kind, e404.status], ['http', 404], '404 is an http error');
    const e301 = await fail([{status: 301, text: ''}]);
    t.eq(e301.kind, 'http', 'a status outside 2xx is an error');

    const savedLang = getLang();
    try {
        setLang('en');
        t.eq(e401.userMessage, 'The Todoist token is invalid or expired.', 'unauthorized message (en)');
        t.eq((await fail([{status: 429, text: ''}])).userMessage, 'Todoist is rate limiting, retrying in a few minutes.', 'rate limit message (en)');
        t.eq(e500.userMessage, `HTTP 500: ${'x'.repeat(200)}`, 'http message keeps 200 characters (en)');
        t.eq(e404.userMessage, 'HTTP 404: nope', 'http message');
        const offline = await fail([{throws: 'offline'}]);
        t.eq(offline.userMessage, 'Network error: offline', 'network message (en)');
        t.eq(offline.message, 'Network error: offline', 'the Error message is readable too');
        setLang('vi');
        t.eq(e401.userMessage, 'Token Todoist không hợp lệ hoặc đã hết hạn.', 'unauthorized message (vi)');
        t.eq(offline.userMessage, 'Lỗi mạng: offline', 'network message (vi)');
        t.eq(e404.userMessage, 'HTTP 404: nope', 'http message does not depend on the language');
    } finally {
        setLang(savedLang);
    }

    const mid = await fail([ok('{"results":[{"id":"1","content":"A"}],"next_cursor":"n"}'), {status: 429, text: ''}], c => c.activeTasks('x'));
    t.eq(mid.kind, 'rateLimited', 'an error on a later page fails the whole list');

    const echo = await caught(new TodoistClient('tok-secret-123', new FakeTransport([{status: 500, text: 'bad token tok-secret-123 here'}])).close('1'));
    t.check(echo.userMessage.startsWith('HTTP 500: bad token ') && !echo.userMessage.includes('tok-secret-123')
        && !echo.message.includes('tok-secret-123') && !echo.body.includes('tok-secret-123'),
    'the token never appears in an error message, even when the server echoes it');
}

async function demo(t) {
    const savedLang = getLang();
    setLang('en');
    try {
        const now = new Date(2026, 9, 25, 10, 30, 0);
        const service = new DemoService({now: () => now});
        const active = await service.activeTasks('today | overdue');
        t.eq(active.map(task => [task.id, task.content, task.priority]),
            [['1', 'Write the weekly report', 4], ['2', 'Call client ABC', 3], ['3', "Reply to the boss's email", 1]],
            'demo sample tasks');
        t.eq(active.map(task => [task.due.date, task.due.string]),
            [['2026-10-25', 'today'], ['2026-10-25T11:00:00', 'today'], ['2026-10-22', 'Monday']],
            'demo due dates are relative to now');
        t.check(active.every(task => task instanceof Task), 'demo tasks are Task objects');
        t.eq(await service.completedTasks(new Date(0), now), [], 'nothing completed at first');
        t.eq(await service.stats(), {streak: 4, completedCount: 42, daysItems: [], dailyGoal: 3, karma: 1234}, 'demo stats');

        const late = new DemoService({now: () => new Date(2026, 9, 25, 23, 30, 0)});
        t.eq((await late.activeTasks('x'))[1].due.date, '2026-10-25T23:00:00', 'the hour is clamped to 23');

        // Closing moves a task from the list to the completed list.
        await service.close('1');
        t.eq((await service.activeTasks('x')).map(task => task.id), ['2', '3'], 'closed task leaves the active list');
        const done = await service.completedTasks(new Date(0), now);
        t.eq(done.map(task => task.id), ['1'], 'closed task shows up as completed');
        t.eq([done[0].checked, done[0].completedAt], [true, utcString(now)], 'completed task is checked and has a time');
        t.eq((await service.stats()).completedCount, 43, 'stats count the completed task');
        await service.close('nope');
        t.eq((await service.completedTasks(new Date(0), now)).length, 1, 'closing an unknown id does nothing');

        await service.reopen('1');
        const reopened = await service.activeTasks('x');
        t.eq(reopened.map(task => task.id), ['2', '3', '1'], 'reopened task is active again, at the end');
        t.eq([reopened[2].checked, reopened[2].completedAt], [false, null], 'reopened task is not completed');
        t.eq(await service.completedTasks(new Date(0), now), [], 'reopened task is no longer completed');
        await service.reopen('nope');

        // What the caller gets is a copy.
        const copy = await service.activeTasks('x');
        copy[0].content = 'changed';
        copy.pop();
        t.eq((await service.activeTasks('x')).map(task => task.content),
            ['Call client ABC', "Reply to the boss's email", 'Write the weekly report'], 'a returned list is a copy');

        // Adding.
        const today = await service.addTask({content: 'New', dueString: 'today', priority: 2, parentId: null});
        t.eq([today.id, today.due.date, today.due.string, today.priority], ['101', '2026-10-25', 'today', 2], 'added task due today');
        t.eq((await service.activeTasks('x')).map(task => task.id), ['2', '3', '1', '101'], 'a task due today is in the list');
        const tomorrow = await service.addTask({content: 'Later', dueString: 'tomorrow', priority: 1});
        t.eq([tomorrow.id, tomorrow.due.date], ['102', '2026-10-26'], 'added task due tomorrow');
        t.check(!(await service.activeTasks('x')).some(task => task.id === '102'), 'a task due tomorrow is not in the list');
        const undated = await service.addTask({content: 'Someday', dueString: null, priority: 1});
        t.eq([undated.id, undated.due], ['103', null], 'added task without a date');
        t.check(!(await service.activeTasks('x')).some(task => task.id === '103'), 'a task without a date is not in the list');
        await service.quickAdd('Buy milk');
        const quick = (await service.activeTasks('x')).find(task => task.content === 'Buy milk');
        t.eq([quick.id, quick.due.date, quick.priority], ['104', '2026-10-25', 1], 'quickAdd adds a task due today');

        // Rescheduling.
        await service.reschedule('2', 'today at 15:00');
        t.eq((await service.activeTasks('x')).find(task => task.id === '2').due.date, '2026-10-25T15:00:00', 'reschedule to a time today');
        await service.reschedule('3', 'Friday');
        const friday = (await service.activeTasks('x')).find(task => task.id === '3');
        t.eq([friday.due.date, friday.due.string, friday.due.isRecurring], ['2026-10-25', 'Friday', null], 'reschedule to another phrase');
        await service.reschedule('1', 'tomorrow');
        await service.reschedule('101', 'no date');
        t.eq((await service.activeTasks('x')).map(task => task.id), ['2', '3', '104'], 'tomorrow and no date leave the list');
        await service.reschedule('nope', 'tomorrow');

        // Deleting takes the sub-tasks along.
        await service.addTask({content: 'Step', dueString: 'today', priority: 1, parentId: '2'});
        await service.delete('2');
        t.eq((await service.activeTasks('x')).map(task => task.id), ['3', '104'], 'delete removes the task and its sub-tasks');

        // Vietnamese texts are picked when the task list is built.
        setLang('vi');
        t.eq((await new DemoService({now: () => now}).activeTasks('x'))[0].content, 'Viết báo cáo tuần', 'sample tasks follow the language');

        // The default clock is the real one.
        t.eq((await new DemoService().activeTasks('x')).length, 3, 'DemoService works without options');
        t.eq(new DemoService().abort(), undefined, 'abort() is there and does nothing');
    } finally {
        setLang(savedLang);
    }
}

function demoEventChecks(t) {
    const savedLang = getLang();
    try {
        setLang('en');
        const now = new Date(2026, 9, 25, 10, 30, 0);
        const events = demoEvents(now);
        t.eq(events.map(event => [event.id, event.title, event.joinURL]),
            [['demo-1', 'Team sync', 'https://meet.google.com/abc-defg-hij'], ['demo-2', 'Client meeting', null]], 'demo events');
        t.eq(events.map(event => [event.start.getTime(), event.end.getTime()]),
            [[new Date(2026, 9, 25, 11, 0).getTime(), new Date(2026, 9, 25, 12, 0).getTime()],
                [new Date(2026, 9, 25, 14, 0).getTime(), new Date(2026, 9, 25, 14, 45).getTime()]],
            'demo events start in 1 and 4 hours and last 60 and 45 minutes');
        t.check(events.every(event => event.start instanceof Date && event.end instanceof Date), 'demo event times are Dates');
        const night = demoEvents(new Date(2026, 9, 25, 22, 30, 0));
        t.eq(night.map(event => event.start.getHours()), [23, 23], 'demo event hours are clamped to 23');
        t.check(demoEvents().length === 2, 'demoEvents works without a clock');
        setLang('vi');
        t.eq(demoEvents(now).map(event => event.title), ['Họp team', 'Gặp khách hàng'], 'demo event titles follow the language');
    } finally {
        setLang(savedLang);
    }
}

// The answer from DevTools.swift: a thinking block, a text block with padded and empty steps.
const ANSWER = '{"content":[{"type":"thinking","thinking":""},{"type":"text","text":"{\\"steps\\":[\\"Mở file\\",\\" Viết dàn ý \\",\\"\\"]}"}],"stop_reason":"end_turn"}';
const answerWith = steps => JSON.stringify({content: [{type: 'text', text: JSON.stringify({steps})}], stop_reason: 'end_turn'});

const SYSTEM_EN = 'You help someone start a task they keep postponing. Split it into 3–5 concrete steps, each doable in 15–30 minutes, starting with a verb, under 70 characters. The first step must be the easiest one to start right away. Write in English.';
const SYSTEM_VI = 'Bạn giúp người dùng bắt đầu một việc họ cứ trì hoãn. Chia việc thành 3–5 bước cụ thể, mỗi bước làm xong trong 15–30 phút, bắt đầu bằng động từ, dưới 70 ký tự. Bước đầu tiên phải là bước dễ nhất để bắt tay vào ngay. Viết bằng tiếng Việt.';

async function claude(t) {
    const savedLang = getLang();
    try {
        setLang('en');
        t.eq(DEFAULT_CLAUDE_MODEL, 'claude-opus-5-5', 'default model');
        const req = buildBreakdownRequest({key: 'k', model: 'claude-opus-5-5', title: 'T', notes: 'N'});
        const body = JSON.parse(req.body);
        t.eq([body.model, body.fallbacks, body.output_config.effort], ['claude-opus-5-5', 'default', 'low'], 'Claude request');
        t.eq(req.headers['anthropic-beta'], 'server-side-fallback-2026-07-01', 'fallback beta header');
        t.eq([req.method, req.url], ['POST', 'https://api.anthropic.com/v1/messages'], 'Claude request method and url');
        t.eq(req.headers, {
            'content-type': 'application/json',
            'x-api-key': 'k',
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'server-side-fallback-2026-07-01',
        }, 'Claude request headers');
        t.eq(body, {
            model: 'claude-opus-5-5',
            max_tokens: 4000,
            fallbacks: 'default',
            output_config: {
                effort: 'low',
                format: {
                    type: 'json_schema',
                    schema: {
                        type: 'object',
                        properties: {steps: {type: 'array', items: {type: 'string'}}},
                        required: ['steps'],
                        additionalProperties: false,
                    },
                },
            },
            system: SYSTEM_EN,
            messages: [{role: 'user', content: 'Task: T\nNotes: N'}],
        }, 'Claude request body');
        t.check(!req.body.includes('"k"'), 'the key is only in the header');

        for (const notes of [null, undefined, '']) {
            const plain = JSON.parse(buildBreakdownRequest({key: 'k', model: 'm', title: 'T', notes}).body);
            t.eq(plain.messages[0].content, 'Task: T', `no notes line for ${JSON.stringify(notes) ?? 'undefined'}`);
        }
        setLang('vi');
        const vi = JSON.parse(buildBreakdownRequest({key: 'k', model: 'm', title: 'Việc', notes: 'Ghi'}).body);
        t.eq([vi.system, vi.messages[0].content], [SYSTEM_VI, 'Việc: Việc\nGhi chú: Ghi'], 'Claude request in Vietnamese');
        setLang('en');

        // Answers (DevTools.swift).
        t.eq(parseSteps(ANSWER), ['Mở file', 'Viết dàn ý'], 'Claude steps parsed');
        const refused = await caught(Promise.resolve().then(() => parseSteps('{"content":[],"stop_reason":"refusal"}')));
        t.check(refused instanceof ClaudeError && refused.kind === 'refused', 'Claude refusal detected');
        t.eq(parseSteps(answerWith(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])), ['a', 'b', 'c', 'd', 'e', 'f'], 'at most 6 steps');
        t.eq(parseSteps(answerWith(['  ', 'a\n', '\t', ' b'])), ['a', 'b'], 'blank steps are dropped, the rest trimmed');
        t.eq(parseSteps('{"content":[{"type":"text","text":"{\\"steps\\":[\\"x\\"]}"}]}'), ['x'], 'stop_reason may be missing');
        t.eq(parseSteps('{"content":[{"type":"text","text":"{\\"steps\\":[\\"x\\"]}"}],"stop_reason":null}'), ['x'], 'stop_reason may be null');
        t.eq(parseSteps(JSON.stringify({content: [{type: 'text', text: '{"steps":["first"]}'}, {type: 'text', text: '{"steps":["second"]}'}]})),
            ['first'], 'the first text block is used');
        const decode = async (text, name) => {
            const e = await caught(Promise.resolve().then(() => parseSteps(text)));
            t.check(e instanceof ClaudeError && e.kind === 'decoding', `unreadable answer: ${name}`);
        };
        await decode('not json', 'not JSON');
        await decode('null', 'null');
        await decode('{}', 'no content');
        await decode('{"content":"x"}', 'content is not a list');
        await decode('{"content":[]}', 'no text block');
        await decode('{"content":[{"type":"thinking"}]}', 'only a thinking block');
        await decode('{"content":[{"text":"x"}]}', 'a block without a type');
        await decode('{"content":[{"type":"text"}]}', 'a text block without text');
        await decode('{"content":[{"type":"text","text":"nope"}]}', 'text that is not JSON');
        await decode('{"content":[{"type":"text","text":"{}"}]}', 'no steps');
        await decode(answerWith([]), 'an empty step list');
        await decode(answerWith(['', '  ']), 'only blank steps');
        await decode(answerWith(['a', 5]), 'a step that is not text');
        await decode('{"content":[{"type":"text","text":"{\\"steps\\":\\"a\\"}"}]}', 'steps that is not a list');
        await decode('{"content":[],"stop_reason":5}', 'a stop_reason that is not text');

        // The client.
        const ok200 = text => [{status: 200, text}];
        const run = (script, key = 'sk-ant-secret', model = 'claude-opus-5-5') => {
            const transport = new FakeTransport(script);
            return {transport, client: new ClaudeClient(key, model, transport)};
        };
        const good = run(ok200(ANSWER));
        t.eq(await good.client.breakdown('T', 'N'), ['Mở file', 'Viết dàn ý'], 'breakdown returns the steps');
        t.eq(good.transport.calls[0], buildBreakdownRequest({key: 'sk-ant-secret', model: 'claude-opus-5-5', title: 'T', notes: 'N'}),
            'breakdown sends the built request');
        const defaulted = run(ok200(ANSWER), 'k', '');
        await defaulted.client.breakdown('T');
        t.eq(JSON.parse(defaulted.transport.calls[0].body).model, DEFAULT_CLAUDE_MODEL, 'an empty model means the default model');

        for (const key of [null, undefined, '', '   ']) {
            const transport = new FakeTransport(ok200(ANSWER));
            const e = await caught(new ClaudeClient(key, 'm', transport).breakdown('T', null));
            t.check(e instanceof ClaudeError && e.kind === 'noKey', `no key: ${JSON.stringify(key) ?? 'undefined'}`);
            t.eq(transport.calls.length, 0, `no request without a key: ${JSON.stringify(key) ?? 'undefined'}`);
        }
        const refusedByApi = await caught(run(ok200('{"content":[],"stop_reason":"refusal"}')).client.breakdown('T'));
        t.eq(refusedByApi?.kind, 'refused', 'breakdown: refusal');
        const garbage = await caught(run(ok200('<html>')).client.breakdown('T'));
        t.eq(garbage?.kind, 'decoding', 'breakdown: unreadable answer');

        const unauthorized = await caught(run([{status: 401, text: '{"error":{"message":"invalid x-api-key sk-ant-secret"}}'}]).client.breakdown('T'));
        t.check(unauthorized instanceof ClaudeError && unauthorized instanceof Error && unauthorized.name === 'ClaudeError', 'ClaudeError is an Error');
        t.eq([unauthorized.kind, unauthorized.status], ['http', 401], 'breakdown: http error with its status');
        t.check(unauthorized.userMessage.startsWith('Claude API 401: ') && unauthorized.userMessage.includes('invalid x-api-key'),
            'the http message has the status and the body');
        t.check(!unauthorized.userMessage.includes('sk-ant-secret') && !unauthorized.message.includes('sk-ant-secret'),
            'the API key never appears in an error message');
        const longBody = await caught(run([{status: 500, text: 'y'.repeat(400)}]).client.breakdown('T'));
        t.eq(longBody.userMessage, `Claude API 500: ${'y'.repeat(300)}`, 'the http body is cut to 300 characters');
        const redirected = await caught(run([{status: 302, text: ''}]).client.breakdown('T'));
        t.eq(redirected?.kind, 'http', 'a status outside 2xx is an error');

        const offline = await caught(run([{throws: 'offline'}]).client.breakdown('T'));
        t.eq(offline?.kind, 'network', 'breakdown: network error');
        t.eq(offline.userMessage, 'Network error: offline', 'network message (en)');

        t.eq(new ClaudeError('noKey').userMessage, 'No Claude API key yet (add one in Settings).', 'noKey message (en)');
        t.eq(new ClaudeError('refused').userMessage, 'Claude declined this request.', 'refused message (en)');
        t.eq(new ClaudeError('decoding').userMessage, "Couldn't read Claude's answer.", 'decoding message (en)');
        setLang('vi');
        t.eq(new ClaudeError('noKey').userMessage, 'Chưa có API key của Claude (thêm trong Cài đặt).', 'noKey message (vi)');
        t.eq(new ClaudeError('refused').userMessage, 'Claude từ chối yêu cầu này.', 'refused message (vi)');
        t.eq(new ClaudeError('decoding').userMessage, 'Claude trả về dữ liệu không đọc được.', 'decoding message (vi)');
        t.eq(offline.userMessage, 'Lỗi mạng: offline', 'network message (vi)');
    } finally {
        setLang(savedLang);
    }
}

// SoupTransport against a server on 127.0.0.1 (nothing leaves the machine).
async function soupTransport(t) {
    const decoder = new TextDecoder();
    const seen = [];
    const server = new Soup.Server();
    server.add_handler('/', (_server, msg, path) => {
        const headers = msg.get_request_headers();
        seen.push({
            method: msg.get_method(),
            path,
            body: decoder.decode(msg.get_request_body().flatten().get_data()),
            contentType: headers.get_list('content-type'),
            auth: headers.get_one('authorization'),
            custom: headers.get_one('x-custom'),
        });
        if (path === '/status/401') {
            msg.set_status(401, null);
        } else if (path === '/status/500') {
            msg.set_status(500, null);
            msg.set_response('application/json', Soup.MemoryUse.COPY, new TextEncoder().encode('{"error":"Việc ✓"}'));
        } else {
            msg.set_status(200, null);
            msg.set_response('application/json', Soup.MemoryUse.COPY, new TextEncoder().encode('{"ok":true}'));
        }
    });
    let port;
    try {
        server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
        port = server.get_uris()[0].get_port();
    } catch (e) {
        print(`soup transport skipped: cannot listen on 127.0.0.1 (${e.message})`);
        return;
    }
    const transport = new SoupTransport();
    try {
        const base = `http://127.0.0.1:${port}`;
        const post = await transport.request({
            method: 'POST', url: `${base}/tasks?a=1`,
            headers: {Authorization: 'Bearer tok', 'Content-Type': 'application/json', 'X-Custom': 'yes'},
            body: '{"content":"Việc"}',
        });
        t.eq(post, {status: 200, text: '{"ok":true}'}, 'SoupTransport: a POST returns status and text');
        t.eq(seen[0], {
            method: 'POST', path: '/tasks', body: '{"content":"Việc"}', contentType: 'application/json',
            auth: 'Bearer tok', custom: 'yes',
        }, 'SoupTransport: method, headers and body arrive (one content type)');

        const get = await transport.request({method: 'GET', url: `${base}/list`, headers: {Authorization: 'Bearer tok'}, body: null});
        t.eq(get.status, 200, 'SoupTransport: a GET works');
        t.eq([seen[1].method, seen[1].body, seen[1].contentType], ['GET', '', null], 'SoupTransport: a GET has no body');
        const bare = await transport.request({method: 'DELETE', url: `${base}/x`});
        t.eq([bare.status, seen[2].method], [200, 'DELETE'], 'SoupTransport: headers and body are optional');

        const empty = await transport.request({method: 'POST', url: `${base}/status/401`, headers: {}, body: null});
        t.eq(empty, {status: 401, text: ''}, 'SoupTransport: an error status with no body is not an exception');
        const failed = await transport.request({method: 'GET', url: `${base}/status/500`, headers: {}, body: null});
        t.eq(failed, {status: 500, text: '{"error":"Việc ✓"}'}, 'SoupTransport: an error status keeps its body, decoded as UTF-8');

        const bad = await caught(transport.request({method: 'GET', url: 'not a url', headers: {}, body: null}));
        t.check(bad instanceof Error && bad.name === 'NetworkError', 'SoupTransport: an invalid url is a NetworkError');

        // A request the server never answers ends when the transport is aborted.
        let held = null;
        server.add_handler('/hang', (_server, msg) => {
            held = msg;
            msg.pause();
        });
        const hanging = transport.request({method: 'GET', url: `${base}/hang`, headers: {}, body: null});
        await sleep(200);
        transport.abort();
        const winner = await Promise.race([caught(hanging), sleep(5000).then(() => 'timeout')]);
        t.check(winner instanceof Error && winner.name === 'NetworkError', 'SoupTransport: abort ends a request in flight with a NetworkError');
        held?.unpause();
    } finally {
        server.disconnect();
    }

    // The server is gone: the connection is refused.
    const refused = await caught(transport.request({method: 'GET', url: `http://127.0.0.1:${port}/`, headers: {}, body: null}));
    t.check(refused instanceof Error && refused.name === 'NetworkError' && refused.message !== '', 'SoupTransport: a refused connection is a NetworkError');
    // A transport that never sent anything can be aborted too.
    new SoupTransport().abort();
}

export default async function (t) {
    await todoistUrls(t);
    await todoistReading(t);
    await todoistWriting(t);
    await todoistErrors(t);
    await demo(t);
    demoEventChecks(t);
    await claude(t);
    await soupTransport(t);
}
