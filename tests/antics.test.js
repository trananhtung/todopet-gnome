// The pet's stunts and celebrations on screen (Task 21): the pure timelines and shapes in ui/anticsLogic.js, their
// drawing in ui/anticsArt.js, the grumble in the walker, the sign's layout cache, and the brain's dev-trigger hooks.
import Cairo from 'cairo';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';

import {getLang, setLang} from '../extension/core/l10n.js';
import {setLinesRandom} from '../extension/core/lines.js';
import {Mood} from '../extension/core/mood.js';
import * as petArt from '../extension/art/petArt.js';
import {
    CONFETTI, FIREWORKS, GRUMBLE, badgeLook, badgeSide, burstAt, celebrationPlan, comboBadge, confettiAt,
    confettiPieces, dustPuffs, effectBox, fireworkBursts, fireworksSeconds, grumbleAt, seededRandom, sighPuffs,
    signFrame,
} from '../extension/ui/anticsLogic.js';
import {drawCelebration, drawGrumble} from '../extension/ui/anticsArt.js';
import {PetWalker} from '../extension/ui/walker.js';
import {at, makeBrain, task} from './helpers.js';

const WA = Object.freeze({x: 0, y: 32, width: 1600, height: 868});
const PET = Object.freeze({x: 700, y: 782, width: 124, height: 124});
const FRAME = 1 / 30;
const SPARE = 'Spare me 15\'';

const input = (changes = {}) => ({
    mood: 'annoyed', workArea: WA, pointer: {x: 0, y: 0}, calm: () => false, chase: false, ...changes,
});

// Draws on a transparent surface and returns how many pixels are not transparent, and whether the caller's
// transform came back untouched.
function paint(width, height, draw) {
    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, width, height);
    const cr = new Cairo.Context(surface);
    let identity;
    try {
        draw(cr);
        const [x, y] = cr.userToDevice(10, 20);
        identity = x === 10 && y === 20;
    } finally {
        cr.$dispose();
    }
    const dir = GLib.dir_make_tmp('todopet-antics-XXXXXX');
    const file = GLib.build_filenamev([dir, 'frame.png']);
    surface.writeToPNG(file);
    surface.finish();
    const pixbuf = GdkPixbuf.Pixbuf.new_from_file(file);
    GLib.unlink(file);
    GLib.rmdir(dir);
    const pixels = pixbuf.get_pixels();
    const stride = pixbuf.get_rowstride();
    const channels = pixbuf.get_n_channels();
    let opaque = 0;
    const alpha = (px, py) => (channels === 4 ? pixels[py * stride + px * channels + 3] : 255);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (alpha(x, y) > 0)
                opaque++;
        }
    }
    return {opaque, identity, alpha};
}

export default async function (t) {
    const savedLang = getLang();
    setLang('en');
    setLinesRandom(() => 0);
    try {
        sign(t);
        signCache(t);
        grumble(t);
        walkerGrumble(t);
        celebrations(t);
        confetti(t);
        fireworks(t);
        drawing(t);
        await devHooks(t);
    } finally {
        setLang(savedLang);
        setLinesRandom();
    }
}

// SignController.follow: the sign trails the pet on the side it walks away from, its rope toward the pet, its bottom
// 18% up the pet.
function sign(t) {
    const size = {width: 271, height: 45};
    const right = signFrame(PET, 1, size);
    t.eq(right, {x: 700 - 271 + 25, y: 782 + 102 - 45, ropeOnRight: true},
        'walking right: the sign is on the left, rope on its right, 20% of the pet under it');
    const left = signFrame(PET, -1, size);
    t.eq(left, {x: 700 + 124 - 25, y: 782 + 102 - 45, ropeOnRight: false},
        'walking left: the sign is on the right, rope on its left');
    const big = signFrame({x: 100.4, y: 500, width: 248, height: 248}, 1, {width: 542, height: 90});
    t.eq(big, {x: 100 - 542 + 50, y: 500 + 203 - 90, ropeOnRight: true}, 'at scale 2 the same proportions, whole pixels');
    t.eq(signFrame(PET, 0, size).ropeOnRight, false, 'not walking yet (facing 0): rope on the left, as Swift (facing > 0)');
}

