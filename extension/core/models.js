// Todoist API v1 objects and the day snapshot (port of TodoTask, ProductivityStats and DaySnapshot from Models.swift).
import {dayKey, parseDate, plainText} from './dates.js';

const str = v => typeof v === 'string' ? v : null;
const num = v => typeof v === 'number' && Number.isFinite(v) ? v : null;
const bool = v => typeof v === 'boolean' ? v : null;

// Optional fields stay null when absent, like Swift's optionals.
function makeDue(due) {
    if (!due)
        return null;
    return {
        date: due.date,
        string: due.string ?? null,
        isRecurring: due.isRecurring ?? null,
        datetime: due.datetime ?? null,
        timezone: due.timezone ?? null,
    };
}

export class Task {
    // One camelCase object; every field that is missing becomes null (labels too).
    constructor({
        id, content, description = null, priority = null, due = null, deadline = null, duration = null,
        projectId = null, parentId = null, labels = null, checked = null, completedAt = null,
        childOrder = null, dayOrder = null,
    }) {
        this.id = id;
        this.content = content;
        this.description = description;
        this.priority = priority;
        this.due = makeDue(due);
        this.deadline = deadline ? {date: deadline.date} : null;
        this.duration = duration ? {amount: duration.amount, unit: duration.unit} : null;
        this.projectId = projectId;
        this.parentId = parentId;
        this.labels = labels ? [...labels] : null;
        this.checked = checked;
        this.completedAt = completedAt;
        this.childOrder = childOrder;
        this.dayOrder = dayOrder;
    }

    // Reads one Todoist API v1 task (snake_case keys); keys it does not know are ignored.
    static fromApi(json) {
        if (typeof json?.id !== 'string' || typeof json.content !== 'string')
            throw new TypeError('A Todoist task needs a string id and content');
        const {due, deadline, duration} = json;
        return new Task({
            id: json.id,
            content: json.content,
            description: str(json.description),
            priority: num(json.priority),
            due: typeof due?.date === 'string' ? {
                date: due.date,
                string: str(due.string),
                isRecurring: bool(due.is_recurring),
                datetime: str(due.datetime),
                timezone: str(due.timezone),
            } : null,
            deadline: typeof deadline?.date === 'string' ? {date: deadline.date} : null,
            duration: num(duration?.amount) !== null && typeof duration.unit === 'string'
                ? {amount: duration.amount, unit: duration.unit} : null,
            projectId: str(json.project_id),
            parentId: str(json.parent_id),
            labels: Array.isArray(json.labels) ? json.labels.filter(label => typeof label === 'string') : null,
            checked: bool(json.checked),
            completedAt: str(json.completed_at),
            childOrder: num(json.child_order),
            dayOrder: num(json.day_order),
        });
    }

    // Todoist API priority: 4 = P1 (urgent) ... 1 = P4 (normal).
    get apiPriority() {
        return this.priority ?? 1;
    }

    // Priority as the Todoist UI shows it: 1 = P1 ... 4 = P4.
    get uiPriority() {
        return 5 - Math.min(Math.max(this.apiPriority, 1), 4);
    }

    get title() {
        return plainText(this.content);
    }

    get isRecurring() {
        return this.due?.isRecurring ?? false;
    }

    // "yyyy-MM-dd" of the due date, null without a due.
    get dueDay() {
        return this.due ? this.due.date.slice(0, 10) : null;
    }

    // Exact due time if the task has one ("3pm"), else null for all-day tasks.
    get dueTime() {
        if (!this.due)
            return null;
        const fromDatetime = this.due.datetime ? parseDate(this.due.datetime) : null;
        if (fromDatetime)
            return fromDatetime;
        if (this.due.date.length > 10)
            return parseDate(this.due.date);
        return null;
    }

    get completedDate() {
        return this.completedAt ? parseDate(this.completedAt) : null;
    }

    // Planned length in minutes (a day counts as 8 working hours), null without a duration.
    get durationMinutes() {
        if (!this.duration)
            return null;
        return this.duration.unit === 'day' ? this.duration.amount * 8 * 60 : this.duration.amount;
    }
}

// Todoist "tasks/completed/stats" (snake_case) -> {streak, completedCount, daysItems, dailyGoal, karma}.
export function statsFromApi(json) {
    return {
        streak: num(json?.goals?.current_daily_streak?.count) ?? 0,
        completedCount: num(json?.completed_count),
        daysItems: Array.isArray(json?.days_items)
            ? json.days_items.map(day => ({date: str(day?.date), totalCompleted: num(day?.total_completed)}))
            : [],
        dailyGoal: num(json?.goals?.daily_goal),
        karma: num(json?.karma),
    };
}

// Highest priority first, then earliest time (timed before all-day), then earliest day, then day/child order.
function compareRank(a, b) {
    if (a.priority !== b.priority)
        return b.priority - a.priority;
    if (a.time !== null && b.time !== null) {
        if (a.time !== b.time)
            return a.time - b.time;
    } else if (a.time !== null) {
        return -1;
    } else if (b.time !== null) {
        return 1;
    }
    if (a.day !== null && b.day !== null && a.day !== b.day)
        return a.day < b.day ? -1 : 1;
    return a.order - b.order;
}

// Today's picture, derived from what Todoist returned.
export class DaySnapshot {
    constructor({today = [], overdue = [], completed = [], late = []} = {}) {
        this.today = today;         // active, due today (or undated tasks matched by the filter)
        this.overdue = overdue;     // active, due before today
        this.completed = completed; // completed today
        this.late = late;           // due today at a time that has passed
    }

    get planned() {
        return this.today.length + this.completed.length;
    }

    get remaining() {
        return this.today.length;
    }

    get open() {
        return [...this.overdue, ...this.today];
    }

    // Open tasks in "eat the frog" order (highest priority, then earliest time, then oldest overdue).
    // A task that was split into open sub-steps gives way to its steps.
    get actionable() {
        const open = this.open;
        const parents = new Set(open.map(task => task.parentId).filter(id => id !== null && id !== undefined));
        return DaySnapshot.ranked(open).filter(task => !parents.has(task.id));
    }

    get next() {
        return this.actionable[0] ?? DaySnapshot.ranked(this.open)[0] ?? null;
    }

    // A new array in rank order; equal tasks keep their input order.
    static ranked(tasks) {
        return tasks
            .map(task => ({
                task,
                priority: task.apiPriority,
                time: task.dueTime?.getTime() ?? null,
                day: task.dueDay,
                order: task.dayOrder ?? task.childOrder ?? 0,
            }))
            .sort(compareRank)
            .map(entry => entry.task);
    }

    static build({active, completed, now}) {
        const todayKey = dayKey(now);
        const snapshot = new DaySnapshot();
        for (const task of active) {
            if (task.checked === true)
                continue;
            const day = task.dueDay;
            if (day !== null && day < todayKey) {
                snapshot.overdue.push(task);
            } else if (day === null || day === todayKey) {
                snapshot.today.push(task);
                const time = task.dueTime;
                if (time !== null && time < now)
                    snapshot.late.push(task);
            }
            // Tasks due later (a custom filter may return them) don't count for today.
        }
        snapshot.today = DaySnapshot.ranked(snapshot.today);
        snapshot.overdue = DaySnapshot.ranked(snapshot.overdue);
        snapshot.completed = [...completed].sort((a, b) => {
            const x = a.completedAt ?? '';
            const y = b.completedAt ?? '';
            return x > y ? -1 : x < y ? 1 : 0;
        });
        return snapshot;
    }
}
