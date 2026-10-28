// How the pet moves along the bottom of the screen: port of PetController.step/chooseNext/speed/idleTime and the
// antic motions (parade, leap, perch) in PetWindow.swift. Pure: no Shell imports. ui/pet.js calls step() every
// frame with the time, the mood, the work area and the pointer, then puts the actor at (x, y).
//
// Coordinates are stage pixels with y pointing down (Swift's y points up, so falling adds to y here). `size` is the
// pet's side in pixels; `unit` is pixels per Swift point (the stage scale factor), for the distances Swift gives in
// points. Times are in seconds on a steady clock.
//
// `behavior` is one of {kind: 'idle', until}, {kind: 'walk', toX}, {kind: 'fall'}, {kind: 'held'},
// {kind: 'parade', toX}, {kind: 'leap', from: {x, y}, to: {x, y}, start}, {kind: 'perch', until}.
import {PetMotion} from '../art/motion.js';
import {PET_BASE_SIZE, clampToWorkArea, groundY} from './geometry.js';

// Swift puts the window 5% of its size below the visible frame, so the feet (not the transparent margin under
// them) touch the edge.
const GROUND_SINK = 0.05;
const GRAVITY = 2200; // points/s²
const MAX_DT = 0.1;
const CALM_CHECK_SECONDS = 0.5;
const PARADE_SPEED = 95;
const LEAP_SECONDS = 0.7;
const LEAP_ARC = 120;
const PERCH_SECONDS = 20;
// Eyes turn fully toward a pointer this many points away from the pet's center.
const LOOK_DISTANCE = 300;

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// Points per second at size 124 (Swift: speed(_:)).
const SPEEDS = Object.freeze({happy: 58, normal: 38, focus: 38, annoyed: 22, angry: 70, sleeping: 0, celebrating: 0});

// Seconds to stand still before choosing what to do next (Swift: idleTime(_:)).
function idleTime(mood, random) {
    const between = (lo, hi) => lo + random() * (hi - lo);
    switch (mood) {
    case 'happy': return between(1.5, 3.5);
    case 'annoyed': return between(5, 9);
    case 'angry': return between(1.5, 3);
    case 'focus':
    case 'sleeping': return 5;
    case 'celebrating': return 1;
    default: return between(3, 7);
    }
}

// Behaviors that move the pet every frame (the pet repaints at full rate then).
const MOVING = new Set(['walk', 'fall', 'held', 'parade', 'leap']);
const ANTICS = new Set(['parade', 'leap', 'perch']);

export class PetWalker {
    constructor({size = PET_BASE_SIZE, unit = 1, random = Math.random} = {}) {
        this.size = size;
        this.unit = unit;
        this.motion = new PetMotion();
        this.x = 0;
        this.y = 0;
        this.vy = 0;
        this.behavior = {kind: 'fall'};
        // True while a bubble or the board is open: the pet stands still.
        this.paused = false;
        // Called when a parade or a perch is over (or endAntic() cut it short).
        this.onAnticEnded = null;
        this._random = random;
        this._last = null;
        this._lastCalmCheck = -Infinity;
    }

    setSize(size, unit) {
        this.size = size;
        this.unit = unit;
    }

    // The y of the pet standing on the work area's bottom edge.
    ground(workArea) {
        return groundY(workArea, this.size) + Math.round(this.size * GROUND_SINK);
    }

    get isInAntic() {
        return ANTICS.has(this.behavior.kind);
    }

    // Moving every frame (walking, falling, held, an antic in motion), as opposed to standing or sitting.
    get active() {
        return MOVING.has(this.behavior.kind);
    }

    // Where the pet appears when it starts: 140 points from the right edge, 300 points up, falling.
    start(workArea) {
        const u = this.unit;
        this.place(workArea.x + workArea.width - this.size - 140 * u,
            workArea.y + workArea.height - 300 * u - this.size);
    }

    // Puts the pet at (x, y), falling from there.
    place(x, y) {
        this.x = x;
        this.y = y;
        this.vy = 0;
        this.behavior = {kind: 'fall'};
    }

