// The reminder rules, deep-work protection, distraction tracking and mischief (Task 15), with every service faked.
import {getLang, setLang} from '../extension/core/l10n.js';
import {setLinesRandom} from '../extension/core/lines.js';
import {MemoryStore, at, done, makeBrain, meeting, task} from './helpers.js';

const FOCUS = '▶︎ Focus 25\'';
const SPARE = 'Spare me 15\'';

const three = () => [task('a', '2026-10-27'), task('b', '2026-10-27'), task('c', '2026-10-27')];
const youtube = since => ({
    appName: 'Firefox', wmClass: 'firefox', title: 'Cats - YouTube — Mozilla Firefox', isBrowser: true, since,
});
const titles = b => b.bubble?.actions.map(x => x.title) ?? null;
const action = (b, title) => b.bubble.actions.find(x => x.title === title);
const lastOf = (b, kind) => b.diary.today.filter(e => e.kind === kind).at(-1) ?? null;

export default async function (t) {
    const savedLang = getLang();
    setLang('en');
    setLinesRandom(() => 0);
    try {
        await brief(t);
        await meetingsAndDueTimes(t);
        await calm(t);
        await distraction(t);
        await mischief(t);
        await otherRules(t);
    } finally {
        setLang(savedLang);
        setLinesRandom();
    }
}

