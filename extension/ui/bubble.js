// The speech bubble the pet talks through: port of BubbleShape, PillButtonStyle, BubbleView and BubbleController in
// Bubble.swift. An St widget in the top chrome: a Cairo shape (rounded body, a tail toward the pet, the shadow) behind
// a column with the pet's name and mood, a close button, the text and the action buttons (two to a row; the first
// one with `primary` in the accent color). Colors, fonts and the buttons are styled in stylesheet.css (`todopet-bubble`).
//
//   new BubbleView(app)   reads app.brain, app.prefs and app.pet (the work area)
//   show(bubble, petFrame, mood)   shows `bubble` ({id, text, actions, seconds, urgent, reminder}, as the brain makes
//                                  it) above the pet; one that is already up is replaced (no new fade-in)
//   hide()                         takes it away at once, reporting nothing (the brain took it away itself)
//   follow(petFrame)               keeps it above the pet while the pet moves (a no-op when nothing changed)
//   visible, destroy()
//
// What it tells the brain (ui/bubbleLogic.js decides): a tapped button -> noteResponse({picked: title}), then
// dismissBubble(id), then the action runs; the close button -> noteResponse('closed') for a reminder, dismissBubble;
// after `seconds` (never extended: hovering does not hold it) it fades out, tells a reminder it was 'ignored' and
// calls dismissBubble. The brain drops a bubble nobody dismissed 2 s later (brain.js).
//
// Like the pet, the actor stays allocated at (0, 0) and moves by its translation: a new allocation would repaint the
// shape and make the layout manager look at the chrome again on every step of a walk or drag.
// For the dev scenes: frame, tailX, textActor, closeButton, actionButtons.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import Cairo from 'cairo';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {L} from '../core/l10n.js';
import {moodEmoji} from '../core/mood.js';
import {
    BUBBLE, bubbleDelayMs, packRows, placeBubble, quadToCubic, responseFor, shadowLayers, tailCurves,
} from './bubbleLogic.js';

// The shape's fill and outline: Swift's windowBackgroundColor and primary at 8%.
const SHAPE_COLORS = Object.freeze({
    light: Object.freeze({fill: [1, 1, 1], stroke: [0, 0, 0, 0.08]}),
    dark: Object.freeze({fill: [0.18, 0.18, 0.19], stroke: [1, 1, 1, 0.08]}),
});

const isDark = () => St.Settings.get().color_scheme === St.SystemColorScheme.PREFER_DARK;

