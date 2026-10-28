// Test doubles shared by the test modules. Later tasks add to this file.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Brain} from '../extension/brain.js';
import {dayKey, parseDate, utcString} from '../extension/core/dates.js';
import {Emitter} from '../extension/core/emitter.js';
import {Task, statsFromApi} from '../extension/core/models.js';
import {Prefs} from '../extension/core/prefs.js';
import {SECRET_TODOIST} from '../extension/core/secretNames.js';
import {DemoService} from '../extension/services/demo.js';
import {TodoError} from '../extension/services/todoist.js';

const copy = value => JSON.parse(JSON.stringify(value));

// An in-memory JsonStore: {load(name) -> Promise<object|null>, save(name, obj), flush() -> Promise}.
// `saves` records every save as [name, copy of obj], in order. Values are copied on the way in and out,
// like a file would, so a test cannot change the "disk" by mutating what it got back.
export class MemoryStore {
    constructor(initial = {}) {
        this._data = new Map(Object.entries(initial).map(([name, value]) => [name, copy(value)]));
        this.saves = [];
    }

    async load(name) {
        return this._data.has(name) ? copy(this._data.get(name)) : null;
    }

    save(name, obj) {
        this.saves.push([name, copy(obj)]);
        this._data.set(name, copy(obj));
    }

    flush() {
        return Promise.resolve();
    }
}

// In-memory diary files: {append(day, line), read(day), list(), remove(day)}.
// `data` maps a day key ("2026-10-25") to the whole text of that day's file, so tests can look at it
// and set it up. `append` adds `line` exactly as given (the diary hands it a trailing newline).
export class MemoryFiles {
    constructor(initial = {}) {
        this.data = new Map(Object.entries(initial));
    }

    async append(day, line) {
        this.data.set(day, (this.data.get(day) ?? '') + line);
    }

    async read(day) {
        return this.data.get(day) ?? '';
    }

    async list() {
        return [...this.data.keys()];
    }

    async remove(day) {
        this.data.delete(day);
    }
}

// A new, empty directory under the system temp directory; returns its path. The caller removes it.
export function tmpDir() {
    return GLib.dir_make_tmp('todopet-test-XXXXXX');
}

// Deletes a directory and everything in it (tests only: it blocks). A path that is not there is fine.
export function rmTree(path) {
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null))
        return;
    if (file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null) === Gio.FileType.DIRECTORY) {
        const children = file.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        for (let info = children.next_file(null); info; info = children.next_file(null))
            rmTree(file.get_child(info.get_name()).get_path());
        children.close(null);
    }
    file.delete(null);
}

// Resolves after `ms` milliseconds of the GLib main loop, which is what lets Gio's async calls and timeouts run.
export function sleep(ms) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

// A scripted stand-in for services/http.js's SoupTransport: `request(req)` records `req` in `calls`, then
// plays the next script item. {status, text} resolves with that response; {throws: message} rejects with an
// Error named 'NetworkError' (what SoupTransport throws when the network or TLS fails). Asking for more
// responses than the script holds rejects with a plain Error that says so, so a test that makes an
// unplanned request fails loudly instead of hanging or passing by accident.
export class FakeTransport {
    constructor(script = []) {
        this._script = [...script];
        this.calls = [];
    }

    async request(req) {
        this.calls.push(req);
        const item = this._script.shift();
        if (item === undefined)
            throw new Error(`FakeTransport: the script is used up (unplanned request ${this.calls.length}: ${req.method} ${req.url})`);
        if (item.throws !== undefined) {
            const error = new Error(item.throws);
            error.name = 'NetworkError';
            throw error;
        }
        return {status: item.status, text: item.text ?? ''};
    }
}

// --- Phase E: the brain and its fakes ---

