// The split view (port of BreakdownView in PlanningViews.swift): a big or vague task is cut into small first steps,
// by hand, from the quick template or with Claude, and saved as Todoist sub-tasks (brain.split). Shown by the board
// in place of the task list (a ✂ on a task row, or the stuck bubble's "✂️ Split it").
//
//   build(app, onBack, task) -> St.Widget    onBack() returns to the task list
//
// The widget carries what the board needs: dispose() (called before it is destroyed), handleEscape() (Escape takes
// the delete question away first) and `view`, the SplitView with the parts the dev scenes use. What it shows comes
// from splitModel() (ui/viewsLogic.js); the text in the fields is kept here.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {L} from '../core/l10n.js';
import {
    addStep, emptySteps, filledSteps, removeStep, saveFailedText, splitErrorText, splitModel, stepsFromSuggestion,
    templateSteps,
} from './viewsLogic.js';
import {
    CheckRow, PageShell, box, busyPill, iconButton, iconPill, label, linkButton, pillButton, setSensitive, spacer,
    wrapLabel,
} from './widgets.js';

// How long a field keeps the key focus while it is drawn with the text the code gave it (a few frames).
const PRIME_MS = 80;

export class SplitView {
    constructor(app, onBack, task) {
        this._app = app;
        this._brain = app.brain;
        this._onBack = onBack;
        this._task = task;
        this._steps = emptySteps();
        this._firstToday = true;
        this._asking = false;
        this._saving = false;
        this._error = null;
        this._confirming = false;
        this._disposed = false;
        this._failed = false;
        this._sig = null;
        this._model = null;
        this._lines = [];
        this._entries = [];
        this._removes = [];
        this._queue = []; // fields waiting for their text (see _fill)
        this._primeSource = 0;

        const column = box({vertical: true, styleClass: 'todopet-page todopet-page-split'});
        this._shell = new PageShell(column, {scroll: true});
        this.actor = this._shell.actor;
        this._build(column);
        this._brainId = this._brain?.on('changed', () => this._guard(() => this._update())) ?? 0;
        this._update(false);
    }

    // --- For the dev scenes ---

    get backButton() {
        return this._back;
    }

    get model() {
        return this._model;
    }

    get entries() {
        return this._entries;
    }

    get removeButtons() {
        return this._removes;
    }

    get askButton() {
        return this._ask;
    }

    get templateButton() {
        return this._template;
    }

    get addStepButton() {
        return this._addStep;
    }

    get saveButton() {
        return this._save;
    }

    get dropButton() {
        return this._drop;
    }

    get deleteButton() {
        return this._delete;
    }

    get firstTodayRow() {
        return this._firstTodayRow;
    }

    get errorLabel() {
        return this._errorLabel;
    }

    get stuckLabel() {
        return this._stuckLabel;
    }

    get keyHint() {
        return this._keyHint;
    }

    get confirmButtons() {
        return this._confirmBox.visible ? {cancel: this._cancel, remove: this._remove} : null;
    }

    // Whether the fields are still being given their text.
    get filling() {
        return this._queue.length > 0 || this._primeSource !== 0;
    }

    get asking() {
        return this._asking;
    }

    get saving() {
        return this._saving;
    }

    // --- Page contract (ui/board.js) ---

    // Escape takes the delete question away first; the board closes only when there is none.
    handleEscape() {
        if (!this._confirming)
            return false;
        this._confirming = false;
        this._update();
        return true;
    }

    dispose() {
        this._disposed = true;
        if (this._brainId !== 0)
            this._brain?.off(this._brainId);
        this._brainId = 0;
        if (this._primeSource !== 0)
            GLib.source_remove(this._primeSource);
        this._primeSource = 0;
        this._queue = [];
        this._shell.dispose();
    }

    // --- Building ---