// The sign's text layout is kept for the last text (one sign on screen at a time).
function signCache(t) {
    const first = petArt.signGeometry('Write the weekly report');
    t.check(petArt.signGeometry('Write the weekly report') === first, 'the same text reuses the laid-out sign');
    const other = petArt.signGeometry('Call the bank');
    t.check(other !== first, 'a new text is laid out');
    t.check(petArt.signGeometry('Call the bank') === other, 'and is kept in its place');
    t.check(petArt.signGeometry('Write the weekly report') !== first, 'one entry: the old text was dropped');
    const size = petArt.signSize('Write the weekly report');
    t.eq([size.width, size.height], [petArt.signGeometry('Write the weekly report').width,
        petArt.signGeometry('Write the weekly report').height], 'signSize reads the cached geometry');
}

// Grumble: a sigh, then four stomps on alternate feet, a rest, done.
function grumble(t) {
    t.eq(GRUMBLE.seconds, 3.6, 'a grumble lasts 3.6 s');
    const start = grumbleAt(0);
    t.check(!start.done && start.hop === 0 && !start.walking && start.sigh === 0, 'it starts with a sigh, standing');
    t.check(grumbleAt(0.6).sigh > 0.4 && grumbleAt(0.6).hop === 0, 'the sigh goes on with the feet on the ground');
    t.eq(grumbleAt(GRUMBLE.sigh).sigh, null, 'then the sigh is over');
    const hops = [];
    for (let s = GRUMBLE.sigh; s < GRUMBLE.seconds; s += 0.01)
        hops.push(grumbleAt(s).hop);
    const top = Math.max(...hops);
    t.near(top, GRUMBLE.hop, 0.05, 'each stomp lifts the pet 6 points');
    const ups = hops.filter((h, i) => i > 0 && h > 0 && hops[i - 1] === 0).length;
    t.eq(ups, GRUMBLE.stomps, 'four stomps');
    const feet = [0, 1, 2, 3].map(k => Math.sign(grumbleAt(GRUMBLE.sigh + (k + 0.3) * GRUMBLE.stomp).walkPhase));
    t.eq(feet, [1, -1, 1, -1], 'on alternate feet');
    t.check([0, 1, 2, 3].every(k => grumbleAt(GRUMBLE.sigh + (k + 0.3) * GRUMBLE.stomp).walking),
        'the lifted foot comes from the walking legs');
    const landing = GRUMBLE.sigh + 0.75 * GRUMBLE.stomp;
    t.eq(grumbleAt(landing - 0.01).dust.length, 0, 'no dust before the first stomp lands');
    const dust = grumbleAt(landing + 0.1).dust;
    t.check(dust.length === 1 && dust[0].side === -1 && dust[0].k > 0 && dust[0].k < 1, 'dust puffs up under the stomping foot');
    t.eq(grumbleAt(landing + GRUMBLE.dust + 0.01).dust.length, 0, 'and settles');
    const rest = grumbleAt(GRUMBLE.seconds - 0.1);
    t.check(!rest.done && rest.hop === 0 && !rest.walking, 'a short rest after the stomps');
    t.check(grumbleAt(GRUMBLE.seconds).done, 'then it is over');

    const puffs = sighPuffs(0.4, 1);
    t.check(puffs.length >= 1 && puffs.every(p => p.x > 0.5 && p.alpha > 0 && p.alpha <= 1),
        'the sigh puffs out toward the side asked for');
    t.check(sighPuffs(0.4, -1).every(p => p.x < 0.5), 'or the other side');
    t.eq(sighPuffs(0, 1).length, 0, 'nothing comes out at the very start');
    const late = sighPuffs(0.99, 1);
    t.check(late.every(p => p.alpha < 0.2), 'and the puffs have faded by the end');
    const d = dustPuffs([{side: 1, k: 0.2}]);
    t.check(d.length >= 2 && d.every(p => p.y > 0.78 && p.y < 0.92 && p.alpha > 0) &&
        d.reduce((sum, p) => sum + p.x, 0) / d.length > 0.6, 'dust is around the stomping foot');
    const left = dustPuffs([{side: -1, k: 0.9}]);
    t.check(left.every(p => p.y < dustPuffs([{side: -1, k: 0.1}])[0].y) && left.reduce((sum, p) => sum + p.x, 0) / left.length < 0.4,
        'and rises as it fades, around the left foot for a left stomp');
}

