// The pet's diary (port of LogView in LogView.swift): what the pet said, what it held back, and why. A day picker, a
// kind filter, the summary line, the entries (newest first), Copy and Open folder. Shown by the board in place of the
// task list (the diary button in its footer), with or without a Todoist token.
//
//   build(app, onBack) -> St.Widget    onBack() returns to the task list
//
// The widget carries dispose() (called before it is destroyed), handleEscape() (Escape closes the day menu first)
// and `view`, the DiaryView with the parts the dev scenes use. What it shows comes from diaryModel()
// (ui/viewsLogic.js). Today's entries are read live from the diary; another day's are loaded from its file.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {PetLog} from '../core/diary.js';
import {dayKey} from '../core/dates.js';
import {L} from '../core/l10n.js';
import {diaryModel, entriesSignature, filterChoices, folderURI} from './viewsLogic.js';
import {OverlayLayer, PageShell, Segmented, box, iconButton, label, spacer, wrapLabel} from './widgets.js';

export class DiaryView {
    constructor(app, onBack) {
        this._app = app;
        this._brain = app.brain;
        this._onBack = onBack;
        this._disposed = false;
        this._failed = false;
        this._day = dayKey(new Date());
        this._filter = 'all';
        this._copied = false;
        this._days = [this._day];
        this._entries = [];
        this._sig = null;
        this._model = null;
        this._seq = 0;
        this._menuOpen = false;
        this._closeSource = 0;
        this._pollSource = 0;

        const column = box({vertical: true, styleClass: 'todopet-page todopet-page-diary'});
        this._shell = new PageShell(column);
        this.actor = this._shell.actor;
        this._build(column);
        this._buildMenu();
        // Reactive, or it would not see the presses that close the day menu.
        this.actor.reactive = true;
        this.actor.connect('captured-event', (_actor, event) => this._onCapturedEvent(event));
        this._brainId = this._brain?.on('changed', () => this._guard(() => this._onBrainChanged())) ?? 0;
        // The diary has no events of its own: today's page looks for new entries every second (Swift: @ObservedObject).
        this._pollSource = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._guard(() => this._onBrainChanged());
            return GLib.SOURCE_CONTINUE;
        });
        this._loadEntries();
        this._loadDays();
    }

    // --- For the dev scenes ---

    get backButton() {
        return this._back;
    }

    get model() {
        return this._model;
    }

    get day() {
        return this._day;
    }

    get dayButton() {
        return this._dayButton;
    }

    get filterButtons() {
        return this._filters;
    }

    get copyButton() {
        return this._copy;
    }

    get folderButton() {
        return this._folder;
    }

    get summaryLabel() {
        return this._summary;
    }

    get menuOpen() {
        return this._menuOpen;
    }

    get menuItems() {
        return this._menuItems;
    }

    // The texts of the rows now on screen, newest first.
    get rowTexts() {
        return this._list.get_children().filter(row => row.todopetText !== undefined).map(row => row.todopetText);
    }

    get emptyLabel() {
        return this._emptyLabel;
    }

    // Resolves once the entries of the shown day are on screen.
    get loaded() {
        return this._loading ?? Promise.resolve();
    }

    // --- Page contract (ui/board.js) ---

    // Escape closes the day menu first; the board closes only when it is not open.
    handleEscape() {
        if (!this._menuOpen)
            return false;
        this._closeMenu();
        return true;
    }

    dispose() {
        this._disposed = true;
        this._seq += 1;
        if (this._brainId !== 0)
            this._brain?.off(this._brainId);
        this._brainId = 0;
        for (const source of [this._closeSource, this._pollSource]) {
            if (source !== 0)
                GLib.source_remove(source);
        }
        this._closeSource = 0;
        this._pollSource = 0;
        this._shell.dispose();
    }

    // --- Building ---

    _build(column) {
        const header = box({styleClass: 'todopet-page-header'});
        this._back = iconButton('go-previous-symbolic', () => this._onBack(), {accessibleName: L('Quay lại', 'Back')});
        header.add_child(this._back);
        this._title = label('', 'todopet-headline');
        header.add_child(this._title);
        header.add_child(spacer());
        // A picker: the day, then a chevron (Swift: Picker with .labelsHidden()).
        const picker = box({styleClass: 'todopet-day-button-box'});
        this._dayLabel = label('', 'todopet-callout');
        picker.add_child(this._dayLabel);
        picker.add_child(new St.Icon({icon_name: 'pan-down-symbolic', style_class: 'todopet-icon', y_align: Clutter.ActorAlign.CENTER}));
        this._dayButton = new St.Button({child: picker, style_class: 'todopet-day-button', can_focus: true, y_align: Clutter.ActorAlign.CENTER});
        this._dayButton.connect('clicked', () => this._toggleMenu());
        header.add_child(this._dayButton);
        column.add_child(header);

        this._summary = wrapLabel('', 'todopet-caption todopet-secondary');
        column.add_child(this._summary);

        this._filterControl = new Segmented(filterChoices(), this._filter, id => {
            this._filter = id;
            this._apply();
        }, {styleClass: 'todopet-diary-filter'});
        this._filters = this._filterControl.actor.get_children();
        column.add_child(this._filterControl.actor);

        this._list = box({vertical: true, styleClass: 'todopet-diary-list', x_expand: true});
        this._scroll = new St.ScrollView({
            style_class: 'todopet-diary-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            child: this._list,
        });
        column.add_child(this._scroll);

        const actions = box({styleClass: 'todopet-diary-actions'});
        this._copy = iconButton('edit-copy-symbolic', () => this._copyDay(), {text: '', styleClass: 'todopet-diary-action'});
        this._shell.tooltips.attach(this._copy, () => this._model?.copy.tooltip);
        this._folder = iconButton('folder-symbolic', () => this._openFolder(), {text: '', styleClass: 'todopet-diary-action'});
        actions.add_child(this._copy);
        actions.add_child(spacer());
        actions.add_child(this._folder);
        column.add_child(actions);

        this._note = wrapLabel('', 'todopet-hint todopet-secondary');
        column.add_child(this._note);
    }

    // The day picker's menu: drawn over the page, in a layer of its own (OverlayLayer), while it is open.
    _buildMenu() {
        this._menuItems = [];
        this._menuList = box({vertical: true, styleClass: 'todopet-day-list'});
        this._menu = new St.ScrollView({
            style_class: 'todopet-day-menu',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            visible: false,
            child: this._menuList,
        });
        this._layer = new OverlayLayer();
        this._layer.add_child(this._menu);
        this.actor.add_child(this._layer);
    }

    _fillMenu(choices) {
        this._menuList.destroy_all_children();
        this._menuItems = [];
        for (const choice of choices) {
            const content = box({styleClass: 'todopet-day-item-box'});
            const mark = new St.Icon({icon_name: 'object-select-symbolic', style_class: 'todopet-day-mark'});
            mark.opacity = choice.key === this._day ? 255 : 0;
            content.add_child(mark);
            content.add_child(label(choice.label, 'todopet-callout'));
            const item = new St.Button({child: content, style_class: 'todopet-day-item', can_focus: true, x_expand: true});
            item.connect('clicked', () => this._selectDay(choice.key));
            item.todopetDay = choice.key;
            this._menuList.add_child(item);
            this._menuItems.push(item);
        }
    }

    // --- Day menu ---

    _toggleMenu() {
        if (this._menuOpen)
            this._closeMenu();
        else
            this._openMenu();
    }

    _openMenu() {
        if (this._menuOpen || !this._model)
            return;
        this._menuOpen = true;
        this._shell.tooltips.hide();
        this._fillMenu(this._model.days);
        this._menu.visible = true;
        // Under the day button, its right edge on the button's.
        const [rootX, rootY] = this.actor.get_transformed_position();
        const [x, y] = this._dayButton.get_transformed_position();
        const [width, height] = this._dayButton.get_transformed_size();
        const [, menuWidth] = this._menu.get_preferred_width(-1);
        this._menu.set_position(Math.round(x - rootX + width - menuWidth), Math.round(y - rootY + height + 2));
        this._loadDays();
    }

    _closeMenu() {
        if (!this._menuOpen)
            return;
        this._menuOpen = false;
        this._menu.visible = false;
        this._menuList.destroy_all_children();
        this._menuItems = [];
    }

    // A press outside the open menu closes it and is used up; one on the day button leaves its own click to toggle.
    _onCapturedEvent(event) {
        const type = event.type();
        if (!this._menuOpen || (type !== Clutter.EventType.BUTTON_PRESS && type !== Clutter.EventType.TOUCH_BEGIN))
            return Clutter.EVENT_PROPAGATE;
        const target = global.stage.get_event_actor(event);
        if (this._menu.contains(target) || this._dayButton.contains(target))
            return Clutter.EVENT_PROPAGATE;
        this._closeMenu();
        return Clutter.EVENT_STOP;
    }

    _selectDay(key) {
        this._closeMenu();
        if (key === this._day)
            return;
        this._day = key;
        this._copied = false;
        this._loadEntries();
    }

    // --- Entries ---

    _onBrainChanged() {
        // Today's diary grows while the page is open.
        if (this._day === dayKey(new Date()))
            this._loadEntries();
    }

    // The entries of the shown day. Today comes from the diary's memory at once; another day is read from its file.
    _loadEntries() {
        const diary = this._brain?.diary;
        if (!diary)
            return;
        const seq = ++this._seq;
        const day = this._day;
        if (day === dayKey(new Date())) {
            this._entries = diary.today;
            this._loading = null;
            this._apply();
            return;
        }
        this._loading = diary.load(day).catch(e => {
            this._report(e);
            return [];
        }).then(entries => {
            if (this._disposed || seq !== this._seq)
                return;
            this._entries = entries;
            this._apply();
        });
    }

    // The days that have a file, for the picker.
    _loadDays() {
        const diary = this._brain?.diary;
        if (!diary)
            return;
        diary.days().then(days => {
            if (this._disposed)
                return;
            this._days = days;
            this._apply();
            if (this._menuOpen)
                this._fillMenu(this._model.days);
        }, e => this._report(e));
    }

    // --- Showing ---

    _apply() {
        if (this._disposed)
            return;
        const today = dayKey(new Date());
        const folder = this._brain?.diary?.folder ?? null;
        const sig = `${entriesSignature(this._entries, this._filter, this._day)}|${this._copied}|${folder}|${this._days.join()}|${today}`;
        if (sig === this._sig)
            return;
        this._sig = sig;
        const m = diaryModel({
            entries: this._entries, day: this._day, today, days: this._days, filter: this._filter, copied: this._copied, folder,
        });
        this._model = m;

        this._title.text = m.title;
        this._dayLabel.text = m.dayLabel;
        this._dayButton.accessible_name = m.dayLabel;
        this._summary.text = m.summary;
        this._filterControl.relabel(m.filters);
        this._filterControl.select(m.filter);
        this._fillList(m);
        this._copy.textLabel.text = m.copy.label;
        this._folder.visible = m.folder !== null;
        if (m.folder)
            this._folder.textLabel.text = m.folder.label;
        this._note.text = m.note;
        this._app.board?.relayout();
    }

    _fillList(m) {
        this._shell.tooltips.hide();
        this._list.destroy_all_children();
        this._emptyLabel = null;
        if (m.empty) {
            this._emptyLabel = wrapLabel(m.empty, 'todopet-callout todopet-secondary todopet-diary-empty');
            this._list.add_child(this._emptyLabel);
        }
        for (const row of m.rows) {
            const line = box({styleClass: 'todopet-diary-row', x_expand: true});
            const tone = row.quiet ? ' todopet-secondary' : '';
            line.add_child(label(row.time, 'todopet-caption todopet-secondary todopet-tnum todopet-diary-time', {y_align: Clutter.ActorAlign.START}));
            line.add_child(label(row.icon, 'todopet-caption todopet-diary-icon', {y_align: Clutter.ActorAlign.START}));
            line.add_child(wrapLabel(row.text, `todopet-caption${tone}`));
            line.todopetText = row.text;
            this._list.add_child(line);
        }
        if (m.hiddenNote)
            this._list.add_child(wrapLabel(m.hiddenNote, 'todopet-caption todopet-secondary'));
    }

    // --- Actions ---

    // Swift: the whole day (not only what the filter shows) goes to the pasteboard.
    _copyDay() {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, PetLog.exportText(this._entries, this._day));
        this._copied = true;
        this._apply();
    }

    // Opens the diary's folder in the file manager. The board closes (while it is open nothing else on screen can be
    // used), on the next idle: this runs inside the button's own click.
    _openFolder() {
        const uri = folderURI(this._brain?.diary?.folder);
        if (!uri)
            return;
        this._app.openFolder?.(uri);
        if (this._closeSource === 0) {
            this._closeSource = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._closeSource = 0;
                this._app.board?.close();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _guard(fn) {
        try {
            fn();
        } catch (e) {
            this._report(e);
        }
    }

    _report(e) {
        if (!this._failed)
            console.error(`TodoPet: the diary failed: ${e?.stack ?? e}`);
        this._failed = true;
    }
}

// The board's page builder.
export function build(app, onBack) {
    const view = new DiaryView(app, onBack);
    const actor = view.actor;
    actor.view = view;
    actor.dispose = () => view.dispose();
    actor.handleEscape = () => view.handleEscape();
    return actor;
}
