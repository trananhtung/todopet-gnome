// Idle time and the typing heuristic (spec "Typing heuristic"). Once a second it reads the compositor's idle
// time (Meta.IdleMonitor, in process, no D-Bus) and the pointer position and feeds them to a TypingSampler.
// The Shell sources are read through functions that touch `global` only when called, so plain gjs can load
// this file and tests can pass their own.
import GLib from 'gi://GLib';

import {TypingSampler} from '../core/calm.js';

const shellIdleMs = () => global.backend.get_core_idle_monitor().get_idletime();
const shellPointer = () => global.get_pointer();
// One steady clock for the sampler: milliseconds of the monotonic clock.
const monotonicMs = () => GLib.get_monotonic_time() / 1000;

export class IdleWatch {
    constructor({idleMs = shellIdleMs, pointer = shellPointer, nowMs = monotonicMs} = {}) {
        this._idleMs = idleMs;
        this._pointer = pointer;
        this._nowMs = nowMs;
        this._sampler = new TypingSampler();
        this._idleSeconds = 0;
        this._sourceId = 0;
    }

    start() {
        if (this._sourceId !== 0)
            return;
        this._sample();
        this._sourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            // A throw would make GJS drop this source, and stop() would then remove an id that is gone.
            try {
                this._sample();
            } catch (e) {
                console.error(`TodoPet: idle sampling failed: ${e.message}`);
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    stop() {
        if (this._sourceId !== 0)
            GLib.source_remove(this._sourceId);
        this._sourceId = 0;
    }

    // Seconds without any input, as of the last sample (0 before the first one).
    idleSeconds() {
        return this._idleSeconds;
    }

    // Seconds since the last detected key press; 1e9 before the first one.
    secondsSinceKey() {
        return this._sampler.secondsSinceKey(this._nowMs());
    }

    _sample() {
        const idleMs = Number(this._idleMs());
        this._idleSeconds = idleMs / 1000;
        this._sampler.sample(this._nowMs(), idleMs, this._pointer());
    }
}
