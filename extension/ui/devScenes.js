// Developer scene runner for the nested-shell harness (tools/nested.sh). When the `dev-scenes` preference is
// not empty, App plays those scenes once after it starts, saves screenshots into `dev-screenshot-dir`, logs
// `TODOPET SCENES DONE` and terminates the shell. Production sessions never load this file.
//
// A scene is registered with registerScene(id, async ctx => ...). Modules that register scenes must be
// imported (statically) from here so that registering happens before runScenes() looks an id up.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {LogSummary, PetLog} from '../core/diary.js';
import {dayKey} from '../core/dates.js';
import {L} from '../core/l10n.js';
import {Lines} from '../core/lines.js';
import {Task} from '../core/models.js';
import {Mood} from '../core/mood.js';
import {rowCount, settingsPages} from '../core/settingsSpec.js';
import {ClaudeError} from '../services/claude.js';
import {hasSpeech} from '../services/speech.js';
import {signFrame} from './anticsLogic.js';
import {rectsOverlap} from './bubbleLogic.js';
import {menuModel} from './indicator.js';
import {indicatorLabel} from './indicatorLogic.js';
import {diaryRows, folderURI, stuckLine, templateSteps} from './viewsLogic.js';

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

// True once the scenes of this process were started. A module outlives the extension, so an App that is started again
// (a scene turning the extension off and on) does not play them again.
let started = false;

