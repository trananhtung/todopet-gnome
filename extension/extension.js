import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {App} from './ui/app.js';

export default class TodoPetExtension extends Extension {
    enable() {
        this._app = new App(this);
        this._app.start().catch(logError);
    }

    disable() {
        this._app?.stop();
        this._app = null;
    }

    // The running App (null while disabled), for the dev scenes.
    get app() {
        return this._app ?? null;
    }

    // Turns the extension off and on again: a new App reads the settings from scratch (the demo mode changed).
    restart() {
        this.disable();
        this.enable();
    }
}
