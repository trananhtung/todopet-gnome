import Cairo from 'cairo';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';

import {Mood} from '../extension/core/mood.js';
import {ACCESSORIES, CELEBRATION_KINDS, defaultLifeState} from '../extension/core/life.js';
import * as petArt from '../extension/art/petArt.js';
import {PetMotion} from '../extension/art/motion.js';

const {decoratePose, defaultPose, drawPet, mixPalette, petPalette} = petArt;

// Draws on a transparent surface and returns pixel readers: alpha(x, y) and rgba(x, y), each channel 0-255.
// Cairo in GJS cannot read pixels back, so the surface goes through a PNG and GdkPixbuf.
function paint(width, height, draw) {
    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, width, height);
    const cr = new Cairo.Context(surface);
    let identity;
    try {
        draw(cr);
        // Drawing must leave the caller's transform as it found it.
        const [x, y] = cr.userToDevice(10, 20);
        identity = x === 10 && y === 20;
    } finally {
        cr.$dispose();
    }
    const dir = GLib.dir_make_tmp('todopet-art-XXXXXX');
    const file = GLib.build_filenamev([dir, 'pet.png']);
    surface.writeToPNG(file);
    surface.finish();
    const pixbuf = GdkPixbuf.Pixbuf.new_from_file(file);
    GLib.unlink(file);
    GLib.rmdir(dir);
    const pixels = pixbuf.get_pixels();
    const stride = pixbuf.get_rowstride();
    const channels = pixbuf.get_n_channels();
    const rgba = (px, py) => {
        const i = py * stride + px * channels;
        return [pixels[i], pixels[i + 1], pixels[i + 2], channels === 4 ? pixels[i + 3] : 255];
    };
    return {alpha: (px, py) => rgba(px, py)[3], rgba, identity, width, height};
}

function render(pose, width = 200, height = 200) {
    return paint(width, height, cr => drawPet(cr, width, height, pose));
}

// How many pixels differ by more than 24 in some channel (colors weighted by alpha, as they are seen).
function differing(a, b) {
    let count = 0;
    for (let y = 0; y < a.height; y++) {
        for (let x = 0; x < a.width; x++) {
            const p = a.rgba(x, y), q = b.rgba(x, y);
            const seen = (c, i) => (i === 3 ? c[3] : c[i] * c[3] / 255);
            if ([0, 1, 2, 3].some(i => Math.abs(seen(p, i) - seen(q, i)) > 24))
                count++;
        }
    }
    return count;
}

// Painted pixels in one row.
function painted(px, y) {
    let count = 0;
    for (let x = 0; x < px.width; x++) {
        if (px.alpha(x, y) > 0)
            count++;
    }
    return count;
}

const POSE_FIELDS = [
    'mood', 't', 'facing', 'walking', 'walkPhase', 'lookX', 'hovered', 'held', 'prevMood', 'blend', 'calm',
    'stageScale', 'sprouts', 'hungry', 'dirt', 'wearing', 'celebration', 'golden', 'food', 'foodT',
];