function walkerGrumble(t) {
    const walker = new PetWalker({size: 124, random: () => 0.99});
    walker.place(700, walker.ground(WA));
    walker.step(0, input());
    walker.behavior = {kind: 'idle', until: 100};
    let ended = 0;
    walker.onAnticEnded = () => ended++;
    t.check(walker.startGrumble(1), 'a standing pet starts grumbling');
    t.check(walker.isInAntic && walker.active, 'the grumble is an antic (a click calls it off) and moves (fast frames)');
    const ground = walker.ground(WA);
    let highest = ground, lowest = ground, xs = new Set();
    let now = 1;
    for (let i = 1; i <= Math.round(GRUMBLE.seconds / FRAME) - 1; i++) {
        now = 1 + i * FRAME;
        walker.step(now, input());
        highest = Math.min(highest, walker.y);
        lowest = Math.max(lowest, walker.y);
        xs.add(walker.x);
    }
    t.check(walker.behavior.kind === 'grumble' && ended === 0, 'it grumbles for 3.6 s');
    t.check(ground - highest >= 5 && lowest === ground, `it hops up to 6 points and lands on the ground (${ground - highest})`);
    t.eq([...xs], [700], 'in place');
    walker.step(now + 2 * FRAME, input());
    t.check(ended === 1 && walker.behavior.kind !== 'grumble' && !walker.isInAntic, 'then it is over and the app is told once');
    walker.step(now + 3 * FRAME, input());
    t.check(walker.y === ground && walker.behavior.kind === 'idle', 'standing on the ground again');

    const held = new PetWalker({size: 124});
    held.place(700, 300);
    held.grab();
    t.check(!held.startGrumble(0) && held.behavior.kind === 'held', 'a pet in your hand does not stomp');
    t.check(!held.startParade(WA) && !held.startBlock(WA, 0) && held.behavior.kind === 'held',
        'nor does it march or leap out of your hand');
    const parading = new PetWalker({size: 124});
    parading.place(700, parading.ground(WA));
    parading.startParade(WA);
    t.check(!parading.startGrumble(0) && parading.behavior.kind === 'parade', 'nor one already on a stunt');

    const cut = new PetWalker({size: 124});
    cut.place(700, cut.ground(WA));
    cut.step(0, input());
    let cutEnded = 0;
    cut.onAnticEnded = () => cutEnded++;
    cut.startGrumble(0);
    cut.step(GRUMBLE.sigh + 0.15, input());
    cut.step(GRUMBLE.sigh + 0.2, input());
    t.check(cut.y < cut.ground(WA), 'mid-stomp the pet is in the air');
    t.check(cut.endAntic() && cutEnded === 1 && cut.behavior.kind === 'fall', 'a click cuts the grumble short: it drops');
    cut.settle(WA);
    t.check(cut.behavior.kind === 'fall', 'settling a cut grumble leaves it falling');
    // Picking the pet up, or calling it over, ends a stunt like a click does: the app hears of it once.
    const picked = new PetWalker({size: 124});
    picked.place(700, picked.ground(WA));
    picked.step(0, input());
    let pickedEnded = 0;
    picked.onAnticEnded = () => pickedEnded++;
    picked.startParade(WA);
    picked.grab();
    picked.release();
    t.check(pickedEnded === 1 && picked.behavior.kind === 'fall' && !picked.isInAntic, 'a parading pet picked up stops parading');
    picked.step(1, input());
    picked.startBlock(WA, 1);
    picked.comeHere(WA);
    t.check(pickedEnded === 2 && picked.behavior.kind === 'fall', 'calling a perched pet over ends the block');
    picked.grab();
    picked.release();
    picked.comeHere(WA);
    t.eq(pickedEnded, 2, 'without a stunt there is nothing to end');

    const settling = new PetWalker({size: 124});
    settling.place(700, settling.ground(WA));
    settling.step(0, input());
    settling.startGrumble(0);
    settling.settle({...WA, height: 800});
    t.eq(settling.y, settling.ground({...WA, height: 800}), 'a work-area change keeps a grumbling pet on the ground');
}

