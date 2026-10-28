// Sleep and screen lock (replaces NSWorkspace.didWakeNotification). Emits 'wake' when logind says the system
// resumed (PrepareForSleep(false)) and 'lock-changed' (with `locked`) when the shell enters or leaves the
// lock screen. Shell-only: it reads Main.sessionMode.
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Emitter} from '../core/emitter.js';

const LOGIND_NAME = 'org.freedesktop.login1';
const LOGIND_PATH = '/org/freedesktop/login1';
const LOGIND_IFACE = 'org.freedesktop.login1.Manager';
const LOGIND_XML = `<node>
  <interface name="${LOGIND_IFACE}">
    <signal name="PrepareForSleep"><arg type="b" name="start"/></signal>
  </interface>
</node>`;

let logindInfo = null;
const logindInterface = () => (logindInfo ??= Gio.DBusNodeInfo.new_for_xml(LOGIND_XML).interfaces[0]);

export class SessionWatch extends Emitter {
    constructor() {
        super();
        this.locked = false;
        this._cancellable = null;
        this._proxy = null;
        this._proxyId = 0;
        this._modeId = 0;
    }

    start() {
        if (this._cancellable)
            return;
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;

        this.locked = Main.sessionMode.isLocked;
        this._modeId = Main.sessionMode.connect('updated', () => {
            const locked = Main.sessionMode.isLocked;
            if (locked === this.locked)
                return;
            this.locked = locked;
            this.emit('lock-changed', locked);
        });

        Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM,
            Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES | Gio.DBusProxyFlags.DO_NOT_AUTO_START, logindInterface(),
            LOGIND_NAME, LOGIND_PATH, LOGIND_IFACE, cancellable, (_source, result) => {
                let proxy;
                try {
                    proxy = Gio.DBusProxy.new_for_bus_finish(result);
                } catch (e) {
                    if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn(`TodoPet: no logind proxy, waking from sleep goes unnoticed: ${e.message}`);
                    return;
                }
                if (cancellable.is_cancelled())
                    return;
                this._proxy = proxy;
                this._proxyId = proxy.connect('g-signal', (_p, _sender, name, params) => {
                    if (name === 'PrepareForSleep' && params.deepUnpack()[0] === false)
                        this.emit('wake');
                });
            });
    }

    stop() {
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._proxy && this._proxyId !== 0)
            this._proxy.disconnect(this._proxyId);
        this._proxy = null;
        this._proxyId = 0;
        if (this._modeId !== 0)
            Main.sessionMode.disconnect(this._modeId);
        this._modeId = 0;
    }
}
