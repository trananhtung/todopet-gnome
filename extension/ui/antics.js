// The pet's mischief and celebrations on screen: port of AppDelegate.perform and SignController (Antics.swift), plus
// the effects around a celebrating pet. The brain decides when (brain/rules.js, brain.js); the pet moves
// (ui/walker.js); this file adds what is drawn beside it:
//   - grumble: the pet sighs and stomps in place (the walker), with its breath and the dust (an effect layer);
//   - parade: the pet marches to the far side dragging the sign with the avoided task (drawSign), rope toward it;
//   - block: the pet leaps into the middle of the screen; the brain's table-flip bubble follows it there;
//   - celebrate: confetti, or fireworks for the fireworks dance and a golden treat, and a combo badge, around the pet
//     (the dance, the falling treat and the golden pet are drawn by drawPet itself, from brain.celebration).
// Every bubble with its "Spare me 15'" button and every voice line come from the brain. Clicking the pet calls a
// stunt off (App._petClicked → brain.endAntic → stop()).
//
//   new Antics(app)     reads app.pet and app.brain; follows the pet and stops everything when the pet hides
//   run(antic)          plays the brain's antic ({kind, text}) if the pet is on screen (Swift: perform)
//   stop()              takes everything off the screen and ends the pet's stunt (the pet tells the brain)
//   celebrate(event)    the brain's celebration ({kind, food, golden, combo, start})
//   destroy()
// For the dev scenes: playing (the antic kind or null), sign ({x, y, width, height, ropeOnRight, text} or null),
// layers (names of the effect actors on stage), celebrationPlan.
//
// Every actor here is a non-reactive St.DrawingArea in the top chrome, placed just above the pet (below the bubble and
// the board), moved by its translation like the pet. An effect layer repaints at about 30 fps from its own timeline
// and removes itself when its time is up; the sign repaints only when its rope changes sides.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {drawSign, signSize} from '../art/petArt.js';
import {drawCelebration, drawGrumble} from './anticsArt.js';
import {
    CELEBRATION_MARGINS, GRUMBLE, GRUMBLE_MARGINS, badgeSide, celebrationPlan, confettiPieces, effectBox,
    fireworkBursts, signFrame,
} from './anticsLogic.js';

const FRAME_SECONDS = 1 / 30;
// Timeline frames come at the display's refresh rate: a frame this much early still counts.
const FRAME_SLACK_SECONDS = 0.004;
// An effect layer is removed this long after its time even if its timeline stalled (an unmapped actor's does).
const SAFETY_MS = 250;
// Like the pet: hidden under a full-screen window. (GNOME 50 has no input region to keep these out of: Wayland only.)
const CHROME = Object.freeze({trackFullscreen: true});

const monotonicSeconds = () => GLib.get_monotonic_time() / 1e6;

// Puts `actor` just above `pet` when both are in the same parent (the layout manager's uiGroup).
function placeAbove(actor, pet) {
    const parent = actor.get_parent();
    if (parent && pet && pet.get_parent() === parent)
        parent.set_child_above_sibling(actor, pet);
}

function logOnce(errors, what, e) {
    if (errors.has(what))
        return;
    errors.add(what);
    console.error(`TodoPet: ${what} failed: ${e?.stack ?? e}`);
}

