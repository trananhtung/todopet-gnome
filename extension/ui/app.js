// Composition root: owns every service and UI object, and undoes all of it in stop().
// extension.js creates one App per enable() and calls stop() from disable().
//
// start() runs the Shell services, the files, the brain (ticked every second), the pet, its speech bubble, the task
// board (a click on the pet opens it), the pet's mischief and celebrations (ui/antics.js), the top bar indicator with
// its quick menu (ui/indicator.js) and the board's global shortcut. The pet is shown unless the screen is locked or
// `hidden-until` is still ahead. While the screen is locked nothing of ours is on screen and the board will not open.
// The UI language follows the `lang` setting. A change of `demo-mode` rebuilds the whole App (extension.restart()).
// The `dev-trigger` setting plays a stunt, a celebration or a bubble on demand (ui/devTrigger.js).
//
// Environment variables set only by tools/nested.sh (the isolated nested shell):
//   TODOPET_NESTED=1      this is the nested dev shell; the only place dev scenes may run. Chimes and speech are
//                         logged ("TODOPET play <chime>") instead of reaching the real session's audio.
//   TODOPET_NO_SECRETS=1  do not touch libsecret/the keyring; the nested session can reach the real one. Secrets
//                         live in memory for the run.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {clearArtCaches} from '../art/petArt.js';
import {Brain} from '../brain.js';
import {setLang} from '../core/l10n.js';
import {Prefs} from '../core/prefs.js';
import {CalendarSource} from '../services/calendar.js';
import {ClaudeClient} from '../services/claude.js';
import {DemoService} from '../services/demo.js';
import {FocusWatch} from '../services/focusWatch.js';
import {IdleWatch} from '../services/idle.js';
import {SessionWatch} from '../services/session.js';
import {playChime} from '../services/sound.js';
import {speak} from '../services/speech.js';
import {DiaryFiles, JsonStore, dataDir} from '../services/store.js';
import {TodoistClient} from '../services/todoist.js';
import {Antics} from './antics.js';
import {clearBadgeCache} from './anticsArt.js';
import {Board} from './board.js';
import {BubbleView} from './bubble.js';
import {shouldShowBubble} from './bubbleLogic.js';
import {runDevTrigger} from './devTrigger.js';
import {PetMenu, TodoPetIndicator} from './indicator.js';
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

// The keyring, through services/secrets.js. That file needs libsecret (gir1.2-secret-1), which GNOME Shell does not
// depend on, so it is imported on the first call: without it every call rejects, which the brain treats as "the
// keyring is not available", and the rest of the extension runs. The failure is logged once.
function keyringSecrets() {
    let loading = null;
    const secrets = () => {
        loading ??= import('../services/secrets.js').catch(e => {
            console.warn('TodoPet: the keyring is unavailable, libsecret could not be loaded ' +
                `(is gir1.2-secret-1 installed?): ${e?.message ?? e}`);
            throw e;
        });
        return loading;
    };
    return {
        lookupSecret: async item => (await secrets()).lookupSecret(item),
        storeSecret: async (item, value) => (await secrets()).storeSecret(item, value),
        clearSecret: async item => (await secrets()).clearSecret(item),
    };
}

