import {L, getLang, setLang} from '../extension/core/l10n.js';
import {
    atHour, dayKey, daysAgo, daysBetween, hourOf, nextDayKey, parseDate, plainText, shortText,
    timeString, utcString,
} from '../extension/core/dates.js';
import {DaySnapshot, Task, statsFromApi} from '../extension/core/models.js';

// Copied verbatim from DevTools.swift (the Todoist API v1 task page).
const API_PAGE = `
{"results":[{"id":"6X7rM8997g3RQmvh","user_id":"1","project_id":"6Jf8VQXxpwv56VQ7","section_id":null,"parent_id":null,
"added_by_uid":"1","assigned_by_uid":null,"responsible_uid":null,"labels":["work"],"deadline":null,"duration":null,
"checked":false,"is_deleted":false,"added_at":"2026-10-20T08:00:00.000000Z","completed_at":null,
"updated_at":"2026-10-20T08:00:00.000000Z","due":{"date":"2026-10-25T15:00:00","timezone":null,"string":"today at 3pm",
"lang":"en","is_recurring":false},"priority":4,"child_order":1,"content":"**Viết** [báo cáo](https://example.com)",
"description":"","note_count":0,"day_order":-1,"is_collapsed":false}],"next_cursor":null}
`;

const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}';

const ids = tasks => tasks.map(task => task.id);

