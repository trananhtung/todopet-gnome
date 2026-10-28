// Test doubles shared by the test modules. Later tasks add to this file.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const copy = value => JSON.parse(JSON.stringify(value));

// An in-memory JsonStore: {load(name) -> Promise<object|null>, save(name, obj), flush() -> Promise}.
// `saves` records every save as [name, copy of obj], in order. Values are copied on the way in and out,
// like a file would, so a test cannot change the "disk" by mutating what it got back.
export class MemoryStore {
    constructor(initial = {}) {
        this._data = new Map(Object.entries(initial).map(([name, value]) => [name, copy(value)]));
        this.saves = [];
    }

    async load(name) {
        return this._data.has(name) ? copy(this._data.get(name)) : null;
    }

    save(name, obj) {
        this.saves.push([name, copy(obj)]);
        this._data.set(name, copy(obj));
    }

    flush() {
        return Promise.resolve();
    }
}

// In-memory diary files: {append(day, line), read(day), list(), remove(day)}.
// `data` maps a day key ("2026-10-25") to the whole text of that day's file, so tests can look at it
// and set it up. `append` adds `line` exactly as given (the diary hands it a trailing newline).
export class MemoryFiles {
    constructor(initial = {}) {
        this.data = new Map(Object.entries(initial));
    }

    async append(day, line) {
        this.data.set(day, (this.data.get(day) ?? '') + line);
    }

    async read(day) {
        return this.data.get(day) ?? '';
    }

    async list() {
        return [...this.data.keys()];
    }

    async remove(day) {
        this.data.delete(day);
    }
}

// A new, empty directory under the system temp directory; returns its path. The caller removes it.
export function tmpDir() {
    return GLib.dir_make_tmp('todopet-test-XXXXXX');
}

// Deletes a directory and everything in it (tests only: it blocks). A path that is not there is fine.
export function rmTree(path) {
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null))
        return;
    if (file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null) === Gio.FileType.DIRECTORY) {
        const children = file.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        for (let info = children.next_file(null); info; info = children.next_file(null))
            rmTree(file.get_child(info.get_name()).get_path());
        children.close(null);
    }
    file.delete(null);
}

// Resolves after `ms` milliseconds of the GLib main loop, which is what lets Gio's async calls and timeouts run.
export function sleep(ms) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}