// The checks from the task brief, word for word, then a few more on the same brains.
async function brief(t) {
    setLang('en');
    const m = makeBrain({events: [meeting('2026-10-27T10:04', 30, 'https://meet.google.com/x')], overdue: 3, now: at('2026-10-27T10:00')});
    await m.start(); await m.refresh(); m.tick(at('2026-10-27T10:00:01'));
    t.eq(m.lastRule, 'meeting', 'meeting reminder beats everything');
    t.check(m.bubble.actions.some(a => a.title === 'Join ↗'), 'join button with a link');
    const p = makeBrain({active: [task('a', '2026-10-27', 1)], now: at('2026-10-27T11:05')});
    await p.start(); await p.refresh(); p.tick(at('2026-10-27T11:05:01'));
    t.eq(p.lastRule, 'plan', 'asks to plan after the deadline when below target');
    const f = makeBrain({active: three(), env: {typingSince: at('2026-10-27T14:00')}, now: at('2026-10-27T14:11')});
    await f.start(); await f.refresh(); f.forceDue('nudge'); f.tick(at('2026-10-27T14:11:01'));
    t.check(f.lastRule !== 'nudge' && f.diary.today.some(e => e.kind === 'hold'), 'deep work holds the nudge');
    const g = makeBrain({active: three(), overdue: 1, prefs: {remindEvery: 5}, now: at('2026-10-27T14:00')});
    await g.start(); await g.refresh(); g.tick(at('2026-10-27T14:00:01'));
    t.eq(g.lastRule, 'overdue', 'overdue tasks get a reminder');
    g.lastRule = null; g.forceDue('nudge'); g.tick(at('2026-10-27T14:10:00'));
    t.check(g.lastRule === null && g.diary.today.some(e => e.kind === 'hold'), 'bubble gap of 15 minutes holds the next reminder');
    const d = makeBrain({active: three(), now: at('2026-10-27T15:03'),
        env: {focus: {appName: 'Firefox', wmClass: 'firefox', title: 'Cats - YouTube — Mozilla Firefox', isBrowser: true, since: at('2026-10-27T15:00')}}});
    await d.start(); await d.refresh(); d.tick(at('2026-10-27T15:03:01'));
    t.eq(d.lastRule, 'distraction', 'three minutes on YouTube, matched by window title');
    const a = makeBrain({active: three(), mood: 'angry', angrySince: at('2026-10-27T15:00'), now: at('2026-10-27T15:11')});
    await a.start(); await a.refresh(); a.tick(at('2026-10-27T15:11:01'));
    t.eq(a.antic?.kind, 'parade', 'ten grumpy minutes start the sign parade');
    const q = makeBrain({active: three(), mood: 'angry', angrySince: at('2026-10-27T15:00'), inMeeting: true, now: at('2026-10-27T15:11')});
    await q.start(); await q.refresh(); q.tick(at('2026-10-27T15:11:01'));
    t.eq(q.antic, null, 'no mischief during meetings');

    // Around the brief's checks.
    t.eq([m.bubble.text, m.bubble.urgent, m.bubble.seconds, titles(m)],
        ['📅 Meeting in 4 min: “Meeting 10:04” (10:04)', true, 90, ['Join ↗', 'OK']],
        'the meeting bubble says how soon, is urgent and stays 90 seconds');
    action(m, 'Join ↗').run();
    t.eq(m.env.opened, ['https://meet.google.com/x'], 'Join opens the meeting link');
    t.check(m.env.played.includes('important') && lastOf(m, 'bubble').text.endsWith('— because meeting at 10:04'),
        'a meeting reminder plays the important chime and says why in the diary');
    t.eq(titles(p), ['＋ Add tasks', 'Later'], 'planning offers to add tasks');
    t.check(f.flow && lastOf(f, 'flow')?.tag === 'flowStart' &&
        lastOf(f, 'hold')?.text === "A reminder is due but you're in the zone — later", 'ten minutes of steady typing is the zone');
    t.check(g.bubble === null && lastOf(g, 'hold')?.text === 'Held a reminder: last one at 14:00, at least 15 min apart',
        'the hold says when the pet last spoke');
    t.eq(lastOf(d, 'bubble').text.split(' — because ')[1], 'on youtube.com for 3 min during work hours',
        'the distraction reminder says why');
    t.eq(titles(d), [FOCUS, "Just a quick break (10')"], 'a distraction offers focus or a short break');
    t.eq(d.life.state.distraction, {'youtube.com': 15}, 'each round on a distracting site adds 15 seconds to the day');
    action(d, "Just a quick break (10')").run();
    t.eq(d.distractionSnoozedUntil.getTime(), at('2026-10-27T15:13:01').getTime(), 'a quick break lets the site be for 10 minutes');
    d.tick(at('2026-10-27T15:03:16')); d.tick(at('2026-10-27T15:05:01'));
    t.eq(lastOf(d, 'distraction')?.text, 'On youtube.com for 2+ minutes', 'two minutes on a site go to the diary');
    d.env.focused = null; d.tick(at('2026-10-27T15:06:01'));
    const left = lastOf(d, 'distraction');
    t.eq([left?.text, left?.tag, left?.minutes, d.life.state.distraction], ['Left youtube.com after 3 minutes', 'end', 3, {'youtube.com': 45}],
        'leaving the site writes how long you stayed; the time stops adding up');
    t.eq([Object.keys(a.antic).sort(), a.antic.text, a.antic.start.getTime(), a.lastRule, a.bubble.urgent, titles(a)],
        [['id', 'kind', 'start', 'text'], 'Task a', at('2026-10-27T15:11:01').getTime(), 'antic', true, [FOCUS, SPARE]],
        'the parade carries the avoided task on its sign');
    t.check(lastOf(a, 'antic')?.text.includes('because grumpy for 11 min, not typing → sign parade') && a.env.spoken.length === 0,
        'the parade goes to the diary with its reason; no voice unless it is on');
    t.eq(q.diary.today.filter(e => e.kind === 'meeting').length, 1, 'the pinned test meeting keeps the pet quiet like a real one');
}

