import {getLang, setLang} from '../extension/core/l10n.js';
import {lifeStateFromJSON} from '../extension/core/life.js';
import {DaySnapshot, Task} from '../extension/core/models.js';
import {Mood} from '../extension/core/mood.js';
import {
    BOARD, addPlaceholder, boardModel, calendarModel, dayDots, dueChoices, hotkeyLabel, lifeModel, listHeight,
    placeBoard, priorityChoices, progressText, reasonBreakdown, reasonLine, taskRow,
} from '../extension/ui/boardLogic.js';

// The nested shell's work area: a 1600×900 monitor under a 32 px top bar; a 124 px pet on its bottom edge.
const WA = Object.freeze({x: 0, y: 32, width: 1600, height: 868});
const PET = Object.freeze({x: 1336, y: 782, width: 124, height: 124});

// Wednesday 28 October 2026, local time (the tests run with TZ=Asia/Ho_Chi_Minh).
const at = (h, m = 0) => new Date(2026, 9, 28, h, m);
const NOW = at(12, 41);

// The demo's tasks (services/demo.js) on the reference screenshot's day: two for today, one three days late.
const WRITE = new Task({id: '1', content: 'Write the weekly report', priority: 4, due: {date: '2026-10-28', string: 'today'}});
const CALL = new Task({id: '2', content: 'Call client ABC', priority: 3, due: {date: '2026-10-28T13:00:00', string: 'today'}});
const REPLY = new Task({id: '3', content: 'Reply to the boss\'s email', priority: 1, due: {date: '2026-10-25', string: 'Monday'}});
const DAY = DaySnapshot.build({active: [WRITE, CALL, REPLY], completed: [], now: NOW});

const EVENTS = Object.freeze([
    {id: 'e1', title: 'Team sync', start: at(13), end: at(14), joinURL: 'https://meet.google.com/abc-defg-hij'},
    {id: 'e2', title: 'Client meeting', start: at(16), end: at(16, 45), joinURL: null},
]);
const SUGGESTIONS = Object.freeze([
    {task: WRITE, start: at(14), end: at(15)},
    {task: REPLY, start: at(15, 10), end: at(16)},
]);
// LifeState.demo, as the brain keeps it for the demo.
const LIFE = lifeStateFromJSON({
    satiety: 55, xp: 320, totalDone: 31, streak: 4, bestStreak: 4,
    distraction: {'youtube.com': 720, 'facebook.com': 300},
});

const PREFS = Object.freeze({
    petName: 'Mochi', focusMinutes: 25, useCalendar: true, workStart: 8, workEnd: 18, dailyTarget: 3,
});

// What the board reads from the brain, as on docs/board-light.png.
function brainLike(changes = {}) {
    return {
        hasToken: true,
        demo: true,
        mood: Mood.angry,
        reasons: [{delta: -38, text: 'only 2/3 tasks planned'}, {delta: -7, text: '1 overdue task(s)'}],
        streak: 4,
        day: DAY,
        target: 3,
        life: {state: LIFE},
        errorText: null,
        events: EVENTS,
        suggestions: SUGGESTIONS,
        stuckTasks: [{task: REPLY, days: 4}],
        focusSession: null,
        loading: false,
        lastSync: at(12, 41),
        ...changes,
    };
}

const model = (brainChanges = {}, options = {}) => boardModel({
    brain: brainLike(brainChanges), prefs: PREFS, now: NOW, hasJoinLinks: true, ...options,
});

