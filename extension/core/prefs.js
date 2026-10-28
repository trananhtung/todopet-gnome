// User preferences. Port of Prefs.swift, backed by GSettings (Prefs.fromSettings) or by plain memory
// for tests and tools (Prefs.memory). The Todoist and Claude tokens are not preferences; they live in
// the keyring.
import {Emitter} from './emitter.js';
import {resolveLang} from './l10n.js';

export const DEFAULT_FILTER = 'today | overdue';
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';

// The single table of preferences: camelCase name -> [GSettings key, GVariant type string, default].
// The defaults must equal the ones in schemas/org.gnome.shell.extensions.todopet.gschema.xml;
// tests/core-basics.test.js compares both.
const PREFS = {
    lang: ['lang', 's', ''],
    petName: ['pet-name', 's', 'Mochi'],
    dailyTarget: ['daily-target', 'i', 3],
    workStart: ['work-start', 'i', 8],
    workEnd: ['work-end', 'i', 18],
    planDeadline: ['plan-deadline', 'i', 10],
    remindEvery: ['remind-every', 'i', 45],
    focusMinutes: ['focus-minutes', 'i', 25],
    breakMinutes: ['break-minutes', 'i', 5],
    filterQuery: ['filter-query', 's', DEFAULT_FILTER],
    distractionApps: ['distraction-apps', 's', 'TikTok, Netflix, Steam, Facebook'],
    soundMode: ['sound-mode', 's', 'important'], // 'off' | 'important' | 'all'
    workSaturday: ['work-saturday', 'b', false],
    workSunday: ['work-sunday', 'b', false],
    petScale: ['pet-scale', 'd', 1.0],
    chaseWhenAngry: ['chase-when-angry', 'b', true],
    watchBrowsers: ['watch-browsers', 'b', true],
    distractionSites: ['distraction-sites', 's',
        'youtube.com, facebook.com, tiktok.com, instagram.com, x.com, reddit.com, netflix.com'],
    useCalendar: ['use-calendar', 'b', true],
    adaptTarget: ['adapt-target', 'b', true],
    meetingLead: ['meeting-lead', 'i', 5],
    stuckDays: ['stuck-days', 'i', 3],
    claudeModel: ['claude-model', 's', DEFAULT_CLAUDE_MODEL],
    antics: ['antics', 'b', true],
    voiceOn: ['voice-on', 'b', false],
    protectFlow: ['protect-flow', 'b', true],
    stillWhileTyping: ['still-while-typing', 'b', true],
    bubbleGap: ['bubble-gap', 'i', 15],
    keepLog: ['keep-log', 'b', true],
    firstLaunch: ['first-launch', 'x', 0], // epoch ms; 0 = not set yet
    boardHotkey: ['board-hotkey', 'as', ['<Control><Super>t']],
    hiddenUntil: ['hidden-until', 'x', 0], // epoch ms; 0 = not hidden
    quietUntil: ['quiet-until', 'x', 0], // epoch ms; 0 = not quiet
    demoMode: ['demo-mode', 'b', false],
    devScreenshotDir: ['dev-screenshot-dir', 's', ''],
    devScenes: ['dev-scenes', 'as', []],
    devTrigger: ['dev-trigger', 's', ''],
    secretsSerial: ['secrets-serial', 'i', 0],
};

// Preferences the extension itself writes; everything else is changed from the preferences window.
const WRITABLE = ['hiddenUntil', 'quietUntil', 'firstLaunch', 'devTrigger', 'secretsSerial'];

const camelCase = key => key.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());

// Arrays are handed out as copies so a caller cannot change a stored value by accident.
const copy = value => (Array.isArray(value) ? [...value] : value);

class SettingsBackend {
    constructor(settings) {
        this._settings = settings;
        this._ids = new Set();
    }

    get(name) {
        const [key, type] = PREFS[name];
        switch (type) {
        case 'i': return this._settings.get_int(key);
        case 'b': return this._settings.get_boolean(key);
        case 'd': return this._settings.get_double(key);
        case 's': return this._settings.get_string(key);
        case 'as': return this._settings.get_strv(key);
        case 'x': return this._settings.get_int64(key);
        default: throw new Error(`Unsupported preference type '${type}' for ${name}`);
        }
    }

