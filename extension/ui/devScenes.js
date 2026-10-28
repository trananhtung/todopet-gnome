// Developer scene runner for the nested-shell harness (tools/nested.sh). When the `dev-scenes` preference is
// not empty, App plays those scenes once after it starts, saves screenshots into `dev-screenshot-dir`, logs
// `TODOPET SCENES DONE` and terminates the shell. Production sessions never load this file.
//
// A scene is registered with registerScene(id, async ctx => ...). Modules that register scenes must be
// imported (statically) from here so that registering happens before runScenes() looks an id up.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Mood} from '../core/mood.js';
import {hasSpeech} from '../services/speech.js';

Gio._promisify(Gio.File.prototype, 'replace_async', 'replace_finish');
Gio._promisify(Gio.OutputStream.prototype, 'close_async', 'close_finish');

const scenes = new Map();

class SceneCancelled extends Error {
    constructor() {
        super('scene run cancelled');
        this.name = 'SceneCancelled';
    }
}

// fn(ctx) gets ctx = {app, arg, wait(ms), shot(name)}; `arg` is what follows ':' in the scene id
// ('prefs:Day' -> id 'prefs', arg 'Day'; '' when there is none).
export function registerScene(id, fn) {
    if (scenes.has(id))
        throw new Error(`Scene '${id}' is registered twice`);
    scenes.set(id, fn);
}

// Resolves after `ms`; rejects with SceneCancelled (and removes its GLib source) when `cancellable` is cancelled.
function sleep(ms, cancellable) {
    return new Promise((resolve, reject) => {
        if (cancellable.is_cancelled()) {
            reject(new SceneCancelled());
            return;
        }
        let sourceId = 0;
        let handlerId = 0;
        sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            sourceId = 0;
            cancellable.disconnect(handlerId);
            resolve();
            return GLib.SOURCE_REMOVE;
        });
        handlerId = cancellable.connect(() => {
            if (sourceId !== 0)
                GLib.source_remove(sourceId);
            sourceId = 0;
            reject(new SceneCancelled());
        });
    });
}

// Resolves once the shell has finished starting up (the overview and the panel are in their final state).
function whenStartupComplete(cancellable) {
    return new Promise((resolve, reject) => {
        if (cancellable.is_cancelled()) {
            reject(new SceneCancelled());
            return;
        }
        if (!Main.layoutManager._startingUp) {
            resolve();
            return;
        }
        let handlerId = 0;
        const cancelId = cancellable.connect(() => {
            Main.layoutManager.disconnect(handlerId);
            reject(new SceneCancelled());
        });
        handlerId = Main.layoutManager.connect('startup-complete', () => {
            Main.layoutManager.disconnect(handlerId);
            cancellable.disconnect(cancelId);
            resolve();
        });
    });
}

