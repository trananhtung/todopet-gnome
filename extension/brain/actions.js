// What you do from the board, the bubbles and the menu (port of Brain.swift's "Actions" and "Focus (Pomodoro)"):
// complete and undo, add, reschedule, move, give a time, delete, take off the plan, ask Claude for steps and split,
// and the focus/break timer. A focus session is saved to the store as `focus`, so it survives a restart.
//
// These are Brain methods: brain.js installs them on Brain.prototype with installActions(Brain), the same way as
// brain/rules.js. `this` is the Brain, and the helpers used here are its own (_celebrate, say, _setBubble, _track,
// recompute, refresh, _focusAction, _laterAction, _prefInt...). Imports nothing from GNOME Shell.
import {shortText, timeString, utcString} from '../core/dates.js';
import {L} from '../core/l10n.js';
import {LifeRules} from '../core/life.js';
import {Lines} from '../core/lines.js';
import {Task} from '../core/models.js';
import {ClaudeError} from '../services/claude.js';
import {SECRET_ANTHROPIC} from '../services/secrets.js';

const MINUTE = 60 * 1000;
// Swift's Date.distantPast.
const NEVER = new Date(0);
// The store name of the focus session.
const FOCUS_STORE = 'focus';
// A session that ended while the pet was off is still asked about if it ended at most this long before the restart;
// one that ended earlier is dropped (Swift would have asked when it ended; that moment has passed).
const FOCUS_RESUME_MS = 10 * MINUTE;
// The board's "due" choices (Swift's DueChoice) and the due string each one sends; 'smart' uses Todoist's quick add.
const DUE_STRINGS = Object.freeze({today: 'today', tomorrow: 'tomorrow', none: null});

// The text to show for a failure (Swift: error.localizedDescription).
const errorMessage = e => e?.userMessage ?? e?.message ?? String(e);

// {session: null} or {session: {task: {id, title}|null, start, end (ISO), isBreak, minutes}}.
function focusToJSON(f) {
    if (!f)
        return {session: null};
    return {
        session: {
            task: f.task ? {id: f.task.id, title: f.task.title} : null,
            start: f.start.toISOString(),
            end: f.end.toISOString(),
            isBreak: f.isBreak,
            minutes: f.minutes,
        },
    };
}

// The saved session, or null when there is none or it is not one this file wrote.
function focusFromJSON(json) {
    const s = json?.session;
    if (!s || typeof s !== 'object')
        return null;
    const start = new Date(s.start);
    const end = new Date(s.end);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start)
        return null;
    if (!Number.isInteger(s.minutes) || s.minutes < 1)
        return null;
    const t = s.task;
    const task = t && typeof t.id === 'string' ? new Task({id: t.id, content: String(t.title ?? '')}) : null;
    return {task, start, end, isBreak: s.isBreak === true, minutes: s.minutes};
}

class ActionMethods {
    // --- Actions ---

    // Ticks a task off: the pet eats and dances right away; if Todoist refuses, the task comes back and the meal goes.
    complete(task) {
        const service = this.todo;
        if (!service)
            return;
        const now = this._now();
        this.active = this.active.filter(t => t.id !== task.id);
        const done = new Task({...task, checked: true, completedAt: utcString(now)});
        this.completed = [done, ...this.completed];
        this.completedViaPet.add(task.id);
        this.knownCompleted.add(task.id);
        if (this.focusSession?.task?.id === task.id && !this.focusSession.isBreak)
            this._setFocus(null);
        this._celebrate(done, true, 1, now);
        this._track((async () => {
            try {
                await service.close(task.id);
            } catch (e) {
                if (!this._live(service))
                    return;
                this.errorText = errorMessage(e);
                this.completed = this.completed.filter(t => t.id !== task.id);
                this.active = [...this.active, task];
                this.life.mutate(s => LifeRules.unfeed(s));
                this.recompute();
                this.say({text: Lines.error(errorMessage(e)), seconds: 10, urgent: true});
            }
        })());
    }

    // The bubble's Undo: the task is open again and the pet gives the meal back.
    undoComplete(task) {
        const service = this.todo;
        if (!service)
            return;
        this.life.mutate(s => LifeRules.unfeed(s));
        this.completed = this.completed.filter(t => t.id !== task.id);
        this.active = [...this.active, new Task({...task, checked: false, completedAt: null})];
        this.lastCelebration = NEVER;
        this.recompute();
        this._track((async () => {
            try {
                await service.reopen(task.id);
            } catch (e) {
                // Swift ignores this (try?); the sync below shows the task as it really is.
                this._log(`TodoPet: could not reopen a task: ${errorMessage(e)}`);
            }
            if (this._live(service))
                await this._refreshAfterChange();
        })());
    }

