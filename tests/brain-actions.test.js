// What you do from the board, the bubbles and the menu (complete, undo, add, reschedule, delete, split...) and the
// focus/break timer (Task 16), with every service faked. Also the keyring hand-off from Task 14's review.
import {getLang, setLang} from '../extension/core/l10n.js';
import {Lines, setLinesRandom} from '../extension/core/lines.js';
import {SECRET_ANTHROPIC, SECRET_TODOIST} from '../extension/core/secretNames.js';
import {MemoryStore, at, makeBrain, task} from './helpers.js';

const TODAY = '2026-10-27';
const FOCUS = '▶︎ Focus 25\'';

const titles = b => b.bubble?.actions.map(x => x.title) ?? null;
const action = (b, title) => b.bubble.actions.find(x => x.title === title);
const lastOf = (b, kind) => b.diary.today.filter(e => e.kind === kind).at(-1) ?? null;
const recurring = id => task(id, TODAY, 1, {due: {date: TODAY, string: 'every day', isRecurring: true}});

// A store whose saved focus session cannot be read.
class BadFocusStore extends MemoryStore {
    async load(name) {
        if (name === 'focus')
            throw new Error('fake: focus.json is unreadable');
        return super.load(name);
    }
}

export default async function (t) {
    const savedLang = getLang();
    setLang('en');
    setLinesRandom(() => 0);
    try {
        await brief(t);
        await keyring(t);
        await editing(t);
        await completing(t);
        await staleSync(t);
        await adding(t);
        await splitting(t);
        await focus(t);
        await focusRestore(t);
    } finally {
        setLang(savedLang);
        setLinesRandom();
    }
}

// The checks from the task brief, word for word.
async function brief(t) {
    const b = makeBrain({active: [task('a', '2026-10-27', 4)], now: at('2026-10-27T11:00')}); await b.start(); await b.refresh();
    b.complete(b.day.today[0]); await b.settle();
    t.eq(b.todo.calls.at(-1), ['close', 'a'], 'complete closes in Todoist');
    await b.refresh();
    t.eq(b.life.state.totalDone, 1, 'completing via the pet feeds once');
    b.undoComplete(b.day.completed[0]); await b.settle();
    t.check(b.todo.calls.at(-1)[0] === 'reopen' && b.life.state.totalDone === 0, 'undo reopens and unfeeds');
    await b.add('Call Anna', 'tomorrow', 3);
    t.eq(b.todo.calls.at(-1), ['addTask', {content: 'Call Anna', dueString: 'tomorrow', priority: 3, parentId: null}], 'add tomorrow');
    await b.add('Call Anna 3pm p1 #Work', 'smart', 4);
    t.eq(b.todo.calls.at(-1), ['quickAdd', 'Call Anna 3pm p1 #Work'], 'Todoist syntax uses quick add');
    await b.split(task('s', '2026-10-27', 2), ['Open file', ' ', 'Outline'], true);
    t.eq(b.todo.calls.filter(c => c[0] === 'addTask').slice(-2).map(c => [c[1].content, c[1].parentId, c[1].dueString, c[1].priority]),
        [['Open file', 's', 'today', 2], ['Outline', 's', null, 2]], 'split adds sub-tasks, step 1 today');
    b.startFocus(null, 25);
    const r = makeBrain({now: at('2026-10-27T11:00'), store: b.store}); await r.start();
    t.eq([r.focusSession?.minutes, r.focusSession?.isBreak], [25, false], 'focus session survives a restart');
    b.tick(new Date(at('2026-10-27T11:00').getTime() + 25 * 60000 + 1000));
    t.eq(b.lastRule, 'focusEnd', 'focus end asks if you finished');
}

