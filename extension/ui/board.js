// The task board that opens when you click the pet: port of BoardView, FrogCard, TaskRow, AddTaskRow,
// TokenSetupView and BoardController in BoardView.swift, CalendarCard in PlanningViews.swift and LifeBar in
// LifeViews.swift. What it shows comes from boardModel() (ui/boardLogic.js); this file only draws it and wires the
// buttons to the brain.
//
//   new Board(app)            reads app.brain, app.prefs, app.pet, app.calendar; calls app.updatePause()
//   open({focusAdd = false})  next to the pet (placeBoard), modal (Main.pushModal), takes the bubble away and asks
//                             for a sync (Swift: AppDelegate.openBoard); focusAdd puts the key focus in "Add a task"
//   close(), toggle(), isOpen, refresh() (re-render soon; App calls it on every brain change), destroy()
//   handleKey(keyval) -> bool Escape closes it. A press outside the board closes it too.
//   showPage(kind, arg), closePage()   the split view, the wardrobe and the diary (ui/splitView.js, ui/wardrobe.js,
//                             ui/diary.js) in place of the task list. A page is `board.pages[kind](app, onBack, arg)`,
//                             an St.Widget that may carry dispose() (called before it is destroyed) and handleEscape()
//                             (called first on Escape; true when it used the key), and setScrolling(on) when its content
//                             is in a scroll view (the board turns it on only when the page is taller than the screen
//                             allows). A page that changes size calls relayout(). The split view takes the task as `arg`.
//
// Layout, top to bottom (as docs/board-light.png): header (little pet, mood, the day's dots, the reason with its
// breakdown on hover, the Todoist streak), life bar, then either the token setup or: demo note, "only N/3 planned",
// the add row, the frog, the calendar card, the task list (overdue, today, done today; it scrolls past 220 px), an
// error; and the footer (focus, last sync, refresh, Todoist, diary, settings).
//
// Parts are rebuilt only when their data changed (a JSON signature per section), at most 10 times a second. The add
// row and the token setup are built once, so typing is never interrupted by a re-render.
// While open the board holds one modal grab; close() and destroy() give it back exactly once.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Spinner} from 'resource:///org/gnome/shell/ui/animation.js';

import {L, getLang} from '../core/l10n.js';
import {insideRect} from './bubbleLogic.js';
import {
    BOARD, addPlaceholder, boardModel, dueChoices, hotkeyLabel, listHeight, placeBoard, priorityChoices,
} from './boardLogic.js';
import {build as buildDiary} from './diary.js';
import {build as buildSplit} from './splitView.js';
import {build as buildWardrobe} from './wardrobe.js';
import {
    MiniPet, ProgressBar, Segmented, Tooltips, box, divider, iconButton, label, linkButton, pillButton, priorityCheck,
    sectionHeader, setSensitive, spacer, wrapLabel,
} from './widgets.js';

const FADE_IN_MS = 120;

const isDark = () => St.Settings.get().color_scheme === St.SystemColorScheme.PREFER_DARK;

// The button of the pet's speech bubble (ui/bubble.js, actor name 'todopet-bubble') that `actor` belongs to, or null.
function bubbleButtonAt(actor) {
    let button = null;
    for (let a = actor; a; a = a.get_parent()) {
        if (!button && a instanceof St.Button)
            button = a;
        if (a.name === 'todopet-bubble')
            return button;
    }
    return null;
}

// Icons for the details under a task title (Swift: clock, calendar, repeat).
const META_ICONS = Object.freeze({
    time: 'preferences-system-time-symbolic',
    ago: 'x-office-calendar-symbolic',
    repeat: 'media-playlist-repeat-symbolic',
});

export class Board {
    constructor(app) {
        this._app = app;
        this._open = false;
        this._grab = null;
        this._inChrome = false;
        this._renderId = 0;
        this._rendering = false;
        this._signals = []; // on objects that outlive the board
        this._openSignals = []; // only while it is open
        this._sigs = new Map(); // section -> JSON of what it shows
        this._view = null; // 'tasks' | 'setup' | 'page'
        this._confirmId = null;
        this._showDone = false;
        this._page = null; // {kind, arg, actor}
        this._due = 'today';
        this._priority = 1; // Swift: @State priority = 1 (P4)
        this._adding = false;
        this._connecting = false;
        this._lang = getLang();
        this._errors = new Set();
        this._placement = null;
        this._size = {width: 0, height: 0};
        // (app, onBack, arg) -> St.Widget. A kind set to null has no page: its button stays dimmed.
        this.pages = {split: buildSplit, wardrobe: buildWardrobe, diary: buildDiary};
        this.model = null;

        this._themeContext = St.ThemeContext.get_for_stage(global.stage);
        this._root = new St.Widget({
            name: 'todopet-board',
            style_class: 'todopet-board',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            opacity: 0,
        });
        this._root.connect('captured-event', (_actor, event) => this._onCapturedEvent(event));
        this._root.connect('destroy', () => this._onRootDestroyed());
        this._column = box({vertical: true, styleClass: 'todopet-board-column', x_expand: true, y_expand: true});
        this._root.add_child(this._column);
        this._tooltips = new Tooltips(this._root);
        this._buildColumn();

        this._connect(St.Settings.get(), 'notify::color-scheme', () => this._applyScheme());
        this._applyScheme();
    }

    get isOpen() {
        return this._open;
    }

    get actor() {
        return this._root;
    }

    // --- For the dev scenes ---

    get frame() {
        const p = this._placement;
        return p ? {x: p.x, y: p.y, width: this._size.width, height: this._size.height} : null;
    }

    get side() {
        return this._placement?.side ?? null;
    }

    get addEntry() {
        return this._entry;
    }

