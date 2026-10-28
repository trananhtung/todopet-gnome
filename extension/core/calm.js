// How the pet avoids breaking your concentration (port of Calm.swift). Based on interruption research:
// - Interrupting at a natural pause instead of mid-task lowers frustration and resumption time
//   (Adamczyk & Bailey 2004; Iqbal & Bailey 2008).
// - Fewer, batched notifications improve attention and well-being (Fitz et al. 2019).
// - Motion at the edge of vision grabs attention, so the pet keeps still while you type (Bartram et al. 2003).
// - Calm technology: stay in the periphery and only move to the center when it matters (Weiser & Brown 1996).

const TYPING_WINDOW = 8;
const FLOW_MINUTES = 10;
const FLOW_ENDS_AFTER = 120;

const secondsBetween = (later, earlier) => (later.getTime() - earlier.getTime()) / 1000;

export const CalmRules = Object.freeze({
    // Typing within this many seconds means you're in the middle of something.
    typingWindow: TYPING_WINDOW,
    // Steady typing for this long counts as "being in the zone"; non-urgent bubbles wait.
    flowMinutes: FLOW_MINUTES,
    // Two minutes without a keystroke ends the zone.
    flowEndsAfter: FLOW_ENDS_AFTER,

    // You're actively working: typing recently, at the computer, and not in a distracting app or site.
    engaged(secondsSinceKey, idleSeconds, distracted) {
        return secondsSinceKey < 45 && idleSeconds < 60 && !distracted;
    },

    // When engaged work started (null when you're not engaged), with a little hysteresis so short pauses
    // don't reset it. `current` is a Date or null; returns a Date or null.
    engagedSince(current, engaged, secondsSinceKey, now) {
        if (engaged)
            return current ?? now;
        return secondsSinceKey > FLOW_ENDS_AFTER ? null : current;
    },

    inFlow(engagedSince, now, minutes = FLOW_MINUTES) {
        if (!engagedSince)
            return false;
        return secondsBetween(now, engagedSince) >= minutes * 60;
    },

    // A natural pause: you stopped typing for a moment, or just switched apps.
    atBreakpoint(secondsSinceKey, secondsSinceAppSwitch) {
        return secondsSinceKey >= TYPING_WINDOW || secondsSinceAppSwitch < 10;
    },

    // Unsolicited bubbles are spaced out: at most one per `minGapMinutes` minutes.
    withinBudget(lastBubbleAt, now, minGapMinutes) {
        return secondsBetween(now, lastBubbleAt) >= minGapMinutes * 60;
    },
});

// Stand-in for CalmRules.secondsSinceKey(): GNOME Shell has no "time since last key press" API, so the Shell
// service samples idle time and the pointer once a second. A second where the idle time dropped under 1 s
// while the pointer did not move counts as a key press. Times are in milliseconds on any steady clock.
export class TypingSampler {
    constructor() {
        this._previous = null; // [x, y] of the previous sample, or null before the first one
        this._lastKeyMs = null;
    }

    sample(nowMs, idleMs, pointer) {
        const prev = this._previous;
        if (prev && idleMs < 1000 && prev[0] === pointer[0] && prev[1] === pointer[1])
            this._lastKeyMs = nowMs;
        this._previous = [pointer[0], pointer[1]];
    }

    // Seconds since the last detected key press; 1e9 when none was detected yet.
    secondsSinceKey(nowMs) {
        if (this._lastKeyMs === null)
            return 1e9;
        return Math.max(0, (nowMs - this._lastKeyMs) / 1000);
    }
}