    // Brings the pet back: it drops into the middle of the work area, 200 points up.
    comeHere(workArea) {
        this.motion.held = false;
        this.place(workArea.x + workArea.width / 2 - this.size / 2,
            workArea.y + workArea.height - 200 * this.unit - this.size);
    }

    // Walks to `x`. The calm state is read again on the next step: an asked-for walk must not be lost to a reading
    // up to 0.5 s old (a walk the pet chooses itself trusts that reading, as in Swift).
    walkTo(x) {
        this.behavior = {kind: 'walk', toX: x};
        this._lastCalmCheck = -Infinity;
    }

    // Picked up by the pointer: legs still, the pet follows dragTo().
    grab() {
        this.behavior = {kind: 'held'};
        this.motion.held = true;
        this.motion.walking = false;
    }

    dragTo(x, y) {
        this.x = x;
        this.y = y;
    }

    // Let go: falls back to the ground.
    release() {
        this.motion.held = false;
        this.vy = 0;
        this.behavior = {kind: 'fall'};
    }

    // Marches to the far side of the work area.
    startParade(workArea) {
        const u = this.unit;
        const toX = this.x + this.size / 2 > workArea.x + workArea.width / 2
            ? workArea.x + 10 * u
            : workArea.x + workArea.width - this.size - 10 * u;
        this.behavior = {kind: 'parade', toX};
    }

    // Leaps up into the middle of the work area (and perches there for a while).
    startBlock(workArea, now) {
        this.behavior = {
            kind: 'leap',
            from: {x: this.x, y: this.y},
            to: {x: workArea.x + workArea.width / 2 - this.size / 2, y: workArea.y + workArea.height / 2 - this.size / 2},
            start: now,
        };
    }

    // Stops a parade, leap or perch: the pet falls back down. Returns whether there was one.
    endAntic() {
        if (!this.isInAntic)
            return false;
        this.vy = 0;
        this.behavior = {kind: 'fall'};
        this.onAnticEnded?.();
        return true;
    }

    // After the work area (or the pet's size) changed: back inside it and on its ground. A walk is dropped (its
    // target may be outside now); a held pet stays where the pointer is.
    settle(workArea) {
        const kind = this.behavior.kind;
        if (kind === 'held')
            return;
        this.x = clampToWorkArea(this.x, this.size, workArea);
        if (kind === 'walk') {
            this.vy = 0;
            this.behavior = {kind: 'fall'};
        } else if (kind === 'parade') {
            this.behavior = {kind: 'parade', toX: clampToWorkArea(this.behavior.toX, this.size, workArea)};
        }
        if (kind === 'idle' || kind === 'parade')
            this.y = this.ground(workArea);
    }