// Task 14's review: a keyring that cannot be read is not "no token", and one secret failing does not drop the other.
async function keyring(t) {
    const logs = [];
    const k = makeBrain({env: {secretsFail: true}});
    k._log = (message, options) => logs.push({message, warning: options?.warning === true});
    await k.start();
    k.tick(at('2026-10-27T11:00:01')); k.tick(at('2026-10-27T11:00:03')); await k.settle();
    k.tick(at('2026-10-27T11:00:20')); await k.settle();
    t.check(!k.hasToken && k.bubble === null && k.lastRule === null &&
        !k.diary.today.some(e => e.tag === 'askToken'), 'a keyring that cannot be read is not "no token": no hello');
    t.eq(logs.length, 1, 'the keyring failure is logged once, not on every retry');
    t.check(logs[0]?.warning, 'a keyring that cannot be read is logged as a warning (GNOME Shell shows an error as CRITICAL)');
    k.env.secretsFail = false;
    k.tick(at('2026-10-27T11:00:40')); await k.settle();
    t.check(k.hasToken && k.fakeTodo.token === 'test-token' && k.lastSync !== null,
        'the slow tick reads the keyring again and connects once it can');
    k.tick(at('2026-10-27T11:00:42'));
    t.check(!k.diary.today.some(e => e.tag === 'askToken'), 'no hello once the token is read');

    const n = makeBrain({token: null, env: {secretsFail: true}});
    n._log = () => {};
    await n.start();
    n.tick(at('2026-10-27T11:00:01')); n.tick(at('2026-10-27T11:00:03')); await n.settle();
    t.eq(n.bubble, null, 'no hello while the keyring cannot be read, even without a token');
    n.env.secretsFail = false;
    n.tick(at('2026-10-27T11:00:20')); await n.settle();
    n.tick(at('2026-10-27T11:00:22'));
    t.check(titles(n)?.includes('Try demo') && !n.hasToken, 'once the keyring answers without a token, the hello comes');

    // Only the Claude key cannot be read: the keyring is retried every slow tick, but the token was read (none).
    const h = makeBrain({token: null, env: {secretsFail: [SECRET_ANTHROPIC]}});
    h._log = () => {};
    await h.start();
    for (let i = 1; i <= 120; i++) {
        h.tick(new Date(at('2026-10-27T11:00').getTime() + i * 1000));
        await h.settle();
    }
    t.eq(h.diary.today.filter(e => e.tag === 'askToken').length, 1, 'an unreadable Claude key does not repeat the hello');

    const s = makeBrain({});
    s._log = () => {};
    await s.start(); await s.settle();
    s.env.secrets.set(SECRET_TODOIST, 'new-token');
    s.env.secretsFail = [SECRET_ANTHROPIC];
    await s.reloadSecrets(); await s.settle();
    t.check(s.hasToken && s.fakeTodo.token === 'new-token', 'reloadSecrets: a Claude key that cannot be read does not stop a new token');
    s.env.secrets.set(SECRET_ANTHROPIC, 'sk-test');
    s.env.secretsFail = [SECRET_TODOIST];
    await s.reloadSecrets(); await s.settle();
    t.check(s.hasClaudeKey && s.hasToken, 'reloadSecrets: a token that cannot be read still updates the Claude key and keeps the connection');
    s.env.secretsFail = [SECRET_ANTHROPIC];
    await s.reloadSecrets();
    t.check(s.hasClaudeKey, 'a Claude key that cannot be read is not taken as removed');

    // Saving into a keyring that is not there: the token still connects, and both failures are warnings.
    const w = makeBrain({token: null, env: {secretsFail: true}});
    const saves = [];
    w._log = (message, options) => saves.push({message, warning: options?.warning === true});
    await w.start(); await w.settle();
    saves.length = 0;
    await w.setToken('typed-token');
    await w.setClaudeKey('sk-typed');
    t.check(w.hasToken, 'a token the keyring cannot save still connects');
    t.eq(saves.map(x => [x.message.includes('keyring'), x.warning]), [[true, true], [true, true]],
        'a token or key the keyring cannot save is logged as a warning');
}

