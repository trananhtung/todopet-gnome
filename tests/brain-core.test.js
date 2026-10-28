// The brain's state, sync, mood, life settlement and talking (Task 14), with every service faked.
import {getLang, setLang} from '../extension/core/l10n.js';
import {setLinesRandom} from '../extension/core/lines.js';
import {SECRET_TODOIST} from '../extension/services/secrets.js';
import {MemoryStore, at, done, makeBrain, task} from './helpers.js';

const SECOND = 1000;
const later = (date, ms) => new Date(date.getTime() + ms);

export default async function (t) {
    const savedLang = getLang();
    setLang('en');
    setLinesRandom(() => 0);
    try {
        await brief(t);
        await tokenAndDemo(t);
        await syncErrors(t);
        await moodContext(t);
        await talking(t);
        await lifeStorage(t);
    } finally {
        setLang(savedLang);
        setLinesRandom();
    }
}

// The checks from the task brief, word for word.
async function brief(t) {
    const b = makeBrain({active: [task('a', '2026-10-27', 4)], now: at('2026-10-27T11:00')});
    await b.start(); await b.refresh();
    t.eq(b.day.today.map(x => x.id), ['a'], 'refresh loads today');
    b.todo.completeRemotely('a'); await b.refresh();
    t.check(b.celebration && b.life.state.totalDone === 1, 'finished in the Todoist app: celebrate and feed');
    const fresh = makeBrain({completed: [done('z', '2026-10-27T01:00:00Z')], now: at('2026-10-27T11:00')});
    await fresh.start(); await fresh.refresh();
    t.eq(fresh.celebration, null, 'first sync does not celebrate earlier completions');
    const err = makeBrain({todoError: 'unauthorized'}); await err.start(); await err.refresh(); await err.refresh();
    t.eq(err.diary.today.filter(e => e.tag === 'askToken').length, 1, '401 asks for the token once');
    const off = makeBrain({active: [task('a', '2026-10-27', 1)], now: at('2026-10-27T11:00')}); await off.start(); await off.refresh();
    off.todo.failWith('network'); await off.refresh();
    t.eq(off.day.today.length, 1, 'offline keeps old tasks');
    t.check(!!off.errorText, 'offline shows the error');
    const mid = makeBrain({now: at('2026-10-27T23:59:50')}); await mid.start();
    mid.tick(at('2026-10-28T00:00:05')); mid.tick(at('2026-10-28T00:00:06'));
    t.eq([mid.life.state.dayKey, mid.closeDayCalls], ['2026-10-28', 1], 'midnight closes the day once');
    const sleepy = makeBrain({now: at('2026-10-26T18:00')}); await sleepy.start();
    sleepy.onWake(at('2026-10-28T09:00'));
    t.eq(sleepy.life.state.dayKey, '2026-10-28', 'waking after two days settles both');
    b.noteResponse({picked: 'Later'});
    t.eq(b.diary.today.at(-1).tag, 'picked', 'responses go to the diary');

    // Around the brief's checks.
    t.eq(b.diary.today.filter(e => e.kind === 'life' && e.text.includes('(in Todoist)')).length, 1,
        'the diary says the task was finished in Todoist');
    t.eq(err.errorText, 'The Todoist token is invalid or expired.', 'a 401 shows the client message');
    t.check(err.hasToken && err.bubble.actions[0].title === 'Enter a new token', 'a 401 keeps the token and offers a new one');
    t.eq(sleepy.life.state.dirt, 2, 'the Monday left undone and the unseen Tuesday both make the pet dirty');
    t.eq(mid.diary.today.filter(e => e.kind === 'life' && e.text.startsWith('Closed 2026-10-27')).length, 1,
        'closing the day is written to the diary');
    t.eq([mid.dayKey, mid.fired.has('morning-2026-10-27')], ['2026-10-28', false], "a new day forgets yesterday's reminders");
    const gap = makeBrain({now: at('2026-10-27T11:00')}); await gap.start();
    let woke = 0;
    const onWake = gap.onWake;
    gap.onWake = now => {
        woke += 1;
        return onWake(now);
    };
    gap.tick(at('2026-10-27T11:00:01')); gap.tick(at('2026-10-27T11:01:01')); gap.tick(at('2026-10-27T11:04:00'));
    t.eq(woke, 1, 'only a tick more than 2 minutes after the last one counts as waking up');
}

