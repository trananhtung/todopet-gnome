// The pet's brain (port of Brain.swift): syncs Todoist, computes the mood, settles the pet's days and decides when
// to talk. It never touches GNOME Shell: everything comes through the constructor, time only moves through tick(now),
// and async work is tracked so settle() can wait for it. Imports only core/ files and services/ files without Shell
// imports, so plain gjs runs it in the tests (with the fakes in tests/helpers.js).
//
//   new Brain({prefs, todoFactory, calendar, claudeFactory, env, store, files, now = () => new Date(), random})
//     todoFactory(token|null, demo: bool) -> TodoService (services/todoist.js or services/demo.js)
//     calendar  {events(day) -> CalEvent[], hasJoinLinks, on('changed', cb)}
//     claudeFactory(key, model) -> ClaudeClient
//     env       {idleSeconds(), secondsSinceKey(), focus() -> {appName, wmClass, title, isBrowser, since}|null,
//                lastAppSwitch() -> Date, speak(text), play(chime), lookupSecret(item), storeSecret(item, v),
//                clearSecret(item), openURL(url)}; focus().title is null unless isBrowser (only a browser's is read)
//     store     {load(name), save(name, obj)} for the pet's life and the postponed-tasks log; files: the diary's files
//
// Events (brain.on(name, cb)): 'changed' after any change the UI shows; 'bubble' with the new bubble, or null when
// it was taken away; 'celebrate' with the celebration; 'antic' with the antic; 'antic-end'.
// For the dev scenes and the Developer page: devAntic(kind) (brain/rules.js) and devCelebrate({kind, golden, combo})
// play a stunt or a celebration on demand.
// A bubble is {id, text, actions: [{title, primary, run}], seconds = 12, urgent, reminder}. The bubble view hides it
// after `seconds` and calls dismissBubble(); if no view did, the brain drops it itself `seconds` + 2 s after showing it
// (and emits 'bubble' with null).
//
// Sections, in Brain.swift order: token and demo, sync, mood, life settlement, talking, tick.
// The reminder rules, flow and distraction tracking and mischief live in brain/rules.js, and the task actions and
// focus sessions in brain/actions.js; both are installed as Brain methods at the end of this file (runRules,
// updateFlow, trackDistraction; complete, add, reschedule, delete, split, startFocus... and their helpers).
import {atHour, dayKey, parseDate, shortText, timeString} from './core/dates.js';
import {currentEvent, freeMinutes, suggest, targetFor} from './core/calendarMath.js';
import {PetLog} from './core/diary.js';
import {Emitter} from './core/emitter.js';
import {L} from './core/l10n.js';
import {CELEBRATION_KINDS, FOODS, GOLDEN_FOOD, LifeRules, PetLife, accessoryEmoji, stageName} from './core/life.js';
import {Lines} from './core/lines.js';
import {DaySnapshot} from './core/models.js';
import {Mood, defaultMoodInputs, evaluateMood, moodLabel} from './core/mood.js';
import {SECRET_ANTHROPIC, SECRET_TODOIST} from './core/secretNames.js';
import {isBrowser, matchTitle} from './core/sites.js';
import {StuckTracker} from './core/stuck.js';
import {installActions} from './brain/actions.js';
import {installRules} from './brain/rules.js';
import {demoEvents} from './services/demo.js';
import {shouldPlay} from './services/sound.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
// Swift's timer: the mood, the life and the rules every 15 seconds.
const SLOW_TICK_MS = 15 * SECOND;
// Sync when the last good sync is older than this (Swift: 180 s).
const SYNC_MS = 180 * SECOND;
// A tick this long after the previous one means the computer slept.
const WAKE_GAP_MS = 120 * SECOND;
// Without a token the pet says hello after a moment (Swift: 1.5 s after start).
const ASK_TOKEN_DELAY_MS = 1.5 * SECOND;
const STATS_MS = 900 * SECOND;
// Todoist is rate limiting: no automatic sync for this long ("retrying in a few minutes").
const RATE_LIMIT_BACKOFF_MS = 3 * MINUTE;
// How often to try again to read a saved life or postponed-tasks log that could not be read.
const RETRY_READ_MS = 3 * MINUTE;
// Idle for longer than this, or locked: away from the computer.
const AWAY_SECONDS = 300;
// Swift's Date.distantPast.
const NEVER = new Date(0);
// The bubble view hides a bubble after its `seconds`; a bubble nobody took away is dropped this much later.
const BUBBLE_GRACE_MS = 2 * SECOND;

// A pet with some history, for the demo (Swift: LifeState.demo).
const DEMO_LIFE = Object.freeze({
    satiety: 55,
    xp: 320,
    totalDone: 31,
    streak: 4,
    bestStreak: 4,
    bestCombo: 2,
    goldens: 1,
    unlocked: ['bow', 'scarf', 'tophat'],
    wearing: ['scarf'],
    perfectDays: ['2026-10-20', '2026-10-21', '2026-10-23'],
    distraction: {'youtube.com': 720, 'facebook.com': 300},
});

// Preferences whose changes need no recompute: values the extension writes itself, and dev settings.
const QUIET_PREFS = new Set(['hiddenUntil', 'quietUntil', 'devTrigger', 'devScenes', 'devScreenshotDir', 'boardHotkey']);

// The text to show for a failure (Swift: error.localizedDescription).
const errorMessage = e => e?.userMessage ?? e?.message ?? String(e);

// Whole number in [lo, hi]; anything that is not a number becomes lo. Prefs are not range-checked by GSettings.
function clampInt(value, lo, hi = Infinity) {
    const n = Number.isFinite(value) ? Math.trunc(value) : lo;
    return Math.min(Math.max(n, lo), hi);
}

const latest = (...dates) => new Date(Math.max(...dates.map(d => d.getTime())));

const startOfDay = date => new Date(date.getFullYear(), date.getMonth(), date.getDate());

function makeBubble({text, actions = [], seconds = 12, urgent = false, reminder = false}, id) {
    return {
        id,
        text: String(text),
        actions: actions.map(a => ({title: a.title, primary: a.primary ?? false, run: a.run ?? (() => {})})),
        seconds,
        urgent,
        reminder,
    };
}

// A store whose saves stay closed until the saved copy was read, so a copy that could not be read is never
// overwritten with a new one.
class GatedStore {
    constructor(store) {
        this._store = store;
        this.open = false;
        this.logged = false;
    }