// Delete, schedule, unplan, reschedule, pull overdue in, move today to tomorrow.
async function editing(t) {
    const e = makeBrain({
        active: [task('x', TODAY), task('x1', TODAY, 1, {parentId: 'x'}), task('y', TODAY), task('z', TODAY), recurring('r')],
        overdue: 2,
    });
    await e.start(); await e.refresh();
    const x = e.day.open.find(v => v.id === 'x');
    e.delete(x);
    t.check(!e.day.open.some(v => v.id === 'x' || v.id === 'x1'), 'delete takes the task and its sub-tasks off the board at once');
    t.eq(e.lastPlanAction, at('2026-10-27T11:00'), 'deleting counts as planning');
    await e.settle();
    t.eq(e.todo.calls.at(-1), ['delete', 'x'], 'delete deletes in Todoist');
    t.eq(e.bubble?.text, Lines.deleted(x), 'delete says so');
    t.check(!e.day.open.some(v => v.id === 'x1'), 'the sub-tasks are gone after the sync too');

    const y = e.day.open.find(v => v.id === 'y');
    const slot = {task: y, start: at('2026-10-27T14:30'), end: at('2026-10-27T15:00')};
    e.schedule(slot); await e.settle();
    t.eq(e.todo.calls.at(-1), ['reschedule', ['y', 'today at 14:30']], 'schedule gives the task a time today ("today at HH:mm")');
    t.eq(e.bubble?.text, Lines.timeSet(y, slot.start), 'schedule says when it will remind you');
    t.eq(e.day.open.find(v => v.id === 'y')?.dueTime, at('2026-10-27T14:30'), 'the board shows the new time after the sync');

    e.unplan(e.day.open.find(v => v.id === 'y')); await e.settle();
    t.eq(e.todo.calls.at(-1), ['reschedule', ['y', 'no date']], 'unplan takes the date off');
    t.check(!e.day.open.some(v => v.id === 'y') && e.bubble?.text === Lines.unplanned(y),
        'unplan: off the board, and the pet says it is still in Todoist');

    e.pullOverdueToToday(); await e.settle();
    t.eq(e.todo.calls.slice(-2), [['reschedule', ['overdue-1', 'today']], ['reschedule', ['overdue-2', 'today']]],
        'pull overdue moves each overdue task to today');
    t.check(e.day.overdue.length === 0 && e.day.today.some(v => v.id === 'overdue-1'), 'the board shows them today');

    const movable = e.day.today.filter(v => !v.isRecurring).map(v => v.id);
    e.moveTodayToTomorrow(); await e.settle();
    t.eq(e.todo.calls.slice(-movable.length), movable.map(id => ['reschedule', [id, 'tomorrow']]),
        'move to tomorrow reschedules every task of today that does not repeat');
    t.eq(e.day.today.map(v => v.id), ['r'], 'the recurring task stays');
    t.eq(e.bubble?.text, `Moved ${movable.length} task(s) to tomorrow. Rest well 🌙`, 'and the pet says how many moved');

    const f = makeBrain({active: [task('a', TODAY)]});
    await f.start(); await f.refresh();
    f.refresh();
    f.reschedule(f.day.today[0], 'tomorrow'); await f.settle();
    t.eq(f.todo.calls.at(-1), ['reschedule', ['a', 'tomorrow']], 'reschedule passes the due string through');
    t.eq(f.day.today.length, 0, "an action's sync starts after its change, not before");

    const g = makeBrain({active: [task('a', TODAY), task('b', TODAY)]});
    await g.start(); await g.refresh();
    g.fakeTodo.failWith('http');
    g.delete(g.day.today[0]); await g.settle();
    t.check(g.errorText !== null && g.bubble?.text.startsWith("I can't reach Todoist"), 'a failed delete says so');
    g.fakeTodo.failWith(null);
    await g.refresh();
    t.eq(g.day.today.map(v => v.id), ['a', 'b'], 'and the next sync brings the task back');
    g.startFocus(g.day.today[1], 25);
    g.delete(g.day.today[1]);
    t.eq(g.focusSession, null, 'deleting the task you focus on ends the session');
    await g.settle();
}

async function completing(t) {
    const c = makeBrain({active: [task('a', TODAY), task('b', TODAY)]});
    await c.start(); await c.refresh();
    const fed = c.life.state.totalDone;
    c.fakeTodo.failWith('network');
    c.complete(c.day.today.find(v => v.id === 'a'));
    t.check(c.day.completed.length === 1 && c.life.state.totalDone === fed + 1 && c.celebration !== null,
        'complete counts and celebrates at once');
    t.eq(titles(c), ['Undo'], 'the celebration offers Undo');
    await c.settle();
    t.check(c.day.today.some(v => v.id === 'a') && c.day.completed.length === 0 && c.life.state.totalDone === fed,
        'a failed close puts the task back and unfeeds');
    t.check(c.errorText !== null && c.bubble?.text.startsWith("I can't reach Todoist"), 'a failed close says so');
    c.fakeTodo.failWith(null);

    const b = c.day.today.find(v => v.id === 'b');
    c.startFocus(b, 25);
    c.complete(b); await c.settle();
    t.eq(c.focusSession, null, 'finishing the task you focus on ends the session');
    t.eq(await c.store.load('focus'), {session: null}, 'and forgets the saved session');

    action(c, 'Undo').run(); await c.settle();
    t.check(c.todo.calls.at(-1)?.[0] === 'reopen' && c.day.today.some(v => v.id === 'b'), "the bubble's Undo reopens the task");
    t.eq(c.lastCelebration, new Date(0), 'undo forgets the celebration (the mood does not count it as progress)');

    const v = makeBrain({active: [task('a', TODAY)]});
    await v.start(); await v.refresh();
    v.complete(v.day.today[0]); await v.settle();
    const closed = v.fakeTodo.completed;
    v.fakeTodo.completed = [];
    await v.refresh();
    v.fakeTodo.completed = closed;
    await v.refresh();
    t.eq(v.life.state.totalDone, 1, 'a completion Todoist reports late is not fed twice');
}