    get tokenEntry() {
        return this._tokenEntry;
    }

    get reasonLabel() {
        return this._reasonLabel ?? null;
    }

    get tooltip() {
        return this._tooltips.label;
    }

    get confirmButtons() {
        return this._confirmButtons ?? null;
    }

    // The page now shown (its actor, with `view` for the scenes), or null.
    get page() {
        return this._page?.actor ?? null;
    }

    get pageKind() {
        return this._page?.kind ?? null;
    }

    get wardrobeButton() {
        return this._wardrobeButton ?? null;
    }

    get diaryButton() {
        return this._diaryButton ?? null;
    }

    get view() {
        return this._view;
    }

    // The parts of the task view on screen, top to bottom.
    sections() {
        const names = new Map([
            [this._demoSlot, 'demo'], [this._nagSlot, 'nag'], [this._addRow, 'add'], [this._frogSlot, 'frog'],
            [this._calendarSlot, 'calendar'], [this._scroll, 'list'], [this._errorSlot, 'error'],
        ]);
        const head = ['header', ...this._lifeSlot.visible ? ['life'] : []];
        if (this._view !== 'tasks')
            return [...head, this._view];
        return [...head, ...this._content.get_children().filter(c => c.visible).map(c => names.get(c))];
    }

    // The section titles and task titles of the list, in order.
    listText() {
        return (this.model?.lists ? [
            ...this.model.lists.overdue ? [this.model.lists.overdue.title, ...this.model.lists.overdue.rows.map(r => r.title)] : [],
            this.model.lists.today.title, ...this.model.lists.today.rows.map(r => r.title),
        ] : []);
    }

    // --- Opening and closing ---

