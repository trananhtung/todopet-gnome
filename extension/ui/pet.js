// The pet on screen: port of PetController, PetView, PetHitView and FocusChip in PetWindow.swift. An St.DrawingArea
// in the top chrome draws Mochi with Cairo (art/petArt.js). ui/walker.js decides where it goes: it walks along the
// bottom of the primary monitor's work area, can be dragged and dropped, looks at the pointer and marches toward
// it when angry. The focus chip (🍅 12:34) or the deep-work chip (🎧) sits on its head.
//
//   new PetActor(app)   reads app.prefs and app.brain (app.brain may be null or replaced; it is read every frame)
//   show(), hide(), destroy(), actor, visible, frame -> {x, y, width, height} (stage pixels), paused (set while a
//   bubble or the board is open: the pet stands still), motion (facing, walking... read-only), isInAntic,
//   comeHere(), startParade(text), startBlock(), endAntic(), poke() (something changed: repaint now)
//
// Events: 'clicked'; 'right-clicked' with {x, y} (stage coordinates of the click); 'moved' with the frame;
// 'antic-ended' when a parade or a perch is over (the app tells the brain).
//
// Repaints come from a Clutter.Timeline at about 30 fps while the pet moves or animates, from a 250 ms timeout
// (4 fps) while it stands still, and stop while it is hidden.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {decoratePose, drawPet} from '../art/petArt.js';
import {Emitter} from '../core/emitter.js';
import {Mood} from '../core/mood.js';
import {petSize} from './geometry.js';
import {PetWalker} from './walker.js';

export {clampToWorkArea, groundY} from './geometry.js';

const FAST_FRAME_SECONDS = 1 / 30;
// Timeline frames come at the display's refresh rate: a frame this much early still counts.
const FRAME_SLACK_SECONDS = 0.004;
const SLOW_FRAME_MS = 250;
// The treat falls for this long after a celebration starts (Swift: PetView).
const FOOD_SECONDS = 1.6;
// A press that moves farther than this (in points) is a drag, not a click.
const DRAG_THRESHOLD = 4;

const monotonicSeconds = () => GLib.get_monotonic_time() / 1e6;

// The drawing area. Only the pet's body takes the pointer (Swift: PetHitView.hitTest): the lower 72% of the area,
// without 14% on each side. Clicks on the transparent corners reach the window underneath.
const PetArea = GObject.registerClass(
class TodoPetArea extends St.DrawingArea {
    // StDrawingArea sets only its own allocation; its one child, the chip, goes at the top, centered (Swift's
    // ZStack(alignment: .top)).
    vfunc_allocate(box) {
        super.vfunc_allocate(box);
        const width = box.get_width();
        for (const child of this.get_children()) {
            const [, naturalWidth] = child.get_preferred_width(-1);
            const [, naturalHeight] = child.get_preferred_height(naturalWidth);
            const x = Math.round((width - naturalWidth) / 2);
            child.allocate(Clutter.ActorBox.new(x, 0, x + naturalWidth, naturalHeight));
        }
    }

    vfunc_pick(context) {
        if (!this.should_pick(context))
            return;
        const [width, height] = this.get_size();
        this.pick_box(context, Clutter.ActorBox.new(width * 0.14, height * 0.28, width * 0.86, height));
    }
});