// Plays `ids` in order. A failing scene is reported and the next one still runs. Returns false when it was
// cancelled before the end (App.stop()) or when the scenes of this process were already started; otherwise logs
// `TODOPET SCENES DONE` and terminates the shell.
//
// ctx = {app, arg, wait(ms), shot(name), stopApp(), startApp(), restartedBy(trigger)}. `app` is always the App that is
// running now: a scene can turn the extension off (stopApp) and on again (startApp, which resolves when the new App
// has started), or make it restart itself (restartedBy), and the scenes go on with it. Only a scene may do that:
// App.stop() would otherwise cancel the run.
export async function runScenes(app, ids, dir, cancellable = new Gio.Cancellable()) {
    if (started)
        return false;
    started = true;
    let current = app;
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
                get app() {
                    return current;
                },
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
                // disable(): the App stops, but the run is let go of first so that its stop() does not cancel it.
                stopApp() {
                    current.releaseScenes();
                    current.extension.disable();
                },
                // For a scene that makes the extension restart itself (the menu's demo switch): `trigger()` does it, and
                // the scenes go on with the App that replaces the old one.
                async restartedBy(trigger) {
                    const old = current;
                    const {extension} = old;
                    old.releaseScenes();
                    trigger();
                    for (let waited = 0; (!extension.app || extension.app === old) && waited < 5000; waited += 50)
                        await sleep(50, cancellable);
                    const next = extension.app;
                    if (!next || next === old)
                        throw new Error('the extension did not restart');
                    next.adoptScenes(cancellable);
                    await next.whenStarted;
                    current = next;
                },
                // enable(): a new App, which is given the run (so that stopping it cancels the run) and which does not
                // play the scenes again. Resolves when it has started.
                async startApp() {
                    const {extension} = current;
                    extension.enable();
                    const next = extension.app;
                    next.adoptScenes(cancellable);
                    await next.whenStarted;
                    current = next;
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
        rightClick() {
            device.notify_button(now(), Clutter.BUTTON_SECONDARY, Clutter.ButtonState.PRESSED);
            device.notify_button(now() + 1000, Clutter.BUTTON_SECONDARY, Clutter.ButtonState.RELEASED);
        },
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
// covered by the unit tests). A bubble that is up (the brain's greeting when it starts) is taken away: the pet stands
// still while it is shown. Afterwards the mood and the setting are back, the pet may walk, and the mouse is away.
async function withPet(ctx, mood, body) {
    const {app} = ctx;
    const pet = app.pet;
    expect(pet?.visible, 'the pet is not on screen');
    app.brain.dismissBubble();
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
        // The pet's reply to the session (a bubble) would cover the chip on the head.
        brain.dismissBubble();
        await ctx.wait(200);
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

// --- The speech bubble (ui/bubble.js) ---

// Moves the pointer onto `actor` (a button) and clicks it, like a person would.
async function click(ctx, pointer, actor) {
    const [x, y] = actor.get_transformed_position();
    const [width, height] = actor.get_transformed_size();
    pointer.moveTo(x + width / 2, y + height / 2);
    await ctx.wait(150);
    pointer.press();
    await ctx.wait(60);
    pointer.release();
    await ctx.wait(300);
}

// What the diary says about `tag` responses so far.
const responses = (brain, tag) => brain.diary.today.filter(e => e.kind === 'response' && e.tag === tag).length;

// The bubble is where Swift puts it: inside the work area, at most 320 px wide, its bottom edge 62% up the pet, the
// tail's tip under the pet's center (the pet is away from the edges in the scenes, so the tail is not pushed aside).
function expectPlaced(view, pet) {
    const f = view.frame;
    const wa = pet.workArea;
    const p = pet.frame;
    console.log(`TODOPET bubble frame ${JSON.stringify(f)} tailX ${view.tailX.toFixed(1)} pet ${JSON.stringify(p)}`);
    expect(f.width <= 320, `the bubble is ${f.width} px wide`);
    expect(f.x >= wa.x && f.x + f.width <= wa.x + wa.width && f.y >= wa.y && f.y + f.height <= wa.y + wa.height,
        `the bubble is outside the work area: ${JSON.stringify(f)}`);
    expect(f.y + f.height <= p.y + p.height * 0.38 + 1, 'the bubble is not above the pet');
    const tip = f.x + 10 + view.tailX;
    expect(Math.abs(tip - (p.x + p.width / 2)) <= 1, `the tail points at x ${tip}, the pet is at ${p.x + p.width / 2}`);
}

// Nothing in the text is cut off: it is not ellipsized, and the label is as tall as its wrapped lines.
function expectTextWhole(view, minLines) {
    const label = view.textActor;
    const layout = label.clutter_text.get_layout();
    const [, logical] = layout.get_pixel_extents();
    const [, height] = label.get_transformed_size();
    console.log(`TODOPET bubble text lines=${layout.get_line_count()} ellipsized=${layout.is_ellipsized()} ` +
        `text ${logical.width}x${logical.height} label ${Math.round(label.get_transformed_size()[0])}x${Math.round(height)}`);
    expect(!layout.is_ellipsized(), 'the text is ellipsized');
    expect(layout.get_line_count() >= minLines, `the text wrapped to ${layout.get_line_count()} lines, not ${minLines}`);
    expect(height >= logical.height, `the label (${height} px) is shorter than its text (${logical.height} px)`);
    expect(logical.width <= label.get_transformed_size()[0] + 1, 'the text is wider than its label');
}

// The pet's morning greeting with its two buttons; a tap on "Later" runs that action and takes the bubble away.
registerScene('bubble', ctx => withPet(ctx, Mood.annoyed, async (pet, pointer) => {
    const {brain, bubble: view} = ctx.app;
    await untilOnGround(ctx, pet);
    const ran = [];
    const text = Lines.morning(new Date(), brain.day, brain.target);
    brain.say({
        text,
        seconds: 60,
        actions: [
            {title: L('＋ Thêm việc', '＋ Add tasks'), primary: true, run: () => ran.push('add')},
            {title: L('Để sau', 'Later'), run: () => ran.push('later')},
        ],
    }, {why: 'the bubble scene'});
    await ctx.wait(600);
    expect(view.visible && brain.bubble?.text === text, 'the bubble is not on screen');
    expect(view.actionButtons.length === 2, `the bubble has ${view.actionButtons.length} buttons, not 2`);
    expect(pet.paused, 'the pet does not stand still while the bubble is up');
    expectPlaced(view, pet);
    expectTextWhole(view, 1);
    await ctx.shot('bubble');

    // The pet is picked up and carried 150 px to the left and 60 px up: the bubble goes with it, tail under its center.
    const start = pet.frame;
    const x = start.x + start.width / 2;
    const y = start.y + start.height * 0.6;
    const before = view.frame;
    pointer.moveTo(x, y);
    await ctx.wait(300);
    pointer.press();
    for (let step = 1; step <= 10; step++) {
        await ctx.wait(30);
        pointer.moveTo(x - 15 * step, y - 6 * step);
    }
    await ctx.wait(300);
    const carried = view.frame;
    console.log(`TODOPET bubble follows: x ${before.x} -> ${carried.x}, y ${before.y} -> ${carried.y}`);
    expect(pet.motion.held, 'the pet is not held');
    expect(carried.x === before.x - 150 && carried.y === before.y - 60, `the bubble did not follow: ${JSON.stringify(carried)}`);
    expectPlaced(view, pet);
    pointer.release();
    await untilOnGround(ctx, pet, 3000);
    await ctx.wait(300);
    expect(view.frame.y === before.y && view.frame.x === before.x - 150, `the bubble is not above the pet again: ${JSON.stringify(view.frame)}`);
    expectPlaced(view, pet);

    await click(ctx, pointer, view.actionButtons[1]);
    console.log(`TODOPET bubble tapped Later: ran=${ran} visible=${view.visible} brain=${brain.bubble?.id ?? null}`);
    expect(ran.join() === 'later', `the action did not run once: ${ran}`);
    expect(!view.visible && brain.bubble === null, 'the bubble is still up after a tap on a button');
    expect(!pet.paused, 'the pet still stands after the bubble went');
    expect(responses(brain, 'picked') === 1, 'the diary does not say which button was tapped');
}));

// A task pushed back for days: three buttons in two rows. The close button takes the bubble away and the diary says
// it was closed.
registerScene('bubble-stuck', ctx => withPet(ctx, Mood.annoyed, async (pet, pointer) => {
    const {brain, bubble: view} = ctx.app;
    await untilOnGround(ctx, pet);
    const ran = [];
    brain.say({
        text: L('“Trả lời email của sếp” bị dời 4 ngày rồi 😑 Chắc nó to quá? Chia thành bước nhỏ cho dễ bắt đầu nhé.',
            '“Reply to the boss\'s email” has been pushed for 4 days 😑 Too big? Let\'s split it into small steps.'),
        seconds: 60,
        actions: [
            {title: L('✂️ Chia nhỏ', '✂️ Split it'), primary: true, run: () => ran.push('split')},
            {title: L('Bỏ khỏi kế hoạch', 'Drop from plan'), run: () => ran.push('drop')},
            {title: L('Để sau', 'Later'), run: () => ran.push('later')},
        ],
    }, {why: 'the bubble-stuck scene'});
    await ctx.wait(600);
    expect(view.visible, 'the bubble is not on screen');
    expect(view.actionButtons.length === 3, `the bubble has ${view.actionButtons.length} buttons, not 3`);
    const [first, second, third] = view.actionButtons.map(b => b.get_transformed_position()[1]);
    expect(first === second && third > first, `the buttons are not two to a row: y ${first}, ${second}, ${third}`);
    expectPlaced(view, pet);
    expectTextWhole(view, 2);
    await ctx.shot('bubble-stuck');

    await click(ctx, pointer, view.closeButton);
    console.log(`TODOPET bubble closed: ran=${ran} visible=${view.visible} brain=${brain.bubble?.id ?? null}`);
    expect(ran.length === 0, `closing the bubble ran an action: ${ran}`);
    expect(!view.visible && brain.bubble === null, 'the bubble is still up after the close button');
    expect(responses(brain, 'closed') === 1, 'the diary does not say the bubble was closed');

    // A reply to something you did (not a reminder) that fades away, or is closed, is nobody's business.
    brain.say({text: 'Xong rồi! 🎉', seconds: 1});
    await ctx.wait(400);
    expect(view.visible, 'the reply is not on screen');
    await ctx.wait(1500);
    expect(!view.visible && brain.bubble === null, 'the reply did not fade after its second');
    expect(responses(brain, 'ignored') === 0, 'a reply that faded was reported as ignored');
    expect(responses(brain, 'closed') === 1, 'the diary has more than one close');
}));

// A 150-character Vietnamese title with emoji, a word with no break in it, and buttons with long titles: everything
// wraps inside the bubble and nothing is cut. Nobody taps anything: the bubble fades after its 3 seconds and the
// diary says it was ignored.
registerScene('long-title', ctx => withPet(ctx, Mood.normal, async pet => {
    const {brain, bubble: view} = ctx.app;
    await untilOnGround(ctx, pet);
    const title = 'Soạn bản báo cáo tổng kết quý ba cho phòng kỹ thuật, gồm doanh thu, chi phí và kế hoạch tuyển dụng, ' +
        'rồi gửi chị Lan duyệt trước 17 giờ chiều nay 📊🚀✨';
    expect(title.length === 150, `the title has ${title.length} characters`);
    const word = 'Khôngcókhoảngtrắngnàoởđâyhếtmàdàiquámứcmộtdòng👨‍👩‍👧‍👦';
    // A bubble with a button is up; the urgent one replaces it (and nobody is told about the first).
    brain.say({text: 'Xin chào 👋', seconds: 60, actions: [{title: 'Ok'}]});
    await ctx.wait(300);
    const first = view.bubble?.id;
    expect(view.visible && view.actionButtons.length === 1, 'the first bubble is not on screen');
    brain.say({
        text: `“${title}” bị dời 6 ngày rồi 😑\n${word}`,
        seconds: 3,
        urgent: true,
        actions: [
            {title: '▶︎ Tập trung 25\'', primary: true},
            {title: 'Kéo 12 việc quá hạn vào hôm nay'},
            {title: 'Để sau'},
        ],
    }, {why: 'the long-title scene'});
    const shownAt = GLib.get_monotonic_time();
    const sinceShown = () => (GLib.get_monotonic_time() - shownAt) / 1e6;
    await ctx.wait(600);
    expect(view.visible && view.bubble.id !== first && view.bubble.id === brain.bubble?.id,
        'the urgent bubble did not replace the first one');
    expect(view.actionButtons.length === 3, `the bubble has ${view.actionButtons.length} buttons, not 3`);
    expectPlaced(view, pet);
    expectTextWhole(view, 5);
    const content = view.textActor.get_transformed_size()[0];
    for (const button of view.actionButtons) {
        const [x] = button.get_transformed_position();
        const [width] = button.get_transformed_size();
        const [textX] = view.textActor.get_transformed_position();
        expect(x + width <= textX + content + 1, `a button sticks out of the bubble: ${x} + ${width}`);
    }
    await ctx.shot('long-title');

    // Up for 3 s: still there at 2.5 s, gone by 3.6 s (a 0.2 s fade), well before the brain's own drop at 5 s.
    await ctx.wait(Math.max(0, 2500 - sinceShown() * 1000));
    expect(sinceShown() < 2.9, `the scene was too slow to look at the bubble before its time (${sinceShown()} s)`);
    expect(view.visible && brain.bubble !== null, 'the bubble went before its time');
    await ctx.wait(Math.max(0, 3600 - sinceShown() * 1000));
    console.log(`TODOPET bubble faded at ${sinceShown().toFixed(1)} s: visible=${view.visible} ` +
        `brain=${brain.bubble?.id ?? null}`);
    expect(!view.visible && brain.bubble === null, 'the bubble did not go after its seconds');
    expect(responses(brain, 'ignored') === 1, 'the diary does not say the bubble was ignored');
    expect(!pet.paused, 'the pet still stands after the bubble went');
}));

// --- The task board (ui/board.js) ---

// A virtual keyboard, like the mouse above: keys go through the same path as a person's (the board's modal grab).
let virtualKeyboard = null;

function keyboard() {
    if (!virtualKeyboard) {
        const seat = global.stage.context.get_backend().get_default_seat();
        virtualKeyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    }
    const device = virtualKeyboard;
    return {
        tap(keyval) {
            const now = GLib.get_monotonic_time();
            device.notify_keyval(now, keyval, Clutter.KeyState.PRESSED);
            device.notify_keyval(now + 1000, keyval, Clutter.KeyState.RELEASED);
        },
        // A shortcut: the keys go down in order and come up in reverse, like a person's fingers.
        chord(...keyvals) {
            const now = GLib.get_monotonic_time();
            keyvals.forEach((keyval, i) => device.notify_keyval(now + i * 1000, keyval, Clutter.KeyState.PRESSED));
            [...keyvals].reverse().forEach((keyval, i) =>
                device.notify_keyval(now + (keyvals.length + i) * 1000, keyval, Clutter.KeyState.RELEASED));
        },
    };
}

// Runs body(board, pet, pointer) on a work day whose hours put "now" where the reference screenshot is (after the plan
// deadline, before the end of the day, so the calendar card has free time and, before 18:00, time blocks), with the
// daily target of 3 (not lowered for the demo's meetings) and the mood pinned (null: the brain's own). Afterwards the
// board is closed and the settings are back.
async function withBoard(ctx, mood, body) {
    const {settings} = ctx.app;
    const ints = ['work-start', 'work-end', 'plan-deadline'].map(key => [key, settings.get_int(key)]);
    const days = ['work-saturday', 'work-sunday', 'adapt-target'].map(key => [key, settings.get_boolean(key)]);
    const hour = new Date().getHours();
    const start = Math.max(0, hour - 4);
    settings.set_int('work-start', start);
    settings.set_int('work-end', Math.min(24, hour + 6));
    settings.set_int('plan-deadline', Math.max(start, hour - 2));
    for (const [key] of days)
        settings.set_boolean(key, key !== 'adapt-target');
    try {
        await withPet(ctx, mood, async (pet, pointer) => {
            const board = ctx.app.board;
            await untilOnGround(ctx, pet);
            try {
                await body(board, pet, pointer);
            } finally {
                board.close();
            }
        });
    } finally {
        for (const [key, value] of ints)
            settings.set_int(key, value);
        for (const [key, value] of days)
            settings.set_boolean(key, value);
    }
}

// The board is inside the work area and next to the pet: above its body, or beside it.
function expectBoardPlaced(board, pet) {
    const f = board.frame;
    const wa = pet.workArea;
    const p = pet.frame;
    console.log(`TODOPET board frame ${JSON.stringify(f)} side ${board.side} pet ${JSON.stringify(p)} work area ${JSON.stringify(wa)}`);
    expect(f.x >= wa.x && f.y >= wa.y && f.x + f.width <= wa.x + wa.width && f.y + f.height <= wa.y + wa.height,
        `the board is outside the work area: ${JSON.stringify(f)}`);
    const beside = {
        above: f.y + f.height <= p.y + p.height * 0.28,
        left: f.x + f.width <= p.x,
        right: f.x >= p.x + p.width,
    }[board.side];
    expect(beside, `the board is not next to the pet (${board.side})`);
}

const modalBefore = () => Main.modalCount;

// The board with the demo's day, as docs/board-light.png: header, life bar, demo note, "only 2/3 planned", the add
// row, the frog, the calendar card, then the overdue task and today's two. The reason shows its breakdown on hover.
// Escape closes it and gives the modal grab back; a click on the pet opens it, a click outside closes it.
registerScene('board', ctx => withBoard(ctx, Mood.angry, async (board, pet, pointer) => {
    const {brain} = ctx.app;
    const modals = modalBefore();
    board.open();
    await ctx.wait(1000);
    await brain.settle();
    await ctx.wait(300);
    const sections = board.sections();
    console.log(`TODOPET board sections ${sections.join(' ')} | list ${board.listText().join(' | ')}`);
    console.log(`TODOPET board header "${board.model.header.title}" ${board.model.header.progress} ` +
        `"${board.model.header.reason?.label}" streak ${board.model.header.streak?.value}`);
    expect(board.isOpen && Main.modalCount === modals + 1, `the board is not open and modal (${Main.modalCount} modals)`);
    expect(pet.paused, 'the pet does not stand still while the board is open');
    expect(sections.join() === 'header,life,demo,nag,add,frog,calendar,list', `the board's parts: ${sections}`);
    const {lists} = board.model;
    expect(lists.overdue?.rows.length === 1 && lists.today.rows.length === 2,
        `the demo's day is not 1 overdue and 2 today: ${board.listText()}`);
    const calendar = board.model.calendar;
    console.log(`TODOPET board calendar "${calendar?.meeting?.label ?? calendar?.none}" "${calendar?.summary}" ` +
        `blocks ${calendar?.blocks.map(b => b.time).join(' ')}`);
    expect(calendar?.meeting || calendar?.none, 'the calendar card is missing');
    // The demo's meetings are 1 and 4 hours from now; before 18:00 there is a free slot between them.
    expect(new Date().getHours() > 17 || calendar.blocks.length > 0, 'the calendar card has no time blocks');
    expectBoardPlaced(board, pet);
    await ctx.shot('board');

    // The reason line explains itself on hover.
    const reason = board.reasonLabel;
    expect(reason, 'the reason line is missing');
    const [rx, ry] = reason.get_transformed_position();
    const [rw, rh] = reason.get_transformed_size();
    pointer.moveTo(rx + rw / 2, ry + rh / 2);
    await ctx.wait(900);
    const tip = board.tooltip;
    console.log(`TODOPET board tooltip visible=${tip.visible} "${tip.text.replaceAll('\n', ' / ')}"`);
    expect(tip.visible && tip.text === board.model.header.breakdown, 'the reason breakdown does not show on hover');
    pointer.moveTo(...AWAY);
    await ctx.wait(200);

    // Step 2 of the brief: Escape closes the board.
    const used = board.handleKey(Clutter.KEY_Escape);
    console.log(`TODOPET board closed=${!board.isOpen}`);
    expect(used && !board.isOpen, 'Escape did not close the board');
    expect(Main.modalCount === modals, `the modal grab was not given back (${Main.modalCount} modals, ${modals} before)`);
    expect(!pet.paused || ctx.app.bubble.visible, 'the pet still stands after the board closed');

    // A click on the pet opens it; a click anywhere outside it closes it again.
    pet.paused = true;
    await ctx.wait(300);
    const {x, y, width, height} = pet.frame;
    pointer.moveTo(x + width / 2, y + height * 0.6);
    await ctx.wait(200);
    pointer.press();
    await ctx.wait(60);
    pointer.release();
    await ctx.wait(500);
    console.log(`TODOPET board opened by the pet: ${board.isOpen}`);
    expect(board.isOpen && Main.modalCount === modals + 1, 'a click on the pet did not open the board');
    pointer.moveTo(...AWAY);
    await ctx.wait(200);
    pointer.press();
    await ctx.wait(60);
    pointer.release();
    await ctx.wait(300);
    console.log(`TODOPET board closed by a click outside: ${!board.isOpen} modals ${Main.modalCount}`);
    expect(!board.isOpen && Main.modalCount === modals, 'a click outside did not close the board');
}));

// No token and no demo: the board asks for a Todoist token (Swift: TokenSetupView). The demo comes back afterwards.
registerScene('board-setup', ctx => withBoard(ctx, null, async board => {
    const {brain} = ctx.app;
    brain.removeToken();
    try {
        await ctx.wait(300);
        board.open();
        await ctx.wait(800);
        console.log(`TODOPET board-setup view=${board.view} hasToken=${brain.hasToken} demo=${brain.demo} ` +
            `sections ${board.sections().join(' ')}`);
        expect(board.view === 'setup', `the board shows ${board.view}, not the token setup`);
        expect(board.tokenEntry.mapped && board.tokenEntry instanceof St.PasswordEntry, 'the token field is not on screen');
        expect(!board.sections().includes('life'), 'the life bar shows without a token');
        await ctx.shot('board-setup');
    } finally {
        board.close();
        brain.useDemo();
        await brain.settle();
        // The demo's greeting gets a frame on screen first: a bubble shown and taken away within one frame makes
        // Clutter warn about allocating an actor that already left the stage.
        await ctx.wait(300);
        brain.dismissBubble();
    }
}));

// A task's delete question (Swift: TaskRow's confirmation). Cancel keeps the task; Delete removes it.
registerScene('board-delete', ctx => withBoard(ctx, Mood.angry, async (board, pet, pointer) => {
    const {brain} = ctx.app;
    board.open();
    await ctx.wait(800);
    await brain.settle();
    const task = brain.day.overdue[0] ?? brain.day.today[0];
    expect(task, 'the demo has no task to delete');
    board.confirmDelete(task.id);
    await ctx.wait(300);
    const asking = [...board.model.lists.overdue?.rows ?? [], ...board.model.lists.today.rows].find(r => r.confirm);
    console.log(`TODOPET board-delete asks "${asking?.confirm}" about "${asking?.title}"`);
    expect(board.confirmButtons && asking?.id === task.id, 'the delete question is not shown');
    await ctx.shot('board-delete');

    await click(ctx, pointer, board.confirmButtons.cancel);
    expect(board.isOpen && board.confirmButtons === null, 'Cancel did not take the question away (or closed the board)');
    expect(brain.day.open.some(t => t.id === task.id), 'Cancel deleted the task');
    // The pointer is still on the row: its actions show (▶ focus, ✂ split, move, delete) and the check has its mark.
    await ctx.shot('board-hover');

    board.confirmDelete(task.id);
    await ctx.wait(300);
    await click(ctx, pointer, board.confirmButtons.remove);
    await brain.settle();
    await ctx.wait(300);
    const gone = !brain.day.open.some(t => t.id === task.id);
    console.log(`TODOPET board-delete deleted=${gone} bubble="${brain.bubble?.text ?? ''}" list ${board.listText().join(' | ')}`);
    expect(gone && !board.listText().includes(task.title), 'Delete did not remove the task');
    expect(board.isOpen, 'deleting closed the board');
}));

// "Add a task" with the key focus in it (focusAdd, as the shortcut opens it), a title typed in; Enter adds it and
// empties the field, the Escape key closes the board.
registerScene('add', ctx => withBoard(ctx, null, async board => {
    const {brain} = ctx.app;
    board.open({focusAdd: true});
    await ctx.wait(800);
    await brain.settle();
    const entry = board.addEntry;
    const focus = global.stage.get_key_focus();
    expect(focus === entry.clutter_text || focus === entry, `the key focus is not in the add field (${focus})`);
    entry.set_text('Call Anna');
    await ctx.wait(300);
    await ctx.shot('add');

    keyboard().tap(Clutter.KEY_Return);
    for (let i = 0; i < 30 && !brain.day.today.some(t => t.title === 'Call Anna'); i++)
        await ctx.wait(100);
    await brain.settle();
    await ctx.wait(400);
    console.log(`TODOPET add today=${brain.day.today.map(t => t.title).join(' | ')} entry="${entry.get_text()}" ` +
        `bubble="${brain.bubble?.text ?? ''}"`);
    expect(brain.day.today.some(t => t.title === 'Call Anna'), 'Enter did not add the task');
    expect(entry.get_text() === '', 'the add field was not emptied');
    expect(board.listText().includes('Call Anna'), 'the board does not list the new task');
    await ctx.shot('add-saved');

    keyboard().tap(Clutter.KEY_Escape);
    await ctx.wait(300);
    console.log(`TODOPET add closed by the Escape key: ${!board.isOpen}`);
    expect(!board.isOpen, 'the Escape key did not close the board');
}));

// A 300-character title on the frog card and on a task row: each is cut to 120 characters (an ellipsis at the end)
// and wraps, so the board stays inside the work area (Swift: lineLimit(2)). The two tasks go into the demo's list
// and come out again afterwards.
registerScene('board-long-title', ctx => withBoard(ctx, null, async (board, pet) => {
    const {brain} = ctx.app;
    const demo = brain.todo;
    expect(brain.demo && Array.isArray(demo?._active), 'the long-title board scene needs the demo');
    const words = 'Viết lại toàn bộ tài liệu hướng dẫn cài đặt cho khách hàng mới, kèm ảnh chụp từng bước và danh sách kiểm tra. ';
    const long = words.repeat(4).slice(0, 300);
    expect(long.length === 300, `the title has ${long.length} characters`);
    const now = new Date();
    const yesterday = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12));
    // P1 and overdue: the frog. P4 today: a row.
    const frog = new Task({id: 'long-frog', content: `A ${long}`, priority: 4, due: {date: yesterday, string: 'yesterday'}});
    const row = new Task({id: 'long-row', content: `B ${long}`, priority: 1, due: {date: dayKey(now), string: 'today'}});
    demo._active.push(frog, row);
    try {
        board.open();
        await brain.refresh();
        await ctx.wait(800);
        await brain.settle();
        await ctx.wait(300);
        const titles = [];
        const walk = actor => {
            if (actor instanceof St.Label &&
                (actor.has_style_class_name('todopet-frog-title') || actor.has_style_class_name('todopet-task-title')))
                titles.push(actor.text);
            for (const child of actor.get_children())
                walk(child);
        };
        walk(board.actor);
        const shown = titles.filter(text => text.startsWith('A Viết') || text.startsWith('B Viết'));
        const f = board.frame;
        const wa = pet.workArea;
        console.log(`TODOPET board-long-title frog=${board.model.frog?.task.id} titles ${shown.map(t => t.length).join(' ')} ` +
            `board ${JSON.stringify(f)} work area ${JSON.stringify(wa)}`);
        expect(board.model.frog?.task.id === 'long-frog', `the long task is not the frog (${board.model.frog?.task.id})`);
        expect(board.listText().includes(row.title), 'the long task is not in the list');
        expect(shown.length >= 2 && shown.every(text => text.length <= 120 && text.endsWith('…')),
            `the long titles are not cut to 120 characters: ${shown.map(t => t.length)}`);
        expect(f.height <= wa.height, `the board is taller than the work area: ${f.height} > ${wa.height}`);
        expectBoardPlaced(board, pet);
        await ctx.shot('board-long-title');
    } finally {
        board.close();
        demo._active = demo._active.filter(t => t !== frog && t !== row);
        await brain.refresh();
        await brain.settle();
    }
}));

// Ruling R13: an urgent bubble while the board is open goes next to the board, not over it. A press on the bubble's
// background leaves the board open; its button works; when the board closes the bubble goes back above the pet.
registerScene('board-bubble', ctx => withBoard(ctx, Mood.angry, async (board, pet, pointer) => {
    const {brain, bubble: view} = ctx.app;
    board.open();
    await ctx.wait(800);
    await brain.settle();
    const ran = [];
    const say = () => brain.say({
        text: Lines.added('Call Anna'), seconds: 30, urgent: true,
        actions: [{title: 'Ok', primary: true, run: () => ran.push('ok')}],
    });
    say();
    await ctx.wait(500);
    const f = view.frame;
    const b = board.frame;
    console.log(`TODOPET board-bubble bubble ${JSON.stringify(f)} ${view.spot} tail=${view.tailX} board ${JSON.stringify(b)} ${board.side}`);
    expect(board.isOpen && view.visible, 'the urgent bubble is not up next to the open board');
    expect(!rectsOverlap(f, b), 'the bubble covers the board');
    const wa = pet.workArea;
    expect(f.x >= wa.x && f.y >= wa.y && f.x + f.width <= wa.x + wa.width && f.y + f.height <= wa.y + wa.height,
        `the bubble is outside the work area: ${JSON.stringify(f)}`);
    await ctx.shot('board-bubble');

    // The bubble's background (its text) is not "outside the board".
    const [tx, ty] = view.textActor.get_transformed_position();
    const [tw, th] = view.textActor.get_transformed_size();
    pointer.moveTo(tx + tw / 2, ty + th / 2);
    await ctx.wait(150);
    pointer.press();
    await ctx.wait(60);
    pointer.release();
    await ctx.wait(300);
    console.log(`TODOPET board-bubble background pressed: board open=${board.isOpen} bubble=${view.visible}`);
    expect(board.isOpen && view.visible, 'a press on the bubble closed the board or the bubble');

    // The board closes: the bubble goes back above the pet, its tail on the pet.
    board.handleKey(Clutter.KEY_Escape);
    await ctx.wait(300);
    console.log(`TODOPET board-bubble after the board closed: ${view.spot} ${JSON.stringify(view.frame)}`);
    expect(!board.isOpen && view.visible && view.spot === 'pet', 'the bubble did not go back above the pet');
    expectPlaced(view, pet);

    // Its button works over the open board, and the board stays open.
    board.open();
    await ctx.wait(500);
    say();
    await ctx.wait(500);
    await click(ctx, pointer, view.actionButtons[0]);
    console.log(`TODOPET board-bubble button pressed: ran=${ran} board open=${board.isOpen} bubble=${view.visible}`);
    expect(ran.join() === 'ok' && board.isOpen && !view.visible, 'the bubble\'s button did not work next to the board');
}));

// The pet hidden for an hour: the board it had open closes once, and the board opened while the pet is away stays
// open (in the corner under the panel) across the 1-second visibility ticks.
registerScene('board-hidden', ctx => withBoard(ctx, null, async (board, pet) => {
    const {prefs} = ctx.app;
    board.open();
    await ctx.wait(500);
    expect(board.isOpen && pet.visible, 'the board is not open next to the pet');
    prefs.hiddenUntil = Date.now() + 3600 * 1000;
    try {
        await ctx.wait(300);
        console.log(`TODOPET board-hidden pet hidden: pet=${pet.visible} board open=${board.isOpen}`);
        expect(!pet.visible && !board.isOpen, 'hiding the pet did not close its board');
        board.open();
        await ctx.wait(2600);
        console.log(`TODOPET board-hidden opened while hidden: open=${board.isOpen} side=${board.side} after 2.6 s`);
        expect(board.isOpen && board.side === 'corner', 'the board opened while the pet is hidden did not stay open');
        await ctx.shot('board-hidden');
    } finally {
        board.close();
        prefs.hiddenUntil = 0;
    }
    await ctx.wait(300);
    expect(pet.visible, 'the pet did not come back');
}));

// --- The split view, the wardrobe and the diary (ui/splitView.js, ui/wardrobe.js, ui/diary.js) ---

// Runs body() with `object[name]` replaced by `stub`; the real one is back afterwards.
async function withStub(object, name, stub, body) {
    const real = object[name];
    object[name] = stub;
    try {
        await body();
    } finally {
        object[name] = real;
    }
}

// Waits (at most `ms`) until `done()`; the check runs every 100 ms.
async function until(ctx, done, ms = 3000) {
    for (let waited = 0; waited <= ms && !done(); waited += 100)
        await ctx.wait(100);
}

// A task cut into steps: the stuck task's page opens the way the stuck bubble's "✂️ Split it" opens it. The quick
// template, adding and removing steps, Ask Claude (off without a key; with one it fails here, the keyring is empty),
// then Save adds the steps as sub-tasks of the task (the first one on today's plan) and the page closes.
registerScene('split', ctx => withBoard(ctx, Mood.angry, async (board, pet, pointer) => {
    const {brain} = ctx.app;
    board.open();
    await ctx.wait(800);
    await brain.settle();
    // The demo's overdue task is the stuck one (docs/split.png); an earlier scene (board-delete) may have deleted it.
    const stuck = brain.stuckTasks[0] ?? null;
    const task = stuck?.task ?? brain.day.today[0];
    expect(task, 'the demo has no task to split');
    brain.openBreakdown(task);
    await ctx.wait(500);
    expect(board.isOpen && board.pageKind === 'split' && board.view === 'page', `the split page is not up (${board.pageKind})`);
    const view = board.page.view;
    console.log(`TODOPET split "${view.model.title}" task "${view.model.task}" stuck "${view.model.stuck}" ` +
        `ask enabled=${view.model.ask.enabled} hint="${view.model.keyHint}" steps ${view.entries.length}`);
    expect(view.model.stuck === stuckLine(stuck?.days ?? null) && view.stuckLabel.visible === Boolean(stuck),
        `the stuck line: ${view.model.stuck}`);
    expect(view.entries.length === 3 && !view.saveButton.reactive, 'three blank steps, nothing to save yet');
    expect(!view.askButton.reactive && view.keyHint.visible, 'Ask Claude is on without a key');
    const f = board.frame;
    const wa = pet.workArea;
    expect(f.x >= wa.x && f.y >= wa.y && f.x + f.width <= wa.x + wa.width && f.y + f.height <= wa.y + wa.height,
        `the board is outside the work area: ${JSON.stringify(f)}`);

    // The quick template, with a real click.
    await click(ctx, pointer, view.templateButton);
    await until(ctx, () => !view.filling);
    const template = templateSteps(task.title);
    expect(view.entries.map(e => e.get_text()).join('|') === template.join('|'), `the template: ${view.entries.map(e => e.get_text())}`);
    expect(view.saveButton.reactive, 'a filled template cannot be saved');

    // Add a step, then take it away again.
    await click(ctx, pointer, view.addStepButton);
    expect(view.entries.length === 4 && view.entries[3].get_text() === '', 'Add a step did not add a blank step');
    await click(ctx, pointer, view.removeButtons[3]);
    expect(view.entries.length === 3, 'the remove button did not take the step away');
    expect(view.entries.map(e => e.get_text()).join('|') === template.join('|'), 'removing a step changed the others');

    // The steps of docs/split.png.
    const steps = [
        L('Mở hộp thư, lọc email của sếp', 'Open the inbox and find the boss\'s email'),
        L('Ghi 3 ý chính cần trả lời', 'Jot down the 3 points to answer'),
        L('Viết và gửi bản trả lời ngắn', 'Write and send a short reply'),
    ];
    view.setSteps(steps);
    await until(ctx, () => !view.filling);
    await ctx.wait(200);
    board.actor.grab_key_focus();
    pointer.moveTo(...AWAY);
    await ctx.wait(300);
    await ctx.shot('split');

    // Ask Claude needs a key; with one in the settings but none in the keyring it fails and says why.
    brain.hasClaudeKey = true;
    brain.emit('changed');
    await ctx.wait(200);
    expect(view.askButton.reactive && !view.keyHint.visible, 'a key did not turn Ask Claude on');
    await click(ctx, pointer, view.askButton);
    await until(ctx, () => !view.asking);
    const failure = `⚠️ ${new ClaudeError('noKey').userMessage}`;
    console.log(`TODOPET split ask says "${view.errorLabel.text}" visible=${view.errorLabel.visible}`);
    expect(view.errorLabel.visible && view.errorLabel.text === failure, `Ask Claude's error: ${view.errorLabel.text}`);
    expect(view.entries.map(e => e.get_text()).join('|') === steps.join('|'), 'a failed Ask Claude changed the steps');
    pointer.moveTo(...AWAY);
    await ctx.wait(200);
    await ctx.shot('split-error');
    brain.hasClaudeKey = false;
    brain.emit('changed');
    await ctx.wait(200);
    expect(!view.askButton.reactive, 'Ask Claude stayed on after the key went');

    // Save: the steps become sub-tasks of the task, the first one for today; the page closes, the board stays.
    const service = brain.todo;
    const calls = [];
    const created = [];
    const addTask = service.addTask.bind(service);
    await withStub(service, 'addTask', async args => {
        calls.push(args);
        const made = await addTask(args);
        created.push(made);
        return made;
    }, async () => {
        await click(ctx, pointer, view.saveButton);
        await until(ctx, () => board.pageKind !== 'split');
        await brain.settle();
    });
    try {
        console.log(`TODOPET split saved ${JSON.stringify(calls.map(c => [c.content, c.dueString, c.parentId]))} page=${board.pageKind}`);
        expect(calls.length === 3 && calls.every((c, i) => c.content === steps[i] && c.parentId === task.id), 'the sub-tasks were not added');
        expect(calls[0].dueString === 'today' && calls[1].dueString === null && calls[2].dueString === null,
            'only the first step goes on today\'s plan');
        expect(calls.every(c => c.priority === task.apiPriority), 'the sub-tasks do not take the task\'s priority');
        expect(board.isOpen && board.pageKind === null && board.view === 'tasks', 'saving did not take the board back to the task list');
        expect(brain.day.today.some(t => t.title === steps[0] && t.parentId === task.id), 'the first step is not on today\'s plan');
        await ctx.wait(300);
        await ctx.shot('split-saved');
    } finally {
        // The demo's day is as it was.
        for (const made of created)
            await service.delete(made.id);
        brain.dismissBubble();
        brain.refreshSoon();
        await brain.settle();
    }

    // The delete question and Drop from plan, on a task the brain is not asked to change.
    const deleted = [];
    const dropped = [];
    await withStub(brain, 'delete', t => deleted.push(t.id), () => withStub(brain, 'unplan', t => dropped.push(t.id), async () => {
        brain.openBreakdown(task);
        await ctx.wait(400);
        const page = board.page.view;
        await click(ctx, pointer, page.deleteButton);
        console.log(`TODOPET split delete asks "${page.model.confirm?.text}"`);
        expect(page.confirmButtons && page.model.confirm.text === Lines.confirmDelete(task), 'the delete question is not shown');
        await ctx.shot('split-confirm');
        expect(board.handleKey(Clutter.KEY_Escape) && board.isOpen && !page.confirmButtons, 'Escape did not take the question away first');
        await click(ctx, pointer, page.deleteButton);
        await click(ctx, pointer, page.confirmButtons.cancel);
        expect(!page.confirmButtons && deleted.length === 0 && board.pageKind === 'split', 'Cancel deleted the task or left the page');
        await click(ctx, pointer, page.deleteButton);
        await click(ctx, pointer, page.confirmButtons.remove);
        expect(deleted.join() === task.id && board.pageKind === null, `Delete: ${deleted} page=${board.pageKind}`);

        brain.openBreakdown(task);
        await ctx.wait(400);
        await click(ctx, pointer, board.page.view.dropButton);
        expect(dropped.join() === task.id && board.pageKind === null, `Drop from plan: ${dropped} page=${board.pageKind}`);

        brain.openBreakdown(task);
        await ctx.wait(400);
        await click(ctx, pointer, board.page.view.backButton);
        expect(board.pageKind === null && board.isOpen, 'the back button did not go back to the task list');
    }));
}));

// The wardrobe, opened with the life bar's button: the pet, five stats, the sticker book and six accessories. Wear and
// Take off with real clicks (one accessory per slot), and the back button.
registerScene('wardrobe', ctx => withBoard(ctx, Mood.angry, async (board, pet, pointer) => {
    const {brain} = ctx.app;
    board.open();
    await ctx.wait(800);
    await brain.settle();
    await click(ctx, pointer, board.wardrobeButton);
    expect(board.isOpen && board.pageKind === 'wardrobe' && board.view === 'page', `the wardrobe is not up (${board.pageKind})`);
    const view = board.page.view;
    const m = view.model;
    console.log(`TODOPET wardrobe "${m.title}" stats ${m.stats.map(s => `${s.label}: ${s.value}`).join(' | ')} | ` +
        `${m.stickers.title} ${m.stickers.stars} | ${m.accessories.map(a => `${a.name}: ${a.status}`).join(' | ')}`);
    expect(view.rows.length === 6 && m.accessories.map(a => a.owned).join() === 'true,true,false,true,false,false',
        'the demo pet does not own the bow, the scarf and the top hat');
    expect(view.rows.map(r => r.button.visible).join() === 'true,true,false,true,false,false', 'only the unlocked ones have a button');
    expect(view.petActor.mapped, 'the pet is not on screen');
    expect(view.stickerLabels.stars.text === '🌟🌟🌟', 'the sticker book does not show three stars');
    expect(brain.life.state.wearing.join() === 'scarf', `the demo pet wears ${brain.life.state.wearing}`);
    const f = board.frame;
    const wa = pet.workArea;
    expect(f.x >= wa.x && f.y >= wa.y && f.x + f.width <= wa.x + wa.width && f.y + f.height <= wa.y + wa.height,
        `the board is outside the work area: ${JSON.stringify(f)}`);
    pointer.moveTo(...AWAY);
    await ctx.wait(300);
    await ctx.shot('wardrobe');

    // The sticker stars list the days on hover (Swift: .help).
    const stars = view.stickerLabels.stars;
    const [sx, sy] = stars.get_transformed_position();
    const [sw, sh] = stars.get_transformed_size();
    pointer.moveTo(sx + sw / 2, sy + sh / 2);
    await ctx.wait(900);
    const tip = board.page.view.tooltipLabel;
    console.log(`TODOPET wardrobe tooltip visible=${tip.visible} "${tip.text}"`);
    expect(tip.visible && tip.text === m.stickers.days, 'the sticker book does not list its days on hover');
    await ctx.shot('wardrobe-tooltip');
    pointer.moveTo(...AWAY);
    await ctx.wait(300);

    const changes = [];
    const id = brain.on('changed', () => changes.push(brain.life.state.wearing.join()));
    try {
        const row = accessory => view.rows.find(r => r.id === accessory);
        // The bow is worn with the scarf (a head slot and a neck slot).
        await click(ctx, pointer, row('bow').button);
        console.log(`TODOPET wardrobe wearing ${brain.life.state.wearing} button "${row('bow').button.label}" changes ${changes}`);
        expect(brain.life.state.wearing.join() === 'scarf,bow', `Wear: ${brain.life.state.wearing}`);
        expect(row('bow').button.label === L('Cởi ra', 'Take off') && changes.length > 0, 'the button did not turn into Take off');
        pointer.moveTo(...AWAY);
        await ctx.wait(300);
        await ctx.shot('wardrobe-worn');
        // The top hat takes the bow's place (one accessory per slot).
        await click(ctx, pointer, row('tophat').button);
        expect(brain.life.state.wearing.join() === 'scarf,tophat', `the top hat did not replace the bow: ${brain.life.state.wearing}`);
        expect(row('bow').button.label === L('Đeo', 'Wear'), 'the bow still says Take off');
        await click(ctx, pointer, row('tophat').button);
        expect(brain.life.state.wearing.join() === 'scarf', `Take off: ${brain.life.state.wearing}`);
    } finally {
        brain.off(id);
    }

    await click(ctx, pointer, view.backButton);
    expect(board.pageKind === null && board.view === 'tasks' && board.isOpen, 'the back button did not go back to the task list');
}));

// The sample diary of docs/diary.png (Swift's DevTools snapshot).
function addSampleDiary(brain) {
    const base = new Date();
    base.setHours(9, 0, 0, 0);
    const at = minutes => new Date(base.getTime() + minutes * 60_000);
    const next = brain.day.next?.title ?? 'Report';
    const sample = [
        [0, 'bubble', L('“Chào buổi sáng! ☀️ Hôm nay mình làm 3 việc gì nào?” — vì lời chào đầu ngày làm việc, mới có 2/3 việc',
            '“Good morning! ☀️ What are our 3 things today?” — because first greeting of the workday, only 2/3 planned'), null, null],
        [1, 'response', L('Bạn bấm “＋ Thêm việc”', 'You tapped “＋ Add tasks”'), 'picked', null],
        [12, 'flow', L('Bạn vào guồng (gõ phím đều 10 phút) — pet giữ im lặng',
            'You\'re in the zone (10 minutes of steady typing) — the pet stays quiet'), 'flowStart', null],
        [40, 'hold', L('Có lời nhắc đến hạn nhưng bạn đang vào guồng — để sau',
            'A reminder is due but you\'re in the zone — later'), null, null],
        [64, 'flow', L('Hết guồng sau 52 phút', 'Left the zone after 52 minutes'), 'flowEnd', 52],
        [65, 'life', L(`Xong “${next}” → no 95%, 345 XP, combo ×2`, `Done “${next}” → 95% full, 345 XP, combo ×2`), null, null],
        [90, 'distraction', L('Đang ở youtube.com hơn 2 phút', 'On youtube.com for 2+ minutes'), null, null],
        [91, 'bubble', L('“Ê! Đang youtube.com đó hả? 👀” — vì ở youtube.com 2 phút trong giờ làm',
            '“Hey! On youtube.com? 👀” — because on youtube.com for 2 min during work hours'), null, null],
        [91.8, 'response', L('Bạn không phản hồi (tự ẩn)', 'No response (faded away)'), 'ignored', null],
        [98, 'distraction', L('Rời youtube.com sau 8 phút', 'Left youtube.com after 8 minutes'), 'end', 8],
        [99, 'mood', L('Tâm trạng: bình thường → đang nhăn nhó (điểm 41) — −21 đang xao nhãng với youtube.com',
            'Mood: chill → annoyed (score 41) — −21 distracted by youtube.com'), null, null],
    ];
    for (const [minutes, kind, text, tag, mins] of sample)
        brain.diary.add(kind, text, {tag, minutes: mins, now: at(minutes)});
    return sample;
}

// The diary: day picker, filter, summary, entries, Copy (the clipboard gets the whole day) and Open folder. Yesterday
// and an older day come from files (a stand-in for the diary folder); the folder button is only there with a folder.
registerScene('diary', ctx => withBoard(ctx, Mood.angry, async (board, pet, pointer) => {
    const {app} = ctx;
    const {brain} = app;
    const sample = addSampleDiary(brain);
    const today = dayKey(new Date());
    const dayBefore = offset => dayKey(new Date(Date.now() - offset * 86_400_000));
    const yesterday = dayBefore(1);
    const older = dayBefore(3);
    const yesterdayEntries = [
        {id: 'y1', time: new Date(`${yesterday}T17:02:00`).toISOString(), kind: 'bubble', text: 'Yesterday: time to wrap up?'},
        {id: 'y2', time: new Date(`${yesterday}T10:15:00`).toISOString(), kind: 'hold', text: 'Yesterday: held back, you were in the zone', tag: null},
        {id: 'y3', time: new Date(`${yesterday}T09:30:00`).toISOString(), kind: 'focus', text: 'Yesterday: started a 25-minute focus session'},
    ];
    const folder = GLib.build_filenamev([GLib.get_user_data_dir(), 'todopet', 'log']);
    const files = {
        dir: folder,
        append: async () => {},
        remove: async () => {},
        list: async () => [yesterday, older],
        read: async day => (day === yesterday ? `${yesterdayEntries.map(e => JSON.stringify(e)).join('\n')}\n` : ''),
    };
    const diary = brain.diary;
    expect(diary.folder === null, 'the demo diary has a folder');
    diary._files = files;
    const opened = [];
    try {
        await withStub(app, 'openFolder', url => opened.push(url), async () => {
            board.open();
            await ctx.wait(800);
            await brain.settle();
            await click(ctx, pointer, board.diaryButton);
            expect(board.isOpen && board.pageKind === 'diary' && board.view === 'page', `the diary is not up (${board.pageKind})`);
            const view = board.page.view;
            await view.loaded;
            await ctx.wait(400);
            // The diary may still be growing (the brain writes to it): the page catches up within a second.
            await until(ctx, () => view.rowTexts.length === diary.today.length && view.summaryLabel.text === new LogSummary(diary.today).text);
            const entries = diary.today;
            console.log(`TODOPET diary day=${view.day} entries=${entries.length} rows=${view.rowTexts.length} ` +
                `summary "${view.summaryLabel.text}" folder=${view.folderButton.visible}`);
            expect(sample.every(([, , text]) => view.rowTexts.includes(text)), 'the sample entries are not all on screen');
            expect(view.rowTexts.length === entries.length, `${view.rowTexts.length} rows for ${entries.length} entries`);
            expect(view.summaryLabel.text === new LogSummary(entries).text && view.summaryLabel.text.includes('💬'),
                `the summary: ${view.summaryLabel.text}`);
            expect(view.rowTexts[0] === diaryRows(entries, 'all').rows[0].text, 'the newest entry is not first');
            expect(view.folderButton.visible, 'Open folder is missing although the diary has a folder');
            const f = board.frame;
            const wa = pet.workArea;
            expect(f.x >= wa.x && f.y >= wa.y && f.x + f.width <= wa.x + wa.width && f.y + f.height <= wa.y + wa.height,
                `the board is outside the work area: ${JSON.stringify(f)}`);
            pointer.moveTo(...AWAY);
            await ctx.wait(300);
            await ctx.shot('diary');

            // Filter: Held back keeps the holds, flow, meetings and focus.
            const quietRows = () => diaryRows(diary.today, 'quiet').rows.map(r => r.text);
            await click(ctx, pointer, view.filterButtons[2]);
            await until(ctx, () => view.rowTexts.join('|') === quietRows().join('|'));
            console.log(`TODOPET diary held back ${view.rowTexts.length} of ${diary.today.length}`);
            expect(quietRows().length > 0 && view.rowTexts.join('|') === quietRows().join('|'),
                `Held back shows ${view.rowTexts.length} rows, not ${quietRows().length}`);
            pointer.moveTo(...AWAY);
            await ctx.wait(200);
            await ctx.shot('diary-held');
            await click(ctx, pointer, view.filterButtons[0]);
            await until(ctx, () => view.rowTexts.length === diary.today.length);
            expect(view.rowTexts.length === diary.today.length, 'All did not bring every entry back');

            // The day picker: today, yesterday and the older day.
            await click(ctx, pointer, view.dayButton);
            console.log(`TODOPET diary days ${view.menuItems.map(i => i.todopetDay).join(' ')}`);
            expect(view.menuOpen && view.menuItems.map(i => i.todopetDay).join() === [today, yesterday, older].join(),
                `the day menu: ${view.menuItems.map(i => i.todopetDay)}`);
            await ctx.wait(200);
            pointer.moveTo(...AWAY);
            await ctx.wait(200);
            await ctx.shot('diary-days');
            expect(board.handleKey(Clutter.KEY_Escape) && !view.menuOpen && board.isOpen, 'Escape did not close the day menu first');
            await click(ctx, pointer, view.dayButton);
            expect(view.menuOpen, 'the day button did not open the menu again');
            await click(ctx, pointer, view.summaryLabel);
            expect(!view.menuOpen && board.isOpen, 'a click outside did not close the day menu (or closed the board)');

            await click(ctx, pointer, view.dayButton);
            await click(ctx, pointer, view.menuItems[1]);
            await view.loaded;
            await ctx.wait(300);
            console.log(`TODOPET diary yesterday ${view.rowTexts.length} rows "${view.rowTexts[0]}" button "${view.model.dayLabel}"`);
            expect(view.day === yesterday && !view.menuOpen, 'the menu did not take us to yesterday');
            expect(view.rowTexts.join('|') === yesterdayEntries.map(e => e.text).join('|'), `yesterday's rows: ${view.rowTexts}`);
            expect(view.model.dayLabel === L('Hôm qua', 'Yesterday'), 'the picker does not say Yesterday');

            // Copy gives the clipboard the whole day, with its date; the button says so.
            await click(ctx, pointer, view.copyButton);
            const text = await new Promise(resolve =>
                St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_clipboard, value) => resolve(value)));
            const loaded = await diary.load(yesterday);
            console.log(`TODOPET diary copied ${JSON.stringify(text?.split('\n').slice(0, 2))} label "${view.model.copy.label}"`);
            expect(text === PetLog.exportText(loaded, yesterday) && text.includes(yesterday) && text.includes('💬'), `the clipboard: ${text}`);
            expect(view.model.copy.label === L('Đã sao chép ✔︎', 'Copied ✔︎'), 'the Copy button does not say Copied');

            // A day without a file says so; back to today the copied mark is gone.
            await click(ctx, pointer, view.dayButton);
            await click(ctx, pointer, view.menuItems[2]);
            await view.loaded;
            await ctx.wait(300);
            expect(view.day === older && view.emptyLabel?.visible && view.rowTexts.length === 0, 'an empty day does not say so');
            expect(view.model.copy.label === L('Sao chép', 'Copy'), 'the copied mark stayed on another day');
            await click(ctx, pointer, view.dayButton);
            await click(ctx, pointer, view.menuItems[0]);
            await until(ctx, () => view.rowTexts.length === diary.today.length);
            expect(view.day === today && view.rowTexts.length === diary.today.length, 'the picker did not bring today back');

            // Open folder opens the diary's folder (a stub records it), then the board makes way for the file manager.
            await click(ctx, pointer, view.folderButton);
            await until(ctx, () => !board.isOpen);
            console.log(`TODOPET diary opened ${opened} board open=${board.isOpen}`);
            expect(opened.length === 1 && opened[0] === folderURI(folder), `Open folder opened ${opened}`);
            expect(!board.isOpen, 'the board stayed open over the file manager');
        });
    } finally {
        diary._files = null;
    }
}));