    load(name) {
        return this._store.load(name);
    }

    save(name, obj) {
        return this.open ? this._store.save(name, obj) : undefined;
    }
}

export class Brain extends Emitter {
    constructor({prefs, todoFactory, calendar = null, claudeFactory = null, env, store = null, files = null,
        now = () => new Date(), random = Math.random}) {
        super();
        this.prefs = prefs;
        this.env = env;
        this.calendar = calendar;
        this.store = store;
        this._files = files;
        this._todoFactory = todoFactory;
        this._claudeFactory = claudeFactory;
        this._clock = now;
        this._random = random;
        this._nowOverride = null;
        const start = now();

        // --- What the UI shows ---
        this.hasToken = false;
        this.demo = prefs.demoMode;
        this.todo = null;
        this.day = new DaySnapshot();
        this.stats = null;
        this.mood = Mood.normal;
        this.score = 60;
        this.reasons = [];
        this.loading = false;
        this.lastSync = null;
        this.focusSession = null; // {task, start, end, isBreak, minutes}
        this.errorText = null;
        this.bubble = null;
        this.quietUntil = null;
        // Today's target: the daily target, lowered on meeting-heavy days.
        this.target = 3;
        this.events = [];
        this.suggestions = [];
        this.stuckTasks = [];
        this.hasClaudeKey = false;
        this.celebration = null; // {kind, food, golden, combo, start}
        this.antic = null; // {id, kind, text, start}
        this.flow = false;
        this.locked = false;
        // The rule that spoke last (null until one does; a held reminder does not change it). From brain/rules.js:
        // meeting, due, morning, plan, distraction, stuck, hungry, antic (block, parade or grumble), overdue,
        // timeblock, review, nudge, tip, and Swift's other messages: token (no Todoist token), welcome (back after
        // being away), night, alldone, distractsum. From brain/actions.js: focusEnd (a focus session's time is up)
        // and breakEnd (a break's time is up).
        this.lastRule = null;
        this.closeDayCalls = 0;

        // Set by the app: open the task board (optionally focusing "add task"), the split view, and settings.
        this.openBoard = null;
        this.openBreakdown = null;
        this.openSettings = null;

        // --- Brain.swift's private state, under the same names ---
        this.active = [];
        this.completed = [];
        this.fired = new Map(); // rule key -> Date
        this.dayKey = dayKey(start);
        this.knownCompleted = new Set();
        this.completedViaPet = new Set();
        this.didLoadOnce = false;
        this.celebrateUntil = NEVER;
        this.lastCelebration = NEVER;
        this.lastPlanAction = NEVER;
        this.lastBubbleAt = NEVER;
        this.awaySince = null;
        this.frontApp = null; // the last env.focus()
        this.distractionSnoozedUntil = NEVER;
        this.anticSnoozedUntil = NEVER;
        this.annoyedSince = null;
        this.angrySince = null;
        this.engagedSince = null;
        this.flowStartedAt = start;
        this.distractionSession = null; // {label, start, logged}
        this.lastFlowEnd = NEVER;
        this.lastAppSwitch = NEVER;
        this.lastStatsAt = NEVER;

        // The demo keeps its pet, log and diary in memory (Swift: PetLife(persist: false, initial: .demo)).
        this._lifeGate = this.demo || !store ? null : new GatedStore(store);
        this._trackerGate = this.demo || !store ? null : new GatedStore(store);
        this.life = this.demo ? new PetLife({initial: DEMO_LIFE}) : new PetLife({store: this._lifeGate});
        this.tracker = new StuckTracker({store: this._trackerGate});
        this.diary = new PetLog({now: start});
        this.diary.enabled = prefs.keepLog;

        this._token = null;
        this._serviceGen = 0;
        this._refreshing = null;
        this._refreshingGen = -1;
        this._syncBackoffUntil = null;
        this._askedAfter401 = false;
        this._askTokenAt = null;
        this._recomputeAt = null;
        this._demoEvents = null;
        this._siteVisit = null; // {rule, since, windowSince}
        this._lockedAt = null;
        this._lifeReady = false;
        this._lifeReadFailed = false;
        this._trackerReadFailed = false;
        this._lastReadTry = NEVER;
        // The keyring could not be read (it is retried every slow tick): the Todoist token, the Claude key.
        this._tokenUnread = false;
        this._claudeKeyUnread = false;
        this._keyringLogged = false;
        this._keyringRetry = null;
        this._claudeClients = new Set(); // suggestSteps requests in flight, aborted by stop()
        this._lastTickAt = null;
        this._lastSlowTick = null;
        this._bubbleSeq = 0;
        this._bubbleUntil = null;
        this._anticSeq = 0;
        this._pins = {};
        this._pending = new Set();
        this._prefsId = null;
        this._calendarId = null;
        this._started = false;
        this._ready = false;
        this._stopped = false;
    }

    // Opens the diary, reads the saved pet and the keyring, then syncs (or asks for a token).
    async start() {
        if (this._started)
            return;
        this._started = true;
        this._stopped = false;
        if (this._files && !this.demo) {
            try {
                this.diary = await PetLog.open({files: this._files, now: this._now()});
            } catch (e) {
                this._log(`TodoPet: could not open the diary: ${e?.message ?? e}`);
            }
            this.diary.enabled = this.prefs.keepLog;
        }
        await this._readSaved(this._now());
        if (this._stopped)
            return;
        await this._restoreFocus(this._now());
        if (this._stopped)
            return;
        const quiet = this.prefs.quietUntil;
        if (quiet > this._now().getTime())
            this.quietUntil = new Date(quiet);
        if (this.demo) {
            this.useDemo();
        } else {
            await this._loadSecrets();
            if (this._stopped)
                return;
        }
        this._prefsId = this.prefs.onChanged(name => this._prefChanged(name));
        this._calendarId = this.calendar?.on('changed', () => {
            this._refreshCalendar(this._now());
            this.recompute();
        }) ?? null;
        const now = this._now();
        this._refreshCalendar(now);
        this.recompute(now);
        if (this.hasToken)
            this.refreshSoon();
        else if (!this._tokenUnread)
            this._askTokenAt = new Date(now.getTime() + ASK_TOKEN_DELAY_MS);
        this._ready = true;
    }

