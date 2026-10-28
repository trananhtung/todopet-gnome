// The pet's diary (port of PetLog.swift): why it spoke, what you did about it, what it held back.
// One JSON-lines file per day (through the `files` object), the last 14 days. With no files it lives in memory only.
import GLib from 'gi://GLib';

import {L} from './l10n.js';
import {dayKey, timeString} from './dates.js';
import {hoursText} from './calendarMath.js';

// Entry kinds and their icons, in the order of the Swift enum.
export const LOG_KINDS = Object.freeze({
    bubble: '💬',
    response: '↳',
    antic: '😤',
    hold: '⏸',
    flow: '🎧',
    meeting: '📅',
    focus: '🍅',
    mood: '🎭',
    life: '🍙',
    distraction: '👀',
    sync: '🔄',
    // U+2699 with its emoji variation selector, as in the Swift source.
    system: '⚙\uFE0F',
});

const KEEP_DAYS = 14;
const MAX_TODAY = 1000;
const DAY_MS = 86_400_000;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

const isKind = kind => typeof kind === 'string' && Object.hasOwn(LOG_KINDS, kind);

// A log entry is a plain object {id, time: Date, kind, text, tag?, minutes?}. tag is machine-readable detail
// for the daily summary ("ignored", "picked", "closed", "flowEnd"...).

// "10:32 💬 text"
export function logLine(entry) {
    return `${timeString(entry.time)} ${isKind(entry.kind) ? LOG_KINDS[entry.kind] : ''} ${entry.text}`;
}

// Counts that show at a glance whether the pet is too pushy or too quiet.
export class LogSummary {
    constructor(entries) {
        this.bubbles = 0;
        this.ignored = 0;
        this.dismissed = 0;
        this.holds = 0;
        this.flows = 0;
        this.flowMinutes = 0;
        this.antics = 0;
        this.distractedMinutes = 0;
        for (const e of entries) {
            switch (e.kind) {
            case 'bubble':
                this.bubbles += 1;
                break;
            case 'antic':
                this.antics += 1;
                break;
            case 'response':
                if (e.tag === 'ignored')
                    this.ignored += 1;
                else if (e.tag === 'closed')
                    this.dismissed += 1;
                break;
            case 'hold':
                this.holds += 1;
                break;
            case 'flow':
                if (e.tag === 'flowEnd') {
                    this.flows += 1;
                    this.flowMinutes += e.minutes ?? 0;
                }
                break;
            case 'distraction':
                if (e.tag === 'end')
                    this.distractedMinutes += e.minutes ?? 0;
                break;
            }
        }
    }

    get text() {
        const parts = [L(`💬 ${this.bubbles} lời nhắc`, `💬 ${this.bubbles} reminders`)];
        if (this.ignored + this.dismissed > 0) {
            parts.push(L(`bạn bỏ qua ${this.ignored}, đóng ${this.dismissed}`,
                `you ignored ${this.ignored}, closed ${this.dismissed}`));
        }
        if (this.holds > 0)
            parts.push(L(`⏸ hoãn ${this.holds} lần`, `⏸ held ${this.holds}×`));
        if (this.flows > 0) {
            const time = hoursText(this.flowMinutes);
            parts.push(L(`🎧 vào guồng ${this.flows} lần (${time})`, `🎧 in the zone ${this.flows}× (${time})`));
        }
        if (this.antics > 0)
            parts.push(L(`😤 quậy ${this.antics} lần`, `😤 ${this.antics} antic(s)`));
        if (this.distractedMinutes > 0)
            parts.push(L(`👀 xao nhãng ${this.distractedMinutes}'`, `👀 distracted ${this.distractedMinutes}'`));
        return parts.join(' · ');
    }
}

// The entry stored in one line of a day file, or null when the line is not a diary entry.
// Wrongly typed optional fields are dropped; a missing id is made up.
function entryFromJSON(json) {
    if (json === null || typeof json !== 'object' || Array.isArray(json))
        return null;
    if (!isKind(json.kind) || typeof json.text !== 'string' || typeof json.time !== 'string')
        return null;
    const time = new Date(json.time);
    if (!ISO_TIME.test(json.time) || Number.isNaN(time.getTime()))
        return null;
    const entry = {
        id: typeof json.id === 'string' && json.id !== '' ? json.id : GLib.uuid_string_random(),
        time,
        kind: json.kind,
        text: json.text,
    };
    if (typeof json.tag === 'string')
        entry.tag = json.tag;
    if (typeof json.minutes === 'number' && Number.isFinite(json.minutes))
        entry.minutes = json.minutes;
    return entry;
}

// All entries of a day file, in file order. Lines that cannot be read are skipped.
function entriesFromText(text) {
    const entries = [];
    for (const line of text.split('\n')) {
        if (line.trim() === '')
            continue;
        let json;
        try {
            json = JSON.parse(line);
        } catch {
            continue;
        }
        const entry = entryFromJSON(json);
        if (entry)
            entries.push(entry);
    }
    return entries;
}