    // One frame. `input` = {mood, workArea, pointer: {x, y}, calm: () => bool (read every 0.5 s), chase: bool}.
    step(now, input) {
        const {mood, workArea} = input;
        const dt = this._last === null ? 0 : clamp(now - this._last, 0, MAX_DT);
        this._last = now;
        if (now - this._lastCalmCheck > CALM_CHECK_SECONDS) {
            this._lastCalmCheck = now;
            this.motion.calm = Boolean(input.calm());
        }
        const motion = this.motion;
        const u = this.unit;
        const b = this.behavior;

        switch (b.kind) {
        case 'held':
            break;
        case 'fall': {
            motion.walking = false;
            this.vy += GRAVITY * u * dt;
            this.y += this.vy * dt;
            const ground = this.ground(workArea);
            if (this.y >= ground) {
                this.y = ground;
                this.vy = 0;
                this.behavior = {kind: 'idle', until: now + 0.8};
            }
            break;
        }
        case 'idle':
            motion.walking = false;
            if (now >= b.until && !this.paused && !motion.hovered)
                this._chooseNext(now, input);
            break;
        case 'walk': {
            const v = this._speed(mood);
            if (this.paused || motion.hovered || motion.calm || v === 0) {
                this.behavior = {kind: 'idle', until: now + 0.6};
                motion.walking = false;
                break;
            }
            const dx = b.toX - this.x;
            if (Math.abs(dx) < 2 * u) {
                this.behavior = {kind: 'idle', until: now + idleTime(mood, this._random)};
                motion.walking = false;
            } else {
                this._walk(dx, v, dt);
                motion.walkPhase += dt * (v / (this.size / PET_BASE_SIZE)) / 38 * 9;
            }
            break;
        }
        case 'parade': {
            // Mischief ignores pauses: the bubble just follows along.
            const dx = b.toX - this.x;
            if (Math.abs(dx) < 2 * u) {
                motion.walking = false;
                this.behavior = {kind: 'idle', until: now + 2};
                this.onAnticEnded?.();
            } else {
                this._walk(dx, PARADE_SPEED * this.size / PET_BASE_SIZE, dt);
                motion.walkPhase += dt * 20;
            }
            break;
        }
        case 'leap': {
            motion.walking = false;
            const k = Math.min(1, (now - b.start) / LEAP_SECONDS);
            this.x = b.from.x + (b.to.x - b.from.x) * k;
            this.y = b.from.y + (b.to.y - b.from.y) * k - Math.sin(Math.PI * k) * LEAP_ARC * u;
            if (k >= 1)
                this.behavior = {kind: 'perch', until: now + PERCH_SECONDS};
            break;
        }
        case 'perch':
            motion.walking = false;
            if (now >= b.until)
                this.endAntic();
            break;
        }

        const kind = this.behavior.kind;
        if (kind !== 'held' && kind !== 'fall' && kind !== 'leap' && kind !== 'perch')
            this.y = this.ground(workArea);
        if (kind !== 'held')
            this.x = clampToWorkArea(this.x, this.size, workArea);
        if (!motion.walking) {
            const target = clamp((input.pointer.x - (this.x + this.size / 2)) / (LOOK_DISTANCE * u), -1, 1);
            motion.lookX += (target - motion.lookX) * Math.min(1, dt * 4);
        }
    }

    _speed(mood) {
        return (SPEEDS[mood] ?? SPEEDS.normal) * this.size / PET_BASE_SIZE;
    }

    _walk(dx, v, dt) {
        const dir = dx > 0 ? 1 : -1;
        this.x += dir * Math.min(Math.abs(dx), v * dt);
        this.motion.facing = dir;
        this.motion.walking = true;
    }

    _chooseNext(now, {mood, workArea, pointer, chase}) {
        // No wandering while you type: walking at the edge of the screen pulls your eyes away.
        if (this.motion.calm) {
            this.behavior = {kind: 'idle', until: now + 2};
            return;
        }
        const u = this.unit;
        const minX = workArea.x + 10 * u;
        const maxX = workArea.x + workArea.width - this.size - 10 * u;
        const inside = v => Math.min(Math.max(v, minX), maxX);
        switch (mood) {
        case 'sleeping':
        case 'celebrating':
            this.behavior = {kind: 'idle', until: now + idleTime(mood, this._random)};
            return;
        case 'focus': {
            // Walk to a quiet corner and sit there.
            const corner = maxX - 20 * u;
            this.behavior = Math.abs(this.x - corner) > 4 * u ? {kind: 'walk', toX: corner} : {kind: 'idle', until: now + 5};
            return;
        }
        }
        // Grumpy pets march toward your cursor.
        if (mood === 'angry' && chase && this._random() < 0.65) {
            this.behavior = {kind: 'walk', toX: inside(pointer.x - this.size / 2)};
            return;
        }
        const chance = mood === 'happy' ? 0.7 : mood === 'annoyed' ? 0.3 : 0.55;
        if (this._random() < chance) {
            const distance = (80 + this._random() * 240) * u * (this._random() < 0.5 ? 1 : -1);
            this.behavior = {kind: 'walk', toX: inside(this.x + distance)};
        } else {
            this.behavior = {kind: 'idle', until: now + idleTime(mood, this._random)};
        }
    }
}
