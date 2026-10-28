// The numbers behind the pet's stunts and celebrations on screen (ui/antics.js draws them with ui/anticsArt.js):
// where the parade's sign goes (SignController.follow in Antics.swift), how a grumble sighs and stomps, and the
// confetti, fireworks and combo badge around a celebrating pet. Pure: no Shell imports, so the tests run it.
//
// Effects are laid out in "pet units": 1 is the pet's side, (0, 0) the top-left corner of its box, y down. An
// effect box (effectBox) is the part of the stage around the pet they are drawn in.

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// --- The sign ---

// Where the parade's sign goes for the pet at `pet` ({x, y, width, height}, stage pixels) walking toward `facing`
// (1 right, -1 left), the sign being `sign` ({width, height}, pixels): behind the pet, its rope toward it and under
// the pet's edge by 20% of its width, its bottom 18% up the pet. Swift: SignController.follow (y points up there).
export function signFrame(pet, facing, sign) {
    const ropeOnRight = facing > 0;
    const x = ropeOnRight ? pet.x - sign.width + pet.width * 0.2 : pet.x + pet.width - pet.width * 0.2;
    const y = pet.y + pet.height * (1 - 0.18) - sign.height;
    return {x: Math.round(x), y: Math.round(y), ropeOnRight};
}

// --- The effect box ---

// Room around the pet for a celebration, in pet sizes: the confetti and fireworks go up and to the sides.
export const CELEBRATION_MARGINS = Object.freeze({left: 1.2, right: 1.2, top: 1.9, bottom: 0});
// Room around the pet for a grumble: the sigh comes out to one side, the dust stays at the feet.
export const GRUMBLE_MARGINS = Object.freeze({left: 0.8, right: 0.8, top: 0.3, bottom: 0.1});

// The stage rectangle effects around the pet at `pet` are drawn in, in whole pixels, with where the pet's box sits
// inside it (petX, petY) and its side (size).
export function effectBox(pet, margins = CELEBRATION_MARGINS) {
    const size = pet.width;
    const petX = Math.round(margins.left * size);
    const petY = Math.round(margins.top * size);
    return {
        x: Math.round(pet.x) - petX,
        y: Math.round(pet.y) - petY,
        width: Math.round((margins.left + 1 + margins.right) * size),
        height: Math.round((margins.top + 1 + margins.bottom) * size),
        petX, petY, size,
    };
}

// Which side of the pet the combo badge and the sigh go to: toward the middle of the work area (1 right, -1 left).
export function badgeSide(pet, workArea) {
    return pet.x + pet.width / 2 <= workArea.x + workArea.width / 2 ? 1 : -1;
}

// --- Grumble: sighs and stomps in place ---

// A sigh first (seconds), then `stomps` stomps on alternate feet, each `stomp` seconds long and lifting the pet `hop`
// points, then a rest. Dust puffs up under each stomp for `dust` seconds.
export const GRUMBLE = Object.freeze({sigh: 1.2, stomps: 4, stomp: 0.5, rest: 0.4, hop: 6, dust: 0.45, seconds: 3.6});
// Within a stomp (0–1): up until LIFT, slammed down by SLAM, then on the ground.
const LIFT = 0.6;
const SLAM = 0.75;