    set(name, value) {
        const [key, type] = PREFS[name];
        switch (type) {
        case 'i': this._settings.set_int(key, value); break;
        case 'b': this._settings.set_boolean(key, value); break;
        case 'd': this._settings.set_double(key, value); break;
        case 's': this._settings.set_string(key, value); break;
        case 'as': this._settings.set_strv(key, value); break;
        case 'x': this._settings.set_int64(key, value); break;
        default: throw new Error(`Unsupported preference type '${type}' for ${name}`);
        }
    }

    onChanged(cb) {
        const id = this._settings.connect('changed', (_settings, key) => cb(camelCase(key)));
        this._ids.add(id);
        return id;
    }

    disconnect(id) {
        if (this._ids.delete(id))
            this._settings.disconnect(id);
    }
}

class MemoryBackend {
    constructor(overrides) {
        this._values = new Map(Object.entries(PREFS).map(([name, [, , value]]) => [name, copy(value)]));
        for (const [name, value] of Object.entries(overrides)) {
            if (!(name in PREFS))
                throw new Error(`Unknown preference '${name}'`);
            this._values.set(name, copy(value));
        }
        this._emitter = new Emitter();
    }

    get(name) {
        return copy(this._values.get(name));
    }

    set(name, value) {
        this._values.set(name, copy(value));
        this._emitter.emit('changed', name);
    }

    onChanged(cb) {
        return this._emitter.on('changed', cb);
    }

    disconnect(id) {
        this._emitter.off(id);
    }
}

export class Prefs {
    // Use Prefs.fromSettings() or Prefs.memory() instead of calling this directly.
    constructor(backend) {
        this._backend = backend;
    }

    // Live view of a Gio.Settings object: every read goes to GSettings.
    static fromSettings(settings) {
        return new Prefs(new SettingsBackend(settings));
    }

    // In-memory preferences holding the schema defaults, with `overrides` ({camelCaseName: value}) on top.
    static memory(overrides = {}) {
        return new Prefs(new MemoryBackend(overrides));
    }

    // Calls cb(camelCaseName) whenever a preference changes. Returns an id for disconnect().
    onChanged(cb) {
        return this._backend.onChanged(cb);
    }

    disconnect(id) {
        this._backend.disconnect(id);
    }

    get effectiveLang() {
        return resolveLang(this.lang);
    }

    get effectiveFilter() {
        const f = this.filterQuery.trim();
        return f === '' ? DEFAULT_FILTER : f;
    }

    // App names that count as distractions, lowercased.
    get distractionList() {
        return this.distractionApps.split(',')
            .map(app => app.trim().toLowerCase())
            .filter(app => app !== '');
    }

    // Site rules without scheme or "www.", lowercased: "https://www.YouTube.com" -> "youtube.com".
    get siteRules() {
        return this.distractionSites.split(',')
            .map(rule => {
                let r = rule.trim().toLowerCase();
                for (const prefix of ['https://', 'http://', 'www.']) {
                    if (r.startsWith(prefix))
                        r = r.slice(prefix.length);
                }
                return r;
            })
            .filter(rule => rule !== '');
    }

    get effectiveClaudeModel() {
        const m = this.claudeModel.trim();
        return m === '' ? DEFAULT_CLAUDE_MODEL : m;
    }

    isWorkday(date) {
        switch (date.getDay()) {
        case 6: return this.workSaturday;
        case 0: return this.workSunday;
        default: return true;
        }
    }
}

// One getter per preference; a setter only for the few the extension writes itself.
for (const name of Object.keys(PREFS)) {
    const descriptor = {
        configurable: true,
        get() {
            return this._backend.get(name);
        },
    };
    if (WRITABLE.includes(name)) {
        descriptor.set = function (value) {
            this._backend.set(name, value);
        };
    }
    Object.defineProperty(Prefs.prototype, name, descriptor);
}