// A local Date from "2026-10-27T11:00" (or with seconds); throws on a typo instead of giving an Invalid Date.
export function at(localISO) {
    const date = parseDate(localISO);
    if (!date || localISO.endsWith('Z'))
        throw new Error(`at(): not a local date and time: ${localISO}`);
    return date;
}

// An active task due on `dueDate` ("2026-10-27", or "2026-10-27T15:00:00" for a timed one; null for no date),
// titled "Task <id>". `extra` overrides any Task field.
export function task(id, dueDate, apiPriority = 1, extra = {}) {
    return new Task({
        id,
        content: `Task ${id}`,
        priority: apiPriority,
        due: dueDate === null || dueDate === undefined ? null : {date: dueDate, string: dueDate, isRecurring: false},
        ...extra,
    });
}

// A task completed at `completedAtISO` ("2026-10-27T01:00:00Z", the form Todoist returns).
export function done(id, completedAtISO) {
    return new Task({id, content: `Task ${id}`, priority: 1, checked: true, completedAt: completedAtISO});
}

// A calendar event (CalEvent) starting at a local time and lasting `minutes`.
export function meeting(startLocalISO, minutes, joinURL = null) {
    const start = at(startLocalISO);
    return {
        id: `meeting-${startLocalISO}`,
        title: `Meeting ${startLocalISO.slice(11)}`,
        start,
        end: new Date(start.getTime() + minutes * 60_000),
        joinURL,
    };
}

// The TodoError of each kind, as the real client throws it.
function todoError(kind) {
    switch (kind) {
    case 'unauthorized': return new TodoError('unauthorized', {status: 401});
    case 'rateLimited': return new TodoError('rateLimited', {status: 429});
    case 'http': return new TodoError('http', {status: 500, body: 'fake server error'});
    default: return new TodoError('network', {detail: 'fake network is down'});
    }
}

const copyTask = t => new Task(t);

// The TodoService interface (services/todoist.js) over in-memory lists.
// `calls` records every change as [method, arg] (reads are in `reads`, so `calls.at(-1)` is the last change even
// after the brain refreshed). `completeRemotely(id)` finishes a task as if in the Todoist app; `failWith(kind)` makes
// every call reject with that TodoError kind (null: work again). `token` is what the brain's factory was given.
export class FakeTodo {
    constructor({active = [], completed = [], error = null, now = () => new Date()} = {}) {
        this.active = active.map(copyTask);
        this.completed = completed.map(copyTask);
        this.calls = [];
        this.reads = [];
        this.token = null;
        this._error = error;
        this._now = now;
        this._counter = 1000;
    }

    failWith(kind) {
        this._error = kind ?? null;
    }

    completeRemotely(id) {
        const index = this.active.findIndex(t => t.id === id);
        if (index < 0)
            throw new Error(`FakeTodo: no active task ${id}`);
        const [t] = this.active.splice(index, 1);
        t.checked = true;
        t.completedAt = utcString(this._now());
        this.completed.push(t);
    }

    abort() {}

    async _read(method, arg) {
        this.reads.push([method, arg]);
        if (this._error)
            throw todoError(this._error);
    }

    async _write(method, arg) {
        this.calls.push([method, arg]);
        if (this._error)
            throw todoError(this._error);
    }

    // Like the default filter "today | overdue": tasks due today or earlier (not undated or later ones).
    async activeTasks(filter) {
        await this._read('activeTasks', filter);
        const today = dayKey(this._now());
        return this.active.filter(t => t.dueDay !== null && t.dueDay <= today).map(copyTask);
    }

    // Tasks completed between `since` and `until` (a task without a readable time is always included).
    async completedTasks(since, until) {
        await this._read('completedTasks', {since, until});
        return this.completed
            .filter(t => {
                const time = t.completedDate;
                return !time || (time >= since && time <= until);
            })
            .map(copyTask);
    }

    async stats() {
        await this._read('stats', null);
        return statsFromApi({completed_count: this.completed.length, goals: {current_daily_streak: {count: 2}}});
    }