// --- Mischief and celebrations (ui/antics.js) ---

// The effect actors of ui/antics.js on the stage now (todopet-sign, todopet-grumble, todopet-celebration).
const ANTIC_ACTORS = new Set(['todopet-sign', 'todopet-grumble', 'todopet-celebration']);
const anticActors = () => Main.layoutManager.uiGroup.get_children().map(a => a.name).filter(name => ANTIC_ACTORS.has(name));

// Plays the celebration `options` (brain.devCelebrate, the Developer page's path) and shoots it `at` ms in. Then the
// effects go away by themselves and the pet drops back to the slow frames. The pet starts in the normal mood (the
// nested shell's clock may say night, and the colors would blend in from sleeping): the pin is let go just before.
async function celebrateScene(ctx, shot, options, at, expected) {
    await withPet(ctx, Mood.normal, async pet => {
        const {brain, antics} = ctx.app;
        await untilOnGround(ctx, pet);
        // Standing still, so the dance happens where it started.
        pet.paused = true;
        await ctx.wait(1000);
        brain.pin({mood: undefined});
        brain.devCelebrate(options);
        await ctx.wait(at);
        const plan = antics.celebrationPlan;
        const c = brain.celebration;
        console.log(`TODOPET ${shot} mood=${brain.mood} celebration=${c.kind} golden=${c.golden} combo=${c.combo} ` +
            `food=${c.food} plan=${JSON.stringify(plan)} actors=${anticActors()} pet=${describePet(pet)}`);
        expect(brain.mood === Mood.celebrating, `the mood is ${brain.mood}, not celebrating`);
        expect(plan?.effect === expected.effect && plan.badge === expected.badge,
            `the effects are ${JSON.stringify(plan)}, not ${JSON.stringify(expected)}`);
        expect(anticActors().join() === 'todopet-celebration', `the actors on stage are ${anticActors()}`);
        await ctx.shot(shot);
        const during = await paintRate(ctx, pet, 500);
        await until(ctx, () => antics.celebrationPlan === null && brain.mood !== Mood.celebrating, 7000);
        await ctx.wait(1000);
        const after = await paintRate(ctx, pet, 2000);
        console.log(`TODOPET ${shot} over: mood=${brain.mood} actors=[${anticActors()}] paints/s ${during.toFixed(1)} during, ` +
            `${after.toFixed(1)} after`);
        expect(brain.mood !== Mood.celebrating && anticActors().length === 0, 'the celebration did not go away');
        expect(during >= 15, `a celebrating pet is drawn at ${during.toFixed(1)} frames a second`);
        expect(after <= 6, `after the celebration the pet still repaints ${after.toFixed(1)} times a second`);
    });
}