// Writes a screenshot of the whole stage to `path`. The output stream is closed whatever happens.
async function writeScreenshot(path) {
    const file = Gio.File.new_for_path(path);
    const stream = await file.replace_async(null, false, Gio.FileCreateFlags.NONE, GLib.PRIORITY_DEFAULT, null);
    let failure = null;
    try {
        await new Promise((resolve, reject) => {
            const shooter = new Shell.Screenshot();
            shooter.screenshot(false, stream, (_shooter, result) => {
                try {
                    shooter.screenshot_finish(result);
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
        });
    } catch (e) {
        failure = e;
    }
    try {
        await stream.close_async(GLib.PRIORITY_DEFAULT, null);
    } catch (e) {
        failure ??= e;
    }
    if (failure)
        throw failure;
}

// Every failure goes through here as `TODOPET SCENE ERROR <id>: <message>`; tools/nested.sh fails on that line.
function reportSceneError(id, error) {
    const message = error?.stack ? `${error.message}\n${error.stack}` : String(error?.message ?? error);
    console.error(`TODOPET SCENE ERROR ${id}: ${message}`);
}

// Plays `ids` in order. A failing scene is reported and the next one still runs. Returns false when it was
// cancelled before the end (App.stop()); otherwise logs `TODOPET SCENES DONE` and terminates the shell.
export async function runScenes(app, ids, dir, cancellable = new Gio.Cancellable()) {
    try {
        await whenStartupComplete(cancellable);
        for (const id of ids) {
            const [name, ...rest] = id.split(':');
            const scene = scenes.get(name);
            if (!scene) {
                reportSceneError(id, new Error(`unknown scene '${name}'`));
                continue;
            }
            const ctx = {
                app,
                arg: rest.join(':'),
                wait: ms => sleep(ms, cancellable),
                async shot(shotName) {
                    if (dir === '')
                        throw new Error('dev-screenshot-dir is empty');
                    if (!/^[A-Za-z0-9_.-]+$/.test(shotName))
                        throw new Error(`bad screenshot name '${shotName}'`);
                    if (cancellable.is_cancelled())
                        throw new SceneCancelled();
                    await writeScreenshot(`${dir}/${shotName}.png`);
                },
            };
            try {
                await scene(ctx);
            } catch (e) {
                if (e instanceof SceneCancelled)
                    throw e;
                reportSceneError(id, e);
            }
            if (cancellable.is_cancelled())
                return false;
        }
    } catch (e) {
        if (e instanceof SceneCancelled)
            return false;
        throw e;
    }
    console.log('TODOPET SCENES DONE');
    global.context.terminate();
    return true;
}

// Built-in scene: the bare desktop, to prove the harness itself works.
registerScene('smoke', async ctx => {
    Main.overview.hide();
    await ctx.wait(1000);
    await ctx.shot('smoke');
});

// The Shell services: one line with what they read, then each one is stopped twice and started again (the log
// must stay clean). Nothing is spoken or played: the nested shell would reach the real session's audio.
registerScene('services', async ctx => {
    const {app} = ctx;
    await ctx.wait(2000);
    const line = () => {
        const events = app.calendar.events(new Date()).length;
        return `idle=${Math.round(app.idle.idleSeconds())} key=${Math.round(app.idle.secondsSinceKey())} ` +
            `focus=${app.focus.current?.wmClass || 'none'} calendar=${app.calendar.kind} events=${events} speech=${hasSpeech()}`;
    };
    console.log(`TODOPET services ${line()}`);
    const info = app.calendar.serverInfo();
    if (info)
        console.log(`TODOPET services calendar backend ${JSON.stringify(info)}`);

    const services = [app.idle, app.focus, app.session, app.calendar];
    for (const service of services) {
        service.stop();
        service.stop();
    }
    await Promise.all(services.map(service => service.start()));
    await ctx.wait(1000);
    console.log(`TODOPET services restarted ${line()}`);
});

// --- The pet (ui/pet.js) ---

// A virtual mouse: the pet scenes move the real pointer, so hovering, the eyes and dragging go through the same input
// path as a person's mouse. One device for the whole run. A move to where the pointer already is would reset the
// idle time without moving it, which the typing heuristic (services/idle.js) takes for a key press; it is skipped.
let virtualMouse = null;

function mouse() {
    if (!virtualMouse) {
        const seat = global.stage.context.get_backend().get_default_seat();
        virtualMouse = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    }
    const device = virtualMouse;
    const now = () => GLib.get_monotonic_time();
    return {
        moveTo(x, y) {
            const [px, py] = global.get_pointer();
            if (Math.round(x) !== px || Math.round(y) !== py)
                device.notify_absolute_motion(now(), x, y);
        },
        press: () => device.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED),
        release: () => device.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED),
    };
}

// A spot on the desktop, away from the pet.
const AWAY = [60, 400];

function expect(ok, message) {
    if (!ok)
        throw new Error(message);
}

const describePet = pet => `${JSON.stringify(pet.frame)} ${pet.behavior} ground=${pet.ground}`;

// Waits (at most `ms`) until the pet stands or walks on the ground.
async function untilOnGround(ctx, pet, ms = 4000) {
    for (let waited = 0; waited <= ms; waited += 100) {
        if ((pet.behavior === 'idle' || pet.behavior === 'walk') && pet.frame.y === pet.ground)
            return;
        await ctx.wait(100);
    }
    throw new Error(`the pet is not on the ground: ${describePet(pet)}`);
}

// The far side of the work area from where the pet stands, so a walk there is long.
function farSide(pet) {
    const area = pet.workArea;
    const {x, width} = pet.frame;
    return x + width / 2 > area.x + area.width / 2 ? area.x + 50 : area.x + area.width - width - 50;
}

// Runs body(pet, mouse) with the brain's mood pinned to `mood` (null: the brain's own). `still-while-typing` is off
// meanwhile: a scene's clicks look like typing to the heuristic and would keep the pet still for 20 s (that rule is
// covered by the unit tests). Afterwards the mood and the setting are back, the pet may walk, and the mouse is away.
async function withPet(ctx, mood, body) {
    const {app} = ctx;
    const pet = app.pet;
    expect(pet?.visible, 'the pet is not on screen');
    const still = app.settings.get_boolean('still-while-typing');
    app.settings.set_boolean('still-while-typing', false);
    mouse().moveTo(...AWAY);
    if (mood)
        app.brain.pin({mood});
    try {
        await body(pet, mouse());
    } finally {
        mouse().moveTo(...AWAY);
        pet.paused = false;
        if (mood) {
            app.brain.pin({mood: undefined});
            app.brain.recompute();
        }
        app.settings.set_boolean('still-while-typing', still);
    }
}

// Two shots 2 s apart while the pet walks along the bottom of the work area.
registerScene('walk', ctx => withPet(ctx, Mood.normal, async pet => {
    await untilOnGround(ctx, pet);
    pet.walkTo(farSide(pet));
    await ctx.wait(500);
    expect(pet.motion.walking, `the pet should be walking: ${describePet(pet)}`);
    const first = pet.frame;
    await ctx.shot('walk-1');
    await ctx.wait(2000);
    const second = pet.frame;
    await ctx.shot('walk-2');
    console.log(`TODOPET walk x ${first.x} -> ${second.x}, y ${first.y} -> ${second.y}, ground ${pet.ground}, ` +
        `work area ${JSON.stringify(pet.workArea)}`);
    expect(Math.abs(second.x - first.x) >= 40, `the pet did not walk: x ${first.x} -> ${second.x}`);
    expect(first.y === pet.ground && second.y === pet.ground, 'the pet is not on the ground while it walks');
}));

// Frames the pet drew per second over the next `ms`.
async function paintRate(ctx, pet, ms) {
    const start = GLib.get_monotonic_time();
    const paints = pet.paints;
    await ctx.wait(ms);
    return (pet.paints - paints) / ((GLib.get_monotonic_time() - start) / 1e6);
}

// The pointer on a walking pet: it stops and gets the petted look, drawn at the full rate at first; under the
// parked pointer it then sits still at 4 fps (the animation budget).
registerScene('hover', ctx => withPet(ctx, Mood.normal, async (pet, pointer) => {
    await untilOnGround(ctx, pet);
    pet.walkTo(farSide(pet));
    await ctx.wait(700);
    expect(pet.motion.walking, `the pet should be walking before the hover: ${describePet(pet)}`);
    const {x, y, width, height} = pet.frame;
    pointer.moveTo(x + width / 2, y + height * 0.6);
    const hoverStart = GLib.get_monotonic_time();
    await ctx.wait(200);
    const early = await paintRate(ctx, pet, 1000);
    const before = pet.frame;
    await ctx.wait(500);
    const after = pet.frame;
    console.log(`TODOPET hover hovered=${pet.hovered} walking=${pet.motion.walking} x ${before.x} -> ${after.x}`);
    expect(pet.hovered, 'the pointer is on the pet but it is not hovered');
    expect(!pet.motion.walking && before.x === after.x, 'the pet keeps walking under the pointer');
    await ctx.shot('hover');
    const hoveredMs = (GLib.get_monotonic_time() - hoverStart) / 1000;
    await ctx.wait(Math.max(0, 3000 - hoveredMs));
    const late = await paintRate(ctx, pet, 3000);
    console.log(`TODOPET hover paints/s: ${early.toFixed(1)} in the first second, ${late.toFixed(1)} from 3 s to 6 s`);
    expect(pet.hovered, 'the pointer left the pet');
    expect(early >= 15, `the petted look is not drawn at the full rate (${early.toFixed(1)} paints/s)`);
    // The slow loop draws 4 frames a second; a change in the brain (a sync, the mood) adds a repaint of its own.
    expect(late <= 6, `a pet under a parked pointer still repaints ${late.toFixed(1)} times a second`);
}));

// Picks the pet up, lifts it 300 px, lets go: it falls back onto the ground.
registerScene('drag', ctx => withPet(ctx, Mood.normal, async (pet, pointer) => {
    await untilOnGround(ctx, pet);
    // Standing still, so it is where the pointer goes and lands where it was lifted.
    pet.paused = true;
    await ctx.wait(700);
    const start = pet.frame;
    const x = start.x + start.width / 2;
    const y = start.y + start.height * 0.6;
    pointer.moveTo(x, y);
    await ctx.wait(300);
    pointer.press();
    for (let step = 1; step <= 10; step++) {
        await ctx.wait(30);
        pointer.moveTo(x, y - 30 * step);
    }
    await ctx.wait(300);
    const air = pet.frame;
    console.log(`TODOPET drag held=${pet.motion.held} ${describePet(pet)} (lifted from y ${start.y})`);
    expect(pet.behavior === 'held' && pet.motion.held, `the pet is not held: ${describePet(pet)}`);
    expect(air.x === start.x && air.y === start.y - 300, `the pet did not follow the pointer 300 px up: ${describePet(pet)}`);
    await ctx.shot('drag-air');
    pointer.release();
    await ctx.wait(150);
    console.log(`TODOPET drag released: ${describePet(pet)}`);
    expect(pet.behavior === 'fall' && pet.frame.y > air.y, `the pet does not fall when let go: ${describePet(pet)}`);
    await untilOnGround(ctx, pet, 3000);
    pointer.moveTo(...AWAY);
    await ctx.wait(300);
    const landed = pet.frame;
    console.log(`TODOPET drag landed ${describePet(pet)}`);
    expect(landed.x === start.x && landed.y === start.y, `the pet did not land where it was lifted: ${describePet(pet)}`);
    await ctx.shot('drag-landed');
}));

// A focus session: the headband, and the countdown chip on the pet's head.
registerScene('focus-chip', ctx => withPet(ctx, null, async pet => {
    const {brain} = ctx.app;
    brain.startFocus(null);
    try {
        await ctx.wait(1500);
        console.log(`TODOPET focus mood=${brain.mood} chip=${pet.chipText}`);
        expect(brain.mood === Mood.focus, `the mood is ${brain.mood}, not focus`);
        expect(/^🍅 2[45]:\d\d$/.test(pet.chipText ?? ''), `the chip says '${pet.chipText}'`);
        await ctx.shot('focus-chip');
    } finally {
        brain.stopFocus();
    }
}));

// After work: the work hours are moved so that they ended before now (they start next hour). The brain calls only
// 23:00–06:00 night, which a scene cannot wait for, so the mood is pinned to sleeping, as the night would set it.
registerScene('sleeping', async ctx => {
    const {settings} = ctx.app;
    const saved = [settings.get_int('work-start'), settings.get_int('work-end')];
    const start = (new Date().getHours() + 1) % 24;
    settings.set_int('work-start', start);
    settings.set_int('work-end', start + 1);
    try {
        await withPet(ctx, Mood.sleeping, async pet => {
            await ctx.wait(1000);
            console.log(`TODOPET sleeping mood=${ctx.app.brain.mood} work ${start}-${start + 1} ${describePet(pet)}`);
            expect(ctx.app.brain.mood === Mood.sleeping, `the mood is ${ctx.app.brain.mood}`);
            expect(!pet.motion.walking, 'a sleeping pet does not walk');
            await ctx.shot('sleeping');
        });
    } finally {
        settings.set_int('work-start', saved[0]);
        settings.set_int('work-end', saved[1]);
    }
});