    async addTask({content, dueString = null, priority, parentId = null}) {
        await this._write('addTask', {content, dueString, priority, parentId});
        this._counter += 1;
        const now = this._now();
        let day = null;
        if (dueString === 'today')
            day = dayKey(now);
        else if (dueString === 'tomorrow')
            day = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 12));
        const created = task(String(this._counter), day, priority, {content, parentId});
        this.active.push(created);
        return copyTask(created);
    }

    async quickAdd(text) {
        await this._write('quickAdd', text);
        this._counter += 1;
        this.active.push(task(String(this._counter), dayKey(this._now()), 1, {content: text}));
    }

    async close(id) {
        await this._write('close', id);
        const index = this.active.findIndex(t => t.id === id);
        if (index >= 0) {
            const [t] = this.active.splice(index, 1);
            t.checked = true;
            t.completedAt = utcString(this._now());
            this.completed.push(t);
        }
    }

    async reopen(id) {
        await this._write('reopen', id);
        const index = this.completed.findIndex(t => t.id === id);
        if (index >= 0) {
            const [t] = this.completed.splice(index, 1);
            t.checked = false;
            t.completedAt = null;
            this.active.push(t);
        }
    }

    async reschedule(id, dueString) {
        await this._write('reschedule', [id, dueString]);
        const t = this.active.find(x => x.id === id);
        if (!t)
            return;
        const now = this._now();
        if (dueString === 'no date')
            t.due = null;
        else if (dueString === 'tomorrow')
            t.due = {date: dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 12)), string: dueString};
        else if (dueString.startsWith('today at '))
            t.due = {date: `${dayKey(now)}T${dueString.slice(9)}:00`, string: dueString};
        else
            t.due = {date: dayKey(now), string: dueString};
    }

    async delete(id) {
        await this._write('delete', id);
        this.active = this.active.filter(t => t.id !== id && t.parentId !== id);
    }
}

// The calendar the brain reads: {events(day), hasJoinLinks, on('changed', cb)}. `set(events)` replaces the events
// and emits 'changed', like a real calendar update.
export class FakeCalendar extends Emitter {
    constructor(events = []) {
        super();
        this._events = [...events];
        this.hasJoinLinks = true;
    }

    events(_day) {
        return this._events.map(e => ({...e}));
    }

    set(events) {
        this._events = [...events];
        this.emit('changed');
    }
}

// The brain's view of the desktop. Each value can be changed by a test afterwards:
//   idle (seconds), sinceKey (seconds since a key press), focused ({appName, wmClass, title, isBrowser, since}|null),
//   appSwitch (Date), secrets (Map item -> value; `secretsFail`: true makes every keyring call reject, an array of
//   items only the calls for those items).
// What the brain did is recorded in `spoken`, `played` and `opened`.
// `typingSince` means "typing right now": secondsSinceKey() is 0 (makeBrain also starts the engaged time there).
export class FakeEnv {
    constructor(overrides = {}) {
        this.idle = overrides.idleSeconds ?? 0;
        this.sinceKey = overrides.typingSince ? 0 : (overrides.secondsSinceKey ?? 1e9);
        this.focused = overrides.focus ?? null;
        this.appSwitch = overrides.lastAppSwitch ?? new Date(0);
        this.secrets = new Map(Object.entries(overrides.secrets ?? {}));
        this.secretsFail = overrides.secretsFail ?? false;
        this.spoken = [];
        this.played = [];
        this.opened = [];
    }

    idleSeconds() {
        return this.idle;
    }

    secondsSinceKey() {
        return this.sinceKey;
    }

    focus() {
        return this.focused;
    }

    lastAppSwitch() {
        return this.appSwitch;
    }

    speak(text) {
        this.spoken.push(text);
    }

    play(chime) {
        this.played.push(chime);
    }

    openURL(url) {
        this.opened.push(url);
    }