    _build(column) {
        const header = box({styleClass: 'todopet-page-header'});
        this._back = iconButton('go-previous-symbolic', () => this._onBack(), {accessibleName: L('Quay lại', 'Back')});
        header.add_child(this._back);
        this._title = label('', 'todopet-headline');
        header.add_child(this._title);
        column.add_child(header);

        this._taskLabel = wrapLabel('', 'todopet-page-task');
        column.add_child(this._taskLabel);
        this._stuckLabel = label('', 'todopet-caption todopet-tone-orange', {x_align: Clutter.ActorAlign.START});
        column.add_child(this._stuckLabel);
        this._intro = wrapLabel('', 'todopet-callout todopet-secondary');
        column.add_child(this._intro);

        const actions = box({styleClass: 'todopet-split-actions'});
        this._ask = busyPill(() => this._askClaude(), {styleClass: 'todopet-pill-box'});
        this._shell.tooltips.attach(this._ask, () => this._model?.ask.tooltip);
        this._template = pillButton('', () => this.fillTemplate(), {styleClass: 'todopet-pill-box'});
        actions.add_child(this._ask);
        actions.add_child(this._template);
        column.add_child(actions);
        this._keyHint = wrapLabel('', 'todopet-caption todopet-secondary');
        column.add_child(this._keyHint);

        this._stepsBox = box({vertical: true, styleClass: 'todopet-steps'});
        column.add_child(this._stepsBox);
        this._addStep = iconButton('list-add-symbolic', () => this._appendStep(), {text: '', styleClass: 'todopet-add-step'});
        this._addStep.x_align = Clutter.ActorAlign.START;
        column.add_child(this._addStep);

        this._firstTodayRow = new CheckRow('', this._firstToday, checked => {
            this._firstToday = checked;
            this._update();
        });
        column.add_child(this._firstTodayRow.actor);

        this._errorLabel = wrapLabel('', 'todopet-caption todopet-tone-red');
        column.add_child(this._errorLabel);

        // Swift: HStack(alignment: .firstTextBaseline), the buttons level with the question's first line.
        this._confirmBox = box({styleClass: 'todopet-confirm-box'});
        this._confirmText = wrapLabel('', 'todopet-caption todopet-tone-red');
        this._cancel = linkButton('', () => {
            this._confirming = false;
            this._update();
        }, {styleClass: 'todopet-plain-link'});
        this._remove = linkButton('', () => this._deleteTask(), {styleClass: 'todopet-danger-link'});
        this._cancel.y_align = Clutter.ActorAlign.START;
        this._remove.y_align = Clutter.ActorAlign.START;
        this._confirmBox.add_child(this._confirmText);
        this._confirmBox.add_child(this._cancel);
        this._confirmBox.add_child(this._remove);
        column.add_child(this._confirmBox);

        const bottom = box({styleClass: 'todopet-split-bottom'});
        this._drop = pillButton('', () => this._dropFromPlan(), {styleClass: 'todopet-pill-box'});
        this._shell.tooltips.attach(this._drop, () => this._model?.drop.tooltip);
        this._delete = iconPill('user-trash-symbolic', () => {
            this._confirming = true;
            this._update();
        }, {styleClass: 'todopet-pill-box todopet-pill-danger'});
        this._shell.tooltips.attach(this._delete, () => this._model?.deleteTooltip);
        this._save = busyPill(() => this._saveSteps(), {primary: true, styleClass: 'todopet-pill-box'});
        bottom.add_child(this._drop);
        bottom.add_child(this._delete);
        bottom.add_child(spacer());
        bottom.add_child(this._save);
        column.add_child(bottom);
    }

    // Brings the step fields in line with the list: one field per step (the last ones are added or taken away), each
    // with the text of its step. Called by _update() when the number of steps changed, and after a new list was set.
    _syncRows() {
        this._shell.tooltips.hide();
        const rows = this._model.rows;
        while (this._lines.length > rows.length) {
            const entry = this._entries.pop();
            this._queue = this._queue.filter(waiting => waiting !== entry);
            this._removes.pop();
            this._lines.pop().destroy();
        }
        rows.forEach((row, i) => {
            if (!this._lines[i])
                this._addRow(i, row);
            this._removes[i].visible = row.removable;
            const entry = this._entries[i];
            if (entry.get_text() !== this._steps[i])
                this._fill(entry);
        });
    }

    // A new step field: empty (see _fill), numbered, with a button that takes the step away.
    _addRow(i, row) {
        const line = box({styleClass: 'todopet-step'});
        line.add_child(label(row.number, 'todopet-callout todopet-secondary todopet-tnum todopet-step-number'));
        const entry = new St.Entry({style_class: 'todopet-entry', hint_text: row.placeholder, can_focus: true, x_expand: true});
        entry.clutter_text.connect('text-changed', () => {
            this._steps[i] = entry.get_text();
            this._update();
        });
        // Swift: the Add to Todoist button is the window's default action, so Return in a field saves.
        entry.clutter_text.connect('activate', () => this._saveSteps());
        line.add_child(entry);
        const remove = iconButton('list-remove-symbolic', () => this._removeAt(i), {
            accessibleName: L('Xoá bước', 'Remove the step'), styleClass: 'todopet-step-remove',
        });
        line.add_child(remove);
        this._stepsBox.add_child(line);
        this._lines.push(line);
        this._entries.push(entry);
        this._removes.push(remove);
    }

    // Puts the text of a step in its field. Clutter logs a critical ("clutter_input_focus_is_focused") when an
    // editable text that has no input focus is drawn with new text. So a field gets text from the code only while it
    // has the key focus, and keeps it for a few frames (PRIME_MS) before the next one. The fields are filled last
    // to first: the focus ends in the first one.
    _fill(entry) {
        if (!this._queue.includes(entry))
            this._queue.push(entry);
        if (this._primeSource === 0)
            this._primeNext();
    }

    _textOf(entry) {
        return this._steps[this._entries.indexOf(entry)] ?? '';
    }