export class PetActor extends Emitter {
    constructor(app) {
        super();
        this._app = app;
        this._walker = new PetWalker();
        this._walker.onAnticEnded = () => this.emit('antic-ended');
        this._shown = false;
        this._loop = 'off'; // 'fast' (timeline), 'slow' (timeout) or 'off'
        this._timeline = null;
        this._timelineId = 0;
        this._slowId = 0;
        this._lastFrame = -Infinity;
        this._press = null; // {x, y, originX, originY, dragging}
        this._grab = null;
        this._grabId = 0;
        this._shownX = null;
        this._shownY = null;
        this._paintedMood = null;
        this._paintedBlend = 1;
        this._errors = new Set();
        this._signals = [];
        this._sized = false;
        this._chase = app.prefs.chaseWhenAngry;

        this.actor = new PetArea({name: 'todopet-pet', reactive: true, track_hover: true});
        this._chip = new St.Label({style_class: 'todopet-pet-chip', visible: false});
        this.actor.add_child(this._chip);

        this._connect(this.actor, 'repaint', area => this._paint(area));
        this._connect(this.actor, 'button-press-event', (_a, event) => this._onPress(event));
        this._connect(this.actor, 'motion-event', (_a, event) => this._onMotion(event));
        this._connect(this.actor, 'button-release-event', (_a, event) => this._onRelease(event));
        this._connect(this.actor, 'notify::hover', () => {
            this._walker.motion.hovered = this.actor.hover;
            this._updateLoop();
        });
        this._connect(this.actor, 'notify::mapped', () => {
            this.actor.queue_repaint();
            this._updateLoop();
        });
        this._connect(this.actor, 'destroy', () => this._onActorDestroyed());
        this._themeContext = St.ThemeContext.get_for_stage(global.stage);
        this._connect(this._themeContext, 'notify::scale-factor', () => this._resize());
        this._connect(global.display, 'workareas-changed', () => this._workAreaChanged());
        this._connect(Main.layoutManager, 'monitors-changed', () => this._workAreaChanged());
        this._prefsId = app.prefs.onChanged(name => {
            if (name === 'petScale')
                this._resize();
            else if (name === 'chaseWhenAngry')
                this._chase = this._app.prefs.chaseWhenAngry;
        });

        this._workArea = this._readWorkArea();
        this._applySize();
        this._walker.start(this._workArea);
        this._place(true);
    }

    get visible() {
        return this._shown;
    }

    get frame() {
        return {x: this._shownX, y: this._shownY, width: this._walker.size, height: this._walker.size};
    }

    get paused() {
        return this._walker.paused;
    }

    set paused(value) {
        this._walker.paused = Boolean(value);
    }

    get motion() {
        return this._walker.motion;
    }

    get isInAntic() {
        return this._walker.isInAntic;
    }

    // --- For the dev scenes ---

    get workArea() {
        return {...this._workArea};
    }

    // The y of the pet standing on the ground.
    get ground() {
        return Math.round(this._walker.ground(this._workArea));
    }

    get behavior() {
        return this._walker.behavior.kind;
    }

    get hovered() {
        return Boolean(this.actor?.hover);
    }

    get chipText() {
        return this._chip?.visible ? this._chip.text : null;
    }

    walkTo(x) {
        this._walker.walkTo(x);
        this._updateLoop();
    }

    // --- Showing ---

    show() {
        if (this._shown || !this.actor)
            return;
        Main.layoutManager.addTopChrome(this.actor, {trackFullscreen: true});
        this._shown = true;
        this._place(true);
        // `hover` may still hold what it was when the pet was hidden.
        this.actor.sync_hover();
        this._walker.motion.hovered = this.actor.hover;
        this.actor.queue_repaint();
        this._updateLoop();
    }

    hide() {
        if (!this._shown)
            return;
        this._cancelPress();
        Main.layoutManager.removeChrome(this.actor);
        this._shown = false;
        this._walker.motion.hovered = false;
        this._updateLoop();
    }

    // Something the pet shows changed (mood, celebration, focus): repaint now instead of on the next slow frame.
    poke() {
        if (!this.actor)
            return;
        this._updateChip();
        this.actor.queue_repaint();
        this._updateLoop();
    }

    // Brings the pet back to the middle of the primary monitor (it drops in) and shows it.
    comeHere() {
        if (!this.actor)
            return;
        this._cancelPress();
        this._walker.comeHere(this._workArea);
        this.show();
        this._place();
        this._updateLoop();
    }

    // Marches to the far side of the screen. The sign with `text` on it is drawn by the antics.
    startParade(_text) {
        this._walker.startParade(this._workArea);
        this._updateLoop();
    }

    // Leaps up into the middle of the screen and stays there a while.
    startBlock() {
        this._walker.startBlock(this._workArea, monotonicSeconds());
        this._updateLoop();
    }

    // Cuts a parade or a perch short: the pet falls back down (and 'antic-ended' is emitted).
    endAntic() {
        this._walker.endAntic();
        this._updateLoop();
    }

    destroy() {
        if (!this.actor)
            return;
        this._cancelPress();
        this._stopLoop();
        this._app.prefs?.disconnect(this._prefsId);
        this._disconnectAll();
        if (this._shown)
            Main.layoutManager.removeChrome(this.actor);
        this._shown = false;
        this._timeline = null;
        const actor = this.actor;
        this.actor = null;
        this._chip = null;
        actor.destroy();
    }

    // --- Frames ---

