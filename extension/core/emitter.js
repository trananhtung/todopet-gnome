// A tiny synchronous event emitter. Listener ids are unique across all event names.

export class Emitter {
    constructor() {
        this._listeners = new Map(); // id -> {name, cb}
        this._nextId = 1;
    }

    on(name, cb) {
        const id = this._nextId++;
        this._listeners.set(id, {name, cb});
        return id;
    }

    off(id) {
        this._listeners.delete(id);
    }

    emit(name, ...args) {
        // Snapshot first: listeners added while emitting wait for the next emit; listeners
        // removed while emitting (checked below) are skipped.
        const snapshot = [...this._listeners].filter(([, l]) => l.name === name);
        for (const [id, listener] of snapshot) {
            if (!this._listeners.has(id))
                continue;
            try {
                listener.cb(...args);
            } catch (e) {
                // One broken listener must not stop the others or the emitter's caller.
                this._reportError(name, e);
            }
        }
    }

    // Overridable (tests replace it) so a listener's error is reported without being thrown.
    _reportError(name, error) {
        console.error(`Emitter: listener for '${name}' threw: ${error?.stack ?? error}`);
    }
}