// A finished task: the treat falls into the pet's mouth while it jumps in a shower of confetti (life.png, "treat falls").
registerScene('celebrate-jump', ctx => celebrateScene(ctx, 'celebrate-jump', {kind: 'jump'}, 330,
    {effect: 'confetti', badge: null}));

// The third task in a row: the fireworks dance, fireworks around the pet and a ×3 badge (life.png, "fireworks").
registerScene('celebrate-fireworks', ctx => celebrateScene(ctx, 'celebrate-fireworks', {kind: 'fireworks', combo: 3}, 1700,
    {effect: 'fireworks', badge: '×3'}));

// A rare golden treat: the golden pet with its sparkles and golden fireworks (life.png, "rare golden").
registerScene('golden', ctx => celebrateScene(ctx, 'golden', {kind: 'jump', golden: true}, 1700,
    {effect: 'fireworks', badge: null}));

// Grumpy for too long: the pet marches to the far side of the screen dragging a sign with the task you avoid, the
// bubble following it. It is said out loud once (the voice is on for the scene; the nested shell only logs it).
// Frames: about 30 a second while it marches, back to 4 once the parade is over.
registerScene('parade', ctx => withPet(ctx, Mood.angry, async pet => {
    const {app} = ctx;
    const {brain, antics, bubble: view} = app;
    const voice = app.settings.get_boolean('voice-on');
    app.settings.set_boolean('voice-on', true);
    const speak = brain.env.speak;
    const spoken = [];
    brain.env.speak = text => {
        spoken.push(text);
        speak(text);
    };
    try {
        // From the middle of the screen, so the march is long enough to watch and short enough to wait for.
        pet.comeHere();
        await untilOnGround(ctx, pet);
        brain.devAntic('parade');
        await ctx.wait(1500);
        const sign = antics.sign;
        const p = pet.frame;
        const facing = pet.motion.facing;
        console.log(`TODOPET parade ${describePet(pet)} facing=${facing} sign=${JSON.stringify(sign)} ` +
            `antic=${JSON.stringify(brain.antic)} bubble=${JSON.stringify(brain.bubble?.text)} ` +
            `buttons=${brain.bubble?.actions.map(a => a.title)} spoken=${JSON.stringify(spoken)}`);
        expect(pet.behavior === 'parade' && pet.motion.walking && antics.playing === 'parade', `the pet is not parading: ${describePet(pet)}`);
        expect(sign && sign.text === brain.antic?.text && sign.text === brain.day.next?.title,
            `the sign does not carry the next task: ${JSON.stringify(sign)}`);
        const want = signFrame(p, facing, sign);
        expect(sign.ropeOnRight === (facing > 0) && sign.x === want.x && sign.y === want.y,
            `the sign is not behind the pet with its rope toward it: ${JSON.stringify(sign)} vs ${JSON.stringify(want)}`);
        expect(facing > 0 ? sign.x + sign.width <= p.x + p.width * 0.2 + 1 : sign.x >= p.x + p.width * 0.8 - 1,
            'the sign is not on the side the pet walks away from');
        expect(view.visible && brain.bubble?.urgent && brain.bubble.actions.some(a => a.title === L("Tha cho tôi 15'", "Spare me 15'")),
            'the parade bubble with "Spare me 15\'" is not up');
        expect(spoken.length === 1, `the voice said ${spoken.length} lines, not 1`);
        const during = await paintRate(ctx, pet, 1000);
        const moved = pet.frame.x - p.x;
        await ctx.shot('parade');
        const following = antics.sign;
        expect(following.x !== sign.x && following.x === signFrame(pet.frame, pet.motion.facing, following).x,
            'the sign does not follow the pet');

        await until(ctx, () => brain.antic === null, 16000);
        console.log(`TODOPET parade over: ${describePet(pet)} antic=${brain.antic} actors=[${anticActors()}]`);
        expect(brain.antic === null && antics.playing === null, 'the parade did not end at the far side');
        expect(anticActors().length === 0 && antics.sign === null, 'the sign is still up after the parade');
        await ctx.wait(1500);
        const after = await paintRate(ctx, pet, 3000);
        console.log(`TODOPET parade paints/s: ${during.toFixed(1)} while marching (${moved} px in 1 s), ` +
            `${after.toFixed(1)} after it ended`);
        expect(during >= 20, `the parade is drawn at ${during.toFixed(1)} frames a second`);
        expect(after <= 6, `after the parade the pet still repaints ${after.toFixed(1)} times a second`);
    } finally {
        brain.env.speak = speak;
        app.settings.set_boolean('voice-on', voice);
        brain.endAntic();
        brain.dismissBubble();
    }
}));