// The final review: Board.open() starts a sync; a task ticked off while it is in flight must not come back with the
// sync's list (from before the tick), or a second tick would feed the pet twice.
async function staleSync(t) {
    const s = makeBrain({active: [task('a', TODAY, 4), task('b', TODAY)]});
    await s.start(); await s.refresh();
    const fed = s.life.state.totalDone;
    const a = s.day.today.find(v => v.id === 'a');
    const release = s.fakeTodo.holdSync();
    const sync = s.refresh();
    s.complete(a);
    await Promise.resolve();
    release();
    await sync; await s.settle();
    t.check(s.fakeTodo.reads.length > 0 && !s.fakeTodo.active.some(v => v.id === 'a'),
        'the sync read the list from before the tick, and Todoist has closed the task since');
    t.check(!s.day.open.some(v => v.id === 'a') && s.day.completed.some(v => v.id === 'a'),
        'the stale sync does not bring the ticked task back: it stays done');
    s.complete(a); await s.settle();
    t.eq([s.life.state.totalDone, s.fakeTodo.calls.filter(c => c[0] === 'close').length], [fed + 1, 1],
        'a second tick of the same task is ignored: fed once, closed once');
    await s.refresh();
    t.check(!s.day.open.some(v => v.id === 'a') && s.day.completed.filter(v => v.id === 'a').length === 1 &&
        s.life.state.totalDone === fed + 1, 'the next sync shows it done, once, and feeds nothing more');

    // Todoist's completed list lags behind the close: the tick still stands. Reopened in the Todoist app: it is open.
    const l = makeBrain({active: [task('a', TODAY)]});
    await l.start(); await l.refresh();
    l.complete(l.day.today[0]); await l.settle();
    const closed = l.fakeTodo.completed;
    l.fakeTodo.completed = [];
    await l.refresh();
    t.check(!l.day.open.some(v => v.id === 'a') && l.day.completed.some(v => v.id === 'a'),
        'a close the completed list does not show yet stays done');
    l.fakeTodo.completed = closed;
    await l.refresh();
    const [reopened] = l.fakeTodo.completed.splice(0, 1);
    l.fakeTodo.active.push(task(reopened.id, TODAY));
    await l.refresh();
    t.check(l.day.open.some(v => v.id === 'a') && !l.day.completed.some(v => v.id === 'a'),
        'a task reopened in the Todoist app after the close is open again');
    l.complete(l.day.today[0]); await l.settle();
    t.check(l.fakeTodo.calls.filter(c => c[0] === 'close').length === 2 && !l.day.open.some(v => v.id === 'a'),
        'and can be ticked off again');

    // Undo, and a close Todoist refuses, let the task go: the next sync shows it open.
    const u = makeBrain({active: [task('a', TODAY)]});
    await u.start(); await u.refresh();
    u.complete(u.day.today[0]); await u.settle();
    u.undoComplete(u.day.completed[0]); await u.settle();
    await u.refresh();
    t.check(u.day.open.some(v => v.id === 'a') && !u.day.completed.some(v => v.id === 'a'), 'after Undo a sync shows the task open');
    u.fakeTodo.failWith('network');
    u.complete(u.day.today[0]); await u.settle();
    u.fakeTodo.failWith(null);
    await u.refresh();
    t.check(u.day.open.some(v => v.id === 'a') && !u.day.completed.some(v => v.id === 'a'),
        'after a refused close a sync shows the task open');
}