    // Disconnects from prefs and the calendar and drops the results of requests still in flight.
    stop() {
        this._stopped = true;
        this._started = false;
        this._ready = false;
        if (this._prefsId !== null)
            this.prefs.disconnect(this._prefsId);
        this._prefsId = null;
        if (this._calendarId !== null)
            this.calendar?.off?.(this._calendarId);
        this._calendarId = null;
        this.todo?.abort?.();
        for (const client of this._claudeClients)
            client.abort?.();
        this._claudeClients.clear();
        this._serviceGen += 1;
        this._refreshing = null;
        this.loading = false;
    }

    // Resolves when every request and action started so far has finished.
    async settle() {
        while (this._pending.size > 0)
            await Promise.allSettled([...this._pending]);
    }

    get streak() {
        return this.stats?.streak ?? 0;
    }

    // The pet should keep still: you're typing, in the zone, or in a meeting.
    get calmMotion() {
        return this.prefs.stillWhileTyping &&
            (this.flow || this._secondsSinceKey() < 20 || this._currentMeeting(this._now()) !== null);
    }

    // --- Token / demo ---

    async setToken(raw) {
        const token = String(raw ?? '').trim();
        if (token === '')
            return false;
        const client = this._todoFactory(token, false);
        try {
            await client.activeTasks('today');
        } catch (e) {
            this.errorText = errorMessage(e);
            this._changed();
            return false;
        }
        try {
            await this.env.storeSecret(SECRET_TODOIST, token);
        } catch (e) {
            this._log(`TodoPet: could not save the Todoist token in the keyring: ${e?.message ?? e}`);
        }
        this._useToken(token, client);
        this._resetDay(this._now());
        this.errorText = null;
        await this.refresh();
        this.say({text: L('Kết nối Todoist thành công! 🎉', 'Connected to Todoist! 🎉'), seconds: 6});
        return true;
    }

    removeToken() {
        this._track((async () => this.env.clearSecret(SECRET_TODOIST))());
        this._setService(null);
        this._token = null;
        this.hasToken = false;
        this.demo = false;
        this.active = [];
        this.completed = [];
        this.recompute();
    }

    useDemo() {
        const now = this._now();
        this._setService(this._todoFactory(null, true));
        this._token = null;
        this._askedAfter401 = false;
        this._askTokenAt = null;
        this.hasToken = true;
        this.demo = true;
        this.tracker = new StuckTracker();
        this._trackerGate = null;
        this._demoEvents = demoEvents(now);
        this._refreshCalendar(now);
        this._resetDay(now);
        this.refreshSoon();
        this.say({
            text: L('Đang chạy demo với dữ liệu giả 🎭 Bấm vào mình để mở bảng việc nhé!',
                'Demo mode with sample tasks 🎭 Click me to open the task board!'),
            seconds: 10,
            urgent: true,
        });
    }

    // Stores the Anthropic key (or clears it for null or blank) and updates hasClaudeKey.
    setClaudeKey(key) {
        const k = String(key ?? '').trim();
        return this._track((async () => {
            try {
                if (k === '')
                    await this.env.clearSecret(SECRET_ANTHROPIC);
                else
                    await this.env.storeSecret(SECRET_ANTHROPIC, k);
            } catch (e) {
                this._log(`TodoPet: could not change the Claude key in the keyring: ${e?.message ?? e}`);
            }
            try {
                this.hasClaudeKey = Boolean(await this.env.lookupSecret(SECRET_ANTHROPIC));
            } catch {
                this.hasClaudeKey = false;
            }
            this._changed();
        })());
    }

    // Reads the keyring again (the Settings window bumps `secrets-serial` after changing a secret): a new Todoist
    // token connects, a removed one disconnects. The demo chosen in the settings stays. The token and the Claude key
    // are read one by one: one that cannot be read keeps what the brain had, and the slow tick tries again.
    async reloadSecrets() {
        const {token, tokenRead} = await this._readSecrets();
        if (this._stopped)
            return;
        if (tokenRead && !this.prefs.demoMode) {
            if (token && token !== this._token) {
                this._useToken(token);
                this.errorText = null;
                this._resetDay(this._now());
                this.refreshSoon();
            } else if (!token && this._token !== null) {
                this._setService(null);
                this._token = null;
                this.hasToken = false;
                this.active = [];
                this.completed = [];
                this.recompute();
            }
        }
        this._changed();
    }

    _askForToken() {
        if (this.hasToken)
            return;
        this.say({
            text: Lines.hello(this.prefs.petName),
            actions: [
                {title: L('Kết nối Todoist', 'Connect Todoist'), primary: true, run: () => this.openBoard?.(false)},
                {title: L('Xem thử (demo)', 'Try demo'), run: () => this.useDemo()},
            ],
            seconds: 60,
        }, {tag: 'askToken'});
    }

    // start(): a token in the keyring connects. A keyring that cannot be read is not "no token": no hello then.
    async _loadSecrets() {
        const {token} = await this._readSecrets();
        if (token)
            this._useToken(token);
    }

    // Reads the Todoist token and the Claude key, each on its own. Updates hasClaudeKey when the key could be read,
    // and remembers what could not be read (the slow tick tries again). The first failure in a row is logged.
    async _readSecrets() {
        let token = null;
        let tokenRead = true;
        try {
            token = await this.env.lookupSecret(SECRET_TODOIST);
        } catch (e) {
            tokenRead = false;
            this._keyringFailed('the Todoist token', e);
        }
        let keyRead = true;
        try {
            this.hasClaudeKey = Boolean(await this.env.lookupSecret(SECRET_ANTHROPIC));
        } catch (e) {
            keyRead = false;
            this._keyringFailed('the Claude key', e);
        }
        this._tokenUnread = !tokenRead;
        this._claudeKeyUnread = !keyRead;
        if (tokenRead && keyRead)
            this._keyringLogged = false;
        return {token, tokenRead};
    }

    _keyringFailed(what, e) {
        if (this._keyringLogged)
            return;
        this._keyringLogged = true;
        this._log(`TodoPet: could not read ${what} from the keyring, trying again every 15 s: ${e?.message ?? e}`);
    }

    // The slow tick's new try at a keyring that could not be read. Once a token that could not be read turns out to
    // be missing, the hello that start() held back comes. A retry only for the Claude key never says hello again.
    async _retrySecrets() {
        const tokenWasUnread = this._tokenUnread;
        try {
            await this.reloadSecrets();
            if (!this._stopped && tokenWasUnread && !this._tokenUnread && !this.hasToken && this._askTokenAt === null)
                this._askTokenAt = new Date(this._now().getTime() + ASK_TOKEN_DELAY_MS);
        } finally {
            this._keyringRetry = null;
        }
    }

