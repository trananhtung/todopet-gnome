// Composition root: owns every service and UI object, and undoes all of it in stop().
// extension.js creates one App per enable() and calls stop() from disable().
//
// Environment variables set only by tools/nested.sh (the isolated nested shell):
//   TODOPET_NESTED=1      this is the nested dev shell; the only place dev scenes may run.
//   TODOPET_NO_SECRETS=1  do not touch libsecret/the keyring; the nested session can reach the real one.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {Prefs} from '../core/prefs.js';

export class App {
    constructor(extension) {
        this.extension = extension;
        this.settings = null;
        this.prefs = null;
        // Filled in by later tasks.
        this.brain = null;
        this.pet = null;
        this.bubble = null;
        this.board = null;
        this.antics = null;
        this.indicator = null;

        this._prefIds = [];
        this._scenesCancellable = null;
    }

    async start() {
        this.settings = this.extension.getSettings();
        this.prefs = Prefs.fromSettings(this.settings);
        if (this.prefs.firstLaunch === 0)
            this.prefs.firstLaunch = Date.now();

        // Keep this last: scenes expect everything above to be running.
        this._startDevScenes();
    }

    // Undoes everything start() did. Safe to call twice, and before start() has finished.
    stop() {
        this._scenesCancellable?.cancel();
        this._scenesCancellable = null;

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
