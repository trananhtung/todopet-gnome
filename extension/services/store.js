// The pet's files on disk, written without ever blocking GNOME Shell: every call is an async Gio call.
//   JsonStore   <dir>/<name>.json   the pet's state (life, stuck tasks...), saved after a short wait
//   DiaryFiles  <dir>/<day>.jsonl   the diary's `files` object (see core/diary.js)
// Imports only gi:// modules, so it also runs in the plain-gjs tests.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'append_to_async', 'append_to_finish');
Gio._promisify(Gio.File.prototype, 'make_directory_async', 'make_directory_finish');
Gio._promisify(Gio.File.prototype, 'move_async', 'move_finish');
Gio._promisify(Gio.File.prototype, 'delete_async', 'delete_finish');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async', 'enumerate_children_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async', 'next_files_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async', 'close_finish');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async', 'write_bytes_finish');
Gio._promisify(Gio.OutputStream.prototype, 'close_async', 'close_finish');

const PRIORITY = GLib.PRIORITY_DEFAULT;
// Files hold the user's task titles, so they are private to the user.
const CREATE = Gio.FileCreateFlags.PRIVATE;
const SAVE_DELAY_MS = 500;
const JSON_NAME = /^[A-Za-z0-9_-]+$/;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const DIARY_EXT = '.jsonl';
const LIST_BATCH = 64;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Where the pet keeps its files: $TODOPET_DATA_DIR, else ~/.local/share/todopet.
export function dataDir() {
    return GLib.getenv('TODOPET_DATA_DIR') || `${GLib.get_user_data_dir()}/todopet`;
}

const isIOError = (e, code) => e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, code);
const isNotFound = e => isIOError(e, Gio.IOErrorEnum.NOT_FOUND);

// Makes one folder; a folder that is already there is fine.
async function makeDir(dir) {
    try {
        await dir.make_directory_async(PRIORITY, null);
    } catch (e) {
        if (!isIOError(e, Gio.IOErrorEnum.EXISTS))
            throw e;
    }
}

// `mkdir -p`, async: makes the folder, and the missing ones above it.
async function makeDirs(dir) {
    try {
        await makeDir(dir);
    } catch (e) {
        const parent = dir.get_parent();
        if (!isNotFound(e) || parent === null)
            throw e;
        await makeDirs(parent);
        await makeDir(dir);
    }
}

// Runs `operation` (a file call that needs the folder around the file). When the folder is missing it is made
// and the call is tried once more.
async function inFolder(file, operation) {
    try {
        return await operation();
    } catch (e) {
        if (!isNotFound(e))
            throw e;
        await makeDirs(file.get_parent());
        return operation();
    }
}

// Closes a stream; if the work before it failed, that error is the one that is thrown.
async function closeAfter(stream, work) {
    let failure = null;
    try {
        await work();
    } catch (e) {
        failure = e;
    }
    try {
        await stream.close_async(PRIORITY, null);
    } catch (e) {
        failure ??= e;
    }
    if (failure)
        throw failure;
}

// Writes `text` to the end of `file` (made when missing), all of it, in one go.
async function appendText(file, text) {
    const bytes = new GLib.Bytes(encoder.encode(text));
    const size = bytes.get_size();
    const stream = await inFolder(file, () => file.append_to_async(CREATE, PRIORITY, null));
    await closeAfter(stream, async () => {
        for (let done = 0; done < size;) {
            const rest = done === 0 ? bytes : GLib.Bytes.new_from_bytes(bytes, done, size - done);
            const written = await stream.write_bytes_async(rest, PRIORITY, null);
            if (written <= 0)
                throw new Error(`Could not write to ${file.get_path()}`);
            done += written;
        }
    });
}

// The whole text of `file`, or null when there is no such file.
async function readText(file) {
    try {
        const [contents] = await file.load_contents_async(null);
        return decoder.decode(contents);
    } catch (e) {
        if (isNotFound(e))
            return null;
        throw e;
    }
}

// Orders the work on one key: `run(key, task)` starts `task` once the earlier tasks of that key are done.
// A failing task fails its own promise only. Nothing is kept for a key that has no work left.
class KeyedQueue {
    constructor() {
        this._tails = new Map();
    }

    run(key, task) {
        const result = (this._tails.get(key) ?? Promise.resolve()).then(task);
        const tail = result.catch(() => {});
        this._tails.set(key, tail);
        tail.then(() => {
            if (this._tails.get(key) === tail)
                this._tails.delete(key);
        });
        return result;
    }

    // Resolves when the work queued so far on `key` is done (failures included).
    idle(key) {
        return this._tails.get(key) ?? Promise.resolve();
    }

    // Resolves when the work queued so far on every key is done.
    idleAll() {
        return Promise.all([...this._tails.values()]).then(() => {});
    }
}

// JSON objects by name: save() keeps the latest object and writes it `delay` ms after the last save of that name;
// the file is replaced atomically (written aside, then renamed), so a crash never leaves half a file.
export class JsonStore {
    // `delay` is the wait before a save is written. `onError(error)` hears about writes that failed (by default
    // they go to the log); a failed write never stops later ones.
    constructor(dir = dataDir(), {delay = SAVE_DELAY_MS, onError = null} = {}) {
        this.dir = dir;
        this.delay = delay;
        this._onError = onError;
        this._waiting = new Map(); // name -> {text, source}: saves not written yet
        this._writes = new KeyedQueue();
        this._destroyed = false;
    }

