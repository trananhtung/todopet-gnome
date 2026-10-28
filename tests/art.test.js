import Cairo from 'cairo';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';

import {Mood} from '../extension/core/mood.js';
import {defaultLifeState} from '../extension/core/life.js';
import {decoratePose, defaultPose, drawPet, mixPalette, petPalette} from '../extension/art/petArt.js';
import {PetMotion} from '../extension/art/motion.js';

// Renders one pose on a transparent surface and returns a function reading a pixel's alpha (0-255).
// Cairo in GJS cannot read pixels back, so the surface goes through a PNG and GdkPixbuf.
function render(pose, width = 200, height = 200) {
    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, width, height);
    const cr = new Cairo.Context(surface);
    let identity;
    try {
        drawPet(cr, width, height, pose);
        // drawPet must leave the caller's transform as it found it.
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
    const alpha = (px, py) => (channels === 4 ? pixels[py * stride + px * channels + 3] : 255);
    return {alpha, identity};
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