// The grumble `t` seconds in: {done, hop (points up), walking and walkPhase (the walking legs lift one foot),
// sigh (0–1 while sighing, else null), dust: [{side (-1 left foot, 1 right), k (0–1 of its life)}]}.
export function grumbleAt(t) {
    const g = GRUMBLE;
    const state = {done: t >= g.seconds, hop: 0, walking: false, walkPhase: 0, sigh: null, dust: []};
    if (state.done || t < 0)
        return state;
    if (t < g.sigh) {
        state.sigh = t / g.sigh;
        return state;
    }
    const stompsEnd = g.sigh + g.stomps * g.stomp;
    for (let k = 0; k < g.stomps; k++) {
        const since = t - (g.sigh + (k + SLAM) * g.stomp);
        if (since >= 0 && since < g.dust)
            state.dust.push({side: k % 2 === 0 ? -1 : 1, k: since / g.dust});
    }
    if (t >= stompsEnd)
        return state;
    const k = Math.floor((t - g.sigh) / g.stomp);
    const u = (t - g.sigh) / g.stomp - k;
    let lift = 0;
    if (u < LIFT)
        lift = Math.sin(Math.PI / 2 * u / LIFT);
    else if (u < SLAM)
        lift = Math.cos(Math.PI / 2 * (u - LIFT) / (SLAM - LIFT));
    state.hop = g.hop * lift;
    state.walking = true;
    // drawPet lifts the left foot for sin(walkPhase) > 0 and the right one below 0.
    state.walkPhase = (k % 2 === 0 ? 1 : -1) * Math.PI / 2 * lift;
    return state;
}

// Where the sigh leaves the pet: its mouth.
const MOUTH = Object.freeze({x: 0.5, y: 0.67});
const SIGH_PUFFS = Object.freeze([0.08, 0.22, 0.36, 0.5]);
const SIGH_PUFF_LIFE = 0.5;

// The puffs of a sigh `progress` (0–1) through it, blown out to `side`: [{x, y, r, alpha}] in pet units.
export function sighPuffs(progress, side) {
    const puffs = [];
    for (const [i, from] of SIGH_PUFFS.entries()) {
        const q = (progress - from) / SIGH_PUFF_LIFE;
        if (q <= 0 || q >= 1)
            continue;
        const out = 0.14 + 0.38 * Math.sqrt(q);
        puffs.push({
            x: MOUTH.x + side * out,
            y: MOUTH.y - 0.02 - 0.08 * q + (i % 2) * 0.03,
            r: 0.035 + 0.065 * q,
            alpha: 0.85 * (1 - q),
        });
    }
    return puffs;
}

// The feet, in pet units (drawPet's feet at 50 ± 17 of its 120). The dust rises from just above their soles: the
// pet stands 5% below the work area, so lower down it would be cut off at the screen's edge.
const FEET = Object.freeze({dx: 0.14, y: 0.88});

// The dust of grumbleAt(t).dust: two small clouds rolling out from the stomping foot.
export function dustPuffs(dust) {
    const puffs = [];
    for (const {side, k} of dust) {
        const footX = 0.5 + side * FEET.dx;
        for (const dir of [-1, 1]) {
            puffs.push({
                x: footX + dir * (0.07 + 0.18 * Math.sqrt(k)),
                y: FEET.y - 0.07 * Math.sqrt(k),
                r: 0.05 + 0.05 * k,
                alpha: 0.85 * (1 - k),
            });
        }
    }
    return puffs;
}

// --- Celebration ---

// Swift's confetti colors (PetArt: 0xFF5C8A, 0xFFC93C, 0x4FC3F7, 0x66BB6A, 0xAB47BC).
const PARTY = Object.freeze(['#FF5C8A', '#FFC93C', '#4FC3F7', '#66BB6A', '#AB47BC']);
// The golden treat's colors (the golden palette and its sparkles).
const GOLD = Object.freeze(['#FFD700', '#FFC531', '#FFF6C2', '#FFB300']);

// Confetti thrown up from the top of the pet's head, slowed by the air, fluttering down. `speed` in pet units per
// second, `spread` radians either side of straight up, `life` seconds per piece after its `delay`, fading over
// the last `fade` seconds. `seconds`: when the last piece is gone.
export const CONFETTI = Object.freeze({
    count: 36, origin: Object.freeze({x: 0.5, y: 0.3}), spread: 0.85, speed: Object.freeze([2.4, 3.3]),
    drag: 2.6, gravity: 2.6, delay: 0.2, life: 2.6, fade: 0.7, flutter: 0.03, seconds: 2.8,
    colors: PARTY,
});