    _keyring(item) {
        if (this.secretsFail === true || (Array.isArray(this.secretsFail) && this.secretsFail.includes(item)))
            throw new Error('FakeEnv: the keyring is not available');
    }

    async lookupSecret(item) {
        this._keyring(item);
        return this.secrets.get(item) ?? null;
    }

    async storeSecret(item, value) {
        this._keyring(item);
        this.secrets.set(item, value);
    }

    async clearSecret(item) {
        this._keyring(item);
        this.secrets.delete(item);
    }
}

// A Brain wired to fakes, at a settable time (`brain.clock.set(date)`; tick() and onWake() also move it).
// opts: prefs (overrides for Prefs.memory), store, files, now (default Tuesday 2026-10-27 11:00),
//   active, completed (Task lists), overdue (how many tasks due yesterday to add), todoError (a TodoError kind),
//   token (default 'test-token'; null: no Todoist token), events (CalEvents), env (FakeEnv overrides),
//   mood + angrySince/annoyedSince (pin the mood), inMeeting (pins the meeting flag),
//   firedToday (once-a-day keys already fired today; default ['morning']), claudeFactory.
// The fakes are at brain.todo (after start), brain.env, brain.calendar, brain.store; `brain.fakeTodo` is the
// FakeTodo even before start() or after the brain switched to the demo.
export function makeBrain(opts = {}) {
    let current = new Date((opts.now ?? at('2026-10-27T11:00')).getTime());
    const clock = () => new Date(current.getTime());

    const overdueDay = dayKey(new Date(current.getFullYear(), current.getMonth(), current.getDate() - 1, 12));
    const overdue = Array.from({length: opts.overdue ?? 0}, (_, i) => task(`overdue-${i + 1}`, overdueDay));
    const todo = new FakeTodo({
        active: [...(opts.active ?? []), ...overdue],
        completed: opts.completed ?? [],
        error: opts.todoError ?? null,
        now: clock,
    });
    const token = opts.token === undefined ? 'test-token' : opts.token;
    const env = new FakeEnv({
        ...(opts.env ?? {}),
        secrets: token === null ? {} : {[SECRET_TODOIST]: token, ...(opts.env?.secrets ?? {})},
    });

    const brain = new Brain({
        prefs: Prefs.memory(opts.prefs ?? {}),
        todoFactory: (t, demo) => {
            if (demo)
                return new DemoService({now: clock});
            todo.token = t;
            return todo;
        },
        calendar: new FakeCalendar(opts.events ?? []),
        claudeFactory: opts.claudeFactory ?? (() => null),
        env,
        store: opts.store ?? new MemoryStore(),
        files: opts.files ?? new MemoryFiles(),
        now: clock,
        random: () => 0,
    });
    brain.fakeTodo = todo;
    brain.clock = {
        now: clock,
        set(date) {
            current = new Date(date.getTime());
        },
    };
    // The test's clock follows the times it hands to tick() and onWake(), so work that finishes afterwards
    // (a refresh, an action) happens at that time too.
    for (const name of ['tick', 'onWake']) {
        const original = brain[name].bind(brain);
        brain[name] = now => {
            if (now)
                brain.clock.set(now);
            return original(now);
        };
    }

    const pins = {};
    if (opts.mood !== undefined)
        pins.mood = opts.mood;
    if (opts.angrySince !== undefined)
        pins.angrySince = opts.angrySince;
    if (opts.annoyedSince !== undefined)
        pins.annoyedSince = opts.annoyedSince;
    if (opts.inMeeting !== undefined)
        pins.inMeeting = opts.inMeeting;
    if (Object.keys(pins).length > 0)
        brain.pin(pins);
    if (opts.env?.typingSince)
        brain.engagedSince = opts.env.typingSince;
    for (const key of opts.firedToday ?? ['morning'])
        brain.markFired(`${key}-${dayKey(current)}`);
    return brain;
}