// Adds a rounded rectangle (clockwise on the screen) to the current path.
function roundedRect(cr, x, y, width, height, radius) {
    cr.newSubPath();
    cr.arc(x + width - radius, y + radius, radius, -Math.PI / 2, 0);
    cr.arc(x + width - radius, y + height - radius, radius, 0, Math.PI / 2);
    cr.arc(x + radius, y + height - radius, radius, Math.PI / 2, Math.PI);
    cr.arc(x + radius, y + radius, radius, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

// Adds the tail as a subpath going the same way round as the rounded rectangle, so that filling both gives their union.
function addTail(cr, tail) {
    const [first, second] = tail.curves;
    const back = quadToCubic(second.to, second.control, first.to);
    const toStart = quadToCubic(first.to, first.control, tail.start);
    cr.moveTo(second.to.x, second.to.y);
    cr.curveTo(back.c1.x, back.c1.y, back.c2.x, back.c2.y, back.to.x, back.to.y);
    cr.curveTo(toStart.c1.x, toStart.c1.y, toStart.c2.x, toStart.c2.y, toStart.to.x, toStart.to.y);
    cr.closePath();
}

// Draws the bubble's shape (Swift: BubbleShape with its fill, shadow and outline) into a width × height surface.
// `tailX` is measured from the shape's left edge, which is `pad` in from the surface's.
function drawShape(cr, width, height, {tailX, unit, dark}) {
    const pad = BUBBLE.pad * unit;
    const radius = BUBBLE.radius * unit;
    const body = {x: pad, y: pad, width: width - 2 * pad, height: height - 2 * pad - BUBBLE.tail * unit};
    const colors = dark ? SHAPE_COLORS.dark : SHAPE_COLORS.light;

    // The shadow (black, 3 px down), outermost layer first.
    const layers = shadowLayers(unit);
    for (const {grow, alpha} of layers.toReversed()) {
        cr.setSourceRGBA(0, 0, 0, alpha);
        roundedRect(cr, body.x - grow, body.y - grow + 3 * unit, body.width + 2 * grow, body.height + 2 * grow, radius + grow);
        cr.fill();
    }

    const tail = tailCurves(tailX + pad, body, unit);
    roundedRect(cr, body.x, body.y, body.width, body.height, radius);
    addTail(cr, tail);
    const [r, g, b] = colors.fill;
    cr.setSourceRGB(r, g, b);
    cr.fillPreserve();
    cr.setLineWidth(unit);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    cr.setSourceRGBA(...colors.stroke);
    cr.stroke();
}

export class BubbleView {
    constructor(app) {
        this._app = app;
        this._bubble = null; // the bubble on screen; null once it was taken away, also while it fades out
        this._inChrome = false;
        this._fading = false;
        this._fadeToken = 0;
        this._timeoutId = 0;
        this._petFrame = null;
        this._size = {width: 0, height: 0};
        this._x = null;
        this._y = null;
        this._tailX = 0;
        this._dark = isDark();
        this._signals = []; // on objects that outlive the bubble: the stage's theme, the settings, the display
        this._errors = new Set();
        this._closeButton = null;
        this._actionButtons = [];
        this._text = null;

        this._root = new St.Widget({
            name: 'todopet-bubble',
            style_class: 'todopet-bubble',
            layout_manager: new Clutter.BinLayout(),
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
            opacity: 0,
        });
        this._shape = new St.DrawingArea({x_expand: true, y_expand: true});
        this._content = new St.BoxLayout({style_class: 'todopet-bubble-content', vertical: true});
        this._root.add_child(this._shape);
        this._root.add_child(this._content);

        this._themeContext = St.ThemeContext.get_for_stage(global.stage);
        // The widgets' own signals go away with the widgets.
        this._shape.connect('repaint', area => this._paintShape(area));
        this._root.connect('destroy', () => this._onRootDestroyed());
        this._connect(this._themeContext, 'notify::scale-factor', () => this._rescale());
        this._connect(St.Settings.get(), 'notify::color-scheme', () => {
            this._applyScheme();
            this._shape.queue_repaint();
        });
        this._connect(global.display, 'workareas-changed', () => this._place(true));
        this._applyScheme();
    }

    get visible() {
        return this._bubble !== null;
    }

    get bubble() {
        return this._bubble;
    }

    // --- For the dev scenes ---

    // The bubble on the stage, with the room for the shadow: {x, y, width, height}.
    get frame() {
        return {x: this._x, y: this._y, width: this._size.width, height: this._size.height};
    }

    get tailX() {
        return this._tailX;
    }

    get textActor() {
        return this._text;
    }

    get closeButton() {
        return this._closeButton;
    }

    get actionButtons() {
        return [...this._actionButtons];
    }

    // --- Showing ---

    show(bubble, petFrame, mood) {
        if (!this._root)
            return;
        this._clearTimer();
        const appearing = !this._inChrome || this._fading;
        if (this._fading)
            this._cancelFade();
        this._bubble = bubble;
        this._petFrame = {...petFrame};
        if (!this._inChrome) {
            this._root.opacity = 0;
            Main.layoutManager.addTopChrome(this._root, {trackFullscreen: true});
            this._inChrome = true;
        }
        this._fill(bubble, mood);
        this._relayout();
        if (appearing) {
            // Fade in gently instead of popping up: abrupt onsets grab attention the most.
            this._root.ease({opacity: 255, duration: BUBBLE.fadeInMs, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }

        const id = bubble.id;
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, bubbleDelayMs(bubble), () => {
            this._timeoutId = 0;
            try {
                this._expire(id);
            } catch (e) {
                this._logOnce('timeout', e);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // Takes the bubble away at once and tells nobody. A bubble that is fading out finishes on its own.
    hide() {
        if (!this._root || this._fading)
            return;
        this._clearTimer();
        this._bubble = null;
        this._removeFromChrome();
    }

    // The pet moved: the bubble goes with it.
    follow(petFrame) {
        this._petFrame = {...petFrame};
        if (this._inChrome && this._root)
            this._place(false);
    }

    destroy() {
        if (!this._root)
            return;
        this._clearTimer();
        this._disconnectAll();
        this._root.remove_all_transitions();
        this._bubble = null;
        this._fading = false;
        this._removeFromChrome();
        const root = this._root;
        this._root = null;
        root.destroy();
    }

    // --- Content ---

    // Builds the column for `bubble`: the name line, the text, the buttons (Swift: BubbleView.body).
    _fill(bubble, mood) {
        this._content.destroy_all_children();
        this._actionButtons = [];

        // The name is gray (Swift: .secondary); the emoji is a label of its own, so that the gray's transparency does
        // not wash its colors out.
        const header = new St.BoxLayout({style_class: 'todopet-bubble-header'});
        const align = Clutter.ActorAlign.CENTER;
        header.add_child(new St.Label({text: this._app.prefs?.petName ?? '', style_class: 'todopet-bubble-name', y_align: align}));
        header.add_child(new St.Label({text: moodEmoji(mood), style_class: 'todopet-bubble-emoji', y_align: align}));
        header.add_child(new St.Widget({x_expand: true}));
        const close = new St.Button({
            style_class: 'todopet-bubble-close',
            accessible_name: L('Đóng', 'Close'),
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: 'window-close-symbolic', style_class: 'todopet-bubble-close-icon'}),
        });
        close.connect('clicked', () => this._onClose());
        header.add_child(close);
        this._closeButton = close;
        this._content.add_child(header);

        // The text wraps at words, and inside a word when one is longer than the line; nothing is cut off.
        const text = new St.Label({text: bubble.text, style_class: 'todopet-bubble-text', x_expand: true});
        text.clutter_text.set({
            line_wrap: true,
            line_wrap_mode: Pango.WrapMode.WORD_CHAR,
            ellipsize: Pango.EllipsizeMode.NONE,
        });
        this._text = text;
        this._content.add_child(text);

        if (bubble.actions.length > 0)
            this._buildActions(bubble.actions);
    }

    // The buttons, two to a row where they fit (see packRows). They are measured on the stage first: St reads a
    // button's style only once it is part of the stage.
    _buildActions(actions) {
        const unit = this._themeContext.scale_factor;
        const holder = new St.BoxLayout({style_class: 'todopet-bubble-actions', vertical: true});
        this._content.add_child(holder);
        const pills = actions.map(action => {
            const pill = new St.Button({
                label: action.title,
                style_class: action.primary ? 'todopet-bubble-pill todopet-bubble-pill-primary' : 'todopet-bubble-pill',
                can_focus: true,
            });
            pill.connect('clicked', () => this._onAction(action));
            holder.add_child(pill);
            return pill;
        });
        const widths = pills.map(pill => pill.get_preferred_width(-1)[1]);
        const available = (BUBBLE.width - 2 * BUBBLE.padX) * unit;
        const rows = packRows(widths, available, BUBBLE.rowSpacing * unit);
        for (const pill of pills)
            holder.remove_child(pill);
        for (const indexes of rows) {
            const line = new St.BoxLayout({style_class: 'todopet-bubble-row'});
            for (const i of indexes)
                line.add_child(pills[i]);
            holder.add_child(line);
        }
        this._actionButtons = pills;
    }

    _applyScheme() {
        this._dark = isDark();
        if (this._dark)
            this._root.add_style_class_name('todopet-bubble-dark');
        else
            this._root.remove_style_class_name('todopet-bubble-dark');
    }

    _paintShape(area) {
        const cr = area.get_context();
        try {
            const [width, height] = area.get_surface_size();
            drawShape(cr, width, height, {tailX: this._tailX, unit: this._themeContext.scale_factor, dark: this._dark});
        } catch (e) {
            this._logOnce('drawing', e);
        } finally {
            cr.$dispose();
        }
    }

    // --- Size and position ---

    // Measures the bubble (it must be on the stage: St reads its style) and puts it above the pet.
    _relayout() {
        const unit = this._themeContext.scale_factor;
        this._content.set_width(Math.round((BUBBLE.width + 2 * BUBBLE.pad) * unit));
        // A size set before would be the preferred size now.
        this._root.set_size(-1, -1);
        const [, width] = this._root.get_preferred_width(-1);
        const [, height] = this._root.get_preferred_height(width);
        this._size = {width: Math.ceil(width), height: Math.ceil(height)};
        this._root.set_size(this._size.width, this._size.height);
        this._place(true);
    }

    _rescale() {
        if (this._inChrome && this._bubble)
            this._relayout();
    }

    _workArea() {
        const index = Main.layoutManager.primaryIndex;
        if (index < 0)
            return {x: 0, y: 0, width: global.stage.width, height: global.stage.height};
        const area = Main.layoutManager.getWorkAreaForMonitor(index);
        return {x: area.x, y: area.y, width: area.width, height: area.height};
    }

    // Swift: BubbleController.place. The tail is only redrawn when it moved by more than a pixel.
    _place(force) {
        if (!this._root || !this._petFrame)
            return;
        const unit = this._themeContext.scale_factor;
        const {x, y, tailX} = placeBubble({petFrame: this._petFrame, size: this._size, workArea: this._workArea(), unit});
        if (force || x !== this._x || y !== this._y) {
            this._x = x;
            this._y = y;
            this._root.set_translation(x, y, 0);
        }
        if (force || Math.abs(tailX - this._tailX) > 1) {
            this._tailX = tailX;
            this._shape.queue_repaint();
        }
    }

    // --- Ending ---

    // The time is up: fade out, tell the brain it was ignored (a reminder only) and have it drop the bubble.
    _expire(id) {
        const bubble = this._bubble;
        if (!bubble || bubble.id !== id)
            return;
        this._bubble = null;
        this._fadeOut();
        const brain = this._app.brain;
        const response = responseFor('ignored', bubble);
        if (response !== null)
            brain?.noteResponse(response);
        brain?.dismissBubble(bubble.id);
    }

    _onClose() {
        const bubble = this._bubble;
        if (!bubble)
            return;
        const response = responseFor('closed', bubble);
        if (response !== null)
            this._app.brain?.noteResponse(response);
        this._dismiss(bubble);
    }

    // Swift: the note, then the bubble goes, then the action runs (which may put up another bubble).
    _onAction(action) {
        const bubble = this._bubble;
        if (!bubble)
            return;
        const response = responseFor('picked', bubble, action);
        if (response !== null)
            this._app.brain?.noteResponse(response);
        this._dismiss(bubble);
        try {
            action.run();
        } catch (e) {
            console.error(`TodoPet: the bubble's action '${action.title}' failed: ${e?.stack ?? e}`);
        }
    }

    _dismiss(bubble) {
        this.hide();
        this._app.brain?.dismissBubble(bubble.id);
    }

    _fadeOut() {
        const token = ++this._fadeToken;
        this._fading = true;
        this._clearTimer();
        this._root.ease({
            opacity: 0,
            duration: BUBBLE.fadeOutMs,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (!this._fading || token !== this._fadeToken)
                    return;
                this._fading = false;
                this._removeFromChrome();
            },
        });
    }

    // Stops a fade-out under way (a new bubble came); the fade-in that follows starts from the current opacity.
    _cancelFade() {
        this._fadeToken++;
        this._fading = false;
        this._root.remove_all_transitions();
    }

    _removeFromChrome() {
        if (!this._root)
            return;
        this._root.remove_all_transitions();
        if (this._inChrome)
            Main.layoutManager.removeChrome(this._root);
        this._inChrome = false;
        this._x = null;
        this._y = null;
    }

    _clearTimer() {
        if (this._timeoutId !== 0)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
    }

    // --- Plumbing ---

    _connect(object, signal, handler) {
        this._signals.push([object, object.connect(signal, handler)]);
    }

    _disconnectAll() {
        for (const [object, id] of this._signals)
            object.disconnect(id);
        this._signals = [];
    }

    // The Shell destroyed the actor (it tears the chrome down on exit): stop listening and timing.
    _onRootDestroyed() {
        if (!this._root)
            return;
        this._clearTimer();
        this._disconnectAll();
        this._bubble = null;
        this._fading = false;
        this._inChrome = false;
        this._root = null;
    }

    _logOnce(what, e) {
        if (this._errors.has(what))
            return;
        this._errors.add(what);
        console.error(`TodoPet: the bubble's ${what} failed: ${e?.stack ?? e}`);
    }
}