    _useToken(token, client = this._todoFactory(token, false)) {
        this._setService(client);
        this._token = token;
        this._askedAfter401 = false;
        this._askTokenAt = null;
        this._syncBackoffUntil = null;
        this.hasToken = true;
        this.demo = false;
    }

    // Swaps the Todoist service; results of requests the old one still has in flight are dropped.
    _setService(service) {
        if (this.todo && this.todo !== service)
            this.todo.abort?.();
        this._serviceGen += 1;
        this.todo = service;
        this._refreshing = null;
        this.loading = false;
    }

    // --- Sync ---

    refreshSoon() {
        this.refresh();
    }

    // Loads today's tasks. While a sync with the same service is in flight, waits for that one instead.
    refresh() {
        if (!this.todo)
            return Promise.resolve();
        if (this._refreshing && this._refreshingGen === this._serviceGen)
            return this._refreshing;
        const gen = this._serviceGen;
        const run = this._sync(this.todo, gen).finally(() => {
            if (this._refreshing === run) {
                this._refreshing = null;
                this._setLoading(false);
            }
        });
        this._refreshing = run;
        this._refreshingGen = gen;
        this._track(run);
        this._setLoading(true);
        return run;
    }

    async _sync(service, gen) {
        const started = this._now();
        let active;
        let completedToday;
        let stats = null;
        let statsTried = false;
        try {
            active = await service.activeTasks(this.prefs.effectiveFilter);
            // The completed-tasks endpoint can fail on some plans: then keep the completions we saw ourselves.
            try {
                completedToday = await service.completedTasks(startOfDay(started), new Date(started.getTime() + 120 * SECOND));
            } catch {
                completedToday = null;
            }
            if (started.getTime() - this.lastStatsAt.getTime() > STATS_MS || this.stats === null) {
                statsTried = true;
                try {
                    stats = await service.stats();
                } catch {
                    stats = null;
                }
            }
        } catch (e) {
            if (gen === this._serviceGen && !this._stopped)
                this._syncFailed(e, this._now());
            return;
        }
        if (gen !== this._serviceGen || this._stopped)
            return;
        if (statsTried) {
            if (stats)
                this.stats = stats;
            this.lastStatsAt = started;
        }
        const now = this._now();
        this._apply(active, completedToday, now);
        this.errorText = null;
        this._syncBackoffUntil = null;
        this.lastSync = now;
        this._changed();
    }

    _syncFailed(e, now) {
        const message = errorMessage(e);
        this.errorText = message;
        this.diary.add('sync', L('Lỗi đồng bộ Todoist: ', 'Todoist sync failed: ') + message,
            {throttle: 'sync-error', every: 30, now});
        if (e?.kind === 'rateLimited')
            this._syncBackoffUntil = new Date(now.getTime() + RATE_LIMIT_BACKOFF_MS);
        // Asked once per token: a token Todoist keeps refusing does not bring the bubble back every sync.
        if (e?.kind === 'unauthorized' && !this._askedAfter401) {
            this._askedAfter401 = true;
            this.say({
                text: Lines.error(message),
                actions: [{title: L('Nhập token mới', 'Enter a new token'), primary: true, run: () => this.openSettings?.()}],
                seconds: 30,
            }, {tag: 'askToken'});
        }
        this._changed();
    }

    _apply(active, completedToday, now) {
        const today = dayKey(now);
        this.active = active;
        // Only today's completions: a sync that started before midnight must not count yesterday's for today.
        if (completedToday) {
            this.completed = completedToday.filter(t => t.completedDate === null || dayKey(t.completedDate) === today);
        } else {
            this.completed = this.completed.filter(t => t.completedDate !== null && dayKey(t.completedDate) === today);
        }
        // Celebrate (and feed the pet for) tasks you completed in the Todoist app since the last sync.
        const ids = new Set(this.completed.map(t => t.id));
        const fresh = this.completed.filter(t => !this.knownCompleted.has(t.id) && !this.completedViaPet.has(t.id));
        if (this.didLoadOnce && fresh.length > 0) {
            this.recompute(now);
            this._celebrate(fresh[0], false, fresh.length, now);
        }
        this.knownCompleted = new Set([...ids, ...this.completedViaPet]);
        this.didLoadOnce = true;
        this.tracker.record(DaySnapshot.build({active, completed: this.completed, now}).open, now);
        this.recompute(now);
    }

    _refreshCalendar(now) {
        if (!this.prefs.useCalendar) {
            this.events = [];
        } else if (this.demo) {
            this._demoEvents ??= demoEvents(now);
            this.events = this._demoEvents.map(e => ({...e}));
        } else {
            try {
                this.events = this.calendar?.events(now) ?? [];
            } catch (e) {
                this._log(`TodoPet: could not read the calendar: ${e?.message ?? e}`);
                this.events = [];
            }
        }
    }

    _resetDay(now) {
        this.dayKey = dayKey(now);
        this.fired = new Map();
        this.knownCompleted = new Set();
        this.completedViaPet = new Set();
        this.didLoadOnce = false;
        this.completed = [];
    }

    // --- Mood ---

    // Work hours as the settings window allows them: start 0-23, end after the start, at most 24.
    _hours() {
        const workStart = clampInt(this.prefs.workStart, 0, 23);
        return {
            workStart,
            workEnd: clampInt(this.prefs.workEnd, workStart + 1, 24),
            planDeadline: Number.isFinite(this.prefs.planDeadline) ? this.prefs.planDeadline : workStart,
        };
    }

    _context(now) {
        const h = now.getHours() + now.getMinutes() / 60;
        const {workStart, workEnd, planDeadline} = this._hours();
        const workday = this.prefs.isWorkday(now);
        return {
            workday,
            inWork: workday && h >= workStart && h < workEnd,
            night: h >= 23 || h < 6,
            hoursAfterPlanDeadline: h - planDeadline,
            reviewTime: new Date(atHour(workEnd, 0, now).getTime() - 30 * MINUTE),
        };
    }

