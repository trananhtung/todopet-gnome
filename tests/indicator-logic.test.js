// The top bar indicator's pure parts (Task 22): its label, the quick menu, the developer trigger, and the caches that
// App.stop() empties.
import Cairo from 'cairo';

import {getLang, setLang} from '../extension/core/l10n.js';
import * as petArt from '../extension/art/petArt.js';
import {celebrationPlan, effectBox, fireworkBursts} from '../extension/ui/anticsLogic.js';
import {badgeCached, clearBadgeCache, drawCelebration} from '../extension/ui/anticsArt.js';
import {parseDevTrigger, runDevTrigger} from '../extension/ui/devTrigger.js';
import {
    HIDE_MS, QUIET_MINUTES, focusText, indicatorLabel, quickMenu,
} from '../extension/ui/indicatorLogic.js';
import {at, makeBrain, task} from './helpers.js';

const NOW = at('2026-10-27T15:11:00').getTime();

// What the label reads from the brain.
const brainLike = (changes = {}) => ({
    hasToken: true, mood: 'happy', focusSession: null, target: 3, day: {completed: [1, 2], planned: 3}, ...changes,
});

const session = (leftSeconds, isBreak = false) => ({isBreak, end: new Date(NOW + leftSeconds * 1000)});

const menuInput = (changes = {}) => ({
    petName: 'Mochi', mood: 'happy', hasToken: true, focusing: false, focusMinutes: 25, petVisible: true,
    quiet: false, demo: false, hotkey: 'Ctrl+Super+T', ...changes,
});
const ids = items => items.map(item => item.id);

export default async function (t) {
    const saved = getLang();
    setLang('en');
    try {
        label(t);
        menu(t);
        await trigger(t);
        caches(t);
    } finally {
        setLang(saved);
    }
}

function label(t) {
    // Swift: updateStatusTitle. Minutes are not padded ("4:59"), seconds are.
    t.eq(focusText(session(24 * 60 + 58), NOW), '🍅 24:58', 'a focus session: the tomato and m:ss');
    t.eq(focusText(session(4 * 60 + 59, true), NOW), '☕ 4:59', 'a break: the cup');
    t.eq(focusText(session(5 * 60), NOW), '🍅 5:00', 'minutes are not padded');
    t.eq(focusText(session(61), NOW), '🍅 1:01', 'seconds are');
    t.eq(focusText(session(24 * 60 + 58.9), NOW), '🍅 24:58', 'whole seconds, cut off (Swift: Int())');
    t.eq(focusText(session(-30), NOW), '🍅 0:00', 'never below zero');

    t.eq(indicatorLabel(brainLike(), NOW), '😊 2/3', 'the mood emoji and done/target');
    t.eq(indicatorLabel(brainLike({mood: 'angry', day: {completed: [], planned: 0}}), NOW), '😤 0/3', 'nothing done yet');
    t.eq(indicatorLabel(brainLike({day: {completed: [1], planned: 5}}), NOW), '😊 1/5',
        'more planned than the target: the plan is the denominator (Swift: max(target, planned))');
    t.eq(indicatorLabel(brainLike({target: 2}), NOW), '😊 2/3', 'and the target is the effective one the brain has');
    t.eq(indicatorLabel(brainLike({focusSession: session(1500)}), NOW), '🍅 25:00', 'a focus session takes the label over');
    t.eq(indicatorLabel(brainLike({hasToken: false}), NOW), '🐾', 'without a token: the paw');
    t.eq(indicatorLabel(brainLike({hasToken: false, focusSession: session(90, true)}), NOW), '☕ 1:30',
        'a focus session shows even without a token');
    t.eq(indicatorLabel(brainLike({mood: 'sleeping'}), NOW), '😴 2/3', 'each mood has its emoji');
}