function placementTests(t) {
    const size = {width: 370, height: 600};
    {
        const p = placeBoard({petFrame: PET, size, workArea: WA});
        // The pet's body starts 28% down its frame; the board ends 6 px above that: 782 + 35 - 6 = 811.
        t.eq(p, {x: 1213, y: 811 - 600, side: 'above'}, 'above the pet, centered on it, ending just over its body');
    }
    {
        const p = placeBoard({petFrame: {...PET, x: 1476}, size, workArea: WA});
        t.eq([p.x, p.side], [1600 - 8 - 370, 'above'], 'a pet at the right edge: the board keeps 8 px from the edge');
        const q = placeBoard({petFrame: {...PET, x: 0}, size, workArea: WA});
        t.eq(q.x, 8, 'a pet at the left edge: 8 px from the left edge');
    }
    {
        const tall = {width: 370, height: 800};
        const p = placeBoard({petFrame: PET, size: tall, workArea: WA});
        // 811 - 800 = 11 is above the work area: beside the pet, on the side with more room (the left).
        t.eq(p.side, 'left', 'no room above: beside the pet');
        t.eq(p.x, 1336 - 6 - 370, 'to its left, 6 px away');
        // Its bottom edge would line up with the pet's (906), but the work area ends at 900: 900 - 8 - 800.
        t.eq(p.y, 92, 'and kept inside the work area');
        const q = placeBoard({petFrame: {...PET, x: 100}, size: tall, workArea: WA});
        t.eq([q.side, q.x], ['right', 100 + 124 + 6], 'a pet near the left edge: the board goes to its right');
    }
    {
        const huge = {width: 370, height: 1000};
        const p = placeBoard({petFrame: PET, size: huge, workArea: WA});
        t.eq(p.y, 32 + 8, 'taller than the work area: it starts at the top of the work area');
    }
    {
        const narrow = {x: 0, y: 32, width: 600, height: 868};
        const p = placeBoard({petFrame: {...PET, x: 238}, size: {width: 370, height: 800}, workArea: narrow});
        t.eq(p.side, 'over', 'no room above or beside: over the pet');
        t.check(p.x >= 8 && p.x + 370 <= 592 && p.y >= 40, 'still inside the work area');
    }
    {
        const p = placeBoard({petFrame: null, size, workArea: WA});
        t.eq(p, {x: 1600 - 8 - 370, y: 32 + 8, side: 'corner'}, 'no pet on screen: the top right corner, under the panel');
    }
    {
        const wa = {x: 1600, y: 0, width: 1920, height: 1080};
        const p = placeBoard({petFrame: {x: 3000, y: 956, width: 124, height: 124}, size, workArea: wa});
        t.eq(p.x, 3062 - 185, 'the work area does not have to start at 0');
        const scaled = placeBoard({petFrame: {x: 0, y: 1500, width: 248, height: 248}, size: {width: 740, height: 1200},
            workArea: {x: 0, y: 0, width: 3200, height: 1800}, unit: 2});
        t.eq([scaled.x, scaled.y], [16, 1500 + 69 - 12 - 1200], 'the margin and the gap scale with the stage');
    }
}

function listTests(t) {
    t.eq(BOARD.listCap, 220, 'the task list scrolls past 220 px (Swift: maxHeight 220)');
    t.eq(listHeight({natural: 150, others: 500, available: 852}), 150, 'a short list takes its own height');
    t.eq(listHeight({natural: 400, others: 500, available: 852}), 220, 'a long one stops at 220 px');
    t.eq(listHeight({natural: 400, others: 700, available: 852}), 152, 'on a short screen it gives way to the rest');
    t.eq(listHeight({natural: 400, others: 840, available: 852}), 80, 'but keeps 80 px');
    t.eq(listHeight({natural: 50, others: 840, available: 852}), 50, 'a list shorter than that keeps its height');
    t.eq(listHeight({natural: 900, others: 500, available: 1700, unit: 2}), 440, 'the cap scales with the stage');
}