async function meetingsAndDueTimes(t) {
    const noLink = makeBrain({events: [meeting('2026-10-27T10:04', 30)], now: at('2026-10-27T10:00')});
    await noLink.start(); await noLink.refresh(); noLink.tick(at('2026-10-27T10:00:01'));
    t.eq([noLink.lastRule, titles(noLink)], ['meeting', ['OK']], 'a meeting without a link only gets OK');

    const busy = makeBrain({active: three(), overdue: 1, events: [meeting('2026-10-27T10:00', 60)], now: at('2026-10-27T10:30')});
    await busy.start(); await busy.refresh();
    busy.tick(at('2026-10-27T10:30:01')); busy.tick(at('2026-10-27T10:30:16'));
    const notes = busy.diary.today.filter(e => e.kind === 'meeting');
    t.check(busy.lastRule === null && notes.length === 1 && notes[0].text === 'In “Meeting 10:00” until 11:00 — the pet stays quiet',
        'during a meeting the pet stays quiet and says so once');

    const focused = makeBrain({events: [meeting('2026-10-27T10:04', 30)], now: at('2026-10-27T10:00')});
    await focused.start(); await focused.refresh();
    focused.focusSession = {task: null, start: at('2026-10-27T09:50'), end: at('2026-10-27T10:15'), isBreak: false, minutes: 25};
    focused.tick(at('2026-10-27T10:00:01'));
    t.eq(focused.lastRule, 'meeting', 'meetings come first, even during a focus session');

    const due = makeBrain({active: [task('t', '2026-10-27T14:08:00'), ...three()], env: {typingSince: at('2026-10-27T13:40')},
        now: at('2026-10-27T14:00')});
    await due.start(); await due.refresh(); due.tick(at('2026-10-27T14:00:01'));
    t.check(due.flow && due.lastRule === 'due' && due.bubble.text === '⏰ In 8 min: “Task t”',
        'a task with a time: 10 minutes before, even in deep work');
    t.eq(titles(due), [FOCUS, '✓ Done'], 'a task time offers focus or done');
    due.lastRule = null; due.tick(at('2026-10-27T14:08:30'));
    t.check(due.lastRule === 'due' && due.bubble.text === '⏰ It\'s time: “Task t”!', 'and when it is due');
}

