// Small St building blocks for the task board and its pages (split view, wardrobe, diary): labels, pill and icon
// buttons, the priority check circle, section titles, a progress bar, a segmented control, a check box, the
// header's little pet, tooltips and the shell of a page. Styles live in stylesheet.css under `todopet-`; colors come
// from there, never from here.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';
import {Spinner} from 'resource:///org/gnome/shell/ui/animation.js';

import {decoratePose, defaultPose, drawPet} from '../art/petArt.js';

const VERTICAL = Clutter.Orientation.VERTICAL;

// A one-line label (ellipsized at the end when it does not fit).
export function label(text, styleClass = null, params = {}) {
    return new St.Label({text, style_class: styleClass, y_align: Clutter.ActorAlign.CENTER, ...params});
}

// A label that wraps at words (and inside a word longer than the line); nothing is cut off.
export function wrapLabel(text, styleClass = null, params = {}) {
    const l = new St.Label({text, style_class: styleClass, x_expand: true, ...params});
    l.clutter_text.set({line_wrap: true, line_wrap_mode: Pango.WrapMode.WORD_CHAR, ellipsize: Pango.EllipsizeMode.NONE});
    return l;
}

export function box({vertical = false, styleClass = null, ...params} = {}) {
    return new St.BoxLayout({
        style_class: styleClass,
        orientation: vertical ? VERTICAL : Clutter.Orientation.HORIZONTAL,
        ...params,
    });
}

export const spacer = () => new St.Widget({x_expand: true});

export const divider = () => new St.Widget({style_class: 'todopet-divider', x_expand: true});