// One effect drawn around the pet for `seconds`: draw(cr, box, t) paints it into an effectBox(frame, margins).
class EffectLayer {
    constructor({name, petActor, frame, margins, seconds, draw, onDone, errors}) {
        this.name = name;
        this._margins = margins;
        this._seconds = seconds;
        this._draw = draw;
        this._onDone = onDone;
        this._errors = errors;
        this._start = monotonicSeconds();
        this._lastFrame = -Infinity;
        this.box = effectBox(frame, margins);

        this.actor = new St.DrawingArea({name, reactive: false});
        this.actor.set_size(this.box.width, this.box.height);
        this._repaintId = this.actor.connect('repaint', area => this._paint(area));
        Main.layoutManager.addTopChrome(this.actor, CHROME);
        placeAbove(this.actor, petActor);
        this.actor.set_translation(this.box.x, this.box.y, 0);

        this._timeline = new Clutter.Timeline({actor: this.actor, duration: 1000, repeat_count: -1});
        this._timelineId = this._timeline.connect('new-frame', () => this._frame());
        this._timeline.start();
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.ceil(seconds * 1000) + SAFETY_MS, () => {
            this._timeoutId = 0;
            this._finish();
            return GLib.SOURCE_REMOVE;
        });
    }

    follow(frame) {
        if (!this.actor)
            return;
        const box = effectBox(frame, this._margins);
        if (box.width !== this.box.width || box.height !== this.box.height)
            this.actor.set_size(box.width, box.height);
        this.box = box;
        this.actor.set_translation(box.x, box.y, 0);
    }

    destroy() {
        if (!this.actor)
            return;
        this._timeline.disconnect(this._timelineId);
        this._timeline.stop();
        this._timeline = null;
        if (this._timeoutId !== 0)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
        const actor = this.actor;
        this.actor = null;
        actor.disconnect(this._repaintId);
        Main.layoutManager.removeChrome(actor);
        actor.destroy();
    }

    _frame() {
        const now = monotonicSeconds();
        if (now - this._lastFrame < FRAME_SECONDS - FRAME_SLACK_SECONDS)
            return;
        this._lastFrame = now;
        if (now - this._start >= this._seconds) {
            this._finish();
            return;
        }
        this.actor?.queue_repaint();
    }

    _paint(area) {
        const cr = area.get_context();
        try {
            this._draw(cr, this.box, monotonicSeconds() - this._start);
        } catch (e) {
            logOnce(this._errors, `drawing the ${this.name}`, e);
        } finally {
            cr.$dispose();
        }
    }

    _finish() {
        if (!this.actor)
            return;
        this.destroy();
        this._onDone?.(this);
    }
}

// The parade's sign (Swift: SignController): sized for its text, behind the pet, the rope toward it.
class SignView {
    constructor(text, petActor, unit, errors) {
        this.text = text;
        this.ropeOnRight = null;
        this.frame = null;
        this._unit = unit;
        this._errors = errors;
        const size = signSize(text);
        this.width = Math.ceil(size.width * unit);
        this.height = Math.ceil(size.height * unit);
        this.actor = new St.DrawingArea({name: 'todopet-sign', reactive: false});
        this.actor.set_size(this.width, this.height);
        this._repaintId = this.actor.connect('repaint', area => this._paint(area));
        Main.layoutManager.addTopChrome(this.actor, CHROME);
        placeAbove(this.actor, petActor);
    }

    // Keeps the sign behind the pet at `frame`, on the side it walks away from (`facing`).
    follow(frame, facing) {
        if (!this.actor)
            return;
        const f = signFrame(frame, facing, this);
        if (f.ropeOnRight !== this.ropeOnRight) {
            this.ropeOnRight = f.ropeOnRight;
            this.actor.queue_repaint();
        }
        this.frame = {x: f.x, y: f.y, width: this.width, height: this.height};
        this.actor.set_translation(f.x, f.y, 0);
    }

    destroy() {
        if (!this.actor)
            return;
        const actor = this.actor;
        this.actor = null;
        actor.disconnect(this._repaintId);
        Main.layoutManager.removeChrome(actor);
        actor.destroy();
    }

    _paint(area) {
        const cr = area.get_context();
        try {
            const [width, height] = area.get_surface_size();
            cr.scale(this._unit, this._unit);
            drawSign(cr, width / this._unit, height / this._unit, this.text, {ropeOnRight: this.ropeOnRight ?? true});
        } catch (e) {
            logOnce(this._errors, 'drawing the sign', e);
        } finally {
            cr.$dispose();
        }
    }
}

export class Antics {
    constructor(app) {
        this._app = app;
        this._kind = null;
        this._sign = null;
        this._grumble = null;
        this._celebration = null;
        this._plan = null;
        this._errors = new Set();
        const pet = app.pet;
        this._pet = pet;
        this._petIds = [
            pet.on('moved', frame => this._follow(frame)),
            // Nothing plays without the pet: a stunt it can no longer finish ends now.
            pet.on('visibility-changed', shown => {
                if (!shown)
                    this.stop();
            }),
        ];
    }

    // --- For the dev scenes ---