function celebrations(t) {
    const jump = celebrationPlan({kind: 'jump', golden: false, combo: 1}, 4);
    t.eq([jump.effect, jump.golden, jump.badge, jump.seconds], ['confetti', false, null, CONFETTI.seconds],
        'a dance gets confetti, no badge, gone when the confetti is');
    const fw = celebrationPlan({kind: 'fireworks', golden: false, combo: 3}, 4);
    t.eq([fw.effect, fw.badge, fw.seconds], ['fireworks', '×3', 4], 'a ×3 combo: fireworks and a ×3 badge for the 4 s dance');
    const gold = celebrationPlan({kind: 'fireworks', golden: true, combo: 1}, 5);
    t.eq([gold.effect, gold.golden, gold.badge, gold.seconds], ['fireworks', true, null, fireworksSeconds(true)],
        'a golden treat: golden fireworks');
    t.eq(celebrationPlan({kind: 'spin', golden: true, combo: 2}, 5).effect, 'fireworks', 'golden always means fireworks');
    t.eq(celebrationPlan({kind: 'spin', combo: 2}, NaN).seconds, 4, 'a missing length counts as 4 s');
    t.eq(celebrationPlan({kind: 'spin', combo: 2}, 60).seconds, 8, 'and a silly one is capped');
    t.eq([comboBadge(1), comboBadge(2), comboBadge(7)], [null, '×2', '×7'], 'the badge counts the combo from ×2');

    const early = badgeLook(0.05, 4);
    t.check(early.scale === 0 && early.alpha === 0, 'the badge is not there at first');
    const pop = badgeLook(0.4, 4);
    t.check(pop.scale > 1 && pop.alpha === 1, 'it pops in, a little too big');
    t.near(badgeLook(1.5, 4).scale, 1, 1e-9, 'then settles');
    t.check(badgeLook(3.8, 4).alpha < 1 && badgeLook(3.8, 4).alpha > 0, 'it fades at the end');
    t.eq(badgeLook(4.2, 4).alpha, 0, 'and is gone');

    const box = effectBox(PET);
    t.eq(box, {x: 700 - 149, y: 782 - 236, width: 422, height: 360, petX: 149, petY: 236, size: 124},
        'the effects fill 3.4 × 2.9 pet sizes above and around the pet');
    const small = effectBox(PET, {left: 0.8, right: 0.8, top: 0.3, bottom: 0.1});
    t.eq([small.petX, small.petY, small.width, small.height], [99, 37, 322, 174], 'or a smaller box when asked');
    t.eq(badgeSide(PET, WA), 1, 'left of the middle: the badge goes on the right, toward the middle');
    t.eq(badgeSide({...PET, x: 900}, WA), -1, 'right of the middle: on the left');
}

