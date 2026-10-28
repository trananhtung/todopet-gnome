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
}