// Rockets rise from the pet's head (`launch`) for `rocket` seconds, then burst into `sparks` sparks that fly out to
// `radius` and fade over `burst` seconds.
export const FIREWORKS = Object.freeze({
    launch: Object.freeze({x: 0.5, y: 0.25}), rocket: 0.35, burst: 1.0, radius: 0.42, sparks: 14, droop: 0.25,
    colors: PARTY, gold: GOLD,
});
const BURSTS = Object.freeze([
    {at: 0, x: -0.45, y: -0.35},
    {at: 0.4, x: 1.45, y: -0.5},
    {at: 0.8, x: 0.5, y: -0.95},
    {at: 1.2, x: 0, y: -1.3},
]);
const GOLDEN_BURST = Object.freeze({at: 1.6, x: 1.05, y: -1.35});
// How far back (seconds) a spark's streak reaches.
const STREAK = 0.12;

// The combo badge pops in after BADGE_POP_AT for BADGE_POP seconds and fades out over BADGE_FADE before the end.
const BADGE_POP_AT = 0.15;
const BADGE_POP = 0.35;
const BADGE_FADE = 0.5;
// A celebration that says nothing about its length lasts this long (Swift: celebrateUntil, 4 s or 5 s).
const DEFAULT_SECONDS = 4;
const MAX_SECONDS = 8;

// The badge's text for a combo: from ×2 on (Swift adds "Combo ×N" to the bubble then).
export function comboBadge(combo) {
    return combo >= 2 ? `×${combo}` : null;
}

export function fireworksSeconds(golden) {
    return fireworkBursts(golden).at(-1).at + FIREWORKS.rocket + FIREWORKS.burst;
}

// What a celebration ({kind, golden, combo}, as the brain emits it) shows around the pet for its `seconds`:
// {effect: 'fireworks' (the fireworks dance or a golden treat) or 'confetti', golden, badge (text or null),
// seconds: how long the effects stay (the badge stays for the whole dance)}.
export function celebrationPlan(event, seconds) {
    const golden = Boolean(event.golden);
    const effect = event.kind === 'fireworks' || golden ? 'fireworks' : 'confetti';
    const badge = comboBadge(event.combo ?? 0);
    const length = Number.isFinite(seconds) ? clamp(seconds, 2, MAX_SECONDS) : DEFAULT_SECONDS;
    const effectSeconds = effect === 'fireworks' ? fireworksSeconds(golden) : CONFETTI.seconds;
    return {effect, golden, badge, seconds: badge ? Math.max(effectSeconds, length) : effectSeconds};
}

// easeOutBack: overshoots a little before settling on 1.
function overshoot(x) {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2;
}

// The badge `t` seconds into a celebration lasting `seconds`: {scale, alpha, dy (a gentle bob, pet units)}.
export function badgeLook(t, seconds) {
    if (t < BADGE_POP_AT || t >= seconds)
        return {scale: 0, alpha: 0, dy: 0};
    const u = Math.min(1, (t - BADGE_POP_AT) / BADGE_POP);
    return {
        scale: u >= 1 ? 1 : overshoot(u),
        alpha: t > seconds - BADGE_FADE ? Math.max(0, (seconds - t) / BADGE_FADE) : 1,
        dy: Math.sin(t * 4) * 0.015,
    };
}

// Random numbers in [0, 1) from a seed (mulberry32), so a throw of confetti can be replayed.
export function seededRandom(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let z = a;
        z = Math.imul(z ^ (z >>> 15), z | 1);
        z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
        return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
    };
}