    // The last sign of progress: a finished task, planning, a focus session, deep work or a meeting.
    _lastProgress(now) {
        const firstLaunch = new Date(this.prefs.firstLaunch || 0);
        const start = latest(atHour(this._hours().workStart, 0, now), firstLaunch);
        let p = latest(start, this.lastPlanAction, this.lastCelebration);
        for (const t of this.day.completed) {
            const time = t.completedDate;
            if (time)
                p = latest(p, time);
        }
        if (this.focusSession)
            p = latest(p, new Date(Math.min(now.getTime(), this.focusSession.start.getTime())));
        // Deep work counts as progress, even before a task gets ticked off.
        p = latest(p, this.flow ? now : this.lastFlowEnd);
        // Time in meetings counts as work.
        for (const e of this.events) {
            if (e.start <= now)
                p = latest(p, new Date(Math.min(e.end.getTime(), now.getTime())));
        }
        return p;
    }

    _distraction(now) {
        return now > this.distractionSnoozedUntil ? this._currentDistraction(now) : null;
    }

    // The distracting app or site in front right now ({app, minutes}), even while the pet was asked to let it go.
    // Sites are matched by the browser's window title; apps by name or window class.
    _currentDistraction(now) {
        const f = this._focused();
        if (!f)
            return null;
        const since = f.since instanceof Date ? f.since : now;
        if (this.prefs.watchBrowsers && (f.isBrowser ?? isBrowser(f.wmClass))) {
            const rule = matchTitle(f.title, this.prefs.siteRules);
            const siteSince = this._siteSince(since, rule, now);
            if (rule !== null)
                return {app: rule, minutes: Math.max(0, now - siteSince) / MINUTE};
        }
        const name = String(f.appName ?? '').toLowerCase();
        const cls = String(f.wmClass ?? '').toLowerCase();
        if (!this.prefs.distractionList.some(d => name.includes(d) || cls.includes(d)))
            return null;
        return {app: f.appName || f.wmClass || '', minutes: Math.max(0, now - since) / MINUTE};
    }

    // When the visit to `rule` began. Focus gives one `since` per window, but a browser changes tabs without losing
    // focus: a site that shows up in a window already watched starts now (Swift times each address separately).
    _siteSince(windowSince, rule, now) {
        const prev = this._siteVisit;
        const sameWindow = prev !== null && prev.windowSince === windowSince.getTime();
        if (sameWindow && prev.rule === rule)
            return prev.since;
        const since = sameWindow ? now : windowSince;
        this._siteVisit = {rule, since, windowSince: windowSince.getTime()};
        return since;
    }

    _focused() {
        try {
            this.frontApp = this.env.focus() ?? null;
        } catch (e) {
            this._log(`TodoPet: could not read the focused window: ${e?.message ?? e}`);
            this.frontApp = null;
        }
        return this.frontApp;
    }

    _idleSeconds(now) {
        let idle;
        try {
            idle = Number(this.env.idleSeconds());
        } catch {
            idle = 0;
        }
        idle = Number.isFinite(idle) ? idle : 0;
        // Locked counts as away from the moment of locking.
        if (this.locked && this._lockedAt)
            idle = Math.max(idle, (now - this._lockedAt) / SECOND);
        return idle;
    }

    // Away from the computer: locked, or idle for 5 minutes.
    _isAway(now) {
        return this.locked || this._idleSeconds(now) > AWAY_SECONDS;
    }

    // A whole-number preference in [lo, hi]; GSettings does not range-check them.
    _prefInt(name, lo, hi = Infinity) {
        return clampInt(this.prefs[name], lo, hi);
    }

    _secondsSinceKey() {
        try {
            const s = Number(this.env.secondsSinceKey());
            return Number.isFinite(s) ? s : 1e9;
        } catch {
            return 1e9;
        }
    }

    // The meeting going on now, or null.
    _currentMeeting(now) {
        if (this._pins.inMeeting !== undefined) {
            if (!this._pins.inMeeting)
                return null;
            const start = startOfDay(now);
            return {id: 'pinned-meeting', title: '', start, end: new Date(start.getTime() + 24 * 60 * MINUTE), joinURL: null};
        }
        return currentEvent(this.events, now);
    }

    recompute(now = this._now()) {
        this._at(now, () => this._recompute(now));
    }

    _recompute(now) {
        this.day = DaySnapshot.build({active: this.active, completed: this.completed, now});
        const ctx = this._context(now);
        const {workStart, workEnd} = this._hours();
        const dayStart = atHour(workStart, 0, now);
        const dayEnd = atHour(workEnd, 0, now);
        const dailyTarget = clampInt(this.prefs.dailyTarget, 1);
        this.target = this.prefs.adaptTarget && this.events.length > 0
            ? targetFor(freeMinutes(this.events, dayStart, dayEnd), dailyTarget)
            : dailyTarget;
        this.suggestions = ctx.inWork ? suggest(this.day.actionable, this.events, now, dayEnd) : [];
        this.stuckTasks = this.tracker.stuck(this.day.open, clampInt(this.prefs.stuckDays, 1), now);
        this._settleLife(now);
        if (this.hasToken && this.didLoadOnce) {
            const s = this.life.state;
            const completed = this.day.completed.length;
            const planned = this.day.planned;
            const target = this.target;
            const workday = ctx.workday;
            if (s.dayCompleted !== completed || s.dayPlanned !== planned || s.dayTarget !== target || s.dayWorkday !== workday)
                this.life.mutate(x => LifeRules.syncDay(x, completed, planned, target, workday));
        }

        const i = defaultMoodInputs();
        i.hasToken = this.hasToken;
        i.workday = ctx.workday;
        i.inWorkHours = ctx.inWork;
        i.night = ctx.night;
        i.hoursAfterPlanDeadline = ctx.hoursAfterPlanDeadline;
        i.target = this.target;
        i.inMeeting = this._currentMeeting(now) !== null;
        i.stuck = this.stuckTasks.length;
        i.planned = this.day.planned;
        i.completed = this.day.completed.length;
        i.remaining = this.day.remaining;
        i.overdue = this.day.overdue.length;
        i.late = this.day.late.length;
        i.minutesSinceProgress = (now - this._lastProgress(now)) / MINUTE;
        i.minutesSinceCelebration = (now - this.lastCelebration) / MINUTE;
        const d = this._distraction(now);
        if (d) {
            i.distractedMinutes = d.minutes;
            i.distractionApp = d.app;
        }
        i.idleMinutes = this._idleSeconds(now) / 60;
        i.focusing = this.focusSession ? !this.focusSession.isBreak : false;
        i.celebratingNow = now < this.celebrateUntil;
        i.satiety = this.life.state.satiety;
        i.dirt = this.life.state.dirt;
        const r = evaluateMood(i);
        this.score = r.score;
        this.reasons = r.reasons;
        const mood = this._pins.mood ?? r.mood;
        if (this.mood !== mood) {
            // Celebrations are logged with the finished task; everything else gets its reasons.
            if (this.mood !== Mood.celebrating && mood !== Mood.celebrating) {
                const why = r.reasons.slice(0, 2).map(x => `${x.delta > 0 ? '+' : ''}${x.delta} ${x.text}`).join('; ');
                const score = Math.trunc(r.score);
                this.diary.add('mood',
                    L(`Tâm trạng: ${moodLabel(this.mood)} → ${moodLabel(mood)} (điểm ${score})`,
                        `Mood: ${moodLabel(this.mood)} → ${moodLabel(mood)} (score ${score})`) + (why === '' ? '' : ` — ${why}`),
                    {throttle: `mood-${this.mood}-${mood}`, every: 2, now});
            }
            this.mood = mood;
        }
        this.diary.enabled = this.prefs.keepLog;
        if (this._pins.angrySince !== undefined)
            this.angrySince = this._pins.angrySince;
        else
            this.angrySince = mood === Mood.angry ? (this.angrySince ?? now) : null;
        if (this._pins.annoyedSince !== undefined)
            this.annoyedSince = this._pins.annoyedSince;
        else
            this.annoyedSince = mood === Mood.annoyed || mood === Mood.angry ? (this.annoyedSince ?? now) : null;
        this._changed();
    }