async function adding(t) {
    const a = makeBrain({active: [task('a', TODAY), task('b', TODAY)]});
    await a.start(); await a.refresh();
    const writes = a.todo.calls.length;
    t.check(await a.add('   ', 'today', 1) === false && a.todo.calls.length === writes, 'add ignores blank text');
    t.check(await a.add('  Write report \n', 'today', 1) === true, 'add returns true when Todoist took it');
    t.eq(a.todo.calls.at(-1), ['addTask', {content: 'Write report', dueString: 'today', priority: 1, parentId: null}],
        'add today, with the text trimmed');
    t.check(a.day.planned === 3 && a.bubble?.text === Lines.planComplete(3, a.day.next), 'the task that completes the plan gets a cheer');
    t.eq(titles(a), [FOCUS], 'with a button to focus on the next task');
    t.eq(a.lastCelebration, at('2026-10-27T11:00'), 'a full plan counts as a celebration for the mood');
    await a.add('Some day', 'none', 4);
    t.eq(a.todo.calls.at(-1), ['addTask', {content: 'Some day', dueString: null, priority: 4, parentId: null}], 'add without a date');
    t.eq(a.bubble?.text, Lines.added('Some day'), 'any other add says "Added"');
    a.fakeTodo.failWith('http');
    t.check(await a.add('Fails', 'today', 1) === false && a.errorText !== null, 'a failed add returns false and shows the error');
    a.fakeTodo.failWith(null);
}

async function splitting(t) {
    const s = makeBrain({active: [task('big', TODAY, 3)]});
    await s.start(); await s.refresh();
    const big = s.day.today[0];
    t.check(await s.split(big, [' ', ''], true) === false, 'split with no real step does nothing');
    t.check(await s.split(big, ['Open the file', 'Write the outline'], true) === true, 'split returns true');
    t.eq(s.bubble?.text, Lines.splitDone(2, 'Open the file'), 'split says how many steps and the first one');
    t.eq(titles(s), [FOCUS], 'with a button to focus on step 1');
    action(s, FOCUS).run();
    t.eq(s.focusSession?.task?.title, 'Open the file', 'which focuses on the first step');
    t.check(await s.split(big, ['Later step'], false) && s.todo.calls.at(-1)[1].dueString === null,
        'split without "first today" leaves step 1 without a date');

    const calls = [];
    const claudeFactory = (key, model) => {
        calls.push([key, model]);
        return {breakdown: async (title, notes) => {
            calls.push([title, notes]);
            return ['Open the doc', 'Write one line'];
        }};
    };
    const k = makeBrain({claudeFactory, env: {secrets: {[SECRET_ANTHROPIC]: 'sk-test'}}});
    await k.start();
    t.eq(await k.suggestSteps(task('q', TODAY, 1, {description: 'for the board'})), ['Open the doc', 'Write one line'],
        'suggestSteps returns the steps Claude wrote');
    t.eq(calls, [['sk-test', 'claude-opus-5-5'], ['Task q', 'for the board']],
        'with the saved key, the model from the settings, the title and the notes');
    k.env.secrets.delete(SECRET_ANTHROPIC);
    await t.rejects(k.suggestSteps(task('q', TODAY)), e => e?.kind === 'noKey', 'without a Claude key: a noKey error');
}

