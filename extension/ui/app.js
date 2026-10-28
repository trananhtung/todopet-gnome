// Composition root: owns every service and UI object, and undoes all of it in stop().
// extension.js creates one App per enable() and calls stop() from disable().
//
// start() runs the Shell services, the files, the brain (ticked every second) and the pet. The pet is shown
// unless the screen is locked or `hidden-until` is still ahead.
//
// Environment variables set only by tools/nested.sh (the isolated nested shell):
//   TODOPET_NESTED=1      this is the nested dev shell; the only place dev scenes may run. Chimes and speech are
//                         logged ("TODOPET play <chime>") instead of reaching the real session's audio.
//   TODOPET_NO_SECRETS=1  do not touch libsecret/the keyring; the nested session can reach the real one. Secrets
//                         live in memory for the run.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

import {Brain} from '../brain.js';
import {Prefs} from '../core/prefs.js';
import {CalendarSource} from '../services/calendar.js';
import {ClaudeClient} from '../services/claude.js';
import {DemoService} from '../services/demo.js';
import {FocusWatch} from '../services/focusWatch.js';
import {IdleWatch} from '../services/idle.js';
import {clearSecret, lookupSecret, storeSecret} from '../services/secrets.js';
import {SessionWatch} from '../services/session.js';
import {playChime} from '../services/sound.js';
import {speak} from '../services/speech.js';
import {DiaryFiles, JsonStore, dataDir} from '../services/store.js';
import {TodoistClient} from '../services/todoist.js';
import {PetActor} from './pet.js';

// The keyring's interface, kept in memory: for the nested shell, which must never read the user's real secrets.
function memorySecrets() {
    const items = new Map();
    return {
        lookupSecret: async item => items.get(item) ?? null,
        storeSecret: async (item, value) => {
            items.set(item, value);
        },
        clearSecret: async item => {
            items.delete(item);
        },
    };
}

// Opens `url` in the default app (a meeting's join link), without waiting.
function openURL(url) {
    const context = global.create_app_launch_context(0, -1);
    Gio.AppInfo.launch_default_for_uri_async(url, context, null, (_source, result) => {
        try {
            Gio.AppInfo.launch_default_for_uri_finish(result);
        } catch (e) {
            console.warn(`TodoPet: could not open ${url}: ${e.message}`);
        }
    });
}

export class App {
    constructor(extension) {
        this.extension = extension;
        this.settings = null;
        this.prefs = null;
        // Shell services (services/*.js); speech.js and sound.js are plain functions.
        this.idle = null;
        this.focus = null;
        this.calendar = null;
        this.session = null;
        // The pet's files: JSON state and the diary.
        this.store = null;
        this.files = null;
        this.brain = null;
        this.pet = null;
        // Filled in by later tasks.
        this.bubble = null;
        this.board = null;
        this.antics = null;
        this.indicator = null;

        this._prefIds = [];
        this._brainIds = [];
        this._petIds = [];
        this._sessionIds = [];
        this._tickId = 0;
        this._loggedFailures = new Set();
        this._scenesCancellable = null;
        this._started = false;
        this._stopped = false;
    }

