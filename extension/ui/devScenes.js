// Developer scene runner for the nested-shell harness (tools/nested.sh). When the `dev-scenes` preference is
// not empty, App plays those scenes once after it starts, saves screenshots into `dev-screenshot-dir`, logs
// `TODOPET SCENES DONE` and terminates the shell. Production sessions never load this file.
//
// A scene is registered with registerScene(id, async ctx => ...). Modules that register scenes must be
// imported (statically) from here so that registering happens before runScenes() looks an id up.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

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