function headerTests(t) {
    t.eq(dayDots({completed: 0, planned: 2, target: 3}), ['planned', 'planned', 'open'],
        'one dot per task of the target: planned ones filled, missing ones dashed');
    t.eq(dayDots({completed: 1, planned: 2, target: 3}), ['done', 'planned', 'open'], 'finished ones are green');
    t.eq(dayDots({completed: 4, planned: 5, target: 3}), ['done', 'done', 'done', 'done', 'planned'],
        'more planned than the target: one dot per planned task');
    t.eq(progressText({completed: 0, planned: 2, target: 3}), '0/3 done today', 'progress counts against the target');
    t.eq(progressText({completed: 4, planned: 5, target: 3}), '4/5 done today', 'or against the plan when it is bigger');

    t.eq(reasonLine([]), null, 'no reasons: no reason line');
    t.eq(reasonLine([{delta: -38, text: 'only 2/3 tasks planned'}, {delta: 8, text: '1 task(s) done today'}]),
        {label: '▼ only 2/3 tasks planned', up: false}, 'the biggest reason, pointing down when it costs points');
    t.eq(reasonLine([{delta: 16, text: '2 task(s) done today'}]), {label: '▲ 2 task(s) done today', up: true},
        'and up when it adds points');
    t.eq(reasonBreakdown([{delta: -38, text: 'only 2/3 tasks planned'}, {delta: 8, text: '1 task(s) done today'}]),
        '-38  only 2/3 tasks planned\n+8  1 task(s) done today', 'the hover breakdown: every reason with its points');

    const m = model();
    t.eq(m.header.title, 'Mochi grumpy 😤', 'the title: name, mood and its emoji');
    t.eq(m.header.progress, '0/3 done today', 'the progress line');
    t.eq(m.header.reason, {label: '▼ only 2/3 tasks planned', up: false}, 'the reason line');
    t.eq(m.header.streak, {value: '🔥 4', label: 'day streak'}, 'the Todoist streak');
    t.eq(model({streak: 0}).header.streak, null, 'no streak: nothing on the right');
}

function lifeTests(t) {
    const l = lifeModel(LIFE);
    t.eq(l.satiety, {text: '55%', fraction: 0.55, tone: 'orange'}, 'fullness 55%: orange');
    t.eq(lifeModel({...LIFE, satiety: 29.9}).satiety.tone, 'red', 'under 30%: red');
    t.eq(lifeModel({...LIFE, satiety: 30}).satiety.tone, 'orange', '30% is orange');
    t.eq(lifeModel({...LIFE, satiety: 60}).satiety, {text: '60%', fraction: 0.6, tone: 'green'}, '60% and up: green');
    t.eq(lifeModel({...LIFE, satiety: 59.9}).satiety.text, '59%', 'the percentage is cut, not rounded (Swift Int())');
    t.eq(l.dirt, null, 'clean: no flies');
    t.eq(lifeModel({...LIFE, dirt: 2}).dirt, '🪰 ×2', 'dirty: the flies and how many layers');
    t.eq(l.streak, '🔥 4', 'the pet\'s streak');
    t.eq(lifeModel({...LIFE, streak: 0}).streak, null, 'no streak: nothing');
    t.eq(l.stage, {label: '⭐ Teen', fraction: 0.05, xp: '320/700 XP'}, 'teen: 20 of the 400 XP to grown-up');
    t.eq(lifeModel({...LIFE, xp: 1600}).stage, {label: '⭐ Master', fraction: null, xp: '1600 XP · MAX'},
        'the last stage has no bar');
    t.eq(l.distraction, '👀 Distracted today: youtube.com 12\' · facebook.com 5\'', 'today\'s distractions, worst first');
    const four = {'a.com': 60, 'b.com': 600, 'c.com': 300, 'd.com': 59};
    t.eq(lifeModel({...LIFE, distraction: four}).distraction, '👀 Distracted today: b.com 10\' · c.com 5\' · a.com 1\'',
        'at most three of them');
    t.eq(lifeModel({...LIFE, distraction: {'x.com': 59}}).distraction, null, 'under a minute in all: no line');
}