    // Adds a task from the board. `due`: 'today' | 'tomorrow' | 'none' | 'smart' (Todoist's own syntax, quick add);
    // `priority` is Todoist's API priority (4 = P1), passed on as it is. Resolves to whether Todoist took it.
    async add(text, due, priority) {
        const content = String(text ?? '').trim();
        const service = this.todo;
        if (!service || content === '')
            return false;
        if (due !== 'smart' && !Object.hasOwn(DUE_STRINGS, due))
            throw new TypeError(`add(): unknown due choice ${due}`);
        return await this._track(this._add(service, content, due, priority)) === true;
    }

    async _add(service, content, due, priority) {
        const plannedBefore = this.day.planned;
        try {
            if (due === 'smart')
                await service.quickAdd(content);
            else
                await service.addTask({content, dueString: DUE_STRINGS[due], priority, parentId: null});
        } catch (e) {
            if (this._live(service))
                this._actionFailed(e);
            return false;
        }
        if (!this._live(service))
            return true;
        this.lastPlanAction = this._now();
        await this._refreshAfterChange();
        const target = this.target;
        if (plannedBefore < target && this.day.planned >= target) {
            this.lastCelebration = this._now();
            this.recompute();
            const next = this.day.next;
            this.say({
                text: Lines.planComplete(target, next), actions: next ? [this._focusAction(next)] : [], seconds: 20, urgent: true,
            });
        } else {
            this.say({text: Lines.added(content), seconds: 4, urgent: true});
        }
        return true;
    }

    // Gives the task a new due ("tomorrow", "next monday", "no date"...), then syncs.
    reschedule(task, dueString) {
        const service = this.todo;
        if (!service)
            return;
        this._track((async () => {
            try {
                await service.reschedule(task.id, dueString);
            } catch (e) {
                if (this._live(service))
                    this._actionFailed(e);
            }
            if (this._live(service))
                await this._refreshAfterChange();
        })());
    }

    // Moves every overdue task that does not repeat to today.
    pullOverdueToToday() {
        const service = this.todo;
        if (!service)
            return;
        const tasks = this.day.overdue.filter(t => !t.isRecurring);
        this.lastPlanAction = this._now();
        this._track((async () => {
            await this._rescheduleEach(service, tasks, 'today');
            if (this._live(service))
                await this._refreshAfterChange();
        })());
    }

    // Moves every task of today that does not repeat to tomorrow (the evening review's button).
    moveTodayToTomorrow() {
        const service = this.todo;
        if (!service)
            return;
        const tasks = this.day.today.filter(t => !t.isRecurring);
        this._track((async () => {
            await this._rescheduleEach(service, tasks, 'tomorrow');
            if (!this._live(service))
                return;
            await this._refreshAfterChange();
            const n = tasks.length;
            this.say({
                text: L(`Đã dời ${n} việc sang mai. Nghỉ ngơi nhé 🌙`, `Moved ${n} task(s) to tomorrow. Rest well 🌙`),
                seconds: 8,
            });
        })());
    }

    // Gives a task the suggested time today ({task, start, end}), so the pet can remind you right on time.
    schedule(slot) {
        const service = this.todo;
        if (!service)
            return;
        this.lastPlanAction = this._now();
        this._track((async () => {
            try {
                await service.reschedule(slot.task.id, `today at ${timeString(slot.start)}`);
            } catch (e) {
                if (this._live(service))
                    this._actionFailed(e);
                return;
            }
            if (!this._live(service))
                return;
            await this._refreshAfterChange();
            this.say({text: Lines.timeSet(slot.task, slot.start), seconds: 6, urgent: true});
        })());
    }

    // Deletes a task (and its sub-tasks) from Todoist for good. The UI asks for confirmation first.
    delete(task) {
        const service = this.todo;
        if (!service)
            return;
        this.active = this.active.filter(t => t.id !== task.id && t.parentId !== task.id);
        if (this.focusSession?.task?.id === task.id && !this.focusSession.isBreak)
            this._setFocus(null);
        this.lastPlanAction = this._now();
        this.recompute();
        this._track((async () => {
            try {
                await service.delete(task.id);
            } catch (e) {
                if (!this._live(service))
                    return;
                this._actionFailed(e);
                this.say({text: Lines.error(errorMessage(e)), seconds: 10, urgent: true});
                await this._refreshAfterChange();
                return;
            }
            if (!this._live(service))
                return;
            this.say({text: Lines.deleted(task), seconds: 5, urgent: true});
            await this._refreshAfterChange();
        })());
    }