    // The object saved under `name`, or null when there is none. A file that is not a JSON object is set aside as
    // <name>.json.bad and counts as none. A file that cannot be read for another reason is an error, so the
    // caller never overwrites data it could not read.
    async load(name) {
        const file = this._file(name);
        await this._settle(name);
        const text = await readText(file);
        if (text === null)
            return null;
        const value = parseObject(text);
        if (value !== null)
            return value;
        await this._setAside(file);
        return null;
    }

    // Keeps a copy of `obj` to be written as <name>.json soon. Saving the same name again before then replaces it
    // and restarts the wait. Ignored once the store is destroyed.
    save(name, obj) {
        this._file(name);
        if (obj === null || typeof obj !== 'object')
            throw new TypeError(`A store keeps objects, not ${obj === null ? 'null' : typeof obj}`);
        if (this._destroyed)
            return;
        const text = JSON.stringify(obj);
        const waiting = this._waiting.get(name);
        if (waiting)
            GLib.source_remove(waiting.source);
        const entry = {text, source: 0};
        entry.source = GLib.timeout_add(PRIORITY, this.delay, () => {
            entry.source = 0;
            this._startWrite(name);
            return GLib.SOURCE_REMOVE;
        });
        this._waiting.set(name, entry);
    }

    // Writes everything that is waiting now; resolves when all the writes so far are done.
    async flush() {
        for (const name of [...this._waiting.keys()])
            this._startWrite(name);
        await this._writes.idleAll();
    }

    // Cancels the saves that are still waiting (flush() first to keep them) and ignores later ones.
    destroy() {
        this._destroyed = true;
        for (const {source} of this._waiting.values())
            GLib.source_remove(source);
        this._waiting.clear();
    }

    _file(name) {
        if (typeof name !== 'string' || !JSON_NAME.test(name))
            throw new TypeError(`Not a store name: ${JSON.stringify(name)}`);
        return Gio.File.new_for_path(`${this.dir}/${name}.json`);
    }

    // Moves the waiting save of `name` (if any) into the queue of writes for that file.
    _startWrite(name) {
        const entry = this._waiting.get(name);
        if (!entry)
            return;
        this._waiting.delete(name);
        if (entry.source)
            GLib.source_remove(entry.source);
        this._writes.run(name, () => this._write(this._file(name), entry.text)).catch(e => this._report(e));
    }

    // Resolves when everything saved under `name` so far is on disk.
    async _settle(name) {
        this._startWrite(name);
        await this._writes.idle(name);
    }

    _write(file, text) {
        const bytes = new GLib.Bytes(encoder.encode(text));
        return inFolder(file, () => file.replace_contents_bytes_async(bytes, null, false, CREATE, null));
    }

    // Keeps a corrupt file for inspection as <name>.json.bad instead of deleting it.
    async _setAside(file) {
        const bad = Gio.File.new_for_path(`${file.get_path()}.bad`);
        try {
            await file.move_async(bad, Gio.FileCopyFlags.OVERWRITE, PRIORITY, null, null);
        } catch (e) {
            this._report(e);
        }
    }

    _report(e) {
        if (this._onError)
            this._onError(e);
        else
            console.error(`TodoPet: could not write a file in ${this.dir}: ${e?.message ?? e}`);
    }
}

// The JSON object in `text`, or null when it is not valid JSON or not an object.
function parseObject(text) {
    try {
        const value = JSON.parse(text);
        return value !== null && typeof value === 'object' ? value : null;
    } catch {
        return null;
    }
}

// The diary's `files` object: one JSON-lines file per day, <dir>/<day>.jsonl, written by appending.
// Appends to one day go one after the other (a read or remove of that day waits for them too), so lines never mix.
export class DiaryFiles {
    constructor(dir = `${dataDir()}/log`) {
        this.dir = dir;
        this._queue = new KeyedQueue();
    }

    // Adds `line` (which ends in a newline) to the end of that day's file. Makes the folder and the file when missing.
    async append(day, line) {
        const file = this._file(day);
        await this._queue.run(day, () => appendText(file, line));
    }

    // The whole text of that day's file; '' when there is none.
    async read(day) {
        const file = this._file(day);
        await this._queue.idle(day);
        return await readText(file) ?? '';
    }

    // The days that have a file, as day keys ("2026-10-25"), oldest first. No folder yet means no days.
    async list() {
        let children;
        try {
            children = await Gio.File.new_for_path(this.dir)
                .enumerate_children_async('standard::name', Gio.FileQueryInfoFlags.NONE, PRIORITY, null);
        } catch (e) {
            if (isNotFound(e))
                return [];
            throw e;
        }
        const days = [];
        await closeAfter(children, async () => {
            for (;;) {
                const infos = await children.next_files_async(LIST_BATCH, PRIORITY, null);
                if (infos.length === 0)
                    return;
                for (const info of infos) {
                    const name = info.get_name();
                    const day = name.endsWith(DIARY_EXT) ? name.slice(0, -DIARY_EXT.length) : '';
                    if (DAY_KEY.test(day))
                        days.push(day);
                }
            }
        });
        return days.sort();
    }

    // Deletes that day's file (fine when there is none).
    async remove(day) {
        const file = this._file(day);
        await this._queue.run(day, async () => {
            try {
                await file.delete_async(PRIORITY, null);
            } catch (e) {
                if (!isNotFound(e))
                    throw e;
            }
        });
    }

    _file(day) {
        if (typeof day !== 'string' || !DAY_KEY.test(day))
            throw new TypeError(`Not a day key: ${JSON.stringify(day)}`);
        return Gio.File.new_for_path(`${this.dir}/${day}${DIARY_EXT}`);
    }
}
