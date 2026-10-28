// Spots tasks you keep postponing (port of StuckTracker.swift). Todoist doesn't say how often a task was
// rescheduled, so the pet keeps its own small log: task id -> the days it sat on your list.
import {dayKey, daysBetween} from './dates.js';

const STORE_NAME = 'stuck';
const DAY_MS = 86_400_000;
const KEEP_DAYS = 21;
const MAX_DAYS_PER_TASK = 30;

// Days on the list: what we saw ourselves, or how long it has been overdue (counting today), whichever is larger.
export function stuckDays(seen, dueDay, today) {
    if (typeof dueDay !== 'string' || !(dueDay < today))
        return seen;
    return Math.max(seen, daysBetween(dueDay, today) + 1);
}

// The saved form is {seen: {id: [dayKey, ...]}}; anything else, and any bad entry, is ignored.
// A Map keeps ids such as "__proto__" harmless.
function seenFromJSON(json) {
    const seen = new Map();
    const raw = json?.seen;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        return seen;
    for (const [id, days] of Object.entries(raw)) {
        if (Array.isArray(days))
            seen.set(id, days.filter(day => typeof day === 'string'));
    }
    return seen;
}

export class StuckTracker {
    // `store` is {load(name) -> Promise<object|null>, save(name, obj)}; without one nothing is persisted.
    // `onSaveError(error)` hears about saves that failed; by default they go to the log.
    constructor({store = null, onSaveError = null} = {}) {
        this._store = store;
        this._onSaveError = onSaveError;
        this._seen = new Map();
    }

    // Replaces the log with the saved one. A failing read is passed on, so a log that could not be read is
    // never overwritten.
    async load() {
        if (!this._store)
            return;
        this._seen = seenFromJSON(await this._store.load(STORE_NAME));
    }

    // Notes that these tasks are on today's list (recurring ones are skipped) and forgets tasks not seen for 21 days.
    record(tasks, now) {
        const today = dayKey(now);
        const cutoff = dayKey(new Date(now.getTime() - KEEP_DAYS * DAY_MS));
        let changed = false;
        for (const task of tasks) {
            if (task.isRecurring)
                continue;
            const days = this._seen.get(task.id) ?? [];
            if (!days.includes(today)) {
                days.push(today);
                this._seen.set(task.id, days.slice(-MAX_DAYS_PER_TASK));
                changed = true;
            }
        }
        for (const [id, days] of [...this._seen]) {
            if ((days.at(-1) ?? '') < cutoff) {
                this._seen.delete(id);
                changed = true;
            }
        }
        if (changed)
            this._save();
    }

    // How many distinct days the task was on the list.
    seenDays(id) {
        return this._seen.get(id)?.length ?? 0;
    }

    // Pre-fills the history with `days` days ending today (dev helper; changes memory only).
    pretend(id, days, now) {
        const keys = [];
        for (let back = Math.max(0, Math.trunc(days) || 0) - 1; back >= 0; back--)
            keys.push(dayKey(new Date(now.getTime() - back * DAY_MS)));
        this._seen.set(id, keys);
    }

    // Tasks on the list for at least `minDays` days, the longest first.
    stuck(tasks, minDays, now) {
        const today = dayKey(now);
        return tasks
            .filter(task => !task.isRecurring)
            .map(task => ({task, days: stuckDays(this.seenDays(task.id), task.dueDay, today)}))
            .filter(entry => entry.days >= minDays)
            .sort((a, b) => b.days - a.days);
    }

    // A store that cannot save must not break the pet: log it and carry on with the in-memory log.
    _save() {
        if (!this._store)
            return;
        const seen = Object.fromEntries([...this._seen].map(([id, days]) => [id, [...days]]));
        try {
            Promise.resolve(this._store.save(STORE_NAME, {seen})).catch(e => this._reportSaveError(e));
        } catch (e) {
            this._reportSaveError(e);
        }
    }

    _reportSaveError(e) {
        if (this._onSaveError)
            this._onSaveError(e);
        else
            console.error(`TodoPet: could not save the postponed tasks log: ${e?.message ?? e}`);
    }
}
