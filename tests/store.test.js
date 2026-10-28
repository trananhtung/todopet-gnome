// Tests for services/store.js (JSON files and diary files on disk) and services/secrets.js (libsecret), and that
// nothing but an import() on first use reaches libsecret (gir1.2-secret-1 is not a dependency of GNOME Shell).
// Everything lives in temp directories: nothing here may touch the real ~/.local/share/todopet.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Secret from 'gi://Secret';

import {SECRET_ANTHROPIC, SECRET_TODOIST} from '../extension/core/secretNames.js';
import {DiaryFiles, JsonStore, dataDir} from '../extension/services/store.js';
import {
    _schemaCreated, clearSecret, lookupSecret, secretSchema, storeSecret,
} from '../extension/services/secrets.js';
import {rmTree, sleep, tmpDir} from './helpers.js';

Gio._promisify(Secret.Service, 'get', 'get_finish');
Gio._promisify(Secret.Collection, 'for_alias', 'for_alias_finish');
Gio._promisify(Secret, 'password_search', 'password_search_finish');

const decoder = new TextDecoder();

// The text of a file, read the blocking way (tests only).
const readText = path => decoder.decode(GLib.file_get_contents(path)[1]);
const exists = path => GLib.file_test(path, GLib.FileTest.EXISTS);
const writeText = (path, text) => GLib.file_set_contents(path, text);

// The names in a directory, sorted (tests only).
function names(dir) {
    const out = [];
    const d = GLib.Dir.open(dir, 0);
    for (let name = d.read_name(); name !== null; name = d.read_name())
        out.push(name);
    d.close();
    return out.sort();
}

export default async function (t) {
    const dirs = [];
    const fresh = () => {
        const dir = tmpDir();
        dirs.push(dir);
        return dir;
    };
    try {
        dataDirTests(t, fresh);
        await jsonStoreTests(t, fresh);
        await diaryFilesTests(t, fresh);
    } finally {
        for (const dir of dirs)
            rmTree(dir);
    }
    await secretsTests(t);
}

function dataDirTests(t, fresh) {
    const saved = GLib.getenv('TODOPET_DATA_DIR');
    try {
        const dir = fresh();
        GLib.setenv('TODOPET_DATA_DIR', dir, true);
        t.eq(dataDir(), dir, 'dataDir is $TODOPET_DATA_DIR when it is set');
        t.eq([new JsonStore().dir, new DiaryFiles().dir], [dir, `${dir}/log`],
            'the stores default to the data dir, the diary to its log folder');
        GLib.setenv('TODOPET_DATA_DIR', '', true);
        t.eq(dataDir(), `${GLib.get_user_data_dir()}/todopet`, 'an empty $TODOPET_DATA_DIR is ignored');
        GLib.unsetenv('TODOPET_DATA_DIR');
        t.eq(dataDir(), `${GLib.get_user_data_dir()}/todopet`, 'without it the data dir is under the user data dir');
    } finally {
        if (saved === null)
            GLib.unsetenv('TODOPET_DATA_DIR');
        else
            GLib.setenv('TODOPET_DATA_DIR', saved, true);
    }
}