function rowTests(t) {
    const reply = taskRow(REPLY, {overdue: true, stuckDays: 4, now: NOW});
    t.eq(reply.meta, [{kind: 'ago', text: '3 days ago'}, {kind: 'stuck', text: '⏳ 4 days'}],
        'an overdue task: how late it is, and how long it keeps being pushed');
    t.eq(reply.move, {due: 'today', tooltip: 'Move to today'}, 'an overdue task moves to today');
    t.eq([reply.priority, reply.title, reply.id], [4, 'Reply to the boss\'s email', '3'], 'P4, its title and id');
    const call = taskRow(CALL, {overdue: false, now: NOW});
    t.eq(call.meta, [{kind: 'time', text: '13:00'}], 'a task with a time shows it');
    t.eq(call.move, {due: 'tomorrow', tooltip: 'Move to tomorrow'}, 'a task of today moves to tomorrow');
    t.eq(call.priority, 2, 'P2');
    const daily = new Task({id: '9', content: 'Stand-up', priority: 2, labels: ['work', 'team'],
        due: {date: '2026-10-28', string: 'every day', isRecurring: true}});
    const row = taskRow(daily, {overdue: false, now: NOW});
    t.eq(row.meta, [{kind: 'repeat', text: ''}, {kind: 'label', text: '@work'}, {kind: 'label', text: '@team'}],
        'a recurring task with labels');
    t.eq(row.move, null, 'a recurring task cannot be moved');
    t.eq(taskRow(WRITE, {overdue: false, now: NOW, confirming: true}).confirm,
        'Delete from Todoist for good (with any sub-tasks)? This can\'t be undone.', 'the delete confirmation text');
    t.eq(taskRow(WRITE, {overdue: false, now: NOW}).confirm, null, 'no confirmation unless asked');
}

function calendarTests(t) {
    const c = calendarModel({events: EVENTS, suggestions: SUGGESTIONS, now: NOW, prefs: PREFS, target: 3,
        hasJoinLinks: true});
    t.eq(c.meeting, {label: 'Next meeting at 13:00', title: 'Team sync', joinURL: 'https://meet.google.com/abc-defg-hij'},
        'the next meeting, with its join link');
    t.eq(c.summary, '3h34 free until 18:00', 'free time until the end of the work day');
    t.eq(c.blocks.map(b => [b.time, b.title]), [['14:00–15:00', 'Write the weekly report'],
        ['15:10–16:00', 'Reply to the boss\'s email']], 'the suggested time blocks');
    t.check(c.blocks[0].slot === SUGGESTIONS[0], 'each block keeps its slot for "Set time"');
    t.eq(c.blocksTitle, 'Suggested time blocks', 'under their title');
    const during = calendarModel({events: EVENTS, suggestions: [], now: at(13, 30), prefs: PREFS, target: 3,
        hasJoinLinks: true});
    t.eq(during.meeting.label, 'In a meeting until 14:00', 'during a meeting: until when');
    t.eq(during.blocks, [], 'no suggestions: no blocks');
    t.eq(calendarModel({events: EVENTS, suggestions: [], now: NOW, prefs: PREFS, target: 3, hasJoinLinks: false})
        .meeting.joinURL, null, 'a calendar without join links: no Join button');
    const done = calendarModel({events: EVENTS, suggestions: [], now: at(17), prefs: PREFS, target: 3,
        hasJoinLinks: true});
    t.eq([done.meeting, done.none], [null, '📅 No more meetings today'], 'after the last meeting');
    t.eq(calendarModel({events: EVENTS, suggestions: [], now: NOW, prefs: PREFS, target: 2, hasJoinLinks: true}).summary,
        '3h34 free until 18:00 · busy day, so today\'s target: 2', 'a busy day lowers the target and says so');
    t.eq(calendarModel({events: [], suggestions: [], now: at(19), prefs: PREFS, target: 3, hasJoinLinks: true}).summary,
        '0h free until 18:00', 'after work: no free time');
}