    open({focusAdd = false} = {}) {
        const brain = this._app.brain;
        if (!this._root || !brain)
            return;
        if (!this._open) {
            // Swift: openBoard takes a bubble away first; a new one waits unless it is urgent (App._onBubble).
            if (brain.bubble)
                brain.dismissBubble();
            this._open = true;
            this._root.opacity = 0;
            Main.layoutManager.addTopChrome(this._root);
            this._inChrome = true;
            this._sigs.clear();
            this._guard('render', () => this._render());
            this._grab = Main.pushModal(this._root, {actionMode: Shell.ActionMode.POPUP});
            this._miniPet.start();
            this._connectWhileOpen();
            this._root.ease({opacity: 255, duration: FADE_IN_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            this._app.updatePause?.();
            brain.refreshSoon();
        }
        if (focusAdd && this._view === 'tasks')
            this._entry.grab_key_focus();
    }

    close() {
        if (!this._open)
            return;
        this._open = false;
        this._cancelRender();
        this._tooltips.hide();
        this._miniPet?.stop();
        for (const [object, id] of this._openSignals)
            object.disconnect(id);
        this._openSignals = [];
        this._popModal();
        if (this._root) {
            this._root.remove_all_transitions();
            if (this._inChrome)
                Main.layoutManager.removeChrome(this._root);
        }
        this._inChrome = false;
        this._app.bubble?.avoid(null);
        // Swift: popoverDidClose drops the split view, the wardrobe and the diary.
        this._destroyPage();
        this._confirmId = null;
        this._app.updatePause?.();
    }

    toggle() {
        if (this._open)
            this.close();
        else
            this.open();
    }

    // Escape takes away what a page has open (the diary's day menu, the split view's delete question) or else closes
    // the board. Returns whether the key was used.
    handleKey(keyval) {
        if (keyval === Clutter.KEY_Escape && this._open) {
            if (this._page?.actor.handleEscape?.())
                return true;
            this.close();
            return true;
        }
        return false;
    }

    // The brain or a setting changed: draw again soon (at most every 100 ms), if the board is open.
    refresh() {
        if (!this._open || this._renderId !== 0)
            return;
        const since = (GLib.get_monotonic_time() - (this._lastRender ?? 0)) / 1000;
        this._renderId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(0, Math.round(BOARD.renderMs - since)), () => {
            this._renderId = 0;
            this._guard('render', () => this._render());
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        if (!this._root)
            return;
        this.close();
        this._destroyPage();
        this._disconnectAll();
        const root = this._root;
        const parked = [this._content, this._setup].filter(actor => actor && !actor.get_parent());
        this._tooltips.destroy();
        this._root = null;
        root.destroy();
        for (const actor of parked)
            actor.destroy();
    }

    // --- Pages (Task 20) ---

    // Shows the split view, the wardrobe or the diary in place of the task list. Returns false when that page does
    // not exist yet.
    showPage(kind, arg = null) {
        const build = this.pages[kind];
        if (!build || !this._root)
            return false;
        this._destroyPage();
        let actor;
        try {
            actor = build(this._app, () => this.closePage(), arg);
        } catch (e) {
            this._logOnce(`page ${kind}`, e);
            return false;
        }
        this._page = {kind, arg, actor};
        this._renderNow();
        return true;
    }

    closePage() {
        this._destroyPage();
        this._renderNow();
    }

    _togglePage(kind) {
        if (this._page?.kind === kind)
            this.closePage();
        else
            this.showPage(kind);
    }

    // A page changed size (steps added, a message shown): measure the board and put it back next to the pet.
    relayout() {
        if (this._open && this._root)
            this._guard('layout', () => this._layout());
    }

    _destroyPage() {
        const page = this._page;
        this._page = null;
        if (!page)
            return;
        if (this._view === 'page')
            this._view = null;
        // The page stops its own timers and listeners first: a `destroy` handler would run during garbage collection.
        this._guard(`closing the ${page.kind} page`, () => page.actor?.dispose?.());
        page.actor?.destroy();
    }

    // Asks to confirm deleting the task with this id (null: stop asking). Swift starts the row in this state for
    // snapshots; the dev scenes do the same.
    confirmDelete(id) {
        this._confirmId = id;
        this._renderNow();
    }

    // --- Building ---

    _buildColumn() {
        this._miniPet = new MiniPet({intervalMs: BOARD.miniPetMs});
        const header = box({styleClass: 'todopet-board-header'});
        header.add_child(this._miniPet.actor);
        this._headerText = box({vertical: true, styleClass: 'todopet-board-header-text', y_align: Clutter.ActorAlign.CENTER});
        header.add_child(this._headerText);
        header.add_child(spacer());
        this._streakSlot = box({vertical: true, styleClass: 'todopet-streak', y_align: Clutter.ActorAlign.CENTER, reactive: true});
        this._tooltips.attach(this._streakSlot, L('Chuỗi ngày đạt mục tiêu trên Todoist', 'Your Todoist daily goal streak'));
        header.add_child(this._streakSlot);
        this._column.add_child(header);

        this._lifeSlot = box({vertical: true, styleClass: 'todopet-life'});
        this._column.add_child(this._lifeSlot);
        this._column.add_child(divider());
        this._body = box({vertical: true, x_expand: true});
        this._column.add_child(this._body);
        this._column.add_child(divider());
        this._footerSlot = box({styleClass: 'todopet-board-footer'});
        this._column.add_child(this._footerSlot);

        this._content = this._buildContent();
        this._setup = this._buildSetup();
        this._view = null;
    }

    // The language changed: everything is built again in the new one (what was typed stays).
    _rebuildAll() {
        const added = this._entry?.get_text() ?? '';
        const token = this._tokenEntry?.get_text() ?? '';
        this._tooltips.hide();
        const running = this._open;
        this._miniPet?.stop();
        for (const actor of [this._content, this._setup]) {
            if (actor && !actor.get_parent())
                actor.destroy();
        }
        if (this._page && this._page.actor.get_parent())
            this._page.actor.get_parent().remove_child(this._page.actor);
        this._column.destroy_all_children();
        this._sigs.clear();
        this._lang = getLang();
        this._buildColumn();
        this._entry.set_text(added);
        this._tokenEntry.set_text(token);
        if (running)
            this._miniPet.start();
    }

    _buildContent() {
        const content = box({vertical: true, styleClass: 'todopet-board-content'});
        this._demoSlot = box({styleClass: 'todopet-demo'});
        this._nagSlot = box({styleClass: 'todopet-nag'});
        this._addRow = this._buildAddRow();
        this._frogSlot = box({styleClass: 'todopet-frog'});
        this._calendarSlot = box({vertical: true, styleClass: 'todopet-calendar'});
        this._list = box({vertical: true, styleClass: 'todopet-list'});
        this._scroll = new St.ScrollView({
            style_class: 'todopet-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            child: this._list,
        });
        this._errorSlot = box({vertical: true});
        for (const actor of [this._demoSlot, this._nagSlot, this._addRow, this._frogSlot, this._calendarSlot,
            this._scroll, this._errorSlot])
            content.add_child(actor);
        return content;
    }

    // Swift: AddTaskRow. The field, the + button, when it is due, its priority and the board's shortcut.
    _buildAddRow() {
        const row = box({vertical: true, styleClass: 'todopet-add'});
        const top = box({styleClass: 'todopet-add-top'});
        this._entry = new St.Entry({
            style_class: 'todopet-entry',
            hint_text: addPlaceholder(this._due),
            can_focus: true,
            x_expand: true,
        });
        this._entry.clutter_text.connect('activate', () => this._save());
        this._entry.clutter_text.connect('text-changed', () => this._updateAddButton());
        this._addButton = iconButton('list-add-symbolic', () => this._save(), {
            accessibleName: L('Thêm việc', 'Add a task'), styleClass: 'todopet-add-button',
        });
        top.add_child(this._entry);
        top.add_child(this._addButton);
        row.add_child(top);

        this._dueControl = new Segmented(dueChoices(), this._due, id => this._setDue(id), {styleClass: 'todopet-due'});
        row.add_child(this._dueControl.actor);

        const bottom = box({styleClass: 'todopet-add-bottom'});
        const priorities = priorityChoices().map(c => ({id: c.value, label: c.label}));
        this._priorityControl = new Segmented(priorities, this._priority, value => {
            this._priority = value;
        }, {styleClass: 'todopet-priority'});
        bottom.add_child(this._priorityControl.actor);
        bottom.add_child(spacer());
        this._hotkeyHint = label(hotkeyLabel(this._app.prefs?.boardHotkey), 'todopet-hint todopet-secondary', {reactive: true});
        this._tooltips.attach(this._hotkeyHint, L('Phím tắt mở bảng việc từ bất kỳ đâu', 'Global shortcut to open this board'));
        bottom.add_child(this._hotkeyHint);
        row.add_child(bottom);
        this._setDue(this._due);
        this._updateAddButton();
        return row;
    }

    // Swift: TokenSetupView.
    _buildSetup() {
        const setup = box({vertical: true, styleClass: 'todopet-setup'});
        const langRow = box({styleClass: 'todopet-setup-lang'});
        langRow.add_child(label(L('Ngôn ngữ', 'Language'), 'todopet-callout'));
        const langs = new Segmented([{id: 'en', label: 'English'}, {id: 'vi', label: 'Tiếng Việt'}], getLang(),
            id => this._app.settings?.set_string('lang', id), {styleClass: 'todopet-lang'});
        langs.actor.x_expand = true;
        langRow.add_child(langs.actor);
        setup.add_child(langRow);

        setup.add_child(label(L('Kết nối Todoist', 'Connect Todoist'), 'todopet-headline'));
        setup.add_child(wrapLabel(L(
            'Mở Todoist → Cài đặt → Tích hợp → Developer, sao chép “API token” rồi dán vào đây. Token được lưu an toàn trong keyring của máy.',
            'Open Todoist → Settings → Integrations → Developer, copy the “API token” and paste it here. It is stored safely in your keyring.'),
        'todopet-callout todopet-secondary'));
        const link = linkButton(L('Mở trang lấy token ↗', 'Open the token page ↗'), () => this._openURL(BOARD.tokenURL),
            {styleClass: 'todopet-callout'});
        link.x_align = Clutter.ActorAlign.START;
        setup.add_child(link);

        this._tokenEntry = new St.PasswordEntry({
            style_class: 'todopet-entry',
            hint_text: 'API token',
            can_focus: true,
            x_expand: true,
        });
        this._tokenEntry.clutter_text.connect('activate', () => this._connectToken());
        this._tokenEntry.clutter_text.connect('text-changed', () => this._updateConnectButton());
        setup.add_child(this._tokenEntry);

        const buttons = box({styleClass: 'todopet-setup-buttons'});
        this._connectButton = pillButton(L('Lưu & kết nối', 'Save & connect'), () => this._connectToken(), {primary: true});
        buttons.add_child(this._connectButton);
        buttons.add_child(pillButton(L('Xem thử (demo)', 'Try demo'), () => this._app.brain?.useDemo()));
        setup.add_child(buttons);
        this._setupError = box({vertical: true});
        setup.add_child(this._setupError);
        this._updateConnectButton();
        return setup;
    }

    // --- Rendering ---

    _renderNow() {
        this._cancelRender();
        if (this._open)
            this._guard('render', () => this._render());
    }

    _render() {
        const brain = this._app.brain;
        const prefs = this._app.prefs;
        if (!this._root || !brain || !prefs)
            return;
        this._lastRender = GLib.get_monotonic_time();
        this._rendering = true;
        try {
            if (getLang() !== this._lang)
                this._rebuildAll();
            const m = boardModel({
                brain, prefs, now: new Date(), hasJoinLinks: Boolean(this._app.calendar?.hasJoinLinks),
                confirmId: this._confirmId, showDone: this._showDone,
            });
            this.model = m;
            this._miniPet.update(brain.mood, brain.life?.state ?? null);
            this._hotkeyHint.text = hotkeyLabel(prefs.boardHotkey);
            let changed = false;
            changed = this._section('header', m.header, () => this._fillHeader(m.header)) || changed;
            changed = this._section('life', [m.life, Boolean(this.pages.wardrobe)], () => this._fillLife(m.life)) || changed;

            const showPage = this._page && (this._page.kind === 'diary' || m.view === 'tasks');
            const view = showPage ? 'page' : m.view;
            if (view !== this._view) {
                this._showBody(view);
                changed = true;
            }
            if (view === 'tasks') {
                changed = this._section('demo', m.demo, () => this._fillDemo(m.demo)) || changed;
                changed = this._section('nag', m.nag, () => this._fillNag(m.nag)) || changed;
                changed = this._section('frog', m.frog, () => this._fillFrog(m.frog)) || changed;
                changed = this._section('calendar', m.calendar, () => this._fillCalendar(m.calendar)) || changed;
                changed = this._section('lists', [m.lists, Boolean(this.pages.split)], () => this._fillList(m.lists)) || changed;
                changed = this._section('error', m.error, () => this._fillError(this._errorSlot, m.error)) || changed;
            } else if (view === 'setup') {
                changed = this._section('setupError', m.error, () => this._fillError(this._setupError, m.error)) || changed;
            }
            changed = this._section('footer', [m.footer, Boolean(this.pages.diary)], () => this._fillFooter(m.footer)) || changed;
            if (changed)
                this._layout();
        } finally {
            this._rendering = false;
        }
    }

    // Rebuilds one part when what it shows changed. Returns whether it did.
    _section(key, data, fill) {
        const sig = JSON.stringify(data) ?? 'null';
        if (this._sigs.get(key) === sig)
            return false;
        this._sigs.set(key, sig);
        // The widget a tooltip belongs to may be about to go.
        this._tooltips.hide();
        fill();
        return true;
    }

    // Puts the task view, the token setup or a page into the body (the others are kept, not destroyed).
    _showBody(view) {
        for (const child of this._body.get_children())
            this._body.remove_child(child);
        const actor = view === 'page' ? this._page.actor : view === 'setup' ? this._setup : this._content;
        this._body.add_child(actor);
        this._view = view;
    }

    // Swift: BoardView.header.
    _fillHeader(h) {
        this._headerText.destroy_all_children();
        this._headerText.add_child(label(h.title, 'todopet-title'));
        const progress = box({styleClass: 'todopet-day'});
        for (const kind of h.dots)
            progress.add_child(new St.Widget({style_class: `todopet-dot todopet-dot-${kind}`, y_align: Clutter.ActorAlign.CENTER}));
        progress.add_child(label(h.progress, 'todopet-caption todopet-secondary'));
        this._headerText.add_child(progress);
        this._reasonLabel = null;
        if (h.reason) {
            const reason = label(h.reason.label, `todopet-reason ${h.reason.up ? 'todopet-tone-green' : 'todopet-tone-orange'}`,
                {reactive: true});
            this._tooltips.attach(reason, h.breakdown);
            this._headerText.add_child(reason);
            this._reasonLabel = reason;
        }

        this._streakSlot.destroy_all_children();
        this._streakSlot.visible = h.streak !== null;
        if (h.streak) {
            this._streakSlot.add_child(label(h.streak.value, 'todopet-streak-value', {x_align: Clutter.ActorAlign.CENTER}));
            this._streakSlot.add_child(label(h.streak.label, 'todopet-streak-label todopet-secondary', {x_align: Clutter.ActorAlign.CENTER}));
        }
    }

    // Swift: LifeBar.
    _fillLife(l) {
        const slot = this._lifeSlot;
        slot.destroy_all_children();
        slot.visible = l !== null;
        if (!l)
            return;
        const first = box({styleClass: 'todopet-life-row'});
        const satiety = box({styleClass: 'todopet-life-item', reactive: true});
        satiety.add_child(label('🍙', 'todopet-emoji'));
        const food = new ProgressBar({style_class: 'todopet-progress todopet-progress-short'});
        food.setValue(l.satiety.fraction, l.satiety.tone);
        satiety.add_child(food);
        satiety.add_child(label(l.satiety.text, 'todopet-caption todopet-secondary todopet-tnum'));
        this._tooltips.attach(satiety, L('Độ no: mỗi việc xong +25%, đói dần trong giờ làm',
            'Fullness: +25% per finished task, drops during work hours'));
        first.add_child(satiety);
        if (l.dirt) {
            const dirt = label(l.dirt, 'todopet-caption todopet-tone-brown', {reactive: true});
            this._tooltips.attach(dirt, L('Bẩn sau những ngày không làm gì; mỗi việc xong tắm sạch 1 lớp',
                'Dirty after lazy days; each finished task washes one layer off'));
            first.add_child(dirt);
        }
        if (l.streak) {
            const streak = label(l.streak, 'todopet-caption todopet-bold', {reactive: true});
            this._tooltips.attach(streak, L('Chuỗi ngày đạt mục tiêu', 'Days in a row hitting your target'));
            first.add_child(streak);
        }
        first.add_child(spacer());
        const wardrobe = new St.Button({label: l.wardrobe, style_class: 'todopet-plain-button todopet-caption', can_focus: true});
        wardrobe.connect('clicked', () => this.showPage('wardrobe'));
        setSensitive(wardrobe, Boolean(this.pages.wardrobe));
        this._wardrobeButton = wardrobe;
        first.add_child(wardrobe);
        slot.add_child(first);

        const second = box({styleClass: 'todopet-life-row todopet-life-stage'});
        second.add_child(label(l.stage.label, 'todopet-caption todopet-bold'));
        if (l.stage.fraction !== null) {
            const xp = new ProgressBar({x_expand: true});
            xp.setValue(l.stage.fraction, 'yellow');
            second.add_child(xp);
            second.add_child(label(l.stage.xp, 'todopet-caption todopet-secondary todopet-tnum'));
        } else {
            second.add_child(label(l.stage.xp, 'todopet-caption todopet-secondary todopet-tnum'));
            second.add_child(spacer());
        }
        slot.add_child(second);
        if (l.distraction)
            slot.add_child(wrapLabel(l.distraction, 'todopet-caption todopet-bold todopet-tone-orange'));
    }

    _fillDemo(text) {
        this._demoSlot.destroy_all_children();
        this._demoSlot.visible = text !== null;
        if (text) {
            this._demoSlot.add_child(label('🎭', 'todopet-demo-icon'));
            this._demoSlot.add_child(label(text, 'todopet-caption todopet-tone-purple'));
        }
    }

    _fillNag(text) {
        this._nagSlot.destroy_all_children();
        this._nagSlot.visible = text !== null;
        if (text) {
            this._nagSlot.add_child(label('📝', 'todopet-nag-icon', {y_align: Clutter.ActorAlign.START}));
            this._nagSlot.add_child(wrapLabel(text, 'todopet-callout'));
        }
    }

    // Swift: FrogCard.
    _fillFrog(frog) {
        const slot = this._frogSlot;
        slot.destroy_all_children();
        slot.visible = frog !== null;
        if (!frog)
            return;
        slot.add_child(label('🐸', 'todopet-frog-icon'));
        const text = box({vertical: true, styleClass: 'todopet-frog-text', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        text.add_child(label(frog.label, 'todopet-caption todopet-bold todopet-secondary'));
        text.add_child(wrapLabel(frog.title, 'todopet-frog-title'));
        slot.add_child(text);
        if (frog.focus)
            slot.add_child(pillButton(frog.focus, () => this._app.brain?.startFocus(frog.task), {primary: true, styleClass: 'todopet-pill-big'}));
    }

    // Swift: CalendarCard (GNOME needs no calendar permission, so only its "granted" state is ported).
    _fillCalendar(c) {
        const slot = this._calendarSlot;
        slot.destroy_all_children();
        slot.visible = c !== null;
        if (!c)
            return;
        if (c.meeting) {
            const row = box({styleClass: 'todopet-meeting'});
            row.add_child(label('📅', 'todopet-calendar-icon'));
            const text = box({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            text.add_child(label(c.meeting.label, 'todopet-caption todopet-bold todopet-secondary'));
            text.add_child(label(c.meeting.title, 'todopet-callout'));
            row.add_child(text);
            if (c.meeting.joinURL) {
                const url = c.meeting.joinURL;
                row.add_child(pillButton(L('Vào họp ↗', 'Join ↗'), () => this._openURL(url), {primary: true, styleClass: 'todopet-pill-big'}));
            }
            slot.add_child(row);
        } else {
            slot.add_child(label(c.none, 'todopet-callout'));
        }
        slot.add_child(label(c.summary, 'todopet-caption todopet-secondary'));
        if (c.blocks.length > 0) {
            slot.add_child(label(c.blocksTitle, 'todopet-caption todopet-bold todopet-secondary todopet-blocks-title'));
            for (const block of c.blocks) {
                const row = box({styleClass: 'todopet-block'});
                row.add_child(label(block.time, 'todopet-caption todopet-secondary todopet-tnum'));
                row.add_child(label(block.title, 'todopet-callout', {x_expand: true}));
                const set = linkButton(L('Đặt giờ', 'Set time'), () => this._app.brain?.schedule(block.slot), {styleClass: 'todopet-caption'});
                this._tooltips.attach(set, L('Đặt giờ này cho việc trong Todoist', 'Give the task this time in Todoist'));
                row.add_child(set);
                slot.add_child(row);
            }
        }
    }

    // The overdue tasks, today's, and what is done today (Swift: the ScrollView in BoardView.content).
    _fillList(lists) {
        const brain = this._app.brain;
        const list = this._list;
        this._confirmButtons = null;
        list.destroy_all_children();
        if (lists.overdue) {
            const moveAll = lists.overdue.moveAll
                ? linkButton(lists.overdue.moveAll, () => brain?.pullOverdueToToday(), {styleClass: 'todopet-caption'})
                : null;
            list.add_child(sectionHeader(lists.overdue.title, 'todopet-tone-red', moveAll));
            for (const row of lists.overdue.rows)
                list.add_child(this._taskRow(row));
        }
        list.add_child(sectionHeader(lists.today.title, 'todopet-primary'));
        if (lists.today.empty)
            list.add_child(label(lists.today.empty, 'todopet-callout todopet-secondary todopet-empty'));
        for (const row of lists.today.rows)
            list.add_child(this._taskRow(row));
        if (lists.done) {
            const toggle = new St.Button({style_class: 'todopet-done-toggle', can_focus: true, x_align: Clutter.ActorAlign.START});
            const content = box({styleClass: 'todopet-done-toggle-box'});
            content.add_child(new St.Icon({
                icon_name: lists.done.open ? 'pan-down-symbolic' : 'pan-end-symbolic', style_class: 'todopet-done-arrow',
            }));
            content.add_child(label(lists.done.label, 'todopet-caption todopet-bold todopet-tone-green'));
            toggle.child = content;
            toggle.connect('clicked', () => {
                this._showDone = !this._showDone;
                this._renderNow();
            });
            list.add_child(toggle);
            if (lists.done.open) {
                for (const title of lists.done.titles) {
                    const row = box({styleClass: 'todopet-done-row'});
                    row.add_child(new St.Icon({icon_name: 'object-select-symbolic', style_class: 'todopet-done-mark'}));
                    const text = label('', 'todopet-callout todopet-secondary', {x_expand: true});
                    text.clutter_text.set_markup(`<s>${GLib.markup_escape_text(title, -1)}</s>`);
                    row.add_child(text);
                    list.add_child(row);
                }
            }
        }
    }

    // Swift: TaskRow. The check finishes the task; ▶ focus, ✂ split, move and delete show while the pointer is on it.
    _taskRow(r) {
        const brain = this._app.brain;
        const outer = box({
            vertical: true,
            styleClass: `todopet-task${r.confirm ? ' todopet-task-confirming' : ''}`,
            reactive: true,
            track_hover: true,
            x_expand: true,
        });
        const line = box({styleClass: 'todopet-task-line'});
        const check = priorityCheck(r.priority, () => brain?.complete(r.task));
        this._tooltips.attach(check, L('Hoàn thành', 'Complete'));
        line.add_child(check);
        const text = box({vertical: true, styleClass: 'todopet-task-text', x_expand: true});
        text.add_child(wrapLabel(r.title, 'todopet-task-title'));
        if (r.meta.length > 0) {
            const meta = box({styleClass: 'todopet-task-meta'});
            for (const item of r.meta)
                meta.add_child(this._metaItem(item));
            text.add_child(meta);
        }
        line.add_child(text);

        const actions = box({styleClass: 'todopet-task-actions', visible: false, y_align: Clutter.ActorAlign.START});
        const action = (icon, tooltip, run, styleClass = '') => {
            const button = iconButton(icon, run, {accessibleName: tooltip, styleClass: `todopet-task-action ${styleClass}`});
            this._tooltips.attach(button, tooltip);
            actions.add_child(button);
            return button;
        };
        action('media-playback-start-symbolic', L('Tập trung vào việc này', 'Focus on this'), () => brain?.startFocus(r.task));
        const split = action('edit-cut-symbolic', L('Chia nhỏ thành các bước', 'Split into small steps'),
            () => brain?.openBreakdown?.(r.task));
        setSensitive(split, Boolean(this.pages.split));
        if (r.move) {
            action(r.overdue ? 'go-bottom-symbolic' : 'go-last-symbolic', r.move.tooltip,
                () => brain?.reschedule(r.task, r.move.due));
        }
        action('user-trash-symbolic', L('Xoá việc', 'Delete task'), () => this.confirmDelete(r.id), 'todopet-danger');
        line.add_child(actions);
        outer.add_child(line);

        if (r.confirm) {
            const confirm = box({styleClass: 'todopet-confirm'});
            confirm.add_child(wrapLabel(r.confirm, 'todopet-caption todopet-tone-red'));
            const cancel = linkButton(L('Huỷ', 'Cancel'), () => this.confirmDelete(null), {styleClass: 'todopet-plain-link'});
            const remove = linkButton(L('Xoá', 'Delete'), () => {
                this._confirmId = null;
                brain?.delete(r.task);
                this._renderNow();
            }, {styleClass: 'todopet-danger-link'});
            // Swift: HStack(alignment: .firstTextBaseline), the buttons level with the question's first line.
            cancel.y_align = Clutter.ActorAlign.START;
            remove.y_align = Clutter.ActorAlign.START;
            confirm.add_child(cancel);
            confirm.add_child(remove);
            outer.add_child(confirm);
            this._confirmButtons = {cancel, remove};
        }

        outer.connect('notify::hover', () => {
            // Rows are rebuilt while the pointer is on them; only a real enter or leave counts.
            if (this._rendering || !outer.mapped)
                return;
            actions.visible = outer.hover;
            check.showCheck(outer.hover);
            // Swift: leaving the row drops its delete question.
            if (!outer.hover && this._confirmId === r.id)
                this.confirmDelete(null);
        });
        return outer;
    }

    _metaItem({kind, text}) {
        const tone = {ago: 'todopet-tone-red', stuck: 'todopet-tone-orange'}[kind] ?? '';
        const item = box({styleClass: `todopet-meta ${tone}`.trim()});
        if (META_ICONS[kind])
            item.add_child(new St.Icon({icon_name: META_ICONS[kind], style_class: 'todopet-meta-icon'}));
        if (text)
            item.add_child(label(text, 'todopet-meta-text'));
        if (kind === 'stuck') {
            item.reactive = true;
            this._tooltips.attach(item, L('Việc này cứ bị dời mãi — thử chia nhỏ (✂️)', 'This keeps getting postponed — try splitting it (✂️)'));
        }
        return item;
    }

    _fillError(slot, text) {
        slot.destroy_all_children();
        slot.visible = text !== null;
        if (text)
            slot.add_child(wrapLabel(text, 'todopet-caption todopet-tone-red'));
    }

    // Swift: BoardView.footer.
    _fillFooter(f) {
        const slot = this._footerSlot;
        const brain = this._app.brain;
        slot.destroy_all_children();
        const focus = iconButton(f.focus.stop ? 'media-playback-stop-symbolic' : 'alarm-symbolic', () => {
            if (f.focus.stop) {
                brain?.stopFocus();
            } else {
                brain?.startFocus(null);
                this.close();
            }
        }, {text: f.focus.label, styleClass: 'todopet-footer-focus'});
        setSensitive(focus, f.focus.enabled);
        slot.add_child(focus);
        slot.add_child(spacer());
        if (f.loading) {
            const spinner = new Spinner(16);
            spinner.y_align = Clutter.ActorAlign.CENTER;
            spinner.play();
            slot.add_child(spinner);
        } else if (f.lastSync) {
            const time = label(f.lastSync, 'todopet-caption todopet-secondary todopet-tnum', {reactive: true});
            this._tooltips.attach(time, L('Lần đồng bộ cuối', 'Last sync'));
            slot.add_child(time);
        }
        const button = (icon, tooltip, run) => {
            const b = iconButton(icon, run, {accessibleName: tooltip, styleClass: 'todopet-footer-button'});
            this._tooltips.attach(b, tooltip);
            slot.add_child(b);
            return b;
        };
        button('view-refresh-symbolic', L('Làm mới', 'Refresh'), () => brain?.refreshSoon());
        button('checkbox-checked-symbolic', L('Mở Todoist', 'Open Todoist'), () => this._openURL(BOARD.todoistURL));
        const diary = button('x-office-document-symbolic',
            L('Nhật ký pet: vì sao pet nhắc, cáu hay im lặng', 'Pet diary: why the pet spoke up, got grumpy or stayed quiet'),
            () => this._togglePage('diary'));
        setSensitive(diary, Boolean(this.pages.diary));
        this._diaryButton = diary;
        button('emblem-system-symbolic', L('Cài đặt', 'Settings'), () => brain?.openSettings?.());
    }

    // --- The add row and the token ---

    _setDue(id) {
        this._due = id;
        this._entry.hint_text = addPlaceholder(id);
        // Todoist's own syntax carries the priority ("p1"), so the picker goes (Swift).
        this._priorityControl.actor.visible = id !== 'smart';
    }

    _updateAddButton() {
        setSensitive(this._addButton, this._entry.get_text().trim() !== '' && !this._adding);
    }

    // Swift: AddTaskRow.save. The field stays put while Todoist answers; it empties when the task was added.
    _save() {
        const brain = this._app.brain;
        const text = this._entry.get_text();
        if (!brain || text.trim() === '' || this._adding)
            return;
        this._adding = true;
        this._entry.clutter_text.editable = false;
        this._updateAddButton();
        const done = added => {
            if (!this._root)
                return;
            this._adding = false;
            this._entry.clutter_text.editable = true;
            if (added)
                this._entry.set_text('');
            this._updateAddButton();
            if (this._open && this._view === 'tasks')
                this._entry.grab_key_focus();
        };
        brain.add(text, this._due, this._priority).then(done, e => {
            this._logOnce('adding a task', e);
            done(false);
        });
    }

    _updateConnectButton() {
        setSensitive(this._connectButton, this._tokenEntry.get_text() !== '' && !this._connecting);
    }

    _connectToken() {
        const brain = this._app.brain;
        const token = this._tokenEntry.get_text();
        if (!brain || token === '' || this._connecting)
            return;
        this._connecting = true;
        this._connectButton.label = L('Đang kết nối…', 'Connecting…');
        this._updateConnectButton();
        const done = ok => {
            if (!this._root)
                return;
            this._connecting = false;
            if (ok)
                this._tokenEntry.set_text('');
            this._connectButton.label = L('Lưu & kết nối', 'Save & connect');
            this._updateConnectButton();
        };
        brain.setToken(token).then(done, e => {
            this._logOnce('connecting Todoist', e);
            done(false);
        });
    }

    // Opens a link in the browser. The board closes: while it is open nothing else on screen can be used.
    _openURL(url) {
        this._app.openURL?.(url);
        this.close();
    }

    // --- Size and position ---

    // Measures the board (the task list at most 220 px, less on a short screen) and puts it next to the pet.
    _layout() {
        if (!this._inChrome || !this._root)
            return;
        const unit = this._themeContext.scale_factor;
        const wa = this._workArea();
        this._root.set_size(-1, -1);
        const [, width] = this._root.get_preferred_width(-1);
        let height;
        if (this._view === 'tasks') {
            // The list's own height, at the width it gets inside the board's border and the content's padding; the
            // rest of the board is measured with the list at 0 px.
            const rootNode = this._root.get_theme_node();
            const inner = width - rootNode.get_border_width(St.Side.LEFT) - rootNode.get_border_width(St.Side.RIGHT) -
                this._content.get_theme_node().get_horizontal_padding();
            const [, natural] = this._list.get_preferred_height(inner);
            this._scroll.set_height(0);
            const [, others] = this._root.get_preferred_height(width);
            const list = Math.round(listHeight({
                natural, others, available: wa.height - 2 * BOARD.margin * unit, unit,
            }));
            this._scroll.set_height(list);
            // Measuring left the scroll view marked for relayout, so its new height alone would not reach the
            // cached heights of the boxes around it.
            this._content.queue_relayout();
            height = others + list;
        } else {
            // A page (or the token setup) taller than the screen gives way: its scroll view takes the difference, and
            // scrolls only then.
            const scroller = this._view === 'page' ? this._page?.actor : null;
            scroller?.setScrolling?.(false);
            [, height] = this._root.get_preferred_height(width);
            const available = wa.height - 2 * BOARD.margin * unit;
            if (height > available)
                scroller?.setScrolling?.(true);
            height = Math.min(height, available);
        }
        this._size = {width: Math.ceil(width), height: Math.ceil(height)};
        this._root.set_size(this._size.width, this._size.height);
        const pet = this._app.pet;
        const petFrame = pet?.visible ? pet.frame : null;
        this._placement = placeBoard({petFrame, size: this._size, workArea: wa, unit});
        this._root.set_position(this._placement.x, this._placement.y);
        // R13: the pet's bubble keeps off the board.
        this._app.bubble?.avoid(this.frame);
    }

    _workArea() {
        const index = Main.layoutManager.primaryIndex;
        if (index < 0)
            return {x: 0, y: 0, width: global.stage.width, height: global.stage.height};
        const area = Main.layoutManager.getWorkAreaForMonitor(index);
        return {x: area.x, y: area.y, width: area.width, height: area.height};
    }

    _applyScheme() {
        if (!this._root)
            return;
        if (isDark())
            this._root.add_style_class_name('todopet-board-dark');
        else
            this._root.remove_style_class_name('todopet-board-dark');
    }

    // --- Events ---

    // The board holds the modal grab: a key goes to handleKey first; a press anywhere outside it closes it and is
    // used up. The pet's bubble is not "outside" (ruling R13; an urgent one shows next to the open board): a press in
    // its rectangle leaves the board open, and one on its buttons presses that button (the grab keeps the press from
    // reaching it).
    _onCapturedEvent(event) {
        const type = event.type();
        if (type === Clutter.EventType.KEY_PRESS)
            return this.handleKey(event.get_key_symbol()) ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        if (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN) {
            const target = global.stage.get_event_actor(event);
            if (this._open && !this._root.contains(target)) {
                const bubbleButton = bubbleButtonAt(target);
                const bubble = this._app.bubble;
                const [x, y] = event.get_coords();
                if (bubbleButton || (bubble?.visible && insideRect(bubble.frame, x, y))) {
                    if (bubbleButton && event.get_button?.() !== Clutter.BUTTON_SECONDARY)
                        bubbleButton.emit('clicked', Clutter.BUTTON_PRIMARY);
                    return Clutter.EVENT_STOP;
                }
                this.close();
                return Clutter.EVENT_STOP;
            }
            this._tooltips.hide();
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _connectWhileOpen() {
        const add = (object, signal, handler) => this._openSignals.push([object, object.connect(signal, handler)]);
        add(global.display, 'workareas-changed', () => this._layout());
        add(this._themeContext, 'notify::scale-factor', () => {
            this._sigs.clear();
            this._renderNow();
        });
    }

    _popModal() {
        const grab = this._grab;
        this._grab = null;
        if (!grab)
            return;
        try {
            Main.popModal(grab);
        } catch (e) {
            this._logOnce('giving the modal grab back', e);
        }
    }

    _cancelRender() {
        if (this._renderId !== 0)
            GLib.source_remove(this._renderId);
        this._renderId = 0;
    }

    _connect(object, signal, handler) {
        this._signals.push([object, object.connect(signal, handler)]);
    }

    _disconnectAll() {
        for (const [object, id] of [...this._signals, ...this._openSignals])
            object.disconnect(id);
        this._signals = [];
        this._openSignals = [];
    }

    // The Shell destroyed the actor (it tears the chrome down on exit): give the grab back, stop timers and signals.
    _onRootDestroyed() {
        if (!this._root)
            return;
        this._open = false;
        this._cancelRender();
        this._popModal();
        this._disconnectAll();
        this._miniPet?.stop();
        this._tooltips.destroy();
        this._inChrome = false;
        this._root = null;
    }

    _guard(what, fn) {
        try {
            fn();
        } catch (e) {
            this._logOnce(what, e);
        }
    }

    _logOnce(what, e) {
        if (this._errors.has(what))
            return;
        this._errors.add(what);
        console.error(`TodoPet: the board's ${what} failed: ${e?.stack ?? e}`);
    }
}