async function jsonStoreTests(t, fresh) {
    // --- Round trip ---
    const dir = fresh();
    const store = new JsonStore(dir);
    t.eq(store.delay, 500, 'saves are debounced by 500 ms');
    t.eq(await store.load('life'), null, 'a missing file loads as null');
    t.check(!exists(`${dir}/life.json`), 'loading does not create the file');
    store.save('life', {xp: 5});
    t.check(!exists(`${dir}/life.json`), 'a save is not written at once');
    t.eq(await store.flush(), undefined, 'flush resolves when the write is done');
    t.eq(readText(`${dir}/life.json`), '{"xp":5}', 'the file is <dir>/<name>.json with the JSON in it');
    t.eq(await store.load('life'), {xp: 5}, 'a saved object loads back');
    t.eq(await new JsonStore(dir).load('life'), {xp: 5}, 'and a new store reads it from disk');
    t.eq(names(dir), ['life.json'], 'no temporary file is left behind');
    t.eq(await store.flush(), undefined, 'flush with nothing to write resolves');

    const text = {title: '“Viết báo cáo” — vì 45 phút', list: [1, 2, {a: null}], nested: {ok: true}};
    store.save('text', text);
    text.title = 'changed after the save';
    await store.flush();
    t.eq(await store.load('text'), {title: '“Viết báo cáo” — vì 45 phút', list: [1, 2, {a: null}], nested: {ok: true}},
        'the object is copied when saved, and non-ASCII text survives');

    const info = Gio.File.new_for_path(`${dir}/life.json`).query_info('unix::mode', 0, null);
    t.eq(info.get_attribute_uint32('unix::mode') & 0o077, 0, 'state files are private to the user');

    // --- The latest object wins, each name is written on its own ---
    store.save('life', {xp: 1});
    store.save('life', {xp: 2});
    store.save('stuck', {seen: {}});
    store.save('life', {xp: 3});
    await store.flush();
    t.eq([await store.load('life'), await store.load('stuck')], [{xp: 3}, {seen: {}}],
        'of several saves of a name only the latest object is written; names are separate files');
    t.eq(names(dir), ['life.json', 'stuck.json', 'text.json'], 'one file per name');

    // load sees a save that has not been written yet.
    store.save('life', {xp: 99});
    t.eq(await store.load('life'), {xp: 99}, 'load gives a save that is still waiting to be written');
    t.eq(readText(`${dir}/life.json`), '{"xp":99}', 'by writing it first');

    // Many saves with flushes in between keep their order.
    for (let i = 0; i < 20; i++) {
        store.save('count', {i});
        if (i % 3 === 0)
            store.flush();
    }
    await store.flush();
    t.eq(await store.load('count'), {i: 19}, 'writes of one name never overtake each other');

    // --- Debounce: a later save restarts the wait ---
    const slowDir = fresh();
    const slow = new JsonStore(slowDir, {delay: 200});
    slow.save('a', {n: 1});
    await sleep(120);
    slow.save('a', {n: 2});
    await sleep(130);
    t.check(!exists(`${slowDir}/a.json`), 'a save made during the wait restarts it');
    await sleep(250);
    t.eq(readText(`${slowDir}/a.json`), '{"n":2}', 'and the latest object is written once the wait is over');
    slow.destroy();

    // --- destroy ---
    const goneDir = fresh();
    const gone = new JsonStore(goneDir, {delay: 30});
    gone.save('a', {n: 1});
    gone.destroy();
    gone.save('b', {n: 2});
    await sleep(120);
    t.check(!exists(`${goneDir}/a.json`) && !exists(`${goneDir}/b.json`),
        'destroy cancels the waiting saves, and later saves are ignored');
    t.eq(await gone.flush(), undefined, 'flush still resolves after destroy');
    const kept = new JsonStore(goneDir, {delay: 30});
    kept.save('a', {n: 1});
    await kept.flush();
    kept.destroy();
    t.eq(await new JsonStore(goneDir).load('a'), {n: 1}, 'flush before destroy keeps the data');

    // --- The directory is made when it is missing ---
    const nestedDir = `${fresh()}/one/two`;
    const nested = new JsonStore(nestedDir);
    nested.save('life', {xp: 1});
    await nested.flush();
    t.eq(await nested.load('life'), {xp: 1}, 'missing folders are created, parents included');

    // --- Corrupt files ---
    const badDir = fresh();
    const bad = new JsonStore(badDir);
    writeText(`${badDir}/life.json`, '{"xp": 5,, nope');
    t.eq(await bad.load('life'), null, 'a corrupt file loads as null');
    t.check(!exists(`${badDir}/life.json`) && readText(`${badDir}/life.json.bad`) === '{"xp": 5,, nope',
        'and is renamed to <name>.json.bad');
    bad.save('life', {xp: 1});
    await bad.flush();
    t.eq([await bad.load('life'), readText(`${badDir}/life.json.bad`)], [{xp: 1}, '{"xp": 5,, nope'],
        'a new save does not touch the .bad file');
    writeText(`${badDir}/life.json`, 'second corruption');
    t.eq(await bad.load('life'), null, 'a second corrupt file loads as null too');
    t.eq(readText(`${badDir}/life.json.bad`), 'second corruption', 'and replaces the older .bad file');
    for (const [label, content] of [['empty', ''], ['null', 'null'], ['a number', '5'], ['a string', '"x"']]) {
        writeText(`${badDir}/odd.json`, content);
        t.eq(await bad.load('odd'), null, `a file that holds ${label} is not an object, so it is corrupt`);
        t.check(!exists(`${badDir}/odd.json`) && exists(`${badDir}/odd.json.bad`), `and ${label} is set aside`);
    }
    t.eq(names(badDir), ['life.json.bad', 'odd.json.bad'], 'nothing else is left in the folder');

    // --- Names and values are checked ---
    const strict = new JsonStore(fresh());
    for (const name of ['../x', 'a/b', '', '.hidden', 'a.b', 5, undefined]) {
        let thrown = null;
        try {
            strict.save(name, {});
        } catch (e) {
            thrown = e;
        }
        t.check(thrown instanceof TypeError, `save refuses the name ${JSON.stringify(name)}`);
        await t.rejects(strict.load(name), e => e instanceof TypeError, `load refuses the name ${JSON.stringify(name)}`);
    }
    for (const value of [null, undefined, 5, 'x']) {
        let thrown = null;
        try {
            strict.save('life', value);
        } catch (e) {
            thrown = e;
        }
        t.check(thrown instanceof TypeError, `save refuses ${String(value)} (only objects are stored)`);
    }
    t.eq(names(strict.dir), [], 'a refused save writes nothing');

    // --- Failures are reported, never thrown ---
    const blockedDir = fresh();
    writeText(`${blockedDir}/blocker`, 'a file where a folder should be');
    const errors = [];
    const blocked = new JsonStore(`${blockedDir}/blocker/sub`, {onError: e => errors.push(e.message)});
    blocked.save('life', {xp: 1});
    t.eq(await blocked.flush(), undefined, 'flush resolves even when the write fails');
    t.check(errors.length === 1 && errors[0] !== '', 'and the failure goes to onError');
    await t.rejects(blocked.load('life'), null, 'a read that fails other than "not found" is passed on');
    blocked.save('life', {xp: 2});
    await blocked.flush();
    t.eq(errors.length, 2, 'later saves are tried again');
}