    // Takes a task off today's plan without deleting it (it stays in Todoist with no date).
    unplan(task) {
        const service = this.todo;
        if (!service)
            return;
        this.lastPlanAction = this._now();
        this._track((async () => {
            try {
                await service.reschedule(task.id, 'no date');
            } catch (e) {
                if (this._live(service))
                    this._actionFailed(e);
                return;
            }
            if (!this._live(service))
                return;
            await this._refreshAfterChange();
            this.say({text: Lines.unplanned(task), seconds: 6, urgent: true});
        })());
    }

    // 3-5 small first steps from Claude. Rejects with ClaudeError ('noKey' without a key in the keyring, or what the
    // client threw); a keyring that cannot be read rejects with its own error.
    async suggestSteps(task) {
        const key = await this.env.lookupSecret(SECRET_ANTHROPIC);
        if (!key)
            throw new ClaudeError('noKey');
        const client = this._claudeFactory?.(key, this.prefs.effectiveClaudeModel);
        if (!client)
            throw new Error('Brain: no claudeFactory');
        this._claudeClients.add(client);
        try {
            return await client.breakdown(task.title, task.description);
        } finally {
            this._claudeClients.delete(client);
        }
    }

    // Adds the steps as Todoist sub-tasks of `task` (blank ones are skipped); with `firstToday` the first one goes on
    // today's plan. Resolves to whether all of them were added.
    async split(task, steps, firstToday) {
        const clean = steps.map(s => String(s ?? '').trim()).filter(s => s !== '');
        const service = this.todo;
        if (!service || clean.length === 0)
            return false;
        return await this._track(this._split(service, task, clean, firstToday)) === true;
    }

    async _split(service, task, clean, firstToday) {
        let first = null;
        try {
            for (const [i, step] of clean.entries()) {
                const created = await service.addTask({
                    content: step, dueString: i === 0 && firstToday ? 'today' : null, priority: task.apiPriority, parentId: task.id,
                });
                if (i === 0)
                    first = created;
            }
        } catch (e) {
            if (this._live(service))
                this._actionFailed(e);
            return false;
        }
        if (!this._live(service))
            return true;
        this.lastPlanAction = this._now();
        await this._refreshAfterChange();
        const start = first ? this.day.open.find(t => t.id === first.id) ?? null : null;
        this.say({
            text: Lines.splitDone(clean.length, clean[0]), actions: start ? [this._focusAction(start)] : [], seconds: 30, urgent: true,
        });
        return true;
    }

    // --- Focus (Pomodoro) ---

    // Starts a focus session on `task` (the next task when null) for `minutes` (the setting when not given).
    startFocus(task = null, minutes = null) {
        const m = Number.isFinite(minutes) ? Math.max(1, Math.trunc(minutes)) : this._prefInt('focusMinutes', 1);
        const now = this._now();
        const t = task ?? this.day.next;
        this._setFocus({task: t, start: now, end: new Date(now.getTime() + m * MINUTE), isBreak: false, minutes: m});
        this.recompute(now);
        this._setBubble({text: Lines.focusStart(t, m), seconds: 5});
        this.lastBubbleAt = now;
        this.diary.add('focus', L(`Bắt đầu tập trung ${m} phút`, `Started a ${m}-minute focus session`) +
            (t ? `: “${shortText(t.title, 40)}”` : ''), {now});
    }

    startBreak() {
        const now = this._now();
        const m = this._prefInt('breakMinutes', 1);
        this._setFocus({task: null, start: now, end: new Date(now.getTime() + m * MINUTE), isBreak: true, minutes: m});
        this.recompute(now);
        this._setBubble({text: L(`Nghỉ ${m} phút nhé ☕ Uống nước, vươn vai đi!`, `${m}-minute break ☕ Water and stretch!`), seconds: 6});
        this.diary.add('focus', L(`Nghỉ ${m} phút`, `${m}-minute break`), {now});
    }

    stopFocus() {
        const now = this._now();
        const f = this.focusSession;
        if (f) {
            const minutes = Math.trunc((now - f.start) / MINUTE);
            this.diary.add('focus', f.isBreak
                ? L(`Bạn dừng giờ nghỉ sau ${minutes} phút`, `You ended the break after ${minutes} min`)
                : L(`Bạn dừng tập trung sau ${minutes}/${f.minutes} phút`, `You stopped focusing after ${minutes}/${f.minutes} min`),
            {now});
        }
        this._setFocus(null);
        this.recompute(now);
    }

