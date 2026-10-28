import {PetWalker} from '../extension/ui/walker.js';
import {HOVER_FAST_SECONDS, loopMode} from '../extension/ui/frameRate.js';
import {clampToWorkArea, groundY, petSize} from '../extension/ui/geometry.js';

// The nested shell's work area: a 1600×900 monitor under a 32 px top bar.
const WA = Object.freeze({x: 0, y: 32, width: 1600, height: 868});
const SIZE = 124;
const FRAME = 1 / 30;

// Random numbers from a list, in order (then 0.5 forever).
const sequence = (...values) => () => (values.length > 0 ? values.shift() : 0.5);

const input = (changes = {}) => ({
    mood: 'normal', workArea: WA, pointer: {x: 0, y: 0}, calm: () => false, chase: true, ...changes,
});

// Steps the walker at 30 fps from `from` for `seconds`; returns the time reached.
function run(walker, from, seconds, changes = {}) {
    const frames = Math.round(seconds / FRAME);
    let now = from;
    for (let i = 1; i <= frames; i++) {
        now = from + i * FRAME;
        walker.step(now, input(changes));
    }
    return now;
}

// A walker standing still on the ground at `x`, its idle time over (the next step chooses what to do).
function standing(x, {random = sequence(), size = SIZE} = {}) {
    const walker = new PetWalker({size, random});
    walker.place(x, walker.ground(WA));
    walker.step(0, input());
    walker.behavior = {kind: 'idle', until: 0};
    return walker;
}