// The day key a listed file stands for ("2026-10-25" or "2026-10-25.jsonl"), or null for anything else.
function dayOfName(name) {
    const day = typeof name === 'string' ? name.replace(/\.jsonl$/, '') : '';
    return DAY_KEY.test(day) ? day : null;
}

// The pet's diary: today's entries in memory, and one JSON-lines file per day behind them.
//
// `files` is {append(day, line), read(day) -> Promise<string>, list() -> Promise<string[]>, remove(day)}:
//   append  adds `line` to that day's file as given. It is one JSON object and ends in a newline.
//   read    gives the whole text of that day's file ('' when there is none).
//   list    gives the days that have a file ("2026-10-25"; a ".jsonl" ending is tolerated).
//   remove  deletes that day's file.
// Everything that touches the files goes through one queue: it runs in order, add() never waits for it,
// and a failing file is reported to `onError` (by default the log) without breaking the pet.
export class PetLog {
    // `files: null` keeps the diary in memory only (demo mode, snapshots, tests).
    // Removes diary files older than 14 days and loads today's entries.
    static async open({files = null, now = new Date(), onError = null} = {}) {
        const log = new PetLog({files, now, onError});
        if (files) {
            await log._prune(now);
            log._today = await log.load(log._dayKey);
        }
        return log;
    }

    constructor({files = null, now = new Date(), onError = null} = {}) {
        this.enabled = true;
        this._files = files;
        this._onError = onError;
        this._dayKey = dayKey(now);
        this._today = [];
        this._lastByKey = new Map();
        this._queue = Promise.resolve();
    }

    // Today's entries, oldest first (a copy).
    get today() {
        return [...this._today];
    }

    // Adds an entry. With `throttle`, the same key is logged at most once every `every` minutes.
    // Does nothing while the diary is not enabled.
    add(kind, text, {tag = null, minutes = null, throttle = null, every = 0, now = new Date()} = {}) {
        if (!isKind(kind))
            throw new TypeError(`Unknown diary entry kind: ${kind}`);
        if (!this.enabled)
            return;
        if (throttle !== null) {
            const last = this._lastByKey.get(throttle);
            if (last !== undefined && now.getTime() - last < every * 60_000)
                return;
            this._lastByKey.set(throttle, now.getTime());
        }
        const day = dayKey(now);
        if (day !== this._dayKey) {
            this._dayKey = day;
            this._today = [];
            this._prune(now);
        }
        const entry = {id: GLib.uuid_string_random(), time: new Date(now.getTime()), kind, text};
        if (tag !== null)
            entry.tag = tag;
        if (minutes !== null)
            entry.minutes = minutes;
        this._today.push(entry);
        if (this._today.length > MAX_TODAY)
            this._today.splice(0, this._today.length - MAX_TODAY);
        this._append(entry, day);
    }

    // The entries of a day, in file order. Today comes from memory once it has entries.
    async load(day) {
        if (day === this._dayKey && this._today.length > 0)
            return this.today;
        if (!this._files)
            return [];
        await this.flush();
        try {
            return entriesFromText(await this._files.read(day));
        } catch (e) {
            this._report(e);
            return [];
        }
    }

    // Days that have a diary file, newest first. Today is always in the list.
    async days() {
        const days = new Set([this._dayKey]);
        if (this._files) {
            try {
                for (const name of await this._files.list()) {
                    const day = dayOfName(name);
                    if (day !== null)
                        days.add(day);
                }
            } catch (e) {
                this._report(e);
            }
        }
        return [...days].sort().reverse();
    }

    // Resolves when every write started so far is done (for shutdown, and for tests).
    flush() {
        return this._queue;
    }

    // Plain text for copying (e.g. to paste into a chat when tuning the pet).
    static exportText(entries, day) {
        const sorted = [...entries].sort((a, b) => a.time.getTime() - b.time.getTime());
        return [`TodoPet — ${L('nhật ký', 'diary')} ${day}`, new LogSummary(entries).text, '', ...sorted.map(logLine)]
            .join('\n');
    }

    // Runs `task` after everything queued before it; its failure is reported, never passed on.
    _enqueue(task) {
        this._queue = this._queue.then(task).catch(e => this._report(e));
        return this._queue;
    }

    _append(entry, day) {
        if (!this._files)
            return;
        const {id, time, kind, text, tag, minutes} = entry;
        const line = `${JSON.stringify({id, time: time.toISOString(), kind, text, tag, minutes})}\n`;
        this._enqueue(() => this._files.append(day, line));
    }

    // Removes the day files older than 14 days.
    _prune(now) {
        if (!this._files)
            return Promise.resolve();
        const cutoff = dayKey(new Date(now.getTime() - KEEP_DAYS * DAY_MS));
        return this._enqueue(async () => {
            for (const name of await this._files.list()) {
                const day = dayOfName(name);
                if (day === null || day >= cutoff)
                    continue;
                try {
                    await this._files.remove(day);
                } catch (e) {
                    this._report(e);
                }
            }
        });
    }

    _report(e) {
        if (this._onError)
            this._onError(e);
        else
            console.error(`TodoPet: the diary could not use its files: ${e?.message ?? e}`);
    }
}