async function diaryFilesTests(t, fresh) {
    const root = fresh();
    const dir = `${root}/log`;
    const files = new DiaryFiles(dir);

    t.eq(await files.list(), [], 'a diary folder that does not exist has no days');
    t.eq(await files.read('2026-10-25'), '', 'and no text for a day');
    await files.remove('2026-10-25');
    t.check(!exists(dir), 'removing a missing day is fine and creates nothing');

    // --- append creates the folder and the file ---
    await files.append('2026-10-25', '{"a":1}\n');
    t.check(exists(`${dir}/2026-10-25.jsonl`), 'append creates the log folder and the day file <day>.jsonl');
    await files.append('2026-10-25', '{"b":"“Viết” — vì"}\n');
    t.eq(readText(`${dir}/2026-10-25.jsonl`), '{"a":1}\n{"b":"“Viết” — vì"}\n', 'append adds the line as given, after the others');
    t.eq(await files.read('2026-10-25'), '{"a":1}\n{"b":"“Viết” — vì"}\n', 'read gives the whole text back');
    t.eq(await files.read('2026-10-24'), '', 'a day without a file reads as empty');

    const info = Gio.File.new_for_path(`${dir}/2026-10-25.jsonl`).query_info('unix::mode', 0, null);
    t.eq(info.get_attribute_uint32('unix::mode') & 0o077, 0, 'diary files are private to the user');

    // --- Writes of the same file never interleave ---
    const lines = Array.from({length: 150}, (_, i) => `${JSON.stringify({i, pad: 'x'.repeat(2000 + i * 7), s: 'é“—'})}\n`);
    await Promise.all(lines.map(line => files.append('2026-10-26', line)));
    t.check(readText(`${dir}/2026-10-26.jsonl`) === lines.join(''), 'many appends started at once land whole and in order');
    // A read or a remove queued behind appends sees them.
    const behind = files.append('2026-10-27', 'one\n');
    const seen = await files.read('2026-10-27');
    await behind;
    t.eq(seen, 'one\n', 'a read waits for the appends started before it');
    files.append('2026-10-28', 'two\n');
    await files.remove('2026-10-28');
    t.check(!exists(`${dir}/2026-10-28.jsonl`), 'and so does a remove');

    // --- list and remove ---
    writeText(`${dir}/notes.txt`, 'not a day');
    writeText(`${dir}/weird.jsonl`, '');
    writeText(`${dir}/2026-10-20.jsonl.bak`, '');
    t.eq(await files.list(), ['2026-10-25', '2026-10-26', '2026-10-27'],
        'list gives the days that have a file, as day keys; other files are left out');
    await files.remove('2026-10-26');
    t.eq([exists(`${dir}/2026-10-26.jsonl`), exists(`${dir}/notes.txt`)], [false, true], 'remove deletes just that day');
    await files.remove('2026-10-26');
    t.eq(await files.list(), ['2026-10-25', '2026-10-27'], 'removing a day twice is fine');

    // --- Days are checked ---
    for (const day of ['../evil', '2026-10-25/../x', '', 'today', '2026-1-1', undefined]) {
        await t.rejects(files.append(day, 'x\n'), e => e instanceof TypeError, `append refuses the day ${JSON.stringify(day)}`);
        await t.rejects(files.read(day), e => e instanceof TypeError, `read refuses the day ${JSON.stringify(day)}`);
        await t.rejects(files.remove(day), e => e instanceof TypeError, `remove refuses the day ${JSON.stringify(day)}`);
    }

    // --- A folder that cannot be made is an error for the caller ---
    writeText(`${root}/blocker`, 'a file');
    await t.rejects(new DiaryFiles(`${root}/blocker/log`).append('2026-10-25', 'x\n'), null,
        'append fails when the folder cannot be made');
    await files.append('2026-10-29', 'after\n');
    t.eq(await files.read('2026-10-29'), 'after\n', 'and a failed write does not stop the next ones');
}

