// Tests for the pure parts of the Shell services (services/speech.js, sound.js, idle.js, focusWatch.js and
// calendar.js). Nothing here touches D-Bus, the sound player or `global`: the Shell-only parts get fakes, and
// CalendarSource is only run in demo mode or with the calendar turned off (both make no D-Bus call).
import GLib from 'gi://GLib';

import {Prefs} from '../extension/core/prefs.js';
import {CalendarSource, EcalBackend, ServerEvents, dayBounds, planTimeRange} from '../extension/services/calendar.js';
import {BROWSER_APP_IDS, FocusWatch, isBrowserWindow} from '../extension/services/focusWatch.js';
import {IdleWatch} from '../extension/services/idle.js';
import {CHIME_SOUNDS, playChime, shouldPlay} from '../extension/services/sound.js';
import {speechArgs} from '../extension/services/speech.js';

const sourceExists = id => GLib.MainContext.default().find_source_by_id(id) !== null;

function speechAndSound(t) {
    t.eq(speechArgs('Xin chào', 'vi'), ['spd-say', '-l', 'vi', '--', 'Xin chào'], 'speech args');
    t.eq(speechArgs('-r 100 hi', 'en'), ['spd-say', '-l', 'en', '--', '-r 100 hi'],
        'speech text that looks like an option stays after --');

    t.check(!shouldPlay('chatter', 'important') && shouldPlay('important', 'important') &&
        !shouldPlay('celebrate', 'off') && shouldPlay('grumble', 'all'), 'sound modes');
    // The whole gate of Brain.play(): off is silent, important skips chatter and grumble, all plays everything.
    const chimes = ['chatter', 'important', 'celebrate', 'big', 'grumble'];
    t.eq(Object.fromEntries(['off', 'important', 'all'].map(mode => [mode, chimes.filter(c => shouldPlay(c, mode))])), {
        off: [],
        important: ['important', 'celebrate', 'big'],
        all: ['chatter', 'important', 'celebrate', 'big', 'grumble'],
    }, 'sound gate matches Brain.play for every mode');
    t.check(!shouldPlay('nonsense', 'all') && !shouldPlay('important', 'loud'), 'unknown chime or mode is silent');
    t.eq(CHIME_SOUNDS, {chatter: 'message', important: 'bell', celebrate: 'complete', big: 'complete', grumble: 'dialog-warning'},
        'theme sound per chime');
    t.check(Object.isFrozen(CHIME_SOUNDS), 'CHIME_SOUNDS is frozen');
    // `global` does not exist in plain gjs, so these would throw if the gate let them reach the sound player.
    t.eq([playChime('chatter', 'important'), playChime('big', 'off')], [false, false], 'a gated chime never touches the player');
}

function idleWatch(t) {
    let now = 0;
    let idle = 5000;
    let pointer = [10, 10, 0];
    const w = new IdleWatch({idleMs: () => idle, pointer: () => pointer, nowMs: () => now});
    t.eq([w.idleSeconds(), w.secondsSinceKey()], [0, 1e9], 'idle watch before the first sample');

    w._sample();
    t.eq([w.idleSeconds(), w.secondsSinceKey()], [5, 1e9], 'first sample: idle time, no key press yet');
    now = 1000;
    idle = 200;
    w._sample();
    now = 3500;
    idle = 2500;
    w._sample();
    t.eq([w.idleSeconds(), w.secondsSinceKey()], [2.5, 2.5], 'input without pointer movement counts as a key press');
    now = 4500;
    idle = 100;
    pointer = [50, 60, 0];
    w._sample();
    t.eq(w.secondsSinceKey(), 3.5, 'input with pointer movement is not a key press');

    w.start();
    const first = w._sourceId;
    t.check(first !== 0 && sourceExists(first), 'start() adds the 1 s sampling source');
    w.start();
    t.eq(w._sourceId, first, 'start() twice keeps one source');
    w.stop();
    t.check(w._sourceId === 0 && !sourceExists(first), 'stop() removes the sampling source');
    w.stop();
    w.start();
    const second = w._sourceId;
    t.check(second !== 0 && sourceExists(second), 'start() after stop() samples again');
    w.stop();
    t.check(!sourceExists(second), 'stopped again');
}

// Minimal stand-ins for Meta.Display, Meta.Window, Shell.WindowTracker and Shell.App.
class FakeObject {
    constructor() {
        this._handlers = new Map();
        this._next = 1;
    }

    connect(name, cb) {
        const id = this._next++;
        this._handlers.set(id, {name, cb});
        return id;
    }

    disconnect(id) {
        if (!this._handlers.delete(id))
            throw new Error(`disconnect of unknown id ${id}`);
    }