// Opens `url` in the default app (a meeting's join link), without waiting.
function launchURL(url) {
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
        this.bubble = null; // BubbleView
        this.board = null; // Board: the pet stands still while it is open
        this.antics = null; // Antics: the stunts and celebrations around the pet
        this.indicator = null; // TodoPetIndicator: the top bar item and its quick menu
        this.petMenu = null; // PetMenu: the same menu on a right click on the pet

        this._prefIds = [];
        this._brainIds = [];
        this._petIds = [];
        this._sessionIds = [];
        this._tickId = 0;
        this._restartId = 0;
        this._loggedFailures = new Set();
        this._scenesCancellable = null;
        this._locked = false;
        this._hotkeyAdded = false;
        this._started = false;
        this._stopped = false;
        this._whenStarted = new Promise(resolve => {
            this._markStarted = resolve;
        });
    }

    // The screen is locked: nothing of ours is on screen and the board does not open.
    get locked() {
        return this._locked;
    }

    // Resolves when start() has built everything (or stop() came first).
    get whenStarted() {
        return this._whenStarted;
    }

    async start() {
        if (this._started)
            return;
        this._started = true;
        this.settings = this.extension.getSettings();
        this.prefs = Prefs.fromSettings(this.settings);
        setLang(this.prefs.effectiveLang);
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
        this._locked = Boolean(this.session.locked);

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
        this.brain.setLocked(this._locked);
        this._connectBrain();

        this.pet = new PetActor(this);
        this.bubble = new BubbleView(this);
        this.board = new Board(this);
        this.antics = new Antics(this);
        this._setBrainHooks();
        this._addIndicator();
        this._addHotkey();
        this.petMenu = new PetMenu(this);
        this._petIds.push(
            this.pet.on('clicked', () => this._petClicked()),
            this.pet.on('right-clicked', ({x, y}) => this.petMenu?.popUp(x, y)),
            this.pet.on('moved', frame => this.bubble?.follow(frame)),
            this.pet.on('antic-ended', () => this.brain?.endAntic()));

        this._sessionIds.push(
            this.session.on('wake', () => this.brain?.onWake(new Date())),
            this.session.on('lock-changed', locked => this._setLocked(locked)));
        // `secrets-serial` needs nothing here: the brain listens to it and reads the keyring again.
        this.onPrefChanged(name => {
            if (name === 'devTrigger') {
                this._devTrigger();
                return;
            }
            if (name === 'demoMode')
                this._restartSoon();
            if (name === 'hiddenUntil')
                this._updateVisibility();
            if (name === 'lang')
                setLang(this.prefs.effectiveLang);
            // The board shows the pet's name, the focus length, the calendar, the shortcut and the language.
            this.board?.refresh();
        });
        // A command left over from an earlier run is not ours to play. The settings window's (prefs:) stays.
        if (this.prefs.devTrigger !== '' && !this.prefs.devTrigger.startsWith('prefs:'))
            this.prefs.devTrigger = '';
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

        this._markStarted();
        // Keep this last: scenes expect everything above to be running.
        this._startDevScenes();
    }

    // Undoes everything start() did. Safe to call twice, and before start() has finished.
    stop() {
        this._stopped = true;
        this._markStarted();
        this._scenesCancellable?.cancel();
        this._scenesCancellable = null;

        if (this._tickId !== 0)
            GLib.source_remove(this._tickId);
        this._tickId = 0;
        if (this._restartId !== 0)
            GLib.source_remove(this._restartId);
        this._restartId = 0;
        if (this._hotkeyAdded)
            Main.wm.removeKeybinding('board-hotkey');
        this._hotkeyAdded = false;
        this.indicator?.destroy();
        this.indicator = null;
        this.petMenu?.destroy();
        this.petMenu = null;

        for (const id of this._brainIds)
            this.brain?.off(id);
        this._brainIds = [];
        if (this.brain) {
            this.brain.openBoard = null;
            this.brain.openBreakdown = null;
            this.brain.openSettings = null;
        }
        this.antics?.destroy();
        this.antics = null;
        this.board?.destroy();
        this.board = null;
        this.bubble?.destroy();
        this.bubble = null;
        this.brain?.stop();
        this.brain = null;

        for (const id of this._petIds)
            this.pet?.off(id);
        this._petIds = [];
        this.pet?.destroy();
        this.pet = null;
        // Modules outlive disable(): what they cache (Pango layouts, Cairo paths) goes with the pet.
        clearArtCaches();
        clearBadgeCache();

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
        const secrets = GLib.getenv('TODOPET_NO_SECRETS') === '1' ? memorySecrets() : keyringSecrets();
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
            openURL: launchURL,
        };
    }

    // Opens a link in the default browser (the board's Todoist and Join links), without waiting.
    openURL(url) {
        launchURL(url);
    }

    // What the brain's bubbles and rules open (Swift: AppDelegate's brain.openBoard, openBreakdown, openSettings).
    _setBrainHooks() {
        const brain = this.brain;
        brain.openBoard = focusAdd => this.openBoard({focusAdd});
        brain.openBreakdown = task => {
            this.board?.open();
            this.board?.showPage('split', task);
        };
        brain.openSettings = () => this.openSettings();
    }

    // --- What the indicator's menu, the shortcut and the brain's bubbles ask for ---

    // Opens the task board (not while the screen is locked: Board.open() refuses).
    openBoard({focusAdd = false} = {}) {
        this.board?.open({focusAdd});
    }

    // Swift: the menu's "Pet diary…" (board.state.showLog = true, then openBoard).
    openDiary() {
        if (!this.board || this._locked)
            return;
        this.board.open();
        this.board.showPage('diary');
    }

    // Swift: openSettings. The board closes; the settings window is the extension's preferences.
    openSettings() {
        this.board?.close();
        try {
            this.extension.openPreferences();
        } catch (e) {
            console.error(`TodoPet: could not open the settings: ${e?.message ?? e}`);
        }
    }

    // Swift: hidePet(for:). Remembered in `hidden-until`, so a restart of the shell keeps it hidden; the 1 s tick shows
    // the pet again when the time is up. The bubble and the board go with the pet (_updateVisibility).
    hidePet(ms) {
        if (!this.prefs)
            return;
        this.prefs.hiddenUntil = Date.now() + ms;
        this._updateVisibility();
    }

    // Swift: showPet.
    showPet() {
        if (!this.prefs)
            return;
        this.prefs.hiddenUntil = 0;
        this._updateVisibility();
    }

    // "Call Mochi over": the pet drops in at the middle of the screen. comeHere() shows the pet, but the tick hides it
    // again while `hidden-until` is ahead, so that goes first. Not while the screen is locked.
    callPetOver() {
        if (!this.pet || this._locked)
            return;
        this.prefs.hiddenUntil = 0;
        this.pet.comeHere();
    }

    // The menu's demo switch. The setting is what a rebuild reads; when it already says so (the demo came from the
    // "Try demo" bubble) the App is rebuilt anyway.
    setDemoMode(on) {
        if (!this.prefs)
            return;
        const changes = this.prefs.demoMode !== on;
        this.settings.set_boolean('demo-mode', on);
        if (!changes && Boolean(this.brain?.demo) !== on)
            this._restartSoon();
    }

    // Rebuilds the App from scratch, as if the extension were turned off and on (a new brain reads the demo setting).
    // Not from inside the handler that asked for it: stop() throws the settings away.
    _restartSoon() {
        if (this._restartId !== 0 || this._stopped)
            return;
        this._restartId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._restartId = 0;
            this.extension.restart?.();
            return GLib.SOURCE_REMOVE;
        });
    }

    // --- The top bar item and the shortcut ---

    _addIndicator() {
        const indicator = new TodoPetIndicator(this);
        try {
            Main.panel.addToStatusArea(this.extension.uuid, indicator);
        } catch (e) {
            indicator.destroy();
            console.error(`TodoPet: could not add the top bar item: ${e?.message ?? e}`);
            return;
        }
        this.indicator = indicator;
        indicator.setLocked(this._locked);
    }

    // The board shortcut (default Ctrl+Super+T), taken from the extension's own `board-hotkey` setting, so it follows
    // what the settings window sets. Removed again by stop(): a binding left behind would call a dead App.
    _addHotkey() {
        const action = Main.wm.addKeybinding('board-hotkey', this.settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._guard('the board shortcut', () => this.openBoard({focusAdd: true})));
        this._hotkeyAdded = action !== Meta.KeyBindingAction.NONE;
        if (!this._hotkeyAdded)
            console.warn('TodoPet: the board shortcut is already in use, it will not work');
    }

    _connectBrain() {
        const brain = this.brain;
        this._brainIds.push(
            // A new mood or a celebration shows at once (between changes the pet repaints on its own). The open
            // board draws the change too (throttled).
            brain.on('changed', () => {
                this.pet?.poke();
                this.board?.refresh();
                this.indicator?.update();
            }),
            brain.on('celebrate', celebration => {
                this.pet?.poke();
                this.antics?.celebrate(celebration);
            }),
            brain.on('bubble', bubble => this._onBubble(bubble)),
            // The brain's mischief, played by the pet and the antics (Swift: AppDelegate.perform); when it is over
            // (a click, "Spare me 15'", a celebration, the site left) everything comes off the screen.
            brain.on('antic', antic => this.antics?.run(antic)),
            brain.on('antic-end', () => this.antics?.stop()));
    }

    // Swift: AppDelegate.showBubble. The brain holds one bubble; the view shows it above the pet and gives it back
    // (dismissBubble) when its time is up. Without the pet in sight, and while the board is open (an urgent bubble
    // still comes through), a new bubble is dropped at once.
    _onBubble(bubble) {
        const brain = this.brain;
        if (!brain || !this.bubble)
            return;
        if (bubble === null) {
            this.bubble.hide();
            this.updatePause();
            return;
        }
        const petVisible = Boolean(this.pet?.visible);
        if (!shouldShowBubble({bubble, petVisible, boardOpen: Boolean(this.board?.isOpen)})) {
            brain.dismissBubble(bubble.id);
            return;
        }
        this.bubble.show(bubble, this.pet.frame, brain.mood);
        this.updatePause();
    }

    // The pet stands still while a bubble or the board is up (Swift: updatePause). The board calls this when it opens
    // or closes.
    updatePause() {
        if (this.pet)
            this.pet.paused = Boolean(this.bubble?.visible) || Boolean(this.board?.isOpen);
    }

    // Swift: AppDelegate.petClicked. Clicking the pet calls off any mischief, takes away a bubble without buttons and
    // opens the task board (or closes it; while it is open a click outside it, on the pet too, already closes it).
    _petClicked() {
        const brain = this.brain;
        if (!brain)
            return;
        if (this.pet?.isInAntic)
            brain.endAntic();
        const bubble = brain.bubble;
        if (bubble && bubble.actions.length === 0)
            brain.dismissBubble(bubble.id);
        this.board?.toggle();
    }

    // The screen locked or unlocked. Locked: the brain counts you as away, the board closes whether or not the pet is
    // on screen, and the pet, its bubble, its stunts and the top bar item go. Unlocked: they come back (the pet only if
    // `hidden-until` allows).
    _setLocked(locked) {
        this._locked = Boolean(locked);
        this.brain?.setLocked(this._locked);
        if (this._locked) {
            this.board?.close();
            this.petMenu?.close();
        }
        this.indicator?.setLocked(this._locked);
        this._updateVisibility();
    }

    // The pet hides while the screen is locked and while `hidden-until` (epoch ms) is ahead. Runs on every tick.
    _updateVisibility() {
        if (!this.pet || !this.prefs)
            return;
        const hidden = this._locked || this.prefs.hiddenUntil > Date.now();
        if (hidden) {
            // A bubble has no business on screen without the pet it points at. The board closes once, when the pet
            // goes (Swift: hidePet); opened while the pet is away, it stays (in the corner under the panel).
            const bubble = this.bubble?.bubble;
            if (bubble)
                this.brain?.dismissBubble(bubble.id);
            if (this.pet.visible)
                this.board?.close();
            this.pet.hide();
        } else {
            this.pet.show();
        }
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

    // Plays a command written to `dev-trigger` (ui/devTrigger.js) and sets the key back to '' so the next write is a
    // change. The settings window's `prefs:<page>` values are left alone.
    _devTrigger() {
        const value = this.prefs.devTrigger;
        if (value === '' || value.startsWith('prefs:') || !this.brain)
            return;
        try {
            runDevTrigger(this.brain, value);
        } catch (e) {
            console.error(`TodoPet: dev-trigger '${value}' failed: ${e?.message ?? e}`);
        } finally {
            this.prefs.devTrigger = '';
        }
    }

    // For the dev scenes (ctx.stopApp, ctx.startApp, ctx.restartedBy): lets the running scenes outlive this App's
    // stop(), and hands them to the App that replaces it. Without it, stop() cancels the run.
    releaseScenes() {
        const cancellable = this._scenesCancellable;
        this._scenesCancellable = null;
        return cancellable;
    }

    adoptScenes(cancellable) {
        this._scenesCancellable = cancellable;
    }

    // Plays the scenes listed in `dev-scenes`, if any, in the background (see devScenes.js). Only in the nested
    // shell: a real session must never run scenes, and they end by terminating the shell. The release zip leaves
    // devScenes.js out (`make pack`): then the import fails, that is logged once, and nothing else changes.
    _startDevScenes() {
        if (GLib.getenv('TODOPET_NESTED') !== '1' || this._scenesCancellable)
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