async function tokenAndDemo(t) {
    const s = makeBrain({token: null});
    await s.start();
    t.check(!s.hasToken && s.todo === null, 'no token: no Todoist service');
    t.eq(s.diary.today.filter(e => e.tag === 'askToken').length, 0, 'the pet waits a moment before asking for the token');
    s.tick(later(at('2026-10-27T11:00'), 2 * SECOND));
    t.eq(s.bubble?.actions.map(a => a.title), ['Connect Todoist', 'Try demo'], 'then says hello and asks for the token');
    t.eq(await s.setToken('  \n '), false, 'an empty token is refused');
    s.fakeTodo.failWith('unauthorized');
    t.check(await s.setToken('bad') === false && !s.hasToken && s.errorText !== null, 'a token Todoist refuses is not kept');
    s.fakeTodo.failWith(null);
    s.fakeTodo.active.push(task('t1', '2026-10-27'));
    t.eq(await s.setToken('  good-token\n'), true, 'a working token is accepted');
    t.eq([s.fakeTodo.token, s.env.secrets.get(SECRET_TODOIST), s.hasToken, s.errorText, s.day.today.length],
        ['good-token', 'good-token', true, null, 1], 'the token is trimmed, stored, and the tasks are loaded');
    s.removeToken(); await s.settle();
    t.check(!s.hasToken && s.day.today.length === 0 && !s.env.secrets.has(SECRET_TODOIST), 'removing the token forgets the tasks');
    s.useDemo(); await s.settle();
    t.check(s.demo && s.hasToken && s.day.open.length === 3 && s.events.length === 2, 'the demo has sample tasks and meetings');
    t.eq(s.bubble?.text, 'Demo mode with sample tasks 🎭 Click me to open the task board!', 'the demo says hello');
    s.setClaudeKey('  sk-test '); await s.settle();
    t.check(s.hasClaudeKey && s.env.secrets.get('anthropic-key') === 'sk-test', 'the Claude key is trimmed and stored');
    s.setClaudeKey(null); await s.settle();
    t.check(!s.hasClaudeKey, 'clearing the Claude key');
}

async function syncErrors(t) {
    const r = makeBrain({active: [task('a', '2026-10-27')]});
    await r.start(); await r.refresh();
    r.todo.failWith('rateLimited');
    r.tick(at('2026-10-27T11:03:30')); await r.settle();
    t.check(r.errorText?.includes('rate limiting'), 'a rate limit shows its message');
    const reads = r.todo.reads.length;
    r.tick(at('2026-10-27T11:04:00')); r.tick(at('2026-10-27T11:05:30')); await r.settle();
    t.eq(r.todo.reads.length, reads, 'after a rate limit the pet waits before syncing again');
    r.todo.failWith(null);
    r.tick(at('2026-10-27T11:06:45')); await r.settle();
    t.check(r.todo.reads.length > reads && r.errorText === null, 'and then syncs again');
    t.eq(r.diary.today.filter(e => e.kind === 'sync').length, 1, 'sync errors are written to the diary at most every 30 minutes');
}

async function moodContext(t) {
    const three = () => [task('a', '2026-10-27'), task('b', '2026-10-27'), task('c', '2026-10-27')];
    const yt = makeBrain({active: three(), now: at('2026-10-27T15:05'), env: {focus: {
        appName: 'Firefox', wmClass: 'firefox', title: 'Cats - YouTube — Mozilla Firefox', isBrowser: true,
        since: at('2026-10-27T15:00'),
    }}});
    await yt.start(); await yt.refresh();
    t.check(yt.reasons.some(x => x.text === 'distracted by youtube.com'), 'a distracting site is found by its window title');
    const steam = makeBrain({active: three(), now: at('2026-10-27T15:05'), env: {focus: {
        appName: 'Steam', wmClass: 'steam', title: 'Library', isBrowser: false, since: at('2026-10-27T15:00'),
    }}});
    await steam.start(); await steam.refresh();
    t.check(steam.reasons.some(x => x.text === 'distracted by Steam'), 'a distracting app is found by its name');
    const off = makeBrain({active: three(), now: at('2026-10-27T15:05'), prefs: {watchBrowsers: false}, env: {focus: {
        appName: 'Firefox', wmClass: 'firefox', title: 'Cats - YouTube — Mozilla Firefox', isBrowser: true,
        since: at('2026-10-27T15:00'),
    }}});
    await off.start(); await off.refresh();
    t.check(!off.reasons.some(x => x.text.startsWith('distracted')), 'sites are not watched when watching browsers is off');

    const night = makeBrain({active: three(), now: at('2026-10-27T23:30')});
    await night.start(); await night.refresh();
    t.eq(night.mood, 'sleeping', 'the pet sleeps at night');
    const pinned = makeBrain({active: three(), mood: 'angry', angrySince: at('2026-10-27T10:00')});
    await pinned.start(); await pinned.refresh();
    t.eq([pinned.mood, pinned.angrySince?.getTime(), pinned.annoyedSince !== null],
        ['angry', at('2026-10-27T10:00').getTime(), true], 'a pinned mood stays (test seam)');
    const meet = makeBrain({active: three(), inMeeting: true, prefs: {stillWhileTyping: true}});
    await meet.start();
    t.check(meet.calmMotion, 'the pet keeps still during a meeting');
}