function confetti(t) {
    const a = confettiPieces(seededRandom(7));
    const b = confettiPieces(seededRandom(7));
    t.eq(a.length, CONFETTI.count, `${CONFETTI.count} pieces of confetti`);
    t.eq(a, b, 'the same seed throws the same confetti');
    t.check(JSON.stringify(confettiPieces(seededRandom(8))) !== JSON.stringify(a), 'another seed throws other confetti');
    const r = seededRandom(1);
    const values = Array.from({length: 1000}, () => r());
    t.check(values.every(v => v >= 0 && v < 1) && Math.min(...values) < 0.01 && Math.max(...values) > 0.99,
        'the seeded numbers spread over 0–1');

    let inside = true, aboveTop = false, rose = 0, fell = 0;
    for (const piece of a) {
        let peak = Infinity;
        let prev = null;
        for (let s = 0; s < CONFETTI.seconds + 0.5; s += 0.02) {
            const p = confettiAt(piece, s);
            if (!p)
                continue;
            if (p.x < -1.2 || p.x > 2.2)
                inside = false;
            if (p.y < -1.9)
                aboveTop = true;
            peak = Math.min(peak, p.y);
            if (prev && p.y < prev.y)
                rose++;
            if (prev && p.y > prev.y)
                fell++;
            prev = p;
        }
        if (peak > CONFETTI.origin.y - 0.2)
            inside = false;
    }
    t.check(inside, 'every piece flies up at least 0.2 pet sizes and stays inside the box sideways');
    t.check(!aboveTop, 'none flies off the top of the box');
    t.check(rose > 0 && fell > rose, 'confetti goes up, then flutters down for longer');
    t.check(a.every(p => confettiAt(p, -0.01) === null), 'nothing before it is thrown');
    t.check(a.every(p => confettiAt(p, CONFETTI.seconds) === null), `all gone after ${CONFETTI.seconds} s`);
    const first = confettiAt(a[0], a[0].delay);
    t.check(Math.abs(first.x - CONFETTI.origin.x) < 1e-9 && Math.abs(first.y - CONFETTI.origin.y) < 1e-9 && first.alpha === 1,
        'each piece starts at the top of the head, fully visible');
    t.check(a.every(p => confettiAt(p, p.delay + CONFETTI.life - 0.05).alpha < 0.15), 'and fades out at the end of its life');
}

function fireworks(t) {
    const plain = fireworkBursts(false);
    const gold = fireworkBursts(true);
    t.eq([plain.length, gold.length], [4, 5], 'four bursts, five for a golden treat');
    t.check(gold.every(b => b.colors.every(c => FIREWORKS.gold.includes(c))), 'golden bursts are gold');
    t.check(plain.every(b => b.colors.every(c => FIREWORKS.colors.includes(c))), 'the others use the confetti colors');
    t.near(fireworksSeconds(false), plain.at(-1).at + FIREWORKS.rocket + FIREWORKS.burst, 1e-9, 'over when the last burst fades');

    let inside = true;
    for (const [i, burst] of [...plain, ...gold].entries()) {
        for (let s = 0; s < 3.5; s += 0.02) {
            const state = burstAt(burst, s, i);
            const points = state === null ? [] : state.rocket ? [state.rocket] : state.sparks;
            if (points.some(p => p.x < -1.2 || p.x > 2.2 || p.y < -1.9 || p.y > 1))
                inside = false;
        }
    }
    t.check(inside, 'rockets and sparks stay inside the box');
    const b = plain[1];
    t.eq(burstAt(b, b.at - 0.01, 1), null, 'nothing before the launch');
    const rocket = burstAt(b, b.at + FIREWORKS.rocket / 2, 1);
    t.check(rocket.rocket && rocket.rocket.y < FIREWORKS.launch.y && rocket.rocket.y > b.y, 'a rocket rises from the pet');
    const bang = burstAt(b, b.at + FIREWORKS.rocket + 0.05, 1);
    t.check(bang.sparks.length === FIREWORKS.sparks && bang.flash > 0, 'then it bursts with a flash');
    const later = burstAt(b, b.at + FIREWORKS.rocket + 0.6, 1);
    const spread = s => Math.max(...s.sparks.map(p => Math.hypot(p.x - b.x, p.y - b.y)));
    t.check(spread(later) > spread(bang) && later.sparks[0].alpha < bang.sparks[0].alpha, 'the sparks spread and fade');
    t.eq(burstAt(b, b.at + FIREWORKS.rocket + FIREWORKS.burst, 1), null, 'and are gone');
}