    // --- Life settlement ---

    // Settles a finished day (streak, perfect-day sticker, dirt) once the date has changed, even after a restart
    // or a long sleep (the days in between are settled too).
    _settleLife(now) {
        const today = dayKey(now);
        const before = this.life.state;
        if (!this._lifeReady || before.dayKey === today || before.dayKey > today)
            return;
        const unlocked = this.life.mutate(s => LifeRules.closeDay(s, today, key => {
            const date = parseDate(key);
            return date ? this.prefs.isWorkday(date) : false;
        }));
        const after = this.life.state;
        if (before.dayKey !== '') {
            this.closeDayCalls += 1;
            let text = L(`Chốt ngày ${before.dayKey}: xong ${before.dayCompleted}/${before.dayTarget} → chuỗi ${after.streak} ngày`,
                `Closed ${before.dayKey}: ${before.dayCompleted}/${before.dayTarget} done → ${after.streak}-day streak`);
            if (after.perfectDays.length > before.perfectDays.length)
                text += L(', nhận sticker 🌟', ', earned a 🌟 sticker');
            if (after.dirt > before.dirt) {
                const more = after.dirt - before.dirt;
                text += L(`, bẩn thêm ${more} lớp`, `, ${more} more layer(s) of dirt`);
            }
            this.diary.add('life', text, {now});
        }
        if (unlocked.length > 0)
            this.say({text: Lines.unlocked(unlocked), seconds: 12, urgent: true});
        this._changed();
    }

    // Reads the saved life and postponed-tasks log. One that cannot be read is replaced by a new one in memory,
    // never saved over the old one, and tried again every few minutes.
    async _readSaved(now) {
        this._lastReadTry = now;
        const [lifeRead, trackerRead] = await Promise.all([
            this._readStored(this._lifeGate, () => this.life.load(), "the pet's life"),
            this._readStored(this._trackerGate, () => this.tracker.load(), 'the postponed-tasks log'),
        ]);
        this._lifeReadFailed = !lifeRead;
        this._trackerReadFailed = !trackerRead;
        this._lifeReady = true;
        this._changed();
    }

    // Reads one saved part unless it was read already; opens its saves once it was. Logs the first failure only.
    async _readStored(gate, load, what) {
        if (!gate || gate.open)
            return true;
        try {
            await load();
            gate.open = true;
            return true;
        } catch (e) {
            if (!gate.logged)
                this._log(`TodoPet: could not read ${what}, using a new one in memory until it can be read: ${e?.message ?? e}`);
            gate.logged = true;
            return false;
        }
    }

    // Feeds the pet once per finished task, then dances with a random (sometimes rare golden) celebration.
    _celebrate(task, viaPet, feeds = 1, now = this._now()) {
        this.lastCelebration = now;
        this.endAntic();
        let r = null;
        const unlocked = [];
        let levelUp = null;
        for (let n = 0; n < Math.max(1, feeds); n++) {
            r = this.life.mutate(s => LifeRules.feed(s, now, this._random(), this._random()));
            unlocked.push(...r.unlocked);
            levelUp = r.levelUp ?? levelUp;
        }
        this.celebration = {kind: r.kind, food: r.food, golden: r.golden, combo: r.combo, start: now};
        const title = shortText(task?.title ?? '', 40);
        const {satiety, xp} = this.life.state;
        let fed = L(`Xong “${title}”${viaPet ? '' : ' (trong Todoist)'} → no ${Math.trunc(satiety)}%, ${xp} XP`,
            `Done “${title}”${viaPet ? '' : ' (in Todoist)'} → ${Math.trunc(satiety)}% full, ${xp} XP`);
        if (feeds > 1)
            fed += L(` (${feeds} việc)`, ` (${feeds} tasks)`);
        if (r.combo >= 2)
            fed += `, combo ×${r.combo}`;
        if (r.golden)
            fed += L(', bánh vàng hiếm', ', rare golden treat');
        if (levelUp !== null)
            fed += L(`, lớn lên thành ${stageName(levelUp)}`, `, grew up: ${stageName(levelUp)}`);
        if (unlocked.length > 0)
            fed += L(', mở khoá ', ', unlocked ') + unlocked.map(accessoryEmoji).join('');
        this.diary.add('life', fed, {now});
        const big = r.golden || levelUp !== null;
        this.celebrateUntil = new Date(now.getTime() + (big ? 5 : 4) * SECOND);
        this.recompute(now);
        this._play(big ? 'big' : 'celebrate');
        if (task) {
            const actions = viaPet ? [{title: L('Hoàn tác', 'Undo'), run: () => this.undoComplete(task)}] : [];
            const lines = [Lines.done(task, this.day.completed.length, this.target)];
            if (r.golden)
                lines.push(Lines.golden());
            if (r.combo >= 2)
                lines.push(Lines.combo(r.combo));
            if (r.cleaned)
                lines.push(Lines.cleaned(this.life.state.dirt));
            if (levelUp !== null)
                lines.push(Lines.levelUp(levelUp));
            if (unlocked.length > 0)
                lines.push(Lines.unlocked(unlocked));
            this._setBubble({
                text: lines.join('\n'),
                actions,
                seconds: unlocked.length === 0 && levelUp === null ? 8 : 14,
                urgent: true,
            });
            this.lastBubbleAt = now;
            if (big)
                this._speak(Lines.voiceCheer());
        }
        this._recomputeAfterDance();
        this.emit('celebrate', this.celebration);
    }