function modelTests(t) {
    const m = model();
    t.eq(m.view, 'tasks', 'with a token: the tasks');
    t.eq(m.demo, 'Demo mode — sample data.', 'the demo says so');
    t.eq(model({demo: false}).demo, null, 'a real account does not');
    t.eq(m.nag, 'Only 2/3 tasks planned. Add the most important one first!', 'fewer tasks than the target: the nudge');
    t.eq(model({target: 2}).nag, null, 'enough planned: no nudge');
    t.eq([m.frog.task.id, m.frog.label, m.frog.title, m.frog.focus], ['1', 'Do this first', 'Write the weekly report', '▶︎ 25\''],
        'the frog: the next task, with a focus button');
    const focusing = model({focusSession: {task: WRITE, start: at(12), end: at(12, 25), isBreak: false, minutes: 25}});
    t.eq(focusing.frog.focus, null, 'during a focus session the frog has no focus button');
    t.eq(focusing.footer.focus, {label: 'Stop focus', stop: true, enabled: true}, 'and the footer stops it');
    t.eq(model({focusSession: {task: null, start: at(12), end: at(12, 5), isBreak: true, minutes: 5}}).footer.focus.label,
        'End break', 'or ends the break');
    t.eq(m.footer.focus, {label: 'Focus 25\'', stop: false, enabled: true}, 'otherwise the footer starts one');
    t.eq([m.footer.loading, m.footer.lastSync], [false, '12:41'], 'the time of the last sync');
    t.eq(model({loading: true}).footer.loading, true, 'or that it is syncing');
    t.check(m.calendar !== null && m.calendar.meeting.title === 'Team sync', 'the calendar card');
    t.eq(boardModel({brain: brainLike(), prefs: {...PREFS, useCalendar: false}, now: NOW, hasJoinLinks: true}).calendar,
        null, 'the calendar off: no card');

    t.eq([m.lists.overdue.title, m.lists.overdue.moveAll], ['Overdue · 1', 'Move all to today'],
        'the overdue section, with "Move all to today"');
    t.eq(m.lists.overdue.rows.map(r => [r.id, r.meta.map(x => x.text)]), [['3', ['3 days ago', '⏳ 4 days']]],
        'its task, late and stuck');
    t.eq(m.lists.today.title, 'Today · 2', 'today\'s section');
    t.eq(m.lists.today.rows.map(r => r.id), ['1', '2'], 'highest priority first');
    t.eq(m.lists.today.empty, null, 'not empty');
    t.eq(m.lists.done, null, 'nothing done yet: no "Done today"');
    const recurringOnly = new Task({...REPLY, due: {date: '2026-10-25', string: 'every monday', isRecurring: true}});
    const late = DaySnapshot.build({active: [recurringOnly], completed: [], now: NOW});
    t.eq(model({day: late}).lists.overdue.moveAll, null, 'only recurring tasks overdue: no "Move all"');
    const empty = model({day: DaySnapshot.build({active: [], completed: [], now: NOW})});
    t.eq([empty.lists.overdue, empty.lists.today.title, empty.lists.today.empty, empty.frog],
        [null, 'Today · 0', 'Nothing planned for today yet.', null], 'an empty day');
    const finished = new Task({...WRITE, checked: true, completedAt: '2026-10-28T03:00:00Z'});
    const halfDone = DaySnapshot.build({active: [CALL], completed: [finished], now: NOW});
    const withDone = model({day: halfDone}, {showDone: true});
    t.eq([withDone.lists.done.label, withDone.lists.done.open, withDone.lists.done.titles],
        ['Done today (1)', true, ['Write the weekly report']], 'what is done today, folded or open');
    t.eq(model({day: halfDone}).lists.done.open, false, 'folded by default');
    t.eq(model({}, {confirmId: '3'}).lists.overdue.rows[0].confirm !== null, true, 'the row being deleted asks first');
    t.eq(m.error, null, 'no error');
    t.eq(model({errorText: 'Todoist rejected the token'}).error, '⚠️ Todoist rejected the token', 'an error');

    const setup = model({hasToken: false, demo: false, mood: Mood.normal, reasons: []});
    t.eq([setup.view, setup.life, setup.header.title], ['setup', null, 'Mochi chill 🙂'],
        'no token: the token setup, no life bar');
    t.eq(setup.footer.focus.enabled, false, 'and no focus without a token');
    t.eq(m.life.stage.label, '⭐ Teen', 'the life bar');
    t.eq(m.life.wardrobe, '👗 Wardrobe', 'with the wardrobe button');
}