// Grumpy on a distracting site: the pet leaps into the middle of the screen and flips the table at it, in a bubble
// with "Spare me 15'" (bubble-block.png). The site in front is faked for the scene, or the brain would end the block
// on its next round (it ends when you leave the site). A click on the pet calls it off: it drops back down (and the
// board opens, as in Swift).
registerScene('block', ctx => withPet(ctx, Mood.angry, async (pet, pointer) => {
    const {brain, antics, bubble: view, board} = ctx.app;
    const focus = brain.env.focus;
    const since = new Date();
    brain.env.focus = () => ({appName: 'Firefox', wmClass: 'firefox', title: 'Cats - YouTube — Mozilla Firefox', isBrowser: true, since});
    try {
        await untilOnGround(ctx, pet);
        brain.devAntic('block');
        await ctx.wait(1500);
        const p = pet.frame;
        const wa = pet.workArea;
        console.log(`TODOPET block ${describePet(pet)} work area ${JSON.stringify(wa)} antic=${JSON.stringify(brain.antic)} ` +
            `bubble=${JSON.stringify(brain.bubble?.text)} frame=${JSON.stringify(view.frame)} buttons=${brain.bubble?.actions.map(a => a.title)}`);
        expect(pet.behavior === 'perch' && antics.playing === 'block', `the pet did not leap up: ${describePet(pet)}`);
        expect(Math.abs(p.x + p.width / 2 - (wa.x + wa.width / 2)) <= 1 && Math.abs(p.y + p.height / 2 - (wa.y + wa.height / 2)) <= 1,
            'the pet is not in the middle of the screen');
        expect(view.visible && brain.bubble?.text.startsWith('(╯°□°)╯︵ ┻━┻') && brain.bubble.text.includes('YOUTUBE.COM'),
            'the table-flip bubble is not up');
        expect(brain.bubble.actions.some(a => a.title === L("Tha cho tôi 15'", "Spare me 15'")), 'the bubble cannot spare you');
        const f = view.frame;
        expect(f.y + f.height <= p.y + p.height * 0.38 + 1 && f.x <= p.x + p.width / 2 && f.x + f.width >= p.x + p.width / 2,
            'the bubble did not follow the pet to the middle');
        const perched = await paintRate(ctx, pet, 1000);
        await ctx.shot('block');

        const {x, y, width, height} = pet.frame;
        pointer.moveTo(x + width / 2, y + height * 0.65);
        await ctx.wait(150);
        pointer.press();
        await ctx.wait(60);
        pointer.release();
        await ctx.wait(200);
        console.log(`TODOPET block clicked: ${describePet(pet)} antic=${brain.antic} board open=${board.isOpen} perched paints/s ${perched.toFixed(1)}`);
        expect(brain.antic === null && !pet.isInAntic && antics.playing === null, 'a click did not call the block off');
        await untilOnGround(ctx, pet, 3000);
        expect(perched <= 6, `the perched pet repaints ${perched.toFixed(1)} times a second`);
    } finally {
        brain.env.focus = focus;
        board.close();
        brain.endAntic();
        brain.dismissBubble();
    }
}));