    get playing() {
        return this._kind;
    }

    get sign() {
        const s = this._sign;
        return s?.frame ? {...s.frame, ropeOnRight: s.ropeOnRight, text: s.text} : null;
    }

    get layers() {
        return [this._sign, this._grumble, this._celebration].filter(x => x?.actor).map(x => x.actor.name);
    }

    get celebrationPlan() {
        return this._celebration?.actor ? this._plan : null;
    }

    // --- Playing ---

    // The brain's antic (Swift: AppDelegate.perform). A parade or a block replaces whatever stunt was on screen. A pet
    // in your hand plays none (Swift's marched out of it, and kept the sign up after you let go); a pet that is busy
    // (falling, on another stunt) grumbles in its bubble only, as Swift's always did.
    run(antic) {
        const pet = this._pet;
        if (!antic || !pet?.visible)
            return;
        switch (antic.kind) {
        case 'parade':
            if (!pet.startParade(antic.text))
                return;
            this._clearAntic();
            this._sign = new SignView(antic.text, pet.actor, pet.unit, this._errors);
            this._sign.follow(pet.frame, pet.motion.facing);
            break;
        case 'block':
            if (!pet.startBlock())
                return;
            this._clearAntic();
            break;
        case 'grumble': {
            if (!pet.startGrumble())
                return;
            this._clearAntic();
            const side = badgeSide(pet.frame, pet.workArea);
            this._grumble = new EffectLayer({
                name: 'todopet-grumble', petActor: pet.actor, frame: this._grounded(pet.frame), margins: GRUMBLE_MARGINS,
                seconds: GRUMBLE.seconds, errors: this._errors,
                draw: (cr, box, t) => drawGrumble(cr, {box, side}, t),
                onDone: layer => {
                    if (this._grumble === layer)
                        this._grumble = null;
                },
            });
            break;
        }
        default:
            return;
        }
        this._kind = antic.kind;
    }

    // Everything off the screen: the sign, the effects, and the pet's stunt (the pet then tells the brain it is over).
    stop() {
        this._clearAntic();
        this._celebration?.destroy();
        this._celebration = null;
        this._plan = null;
        this._pet?.endAntic();
    }

    // Confetti or fireworks, and the combo badge, around the pet for the celebration's length (brain.celebrateUntil).
    celebrate(event) {
        const pet = this._pet;
        if (!event || !pet?.visible)
            return;
        this._celebration?.destroy();
        const until = this._app.brain?.celebrateUntil;
        const seconds = until instanceof Date && event.start instanceof Date ? (until - event.start) / 1000 : NaN;
        const plan = celebrationPlan(event, seconds);
        const scene = {
            plan,
            pieces: confettiPieces(),
            bursts: fireworkBursts(plan.golden),
            side: badgeSide(pet.frame, pet.workArea),
        };
        this._plan = plan;
        this._celebration = new EffectLayer({
            name: 'todopet-celebration', petActor: pet.actor, frame: pet.frame, margins: CELEBRATION_MARGINS,
            seconds: plan.seconds, errors: this._errors,
            draw: (cr, box, t) => drawCelebration(cr, {...scene, box}, t),
            onDone: layer => {
                if (this._celebration === layer) {
                    this._celebration = null;
                    this._plan = null;
                }
            },
        });
    }

    destroy() {
        for (const id of this._petIds)
            this._pet?.off(id);
        this._petIds = [];
        this._clearAntic();
        this._celebration?.destroy();
        this._celebration = null;
        this._pet = null;
    }

    // --- Plumbing ---

    // Takes the current stunt's sign and effects away (the pet's motion is left alone).
    _clearAntic() {
        this._kind = null;
        this._sign?.destroy();
        this._sign = null;
        this._grumble?.destroy();
        this._grumble = null;
    }

    _follow(frame) {
        this._sign?.follow(frame, this._pet.motion.facing);
        // The breath and the dust stay put while the pet hops.
        this._grumble?.follow(this._grounded(frame));
        this._celebration?.follow(frame);
    }

    // The pet's frame as if it stood on the ground (a grumble's stomps lift it a little).
    _grounded(frame) {
        return {...frame, y: this._pet.ground};
    }
}
