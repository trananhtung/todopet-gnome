import {
    BUBBLE, bubbleDelayMs, packRows, placeBubble, quadToCubic, responseFor, shadowLayers, shouldShowBubble,
    tailCurves,
} from '../extension/ui/bubbleLogic.js';

// The nested shell's work area: a 1600×900 monitor under a 32 px top bar.
const WA = Object.freeze({x: 0, y: 32, width: 1600, height: 868});
// A 124 px pet standing on the bottom edge, in the middle of the screen.
const PET = Object.freeze({x: 738, y: 782, width: 124, height: 124});
// The bubble view's size: the shape is 270 wide, the 10 px of room for the shadow are on every side.
const SIZE = Object.freeze({width: 290, height: 140});

const bubble = (changes = {}) => ({
    id: 'bubble-1', text: 'Hi', actions: [], seconds: 12, urgent: false, reminder: false, ...changes,
});

export default async function (t) {
    // --- placeBubble (Swift: BubbleController.place) ---
    {
        const p = placeBubble({petFrame: PET, size: SIZE, workArea: WA});
        t.eq(p.x, 800 - 145, 'centered on the pet');
        // The view's bottom edge is 62% of the way up the pet: 782 + 0.38 × 124 = 829.12
        t.eq(p.y, Math.round(782 + 124 * 0.38 - 140), 'its bottom edge is 62% up the pet');
        // The tail points at the pet's center, measured from the shape's left edge (10 px in).
        t.eq(p.tailX, 800 - p.x - 10, 'the tail is under the pet\'s center');
        t.eq(p.tailX, 145 - 10, 'a centered bubble has its tail in the middle');
    }
    {
        const p = placeBubble({petFrame: {...PET, x: 0}, size: SIZE, workArea: WA});
        t.eq(p.x, 4, 'a pet at the left edge: the bubble keeps 4 px from the edge');
        t.eq(p.tailX, 62 - 4 - 10, 'and the tail still points at the pet');
    }
    {
        const p = placeBubble({petFrame: {...PET, x: 1476}, size: SIZE, workArea: WA});
        t.eq(p.x, 1600 - 290 - 4, 'a pet at the right edge: 4 px from the right edge');
        t.eq(p.tailX, 1538 - p.x - 10, 'the tail follows the pet');
    }
    {
        const p = placeBubble({petFrame: {...PET, y: 40}, size: SIZE, workArea: WA});
        t.eq(p.y, 32, 'a pet high up: the bubble stops at the top of the work area');
        const q = placeBubble({petFrame: {...PET, y: 300}, size: SIZE, workArea: WA});
        t.eq(q.y, Math.round(300 + 124 * 0.38 - 140), 'a pet in the middle of the screen: the bubble is above it');
    }
    {
        const wa = {x: 1600, y: 0, width: 1920, height: 1080};
        const p = placeBubble({petFrame: {x: 1600, y: 950, width: 124, height: 124}, size: SIZE, workArea: wa});
        t.eq(p.x, 1604, 'the work area does not have to start at 0');
        const scaled = placeBubble({petFrame: {x: 0, y: 700, width: 248, height: 248}, size: {width: 580, height: 280},
            workArea: {x: 0, y: 0, width: 3200, height: 1800}, unit: 2});
        t.eq([scaled.x, scaled.tailX], [8, 124 - 8 - 20], 'the margin and the shadow room scale with the stage');
    }
    t.eq(placeBubble({petFrame: PET, size: {width: 900, height: 100}, workArea: {x: 0, y: 0, width: 600, height: 800}}).x,
        0, 'a bubble wider than the work area sticks to its left edge');

    // --- tailCurves (Swift: BubbleShape.path) ---
    {
        const body = {x: 10, y: 10, width: 270, height: 100};
        const tail = tailCurves(135, body);
        t.eq(tail.tailX, 135, 'a tail inside the body stays where it is');
        t.eq(tail.start, {x: 126, y: 109.5}, 'the tail starts 9 px left of its x, half a pixel inside the body');
        t.eq(tail.curves, [
            {control: {x: 133, y: 114}, to: {x: 137, y: 120}},
            {control: {x: 139, y: 112}, to: {x: 144, y: 109.5}},
        ], 'two quadratic curves down to the tip, 10 px under the body, and back');
        t.eq(tailCurves(0, body).tailX, 32, 'the tail keeps 22 px from the left edge of the body');
        t.eq(tailCurves(1000, body).tailX, 258, 'and 22 px from the right edge');
        t.eq(tailCurves(135, body, 2).curves[0].to.y, 130, 'a tail at twice the scale is twice as tall');
        t.eq(tailCurves(0, body, 2).tailX, 54, 'and keeps twice the distance from the corners');
    }
    {
        const c = quadToCubic({x: 0, y: 0}, {x: 3, y: 0}, {x: 3, y: 3});
        t.eq(c, {c1: {x: 2, y: 0}, c2: {x: 3, y: 1}, to: {x: 3, y: 3}}, 'a quadratic curve as a cubic one');
    }

    // --- the shadow (Swift: .shadow(color: .black.opacity(0.22), radius: 8, y: 3)) ---
    {
        const layers = shadowLayers(1);
        t.eq(layers.length, 9, 'nine layers fake a blur of radius 8');
        t.eq(layers.map(l => l.grow), [0, 1, 2, 3, 4, 5, 6, 7, 8], 'growing one pixel at a time');
        t.check(layers.every((l, i) => i === 0 || l.alpha < layers[i - 1].alpha), 'each layer fainter than the one inside');
        const edge = layers.reduce((sum, l) => sum + l.alpha, 0);
        t.near(edge, 0.22 * 0.5, 0.012, 'at the edge, half of the 22% black is left');
        t.eq(shadowLayers(2).map(l => l.grow), [0, 2, 4, 6, 8, 10, 12, 14, 16], 'the layers grow with the stage scale');
    }

    // --- the action buttons: two to a row when they fit ---
    t.eq(packRows([], 242), [], 'no actions, no rows');
    t.eq(packRows([80], 242), [[0]], 'one action: one row');
    t.eq(packRows([90, 60], 242), [[0, 1]], 'two actions fit in a row');
    t.eq(packRows([90, 60, 70], 242), [[0, 1], [2]], 'three actions: a pair and a single');
    t.eq(packRows([50, 50, 50, 50, 50], 242), [[0, 1], [2, 3], [4]], 'five actions: three rows, two to a row');
    t.eq(packRows([90, 60, 70, 50], 242), [[0, 1], [2, 3]], 'two pairs');
    t.eq(packRows([120, 116], 242), [[0, 1]], 'a pair that just fits stays together (120 + 6 + 116 = 242)');
    t.eq(packRows([120, 117], 242), [[0], [1]], 'a pair one pixel too wide is split');
    t.eq(packRows([150, 150, 40], 242), [[0], [1, 2]], 'the next pair starts where the split left off');
    t.eq(packRows([300, 50], 242), [[0], [1]], 'a button wider than the row has the row to itself');
    t.eq(packRows([30, 30, 30], 242, 6, 3), [[0, 1, 2]], 'perRow can be raised');

    // --- when a bubble is shown (Swift: AppDelegate.showBubble) ---
    t.check(shouldShowBubble({bubble: bubble(), petVisible: true, boardOpen: false}), 'a bubble shows next to a visible pet');
    t.check(!shouldShowBubble({bubble: bubble(), petVisible: false, boardOpen: false}), 'no bubble when the pet is hidden');
    t.check(!shouldShowBubble({bubble: bubble(), petVisible: true, boardOpen: true}), 'no bubble while the board is open');
    t.check(shouldShowBubble({bubble: bubble({urgent: true}), petVisible: true, boardOpen: true}),
        'except an urgent one');
    t.check(!shouldShowBubble({bubble: bubble({urgent: true}), petVisible: false, boardOpen: true}),
        'but never without the pet');

    // --- what the bubble reports (Swift: onAction, onClose, the hide timer) ---
    const action = {title: 'Later', primary: false, run: () => {}};
    t.eq(responseFor('picked', bubble(), action), {picked: 'Later'}, 'a tapped button is reported with its title');
    t.eq(responseFor('picked', bubble({reminder: true}), action), {picked: 'Later'}, 'for a reminder too');
    t.eq(responseFor('closed', bubble({reminder: true})), 'closed', 'closing a reminder is reported');
    t.eq(responseFor('closed', bubble()), null, 'closing a reply to something you did is not');
    t.eq(responseFor('ignored', bubble({reminder: true})), 'ignored', 'a reminder that faded away was ignored');
    t.eq(responseFor('ignored', bubble()), null, 'a reply that faded away is not reported');
    t.eq(responseFor('picked', bubble()), null, 'a pick without its button is not reported');
    t.eq(responseFor('nonsense', bubble({reminder: true})), null, 'an unknown event is not reported');

    // --- how long a bubble stays ---
    t.eq(bubbleDelayMs(bubble({seconds: 12})), 12000, 'a bubble stays for its seconds');
    t.eq(bubbleDelayMs(bubble({seconds: 0.5})), 500, 'fractions of a second count');
    t.eq(bubbleDelayMs(bubble({seconds: Number.NaN})), 12000, 'no number: the default 12 seconds');
    t.eq(bubbleDelayMs(bubble({seconds: -3})), 0, 'a negative time is over at once');
    t.eq(BUBBLE.width, 270, 'Swift\'s BubbleView.width');
    t.check(BUBBLE.width + 2 * BUBBLE.pad <= 320, 'the whole bubble is at most 320 px wide');
}