// Annoyed for too long: the pet sighs (puffs of breath), then stomps four times on alternate feet (dust under each),
// in place, and the grumble ends by itself.
registerScene('grumble', ctx => withPet(ctx, Mood.annoyed, async pet => {
    const {brain, antics} = ctx.app;
    try {
        await untilOnGround(ctx, pet);
        pet.paused = true;
        await ctx.wait(500);
        const start = pet.frame;
        brain.devAntic('grumble');
        await ctx.wait(500);
        console.log(`TODOPET grumble ${describePet(pet)} antic=${JSON.stringify(brain.antic)} actors=${anticActors()} ` +
            `bubble=${JSON.stringify(brain.bubble?.text)}`);
        expect(pet.behavior === 'grumble' && antics.playing === 'grumble' && brain.antic?.kind === 'grumble',
            `the pet is not grumbling: ${describePet(pet)}`);
        expect(anticActors().join() === 'todopet-grumble', `the actors on stage are ${anticActors()}`);
        await ctx.shot('grumble');
        // The stomps: the pet goes up and down in place. One shot as the first stomp lands, in its dust.
        let highest = start.y;
        let shot = false;
        const xs = new Set();
        for (let i = 0; i < 50; i++) {
            await ctx.wait(30);
            highest = Math.min(highest, pet.frame.y);
            xs.add(pet.frame.x);
            if (!shot && highest <= start.y - 4 && pet.frame.y === start.y) {
                shot = true;
                await ctx.shot('grumble-stomp');
            }
        }
        expect(shot, 'no shot of a stomp');
        console.log(`TODOPET grumble stomps: lifted ${start.y - highest} px, x ${[...xs]}`);
        expect(start.y - highest >= 3 && xs.size === 1 && xs.has(start.x), 'the pet did not stomp in place');
        await until(ctx, () => brain.antic === null, 4000);
        await ctx.wait(1000);
        const after = await paintRate(ctx, pet, 2000);
        console.log(`TODOPET grumble over: ${describePet(pet)} antic=${brain.antic} actors=[${anticActors()}] paints/s ${after.toFixed(1)}`);
        expect(brain.antic === null && antics.playing === null && pet.behavior === 'idle' && pet.frame.y === pet.ground,
            'the grumble did not end by itself');
        expect(anticActors().length === 0, 'the breath and dust are still on stage');
        expect(after <= 6, `after the grumble the pet still repaints ${after.toFixed(1)} times a second`);
    } finally {
        brain.endAntic();
        brain.dismissBubble();
    }
}));

// --- The top bar item, the shortcut, the lock, the developer trigger, and turning the extension off and on ---

// The actors on the stage (the whole tree) for which `test(actor)` holds.
function stageActors(test) {
    const found = [];
    const walk = actor => {
        if (test(actor))
            found.push(actor);
        for (const child of actor.get_children())
            walk(child);
    };
    walk(global.stage);
    return found;
}

const isOurs = actor => (actor.name ?? '').startsWith('todopet');

// Whether the key focus is in the board's add field.
function addFieldFocused(board) {
    const focus = global.stage.get_key_focus();
    return focus === board.addEntry.clutter_text || focus === board.addEntry;
}

// What the indicator's menu holds right now, as [id or title]: the real menu items, not the model they came from.
function menuTitles(indicator) {
    return indicator.menu._getMenuItems().map(item => {
        if (item instanceof PopupMenu.PopupSeparatorMenuItem)
            return '---';
        return item.label?.text ?? '';
    });
}

// The menu item whose title is `title`.
function menuRow(indicator, title) {
    const row = indicator.menu._getMenuItems().find(item => item.label?.text === title);
    expect(row, `the menu has no '${title}': ${menuTitles(indicator)}`);
    return row;
}

// Opens the menu, uses the item `title` the way a click does (the menu closes, then the item runs) and waits a moment.
async function useMenuItem(ctx, indicator, title) {
    indicator.menu.open(false);
    await ctx.wait(250);
    expect(indicator.menu.isOpen, 'the menu did not open');
    menuRow(indicator, title).activate(Clutter.get_current_event());
    await ctx.wait(250);
    expect(!indicator.menu.isOpen, `the menu stayed open after '${title}'`);
}