export default function (t) {
    // --- Poses ---
    const pose = defaultPose(Mood.happy, 1.5);
    t.eq(Object.keys(pose).sort(), [...POSE_FIELDS].sort(), 'defaultPose has every PetPose field');
    t.eq(pose, {
        mood: 'happy', t: 1.5, facing: 1, walking: false, walkPhase: 0, lookX: 0, hovered: false, held: false,
        prevMood: 'normal', blend: 1, calm: false, stageScale: 1, sprouts: 0, hungry: false, dirt: 0, wearing: [],
        celebration: 'jump', golden: false, food: null, foodT: 0,
    }, 'defaultPose uses the Swift defaults');
    t.check(defaultPose(Mood.happy, 0).wearing !== defaultPose(Mood.happy, 0).wearing,
        'defaultPose returns a fresh wearing list each time');

    const life = {...defaultLifeState(), xp: 120, satiety: 12, dirt: 2, wearing: ['bow', 'cape', 'scarf']};
    const plain = defaultPose(Mood.normal, 0);
    const dressed = decoratePose(plain, life);
    t.eq([dressed.stageScale, dressed.sprouts, dressed.hungry, dressed.dirt, dressed.wearing],
        [0.88, 1, true, 2, ['bow', 'scarf']], 'decoratePose applies stage, hunger, dirt and known accessories');
    t.eq([plain.stageScale, plain.sprouts, plain.hungry, plain.dirt, plain.wearing], [1, 0, false, 0, []],
        'decoratePose leaves the given pose untouched');
    t.eq(dressed.mood, 'normal', 'decoratePose keeps the other fields');

    // --- Palettes ---
    const normal = petPalette(Mood.normal);
    t.eq(normal.top, {r: 0xFF / 255, g: 0xF0 / 255, b: 0xDE / 255, a: 1}, 'normal palette top is FFF0DE');
    t.eq(normal.cheek.a, 0.4, 'normal cheeks are 40 % opaque');
    t.eq(petPalette(Mood.focus), normal, 'focus uses the normal palette');
    t.eq(petPalette(Mood.celebrating), petPalette(Mood.happy), 'celebrating uses the happy palette');
    t.eq(petPalette(Mood.angry).cheek.a, 0, 'angry has no cheeks');
    const half = mixPalette(petPalette(Mood.normal), petPalette(Mood.angry), 0.5);
    t.near(half.bottom.r, (0xF4 + 0xEA) / 2 / 255, 1e-9, 'mixPalette blends each color halfway');
    t.near(half.cheek.a, 0.2, 1e-9, 'mixPalette blends alpha too');

    // --- Drawing: every mood paints the pet in the middle and nothing in the corners ---
    for (const mood of Object.values(Mood)) {
        for (const time of [0, 0.4, 2.5]) {
            let px;
            try {
                px = render(defaultPose(mood, time));
            } catch (e) {
                t.fail(`drawPet(${mood}, t=${time}) does not throw`, e.message);
                continue;
            }
            t.check(px.alpha(100, 100) > 0, `${mood} at t=${time}: center pixel is painted`);
            t.check(px.alpha(0, 0) === 0 && px.alpha(199, 0) === 0, `${mood} at t=${time}: corner pixels stay clear`);
            t.check(px.identity, `${mood} at t=${time}: drawPet restores the transform`);
        }
    }
    for (const [name, change] of [['held', {held: true}], ['petted', {hovered: true}],
        ['walking', {walking: true, walkPhase: 1.2}], ['calm', {calm: true}],
        ['blending from angry', {prevMood: Mood.angry, blend: 0.3}]]) {
        const px = render({...defaultPose(Mood.normal, 0.6), ...change});
        t.check(px.alpha(100, 100) > 0 && px.alpha(0, 0) === 0, `${name} pose draws in the middle only`);
    }
    // A wide area: the pet stays centered and keeps its proportions.
    const wide = render(defaultPose(Mood.normal, 0.4), 360, 120);
    t.check(wide.alpha(180, 70) > 0, 'wide area: pet drawn in the middle');
    t.check(wide.alpha(60, 70) === 0 && wide.alpha(300, 70) === 0, 'wide area: sides stay clear');

    // --- Life: growth, hunger, dirt, accessories ---
    const lifePose = (mood, change, t0 = 0.4) => ({...defaultPose(mood, t0), ...change});
    const plainNormal = render(lifePose(Mood.normal, {}));
    t.check(differing(render(lifePose(Mood.normal, {sprouts: 1})), plainNormal) > 20, 'one sprout grows on the head');
    t.check(differing(render(lifePose(Mood.normal, {sprouts: 2})), render(lifePose(Mood.normal, {sprouts: 1}))) > 20,
        'two sprouts look different from one');
    for (const accessory of ACCESSORIES) {
        let px;
        try {
            px = render(lifePose(Mood.normal, {wearing: [accessory]}));
        } catch (e) {
            t.fail(`drawPet wearing ${accessory} does not throw`, e.message);
            continue;
        }
        t.check(differing(px, plainNormal) > 20, `${accessory} is drawn on the pet`);
    }
    for (const mood of [Mood.normal, Mood.sleeping, Mood.celebrating]) {
        for (const held of [false, true]) {
            try {
                const px = render(lifePose(mood, {wearing: [...ACCESSORIES], held}));
                t.check(px.alpha(100, 100) > 0 && px.identity, `${mood}${held ? ' held' : ''} wearing everything draws`);
            } catch (e) {
                t.fail(`${mood}${held ? ' held' : ''} wearing everything does not throw`, e.message);
            }
        }
    }
    const grimy = [0, 1, 2, 3].map(dirt => {
        try {
            return render(lifePose(Mood.annoyed, {dirt}));
        } catch (e) {
            t.fail(`dirt ${dirt} does not throw`, e.message);
            return null;
        }
    });
    if (grimy.every(Boolean)) {
        t.check(differing(grimy[1], grimy[0]) > 10, 'dirt 1 puts smudges on the body');
        t.check(differing(grimy[2], grimy[1]) > 10, 'dirt 2 adds smudges and a fly');
        t.check(differing(grimy[3], grimy[2]) > 10, 'dirt 3 adds more smudges and a second fly');
    }
    try {
        const full = render(lifePose(Mood.normal, {}, 0.6));
        const hungry = render(lifePose(Mood.normal, {hungry: true}, 0.6));
        // Row 150 crosses the lower body, where it is widest.
        t.check(painted(hungry, 150) < painted(full, 150), 'a hungry pet is thinner');
        t.check(differing(hungry, full) > 20, 'a hungry pet looks different');
    } catch (e) {
        t.fail('hungry pose does not throw', e.message);
    }

    // --- Celebrations ---
    const celebration = (kind, t0, change = {}) => lifePose(Mood.celebrating, {celebration: kind, ...change}, t0);
    for (const kind of CELEBRATION_KINDS) {
        for (const time of [0, 0.27, 1.3]) {
            try {
                const px = render(celebration(kind, time));
                t.check(px.identity, `${kind} at t=${time} draws and restores the transform`);
            } catch (e) {
                t.fail(`${kind} at t=${time} does not throw`, e.message);
            }
        }
    }
    const jump = time => render(celebration('jump', time));
    t.check(differing(render(celebration('spin', 0.28)), jump(0.28)) > 100, 'spin turns the body');
    t.check(differing(render(celebration('flip', 0.27)), jump(0.27)) > 100, 'flip rotates the body');
    t.check(differing(render(celebration('dance', 0.1)), jump(0.1)) > 100, 'dance sways instead of jumping');
    t.check(differing(render(celebration('fireworks', 0.3)), jump(0.3)) > 20, 'fireworks burst in the sky');
    try {
        const golden = render(celebration('fireworks', 0.35, {golden: true}));
        const [r, g, b] = golden.rgba(100, 100);
        t.check(r > 200 && g > 160 && b < 140, `the golden pet is yellow in the middle (${r}, ${g}, ${b})`);
        t.check(differing(golden, render(celebration('fireworks', 0.35))) > 1000, 'the golden pet looks different');
    } catch (e) {
        t.fail('golden pose does not throw', e.message);
    }
    const noFood = render(celebration('jump', 0.2));
    for (const [foodT, what] of [[0.3, 'falling treat'], [1, 'nom']]) {
        try {
            const px = render(celebration('jump', 0.2, {food: '🍙', foodT}));
            t.check(differing(px, noFood) > 20, `the ${what} is drawn at foodT=${foodT}`);
        } catch (e) {
            t.fail(`food at foodT=${foodT} does not throw`, e.message);
        }
    }
    t.eq(differing(render(celebration('jump', 0.2, {food: '🍙', foodT: 2})), noFood), 0, 'the treat is gone after 1.6 s');

    // --- Robustness: a failure mid-frame leaves the caller's context as it was ---
    {
        const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, 200, 200);
        const cr = new Cairo.Context(surface);
        const broken = defaultPose(Mood.normal, 0.4);
        Object.defineProperty(broken, 'wearing', {get: () => {
            throw new Error('broken pose');
        }});
        let threw = false;
        try {
            drawPet(cr, 100, 100, broken);
        } catch {
            threw = true;
        }
        const [x, y] = cr.userToDevice(10, 20);
        const clip = cr.clipExtents();
        t.check(threw, 'a broken pose makes drawPet throw');
        t.eq([x, y, ...clip], [10, 20, 0, 0, 200, 200], 'after a throw the caller keeps its transform and clip');
        cr.$dispose();
        surface.finish();
    }

    // --- The sign dragged during a parade ---
    const longTitle = 'Viết báo cáo tổng kết quý ba cho phòng kinh doanh, gửi chị Hương trước thứ Sáu, nhớ đính kèm bảng số liệu đã duyệt nhé!!';
    t.eq([...longTitle].length, 120, 'the long sign title has 120 characters');
    try {
        const px = paint(260, 90, cr => petArt.drawSign(cr, 260, 90, longTitle));
        t.check(px.identity, 'drawSign with a long Vietnamese title restores the transform');
        t.check(px.alpha(130, 45) === 255, 'the sign board is drawn in the middle');
        t.check(px.alpha(0, 0) === 0 && px.alpha(259, 89) === 0, 'the sign leaves the corners clear');
    } catch (e) {
        t.fail('drawSign with a 120-character Vietnamese title does not throw', e.message);
    }
    try {
        const short = petArt.signSize('Write the weekly report');
        const long = petArt.signSize(longTitle);
        t.check(short.width > 150 && short.width < 300 && short.height > 35 && short.height < 55,
            `a short title makes a one-line sign (${short.width}×${short.height})`);
        t.check(long.width <= 6 + 264 + 22 + 6 && long.height > short.height + 10,
            `a long title wraps to two lines at most 240 wide (${long.width}×${long.height})`);
        const empty = paint(80, 50, cr => petArt.drawSign(cr, 80, 50, ''));
        t.check(empty.identity, 'drawSign with an empty title draws');
    } catch (e) {
        t.fail('signSize and drawSign handle short and empty titles', e.message);
    }

    // --- Motion: colors blend over 0.8 s after a mood change ---
    const motion = new PetMotion();
    t.eq([motion.facing, motion.walking, motion.walkPhase, motion.lookX, motion.hovered, motion.held, motion.calm],
        [-1, false, 0, 0, false, false, false], 'PetMotion starts facing left, standing still');
    t.eq(motion.pose(Mood.normal, 5).blend, 1, 'no blend while the mood stays the same');
    const changed = motion.pose(Mood.angry, 10);
    t.eq([changed.blend, changed.prevMood, changed.mood], [0, 'normal', 'angry'], 'blend is 0 right after a mood change');
    t.near(motion.pose(Mood.angry, 10.4).blend, 0.5, 1e-9, 'blend is halfway after 0.4 s');
    t.eq(motion.pose(Mood.angry, 10.8).blend, 1, 'blend is 1 after 0.8 s');
    t.eq(motion.pose(Mood.angry, 30).blend, 1, 'blend stays at 1');
    motion.facing = 1;
    motion.walking = true;
    motion.walkPhase = 2;
    motion.lookX = 0.5;
    motion.hovered = true;
    motion.held = true;
    motion.calm = true;
    const live = motion.pose(Mood.happy, 31);
    t.eq([live.facing, live.walking, live.walkPhase, live.lookX, live.hovered, live.held, live.calm, live.prevMood, live.blend],
        [1, true, 2, 0.5, true, true, true, 'angry', 0], 'pose carries the live motion values and the previous mood');
    t.eq([live.stageScale, live.celebration, live.wearing], [1, 'jump', []], 'pose keeps the other defaults');
}