export default async function (t) {
    // --- geometry.js (brief) ---
    t.eq(clampToWorkArea(-50, 120, {x: 0, y: 32, width: 1600, height: 868}), 0, 'clamp left');
    t.eq(clampToWorkArea(1590, 120, {x: 0, y: 32, width: 1600, height: 868}), 1480, 'clamp right');
    t.eq(clampToWorkArea(700, 120, {x: 1600, y: 0, width: 1920, height: 1080}), 1600, 'monitor moved');
    t.eq(groundY({x: 0, y: 32, width: 1600, height: 868}, 120), 780, 'ground');

    t.eq(clampToWorkArea(700, 120, WA), 700, 'a pet inside the work area stays where it is');
    t.eq(clampToWorkArea(50, 300, {x: 10, y: 0, width: 200, height: 200}), 10,
        'a pet wider than the work area sticks to its left edge');
    t.eq(petSize(1, 1), 124, 'Swift size: 124 points at scale 1');
    t.eq(petSize(1.5, 2), 372, 'size grows with the pet scale and the stage scale');
    t.eq([petSize(0.1, 1), petSize(5, 1)], [74, 248], 'the pet scale is clamped to 0.6–2.0, as in Swift');
    t.eq(petSize(Number.NaN, 1), 124, 'a pet scale that is not a number counts as 1');

    // --- frameRate.js: the animation budget ---
    {
        const still = {shown: true, moving: false, hoveredFor: null, mood: 'normal', paintedMood: 'normal', blend: 1};
        t.eq(loopMode(still), 'slow', 'standing still: the slow loop (4 fps)');
        t.eq(loopMode({...still, shown: false}), 'off', 'hidden (or unmapped): no loop');
        t.eq(loopMode({...still, shown: false, moving: true}), 'off', 'hidden wins over moving');
        t.eq(loopMode({...still, moving: true}), 'fast', 'moving: the fast loop (30 fps)');
        t.eq(loopMode({...still, hoveredFor: 0}), 'fast', 'the pointer just came onto the pet: fast for the petted look');
        t.eq(loopMode({...still, hoveredFor: HOVER_FAST_SECONDS - 0.01}), 'fast', 'for a short while');
        t.eq(loopMode({...still, hoveredFor: HOVER_FAST_SECONDS}), 'slow', 'a pet under a parked pointer drops to 4 fps');
        t.check(HOVER_FAST_SECONDS >= 1.7 && HOVER_FAST_SECONDS <= 3,
            `the fast hover lasts one rise of the heart (1.7 s) and not much more (${HOVER_FAST_SECONDS} s)`);
        t.eq(loopMode({...still, mood: 'celebrating', paintedMood: 'celebrating'}), 'fast', 'celebrating: fast');
        t.eq(loopMode({...still, mood: 'happy'}), 'fast', 'a mood not painted yet: fast (its colors blend in)');
        t.eq(loopMode({...still, blend: 0.5}), 'fast', 'while the colors blend: fast');
    }

    // --- walker.js: PetController.step/chooseNext/speed/idleTime ---
    {
        const w = new PetWalker({size: SIZE});
        w.start(WA);
        t.eq([w.x, w.y], [1600 - 124 - 140, 900 - 300 - 124], 'starts 140 px from the right edge, 300 px up');
        t.eq(w.behavior.kind, 'fall', 'and falls');
        t.eq(w.ground(WA), 776 + 6, 'the ground is groundY sunk by 5% of the size (feet on the edge, as in Swift)');
        let now = 0;
        while (w.behavior.kind === 'fall' && now < 3)
            now = run(w, now, FRAME);
        t.near(now, Math.sqrt(2 * (782 - 476) / 2200), 0.05, 'lands after a free fall at 2200 px/s²');
        t.eq([w.y, w.vy, w.behavior.kind], [782, 0, 'idle'], 'stands on the ground, at rest');
        t.near(w.behavior.until - now, 0.8, 1e-9, 'and rests 0.8 s after landing');
        t.check(!w.active, 'resting is not "active" (slow repaint)');
    }

    {
        const w = standing(800);
        w.walkTo(500);
        const now = run(w, 0, 1);
        t.near(800 - w.x, 38, 0.6, 'a normal pet walks 38 px/s');
        t.eq([w.motion.facing, w.motion.walking], [-1, true], 'facing where it walks, legs moving');
        t.near(w.motion.walkPhase, 9, 0.2, 'the walk phase moves 9 per second at the base speed');
        t.check(w.active, 'walking is "active" (fast repaint)');
        run(w, now, 10);
        t.near(w.x, 500, 2, 'stops at the target (within 2 px, as in Swift)');
        t.eq([w.motion.walking, w.behavior.kind], [false, 'idle'], 'and stands there');
    }

    for (const [mood, speed] of [['happy', 58], ['annoyed', 22], ['angry', 70], ['focus', 38]]) {
        const w = standing(800);
        w.walkTo(1200);
        run(w, 0, 1, {mood});
        t.near(w.x - 800, speed, 0.6, `a ${mood} pet walks ${speed} px/s`);
    }

    {
        const w = standing(800, {size: 248});
        w.walkTo(1200);
        run(w, 0, 1);
        t.near(w.x - 800, 76, 1, 'a pet twice as big walks twice as fast');
        t.near(w.motion.walkPhase, 9, 0.2, 'with the same leg rhythm');
    }

    for (const mood of ['sleeping', 'celebrating']) {
        const w = standing(800);
        w.walkTo(500);
        run(w, 0, 0.5, {mood});
        t.eq([w.x, w.motion.walking, w.behavior.kind], [800, false, 'idle'], `a ${mood} pet does not walk`);
    }

    {
        const w = standing(800);
        w.walkTo(500);
        w.motion.hovered = true;
        run(w, 0, 0.5);
        t.eq([w.x, w.motion.walking, w.behavior.kind], [800, false, 'idle'], 'hovering stops the walk');
        run(w, 0.5, 5);
        t.eq(w.behavior.kind, 'idle', 'and no new walk starts while hovered');

        const p = standing(800);
        p.walkTo(500);
        p.paused = true;
        run(p, 0, 0.5);
        t.eq([p.x, p.behavior.kind], [800, 'idle'], 'a paused pet (bubble or board open) stands still');
    }

    {
        let reads = 0;
        const w = new PetWalker({size: SIZE, random: sequence()});
        w.place(800, w.ground(WA));
        run(w, 0, 2, {calm: () => {
            reads += 1;
            return true;
        }});
        t.eq([w.x, w.behavior.kind], [800, 'idle'], 'while you type the pet does not wander off');
        t.near(w.behavior.until, FRAME + 0.8 + 2, 0.05, 'it looks again 2 s later');
        t.eq(reads, 4, 'the calm state is read every 0.5 s, not on every frame');
        // A walk the pet chose itself trusts the last reading (at most 0.5 s old).
        w.behavior = {kind: 'walk', toX: 500};
        w.step(2.05, input());
        t.eq([w.behavior.kind, w.motion.calm], ['idle', true], 'a walk under way stops while the last reading says calm');
        // An asked-for walk (walkTo) reads the calm state again on the next step, so it is not lost to a stale reading.
        w.walkTo(500);
        w.step(2.1, input());
        t.eq([w.behavior.kind, w.motion.calm], ['walk', false], 'walkTo reads the calm state again at once');
    }

    {
        const w = standing(800, {random: sequence(0.1)});
        w.step(0.1, input({mood: 'angry', pointer: {x: 300, y: 500}}));
        t.eq(w.behavior, {kind: 'walk', toX: 300 - 62}, 'an angry pet marches toward the pointer');

        const edge = standing(800, {random: sequence(0.1)});
        edge.step(0.1, input({mood: 'angry', pointer: {x: 1590, y: 500}}));
        t.eq(edge.behavior.toX, 1600 - 124 - 10, 'but stays 10 px inside the work area');

        const calm = standing(800, {random: sequence(0.7, 0.9)});
        calm.step(0.1, input({mood: 'angry', pointer: {x: 300, y: 500}}));
        t.eq(calm.behavior.kind, 'idle', 'only about 65% of the time (then it may just stand)');

        const off = standing(800, {random: sequence(0.1, 0, 0.9)});
        off.step(0.1, input({mood: 'angry', chase: false, pointer: {x: 300, y: 500}}));
        t.eq(off.behavior, {kind: 'walk', toX: 800 - 80}, 'with chasing off it wanders like a normal pet');
    }

    {
        const w = standing(800);
        w.step(0.1, input({mood: 'focus'}));
        t.eq(w.behavior, {kind: 'walk', toX: 1600 - 124 - 10 - 20}, 'in focus it walks to a quiet corner');
        const there = standing(1446);
        there.step(0.1, input({mood: 'focus'}));
        t.eq(there.behavior, {kind: 'idle', until: 5.1}, 'and sits there');
    }

    {
        const w = standing(800, {random: sequence(0.1, 0, 0.2)});
        w.step(0.1, input());
        t.eq(w.behavior, {kind: 'walk', toX: 880}, 'a normal pet wanders 80–320 px (55% of the time)');
        const far = standing(800, {random: sequence(0.5, 1, 0.9)});
        far.step(0.1, input());
        t.eq(far.behavior, {kind: 'walk', toX: 480}, 'up to 320 px, either way');
        const lazy = standing(800, {random: sequence(0.6, 0)});
        lazy.step(0.1, input());
        t.eq(lazy.behavior, {kind: 'idle', until: 3.1}, 'otherwise it idles 3–7 s');
        const grumpy = standing(800, {random: sequence(0.31, 1)});
        grumpy.step(0.1, input({mood: 'annoyed'}));
        t.eq(grumpy.behavior, {kind: 'idle', until: 9.1}, 'an annoyed pet walks only 30% of the time, idles 5–9 s');
        const happy = standing(800, {random: sequence(0.69, 0, 0)});
        happy.step(0.1, input({mood: 'happy'}));
        t.eq(happy.behavior.kind, 'walk', 'a happy pet walks 70% of the time');
        const sleepy = standing(800, {random: sequence(0)});
        sleepy.step(0.1, input({mood: 'sleeping'}));
        t.eq(sleepy.behavior, {kind: 'idle', until: 5.1}, 'a sleeping pet stays put');
    }

    {
        const w = standing(800);
        const ground = w.y;
        w.grab();
        t.eq([w.behavior.kind, w.motion.held, w.motion.walking], ['held', true, false], 'grabbed: held, legs still');
        w.dragTo(-60, ground - 300);
        run(w, 0, 0.5);
        t.eq([w.x, w.y], [-60, ground - 300], 'held: follows the pointer, even past the work area');
        t.check(w.active, 'held is "active"');
        w.release();
        t.eq([w.motion.held, w.behavior.kind, w.vy], [false, 'fall', 0], 'released: falls');
        const now = run(w, 0.5, 1);
        t.eq([w.x, w.y, w.behavior.kind], [0, ground, 'idle'], 'and lands on the ground inside the work area');
        t.check(now > 0.5, 'time moved on');
    }

    {
        const w = standing(700);
        w.settle({x: 1600, y: 0, width: 1920, height: 1080});
        t.eq([w.x, w.y], [1600, 1080 - 124 + 6], 'when the monitor moves, the pet moves onto it');
        const walking = standing(700);
        walking.walkTo(300);
        walking.settle(WA);
        t.eq(walking.behavior.kind, 'fall', 'a walk is dropped when the work area changes');
        const held = standing(700);
        held.grab();
        held.dragTo(-100, 100);
        held.settle(WA);
        t.eq([held.x, held.y], [-100, 100], 'a held pet stays in your hand');
    }

    {
        // A sleeping pet stays put, so its eyes keep following.
        const w = standing(800);
        w.step(0.1, input({mood: 'sleeping', pointer: {x: 1600, y: 500}}));
        t.near(w.motion.lookX, 0.4, 0.05, 'the eyes turn toward the pointer (eased)');
        run(w, 0.1, 2, {mood: 'sleeping', pointer: {x: 1600, y: 500}});
        t.near(w.motion.lookX, 1, 0.01, 'and settle on it (full turn 300 px away)');
        run(w, 2.1, 2, {mood: 'sleeping', pointer: {x: 862 - 150, y: 500}});
        t.near(w.motion.lookX, -0.5, 0.01, 'half a turn 150 px away');
    }

    {
        let ended = 0;
        const w = standing(1000);
        w.onAnticEnded = () => (ended += 1);
        w.startParade(WA);
        t.eq(w.behavior, {kind: 'parade', toX: 10}, 'a parade marches to the far side');
        t.check(w.isInAntic, 'a parade is an antic');
        run(w, 0, 1, {mood: 'sleeping'});
        t.near(1000 - w.x, 95, 0.6, 'at 95 px/s whatever the mood');
        run(w, 1, 15, {mood: 'sleeping'});
        t.near(w.x, 10, 2, 'and ends there');
        t.eq([w.behavior.kind, ended], ['idle', 1], 'reporting the end once');
        t.eq(w.endAntic(), false, 'endAntic outside an antic does nothing');
        t.eq(ended, 1, 'and reports nothing');
    }

    {
        let ended = 0;
        const w = standing(300);
        w.onAnticEnded = () => (ended += 1);
        const ground = w.y;
        w.startBlock(WA, 0);
        const mid = 32 + 434 - 62;
        w.step(0.35, input());
        t.check(w.y < (ground + mid) / 2 - 100, `a block leaps up in an arc (y ${w.y})`);
        run(w, 0.35, 1);
        t.near(w.x, 800 - 62, 1e-6, 'and lands in the middle of the work area');
        t.near(w.y, mid, 1e-6, 'halfway up');
        t.eq(w.behavior.kind, 'perch', 'where it perches');
        t.check(!w.active, 'perching is still (slow repaint)');
        run(w, 1.35, 1);
        t.near(w.y, mid, 1e-6, 'the perch is not pulled to the ground');
        t.eq([w.endAntic(), w.behavior.kind, ended], [true, 'fall', 1], 'endAntic: falls back down and reports it');
        const late = standing(300);
        late.onAnticEnded = () => (ended += 1);
        late.startBlock(WA, 0);
        run(late, 0, 21);
        t.eq([late.behavior.kind, ended], ['fall', 2], 'a perch ends by itself after 20 s');
    }

    {
        const w = standing(100);
        w.comeHere(WA);
        t.eq([w.x, w.y, w.behavior.kind], [800 - 62, 900 - 200 - 124, 'fall'], 'come here: drops in the middle');
    }
}