    _updateLoop() {
        const want = this._wantedLoop();
        if (want === this._loop)
            return;
        this._stopLoop();
        this._loop = want;
        if (want === 'fast') {
            if (!this._timeline) {
                this._timeline = new Clutter.Timeline({actor: this.actor, duration: 1000, repeat_count: -1});
                this._timelineId = this._timeline.connect('new-frame', () => this._frame());
            }
            this._timeline.start();
        } else if (want === 'slow') {
            this._slowId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SLOW_FRAME_MS, () => {
                this._frame();
                return GLib.SOURCE_CONTINUE;
            });
        }
    }

    _wantedLoop() {
        if (!this._shown || !this.actor?.mapped)
            return 'off';
        return this._animating() ? 'fast' : 'slow';
    }

    // Moving, in your hand, under the pointer, celebrating or blending into a new mood's colors.
    _animating() {
        if (this._walker.active || this._walker.motion.hovered || this._press)
            return true;
        const mood = this._app.brain?.mood ?? Mood.normal;
        return mood === Mood.celebrating || mood !== this._paintedMood || this._paintedBlend < 1;
    }

    _stopLoop() {
        this._timeline?.stop();
        if (this._slowId !== 0)
            GLib.source_remove(this._slowId);
        this._slowId = 0;
        this._loop = 'off';
    }

    _frame() {
        if (!this.actor)
            return;
        const now = monotonicSeconds();
        if (this._loop === 'fast' && now - this._lastFrame < FAST_FRAME_SECONDS - FRAME_SLACK_SECONDS)
            return;
        this._lastFrame = now;
        try {
            this._step(now);
        } catch (e) {
            this._logOnce('step', e);
        }
        this.actor.queue_repaint();
        this._updateLoop();
    }

    _step(now) {
        const brain = this._app.brain;
        const [x, y] = global.get_pointer();
        this._walker.step(now, {
            mood: brain?.mood ?? Mood.normal,
            workArea: this._workArea,
            pointer: {x, y},
            calm: () => brain?.calmMotion ?? false,
            chase: this._chase,
        });
        this._place();
        this._updateChip();
    }

    _paint(area) {
        const cr = area.get_context();
        try {
            const [width, height] = area.get_surface_size();
            drawPet(cr, width, height, this._pose());
        } catch (e) {
            this._logOnce('drawing', e);
        } finally {
            cr.$dispose();
        }
    }

    // The frame's pose (Swift: PetView's Canvas): motion, mood, life, and the treat of a fresh celebration.
    _pose() {
        const brain = this._app.brain;
        const mood = brain?.mood ?? Mood.normal;
        let pose = this._walker.motion.pose(mood, monotonicSeconds());
        this._paintedMood = mood;
        this._paintedBlend = pose.blend;
        if (!brain)
            return pose;
        pose = decoratePose(pose, brain.life.state);
        const c = brain.celebration;
        if (c) {
            pose.celebration = c.kind;
            pose.golden = c.golden;
            const since = (Date.now() - c.start.getTime()) / 1000;
            if (since >= 0 && since < FOOD_SECONDS) {
                pose.food = c.food;
                pose.foodT = since;
            }
        }
        return pose;
    }

    // 🍅 24:59 during a focus session, ☕ 4:59 during a break, 🎧 in deep work, nothing otherwise.
    _updateChip() {
        const chip = this._chip;
        if (!chip)
            return;
        const brain = this._app.brain;
        const session = brain?.focusSession;
        let text = null;
        let styleClass = 'todopet-pet-chip';
        if (session) {
            const left = Math.max(0, Math.trunc((session.end.getTime() - Date.now()) / 1000));
            text = `${session.isBreak ? '☕' : '🍅'} ${Math.trunc(left / 60)}:${String(left % 60).padStart(2, '0')}`;
        } else if (brain?.flow) {
            text = '🎧';
            styleClass = 'todopet-pet-chip todopet-pet-chip-flow';
        }
        if (text === null) {
            chip.visible = false;
            return;
        }
        if (chip.text !== text)
            chip.text = text;
        if (chip.style_class !== styleClass)
            chip.style_class = styleClass;
        chip.visible = true;
    }

    // --- Position and size ---

    _readWorkArea() {
        const index = Main.layoutManager.primaryIndex;
        if (index < 0)
            return this._workArea ?? {x: 0, y: 0, width: global.stage.width, height: global.stage.height};
        const area = Main.layoutManager.getWorkAreaForMonitor(index);
        return {x: area.x, y: area.y, width: area.width, height: area.height};
    }

    _workAreaChanged() {
        this._workArea = this._readWorkArea();
        this._walker.settle(this._workArea);
        this._place();
        this._updateLoop();
    }

    // Sets the actor's size from the pet scale and the stage scale. Returns whether it changed.
    _applySize() {
        const scale = this._themeContext.scale_factor;
        const size = petSize(this._app.prefs.petScale, scale);
        if (this._sized && size === this._walker.size && scale === this._walker.unit)
            return false;
        this._sized = true;
        this._walker.setSize(size, scale);
        this.actor.set_size(size, size);
        return true;
    }

    _resize() {
        if (!this.actor || !this._applySize())
            return;
        this._walker.settle(this._workArea);
        this._place(true);
        this.actor.queue_repaint();
    }

    // Moves the actor to the walker's position (whole pixels) and announces it. The actor stays allocated at (0, 0)
    // and moves by its translation: a new allocation makes the drawing area repaint once more (60 repaints a second
    // while walking instead of 30, measured) and makes the layout manager recompute the struts on every frame.
    _place(force = false) {
        if (!this.actor)
            return;
        const x = Math.round(this._walker.x);
        const y = Math.round(this._walker.y);
        if (!force && x === this._shownX && y === this._shownY)
            return;
        this._shownX = x;
        this._shownY = y;
        this.actor.set_translation(x, y, 0);
        this.emit('moved', this.frame);
    }

    // --- Input (Swift: PetHitView) ---

    _onPress(event) {
        const button = event.get_button();
        if (button === Clutter.BUTTON_SECONDARY) {
            const [x, y] = event.get_coords();
            this.emit('right-clicked', {x, y});
            return Clutter.EVENT_STOP;
        }
        if (button !== Clutter.BUTTON_PRIMARY || this._press)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        this._press = {x, y, originX: this._walker.x, originY: this._walker.y, dragging: false};
        // The pointer leaves the pet as soon as the drag starts; the grab keeps its events coming here.
        this._grab = global.stage.grab(this.actor);
        this._grabId = this._grab.connect('notify::revoked', () => {
            if (this._grab?.is_revoked())
                this._cancelPress();
        });
        this._updateLoop();
        return Clutter.EVENT_STOP;
    }

    _onMotion(event) {
        const press = this._press;
        if (!press)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        if (!press.dragging && Math.hypot(x - press.x, y - press.y) > DRAG_THRESHOLD * this._walker.unit) {
            press.dragging = true;
            this._walker.grab();
        }
        if (press.dragging) {
            this._walker.dragTo(press.originX + x - press.x, press.originY + y - press.y);
            this._place();
        }
        return Clutter.EVENT_STOP;
    }

    _onRelease(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY || !this._press)
            return Clutter.EVENT_PROPAGATE;
        const dragged = this._press.dragging;
        this._endPress();
        if (dragged)
            this._walker.release();
        else
            this.emit('clicked');
        this._updateLoop();
        return Clutter.EVENT_STOP;
    }

    // Lets go of a press that cannot finish normally (hidden, destroyed, grab taken away): a held pet falls.
    _cancelPress() {
        if (!this._press)
            return;
        const dragged = this._press.dragging;
        this._endPress();
        if (dragged)
            this._walker.release();
        this._updateLoop();
    }

    _endPress() {
        this._press = null;
        const grab = this._grab;
        this._grab = null;
        if (grab) {
            grab.disconnect(this._grabId);
            grab.dismiss();
        }
        this._grabId = 0;
    }

    // --- Plumbing ---

    _connect(object, signal, handler) {
        this._signals.push([object, object.connect(signal, handler)]);
    }

    _disconnectAll() {
        for (const [object, id] of this._signals)
            object.disconnect(id);
        this._signals = [];
        if (this._timeline && this._timelineId !== 0)
            this._timeline.disconnect(this._timelineId);
        this._timelineId = 0;
    }

    // The Shell destroyed the actor (it tears the chrome down on exit): stop drawing and listening.
    _onActorDestroyed() {
        if (!this.actor)
            return;
        this._endPress();
        this._stopLoop();
        this._app.prefs?.disconnect(this._prefsId);
        this._disconnectAll();
        this._shown = false;
        this._timeline = null;
        this.actor = null;
        this._chip = null;
    }

    _logOnce(what, e) {
        if (this._errors.has(what))
            return;
        this._errors.add(what);
        console.error(`TodoPet: the pet's ${what} failed: ${e?.stack ?? e}`);
    }
}