async function calm(t) {
    const typing = makeBrain({active: three(), mood: 'normal', firedToday: ['morning', 'timeblock'], env: {secondsSinceKey: 3},
        now: at('2026-10-27T14:00')});
    await typing.start(); await typing.refresh(); typing.tick(at('2026-10-27T14:00:01'));
    t.check(typing.lastRule === null && lastOf(typing, 'hold')?.text === "Held a reminder: you're typing — waiting for a pause",
        'typing holds a reminder until a pause');
    typing.env.appSwitch = at('2026-10-27T14:00:10'); typing.tick(at('2026-10-27T14:00:16'));
    t.eq(typing.lastRule, 'nudge', 'switching apps is a natural pause');

    const zone = makeBrain({active: three(), env: {typingSince: at('2026-10-27T14:00')}, now: at('2026-10-27T14:11')});
    await zone.start(); await zone.refresh(); zone.tick(at('2026-10-27T14:11:01'));
    zone.env.sinceKey = 200; zone.tick(at('2026-10-27T14:13:01'));
    const end = lastOf(zone, 'flow');
    t.check(!zone.flow && end?.tag === 'flowEnd' && end.minutes === 13 && zone.lastFlowEnd.getTime() === at('2026-10-27T14:13:01').getTime(),
        'two minutes without typing ends the zone');
    const unprotected = makeBrain({active: three(), prefs: {protectFlow: false}, env: {typingSince: at('2026-10-27T14:00')},
        now: at('2026-10-27T14:11')});
    await unprotected.start(); await unprotected.refresh(); unprotected.tick(at('2026-10-27T14:11:01'));
    t.check(!unprotected.flow, 'without focus protection there is no zone');

    const gap = makeBrain({active: three(), overdue: 1, mood: 'normal', now: at('2026-10-27T14:00')});
    await gap.start(); await gap.refresh(); gap.tick(at('2026-10-27T14:00:01'));
    t.eq([gap.lastRule, titles(gap)], ['overdue', ['Move to today', 'Show']], 'overdue tasks: move them to today or look at them');
    const boards = [];
    gap.openBoard = focusAdd => boards.push(focusAdd);
    action(gap, 'Show').run();
    t.eq(boards, [false], 'Show opens the board');
    gap.lastRule = null; gap.forceDue('overdue'); gap.tick(at('2026-10-27T14:10:00'));
    t.eq(gap.lastRule, null, 'the gap holds the reminder');
    gap.tick(at('2026-10-27T14:16:00'));
    t.eq(gap.lastRule, 'overdue', 'once the gap has passed, the held reminder comes');

    const hush = makeBrain({active: three(), mood: 'normal', now: at('2026-10-27T14:00')});
    await hush.start(); await hush.refresh(); hush.quiet(60); hush.tick(at('2026-10-27T14:00:01'));
    t.eq(hush.lastRule, null, 'quiet mutes every reminder');
    hush.tick(at('2026-10-27T15:00:30'));
    t.check(hush.lastRule !== null && hush.quietUntil === null, 'reminders come back when the quiet time is over');

    const away = makeBrain({active: three(), mood: 'normal', firedToday: ['morning', 'timeblock'], env: {idleSeconds: 400},
        now: at('2026-10-27T14:00')});
    await away.start(); await away.refresh(); away.tick(at('2026-10-27T14:00:01'));
    t.check(away.lastRule === null && lastOf(away, 'system')?.text === 'You stepped away at 13:53 — no reminders',
        'away from the computer: no reminders');
    away.env.idle = 0; away.tick(at('2026-10-27T14:30:00'));
    t.check(away.lastRule === 'welcome' && away.diary.today.some(e => e.text === 'You came back after 36 minutes') &&
        away.bubble.text === 'Welcome back! 👋 Continue with “Task a”?', 'coming back after a while: welcome back with the next task');

    const locked = makeBrain({active: three(), mood: 'normal', now: at('2026-10-27T14:00')});
    await locked.start(); await locked.refresh(); locked.setLocked(true); locked.tick(at('2026-10-27T14:00:01'));
    t.check(locked.lastRule === null && lastOf(locked, 'system')?.text === 'You stepped away at 14:00 — no reminders',
        'a locked screen counts as away');

    const shown = makeBrain();
    await shown.start(); await shown.refresh();
    shown.say({text: 'Hi', seconds: 5});
    shown.tick(at('2026-10-27T11:00:06'));
    const still = shown.bubble?.text;
    shown.tick(at('2026-10-27T11:00:08'));
    t.eq([still, shown.bubble], ['Hi', null], 'a bubble nobody took away is gone shortly after its time');
}

async function distraction(t) {
    const steam = makeBrain({active: three(), mood: 'normal', now: at('2026-10-27T15:03'),
        env: {focus: {appName: 'Steam', wmClass: 'steam', title: 'Library', isBrowser: false, since: at('2026-10-27T15:00')}}});
    await steam.start(); await steam.refresh(); steam.tick(at('2026-10-27T15:03:01'));
    t.check(steam.lastRule === 'distraction' && steam.bubble.text === 'Hey! On Steam? 👀 3 task(s) left.',
        'a distracting app, matched by its name');

    const unwatched = makeBrain({active: three(), mood: 'normal', prefs: {watchBrowsers: false}, now: at('2026-10-27T15:03'),
        env: {focus: youtube(at('2026-10-27T15:00'))}});
    await unwatched.start(); await unwatched.refresh(); unwatched.tick(at('2026-10-27T15:03:01'));
    t.check(unwatched.lastRule !== 'distraction' && Object.keys(unwatched.life.state.distraction).length === 0,
        'sites are left alone when browsers are not watched');

    const evening = makeBrain({active: three(), now: at('2026-10-27T19:03'), env: {focus: youtube(at('2026-10-27T19:00'))}});
    await evening.start(); await evening.refresh(); evening.tick(at('2026-10-27T19:03:01'));
    t.check(evening.lastRule !== 'distraction' && Object.keys(evening.life.state.distraction).length === 0,
        'after work hours the pet does not count or mind the site');
}