// The quick menu in the top bar: the label, the items in the macOS order, and each item doing its job. (The demo
// switch is looked at, not used: switching it rebuilds the whole App.)
registerScene('menu', ctx => withPet(ctx, Mood.happy, async (pet, pointer) => {
    const {app} = ctx;
    const {brain, prefs, board, indicator} = app;
    expect(indicator && Main.panel.statusArea[app.extension.uuid] === indicator, 'the indicator is not in the top bar');
    // A pinned mood is a test seam that does not tell the brain's listeners: the label follows on the next change.
    indicator.update();
    expect(/^😊 \d+\/\d+$/.test(indicator.labelText), `the label says '${indicator.labelText}'`);
    expect(indicator.labelText === indicatorLabel(brain, Date.now()), 'the label is not the brain\'s');
    console.log(`TODOPET menu label '${indicator.labelText}'`);

    // A click on the item opens the menu.
    await click(ctx, pointer, indicator);
    await ctx.wait(400);
    expect(indicator.menu.isOpen, 'a click on the item did not open the menu');
    const ids = indicator.model.map(item => item.id);
    console.log(`TODOPET menu items ${menuTitles(indicator).join(' | ')}`);
    expect(ids.join() === 'header,separator,open,add,startFocus,separator,callOver,hide,quiet,refresh,diary,separator,settings,demo',
        `the menu items: ${ids}`);
    const expected = indicator.model.map(item => (item.id === 'separator' ? '---' : item.title));
    expect(menuTitles(indicator).join('|') === expected.join('|'), `the menu shows ${menuTitles(indicator)}`);
    expect(menuRow(indicator, indicator.model[0].title).sensitive === false, 'the header is not greyed out');
    const demo = indicator.menu._getMenuItems().at(-1);
    expect(demo instanceof PopupMenu.PopupSwitchMenuItem && demo.state === true, 'the demo switch is not on');
    await ctx.shot('menu');
    indicator.menu.close(false);
    await ctx.wait(300);

    // Quiet for an hour, and back.
    await useMenuItem(ctx, indicator, indicator.model.find(i => i.id === 'quiet').title);
    expect(brain.quietUntil && Math.abs(brain.quietUntil.getTime() - Date.now() - 3600 * 1000) < 5000 &&
        prefs.quietUntil === brain.quietUntil.getTime(), `reminders are not quiet for an hour: ${brain.quietUntil}`);
    indicator.menu.open(false);
    await ctx.wait(250);
    expect(menuModel(app).some(i => i.id === 'unquiet') && !menuModel(app).some(i => i.id === 'quiet'),
        'a quiet pet does not offer "Resume reminders"');
    indicator.menu.close(false);
    await useMenuItem(ctx, indicator, menuModel(app).find(i => i.id === 'unquiet').title);
    expect(brain.quietUntil === null && prefs.quietUntil === 0, 'the reminders did not come back');

    // Hide for an hour: the pet and the board go and stay away; the menu then offers to show it and to call it over.
    board.open();
    await ctx.wait(300);
    expect(board.isOpen, 'the board did not open');
    await useMenuItem(ctx, indicator, menuModel(app).find(i => i.id === 'hide').title);
    console.log(`TODOPET menu hidden: pet=${pet.visible} board=${board.isOpen} until +${Math.round((prefs.hiddenUntil - Date.now()) / 1000)} s`);
    expect(!pet.visible && !board.isOpen, 'hiding the pet left it or its board on screen');
    expect(Math.abs(prefs.hiddenUntil - Date.now() - 3600 * 1000) < 5000, 'the pet is not hidden for an hour');
    await ctx.wait(1500);
    expect(!pet.visible, 'the tick showed the pet again');
    indicator.menu.open(false);
    await ctx.wait(250);
    const hiddenIds = menuModel(app).map(i => i.id);
    expect(hiddenIds.includes('show') && hiddenIds.includes('callOver') && !hiddenIds.includes('hide'),
        `a hidden pet's menu: ${hiddenIds}`);
    indicator.menu.close(false);
    await useMenuItem(ctx, indicator, menuModel(app).find(i => i.id === 'show').title);
    expect(pet.visible && prefs.hiddenUntil === 0, 'the pet did not come back');

    // "Call Mochi over" works on a hidden pet too: it clears the hiding first, or the tick would hide it again.
    app.hidePet(3600 * 1000);
    await ctx.wait(300);
    expect(!pet.visible, 'the pet did not hide');
    await useMenuItem(ctx, indicator, menuModel(app).find(i => i.id === 'callOver').title);
    // It drops in at the middle (the fall takes about half a second; it walks on once it has landed).
    const area = pet.workArea;
    console.log(`TODOPET menu called over: pet=${pet.visible} until=${prefs.hiddenUntil} ${describePet(pet)}`);
    expect(pet.visible && prefs.hiddenUntil === 0, 'calling the pet over did not bring it back');
    expect(Math.abs(pet.frame.x + pet.frame.width / 2 - (area.x + area.width / 2)) < 2, 'the pet is not in the middle');
    await ctx.wait(1500);
    expect(pet.visible, 'the tick hid the pet again');

    // Add a task: the board opens with the cursor in its field. The diary: the board opens on the diary page.
    await useMenuItem(ctx, indicator, menuModel(app).find(i => i.id === 'add').title);
    await ctx.wait(400);
    expect(board.isOpen && addFieldFocused(board), 'Add a task did not open the board with the field focused');
    board.close();
    await useMenuItem(ctx, indicator, menuModel(app).find(i => i.id === 'diary').title);
    await ctx.wait(400);
    expect(board.isOpen && board.pageKind === 'diary', `the diary item opened '${board.pageKind}'`);
    board.close();

    // The settings are the extension's preferences window (not opened for real here).
    const opened = [];
    await withStub(app.extension, 'openPreferences', () => opened.push('prefs'), async () => {
        await useMenuItem(ctx, indicator, menuModel(app).find(i => i.id === 'settings').title);
    });
    expect(opened.length === 1, `Settings opened the preferences ${opened.length} times`);

    // A focus session: the label is the clock and counts down, from a single timer; stopping puts the mood back.
    await useMenuItem(ctx, indicator, menuModel(app).find(i => i.id === 'startFocus').title);
    expect(brain.focusSession !== null, 'the focus session did not start');
    const first = indicator.labelText;
    await ctx.wait(2200);
    const later = indicator.labelText;
    console.log(`TODOPET menu focus label '${first}' -> '${later}'`);
    expect(/^🍅 2[45]:\d\d$/.test(first) && /^🍅 2[45]:\d\d$/.test(later) && first !== later, `the clock: '${first}' -> '${later}'`);
    expect(menuModel(app).some(i => i.id === 'stopFocus') && !menuModel(app).some(i => i.id === 'startFocus'),
        'during focus the menu offers to stop it');
    await useMenuItem(ctx, indicator, menuModel(app).find(i => i.id === 'stopFocus').title);
    expect(brain.focusSession === null && /^😊 \d+\/\d+$/.test(indicator.labelText),
        `after stopping, the label says '${indicator.labelText}'`);
    brain.dismissBubble();

    // A right click on the pet opens the same menu there (Swift: pet.hit.onRightClick); its items work the same.
    await untilOnGround(ctx, pet);
    pet.paused = true;
    await ctx.wait(700);
    const {x, y, width, height} = pet.frame;
    pointer.moveTo(x + width / 2, y + height * 0.6);
    await ctx.wait(300);
    pointer.rightClick();
    await ctx.wait(600);
    const petMenu = app.petMenu.menu;
    const petItems = petMenu._getMenuItems().map(item => (item instanceof PopupMenu.PopupSeparatorMenuItem ? '---' : item.label?.text));
    console.log(`TODOPET menu pet menu open=${app.petMenu.isOpen} items ${petItems.join(' | ')}`);
    const wanted = menuModel(app).map(item => (item.id === 'separator' ? '---' : item.title));
    expect(app.petMenu.isOpen && petItems.join('|') === wanted.join('|'), `the pet's menu: ${petItems}`);
    const box = petMenu.actor.get_transformed_extents?.() ?? null;
    expect(box && box.get_y() + box.get_height() <= y + height, 'the menu is not above the pet');
    await ctx.shot('menu-pet');
    petMenu._getMenuItems().find(item => item.label?.text === menuModel(app).find(i => i.id === 'hide').title).activate(null);
    await ctx.wait(300);
    expect(!app.petMenu.isOpen && !pet.visible, 'Hide pet for 1 hour from the pet\'s menu did not hide the pet');
    app.showPet();
    await ctx.wait(300);
    expect(pet.visible, 'the pet did not come back');
}));

// Locks the screen without the lock screen: the session watcher says so, as it does when the shell enters it.
function setLocked(app, locked) {
    app.session.locked = locked;
    app.session.emit('lock-changed', locked);
}

// While the screen is locked nothing of ours is on screen: not the pet, its stunts and sign, its bubble, the board
// or the top bar item, and the board will not open. Everything comes back when it unlocks. A board that was open while
// the pet was hidden (it stays, in the corner) closes too.
registerScene('locked', ctx => withPet(ctx, Mood.angry, async pet => {
    const {app} = ctx;
    const {brain, prefs, board, antics, indicator} = app;
    const modals = modalBefore();

    // The board opened while the pet is away is shut by the lock, whether or not the pet was on screen.
    prefs.hiddenUntil = Date.now() + 3600 * 1000;
    await ctx.wait(300);
    board.open();
    await ctx.wait(400);
    expect(board.isOpen && board.side === 'corner', `the board did not open in the corner: ${board.side}`);
    setLocked(app, true);
    await ctx.wait(300);
    expect(!board.isOpen && Main.modalCount === modals, `the board stayed open on the lock screen (${Main.modalCount} modals)`);
    board.open({focusAdd: true});
    app.openDiary();
    await ctx.wait(300);
    expect(!board.isOpen && Main.modalCount === modals, 'the board opened while locked');
    setLocked(app, false);
    prefs.hiddenUntil = 0;
    await ctx.wait(500);
    expect(pet.visible && !brain.locked, 'the pet did not come back');

    // A parade with its sign, and its bubble.
    brain.devAntic('parade');
    await ctx.wait(1000);
    console.log(`TODOPET locked before: pet=${pet.visible} antic=${antics.playing} sign=${Boolean(antics.sign)} ` +
        `bubble=${app.bubble.visible} indicator=${indicator.container.visible}`);
    expect(antics.playing === 'parade' && antics.sign && app.bubble.visible, 'the parade is not on screen');
    setLocked(app, true);
    await ctx.wait(500);
    // On screen: an actor of ours that is mapped (the pet menu's hidden anchor and the like stay in the tree).
    const actors = stageActors(a => isOurs(a) && a.mapped).map(a => a.name);
    console.log(`TODOPET locked: pet=${pet.visible} antic=${antics.playing} sign=${Boolean(antics.sign)} bubble=${app.bubble.visible} ` +
        `brain.locked=${brain.locked} indicator=${indicator.container.visible} actors=[${actors}]`);
    expect(!pet.visible && antics.playing === null && antics.sign === null && antics.layers.length === 0,
        'the pet or its stunt is still on screen');
    expect(!app.bubble.visible && brain.bubble === null, 'the bubble is still on screen');
    expect(brain.locked && !indicator.container.visible, 'the brain does not know, or the top bar item shows');
    expect(actors.length === 0, `these are still on the stage: ${actors}`);
    expect(brain.antic === null, 'the brain still has the stunt');
    app.callPetOver();
    app.openBoard();
    await ctx.wait(300);
    expect(!pet.visible && !board.isOpen, 'calling the pet over or opening the board worked on the lock screen');
    await ctx.shot('locked');

    setLocked(app, false);
    await ctx.wait(600);
    console.log(`TODOPET unlocked: pet=${pet.visible} brain.locked=${brain.locked} indicator=${indicator.container.visible}`);
    expect(pet.visible && !brain.locked && indicator.container.visible, 'the pet or the top bar item did not come back');
    board.open();
    await ctx.wait(300);
    expect(board.isOpen, 'the board does not open after unlocking');
    board.close();
    brain.endAntic();
    brain.dismissBubble();
}));

// App.openURL opens only http and https links: a Join link comes from calendar data, which anyone's invitation can
// fill. javascript:, file: and smb: links are refused (logged once), from the board's path and the brain's. Nothing is
// really launched here: Gio's launcher is stubbed.
registerScene('open-links', async ctx => {
    const {app} = ctx;
    const launched = [];
    const join = 'https://meet.google.com/abc-defg-hij';
    await withStub(Gio.AppInfo, 'launch_default_for_uri_async', uri => launched.push(uri), async () => {
        for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'smb://server/share', join])
            app.openURL(url);
        app.brain.env.openURL('smb://server/other');
        app.brain.env.openURL(join);
        await ctx.wait(100);
    });
    console.log(`TODOPET open-links launched ${launched.join(' ')}`);
    expect(launched.length === 2 && launched.every(uri => uri === join), `the links launched: ${launched.join(' ')}`);
});

// The `dev-trigger` setting plays a command and goes back to ''; the settings window's `prefs:` values stay.
registerScene('dev-trigger', ctx => withPet(ctx, Mood.normal, async pet => {
    const {app} = ctx;
    const {brain, settings, antics} = app;
    const trigger = async value => {
        settings.set_string('dev-trigger', value);
        await ctx.wait(200);
    };
    await untilOnGround(ctx, pet);
    brain.dismissBubble();

    await trigger('bubble');
    console.log(`TODOPET dev-trigger bubble: '${brain.bubble?.text}' key='${settings.get_string('dev-trigger')}'`);
    expect(brain.bubble !== null && app.bubble.visible && settings.get_string('dev-trigger') === '', 'bubble did not say a bubble');
    brain.dismissBubble();

    await trigger('prefs:Day');
    await ctx.wait(300);
    expect(settings.get_string('dev-trigger') === 'prefs:Day', 'a prefs: value was touched');
    settings.set_string('dev-trigger', '');

    await trigger('parade');
    console.log(`TODOPET dev-trigger parade: antic=${brain.antic?.kind} playing=${antics.playing} key='${settings.get_string('dev-trigger')}'`);
    expect(brain.antic?.kind === 'parade' && antics.playing === 'parade' && settings.get_string('dev-trigger') === '',
        'parade did not start the parade');
    brain.endAntic();
    brain.dismissBubble();
    await ctx.wait(500);

    await trigger('celebrate:spin');
    console.log(`TODOPET dev-trigger celebrate: ${brain.celebration?.kind} golden=${brain.celebration?.golden}`);
    expect(brain.celebration?.kind === 'spin' && brain.celebration.golden === false && settings.get_string('dev-trigger') === '',
        'celebrate:spin did not celebrate a spin');
    await until(ctx, () => antics.celebrationPlan === null, 7000);
    expect(antics.celebrationPlan === null, 'the celebration did not go away');
    await trigger('golden');
    expect(brain.celebration?.golden === true && settings.get_string('dev-trigger') === '', 'golden did not celebrate a golden treat');
    await until(ctx, () => antics.celebrationPlan === null, 8000);
}));