function menu(t) {
    // Swift: AppDelegate.fill, in its order.
    const base = quickMenu(menuInput());
    t.eq(ids(base), [
        'header', 'separator', 'open', 'add', 'startFocus', 'separator',
        'callOver', 'hide', 'quiet', 'refresh', 'diary', 'separator', 'settings', 'demo',
    ], 'the quick menu, in the macOS order, then the demo switch');
    t.eq(base[0], {id: 'header', title: 'Mochi 😊 — happy', sensitive: false}, 'the header names the pet and its mood');
    t.eq(base[2], {id: 'open', title: 'Open task board', hint: 'Ctrl+Super+T'}, 'the board item shows the shortcut');
    t.eq(base.find(i => i.id === 'add').title, 'Add a task…', 'add a task');
    t.eq(base.find(i => i.id === 'startFocus').title, "Start focus 25'", 'start a focus session of the set length');
    t.eq(base.find(i => i.id === 'callOver').title, 'Call Mochi over', 'call the pet by its name');
    t.eq(base.find(i => i.id === 'hide').title, 'Hide pet for 1 hour', 'hide for an hour');
    t.eq(base.find(i => i.id === 'quiet').title, 'Quiet for 1 hour', 'quiet for an hour');
    t.eq(base.find(i => i.id === 'refresh').title, 'Refresh', 'refresh');
    t.eq(base.find(i => i.id === 'diary').title, 'Pet diary…', 'the diary');
    t.eq(base.find(i => i.id === 'settings').title, 'Settings…', 'the settings');
    t.eq(base.find(i => i.id === 'demo'), {id: 'demo', title: 'Demo mode', toggle: false}, 'the demo switch, off');
    t.check(HIDE_MS === 3600 * 1000 && QUIET_MINUTES === 60, 'an hour is an hour');

    t.eq(ids(quickMenu(menuInput({focusing: true}))).slice(3, 5), ['add', 'stopFocus'], 'during focus: stop it instead');
    t.eq(quickMenu(menuInput({focusing: true})).find(i => i.id === 'stopFocus').title, 'Stop focus', 'stop focus');
    t.eq(ids(quickMenu(menuInput({hasToken: false}))).slice(2, 5), ['open', 'connect', 'separator'],
        'without a token: connect Todoist, no add and no focus');
    t.eq(quickMenu(menuInput({hasToken: false})).find(i => i.id === 'connect').title, 'Connect Todoist…', 'connect Todoist');
    const hidden = quickMenu(menuInput({petVisible: false}));
    t.eq(ids(hidden).slice(6, 8), ['callOver', 'show'], 'a hidden pet: show it instead of hiding it, and calling it stays');
    t.eq(hidden.find(i => i.id === 'show').title, 'Show pet', 'show the pet');
    const quiet = quickMenu(menuInput({quiet: true}));
    t.eq(ids(quiet).slice(8, 9), ['unquiet'], 'while quiet: resume instead');
    t.eq(quiet.find(i => i.id === 'unquiet').title, 'Resume reminders', 'resume reminders');
    t.eq(quickMenu(menuInput({demo: true})).find(i => i.id === 'demo').toggle, true, 'the demo switch is on in demo mode');
    t.eq(quickMenu(menuInput({hotkey: ''})).find(i => i.id === 'open'), {id: 'open', title: 'Open task board', hint: ''},
        'no shortcut set: no hint');
    t.eq(quickMenu(menuInput({mood: 'angry', petName: 'Bông'}))[0].title, 'Bông 😤 — grumpy', 'the header follows the mood');

    setLang('vi');
    const vi = quickMenu(menuInput());
    t.eq(vi.map(i => i.title ?? null), [
        'Mochi 😊 — đang vui', null, 'Mở bảng việc', 'Thêm việc…', "Bắt đầu tập trung 25'", null,
        'Gọi Mochi về đây', 'Ẩn pet 1 giờ', 'Im lặng 1 giờ', 'Làm mới', 'Nhật ký pet…', null, 'Cài đặt…', 'Chế độ demo',
    ], 'every title in Vietnamese');
    setLang('en');
}