// True when a Secret Service is on the bus with an unlocked default keyring (so the test never opens an unlock prompt).
async function secretServiceReady() {
    const cancellable = new Gio.Cancellable();
    const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
        cancellable.cancel();
        return GLib.SOURCE_REMOVE;
    });
    try {
        await Secret.Service.get(Secret.ServiceFlags.NONE, cancellable);
        const keyring = await Secret.Collection.for_alias(null, 'default', Secret.CollectionFlags.NONE, cancellable);
        return keyring !== null && !keyring.get_locked();
    } catch {
        return false;
    } finally {
        GLib.source_remove(timer);
    }
}

// The repository's extension/ folder, found relative to this file so the cwd does not matter.
const EXTENSION_DIR = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_child('extension');

// What `path` (relative to extension/) imports with static import declarations, and what those files import, and so
// on: the module specifiers ('gi://Secret', 'resource:///...', and the files as paths relative to extension/).
// import() calls are not followed: they load on first use.
function staticImportClosure(path) {
    const seen = new Set();
    const specifiers = new Set();
    const visit = file => {
        const rel = EXTENSION_DIR.get_relative_path(file);
        if (seen.has(rel))
            return;
        seen.add(rel);
        specifiers.add(rel);
        const text = decoder.decode(file.load_contents(null)[1]);
        for (const [, spec] of text.matchAll(/^import\s+(?:[^'"();]*?\s+from\s+)?['"]([^'"]+)['"]/gm)) {
            if (spec.startsWith('.'))
                visit(file.get_parent().resolve_relative_path(spec));
            else
                specifiers.add(spec);
        }
    };
    visit(EXTENSION_DIR.resolve_relative_path(path));
    return specifiers;
}

function lazyLibsecretTests(t) {
    t.eq([SECRET_TODOIST, SECRET_ANTHROPIC], ['todoist-token', 'anthropic-key'], 'core/secretNames.js: the secret item names');
    t.check(!_schemaCreated(), 'importing services/secrets.js makes no libsecret schema');
    const app = staticImportClosure('extension.js');
    t.check(app.has('ui/app.js') && app.has('brain.js') && app.has('core/secretNames.js') && app.has('gi://Shell'),
        'the import walk follows extension.js into the app, the brain and the Shell libraries');
    for (const entry of ['extension.js', 'brain.js', 'prefs.js']) {
        const closure = staticImportClosure(entry);
        t.check(!closure.has('gi://Secret') && !closure.has('services/secrets.js'),
            `${entry} does not import libsecret or services/secrets.js, not even through another file`);
    }
    t.check(staticImportClosure('services/secrets.js').has('gi://Secret'), 'only services/secrets.js does');
}

async function secretsTests(t) {
    lazyLibsecretTests(t);
    t.eq(secretSchema().name, 'org.gnome.shell.extensions.todopet.Secret', 'the secret schema id');
    t.check(_schemaCreated() && secretSchema() === secretSchema(), 'the schema is made once, on first use');

    await t.rejects(storeSecret('', 'x'), e => e instanceof TypeError, 'storeSecret refuses an empty item name');
    await t.rejects(storeSecret('test-item', ''), e => e instanceof TypeError, 'and an empty secret (clearSecret is for that)');
    await t.rejects(lookupSecret(5), e => e instanceof TypeError, 'lookupSecret refuses an item that is not a name');

    if (!await secretServiceReady()) {
        t.check(true, 'secrets skipped: no Secret Service');
        return;
    }
    try {
        t.eq(await lookupSecret('test-item'), null, 'a secret that was never stored looks up as null');
        await storeSecret('test-item', 'first-value é“');
        t.eq(await lookupSecret('test-item'), 'first-value é“', 'a stored secret looks up again');
        await storeSecret('test-item', 'second-value');
        t.eq(await lookupSecret('test-item'), 'second-value', 'storing again replaces the value');

        const found = await Secret.password_search(secretSchema(), {item: 'test-item'}, Secret.SearchFlags.ALL, null);
        t.check(found.length === 1 && found[0].get_label() === 'TodoPet: test-item'
            && found[0].get_attributes().item === 'test-item', 'one keyring item, labelled "TodoPet: ...", with the attribute item');
        t.eq(await lookupSecret('test-item-other'), null, 'other items are separate');

        await clearSecret('test-item');
        t.eq(await lookupSecret('test-item'), null, 'a cleared secret is gone');
        await clearSecret('test-item');
        t.check(true, 'clearing a secret that is not there is fine');
    } finally {
        await clearSecret('test-item').catch(() => {});
    }
}