    async start() {
        if (this._started)
            return;
        this._started = true;
        this.settings = this.extension.getSettings();
        this.prefs = Prefs.fromSettings(this.settings);
        if (this.prefs.firstLaunch === 0)
            this.prefs.firstLaunch = Date.now();

        this.idle = new IdleWatch();
        this.focus = new FocusWatch({tracker: Shell.WindowTracker.get_default()});
        this.session = new SessionWatch();
        this.calendar = new CalendarSource(this.prefs);
        this.idle.start();
        this.focus.start();
        this.session.start();
        await this.calendar.start();
        if (this._stopped)
            return;

        this.store = new JsonStore(dataDir());
        this.files = new DiaryFiles();
        this.brain = new Brain({
            prefs: this.prefs,
            todoFactory: (token, demo) => {
                if (demo)
                    return new DemoService();
                return token ? new TodoistClient(token) : null;
            },
            calendar: this.calendar,
            claudeFactory: (key, model) => new ClaudeClient(key, model),
            env: this._makeEnv(),
            store: this.store,
            files: this.files,
        });
        this.brain.setLocked(this.session.locked);
        this._connectBrain();

        this.pet = new PetActor(this);
        this._petIds.push(
            this.pet.on('clicked', () => this._petClicked()),
            this.pet.on('antic-ended', () => this.brain?.endAntic()));

        this._sessionIds.push(
            this.session.on('wake', () => this.brain?.onWake(new Date())),
            this.session.on('lock-changed', locked => {
                this.brain?.setLocked(locked);
                this._updateVisibility();
            }));
        // `secrets-serial` needs nothing here: the brain listens to it and reads the keyring again.
        this.onPrefChanged(name => {
            if (name === 'hiddenUntil')
                this._updateVisibility();
        });
        this._updateVisibility();

        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._guard('the brain tick', () => this.brain?.tick(new Date()));
            this._guard('showing the pet', () => this._updateVisibility());
            return GLib.SOURCE_CONTINUE;
        });

        try {
            await this.brain.start();
        } catch (e) {
            console.error(`TodoPet: the brain did not start: ${e?.stack ?? e}`);
        }
        if (this._stopped)
            return;

        // Keep this last: scenes expect everything above to be running.
        this._startDevScenes();
    }

    // Undoes everything start() did. Safe to call twice, and before start() has finished.
    stop() {
        this._stopped = true;
        this._scenesCancellable?.cancel();
        this._scenesCancellable = null;

        if (this._tickId !== 0)
            GLib.source_remove(this._tickId);
        this._tickId = 0;

        for (const id of this._brainIds)
            this.brain?.off(id);
        this._brainIds = [];
        this.brain?.stop();
        this.brain = null;

        for (const id of this._petIds)
            this.pet?.off(id);
        this._petIds = [];
        this.pet?.destroy();
        this.pet = null;

        // disable() cannot wait: the saves still waiting are started now and finish on their own.
        if (this.store) {
            const store = this.store;
            store.flush().catch(e => console.error(`TodoPet: could not save the pet's state: ${e?.message ?? e}`));
            store.destroy();
        }
        this.store = null;
        this.files = null;

        for (const id of this._sessionIds)
            this.session?.off(id);
        this._sessionIds = [];
        for (const service of [this.calendar, this.session, this.focus, this.idle])
            service?.stop();
        this.calendar = null;
        this.session = null;
        this.focus = null;
        this.idle = null;

        for (const id of this._prefIds)
            this.prefs?.disconnect(id);
        this._prefIds = [];

        this.prefs = null;
        this.settings = null;
    }

    // Like prefs.onChanged(), but the handler is disconnected by stop().
    onPrefChanged(cb) {
        const id = this.prefs.onChanged(cb);
        this._prefIds.push(id);
        return id;
    }

    // What the brain reads from the Shell and does through it (see the env contract in brain.js).
    _makeEnv() {
        const nested = GLib.getenv('TODOPET_NESTED') === '1';
        const secrets = GLib.getenv('TODOPET_NO_SECRETS') === '1'
            ? memorySecrets()
            : {lookupSecret, storeSecret, clearSecret};
        return {
            idleSeconds: () => this.idle?.idleSeconds() ?? 0,
            secondsSinceKey: () => this.idle?.secondsSinceKey() ?? 1e9,
            focus: () => this.focus?.current ?? null,
            lastAppSwitch: () => this.focus?.lastSwitch ?? new Date(0),
            speak: text => {
                if (this._stopped)
                    return;
                if (nested)
                    console.log(`TODOPET speak ${text}`);
                else
                    speak(text, this.prefs.effectiveLang);
            },
            play: chime => {
                if (this._stopped)
                    return;
                if (nested)
                    console.log(`TODOPET play ${chime}`);
                else
                    playChime(chime, this.prefs.soundMode);
            },
            ...secrets,
            openURL,
        };
    }

    _connectBrain() {
        const brain = this.brain;
        this._brainIds.push(
            // A new mood or a celebration shows at once (between changes the pet repaints on its own).
            brain.on('changed', () => this.pet?.poke()),
            brain.on('celebrate', () => this.pet?.poke()),
            brain.on('antic', antic => this._performAntic(antic)),
            brain.on('antic-end', () => this.pet?.endAntic()));
    }

    // The brain's mischief, played by the pet (Swift: AppDelegate.perform). Grumbling needs no movement.
    _performAntic(antic) {
        if (!this.pet?.visible)
            return;
        if (antic?.kind === 'parade')
            this.pet.startParade(antic.text);
        else if (antic?.kind === 'block')
            this.pet.startBlock();
    }

    // Swift: AppDelegate.petClicked. Clicking the pet calls off any mischief and takes away a bubble without buttons.
    // Opening the task board comes with the board.
    _petClicked() {
        const brain = this.brain;
        if (!brain)
            return;
        if (this.pet?.isInAntic)
            brain.endAntic();
        const bubble = brain.bubble;
        if (bubble && bubble.actions.length === 0)
            brain.dismissBubble(bubble.id);
    }

    // The pet hides while the screen is locked and while `hidden-until` (epoch ms) is ahead.
    _updateVisibility() {
        if (!this.pet || !this.prefs)
            return;
        const hidden = Boolean(this.session?.locked) || this.prefs.hiddenUntil > Date.now();
        if (hidden)
            this.pet.hide();
        else
            this.pet.show();
    }

    // Runs `fn`; a failure is logged the first time it happens for `what`, and its repeats stay quiet.
    _guard(what, fn) {
        try {
            fn();
        } catch (e) {
            if (this._loggedFailures.has(what))
                return;
            this._loggedFailures.add(what);
            console.error(`TodoPet: ${what} failed: ${e?.stack ?? e}`);
        }
    }

    // Plays the scenes listed in `dev-scenes`, if any, in the background (see devScenes.js). Only in the nested
    // shell: a real session must never run scenes, and they end by terminating the shell.
    _startDevScenes() {
        if (GLib.getenv('TODOPET_NESTED') !== '1')
            return;
        const ids = this.prefs.devScenes;
        if (ids.length === 0)
            return;

        const dir = this.prefs.devScreenshotDir;
        const cancellable = new Gio.Cancellable();
        this._scenesCancellable = cancellable;
        import('./devScenes.js')
            .then(({runScenes}) => runScenes(this, ids, dir, cancellable))
            .catch(e => logError(e, 'TODOPET scene runner failed'));
    }
}