    fire(name) {
        for (const {name: n, cb} of [...this._handlers.values()]) {
            if (n === name)
                cb(this);
        }
    }

    get connections() {
        return this._handlers.size;
    }
}

class FakeWindow extends FakeObject {
    constructor(wmClass, title) {
        super();
        this.wmClass = wmClass;
        this.title = title;
        this.titleReads = 0;
    }

    get_wm_class() {
        return this.wmClass;
    }

    get_title() {
        this.titleReads += 1;
        return this.title;
    }

    // The signals connected, by name.
    get signals() {
        return [...this._handlers.values()].map(h => h.name).sort();
    }
}

const fakeTracker = apps => ({
    get_window_app: win => {
        const app = apps.get(win);
        return app ? {get_name: () => app[0], get_id: () => app[1]} : null;
    },
});

function focusWatch(t) {
    t.check(isBrowserWindow('Firefox', '') && isBrowserWindow('google-chrome', null), 'browser by window class');
    t.check(isBrowserWindow('chrome-abc-Default', 'com.google.Chrome.desktop') &&
        isBrowserWindow('', 'org.mozilla.firefox'), 'browser by app id, with or without .desktop');
    t.check(!isBrowserWindow('gnome-terminal-server', 'org.gnome.Terminal.desktop') && !isBrowserWindow(null, undefined),
        'a terminal is not a browser');
    t.eq(BROWSER_APP_IDS, ['com.google.Chrome', 'com.brave.Browser', 'com.microsoft.Edge', 'org.chromium.Chromium',
        'com.vivaldi.Vivaldi', 'com.opera.Opera', 'org.mozilla.firefox'], 'browser app ids (ruling R9)');

    const display = new FakeObject();
    const code = new FakeWindow('Code', 'main.js - todopet');
    const web = new FakeWindow('chrome-x', 'Watch later - YouTube - Google Chrome');
    const apps = new Map([[code, ['Visual Studio Code', 'code.desktop']], [web, ['Google Chrome', 'com.google.Chrome.desktop']]]);
    let clock = 1000;
    const watch = new FocusWatch({display, tracker: fakeTracker(apps), now: () => new Date(clock)});
    const changes = [];
    watch.on('changed', current => changes.push(current));

    display.focus_window = code;
    watch.start();
    t.eq(watch.current, {appName: 'Visual Studio Code', wmClass: 'Code', title: null, isBrowser: false,
        since: new Date(1000)}, 'start() reads the focused window: an app that is not a browser has no title');
    t.eq(watch.lastSwitch, new Date(1000), 'lastSwitch starts at start()');
    t.eq([code.titleReads, code.signals], [0, ['unmanaged']],
        'the title of a window that is not a browser is never read, and its title changes are not followed');

    clock = 2000;
    code.title = 'calendar.js - todopet';
    code.fire('notify::title');
    t.eq([watch.current.title, code.titleReads, changes.length], [null, 0, 0], 'so a new title there changes nothing');

    clock = 3000;
    display.focus_window = web;
    display.fire('notify::focus-window');
    t.eq([watch.current.appName, watch.current.isBrowser, watch.current.title, watch.current.since, watch.lastSwitch,
        changes.length], ['Google Chrome', true, 'Watch later - YouTube - Google Chrome', new Date(3000), new Date(3000), 1],
    'moving focus to another window is a switch; a browser\'s title is read');
    t.eq([code.connections, web.signals], [0, ['notify::title', 'unmanaged']],
        'the previous window is no longer watched; the browser\'s title is followed');

    clock = 3500;
    web.title = 'Cats - YouTube - Google Chrome';
    web.fire('notify::title');
    t.eq([watch.current.title, watch.current.since, watch.lastSwitch, changes.length],
        ['Cats - YouTube - Google Chrome', new Date(3000), new Date(3000), 2], 'a browser title change keeps since and emits changed');

    clock = 4000;
    display.focus_window = null;
    display.fire('notify::focus-window');
    t.eq([watch.current, watch.lastSwitch, changes.length, changes.at(-1)], [null, new Date(3000), 3, null],
        'no focused window: current is null, not a switch');
    clock = 5000;
    display.focus_window = web;
    display.fire('notify::focus-window');
    t.eq([watch.current.since, watch.lastSwitch], [new Date(3000), new Date(3000)],
        'focus back on the same window keeps since');
    display.fire('notify::focus-window');
    t.eq(changes.length, 4, 'a notify without a change emits nothing');

    watch.stop();
    t.eq([display.connections, web.connections, code.connections, watch.current], [0, 0, 0, null],
        'stop() disconnects the display and the window');
    watch.stop();
    clock = 6000;
    watch.start();
    t.eq([watch.current.wmClass, watch.current.since, display.connections, web.connections],
        ['chrome-x', new Date(6000), 1, 2], 'start() after stop() watches again');
    watch.stop();
    t.eq([display.connections, web.connections], [0, 0], 'stopped again');

    const noTracker = new FocusWatch({display, now: () => new Date(clock)});
    noTracker.start();
    t.eq(noTracker.current.appName, 'chrome-x', 'without an app the name falls back to the window class');
    noTracker.stop();
}