function addRowTests(t) {
    t.eq(dueChoices().map(c => [c.id, c.label]),
        [['today', 'Today'], ['tomorrow', 'Tomorrow'], ['none', 'No date'], ['smart', '✨ Todoist syntax']],
        'the due choices (Swift: DueChoice)');
    t.eq(priorityChoices().map(c => [c.value, c.label]), [[4, 'P1'], [3, 'P2'], [2, 'P3'], [1, 'P4']],
        'priorities as Todoist shows them, sent as API priorities');
    t.eq(addPlaceholder('today'), 'Add a task… (Enter to save)', 'the add field\'s hint');
    t.eq(addPlaceholder('smart'), 'e.g. Call client 3pm p1 #Work', 'and with Todoist\'s syntax');
    t.eq(hotkeyLabel(['<Control><Super>t']), 'Ctrl+Super+T', 'the board shortcut, as people read it');
    t.eq(hotkeyLabel(['<Primary><Alt>Return']), 'Ctrl+Alt+Return', '<Primary> is Ctrl');
    t.eq(hotkeyLabel(['<Shift><Super>space']), 'Shift+Super+Space', 'named keys start with a capital');
    t.eq(hotkeyLabel([]), '', 'no shortcut: no hint');
    t.eq(hotkeyLabel(['']), '', 'an empty shortcut: no hint');
}

function vietnameseTests(t) {
    setLang('vi');
    const m = model();
    t.eq(m.header.title, 'Mochi nổi cáu rồi 😤', 'VI title');
    t.eq(m.header.progress, 'Xong 0/3 hôm nay', 'VI progress');
    t.eq(m.header.streak.label, 'ngày liên tiếp', 'VI streak');
    t.eq(m.demo, 'Đang chạy chế độ demo — dữ liệu giả.', 'VI demo');
    t.eq(m.nag, 'Hôm nay mới có 2/3 việc. Thêm việc quan trọng nhất trước nhé!', 'VI nudge');
    t.eq(m.frog.label, 'Làm ngay việc này', 'VI frog');
    t.eq([m.calendar.meeting.label, m.calendar.summary, m.calendar.blocksTitle],
        ['Họp tiếp lúc 13:00', 'Còn trống 3h34 đến 18:00', 'Gợi ý khung giờ'], 'VI calendar');
    t.eq([m.lists.overdue.title, m.lists.overdue.moveAll, m.lists.today.title],
        ['Quá hạn · 1', 'Dời hết vào hôm nay', 'Hôm nay · 2'], 'VI sections');
    t.eq(m.lists.overdue.rows[0].meta.map(x => x.text), ['3 ngày trước', '⏳ dời 4 ngày'], 'VI row');
    t.eq([m.life.stage.label, m.life.wardrobe], ['⭐ Thiếu niên', '👗 Tủ đồ'], 'VI life bar');
    t.eq(m.life.distraction, '👀 Xao nhãng hôm nay: youtube.com 12\' · facebook.com 5\'', 'VI distraction');
    t.eq(m.footer.focus.label, 'Tập trung 25\'', 'VI focus');
    t.eq(dueChoices().map(c => c.label), ['Hôm nay', 'Ngày mai', 'Không hạn', '✨ Cú pháp Todoist'], 'VI due choices');
    t.eq(addPlaceholder('today'), 'Thêm việc… (Enter để lưu)', 'VI add hint');
    t.eq(calendarModel({events: EVENTS, suggestions: [], now: at(13, 30), prefs: PREFS, target: 2, hasJoinLinks: true})
        .summary, 'Còn trống 3h15 đến 18:00 · nhiều họp nên mục tiêu hôm nay: 2 việc', 'VI busy day');
}

export default async function (t) {
    const savedLang = getLang();
    setLang('en');
    try {
        placementTests(t);
        listTests(t);
        headerTests(t);
        lifeTests(t);
        rowTests(t);
        calendarTests(t);
        modelTests(t);
        addRowTests(t);
        vietnameseTests(t);
    } finally {
        setLang(savedLang);
    }
}