async function focus(t) {
    const f = makeBrain({active: [task('a', TODAY, 4), task('b', TODAY)]});
    await f.start(); await f.refresh();
    const a = f.day.next;
    f.startFocus(a, 25);
    t.eq([f.focusSession.task.id, f.focusSession.minutes, f.focusSession.isBreak, f.focusSession.end - f.focusSession.start],
        ['a', 25, false, 25 * 60000], 'startFocus starts a 25-minute session on the task');
    t.eq(f.bubble?.text, Lines.focusStart(a, 25), 'the pet says it will keep quiet');
    t.eq(lastOf(f, 'focus')?.text, 'Started a 25-minute focus session: “Task a”', 'the diary notes the session');
    f.tick(at('2026-10-27T11:10')); await f.settle();
    f.stopFocus();
    t.check(f.focusSession === null && lastOf(f, 'focus')?.text === 'You stopped focusing after 10/25 min',
        'stopFocus ends the session and notes how long it ran');

    f.startFocus(null);
    t.eq([f.focusSession.task?.id, f.focusSession.minutes], ['a', 25], 'with no task or length: the next task, the length from the settings');
    f.tick(at('2026-10-27T11:34:59'));
    t.check(f.focusSession !== null, 'the session runs until its end');
    f.tick(at('2026-10-27T11:35:00'));
    t.eq(f.focusSession, null, 'and ends on the tick that reaches it');
    t.eq(f.lastRule, 'focusEnd', 'with the focusEnd bubble');
    t.eq(f.bubble?.text, Lines.focusEnd(a, 25), 'which asks if the task is done');
    t.eq(titles(f), ['✓ Done', '+25\' more', '☕ Break 5\''], 'done, more time or a break');
    t.check(f.env.played.includes('important'), 'with the important chime');
    t.eq(lastOf(f, 'focus')?.text, 'Finished a 25-minute focus session', 'the diary notes the finished session');

    action(f, '✓ Done').run(); await f.settle();
    t.check(f.todo.calls.at(-1)?.[0] === 'close' && f.todo.calls.at(-1)[1] === 'a', 'Done finishes the task');
    t.check(f.focusSession?.isBreak && f.focusSession.minutes === 5 && f.focusSession.task === null, 'and starts the break');
    t.eq(f.bubble?.text, '5-minute break ☕ Water and stretch!', 'the break bubble');
    f.tick(at('2026-10-27T11:40:00'));
    t.eq([f.lastRule, f.focusSession], ['breakEnd', null], 'the end of the break');
    t.eq(f.bubble?.text, Lines.breakEnd(), 'calls you back to work');
    t.eq(titles(f), [FOCUS, 'Later'], 'with focus and later');
    t.eq(lastOf(f, 'focus')?.text, 'Break over', 'the diary notes the end of the break');

    const m = makeBrain({active: [task('a', TODAY)]});
    await m.start(); await m.refresh();
    m.startFocus(null, 15);
    m.tick(at('2026-10-27T11:15:00'));
    action(m, '+15\' more').run();
    t.eq([m.focusSession?.task?.id, m.focusSession?.minutes, m.focusSession?.isBreak], ['a', 15, false], '"more" starts the same session again');
    m.stopFocus();
    m.startBreak();
    m.tick(at('2026-10-27T11:17:00'));
    m.stopFocus();
    t.eq(lastOf(m, 'focus')?.text, 'You ended the break after 2 min', 'stopping a break is noted as such');

    const gone = makeBrain({active: [task('a', TODAY)]});
    await gone.start(); await gone.refresh();
    gone.startFocus(gone.day.today[0], 25);
    gone.fakeTodo.completeRemotely('a');
    await gone.refresh();
    gone.tick(at('2026-10-27T11:25:00'));
    t.eq(titles(gone), ['+25\' more', '☕ Break 5\''], 'no Done button when the task is no longer open');
}

async function focusRestore(t) {
    const store = new MemoryStore();
    const s = makeBrain({store, active: [task('a', TODAY)]});
    await s.start(); await s.refresh();
    s.startFocus(s.day.today[0], 25);
    t.eq(await store.load('focus'), {session: {
        task: {id: 'a', title: 'Task a'}, start: '2026-10-27T04:00:00.000Z', end: '2026-10-27T04:25:00.000Z', isBreak: false, minutes: 25,
    }}, 'the session is saved with the task id and title');
    const r = makeBrain({store, now: at('2026-10-27T11:10')});
    await r.start();
    t.check(r.focusSession?.task?.id === 'a' && r.focusSession.task.title === 'Task a' &&
        r.focusSession.end.getTime() === at('2026-10-27T11:25').getTime(), 'a restart keeps the task and the end time');
    r.tick(at('2026-10-27T11:10:01'));
    t.eq(r.lastRule, null, 'the restored session keeps the pet quiet');

    const late = makeBrain({store, now: at('2026-10-27T11:30')});
    await late.start();
    t.check(late.focusSession !== null, 'a session that ended a few minutes before the restart is kept');
    late.tick(at('2026-10-27T11:30:01'));
    t.eq(late.lastRule, 'focusEnd', 'and ends on the first tick');
    t.eq(await store.load('focus'), {session: null}, 'which forgets it on disk');

    s.startFocus(null, 25);
    const old = makeBrain({store, now: at('2026-10-27T13:00')});
    await old.start();
    t.eq(old.focusSession, null, 'a session that ended long ago is dropped at start');
    t.eq(await store.load('focus'), {session: null}, 'and forgotten on disk');

    const logs = [];
    const bad = makeBrain({store: new BadFocusStore()});
    bad._log = message => logs.push(message);
    await bad.start();
    t.check(bad.focusSession === null && bad.hasToken && logs.length === 1, 'a saved session that cannot be read is logged and skipped');

    const demoStore = new MemoryStore();
    const d = makeBrain({store: demoStore, prefs: {demoMode: true}});
    await d.start(); await d.settle();
    d.startFocus(null, 25);
    t.check(d.focusSession !== null && await demoStore.load('focus') === null, 'the demo keeps its session in memory only');
}