    // Celebrates without a finished task: the dev scenes and the Developer page. Shows the dance `kind` (fireworks for
    // a golden treat) with its treat falling, for `combo`, with the chime and the mood of a real celebration (4 s, 5 s
    // when golden), and calls off any stunt. The pet is not fed, nothing goes to the diary and no bubble is said.
    devCelebrate({kind = 'jump', golden = false, combo = 1} = {}, now = this._now()) {
        if (!CELEBRATION_KINDS.includes(kind))
            throw new Error(`devCelebrate: unknown celebration '${kind}'`);
        this.endAntic();
        this.celebration = {kind: golden ? 'fireworks' : kind, food: golden ? GOLDEN_FOOD : FOODS[0], golden, combo, start: now};
        this.celebrateUntil = new Date(now.getTime() + (golden ? 5 : 4) * SECOND);
        this.recompute(now);
        this._play(golden ? 'big' : 'celebrate');
        this._recomputeAfterDance();
        this.emit('celebrate', this.celebration);
    }

    // The mood follows the end of the dance, 0.2 s after `celebrateUntil`. Swift recomputed 4.2 s after every
    // celebration, so a 5 s one (golden, or growing up) went on until the next 15 s round.
    _recomputeAfterDance() {
        this._recomputeAt = new Date(this.celebrateUntil.getTime() + 0.2 * SECOND);
    }

    // --- Talking ---

    // Shows a bubble. `why` marks it as an unsolicited reminder and records the reason in the diary; without it the
    // bubble is a reply to something you did. A bubble without buttons does not replace one with buttons unless it is
    // urgent. `tag` goes on the diary entry. Returns whether the bubble was shown.
    say(b, {chime = 'chatter', why = null, antic = false, tag = null} = {}) {
        const bubble = makeBubble(b, this._nextBubbleId());
        const cur = this.bubble;
        if (cur && cur.actions.length > 0 && !bubble.urgent && bubble.actions.length === 0)
            return false;
        bubble.reminder = why !== null;
        const now = this._now();
        this._showBubble(bubble);
        this.lastBubbleAt = now;
        this._play(chime);
        const quote = `“${shortText(bubble.text.replaceAll('\n', ' '), 90)}”`;
        if (why !== null)
            this.diary.add(antic ? 'antic' : 'bubble', `${quote} — ${L('vì ', 'because ')}${why}`, {tag, now});
        else
            this.diary.add('system', L('Pet nói ', 'Pet said ') + quote, {tag, now});
        return true;
    }

    // Takes the bubble away (the bubble view calls this when it hid it). With an id, only that bubble.
    dismissBubble(id = null) {
        if (this.bubble && (id === null || this.bubble.id === id))
            this._showBubble(null);
    }

    // What you did with the last bubble: {picked: title} (tapped a button), 'closed', or 'ignored' (faded away).
    noteResponse(response) {
        const now = this._now();
        if (response === 'closed')
            this.diary.add('response', L('Bạn đóng bong bóng', 'You closed the bubble'), {tag: 'closed', now});
        else if (response === 'ignored')
            this.diary.add('response', L('Bạn không phản hồi (tự ẩn)', 'No response (faded away)'), {tag: 'ignored', now});
        else if (typeof response?.picked === 'string')
            this.diary.add('response', L(`Bạn bấm “${response.picked}”`, `You tapped “${response.picked}”`), {tag: 'picked', now});
    }

    // Mutes reminders for `minutes` (and hides the bubble), or turns them back on with null.
    quiet(minutes) {
        const now = this._now();
        const on = minutes !== null && minutes !== undefined;
        this.quietUntil = on ? new Date(now.getTime() + minutes * MINUTE) : null;
        if (on && this.bubble !== null)
            this._showBubble(null);
        try {
            this.prefs.quietUntil = this.quietUntil?.getTime() ?? 0;
        } catch (e) {
            this._log(`TodoPet: could not remember the quiet time: ${e?.message ?? e}`);
        }
        if (this.quietUntil) {
            const q = timeString(this.quietUntil);
            this.diary.add('hold', L(`Bạn bật im lặng tới ${q}`, `You muted the pet until ${q}`), {now});
        } else {
            this.diary.add('system', L('Bạn bật lại nhắc nhở', 'You turned reminders back on'), {now});
        }
        this._changed();
    }

    endAntic() {
        if (this.antic === null)
            return;
        this.antic = null;
        this.emit('antic-end');
        this._changed();
    }

    // Plays a chime through the env if the sound setting allows this kind.
    _play(chime) {
        if (!shouldPlay(chime, this.prefs.soundMode))
            return;
        try {
            this.env.play(chime);
        } catch (e) {
            this._log(`TodoPet: could not play a sound: ${e?.message ?? e}`);
        }
    }

    _speak(text) {
        if (!this.prefs.voiceOn)
            return;
        try {
            this.env.speak(text);
        } catch (e) {
            this._log(`TodoPet: could not speak: ${e?.message ?? e}`);
        }
    }

    // True the first time `key` is asked for (until the day resets).
    _once(key, now = this._now()) {
        if (this.fired.has(key))
            return false;
        this.fired.set(key, now);
        return true;
    }

    // True when `key` has not fired for `minutes` (then it counts as fired now).
    _every(key, minutes, now = this._now()) {
        const last = this.fired.get(key);
        if (last && now - last < minutes * MINUTE)
            return false;
        this.fired.set(key, now);
        return true;
    }

    // Puts a bubble up directly, as Swift's `bubble = Bubble(...)`: no diary line, no chime, and it replaces whatever
    // is on screen. The caller sets lastBubbleAt where Swift does.
    _setBubble(b) {
        this._showBubble(makeBubble(b, this._nextBubbleId()));
    }