// Swift's PillButtonStyle: a capsule, the accent color when `primary`.
export function pillButton(text, onClick, {primary = false, styleClass = ''} = {}) {
    const button = new St.Button({
        label: text,
        style_class: `todopet-pill${primary ? ' todopet-pill-primary' : ''} ${styleClass}`.trim(),
        can_focus: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    button.connect('clicked', () => onClick());
    return button;
}

// A capsule whose text can be replaced by a spinner while something runs (Swift: a ProgressView in the button). The
// button keeps its size: the text stays in place, invisible, under the spinner. setText(text), setBusy(busy).
export function busyPill(onClick, {primary = false, styleClass = ''} = {}) {
    const text = label('', null, {x_align: Clutter.ActorAlign.CENTER});
    const wheel = spinner(14);
    wheel.visible = false;
    wheel.x_expand = true;
    wheel.y_expand = true;
    const content = new St.Widget({layout_manager: new Clutter.BinLayout()});
    content.add_child(text);
    content.add_child(wheel);
    const button = new St.Button({
        child: content,
        style_class: `todopet-pill${primary ? ' todopet-pill-primary' : ''} ${styleClass}`.trim(),
        can_focus: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    button.connect('clicked', () => onClick());
    button.setText = value => {
        text.text = value;
        button.accessible_name = value;
    };
    button.setBusy = busy => {
        text.opacity = busy ? 0 : 255;
        wheel.visible = busy;
    };
    return button;
}

// A capsule with only a symbolic icon in it (Swift: a PillButtonStyle button around an Image).
export function iconPill(iconName, onClick, {accessibleName = '', styleClass = ''} = {}) {
    const button = new St.Button({
        child: new St.Icon({icon_name: iconName, style_class: 'todopet-icon'}),
        style_class: `todopet-pill ${styleClass}`.trim(),
        accessible_name: accessibleName,
        can_focus: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    button.connect('clicked', () => onClick());
    return button;
}

// A small spinning wheel (the Shell's), playing.
export function spinner(size = 14) {
    const wheel = new Spinner(size);
    wheel.y_align = Clutter.ActorAlign.CENTER;
    wheel.x_align = Clutter.ActorAlign.CENTER;
    wheel.play();
    return wheel;
}

// A borderless button with a symbolic icon (Swift: .buttonStyle(.borderless) with an Image), and an optional label.
export function iconButton(iconName, onClick, {text = null, accessibleName = null, styleClass = ''} = {}) {
    const content = box({styleClass: 'todopet-icon-button-box'});
    content.add_child(new St.Icon({icon_name: iconName, style_class: 'todopet-icon', y_align: Clutter.ActorAlign.CENTER}));
    const textLabel = text !== null ? label(text, 'todopet-icon-button-text') : null;
    if (textLabel)
        content.add_child(textLabel);
    const button = new St.Button({
        child: content,
        style_class: `todopet-icon-button ${styleClass}`.trim(),
        accessible_name: accessibleName ?? text ?? '',
        can_focus: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    button.connect('clicked', () => onClick());
    // For a later change of the text (a language change, "Copy" -> "Copied").
    button.textLabel = textLabel;
    return button;
}

// Swift's .buttonStyle(.link): text in the link color.
export function linkButton(text, onClick, {styleClass = ''} = {}) {
    const button = new St.Button({
        label: text,
        style_class: `todopet-link ${styleClass}`.trim(),
        can_focus: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    button.connect('clicked', () => onClick());
    return button;
}

// Turns a button off (it no longer reacts and looks dimmed) or on again.
export function setSensitive(actor, sensitive) {
    actor.reactive = sensitive;
    actor.can_focus = sensitive;
    if (sensitive)
        actor.remove_style_pseudo_class('insensitive');
    else
        actor.add_style_pseudo_class('insensitive');
}

// The round check in front of a task, in its priority's color (Swift: PriorityStyle.color, "circle" and, on hover,
// "checkmark.circle"). showCheck(true) puts the check mark in.
export function priorityCheck(uiPriority, onClick) {
    const mark = new St.Icon({icon_name: 'object-select-symbolic', style_class: 'todopet-check-mark', opacity: 0});
    const button = new St.Button({
        child: mark,
        style_class: `todopet-check todopet-priority-${Math.min(Math.max(uiPriority, 1), 4)}`,
        can_focus: true,
        y_align: Clutter.ActorAlign.START,
    });
    button.connect('clicked', () => onClick());
    button.showCheck = on => {
        mark.opacity = on ? 255 : 0;
    };
    return button;
}

// A section title, "Overdue · 1", with something on the right (Swift: BoardView.sectionTitle).
export function sectionHeader(title, toneClass, trailing = null) {
    const row = box({styleClass: 'todopet-section'});
    row.add_child(label(title, `todopet-section-title ${toneClass}`));
    row.add_child(spacer());
    if (trailing)
        row.add_child(trailing);
    return row;
}

// A thin rounded bar filled to `fraction` (Swift: ProgressView with a tint). The tone is a style class suffix.
export const ProgressBar = GObject.registerClass(
class TodoPetProgressBar extends St.Widget {
    constructor(params = {}) {
        super({style_class: 'todopet-progress', y_align: Clutter.ActorAlign.CENTER, ...params});
        this._fraction = 0;
        this._fill = new St.Widget({style_class: 'todopet-progress-fill'});
        this.add_child(this._fill);
    }

    setValue(fraction, tone) {
        this._fraction = Number.isFinite(fraction) ? Math.min(Math.max(fraction, 0), 1) : 0;
        this._fill.style_class = `todopet-progress-fill todopet-tone-${tone}`;
        this.queue_relayout();
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const content = this.get_theme_node().get_content_box(box);
        const width = Math.round((content.x2 - content.x1) * this._fraction);
        this._fill.allocate(Clutter.ActorBox.new(content.x1, content.y1, content.x1 + width, content.y2));
    }
});

// A row of toggle buttons, one of them selected (Swift: Picker with .pickerStyle(.segmented)).
export class Segmented {
    constructor(choices, selected, onChange, {styleClass = ''} = {}) {
        this._onChange = onChange;
        this._buttons = new Map();
        this.selected = selected;
        this.actor = box({styleClass: `todopet-segmented ${styleClass}`.trim()});
        for (const {id, label: text} of choices) {
            const button = new St.Button({
                label: text,
                style_class: 'todopet-segment',
                toggle_mode: true,
                can_focus: true,
                x_expand: true,
            });
            button.connect('clicked', () => this.select(id, true));
            this._buttons.set(id, button);
            this.actor.add_child(button);
        }
        this.select(selected, false);
    }

    // Selects `id` (the others are released); `notify` tells onChange when the selection changed.
    select(id, notify = false) {
        const changed = id !== this.selected;
        this.selected = id;
        for (const [key, button] of this._buttons)
            button.checked = key === id;
        if (changed && notify)
            this._onChange(id);
    }

    // Puts new labels on the buttons (after a language change).
    relabel(choices) {
        for (const {id, label: text} of choices)
            this._buttons.get(id)?.set_label(text);
    }
}

// A check box with its text (Swift: Toggle). onChange(checked) runs when the user flips it; setChecked() and
// setText() change it from outside without calling onChange.
export class CheckRow {
    constructor(text, checked, onChange) {
        this._mark = new St.Icon({icon_name: 'object-select-symbolic', style_class: 'todopet-checkbox-mark'});
        const indicator = new St.Bin({style_class: 'todopet-checkbox', child: this._mark, y_align: Clutter.ActorAlign.CENTER});
        this._label = label(text, 'todopet-callout');
        const content = box({styleClass: 'todopet-check-row-box'});
        content.add_child(indicator);
        content.add_child(this._label);
        this.actor = new St.Button({
            child: content,
            style_class: 'todopet-check-row',
            toggle_mode: true,
            can_focus: true,
            x_align: Clutter.ActorAlign.START,
            accessible_name: text,
        });
        this.actor.connect('notify::checked', () => {
            this._mark.opacity = this.actor.checked ? 255 : 0;
        });
        this.actor.connect('clicked', () => onChange(this.actor.checked));
        this.setChecked(checked);
    }

    get checked() {
        return this.actor.checked;
    }

    setChecked(checked) {
        this.actor.checked = checked;
        this._mark.opacity = checked ? 255 : 0;
    }

    setText(text) {
        this._label.text = text;
        this.actor.accessible_name = text;
    }
}

// The pet's face in the header (Swift: MiniPet, 54 × 54, redrawn as time passes). start() and stop() run the redraw
// timer (the owner stops it before the actor goes: a `destroy` handler on a child actor would run during garbage
// collection when the shell exits without disabling the extension); update(mood, life) sets what it shows.
export class MiniPet {
    constructor({intervalMs = 100, styleClass = 'todopet-minipet'} = {}) {
        this._mood = 'normal';
        this._life = null;
        this._intervalMs = intervalMs;
        this._timerId = 0;
        this._failed = false;
        this.actor = new St.DrawingArea({style_class: styleClass, y_align: Clutter.ActorAlign.CENTER});
        this.actor.connect('repaint', area => this._paint(area));
    }

    update(mood, life) {
        this._mood = mood;
        this._life = life;
        this.actor.queue_repaint();
    }

    start() {
        if (this._timerId !== 0)
            return;
        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._intervalMs, () => {
            this.actor.queue_repaint();
            return GLib.SOURCE_CONTINUE;
        });
    }

    stop() {
        if (this._timerId !== 0)
            GLib.source_remove(this._timerId);
        this._timerId = 0;
    }

    _paint(area) {
        const cr = area.get_context();
        try {
            const [width, height] = area.get_surface_size();
            let pose = defaultPose(this._mood, GLib.get_monotonic_time() / 1e6);
            if (this._life)
                pose = decoratePose(pose, this._life);
            drawPet(cr, width, height, pose);
        } catch (e) {
            if (!this._failed)
                console.error(`TodoPet: drawing the board's pet failed: ${e?.stack ?? e}`);
            this._failed = true;
        } finally {
            cr.$dispose();
        }
    }
}

// A layer over the rest of a parent that lays its children over each other (a BinLayout): it fills the parent, asks
// for no room of its own, and leaves its children where set_position() puts them. (A BinLayout would center a child
// that does not expand, whatever its x_align and y_align say.) Tooltips and menus go in it.
export const OverlayLayer = GObject.registerClass(
class TodoPetOverlayLayer extends St.Widget {
    constructor(params = {}) {
        super({x_expand: true, y_expand: true, ...params});
    }

    vfunc_get_preferred_width() {
        return [0, 0];
    }

    vfunc_get_preferred_height() {
        return [0, 0];
    }
});

const TOOLTIP_DELAY_MS = 500;
const TOOLTIP_GAP = 4;

// Tooltips (Swift: .help) for widgets inside `root`: one label, drawn on top of `root`'s other children (root must
// lay its children over each other, e.g. a BinLayout), shown under the hovered widget after half a second. The owner
// calls hide() before it destroys widgets that have a tooltip (no `destroy` handlers here, see MiniPet).
export class Tooltips {
    constructor(root) {
        this._root = root;
        this._timerId = 0;
        this._owner = null;
        this._label = new St.Label({style_class: 'todopet-tooltip', visible: false});
        this._label.clutter_text.set({line_wrap: true, line_wrap_mode: Pango.WrapMode.WORD_CHAR});
        this._layer = new OverlayLayer();
        this._layer.add_child(this._label);
        root.add_child(this._layer);
    }

    get label() {
        return this._label;
    }

    // Shows `text` (a string, or a function giving one) while `actor` is hovered. Turns hover tracking on.
    attach(actor, text) {
        actor.track_hover = true;
        if (!actor.reactive)
            actor.reactive = true;
        actor.connect('notify::hover', () => {
            if (actor.hover)
                this._schedule(actor, text);
            else if (this._owner === actor)
                this.hide();
        });
    }

    hide() {
        this._cancel();
        this._owner = null;
        if (this._label)
            this._label.visible = false;
    }

    destroy() {
        this._cancel();
        this._owner = null;
        this._label = null;
    }

    _schedule(actor, text) {
        this._cancel();
        this._owner = actor;
        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TOOLTIP_DELAY_MS, () => {
            this._timerId = 0;
            this.showNow(actor, typeof text === 'function' ? text() : text);
            return GLib.SOURCE_REMOVE;
        });
    }

    // Shows `text` under `actor` at once (or over it, when there is no room below).
    showNow(actor, text) {
        if (!this._label || !text || !actor.get_stage())
            return;
        this._owner = actor;
        const tip = this._label;
        tip.text = text;
        tip.visible = true;
        const [rootX, rootY] = this._root.get_transformed_position();
        const [x, y] = actor.get_transformed_position();
        const [width, height] = actor.get_transformed_size();
        const [rootWidth, rootHeight] = this._root.get_transformed_size();
        const [, tipWidth] = tip.get_preferred_width(-1);
        const [, tipHeight] = tip.get_preferred_height(tipWidth);
        const left = Math.min(Math.max(x - rootX + (width - tipWidth) / 2, TOOLTIP_GAP), rootWidth - tipWidth - TOOLTIP_GAP);
        let top = y - rootY + height + TOOLTIP_GAP;
        if (top + tipHeight > rootHeight - TOOLTIP_GAP)
            top = y - rootY - tipHeight - TOOLTIP_GAP;
        tip.set_position(Math.round(Math.max(left, 0)), Math.round(Math.max(top, 0)));
    }

    _cancel() {
        if (this._timerId !== 0)
            GLib.source_remove(this._timerId);
        this._timerId = 0;
    }
}

// The root of a board page: the content (optionally in a scroll view that gives way when the screen is short) and,
// drawn over it, the page's tooltip. The page's owner calls dispose() before the actor is destroyed.
export class PageShell {
    constructor(content, {scroll = false} = {}) {
        this.actor = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true});
        this.scroll = null;
        if (scroll) {
            this.scroll = new St.ScrollView({
                style_class: 'todopet-page-scroll',
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
                overlay_scrollbars: true,
                x_expand: true,
                y_expand: true,
                child: content,
            });
            this.actor.add_child(this.scroll);
            // The board turns scrolling on only when the page is taller than the screen allows.
            this.actor.setScrolling = on => this.setScrolling(on);
        } else {
            this.actor.add_child(content);
        }
        this.tooltips = new Tooltips(this.actor);
    }

    // Whether the content scrolls. While it does not, the scroll view takes exactly the room the content needs (a
    // pixel short, and a scroll bar would appear).
    setScrolling(on) {
        if (this.scroll)
            this.scroll.vscrollbar_policy = on ? St.PolicyType.AUTOMATIC : St.PolicyType.NEVER;
    }

    dispose() {
        this.tooltips.hide();
        this.tooltips.destroy();
    }
}
