// Live motion values, read by the renderer every frame (port of PetMotion in PetWindow.swift).
import {Mood} from '../core/mood.js';
import {defaultPose} from './petArt.js';

// Seconds the body colors take to blend into a new mood's colors.
const BLEND_SECONDS = 0.8;

export class PetMotion {
    constructor() {
        this.facing = -1;
        this.walking = false;
        this.walkPhase = 0;
        this.lookX = 0;
        this.hovered = false;
        this.held = false;
        // You're typing or in the zone: small movements, no walking.
        this.calm = false;
        this._shownMood = Mood.normal;
        this._prevMood = Mood.normal;
        this._changedAt = 0;
    }

    // The pose for this frame. A mood change starts a color blend from the mood shown before.
    pose(mood, t) {
        if (mood !== this._shownMood) {
            this._prevMood = this._shownMood;
            this._shownMood = mood;
            this._changedAt = t;
        }
        return {
            ...defaultPose(mood, t),
            facing: this.facing,
            walking: this.walking,
            walkPhase: this.walkPhase,
            lookX: this.lookX,
            hovered: this.hovered,
            held: this.held,
            prevMood: this._prevMood,
            blend: Math.min(1, (t - this._changedAt) / BLEND_SECONDS),
            calm: this.calm,
        };
    }
}