async function trigger(t) {
    t.eq(parseDevTrigger(''), {kind: 'none'}, 'empty: nothing to do');
    t.eq(parseDevTrigger('prefs:Day'), {kind: 'prefs'}, 'prefs:<page> belongs to the settings window');
    t.eq(parseDevTrigger('prefs:'), {kind: 'prefs'}, 'even an empty page');
    t.eq(parseDevTrigger('parade'), {kind: 'antic', antic: 'parade'}, 'parade');
    t.eq(parseDevTrigger('block'), {kind: 'antic', antic: 'block'}, 'block');
    t.eq(parseDevTrigger('grumble'), {kind: 'antic', antic: 'grumble'}, 'grumble');
    t.eq(parseDevTrigger('celebrate:spin'), {kind: 'celebrate', options: {kind: 'spin'}}, 'celebrate:<kind>');
    t.eq(parseDevTrigger('golden'), {kind: 'celebrate', options: {kind: 'jump', golden: true}}, 'golden');
    t.eq(parseDevTrigger('bubble'), {kind: 'bubble'}, 'bubble');
    t.eq(parseDevTrigger('nonsense'), {kind: 'unknown', value: 'nonsense'}, 'anything else is unknown');
    t.eq(parseDevTrigger('Parade'), {kind: 'unknown', value: 'Parade'}, 'and the names are exact');
    t.eq(parseDevTrigger('celebrate:'), {kind: 'celebrate', options: {kind: ''}}, 'a missing kind is the hook\'s to refuse');

    const calls = [];
    const fake = {
        devAntic: kind => calls.push(['antic', kind]),
        devCelebrate: options => calls.push(['celebrate', options]),
        say: (bubble, options) => calls.push(['say', bubble.text.length > 0, bubble.seconds > 0, options?.why ?? null]),
    };
    t.eq(runDevTrigger(fake, 'parade'), true, 'a command runs');
    runDevTrigger(fake, 'block');
    runDevTrigger(fake, 'grumble');
    runDevTrigger(fake, 'celebrate:fireworks');
    runDevTrigger(fake, 'golden');
    runDevTrigger(fake, 'bubble');
    t.eq(calls, [
        ['antic', 'parade'], ['antic', 'block'], ['antic', 'grumble'],
        ['celebrate', {kind: 'fireworks'}], ['celebrate', {kind: 'jump', golden: true}],
        ['say', true, true, null],
    ], 'each value calls its hook');
    calls.length = 0;
    t.eq([runDevTrigger(fake, ''), runDevTrigger(fake, 'prefs:Developer')], [false, false], 'empty and prefs: values run nothing');
    t.eq(calls, [], 'and call nothing');
    await t.rejects(Promise.resolve().then(() => runDevTrigger(fake, 'nonsense')), e => /nonsense/.test(e.message),
        'an unknown command throws, naming it');

    // The real hooks: a celebration and a bubble reach the brain.
    const brain = makeBrain({active: [task('a', '2026-10-27')], now: at('2026-10-27T15:11')});
    await brain.start();
    await brain.refresh();
    brain.dismissBubble();
    const seen = [];
    brain.on('celebrate', c => seen.push([c.kind, c.golden]));
    runDevTrigger(brain, 'celebrate:spin');
    runDevTrigger(brain, 'golden');
    t.eq(seen, [['spin', false], ['fireworks', true]], 'the brain celebrates a kind, and a golden treat');
    t.eq(brain.bubble, null, 'with no bubble said');
    runDevTrigger(brain, 'bubble');
    t.check(brain.bubble?.text.length > 0 && brain.bubble.seconds > 0, 'the bubble trigger says a bubble');
    await t.rejects(Promise.resolve().then(() => runDevTrigger(brain, 'celebrate:nope')), e => /nope/.test(e.message),
        'a celebration kind the brain does not know is refused');
    runDevTrigger(brain, 'parade');
    t.eq(brain.antic?.kind, 'parade', 'the parade starts');
}

// App.stop() empties the module-level caches that hold Pango layouts, so nothing is kept after disable.
function caches(t) {
    const first = petArt.signGeometry('Write the weekly report');
    t.check(petArt.signGeometry('Write the weekly report') === first, 'the sign is cached');
    petArt.clearArtCaches();
    const again = petArt.signGeometry('Write the weekly report');
    t.check(again !== first && again.width === first.width && again.height === first.height,
        'after clearing it is laid out again, to the same size');

    const box = effectBox({x: 700, y: 782, width: 124, height: 124});
    const plan = celebrationPlan({kind: 'fireworks', combo: 3}, 4);
    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, box.width, box.height);
    const cr = new Cairo.Context(surface);
    try {
        clearBadgeCache();
        t.check(!badgeCached(), 'no badge is cached at first');
        drawCelebration(cr, {box, plan, pieces: [], bursts: fireworkBursts(false), side: 1}, 1.5);
        t.check(badgeCached(), 'drawing a combo badge caches its layouts');
        clearBadgeCache();
        t.check(!badgeCached(), 'and clearing drops them');
    } finally {
        cr.$dispose();
        surface.finish();
    }
}
