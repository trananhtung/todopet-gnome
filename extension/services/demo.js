// The demo (no account needed): port of DemoService from TodoService.swift, and the sample calendar events
// that Brain.useDemo() hands to the calendar watcher. Same interface as TodoistClient (services/todoist.js).
// Imports only core/ files.
import {atHour, dayKey, hourOf, timeString, utcString} from '../core/dates.js';
import {L} from '../core/l10n.js';
import {Task, statsFromApi} from '../core/models.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

// A copy, so a caller cannot change the service's own tasks (Swift's structs copy on assignment).
const copy = task => new Task(task);

// Two meetings today: one in about an hour (with a join link), one in about four hours (without).
export function demoEvents(now = new Date()) {
    const soon = atHour(hourOf(now) + 1, 0, now);
    const later = atHour(hourOf(now) + 4, 0, now);
    return [
        {
            id: 'demo-1', title: L('Họp team', 'Team sync'), start: soon, end: new Date(soon.getTime() + HOUR_MS),
            joinURL: 'https://meet.google.com/abc-defg-hij',
        },
        {
            id: 'demo-2', title: L('Gặp khách hàng', 'Client meeting'), start: later, end: new Date(later.getTime() + 45 * 60_000),
            joinURL: null,
        },
    ];
}

export class DemoService {
    // `now` is the clock (a function returning a Date); tests pass a fixed one.
    constructor({now = () => new Date()} = {}) {
        this._now = now;
        this._done = [];
        this._counter = 100;
        const start = now();
        const today = dayKey(start);
        const threeDaysAgo = dayKey(new Date(start.getTime() - 3 * DAY_MS));
        const soon = atHour(hourOf(start) + 1, 0, start);
        this._active = [
            new Task({
                id: '1', content: L('Viết báo cáo tuần', 'Write the weekly report'), priority: 4,
                due: {date: today, string: 'today'},
            }),
            new Task({
                id: '2', content: L('Gọi cho khách hàng ABC', 'Call client ABC'), priority: 3,
                due: {date: `${dayKey(soon)}T${timeString(soon)}:00`, string: 'today'},
            }),
            new Task({
                id: '3', content: L('Trả lời email của sếp', "Reply to the boss's email"), priority: 1,
                due: {date: threeDaysAgo, string: 'Monday'},
            }),
        ];
    }

    // The real client takes a moment; the demo only has to answer asynchronously.
    _pause() {
        return Promise.resolve();
    }

    // Nothing is ever in flight; here so the brain can call abort() on whichever service it holds.
    abort() {}

    async activeTasks(_filter) {
        await this._pause();
        return this._active.map(copy);
    }

    async completedTasks(_since, _until) {
        await this._pause();
        return this._done.map(copy);
    }

    async stats() {
        return statsFromApi({
            completed_count: 42 + this._done.length,
            goals: {daily_goal: 3, current_daily_streak: {count: 4}, max_daily_streak: {count: 9}},
            karma: 1234,
        });
    }

    async addTask({content, dueString = null, priority, parentId = null}) {
        await this._pause();
        this._counter += 1;
        const now = this._now();
        let day = null;
        if (dueString === 'today')
            day = dayKey(now);
        else if (dueString === 'tomorrow')
            day = dayKey(new Date(now.getTime() + DAY_MS));
        const task = new Task({
            id: String(this._counter), content, priority, due: day === null ? null : {date: day, string: dueString}, parentId,
        });
        if (day === dayKey(now))
            this._active.push(task);
        return copy(task);
    }

    async quickAdd(text) {
        await this.addTask({content: text, dueString: 'today', priority: 1, parentId: null});
    }

    async close(id) {
        await this._pause();
        const index = this._active.findIndex(task => task.id === id);
        if (index < 0)
            return;
        const [task] = this._active.splice(index, 1);
        task.checked = true;
        task.completedAt = utcString(this._now());
        this._done.push(task);
    }

    async reopen(id) {
        await this._pause();
        const index = this._done.findIndex(task => task.id === id);
        if (index < 0)
            return;
        const [task] = this._done.splice(index, 1);
        task.checked = false;
        task.completedAt = null;
        this._active.push(task);
    }

    async reschedule(id, dueString) {
        await this._pause();
        const index = this._active.findIndex(task => task.id === id);
        if (index < 0)
            return;
        if (dueString === 'tomorrow' || dueString === 'no date') {
            this._active.splice(index, 1);
            return;
        }
        const today = dayKey(this._now());
        let due = {date: today, string: dueString};
        if (dueString.startsWith('today at ')) {
            const time = dueString.split(' ').filter(part => part !== '').at(-1);
            due = {date: `${today}T${time}:00`, string: dueString};
        }
        this._active[index] = new Task({...this._active[index], due});
    }

    async delete(id) {
        await this._pause();
        this._active = this._active.filter(task => task.id !== id && task.parentId !== id);
    }
}