const sec = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min).getTime() / 1000;

function serverEvents(t) {
    const day = new Date(2026, 9, 28, 15);
    const [start, end] = dayBounds(day);
    t.eq([start, end], [new Date(2026, 9, 28), new Date(2026, 9, 29)], 'dayBounds: local midnight to midnight');

    const cache = new ServerEvents();
    t.check(cache.add([
        ['src\nsolo\n', 'Standup', sec(2026, 10, 28, 9), sec(2026, 10, 28, 9, 15), {}],
        ['src\nrec\n20261028T080000', 'Daily', sec(2026, 10, 28, 8), sec(2026, 10, 28, 8, 30), {}],
        ['src\nrec\n20261027T080000', 'Daily', sec(2026, 10, 27, 8), sec(2026, 10, 27, 8, 30), {}],
        ['src\nnight\n', 'Deploy', sec(2026, 10, 27, 23), sec(2026, 10, 28, 1), {}],
        ['src\nholiday\n', 'Holiday', sec(2026, 10, 28, 0), sec(2026, 10, 29, 0), {}],
    ]), 'add() reports a change');
    t.eq(cache.forDay(day).map(e => e.title), ['Deploy', 'Daily', 'Standup'],
        'forDay: overlapping events of that day, sorted by start, all-day dropped');
    t.eq(cache.forDay(day)[1], {id: 'src\nrec\n20261028T080000', title: 'Daily', start: new Date(2026, 9, 28, 8),
        end: new Date(2026, 9, 28, 8, 30), joinURL: null}, 'a server event has no join link');

    // An update of a recurring event replaces all of its instances, as in the shell's DBusEventSource.
    cache.add([['src\nrec\n20261028T100000', 'Daily (moved)', sec(2026, 10, 28, 10), sec(2026, 10, 28, 10, 30), {}]]);
    t.eq(cache.forDay(day).map(e => e.title), ['Deploy', 'Standup', 'Daily (moved)'], 'recurring update replaces the series');
    t.eq(cache.forDay(new Date(2026, 9, 27, 12)).map(e => e.title), ['Deploy'], 'the old instances are gone');

    t.check(cache.remove(['src\nsolo\n']), 'remove() reports a change');
    t.check(!cache.remove(['src\nnothing\n']), 'removing an unknown id is no change');
    t.eq(cache.forDay(day).map(e => e.title), ['Deploy', 'Daily (moved)'], 'removed by id prefix');

    cache.add([['other\nx\n', 'Other calendar', sec(2026, 10, 28, 14), sec(2026, 10, 28, 15), {}]]);
    t.check(cache.clientDisappeared('src'), 'clientDisappeared() reports a change');
    t.eq(cache.forDay(day).map(e => e.title), ['Other calendar'], 'a vanished calendar takes its events with it');

    cache.prune(new Date(2026, 9, 29));
    t.eq(cache.size, 0, 'prune() drops events that ended before the given time');
    t.check(!cache.add([]), 'an empty batch is no change');
}

// The calendar server has one window for all of its clients and the top bar calendar sets it to the month grid
// it shows: planTimeRange never sends a window that drops any part of the current one (ruling R11).
function serverWindow(t) {
    const day = [sec(2026, 10, 28, 0), sec(2026, 10, 29, 0)];
    for (const needsLoad of [false, true]) {
        t.eq([planTimeRange(day, null, needsLoad), planTimeRange(day, [0, 0], needsLoad)], [null, null],
            `no window yet: no call, wait for the top bar calendar to ask (needsLoad ${needsLoad})`);
    }
    // The shell's grid for October (Sep 27 - Nov 8) already covers today.
    const october = [sec(2026, 9, 27, 0), sec(2026, 11, 8, 0)];
    t.eq(planTimeRange(day, october, false), null, 'a window that covers today: no call');
    t.eq(planTimeRange(day, october, true), {since: october[0], until: october[1], force: true},
        'nothing loaded yet: reload the same window');
    // The shell shows December (Nov 29 - Jan 10): keep its window and add today (74 days in all).
    const december = [sec(2026, 11, 29, 0), sec(2027, 1, 10, 0)];
    for (const needsLoad of [false, true]) {
        t.eq(planTimeRange(day, december, needsLoad), {since: day[0], until: december[1], force: false},
            `today outside the window: the union, no forced reload (needsLoad ${needsLoad})`);
    }
    // The shell shows January (Dec 27 - Feb 7): the union would span 102 days. Never narrow to today instead.
    const january = [sec(2026, 12, 27, 0), sec(2027, 2, 7, 0)];
    for (const needsLoad of [false, true]) {
        t.eq(planTimeRange(day, january, needsLoad), null,
            `union over 100 days: no call, the shell's window stays (needsLoad ${needsLoad})`);
    }
    // Whatever the window, a planned call covers all of it and today.
    for (const current of [october, december, [day[0] + 3600, day[1] - 3600], [day[0] - 86400, day[0] + 60]]) {
        const plan = planTimeRange(day, current, true);
        t.check(plan && plan.since <= Math.min(day[0], current[0]) && plan.until >= Math.max(day[1], current[1]),
            `the planned window covers today and ${current.join('..')}`);
    }
}