    _primeNext() {
        this._primeSource = 0;
        if (this._queue.length === 0)
            return;
        this._queue.sort((a, b) => this._entries.indexOf(b) - this._entries.indexOf(a));
        const entry = this._queue.shift();
        entry.grab_key_focus();
        entry.set_text(this._textOf(entry));
        this._primeSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PRIME_MS, () => {
            this._primeNext();
            return GLib.SOURCE_REMOVE;
        });
    }

    // --- State ---

    // Puts the state on screen. The fields are rebuilt only when their number changed (or `rows` says so).
    _update(relayout = true) {
        if (this._disposed)
            return;
        const m = splitModel({
            task: this._task,
            stuckDays: this._stuckDays(),
            hasClaudeKey: Boolean(this._brain?.hasClaudeKey),
            steps: this._steps,
            firstToday: this._firstToday,
            asking: this._asking,
            saving: this._saving,
            error: this._error,
            confirming: this._confirming,
        });
        const sig = JSON.stringify(m);
        if (sig === this._sig)
            return;
        this._sig = sig;
        this._model = m;

        this._title.text = m.title;
        this._taskLabel.text = m.task;
        this._stuckLabel.visible = m.stuck !== null;
        this._stuckLabel.text = m.stuck ?? '';
        this._intro.text = m.intro;
        this._ask.setText(m.ask.label);
        this._ask.setBusy(m.ask.busy);
        setSensitive(this._ask, m.ask.enabled);
        this._template.set_label(m.template);
        this._keyHint.visible = m.keyHint !== null;
        this._keyHint.text = m.keyHint ?? '';
        if (m.rows.length !== this._entries.length)
            this._syncRows();
        this._addStep.visible = m.addStep.visible;
        this._addStep.textLabel.text = m.addStep.label;
        this._firstTodayRow.setText(m.firstToday.label);
        this._firstTodayRow.setChecked(m.firstToday.checked);
        this._errorLabel.visible = m.error !== null;
        this._errorLabel.text = m.error ?? '';
        this._confirmBox.visible = m.confirm !== null;
        if (m.confirm) {
            this._confirmText.text = m.confirm.text;
            this._cancel.set_label(m.confirm.cancel);
            this._remove.set_label(m.confirm.delete);
        }
        this._drop.set_label(m.drop.label);
        this._save.setText(m.save.label);
        this._save.setBusy(m.save.busy);
        setSensitive(this._save, m.save.enabled);
        if (relayout)
            this._app.board?.relayout();
    }

    _stuckDays() {
        const stuck = this._brain?.stuckTasks?.find(s => s.task.id === this._task.id);
        return stuck ? stuck.days : null;
    }

    // Replaces the list (the template, or Claude's answer); the fields take the new text.
    _setSteps(steps) {
        this._steps = steps;
        this._sig = null;
        this._update();
        this._syncRows();
    }

    // Replaces the steps (for the dev scenes: what the quick template and Claude do).
    setSteps(steps) {
        this._setSteps(steps);
    }

    fillTemplate() {
        this._setSteps(templateSteps(this._task.title));
    }

    _appendStep() {
        const next = addStep(this._steps);
        if (next.length === this._steps.length)
            return;
        this._steps = next;
        this._update();
        this._entries.at(-1)?.grab_key_focus();
    }

    _removeAt(index) {
        this._steps = removeStep(this._steps, index);
        this._update();
    }

    // --- Actions ---

    async _askClaude() {
        const brain = this._brain;
        if (!brain || !this._model?.ask.enabled)
            return;
        this._asking = true;
        this._error = null;
        this._update();
        let steps = null;
        let failure = null;
        try {
            steps = stepsFromSuggestion(await brain.suggestSteps(this._task));
        } catch (e) {
            failure = splitErrorText(e);
        }
        if (this._disposed)
            return;
        this._asking = false;
        this._error = failure;
        if (steps)
            this._setSteps(steps);
        else
            this._update();
    }

    async _saveSteps() {
        const brain = this._brain;
        if (!brain || !this._model?.save.enabled)
            return;
        this._saving = true;
        this._error = null;
        this._update();
        let saved = false;
        let failure = null;
        try {
            saved = await brain.split(this._task, filledSteps(this._steps), this._firstToday);
        } catch (e) {
            failure = splitErrorText(e);
        }
        if (this._disposed)
            return;
        this._saving = false;
        if (saved) {
            this._onBack();
            return;
        }
        this._error = failure ?? saveFailedText(brain.errorText);
        this._update();
    }

    _dropFromPlan() {
        this._brain?.unplan(this._task);
        this._onBack();
    }

    _deleteTask() {
        this._brain?.delete(this._task);
        this._onBack();
    }

    _guard(fn) {
        try {
            fn();
        } catch (e) {
            if (!this._failed)
                console.error(`TodoPet: the split view failed: ${e?.stack ?? e}`);
            this._failed = true;
        }
    }
}

// The board's page builder.
export function build(app, onBack, task) {
    const view = new SplitView(app, onBack, task);
    const actor = view.actor;
    actor.view = view;
    actor.dispose = () => view.dispose();
    actor.handleEscape = () => view.handleEscape();
    return actor;
}