async function mischief(t) {
    const grumpy = (extra = {}) => makeBrain({active: three(), now: at('2026-10-27T15:11'), ...extra});

    const gr = grumpy({mood: 'annoyed', annoyedSince: at('2026-10-27T15:00')});
    const started = [];
    gr.on('antic', x => started.push(x.kind));
    await gr.start(); await gr.refresh(); gr.tick(at('2026-10-27T15:11:01'));
    t.eq([gr.lastRule, gr.antic?.kind, gr.antic?.text, gr.bubble?.urgent, titles(gr), started],
        ['antic', 'grumble', 'Task a', false, [FOCUS, SPARE], ['grumble']], 'ten annoyed minutes: the pet grumbles');
    const early = grumpy({mood: 'annoyed', annoyedSince: at('2026-10-27T15:02')});
    await early.start(); await early.refresh(); early.tick(at('2026-10-27T15:11:01'));
    t.eq(early.antic, null, 'nine annoyed minutes are not enough to grumble');
    const cross = grumpy({mood: 'angry', angrySince: at('2026-10-27T15:02')});
    await cross.start(); await cross.refresh(); cross.tick(at('2026-10-27T15:11:01'));
    t.eq(cross.antic, null, 'nine grumpy minutes are not enough for the parade');

    const bl = grumpy({mood: 'angry', angrySince: at('2026-10-27T15:00'), env: {focus: youtube(at('2026-10-27T15:00'))}});
    const ended = [];
    bl.on('antic-end', () => ended.push(true));
    await bl.start(); await bl.refresh(); bl.tick(at('2026-10-27T15:11:01'));
    t.eq([bl.lastRule, bl.antic?.kind, bl.antic?.text, bl.bubble?.urgent], ['antic', 'block', 'youtube.com', true],
        'grumpy and on a distracting site for 5 minutes: the pet jumps in the way');
    t.check(bl.bubble.text.includes('ENOUGH YOUTUBE.COM!'), 'the table flip names the site');
    bl.env.focused = null; bl.tick(at('2026-10-27T15:11:16'));
    t.check(bl.antic === null && ended.length === 1, 'leaving the site ends the block');
    const meh = grumpy({mood: 'annoyed', annoyedSince: at('2026-10-27T15:05'), env: {focus: youtube(at('2026-10-27T15:00'))}});
    await meh.start(); await meh.refresh(); meh.tick(at('2026-10-27T15:11:01'));
    t.eq([meh.lastRule, meh.antic], ['distraction', null], 'the block needs a grumpy pet');
    const soon = grumpy({mood: 'angry', angrySince: at('2026-10-27T15:00'), env: {focus: youtube(at('2026-10-27T15:07'))}});
    await soon.start(); await soon.refresh(); soon.tick(at('2026-10-27T15:11:01'));
    t.eq([soon.lastRule, soon.antic], ['distraction', null], 'the block waits for five minutes on the site');

    const twice = grumpy({mood: 'angry', angrySince: at('2026-10-27T15:00')});
    await twice.start(); await twice.refresh(); twice.tick(at('2026-10-27T15:11:01'));
    twice.endAntic();
    twice.env.focused = youtube(at('2026-10-27T15:20'));
    twice.tick(at('2026-10-27T15:26:00'));
    t.eq([twice.lastRule, twice.antic], ['distraction', null], 'no second stunt within 20 minutes of the last');
    twice.tick(at('2026-10-27T15:31:02'));
    t.eq(twice.antic?.kind, 'block', 'after 20 minutes the next stunt may come');

    const typing = grumpy({mood: 'angry', angrySince: at('2026-10-27T15:00'), env: {secondsSinceKey: 30}});
    await typing.start(); await typing.refresh(); typing.tick(at('2026-10-27T15:11:01'));
    t.eq(typing.antic, null, 'no mischief while you type');
    const away = grumpy({mood: 'angry', angrySince: at('2026-10-27T15:00'), env: {idleSeconds: 400}});
    await away.start(); await away.refresh(); away.tick(at('2026-10-27T15:11:01'));
    t.eq([away.antic, away.lastRule], [null, null], 'no mischief while you are away');
    const focusing = grumpy({mood: 'angry', angrySince: at('2026-10-27T15:00')});
    await focusing.start(); await focusing.refresh();
    focusing.focusSession = {task: null, start: at('2026-10-27T15:05'), end: at('2026-10-27T15:30'), isBreak: false, minutes: 25};
    focusing.tick(at('2026-10-27T15:11:01'));
    t.eq([focusing.antic, focusing.lastRule], [null, null], 'no mischief during a focus session');
    const tame = grumpy({mood: 'angry', angrySince: at('2026-10-27T15:00'), prefs: {antics: false}});
    await tame.start(); await tame.refresh(); tame.tick(at('2026-10-27T15:11:01'));
    t.eq(tame.antic, null, 'no mischief when it is turned off');

    const loud = grumpy({mood: 'angry', angrySince: at('2026-10-27T15:00'), prefs: {voiceOn: true}});
    await loud.start(); await loud.refresh(); loud.tick(at('2026-10-27T15:11:01'));
    t.eq(loud.env.spoken, ['Hey! Do Task a now!'], 'with the voice on, the parade is said out loud');

    const spared = grumpy({mood: 'angry', angrySince: at('2026-10-27T15:00')});
    const calledOff = [];
    spared.on('antic-end', () => calledOff.push(true));
    await spared.start(); await spared.refresh(); spared.tick(at('2026-10-27T15:11:01'));
    action(spared, SPARE).run();
    const until = at('2026-10-27T15:26:01').getTime();
    t.check(spared.antic === null && calledOff.length === 1 && spared.anticSnoozedUntil.getTime() === until &&
        spared.distractionSnoozedUntil.getTime() === until, "“Spare me 15'” calls the pet off for 15 minutes");
}