// The menu's demo switch rebuilds the whole App: off, it runs without the demo (no token, so the paw and "Connect
// Todoist…"); on, with it again. The scenes go on with each new App.
registerScene('demo-toggle', async ctx => {
    const flip = async () => {
        const {indicator} = ctx.app;
        indicator.menu.open(false);
        await ctx.wait(300);
        const row = indicator.menu._getMenuItems().at(-1);
        expect(row instanceof PopupMenu.PopupSwitchMenuItem, 'the last menu item is not the demo switch');
        await ctx.restartedBy(() => row.toggle());
        expect(!indicator.menu.isOpen, 'the old menu is still open');
        await ctx.wait(1200);
    };
    const before = ctx.app;
    expect(before.brain.demo && before.prefs.demoMode, 'the shell is not in demo mode');

    await flip();
    const off = ctx.app;
    const ids = off.indicator.model.map(i => i.id);
    console.log(`TODOPET demo-toggle off: new app=${off !== before} demo=${off.brain.demo} setting=${off.prefs.demoMode} ` +
        `hasToken=${off.brain.hasToken} label='${off.indicator.labelText}' menu=${ids}`);
    expect(off !== before && !off.brain.demo && !off.prefs.demoMode, 'turning the switch off did not rebuild without the demo');
    expect(off.indicator.labelText === '🐾', `no token: the label says '${off.indicator.labelText}'`);
    expect(ids.includes('connect') && !ids.includes('add') && !ids.includes('startFocus'), `no token: the menu has ${ids}`);
    expect(Main.panel.statusArea[off.extension.uuid] === off.indicator && stageActors(a => a.name === 'todopet-pet').length === 1,
        'the new App has not one pet and its top bar item');
    off.indicator.menu.open(false);
    await ctx.wait(400);
    await ctx.shot('menu-no-token');
    off.indicator.menu.close(false);
    await ctx.wait(300);
    off.brain.dismissBubble();

    await flip();
    const on = ctx.app;
    console.log(`TODOPET demo-toggle on: new app=${on !== off} demo=${on.brain.demo} setting=${on.prefs.demoMode} ` +
        `hasToken=${on.brain.hasToken} label='${on.indicator.labelText}'`);
    expect(on !== off && on.brain.demo && on.prefs.demoMode && on.brain.hasToken, 'turning the switch on did not rebuild with the demo');
    expect(on.indicator.labelText !== '🐾', 'the demo has a mood label');
    on.brain.dismissBubble();
});

// A signal handler's or timer's origin: the first frame of a stack that is not the probe's own.
const callerOf = () => (new Error().stack.split('\n')[2] ?? '');

// Wraps GLib's timer functions and the connect() of GObjects and of the shell's JS emitters while it is installed, and
// remembers the timers and the signal handlers the extension makes (judged by where the call came from: a file of the
// extension, not this one). Handlers are kept only on the shell's own long-lived objects, which the extension must not
// leave a handler on: the other objects go away with the extension. live() says which are still there.
function installLeakProbe(app) {
    const dir = `/${app.extension.uuid}/`;
    const ours = where => where.includes(dir) && !where.includes('/ui/devScenes.js');
    const longLived = [
        global.display, global.stage, global.workspace_manager, global.window_manager,
        Main.layoutManager, Main.sessionMode, Main.panel, Main.overview, Main.messageTray,
        St.Settings.get(), St.ThemeContext.get_for_stage(global.stage), Shell.WindowTracker.get_default(),
    ];
    const timers = new Map(); // source id -> where
    const handlers = []; // {object, signal, id, where}
    const originals = {};

    for (const name of ['timeout_add', 'timeout_add_seconds', 'idle_add']) {
        const real = GLib[name];
        originals[name] = real;
        const callbackAt = name === 'idle_add' ? 1 : 2;
        GLib[name] = function (...args) {
            const where = callerOf();
            const fn = args[callbackAt];
            let id = 0;
            args[callbackAt] = (...rest) => {
                let keep = false;
                try {
                    keep = fn(...rest);
                } finally {
                    if (!keep)
                        timers.delete(id);
                }
                return keep;
            };
            id = real.apply(GLib, args);
            if (ours(where))
                timers.set(id, where);
            return id;
        };
    }
    const removeReal = GLib.source_remove;
    originals.source_remove = removeReal;
    GLib.source_remove = function (id) {
        timers.delete(id);
        return removeReal.call(GLib, id);
    };

    // GObjects: signal_handler_is_connected() tells; the shell's JS emitters keep their connections in a table.
    const gobjectConnect = GObject.Object.prototype.connect;
    const emitterConnect = Signals.EventEmitter.prototype.connect;
    const wrap = (real, emitter) => function (signal, fn) {
        const where = callerOf();
        const id = real.call(this, signal, fn);
        if (ours(where) && longLived.includes(this))
            handlers.push({object: this, signal, id, where, emitter});
        return id;
    };
    GObject.Object.prototype.connect = wrap(gobjectConnect, false);
    Signals.EventEmitter.prototype.connect = wrap(emitterConnect, true);

    return {
        timers: () => [...timers].map(([id, where]) => `${id}@${where}`),
        handlers: () => handlers
            .filter(h => (h.emitter ? Boolean(h.object._signalConnections?.[h.id])
                : GObject.signal_handler_is_connected(h.object, h.id)))
            .map(h => `${h.signal}@${h.where}`),
        remove() {
            Object.assign(GLib, originals);
            GObject.Object.prototype.connect = gobjectConnect;
            Signals.EventEmitter.prototype.connect = emitterConnect;
        },
    };
}

// Turns the extension off and on 3 times. Each time off, nothing of ours is left: no actor, no top bar item, no
// shortcut, no timer and no signal handler on the shell's objects (counted by the probe above; it also has to see
// some while the extension is on, or it proves nothing). Each time on, there is exactly one pet and one top bar item,
// and the shortcut opens the board once. The scenes go on with the new App (ctx.stopApp / ctx.startApp).
registerScene('reenable', async ctx => {
    const {uuid} = ctx.app.extension;
    const keys = keyboard();
    const modals = modalBefore();
    // A binding is taken by name: adding it again fails while a shortcut is left behind. It is the only way to ask.
    const schema = ctx.app.settings.settings_schema;
    const shortcutFree = () => {
        const settings = new Gio.Settings({settings_schema: schema});
        const action = Main.wm.addKeybinding('board-hotkey', settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL, () => {});
        if (action !== Meta.KeyBindingAction.NONE)
            Main.wm.removeKeybinding('board-hotkey');
        return action !== Meta.KeyBindingAction.NONE;
    };
    const probe = installLeakProbe(ctx.app);
    // With the extension off, the same number of actors is on the stage and tracked by the layout manager every time:
    // an actor an App leaves behind would add up over the cycles.
    const residue = () => [Main.layoutManager.uiGroup.get_n_children(), Main.layoutManager._trackedActors?.length ?? -1];
    let firstResidue = null;
    try {
        for (let cycle = 1; cycle <= 3; cycle++) {
            ctx.stopApp();
            await ctx.wait(300);
            firstResidue ??= residue();
            const left = stageActors(isOurs).map(a => a.name);
            const free = shortcutFree();
            const timers = probe.timers();
            const handlers = probe.handlers();
            console.log(`TODOPET reenable cycle ${cycle} off: actors=[${left}] topBar=${Boolean(Main.panel.statusArea[uuid])} ` +
                `shortcutFree=${free} timers=${timers.length} handlers=${handlers.length} modals=${Main.modalCount} ` +
                `uiGroup/tracked=${residue()}`);
            expect(residue().join() === firstResidue.join(), `the stage holds ${residue()} (uiGroup, tracked), ${firstResidue} the first time off`);
            expect(left.length === 0, `these are left on the stage after disable(): ${left}`);
            expect(!Main.panel.statusArea[uuid], 'the top bar item is still there');
            expect(free, 'the board shortcut is still bound');
            expect(timers.length === 0, `timers left after disable(): ${timers}`);
            expect(handlers.length === 0, `signal handlers left on the shell's objects after disable(): ${handlers}`);
            expect(Main.modalCount === modals, `a modal grab is left (${Main.modalCount}, ${modals} before)`);

            await ctx.startApp();
            await ctx.wait(1500);
            const {app} = ctx;
            const pets = stageActors(a => a.name === 'todopet-pet').length;
            console.log(`TODOPET actors=${pets}`);
            expect(pets === 1, `${pets} pet actors on the stage, not 1`);
            expect(app.indicator && Main.panel.statusArea[uuid] === app.indicator, 'the top bar item is not the new App\'s');
            expect(stageActors(a => a.name === 'todopet-board').length === 0, 'a board is open');
            const alive = {timers: probe.timers().length, handlers: probe.handlers().length};
            console.log(`TODOPET reenable cycle ${cycle} on: label='${app.indicator.labelText}' timers=${alive.timers} handlers=${alive.handlers}`);
            expect(alive.timers > 0 && alive.handlers > 0,
                `the probe saw ${alive.timers} timers and ${alive.handlers} handlers while on: it sees nothing`);

            // The shortcut opens the board, once, with the cursor in the add field.
            const opens = [];
            const open = app.board.open;
            await withStub(app.board, 'open', options => {
                opens.push(options);
                return open.call(app.board, options);
            }, async () => {
                keys.chord(Clutter.KEY_Control_L, Clutter.KEY_Super_L, Clutter.KEY_t);
                await ctx.wait(500);
            });
            console.log(`TODOPET reenable cycle ${cycle} shortcut: open calls ${JSON.stringify(opens)} board=${app.board.isOpen}`);
            expect(opens.length === 1 && opens[0]?.focusAdd === true, `the shortcut called board.open ${opens.length} times`);
            expect(app.board.isOpen && addFieldFocused(app.board), 'the shortcut did not open the board with the field focused');
            app.board.close();
            await ctx.wait(200);
        }
        // After the last cycle: one pet, one top bar item.
        ctx.app.brain.dismissBubble();
        await ctx.wait(500);
        await ctx.shot('reenable');
    } finally {
        probe.remove();
    }
});

// --- The settings window (prefs.js) ---

// The settings window is another process (org.gnome.Shell.Extensions); its window is the extension's name.
const prefsWindow = ctx => global.get_window_actors().map(a => a.meta_window)
    .find(w => w.get_title() === ctx.app.extension.metadata.name && w.get_wm_class() !== null && !w.is_override_redirect()) ?? null;

// `prefs:<Page>` writes `dev-trigger` = 'prefs:<Page>' and opens the settings window; prefs.js shows that page and sets
// the key back to ''. The shot is `prefs-<page>.png`. `prefs:<Page>:end` scrolls the page to its last row first
// (`prefs-<page>-end.png`): Day and Developer have more rows than the window shows. A window that never appears fails
// the scene (the window is another process, so the pictures and the log are the evidence for its content;
// tools/prefs-check.js builds every page without a display server and counts the rows). The window is closed
// afterwards, so the next scene opens a fresh one.
registerScene('prefs', async ctx => {
    const [page, where = ''] = ctx.arg === '' ? ['General'] : ctx.arg.split(':');
    const spec = settingsPages().find(p => p.name === page);
    expect(spec, `there is no settings page '${page}'`);
    const {settings, extension} = ctx.app;
    expect(!prefsWindow(ctx), 'a settings window is still open from before');
    settings.set_string('dev-trigger', `prefs:${ctx.arg === '' ? page : ctx.arg}`);
    extension.openPreferences();
    let window = null;
    for (let waited = 0; !window && waited < 20000; waited += 100) {
        await ctx.wait(100);
        window = prefsWindow(ctx);
    }
    expect(window, 'the settings window did not open in 20 s');
    await ctx.wait(3000);
    const frame = window.get_frame_rect();
    console.log(`TODOPET prefs ${ctx.arg || page}: window '${window.get_title()}' ${window.get_wm_class()} ${frame.width}x${frame.height} ` +
        `rows=${rowCount(spec)} dev-trigger='${settings.get_string('dev-trigger')}'`);
    await ctx.shot(`prefs-${page.toLowerCase()}${where === '' ? '' : `-${where}`}`);
    expect(settings.get_string('dev-trigger') === '', `the settings window left dev-trigger at '${settings.get_string('dev-trigger')}'`);
    window.delete(global.get_current_time());
    for (let waited = 0; prefsWindow(ctx) && waited < 5000; waited += 100)
        await ctx.wait(100);
    expect(!prefsWindow(ctx), 'the settings window did not close');
});