    // The session's time is up (brain.js checks every tick): did you finish? After a break: back to work.
    // lastRule becomes 'focusEnd', or 'breakEnd' after a break.
    _finishFocus(now) {
        const f = this.focusSession;
        if (!f)
            return;
        this.diary.add('focus', f.isBreak
            ? L('Hết giờ nghỉ', 'Break over')
            : L(`Xong phiên tập trung ${f.minutes} phút`, `Finished a ${f.minutes}-minute focus session`), {now});
        this._setFocus(null);
        this.recompute(now);
        this._play('important');
        if (f.isBreak) {
            this._setBubble({
                text: Lines.breakEnd(), actions: [this._focusAction(this.day.next), this._laterAction()], seconds: 60, urgent: true,
            });
            this.lastRule = 'breakEnd';
        } else {
            const actions = [];
            // The task as the last sync has it (a restored session only kept its id and title).
            const open = f.task ? this.day.open.find(t => t.id === f.task.id) : null;
            if (open) {
                actions.push({
                    title: L('✓ Xong rồi', '✓ Done'),
                    primary: true,
                    run: () => {
                        this.complete(open);
                        this.startBreak();
                    },
                });
            }
            actions.push({title: L(`+${f.minutes}' nữa`, `+${f.minutes}' more`), run: () => this.startFocus(f.task, f.minutes)});
            const b = this._prefInt('breakMinutes', 1);
            actions.push({title: L(`☕ Nghỉ ${b}'`, `☕ Break ${b}'`), run: () => this.startBreak()});
            this._setBubble({text: Lines.focusEnd(f.task, f.minutes), actions, seconds: 120, urgent: true});
            this.lastRule = 'focusEnd';
        }
        this.lastBubbleAt = now;
    }

    // Sets the session and saves it (the demo keeps it in memory only, like its pet).
    _setFocus(session) {
        this.focusSession = session;
        if (!this.store || this.demo)
            return;
        try {
            this.store.save(FOCUS_STORE, focusToJSON(session));
        } catch (e) {
            this._log(`TodoPet: could not save the focus session: ${e?.message ?? e}`);
        }
    }

    // start(): brings back the session that was running when the pet stopped. One that ended more than a few minutes
    // ago is dropped; one that ended moments ago ends on the first tick.
    async _restoreFocus(now) {
        if (!this.store || this.demo)
            return;
        let saved;
        try {
            saved = await this.store.load(FOCUS_STORE);
        } catch (e) {
            this._log(`TodoPet: could not read the saved focus session: ${e?.message ?? e}`);
            return;
        }
        const f = focusFromJSON(saved);
        if (!f)
            return;
        if (now - f.end > FOCUS_RESUME_MS)
            this._setFocus(null);
        else
            this.focusSession = f;
    }

    // --- Helpers ---

    // A sync that starts after the change just made: one already in flight may have read the tasks before it.
    async _refreshAfterChange() {
        const inFlight = this._refreshing;
        if (inFlight && this._refreshingGen === this._serviceGen)
            await inFlight;
        return this.refresh();
    }

    async _rescheduleEach(service, tasks, dueString) {
        for (const t of tasks) {
            try {
                await service.reschedule(t.id, dueString);
            } catch (e) {
                // Swift moves the others anyway (try?); the sync shows what moved.
                this._log(`TodoPet: could not move a task to ${dueString}: ${errorMessage(e)}`);
            }
            if (!this._live(service))
                return;
        }
    }

    _actionFailed(e) {
        this.errorText = errorMessage(e);
        this._changed();
    }

    // The result of a request still matters: the brain runs and still uses that service.
    _live(service) {
        return !this._stopped && this.todo === service;
    }
}

// Adds the methods above to `cls.prototype` (non-enumerable, like class methods). A name the class already has is
// a mistake, so it throws instead of replacing it.
export function installActions(cls) {
    const descriptors = Object.getOwnPropertyDescriptors(ActionMethods.prototype);
    for (const [name, descriptor] of Object.entries(descriptors)) {
        if (name === 'constructor')
            continue;
        if (Object.hasOwn(cls.prototype, name))
            throw new Error(`brain/actions.js: ${cls.name} already has ${name}`);
        Object.defineProperty(cls.prototype, name, descriptor);
    }
}