function drawing(t) {
    const box = effectBox(PET);
    const pieces = confettiPieces(seededRandom(3));
    const scene = plan => ({box, plan, pieces, bursts: fireworkBursts(plan.golden), side: 1});
    const jump = scene(celebrationPlan({kind: 'jump', combo: 1}, 4));
    const mid = paint(box.width, box.height, cr => drawCelebration(cr, jump, 0.6));
    t.check(mid.identity, 'drawing the confetti leaves the transform as it was');
    t.check(mid.opaque > 200, `confetti is drawn (${mid.opaque} px)`);
    t.eq(paint(box.width, box.height, cr => drawCelebration(cr, jump, CONFETTI.seconds + 0.1)).opaque, 0, 'and gone at the end');
    const fw = scene(celebrationPlan({kind: 'fireworks', combo: 3}, 4));
    const bursting = paint(box.width, box.height, cr => drawCelebration(cr, fw, 0.6));
    t.check(bursting.identity && bursting.opaque > 200, `fireworks are drawn (${bursting.opaque} px)`);
    const badgeX = Math.round(box.petX + box.size * 1.12), badgeY = Math.round(box.petY + box.size * 0.55);
    t.check(bursting.alpha(badgeX, badgeY) === 255, 'the combo badge is beside the pet');
    const noBadge = paint(box.width, box.height, cr => drawCelebration(cr, scene(celebrationPlan({kind: 'fireworks', combo: 1}, 4)), 0.6));
    t.check(noBadge.alpha(badgeX, badgeY) < 255, 'without a combo there is no badge');
    const golden = paint(box.width, box.height, cr => drawCelebration(cr, scene(celebrationPlan({kind: 'fireworks', golden: true, combo: 1}, 5)), 1.0));
    t.check(golden.opaque > 200, 'golden fireworks are drawn');

    const small = effectBox(PET, {left: 0.8, right: 0.8, top: 0.3, bottom: 0.1});
    const sighing = paint(small.width, small.height, cr => drawGrumble(cr, {box: small, side: 1}, 0.5));
    t.check(sighing.identity && sighing.opaque > 50, `the sigh is drawn (${sighing.opaque} px)`);
    const stomping = paint(small.width, small.height, cr => drawGrumble(cr, {box: small, side: 1}, GRUMBLE.sigh + 0.75 * GRUMBLE.stomp + 0.1));
    t.check(stomping.opaque > 20, `the dust is drawn (${stomping.opaque} px)`);
    t.eq(paint(small.width, small.height, cr => drawGrumble(cr, {box: small, side: 1}, GRUMBLE.seconds - 0.05)).opaque, 0,
        'nothing is left at the end');
}