export default async function (t) {
    // --- Dates (DevTools.swift "Dates") ---
    t.check(parseDate('2026-10-25') !== null, 'parse all-day date');
    const a = parseDate('2026-10-25T02:00:00Z');
    t.check(a !== null && a.getTime() === parseDate('2026-10-25T02:00:00.000000Z')?.getTime(),
        'parse UTC with and without microseconds');
    const floating = parseDate('2026-10-25T09:30:00');
    t.check(floating !== null && floating.getHours() === 9 && floating.getMinutes() === 30,
        'floating time is local time');

    t.eq(a.toISOString(), '2026-10-25T02:00:00.000Z', 'a Z time is UTC');
    t.eq(parseDate('2026-10-25T09:00:00+07:00').toISOString(), '2026-10-25T02:00:00.000Z',
        'a numeric offset is honoured');
    t.eq(parseDate('2026-10-25T02:00:00.123456Z').toISOString(), '2026-10-25T02:00:00.000Z',
        'fractional seconds are stripped, not rounded');
    t.eq(parseDate('  2026-10-25T09:30:00\t')?.getTime(), floating.getTime(), 'surrounding blanks are ignored');
    t.eq(parseDate('2026-10-25T09:30')?.getTime(), floating.getTime(), 'a floating time without seconds parses');
    const allDay = parseDate('2026-10-25');
    t.check(allDay.getHours() === 0 && allDay.getMinutes() === 0 && dayKey(allDay) === '2026-10-25',
        'an all-day date is local midnight');
    for (const bad of ['', 'tomorrow', '2026-02-30', '2026-13-01', '2026-10-25T25:00:00', '2026-10-25 09:00', null, undefined])
        t.eq(parseDate(bad), null, `unparseable date ${JSON.stringify(bad)} gives null`);
    t.check(parseDate('2028-02-29') !== null && parseDate('2026-02-29') === null, 'leap days are validated');

    t.eq(utcString(new Date(Date.UTC(2026, 9, 25, 2, 0, 0, 999))), '2026-10-25T02:00:00Z',
        'utcString is YYYY-MM-DDTHH:MM:SSZ without milliseconds');
    t.eq(dayKey(new Date(2026, 0, 5, 23, 59)), '2026-01-05', 'dayKey pads month and day and uses local time');
    t.eq(dayKey(new Date(2026, 11, 31, 0, 0)), '2026-12-31', 'dayKey at the start of a day');

    const base = parseDate('2026-10-25');
    const eleven = atHour(11, 0, base);
    t.check(eleven.getHours() === 11 && eleven.getMinutes() === 0 && eleven.getSeconds() === 0 &&
        dayKey(eleven) === '2026-10-25', 'atHour sets the hour on the same day');
    t.check(base.getHours() === 0, 'atHour does not change its input');
    t.eq(atHour(9, 45, parseDate('2026-10-25T17:20:33')).getTime(), parseDate('2026-10-25T09:45:00').getTime(),
        'atHour sets the minute and zeroes the seconds');
    t.eq([atHour(30, 0, base).getHours(), atHour(-3, 0, base).getHours()], [23, 0], 'atHour clamps the hour to 0...23');
    t.eq(atHour(8, undefined, base).getMinutes(), 0, 'atHour minute defaults to 0');
    t.eq(hourOf(parseDate('2026-10-25T15:00:00')), 15, 'hourOf is the local hour');

    t.eq(daysBetween('2026-10-22', '2026-10-25'), 3, 'daysBetween counts whole days');
    t.eq(daysBetween('2026-10-25', '2026-10-22'), -3, 'daysBetween is negative going backwards');
    t.eq(daysBetween('2026-10-31', '2026-11-01'), 1, 'daysBetween across a month');
    t.eq(daysBetween('2026-10-25', '2026-10-25'), 0, 'daysBetween of the same day');
    t.eq(daysBetween('nope', '2026-10-25'), 0, 'daysBetween of an unparseable key is 0');

    const savedLang = getLang();
    const now = atHour(11, 0, base);
    setLang('en');
    t.eq(daysAgo('2026-10-24', now), 'yesterday', 'daysAgo yesterday (en)');
    t.eq(daysAgo('2026-10-22', now), '3 days ago', 'daysAgo 3 days (en)');
    setLang('vi');
    t.eq(daysAgo('2026-10-24', now), 'hôm qua', 'daysAgo yesterday (vi)');
    t.eq(daysAgo('2026-10-22', now), '3 ngày trước', 'daysAgo 3 days (vi)');
    setLang(savedLang);
    t.eq(daysAgo('2026-10-24', now), L('hôm qua', 'yesterday'), 'daysAgo follows the current language');

    t.eq(timeString(atHour(9, 5, base)), '09:05', 'timeString pads to HH:MM');
    t.eq(timeString(atHour(15, 30, base)), '15:30', 'timeString is 24-hour');
    t.eq(timeString(atHour(0, 0, base)), '00:00', 'timeString at midnight');

    t.eq(nextDayKey('2026-12-31'), '2027-01-01', 'next day across the year');
    t.eq(nextDayKey('2026-10-25'), '2026-10-26', 'next day inside a month');
    t.eq(nextDayKey('2026-10-31'), '2026-11-01', 'next day across a month');
    t.eq(nextDayKey('2028-02-28'), '2028-02-29', 'next day into a leap day');
    t.eq(nextDayKey('2026-02-28'), '2026-03-01', 'next day after February 28 in a common year');
    t.eq(nextDayKey('not a day'), '9999', 'next day of an unparseable key is 9999');

    // --- Text ---
    t.eq(plainText('**Viết** [báo cáo](https://example.com)'), 'Viết báo cáo', 'plainText strips bold and links');
    t.eq(plainText('__a__ `b` [c](d) [e](f)'), 'a b c e', 'plainText strips underscores, code ticks and every link');
    t.eq(plainText('  \n [only](u)\t\n'), 'only', 'plainText trims blanks and newlines');
    t.eq(plainText('plain [not a link] (x)'), 'plain [not a link] (x)', 'plainText keeps brackets that are not links');
    t.eq(plainText(''), '', 'plainText of nothing');

    t.eq(shortText('abc', 3), 'abc', 'short text keeps text that fits');
    t.eq(shortText(FAMILY + FAMILY + FAMILY, 2), FAMILY + '…', 'short text never splits a grapheme');
    t.eq(shortText('Tiếng Việt có dấu', 5), 'Tiến…', 'combining marks stay with their letter');
    t.eq(shortText('x'.repeat(42)), 'x'.repeat(42), 'short text default limit keeps 42');
    t.eq(shortText('x'.repeat(43)), `${'x'.repeat(41)}…`, 'short text default limit cuts 43 to 41 + ellipsis');
    t.eq(shortText('abcd', 3), 'ab…', 'short text keeps max - 1 characters and an ellipsis');
    t.eq(shortText('abcd', 1), '…', 'short text with max 1 is just the ellipsis');
    t.eq(shortText(FAMILY + FAMILY, 2), FAMILY + FAMILY, 'a long grapheme counts as one');

    // --- Task model ---
    const bare = new Task({id: 'x', content: 'Bare'});
    t.eq(bare, {
        id: 'x', content: 'Bare', description: null, priority: null, due: null, deadline: null, duration: null,
        projectId: null, parentId: null, labels: null, checked: null, completedAt: null, childOrder: null,
        dayOrder: null,
    }, 'a task fills missing fields with null (labels too)');
    const sparse = new Task({id: 'y', content: 'Due', due: {date: '2026-10-25'}});
    t.eq(sparse.due, {date: '2026-10-25', string: null, isRecurring: null, datetime: null, timezone: null},
        'a task fills missing due fields with null');

    t.eq(bare.apiPriority, 1, 'apiPriority defaults to 1');
    t.eq([4, 3, 2, 1, null].map(p => new Task({id: 'p', content: 'p', priority: p}).uiPriority), [1, 2, 3, 4, 4],
        'uiPriority is 5 - apiPriority');
    t.eq([9, 0].map(p => new Task({id: 'p', content: 'p', priority: p}).uiPriority), [1, 4],
        'uiPriority clamps out-of-range priorities');
    t.eq(bare.dueDay, null, 'dueDay is null without a due');
    t.eq(new Task({id: 'z', content: 'z', due: {date: '2026-10-25T15:00:00'}}).dueDay, '2026-10-25',
        'dueDay is the first 10 characters of the due date');
    t.eq(bare.dueTime, null, 'dueTime is null without a due');
    t.eq(sparse.dueTime, null, 'dueTime is null for an all-day task');
    t.eq(bare.isRecurring, false, 'isRecurring defaults to false');
    t.eq(new Task({id: 'r', content: 'r', due: {date: '2026-10-25', isRecurring: true}}).isRecurring, true,
        'isRecurring reads the due');
    const withTime = new Task({id: 'w', content: 'w', due: {date: '2026-10-25T15:00:00'}});
    t.eq(withTime.dueTime?.getTime(), parseDate('2026-10-25T15:00:00').getTime(), 'dueTime from a date with a time part');
    const withDatetime = new Task({
        id: 'd', content: 'd', due: {date: '2026-10-25', datetime: '2026-10-25T02:00:00Z'},
    });
    t.eq(withDatetime.dueTime?.toISOString(), '2026-10-25T02:00:00.000Z', 'dueTime prefers the datetime field');
    const badDatetime = new Task({
        id: 'b', content: 'b', due: {date: '2026-10-25T08:15:00', datetime: 'garbage'},
    });
    t.eq(badDatetime.dueTime?.getTime(), parseDate('2026-10-25T08:15:00').getTime(),
        'dueTime falls back to the date when the datetime does not parse');
    t.eq(bare.completedDate, null, 'completedDate is null while open');
    t.eq(new Task({id: 'c', content: 'c', completedAt: '2026-10-25T01:00:00Z'}).completedDate?.toISOString(),
        '2026-10-25T01:00:00.000Z', 'completedDate parses completedAt');
    t.eq(bare.durationMinutes, null, 'durationMinutes is null without a duration');
    t.eq(new Task({id: 'm', content: 'm', duration: {amount: 30, unit: 'minute'}}).durationMinutes, 30,
        'a minute duration is in minutes');
    t.eq(new Task({id: 'm', content: 'm', duration: {amount: 2, unit: 'day'}}).durationMinutes, 960,
        'a day is 8 working hours');
    t.eq(new Task({id: 't', content: '**Bold** `code`'}).title, 'Bold code', 'title is the plain content');

    // --- API v1 payload (DevTools.swift "API v1 payload") ---
    const page = JSON.parse(API_PAGE);
    const parsed = Task.fromApi(page.results[0]);
    t.eq(parsed.title, 'Viết báo cáo', 'markdown stripped from title');
    t.eq(parsed.uiPriority, 1, 'API priority 4 is P1');
    t.check(parsed.dueTime !== null && parsed.dueTime.getHours() === 15, 'due time parsed');
    t.check(JSON.stringify(parsed.labels) === '["work"]' && parsed.isRecurring === false,
        'labels and recurrence decoded');
    t.eq([parsed.id, parsed.projectId, parsed.parentId, parsed.checked, parsed.childOrder, parsed.dayOrder,
        parsed.description, parsed.completedAt, parsed.deadline, parsed.duration],
    ['6X7rM8997g3RQmvh', '6Jf8VQXxpwv56VQ7', null, false, 1, -1, '', null, null, null],
    'snake_case keys map to camelCase fields');
    t.eq(parsed.due, {date: '2026-10-25T15:00:00', string: 'today at 3pm', isRecurring: false, datetime: null,
        timezone: null}, 'the due object is mapped');
    t.check(!('userId' in parsed) && !('user_id' in parsed) && !('noteCount' in parsed),
        'unknown API keys are ignored');

    const full = Task.fromApi({
        id: '9', content: 'Full', parent_id: '8', completed_at: '2026-10-25T01:00:00.000000Z', checked: true,
        due: {date: '2026-10-25', datetime: '2026-10-25T02:00:00Z', timezone: 'Asia/Ho_Chi_Minh',
            string: 'every day', is_recurring: true},
        deadline: {date: '2026-10-30', lang: 'en'}, duration: {amount: 45, unit: 'minute'},
        labels: ['a', 'b'], priority: 3,
    });
    t.eq(full.due, {date: '2026-10-25', datetime: '2026-10-25T02:00:00Z', timezone: 'Asia/Ho_Chi_Minh',
        string: 'every day', isRecurring: true}, 'due datetime, timezone and recurrence are mapped');
    t.eq([full.deadline, full.duration, full.parentId, full.completedAt, full.labels, full.priority, full.checked],
        [{date: '2026-10-30'}, {amount: 45, unit: 'minute'}, '8', '2026-10-25T01:00:00.000000Z', ['a', 'b'], 3, true],
        'deadline, duration, parent, completion, labels and priority are mapped');
    t.eq(Task.fromApi({id: '1', content: 'c', due: null, labels: null}).due, null, 'a null due stays null');
    for (const bad of [null, {}, {id: '1'}, {content: 'x'}, {id: 1, content: 'x'}])
        t.check(throwsTypeError(() => Task.fromApi(bad)), `fromApi rejects ${JSON.stringify(bad)}`);

    // --- Productivity stats ---
    const stats = statsFromApi({
        completed_count: 42,
        days_items: [{date: '2026-10-24', items: [], total_completed: 2}, {date: '2026-10-25', total_completed: 5}],
        goals: {daily_goal: 3, current_daily_streak: {count: 4, start: '2026-10-22'}, max_daily_streak: {count: 9}},
        karma: 1234.5,
        week_items: [],
    });
    t.eq(stats, {
        streak: 4, completedCount: 42,
        daysItems: [{date: '2026-10-24', totalCompleted: 2}, {date: '2026-10-25', totalCompleted: 5}],
        dailyGoal: 3, karma: 1234.5,
    }, 'stats decode: streak, completed count, days, daily goal and karma');
    t.eq(statsFromApi({}), {streak: 0, completedCount: null, daysItems: [], dailyGoal: null, karma: null},
        'stats of an empty object');
    t.eq(statsFromApi({goals: {current_daily_streak: {}}}).streak, 0, 'a streak without a count is 0');
    t.eq(statsFromApi({days_items: [{}]}).daysItems, [{date: null, totalCompleted: null}], 'a day without fields');

    // --- Day snapshot (DevTools.swift "Day snapshot") ---
    const dayNow = atHour(11, 0, parseDate('2026-10-25'));
    const tasks = [
        new Task({id: 'o', content: 'old', priority: 1, due: {date: '2026-10-24'}}),
        new Task({id: 'a', content: 'all day', priority: 1, due: {date: '2026-10-25'}}),
        new Task({id: 'l', content: 'late', priority: 1, due: {date: '2026-10-25T09:00:00'}}),
        new Task({id: 'u', content: 'urgent', priority: 4, due: {date: '2026-10-25'}}),
        new Task({id: 'f', content: 'future', priority: 4, due: {date: '2026-10-26'}}),
    ];
    const done = [new Task({id: 'd', content: 'done', completedAt: '2026-10-25T01:00:00Z'})];
    const day = DaySnapshot.build({active: tasks, completed: done, now: dayNow});
    t.eq(ids(day.overdue), ['o'], 'overdue bucket');
    t.check(day.today.length === 3 && JSON.stringify(ids(day.late)) === '["l"]', 'today and late buckets');
    t.check(day.planned === 4 && day.remaining === 3, 'planned counts completed + today');
    t.check(day.next?.id === 'u', 'next task is the highest priority (eat the frog)');

    t.eq(ids(day.today), ['u', 'l', 'a'], 'today is ranked: priority, then timed before all-day');
    t.eq(ids(day.open), ['o', 'u', 'l', 'a'], 'open is overdue followed by today');
    t.eq(ids(day.completed), ['d'], 'completed tasks are kept');
    t.eq(ids(DaySnapshot.build({active: [], completed: [], now: dayNow}).today), [], 'an empty day');
    t.eq(DaySnapshot.build({active: [], completed: [], now: dayNow}).next, null, 'an empty day has no next task');

    const parent = new Task({id: 'p', content: 'Big', priority: 4, due: {date: '2026-10-25'}});
    const child = new Task({id: 'c', content: 'Small', priority: 4, due: {date: '2026-10-25'}, parentId: 'p'});
    t.check(DaySnapshot.build({active: [parent, child], completed: [], now: dayNow}).next?.id === 'c',
        'first step comes before the big task');
    const split = DaySnapshot.build({active: [parent, child], completed: [], now: dayNow});
    t.eq(ids(split.actionable), ['c'], 'a task with open sub-steps gives way to its steps');
    t.eq(ids(split.open).sort(), ['c', 'p'], 'open still lists the parent');
    const loopA = new Task({id: 'la', content: 'A', due: {date: '2026-10-25'}, parentId: 'lb'});
    const loopB = new Task({id: 'lb', content: 'B', due: {date: '2026-10-25'}, parentId: 'la'});
    t.check(DaySnapshot.build({active: [loopA, loopB], completed: [], now: dayNow}).next !== null,
        'next falls back to the ranked list when every open task is a parent');

    const checkedOne = new Task({id: 'k', content: 'checked', checked: true, due: {date: '2026-10-25'}});
    const undated = new Task({id: 'n', content: 'no date', priority: 2});
    const mixed = DaySnapshot.build({active: [checkedOne, undated, tasks[4]], completed: [], now: dayNow});
    t.eq([ids(mixed.today), ids(mixed.overdue)], [['n'], []],
        'checked tasks and tasks due later are left out; undated tasks count for today');

    const early = new Task({id: 'e', content: 'e', completedAt: '2026-10-25T01:00:00Z'});
    const lateDone = new Task({id: 'g', content: 'g', completedAt: '2026-10-25T09:00:00Z'});
    const noStamp = new Task({id: 'h', content: 'h'});
    t.eq(ids(DaySnapshot.build({active: [], completed: [early, noStamp, lateDone], now: dayNow}).completed),
        ['g', 'e', 'h'], 'completed tasks are newest first');

    t.eq(ids(DaySnapshot.build({
        active: [
            new Task({id: 'on', content: 'on', due: {date: '2026-10-25T12:30:00'}}),
            new Task({id: 'oe', content: 'oe', due: {date: '2026-10-25T12:00:00'}}),
            new Task({id: 'oa', content: 'oa', due: {date: '2026-10-25'}}),
        ],
        completed: [], now: dayNow,
    }).late), [], 'a task whose time has not come is not late');

    // ranked(): priority, then due time, then due day, then day/child order.
    const mk = (id, extra) => new Task({id, content: id, ...extra});
    const input = [
        mk('low', {priority: 1, due: {date: '2026-10-25T08:00:00'}}),
        mk('allday', {priority: 4, due: {date: '2026-10-25'}, childOrder: 1}),
        mk('t10', {priority: 4, due: {date: '2026-10-25T10:00:00'}}),
        mk('t09', {priority: 4, due: {date: '2026-10-25T09:00:00'}}),
        mk('t09b', {priority: 4, due: {date: '2026-10-25T09:00:00'}}),
        mk('d25', {priority: 3, due: {date: '2026-10-25'}, childOrder: 5}),
        mk('d24', {priority: 3, due: {date: '2026-10-24'}, childOrder: 9}),
        mk('ord2', {priority: 2, due: {date: '2026-10-25'}, dayOrder: 2, childOrder: 0}),
        mk('ord1', {priority: 2, due: {date: '2026-10-25'}, dayOrder: 1, childOrder: 7}),
        mk('child1', {priority: 2, due: {date: '2026-10-25'}, childOrder: 1.5}),
    ];
    const before = ids(input);
    t.eq(ids(DaySnapshot.ranked(input)),
        ['t09', 't09b', 't10', 'allday', 'd24', 'd25', 'ord1', 'child1', 'ord2', 'low'],
        'ranked: priority, timed before all-day, earlier time, earlier day, then dayOrder/childOrder');
    t.eq(ids(input), before, 'ranked does not reorder its input');
    t.eq(ids(DaySnapshot.ranked([mk('b', {priority: 4}), mk('a', {priority: 4})])), ['b', 'a'],
        'ranked keeps the input order for equal tasks');

    // A snapshot can be constructed empty and filled.
    const empty = new DaySnapshot();
    t.eq([empty.today, empty.overdue, empty.completed, empty.late, empty.planned, empty.remaining], [[], [], [], [], 0, 0],
        'an empty snapshot');
}

function throwsTypeError(fn) {
    try {
        fn();
    } catch (e) {
        return e instanceof TypeError;
    }
    return false;
}
