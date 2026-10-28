// The top bar item (macOS: the status item of AppDelegate.setupStatusItem) and its quick menu. The label is
// "<mood emoji> <done>/<target>", the focus clock ("🍅 24:58") during a focus session, or "🐾" before Todoist is
// connected (ui/indicatorLogic.js). The menu is built from quickMenu() each time it opens, so it always matches the
// brain: add a task, focus, call the pet over, hide it for an hour, quiet for an hour, refresh, the diary, the
// settings and the demo switch.
//
//   new TodoPetIndicator(app)   reads app.brain, app.prefs and app.pet; add it with Main.panel.addToStatusArea
//   update()                    redraws the label (the brain changed); during focus a 1 s timer keeps the clock going
//   setLocked(locked)           the lock screen shows nothing of ours: hidden while locked
//   destroy()                   removes the timer
//   new PetMenu(app)            the same menu on a right click on the pet (Swift: pet.hit.onRightClick)
//   popUp(x, y), close(), destroy()
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {hotkeyLabel} from './boardLogic.js';
import {HIDE_MS, QUIET_MINUTES, indicatorLabel, quickMenu} from './indicatorLogic.js';

// What the menu items do. The board, the pet and the settings are the App's; the rest is the brain's.
const ACTIONS = Object.freeze({
    open: app => app.openBoard(),
    add: app => app.openBoard({focusAdd: true}),
    connect: app => app.openBoard(),
    startFocus: app => app.brain.startFocus(null),
    stopFocus: app => app.brain.stopFocus(),
    callOver: app => app.callPetOver(),
    hide: app => app.hidePet(HIDE_MS),
    show: app => app.showPet(),
    quiet: app => app.brain.quiet(QUIET_MINUTES),
    unquiet: app => app.brain.quiet(null),
    refresh: app => app.brain.refreshSoon(),
    diary: app => app.openDiary(),
    settings: app => app.openSettings(),
});

// The items of the quick menu for the app's state right now (ui/indicatorLogic.js: quickMenu).
export function menuModel(app) {
    const {brain, prefs} = app;
    return quickMenu({
        petName: prefs.petName,
        mood: brain.mood,
        hasToken: brain.hasToken,
        focusing: brain.focusSession !== null,
        focusMinutes: prefs.focusMinutes,
        petVisible: Boolean(app.pet?.visible),
        quiet: Boolean(brain.quietUntil && brain.quietUntil.getTime() > Date.now()),
        demo: Boolean(brain.demo),
        hotkey: hotkeyLabel(prefs.boardHotkey),
    });
}

// Fills `menu` (a PopupMenu) with the quick menu, as it is for the app's state now.
export function fillQuickMenu(menu, app) {
    menu.removeAll();
    for (const item of menuModel(app)) {
        if (item.id === 'separator') {
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        } else if (item.toggle !== undefined) {
            const row = new PopupMenu.PopupSwitchMenuItem(item.title, item.toggle);
            // Switching the demo rebuilds the App (setDemoMode): the menu goes first, it is about to be destroyed.
            row.connect('toggled', (_row, state) => {
                menu.close(false);
                app.setDemoMode(state);
            });
            menu.addMenuItem(row);
        } else {
            const row = new PopupMenu.PopupMenuItem(item.title);
            if (item.hint) {
                row.label.x_expand = true;
                row.add_child(new St.Label({
                    text: item.hint, style_class: 'todopet-menu-hint', y_align: Clutter.ActorAlign.CENTER,
                }));
            }
            menu.addMenuItem(row);
            if (item.sensitive === false) {
                row.setSensitive(false);
            } else {
                // Connected after addMenuItem(): the menu's own handler runs first and closes the menu, so the board
                // opened by an item gets the grab and the key focus.
                row.connect('activate', () => {
                    try {
                        ACTIONS[item.id](app);
                    } catch (e) {
                        console.error(`TodoPet: the menu item '${item.id}' failed: ${e?.stack ?? e}`);
                    }
                });
            }
        }
    }
}

export const TodoPetIndicator = GObject.registerClass(
class TodoPetIndicator extends PanelMenu.Button {
    _init(app) {
        super._init(0.5, 'TodoPet', false);
        this._app = app;
        this._timerId = 0;
        this._label = new St.Label({
            text: '🐾', style_class: 'todopet-indicator-label', y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._label);
        // Built on every open: the pet may have been hidden, a session started, reminders muted.
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._fill();
        });
        this.connect('destroy', () => this._stopTimer());
        this._fill();
        this.update();
    }

    // The menu's items, for the dev scenes.
    get model() {
        return this._app.brain ? menuModel(this._app) : [];
    }

    get labelText() {
        return this._label.text;
    }

    update() {
        const brain = this._app.brain;
        if (!brain)
            return;
        const text = indicatorLabel(brain, Date.now());
        if (this._label.text !== text)
            this._label.text = text;
        if (brain.focusSession && this._timerId === 0) {
            this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                this.update();
                return this._timerId === 0 ? GLib.SOURCE_REMOVE : GLib.SOURCE_CONTINUE;
            });
        } else if (!brain.focusSession) {
            this._stopTimer();
        }
    }

    setLocked(locked) {
        if (locked)
            this.menu.close(false);
        this.container.visible = !locked;
    }

    _fill() {
        if (!this._app.brain || !this._app.prefs)
            return;
        fillQuickMenu(this.menu, this._app);
    }

    _stopTimer() {
        if (this._timerId !== 0)
            GLib.source_remove(this._timerId);
        this._timerId = 0;
    }
});

// The quick menu where the pet was right-clicked, above that spot (the pet stands at the bottom of the screen; the
// menu flips when there is no room). Built on every use, like the top bar menu.
export class PetMenu {
    constructor(app) {
        this._app = app;
        // A 1 px actor at the click: the menu's source.
        this._anchor = new St.Widget({name: 'todopet-menu-anchor', width: 1, height: 1, opacity: 0, visible: false});
        Main.uiGroup.add_child(this._anchor);
        this.menu = new PopupMenu.PopupMenu(this._anchor, 0.5, St.Side.BOTTOM);
        // A menu outside the panel is added to the stage by hand, and starts out visible: an empty bar at the corner.
        Main.uiGroup.add_child(this.menu.actor);
        this.menu.actor.hide();
        this._manager = new PopupMenu.PopupMenuManager(this._anchor);
        this._manager.addMenu(this.menu);
        // The anchor is only on screen (and in the stage's tree as a visible actor) while the menu is.
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (!open && this._anchor)
                this._anchor.visible = false;
        });
    }

    get isOpen() {
        return Boolean(this.menu?.isOpen);
    }

    popUp(x, y) {
        const app = this._app;
        if (!this.menu || !app.brain || !app.prefs || app.locked)
            return;
        this._anchor.set_position(Math.round(x), Math.round(y));
        this._anchor.visible = true;
        fillQuickMenu(this.menu, app);
        this.menu.open(true);
    }

    close() {
        this.menu?.close(false);
    }

    destroy() {
        if (!this.menu)
            return;
        this._manager.removeMenu(this.menu);
        this._manager = null;
        this.menu.destroy();
        this.menu = null;
        this._anchor.destroy();
        this._anchor = null;
    }
}