// The Developer page and the dev scenes play a stunt or a celebration on demand, through the same code as the rules.
async function devHooks(t) {
    const three = () => [task('a', '2026-10-27'), task('b', '2026-10-27'), task('c', '2026-10-27')];
    const now = at('2026-10-27T15:11:01');

    const p = makeBrain({active: three(), now: at('2026-10-27T15:11'), prefs: {voiceOn: true}});
    await p.start(); await p.refresh();
    const started = [];
    p.on('antic', x => started.push(x.kind));
    p.devAntic('parade', now);
    t.eq([p.antic?.kind, p.antic?.text, p.bubble?.urgent, p.bubble?.actions.map(x => x.title).includes(SPARE), started],
        ['parade', 'Task a', true, true, ['parade']], 'devAntic parade: the sign carries the next task, the bubble can spare you');
    t.eq(p.env.spoken, ['Hey! Do Task a now!'], 'and says its line once when the voice is on');
    t.check(p.diary.today.some(e => e.kind === 'antic' && e.text.includes('a developer test')), 'the diary says it was a test');

    const b = makeBrain({active: three(), now: at('2026-10-27T15:11')});
    await b.start(); await b.refresh();
    b.devAntic('block', now);
    t.eq([b.antic?.kind, b.antic?.text, b.bubble?.urgent], ['block', 'youtube.com', true], 'devAntic block: youtube.com by default');
    t.check(b.bubble.text.startsWith('(╯°□°)╯︵ ┻━┻ ENOUGH YOUTUBE.COM!') && b.env.spoken.length === 0,
        'the table flip, and no voice while it is off');
    const site = makeBrain({active: three(), now: at('2026-10-27T15:11'), env: {focus: {
        appName: 'Firefox', wmClass: 'firefox', title: 'Feed - Facebook — Mozilla Firefox', isBrowser: true,
        since: at('2026-10-27T15:00'),
    }}});
    await site.start(); await site.refresh();
    site.devAntic('block', now);
    t.eq(site.antic?.text, 'facebook.com', 'or the distracting site in front');

    const g = makeBrain({active: three(), now: at('2026-10-27T15:11')});
    await g.start(); await g.refresh();
    g.devAntic('grumble', now);
    t.eq([g.antic?.kind, g.bubble?.urgent, g.bubble?.seconds], ['grumble', false, 15], 'devAntic grumble: the grumble bubble');

    const none = makeBrain({now: at('2026-10-27T15:11')});
    await none.start(); await none.refresh();
    none.dismissBubble();
    none.devAntic('parade', now);
    t.eq([none.antic?.kind, none.antic?.text, none.bubble], ['parade', 'Demo', null],
        'with nothing to do the parade carries "Demo" and says nothing (Swift\'s TODOPET_ANTIC)');
    let threw = false;
    try {
        none.devAntic('dance', now);
    } catch {
        threw = true;
    }
    t.check(threw, 'an unknown stunt is an error');

    const c = makeBrain({active: three(), now: at('2026-10-27T15:11')});
    await c.start(); await c.refresh();
    c.devAntic('parade', now);
    const fed = c.life.state.totalDone;
    const events = [];
    c.on('celebrate', e => events.push(e));
    const ends = [];
    c.on('antic-end', () => ends.push(true));
    c.devCelebrate({kind: 'spin'}, now);
    t.eq([c.celebration.kind, c.celebration.golden, c.celebration.combo, c.celebration.food, events.length],
        ['spin', false, 1, '🍙', 1], 'devCelebrate: the dance asked for, with a treat');
    t.check(c.mood === Mood.celebrating && c.antic === null && ends.length === 1, 'the pet celebrates, the stunt is off');
    t.eq(c.life.state.totalDone, fed, 'the pet is not fed for a test');
    t.eq(c.celebrateUntil.getTime() - now.getTime(), 4000, 'for 4 s');
    c.devCelebrate({kind: 'jump', golden: true}, now);
    t.eq([c.celebration.kind, c.celebration.golden, c.celebration.food, c.celebrateUntil.getTime() - now.getTime()],
        ['fireworks', true, '🍰', 5000], 'golden: fireworks and cake, for 5 s');
    c.devCelebrate({kind: 'fireworks', combo: 3}, now);
    t.eq([c.celebration.kind, c.celebration.combo], ['fireworks', 3], 'a combo can be asked for');
    threw = false;
    try {
        c.devCelebrate({kind: 'moonwalk'}, now);
    } catch {
        threw = true;
    }
    t.check(threw, 'an unknown dance is an error');

    // The mood follows the end of the dance: 4 s, or 5 s for a golden treat (Swift recomputed after 4.2 s in both
    // cases, so a golden pet went on celebrating until the next 15 s round).
    const end = makeBrain({active: three(), now: at('2026-10-27T15:11')});
    await end.start(); await end.refresh();
    const second = s => new Date(now.getTime() + s * 1000);
    end.devCelebrate({kind: 'jump', golden: true}, now);
    end.tick(second(4.5));
    t.eq(end.mood, Mood.celebrating, 'a golden dance still goes on after 4.5 s');
    end.tick(second(5.3));
    t.check(end.mood !== Mood.celebrating, 'and is over at once after 5 s');
    end.devCelebrate({kind: 'spin'}, second(6));
    end.tick(second(10.3));
    t.check(end.mood !== Mood.celebrating, 'a plain one is over after 4 s');
    const real = makeBrain({active: three(), now: at('2026-10-27T15:11')});
    await real.start(); await real.refresh();
    real.complete(real.day.today[0]);
    await real.settle();
    const done = real.celebration.start;
    t.check(real.celebration.golden, 'the test brain\'s rolls make every treat golden');
    // The first tick runs the 15 s round (and its recompute); the ones after it only the 1 s work.
    real.tick(new Date(done.getTime() + 1000));
    real.tick(new Date(done.getTime() + 4500));
    t.eq(real.mood, Mood.celebrating, 'a finished task with a golden treat still celebrates after 4.5 s');
    real.tick(new Date(done.getTime() + 5300));
    t.check(real.mood !== Mood.celebrating, 'a finished task with a golden treat celebrates for 5 s, not until the next round');
}