async function calendarSource(t) {
    const prefs = Prefs.memory({demoMode: true});
    const cal = new CalendarSource(prefs);
    let changed = 0;
    cal.on('changed', () => changed++);
    await cal.start();
    t.eq(changed, 1, 'start() emits changed once');
    t.eq([cal.kind, cal.hasJoinLinks, cal.events(new Date()).length], ['demo', true, 2], 'demo mode: the two demo meetings');
    t.eq(cal.events(new Date()).map(e => e.id), ['demo-1', 'demo-2'], 'demo events keep their ids');
    const first = cal.events(new Date())[0].start.getTime();
    t.eq(cal.events(new Date())[0].start.getTime(), first, 'demo times do not move between calls');
    t.check(cal._sources.size === 2, 'start() adds the 10-minute and the midnight sources');

    prefs._backend.set('useCalendar', false);
    t.eq([changed, cal.kind, cal.hasJoinLinks, cal.events(new Date())], [2, 'off', false, []],
        'turning the calendar off empties it and emits changed');
    prefs._backend.set('petName', 'Bo');
    t.eq(changed, 2, 'other preferences do not reload the calendar');
    prefs._backend.set('useCalendar', true);
    t.eq([changed, cal.kind], [3, 'demo'], 'turned back on');

    const ids = [...cal._sources];
    cal.stop();
    t.check(cal._sources.size === 0 && ids.every(id => !sourceExists(id)), 'stop() removes its sources');
    prefs._backend.set('useCalendar', false);
    t.eq(changed, 3, 'stop() disconnects from the preferences');
    cal.stop();
    await cal.start();
    t.eq([cal.kind, cal.events(new Date())], ['off', []], 'start() after stop() works; off makes no D-Bus call');
    t.check(cal.serverInfo() === null, 'no calendar server proxy when the calendar is off');
    cal.stop();
}

// The ECal source's refresh, with stand-ins for ECal and the source registry: a calendar whose client cannot be had,
// or whose events cannot be read, is a warning (once per calendar), never a promise rejected with nobody waiting.
async function ecalRefresh(t) {
    const source = (uid, name) => ({
        get_uid: () => uid,
        get_display_name: () => name,
        get_extension: () => ({get_selected: () => true}),
        has_extension: () => false,
        get_parent: () => null,
    });
    const backend = new EcalBackend({ECal: {}, EDataServer: {}, ICalGLib: {}}, () => {});
    backend._registry = {
        list_enabled: () => [source('work', 'Work'), source('home', 'Home')],
        list_sources: () => [],
    };
    backend._client = s => (s.get_uid() === 'work'
        ? Promise.resolve({})
        : Promise.reject(new Error('fake: the calendar factory is gone')));
    backend._generate = () => {
        throw new Error('fake: generate_instances failed');
    };
    const warned = [];
    backend._warnOnce = (key, message) => warned.push([key, message]);
    const flush = async () => {
        for (let i = 0; i < 5; i++)
            await Promise.resolve();
    };
    backend.refresh();
    await flush();
    backend.refresh();
    await flush();
    t.eq(warned.map(([key]) => key).sort(), ['home:refresh', 'home:refresh', 'work:refresh', 'work:refresh'],
        'ECal refresh: a failed client and failed events are caught, under one key per calendar (logged once)');
    t.check(warned.some(([, message]) => message === "TodoPet: could not read calendar 'Work': fake: generate_instances failed"),
        'ECal refresh: the warning names the calendar and the reason');
    backend.stop();
}

export default async function (t) {
    speechAndSound(t);
    idleWatch(t);
    focusWatch(t);
    serverEvents(t);
    serverWindow(t);
    await calendarSource(t);
    await ecalRefresh(t);
}
