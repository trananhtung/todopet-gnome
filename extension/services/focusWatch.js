// The focused window: app name, window class and, for a browser only, the title (replaces
// NSWorkspace.frontmostApplication and the didActivateApplication observer). Follows `notify::focus-window` on the
// display, and `notify::title` on the focused window when it is a browser. The title of any other window is never
// read: the brain matches sites by a browser's title, and other apps by name and window class.
//
// The display and the Shell.WindowTracker are passed in (App passes Shell.WindowTracker.get_default(); the
// display defaults to global.display, read in start()), so this file imports no Shell library and plain gjs
// can load it with fakes.
import {Emitter} from '../core/emitter.js';
import {isBrowser} from '../core/sites.js';

// Shell app ids (without ".desktop") of browsers whose window class does not say so, such as Chrome's
// "chrome-<id>-Default" web app windows or Flatpak builds.
export const BROWSER_APP_IDS = Object.freeze([
    'com.google.Chrome', 'com.brave.Browser', 'com.microsoft.Edge', 'org.chromium.Chromium', 'com.vivaldi.Vivaldi',
    'com.opera.Opera', 'org.mozilla.firefox',
]);

export function isBrowserWindow(wmClass, appId) {
    if (isBrowser(wmClass))
        return true;
    const id = typeof appId === 'string' ? appId.replace(/\.desktop$/, '') : '';
    return BROWSER_APP_IDS.includes(id);
}

// `current` is {appName, wmClass, title, isBrowser, since: Date} or null when no window has focus (the desktop,
// the overview). `title` is null unless isBrowser. `since` is when focus moved to that window; a new title on the
// same (browser) window keeps it.
// `lastSwitch` is when focus last moved to a different window. Emits 'changed' with `current`.
export class FocusWatch extends Emitter {
    constructor({display = null, tracker = null, now = () => new Date()} = {}) {
        super();
        this._displayArg = display;
        this._tracker = tracker;
        this._now = now;
        this._display = null;
        this._displayId = 0;
        // The window focus is on, or was on before it went to nothing; watched for title changes.
        this._window = null;
        this._windowIds = [];
        this._since = null; // when focus moved to this._window
        this.current = null;
        this.lastSwitch = now();
    }

    start() {
        if (this._display)
            return;
        this._display = this._displayArg ?? global.display;
        this._displayId = this._display.connect('notify::focus-window', () => this._sync());
        const now = this._now();
        this.lastSwitch = now;
        this._watch(this._display.focus_window ?? null, now);
        this.current = this._window ? this._describe(this._window) : null;
    }

    stop() {
        this._unwatch();
        if (this._display && this._displayId !== 0)
            this._display.disconnect(this._displayId);
        this._display = null;
        this._displayId = 0;
        this.current = null;
    }

    _sync() {
        const win = this._display.focus_window ?? null;
        if (win === null) {
            // Nothing focused is not a switch: coming back to the same window keeps its `since`.
            if (this.current === null)
                return;
            this.current = null;
        } else if (win === this._window) {
            if (this.current !== null)
                return;
            this.current = this._describe(win);
        } else {
            const now = this._now();
            this._watch(win, now);
            this.lastSwitch = now;
            this.current = this._describe(win);
        }
        this.emit('changed', this.current);
    }

    _onTitle(win) {
        if (win !== this._window || this.current === null)
            return;
        this.current = this._describe(win);
        this.emit('changed', this.current);
    }

    _watch(win, since) {
        this._unwatch();
        if (!win)
            return;
        this._window = win;
        this._since = since;
        this._windowIds = [
            // A closed window must not be kept alive by this watch.
            win.connect('unmanaged', () => {
                if (win === this._window)
                    this._unwatch();
            }),
        ];
        if (this._isBrowser(win))
            this._windowIds.push(win.connect('notify::title', () => this._onTitle(win)));
    }

    _unwatch() {
        for (const id of this._windowIds)
            this._window.disconnect(id);
        this._windowIds = [];
        this._window = null;
        this._since = null;
    }

    _isBrowser(win) {
        const app = this._tracker?.get_window_app(win) ?? null;
        return isBrowserWindow(win.get_wm_class() ?? '', app?.get_id() ?? '');
    }

    _describe(win) {
        const app = this._tracker?.get_window_app(win) ?? null;
        const wmClass = win.get_wm_class() ?? '';
        const browser = isBrowserWindow(wmClass, app?.get_id() ?? '');
        return {
            appName: app?.get_name() || wmClass,
            wmClass,
            title: browser ? win.get_title() ?? '' : null,
            isBrowser: browser,
            since: this._since,
        };
    }
}