async function talking(t) {
    const b = makeBrain({prefs: {soundMode: 'important'}});
    await b.start(); await b.settle();
    const events = [];
    b.on('bubble', x => events.push(x?.text ?? null));
    b.say({text: 'Hello\nthere'});
    t.eq([b.bubble.text, b.bubble.seconds, b.bubble.urgent, b.bubble.reminder, b.env.played], ['Hello\nthere', 12, false, false, []],
        'say shows a bubble with the defaults; ordinary chatter is silent in "important only"');
    t.eq(b.diary.today.at(-1).text, 'Pet said “Hello there”', 'what the pet said goes to the diary');
    b.say({text: 'Meeting!', urgent: true}, {chime: 'important', why: 'a meeting at 10:00'});
    t.eq([b.bubble.reminder, b.env.played, b.diary.today.at(-1).kind, b.diary.today.at(-1).text],
        [true, ['important'], 'bubble', '“Meeting!” — because a meeting at 10:00'], 'a reminder plays its chime and says why');
    b.say({text: 'Pick one', actions: [{title: 'A', run: () => {}}]});
    b.say({text: 'Small talk'});
    t.eq(b.bubble.text, 'Pick one', 'small talk does not replace a bubble with buttons');
    b.quiet(60);
    t.check(b.bubble === null && b.quietUntil?.getTime() === at('2026-10-27T12:00').getTime() &&
        b.diary.today.at(-1).kind === 'hold', 'quiet hides the bubble and is written to the diary');
    t.eq(b.prefs.quietUntil, at('2026-10-27T12:00').getTime(), 'quiet survives a restart');
    b.quiet(null);
    t.check(b.quietUntil === null && b.diary.today.at(-1).text === 'You turned reminders back on', 'reminders back on');
    t.eq(events, ['Hello\nthere', 'Meeting!', 'Pick one', null], 'every shown or hidden bubble is announced');
    b.noteResponse('closed'); b.noteResponse('ignored');
    t.eq(b.diary.today.slice(-2).map(e => e.tag), ['closed', 'ignored'], 'closed and ignored bubbles go to the diary');
}

async function lifeStorage(t) {
    const failing = new MemoryStore();
    failing.load = async name => {
        if (name === 'life')
            throw new Error('disk on fire');
        return null;
    };
    const errors = [];
    const b = makeBrain({store: failing, active: [task('a', '2026-10-27')]});
    b._log = message => errors.push(message);
    await b.start(); await b.refresh();
    b.todo.completeRemotely('a'); await b.refresh();
    b.tick(at('2026-10-27T11:00:20'));
    b.tick(at('2026-10-27T11:04:00')); await b.settle();
    t.check(b.life.state.totalDone === 1 && failing.saves.every(([name]) => name !== 'life'),
        'a pet that could not be read lives in memory and is never saved over the old one');
    t.eq(errors.filter(e => e.includes('disk on fire')).length, 1, 'the failed read is logged once');
    failing.load = async () => null;
    b.tick(at('2026-10-27T11:07:30')); await b.settle();
    b.tick(at('2026-10-27T11:07:50'));
    t.check(failing.saves.some(([name]) => name === 'life'), 'once it can be read, the pet is saved again');
    const store = new MemoryStore({life: {totalDone: 7, dayKey: '2026-10-27', xp: 70}});
    const kept = makeBrain({store});
    await kept.start();
    t.eq(kept.life.state.totalDone, 7, 'the saved pet is loaded at start');
}