// One throw of confetti: [{vx, vy, delay, angle, spin, color, w, h, phase, wobble}] (pet units and seconds).
export function confettiPieces(random = Math.random) {
    const c = CONFETTI;
    return Array.from({length: c.count}, (_, i) => {
        const direction = -Math.PI / 2 + (random() * 2 - 1) * c.spread;
        const speed = c.speed[0] + random() * (c.speed[1] - c.speed[0]);
        return {
            vx: Math.cos(direction) * speed,
            vy: Math.sin(direction) * speed,
            delay: random() * c.delay,
            angle: random() * Math.PI * 2,
            spin: (random() * 2 - 1) * 9,
            color: c.colors[i % c.colors.length],
            w: 0.026 + random() * 0.012,
            h: 0.05 + random() * 0.016,
            phase: random() * Math.PI * 2,
            wobble: 5 + random() * 4,
        };
    });
}

// A piece of confetti `t` seconds into the throw: {x, y, angle, alpha, color, w, h}, or null before it is thrown
// and after its life. Air drag `k`: it slows down and falls at no more than gravity / k.
export function confettiAt(piece, t) {
    const c = CONFETTI;
    const tau = t - piece.delay;
    if (tau < 0 || tau >= c.life)
        return null;
    const k = c.drag, g = c.gravity;
    const slowed = (1 - Math.exp(-k * tau)) / k;
    const flutter = c.flutter * (1 - Math.exp(-3 * tau)) * Math.sin(piece.wobble * tau + piece.phase);
    return {
        x: c.origin.x + piece.vx * slowed + flutter,
        y: c.origin.y + (g / k) * tau + (piece.vy - g / k) * slowed,
        angle: piece.angle + piece.spin * tau,
        alpha: tau > c.life - c.fade ? (c.life - tau) / c.fade : 1,
        color: piece.color,
        w: piece.w,
        h: piece.h,
    };
}

// The bursts of a fireworks show: [{at, x, y, colors}] (seconds, pet units).
export function fireworkBursts(golden) {
    const list = golden ? [...BURSTS, GOLDEN_BURST] : BURSTS;
    const palette = golden ? GOLD : PARTY;
    return list.map((b, i) => ({
        ...b,
        colors: [0, 1, 2].map(j => palette[(i * 2 + j) % palette.length]),
    }));
}

// Burst number `index` `t` seconds into the show: null when it is not on screen; {rocket: {x, y}, trail: [{x, y}]}
// while its rocket rises; {flash (0–1), sparks: [{x, y, r, alpha, color, tail: {x, y}}]} once it has burst. A spark's
// tail is where it was STREAK seconds earlier: a long streak while it flies out fast, a dot once it slows down.
export function burstAt(burst, t, index) {
    const f = FIREWORKS;
    const since = t - burst.at;
    if (since < 0)
        return null;
    if (since < f.rocket) {
        const at = s => {
            const k = 1 - (1 - clamp(s / f.rocket, 0, 1)) ** 2;
            return {x: f.launch.x + (burst.x - f.launch.x) * k, y: f.launch.y + (burst.y - f.launch.y) * k};
        };
        return {rocket: at(since), trail: [0.04, 0.08, 0.12].map(back => at(since - back))};
    }
    const tau = since - f.rocket;
    if (tau >= f.burst)
        return null;
    const reachAt = s => f.radius * (1 - Math.exp(-5 * Math.max(0, s)));
    const reach = reachAt(tau);
    const back = reachAt(tau - STREAK);
    const sparks = Array.from({length: f.sparks}, (_, j) => {
        const a = (j / f.sparks) * Math.PI * 2 + index * 0.3;
        const droop = f.droop * tau * tau;
        return {
            x: burst.x + Math.cos(a) * reach,
            y: burst.y + Math.sin(a) * reach + droop,
            r: 0.026 * (1 - 0.5 * tau / f.burst),
            alpha: 1 - tau / f.burst,
            color: burst.colors[j % burst.colors.length],
            tail: {x: burst.x + Math.cos(a) * back, y: burst.y + Math.sin(a) * back + droop},
        };
    });
    return {flash: Math.max(0, 1 - tau / 0.15), sparks};
}