    _showBubble(bubble) {
        this.bubble = bubble;
        this._bubbleUntil = bubble ? new Date(this._now().getTime() + bubble.seconds * SECOND + BUBBLE_GRACE_MS) : null;
        this.emit('bubble', bubble);
        this._changed();
    }

    _nextBubbleId() {
        this._bubbleSeq += 1;
        return `bubble-${this._bubbleSeq}`;
    }

    // --- Tick ---

    // Called every second. The mood, the life and the rules run every 15 seconds (Swift's timer), a sync when the
    // last one is 3 minutes old, the new day at midnight; a gap of more than 2 minutes since the last tick is a wake.
    tick(now = this._now()) {
        if (!this._ready)
            return;
        try {
            this._at(now, () => this._tick(now));
        } catch (e) {
            this._log(`TodoPet: the brain's tick failed: ${e?.stack ?? e}`);
        }
    }

    _tick(now) {
        const last = this._lastTickAt;
        this._lastTickAt = now;
        if (last !== null && now - last > WAKE_GAP_MS)
            this.onWake(now);
        if (dayKey(now) !== this.dayKey) {
            this._resetDay(now);
            this.refreshSoon();
            this.recompute(now);
        }
        if (this._askTokenAt !== null && now >= this._askTokenAt) {
            this._askTokenAt = null;
            // The rules ask again an hour later, not on their next round.
            this.fired.set('token', now);
            this._askForToken();
        }
        // Swift's bubble window hides a bubble after its seconds and clears it; this does it when no view did.
        if (this.bubble !== null && this._bubbleUntil !== null && now >= this._bubbleUntil)
            this._showBubble(null);
        if (this._recomputeAt !== null && now >= this._recomputeAt) {
            this._recomputeAt = null;
            this.recompute(now);
        }
        // A focus session or break whose time is up (brain/actions.js). Swift checks in its 15-second tick; this
        // checks every second, so the bubble comes when the board's countdown reaches zero.
        if (this.focusSession && now >= this.focusSession.end)
            this._finishFocus(now);
        if (this._lastSlowTick === null || now - this._lastSlowTick >= SLOW_TICK_MS || now < this._lastSlowTick) {
            this._lastSlowTick = now;
            this._slowTick(now);
        }
    }

    // Swift's tick().
    _slowTick(now) {
        if ((this._tokenUnread || this._claudeKeyUnread) && this._keyringRetry === null)
            this._keyringRetry = this._track(this._retrySecrets());
        const backedOff = this._syncBackoffUntil !== null && now < this._syncBackoffUntil;
        if (this.hasToken && !this.loading && !backedOff && (this.lastSync === null || now - this.lastSync > SYNC_MS))
            this.refreshSoon();
        if ((this._lifeReadFailed || this._trackerReadFailed) && now - this._lastReadTry >= RETRY_READ_MS)
            this._track(this._readSaved(now));
        this._refreshCalendar(now);
        // Hunger grows during work hours (not during meetings or while you're away).
        const ctx = this._context(now);
        const working = this.hasToken && ctx.inWork && this._currentMeeting(now) === null && !this._isAway(now);
        this.life.mutate(s => LifeRules.decay(s, now, working));
        // Time on distracting sites, the end of a block, the distraction log and deep work (brain/rules.js).
        this._watchWork(now);
        this.recompute(now);
        this.runRules(now);
    }

    // After a sleep (or a long gap between ticks): a new day is settled, then a sync.
    onWake(now = this._now()) {
        this._at(now, () => {
            if (dayKey(now) !== this.dayKey)
                this._resetDay(now);
            this.recompute(now);
            this.refreshSoon();
        });
    }

    // While locked the pet counts you as away.
    setLocked(locked) {
        const value = Boolean(locked);
        if (value === this.locked)
            return;
        this.locked = value;
        this._lockedAt = value ? this._now() : null;
        this._changed();
    }

    // --- Test seams ---

    // Records a once-a-day key ("morning-2026-10-27") as already fired.
    markFired(key) {
        this.fired.set(key, this._now());
    }

    // Forgets when `every`/`isDue` last fired this rule, so it is due again.
    forceDue(key) {
        this.fired.delete(key);
    }

    // Pins {mood, angrySince, annoyedSince, inMeeting} (any of them) whatever recompute would decide.
    pin(pins) {
        this._pins = {...this._pins, ...pins};
        if (pins.mood !== undefined)
            this.mood = pins.mood;
        if (pins.angrySince !== undefined)
            this.angrySince = pins.angrySince;
        if (pins.annoyedSince !== undefined)
            this.annoyedSince = pins.annoyedSince;
    }

    // --- Plumbing ---

    // The brain's time: the tick (or recompute/onWake) being handled, else the clock.
    _now() {
        return this._nowOverride ?? this._clock();
    }

    _at(now, fn) {
        const saved = this._nowOverride;
        this._nowOverride = now;
        try {
            return fn();
        } finally {
            this._nowOverride = saved;
        }
    }

    _prefChanged(name) {
        if (QUIET_PREFS.has(name))
            return;
        if (name === 'secretsSerial') {
            this._track(this.reloadSecrets());
            return;
        }
        this.diary.enabled = this.prefs.keepLog;
        this._refreshCalendar(this._now());
        this.recompute();
    }

    // Keeps `promise` for settle(); a failure is logged, never thrown at the caller of _track.
    _track(promise) {
        const tracked = Promise.resolve(promise)
            .catch(e => this._log(`TodoPet: ${e?.stack ?? e}`))
            .finally(() => this._pending.delete(tracked));
        this._pending.add(tracked);
        return tracked;
    }

    _changed() {
        this.emit('changed');
    }

    // The board shows a spinner while a sync runs, so both edges are announced.
    _setLoading(value) {
        if (this.loading === value)
            return;
        this.loading = value;
        this._changed();
    }

    // Unexpected problems go to the journal. Tests replace this to see them.
    _log(message) {
        console.error(message);
    }
}

// runRules(now), updateFlow(now), trackDistraction(now) and the rules' helpers (brain/rules.js).
installRules(Brain);
// complete, undoComplete, add, reschedule, pullOverdueToToday, moveTodayToTomorrow, schedule, delete, unplan,
// suggestSteps, split, startFocus, startBreak, stopFocus and their helpers (brain/actions.js).
installActions(Brain);
