// The speech bubble's numbers and decisions, without any Shell import, so plain gjs tests load them (ui/bubble.js
// draws and runs the bubble). Port of the parts of Bubble.swift and AppDelegate.showBubble that are arithmetic or
// rules. Lengths are in CSS pixels at scale 1: `unit` (the stage scale factor) multiplies them. A work area and a
// pet frame are {x, y, width, height} in stage pixels.

export const BUBBLE = Object.freeze({
    // The shape's width (Swift: BubbleView.width). The view is 10 px wider on each side, for the shadow: 290 in all.
    width: 270,
    pad: 10,
    // The text and the buttons are this far in from the shape's sides (Swift: .padding(.horizontal, 14)).
    padX: 14,
    // Buttons are put at most this many to a row (Swift: stride by 2), this far apart.
    perRow: 2,
    rowSpacing: 6,
    // The tail under the body, the body's corner radius, and how far the tail stays from the body's corners.
    tail: 10,
    radius: 16,
    tailMargin: 22,
    // The view keeps this far from the edges of the work area.
    edgeMargin: 4,
    // The view's bottom edge is this far up the pet: the tail points at the top of the pet's head.
    petAnchor: 0.62,
    defaultSeconds: 12,
    // Fade in, and out when the time is up (Swift pops it up and away; abrupt onsets grab attention the most).
    fadeInMs: 150,
    fadeOutMs: 200,
});

// Where the view goes (Swift: BubbleController.place), as {x, y, tailX}: the top-left of the view in stage pixels,
// and the tail's x from the shape's left edge. `size` is the view's size {width, height}. The view is centered on the
// pet and kept inside the work area; its bottom edge is 62% of the way up the pet, but never above the top of the
// work area.
export function placeBubble({petFrame, size, workArea, unit = 1}) {
    const pad = BUBBLE.pad * unit;
    const margin = BUBBLE.edgeMargin * unit;
    const petCenter = petFrame.x + petFrame.width / 2;
    const maxX = workArea.x + workArea.width - size.width - margin;
    const x = Math.round(Math.max(workArea.x, Math.min(Math.max(petCenter - size.width / 2, workArea.x + margin), maxX)));
    const bottom = petFrame.y + petFrame.height * (1 - BUBBLE.petAnchor);
    const y = Math.round(Math.max(bottom - size.height, workArea.y));
    return {x, y, tailX: petCenter - x - pad};
}

// The quadratic curve p0 -> p1 with control point c, as the cubic one Cairo draws.
export function quadToCubic(p0, c, p1) {
    return {
        c1: {x: p0.x + 2 / 3 * (c.x - p0.x), y: p0.y + 2 / 3 * (c.y - p0.y)},
        c2: {x: p1.x + 2 / 3 * (c.x - p1.x), y: p1.y + 2 / 3 * (c.y - p1.y)},
        to: p1,
    };
}

// The tail under `body` ({x, y, width, height}: the rounded part, without the tail), as in Swift's BubbleShape: it
// starts 9 px left of tailX, half a pixel inside the body, goes down to a tip 10 px under the body (2 px right of
// tailX) and comes back up 9 px right of tailX. tailX is kept 22 px from the body's corners. Returns
// {tailX, start, curves: [{control, to}, {control, to}]}, the x the tail ended up at included.
export function tailCurves(tailX, body, unit = 1) {
    const margin = BUBBLE.tailMargin * unit;
    const tx = Math.min(Math.max(tailX, body.x + margin), body.x + body.width - margin);
    const bottom = body.y + body.height;
    const u = n => n * unit;
    return {
        tailX: tx,
        start: {x: tx - u(9), y: bottom - 0.5 * unit},
        curves: [
            {control: {x: tx - u(2), y: bottom + u(4)}, to: {x: tx + u(2), y: bottom + u(BUBBLE.tail)}},
            {control: {x: tx + u(4), y: bottom + u(2)}, to: {x: tx + u(9), y: bottom - 0.5 * unit}},
        ],
    };
}

// Standard normal tail probabilities Q(k / 4) for k = 0..9, used by shadowLayers().
const NORMAL_TAIL = Object.freeze([0.5, 0.4013, 0.3085, 0.2266, 0.1587, 0.1056, 0.0668, 0.0401, 0.0228, 0.0122]);
const SHADOW_BLACK = 0.22;

// Cairo cannot blur. Swift's shadow (black at 22%, radius 8, 3 px down) is faked with the body grown by 0, 1, ... 8 px,
// each filled with a faint black: a pixel d px outside the body is covered by every layer that grew at least d, so the
// sum follows a Gaussian falling from 11% at the edge to nothing 8 px away. Outermost layer first is the caller's job:
// returns [{grow, alpha}] from the body outward.
export function shadowLayers(unit = 1) {
    const layers = [];
    for (let i = 0; i < NORMAL_TAIL.length - 1; i++)
        layers.push({grow: i * unit, alpha: SHADOW_BLACK * (NORMAL_TAIL[i] - NORMAL_TAIL[i + 1])});
    return layers;
}

// The action buttons in rows, as lists of indexes. Swift puts two in a row (stride(from: 0, to: count, by: 2)) and
// cuts a title short with "…" when the pair is too wide; here a pair that does not fit in `available` (the width of
// the row) goes on two rows instead, so that no title is cut. `widths` are the buttons' natural widths; `spacing`
// the gap between two buttons in a row.
export function packRows(widths, available, spacing = BUBBLE.rowSpacing, perRow = BUBBLE.perRow) {
    const rows = [];
    let row = [];
    let used = 0;
    widths.forEach((width, i) => {
        const needed = row.length === 0 ? width : used + spacing + width;
        if (row.length > 0 && (row.length >= perRow || needed > available)) {
            rows.push(row);
            row = [];
        }
        used = row.length === 0 ? width : used + spacing + width;
        row.push(i);
    });
    if (row.length > 0)
        rows.push(row);
    return rows;
}

// Swift's AppDelegate.showBubble: no bubble without the pet next to it, and none while the board is open, unless it
// is urgent. (A bubble that came while another one is up replaces it, as in Swift: the brain, which holds only one,
// already refused a reply without buttons that would have taken the place of one with buttons.)
export function shouldShowBubble({bubble, petVisible, boardOpen}) {
    if (!petVisible)
        return false;
    return !boardOpen || bubble.urgent === true;
}

// What the brain is told (brain.noteResponse) when `event` happens to `bubble`, or null for nothing. Swift's
// onAction tells it about every tapped button; closing and fading away only count for a reminder (a bubble the pet
// started), not for a reply to something you did.
export function responseFor(event, bubble, action = null) {
    switch (event) {
    case 'picked':
        return typeof action?.title === 'string' ? {picked: action.title} : null;
    case 'closed':
        return bubble.reminder ? 'closed' : null;
    case 'ignored':
        return bubble.reminder ? 'ignored' : null;
    default:
        return null;
    }
}

// How long the bubble stays, in ms: its `seconds`, never extended (hovering does not hold it, as in Swift).
export function bubbleDelayMs(bubble) {
    const seconds = Number.isFinite(bubble.seconds) ? bubble.seconds : BUBBLE.defaultSeconds;
    return Math.max(0, Math.round(seconds * 1000));
}