async function otherRules(t) {
    const mo = makeBrain({active: [task('a', '2026-10-27')], firedToday: [], now: at('2026-10-27T09:00')});
    await mo.start(); await mo.refresh(); mo.tick(at('2026-10-27T09:00:01'));
    t.check(mo.lastRule === 'morning' && mo.fired.has('plan') && mo.bubble.text.startsWith('Good morning!'),
        'the first greeting of the workday asks for a plan, which counts as asking');
    t.eq(titles(mo), ['＋ Add tasks', 'Later'], 'the greeting offers to add tasks');

    const po = makeBrain({active: [task('a', '2026-10-27')], overdue: 2, now: at('2026-10-27T11:05')});
    await po.start(); await po.refresh(); po.tick(at('2026-10-27T11:05:01'));
    t.eq([po.lastRule, titles(po)], ['plan', ['＋ Add tasks', 'Pull 2 overdue in', 'Later']], 'planning can pull overdue tasks in');

    const nu = makeBrain({active: three(), mood: 'normal', firedToday: ['morning', 'timeblock'], now: at('2026-10-27T14:00')});
    await nu.start(); await nu.refresh(); nu.tick(at('2026-10-27T14:00:01'));
    t.eq([nu.lastRule, nu.bubble.text, titles(nu)], ['nudge', 'Next: “Task a”. Want a focus session?', [FOCUS, '✓ Done', 'Later']],
        'a nudge with the next task');
    action(nu, 'Later').run();
    t.eq(nu.fired.get('nudge').getTime(), at('2026-10-27T13:45:01').getTime(), 'Later makes the nudge due again in 30 minutes');

    const st = makeBrain({active: [task('s', '2026-10-24'), ...three()], mood: 'normal', now: at('2026-10-27T14:00')});
    await st.start(); await st.refresh(); st.tick(at('2026-10-27T14:00:01'));
    t.eq([st.lastRule, titles(st), st.fired.has('stuck-s-2026-10-27')], ['stuck', ['✂️ Split it', 'Drop from plan', 'Later'], true],
        'a task that keeps getting postponed: split it or drop it');
    const split = [];
    st.openBreakdown = x => split.push(x.id);
    action(st, '✂️ Split it').run();
    t.check(split[0] === 's' && lastOf(st, 'bubble').text.endsWith('because “Task s” has been on your list 4 days'),
        'Split opens the split view for that task');

    const hu = makeBrain({active: three(), mood: 'normal', prefs: {voiceOn: true}, now: at('2026-10-27T14:00'),
        store: new MemoryStore({life: {satiety: 20, dayKey: '2026-10-27'}})});
    await hu.start(); await hu.refresh(); hu.tick(at('2026-10-27T14:00:01'));
    t.eq([hu.lastRule, hu.bubble.text, hu.env.spoken], ['hungry', 'My tummy is rumbling 🍙 Finish “Task a” and feed me 🥺', ["I'm so hungry."]],
        'a hungry pet begs for a finished task');

    const tb = makeBrain({active: three(), mood: 'normal', now: at('2026-10-27T14:00')});
    await tb.start(); await tb.refresh(); tb.tick(at('2026-10-27T14:00:01'));
    t.eq([tb.lastRule, titles(tb)], ['timeblock', ['⏰ Set time', 'Later']], 'once a day, a time slot for the next task');

    const rv = makeBrain({active: three(), mood: 'normal', firedToday: ['morning', 'timeblock'], now: at('2026-10-27T17:31')});
    await rv.start(); await rv.refresh(); rv.tick(at('2026-10-27T17:31:01'));
    t.eq([rv.lastRule, titles(rv)], ['review', ['Move to tomorrow', 'Keep going']], 'the end-of-day review');

    const ds = makeBrain({mood: 'normal', now: at('2026-10-27T17:31'),
        store: new MemoryStore({life: {distraction: {'youtube.com': 700}, dayKey: '2026-10-27'}})});
    ds.markFired('plan');
    await ds.start(); await ds.refresh(); ds.tick(at('2026-10-27T17:31:01'));
    t.eq([ds.lastRule, ds.bubble?.text], ['distractsum', "You spent 11 minutes on distractions today 😒 (youtube.com 11')"],
        'a sulky report on the day\'s distractions');

    const ni = makeBrain({active: three(), now: at('2026-10-27T23:10')});
    await ni.start(); await ni.refresh(); ni.tick(at('2026-10-27T23:10:01'));
    t.eq([ni.lastRule, ni.bubble?.text], ['night', "It's late… sleep now, crush it tomorrow 😴"], 'past 11pm: go to bed');

    const ad = makeBrain({completed: [done('z', '2026-10-27T03:00:00Z')], now: at('2026-10-27T14:00')});
    await ad.start(); await ad.refresh(); ad.tick(at('2026-10-27T14:00:01'));
    t.check(ad.lastRule === 'alldone' && ad.mood === 'celebrating' && titles(ad)[0] === '＋ Plan tomorrow',
        'everything done: celebrate and offer to plan tomorrow');

    const tp = makeBrain({completed: [done('z', '2026-10-27T03:00:00Z')], mood: 'happy', firedToday: ['morning', 'alldone'],
        now: at('2026-10-27T14:00')});
    tp.markFired('plan');
    await tp.start(); await tp.refresh(); tp.tick(at('2026-10-27T14:00:01'));
    t.check(tp.lastRule === 'tip' && tp.bubble.text.startsWith('Tip: do the hardest task first'), 'a tip when the mood is good');

    const tk = makeBrain({token: null, now: at('2026-10-27T11:00')});
    await tk.start();
    tk.tick(at('2026-10-27T11:00:02')); tk.tick(at('2026-10-27T11:00:17'));
    const asks = () => tk.diary.today.filter(e => e.tag === 'askToken').length;
    t.eq(asks(), 1, 'the hello is not repeated by the next round of rules');
    tk.tick(at('2026-10-27T12:00:03'));
    t.check(tk.lastRule === 'token' && asks() === 2, 'without a token the pet asks again every hour');
}
