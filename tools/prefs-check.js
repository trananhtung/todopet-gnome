// Builds the settings window (build/<uuid>/prefs.js) the way GNOME's Extensions app does, on a throw-away GTK Broadway
// display (no window ever reaches a real screen) and checks it: every page and its rows, the bindings, the language
// switch, the work-hour limits, the secrets (an in-memory stub, never the keyring), the Developer buttons, the shortcut
// row and its capture dialog, `prefs:<page>`.
//
//   make build && gjs -m tools/prefs-check.js
//
// It needs gtk4-broadwayd and the Extensions app's resources (/usr/share/gnome-shell). The nested-shell scenes
// (`tools/nested.sh prefs:Day`) show the same window in a real GNOME Shell session; this checks what a picture cannot.
// Exit 0: every check passed.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';

import {T} from '../tests/harness.js';

const UUID = 'todopet@trananhtung.github.io';
const SHELL_DATADIR = GLib.getenv('GNOME_SHELL_DATADIR') || '/usr/share/gnome-shell';

const root = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent();
const buildDir = root.resolve_relative_path(`build/${UUID}`);

const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

async function until(done, ms = 3000) {
    for (let waited = 0; waited < ms; waited += 50) {
        if (done())
            return true;
        await sleep(50);
    }
    return done();
}

function fail(message) {
    console.error(`prefs-check: ${message}`);
    System.exit(1);
}

if (!buildDir.get_child('schemas').get_child('gschemas.compiled').query_exists(null))
    fail(`${buildDir.get_path()} has no compiled schema: run 'make build' first`);
if (!GLib.find_program_in_path('gtk4-broadwayd'))
    fail('gtk4-broadwayd is not installed');

// --- The environment: nothing here may reach the user's session, settings or keyring ---

const dataDir = GLib.dir_make_tmp('todopet-prefs-check-XXXXXX');
GLib.setenv('GSETTINGS_BACKEND', 'memory', true);
GLib.setenv('TODOPET_NO_SECRETS', '1', true);
GLib.setenv('TODOPET_DATA_DIR', dataDir, true);
const display = `:${20 + GLib.random_int_range(0, 900)}`;
const broadwayd = Gio.Subprocess.new(['gtk4-broadwayd', display], Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
const socket = Gio.File.new_for_path(`${GLib.get_user_runtime_dir()}/broadway${display.slice(1)}.socket`);
for (let i = 0; i < 100 && !socket.query_exists(null); i++)
    await sleep(50);
GLib.setenv('GDK_BACKEND', 'broadway', true);
GLib.setenv('BROADWAY_DISPLAY', display, true);

// The Extensions app's own modules (ExtensionPreferences) and the Shew typelib it needs.
globalThis.imports.package.init({name: 'gnome-shell', prefix: '/usr', libdir: '/usr/lib'});
Gio.Resource.load(`${SHELL_DATADIR}/org.gnome.Shell.Extensions.src.gresource`)._register();

const t = new T();
let status = 1;
try {
    status = await check(t);
} catch (e) {
    t.fail('the check ran without throwing', e?.stack ?? e);
} finally {
    broadwayd.force_exit();
    GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(dataDir)}`);
}
if (t.failures === 0 && status === 0)
    print('All good 🎉');
System.exit(t.failures === 0 && status === 0 ? 0 : 1);

// --- The checks ---

async function check(t) {
    const Adw = (await import('gi://Adw?version=1')).default;
    const Gdk = (await import('gi://Gdk?version=4.0')).default;
    const Gtk = (await import('gi://Gtk?version=4.0')).default;
    Adw.init();

    // The build's own modules, so that the language the window sets is the one read here (a module is one instance per URL).
    const load = path => import(buildDir.resolve_relative_path(path).get_uri());
    const {L, getLang, setLang} = await load('core/l10n.js');
    const {PAGE_NAMES, developerTriggers, rowCount, settingsPages} = await load('core/settingsSpec.js');
    const {hasSpeech} = await load('services/speech.js');
    const PrefsClass = (await load('prefs.js')).default;
    const metadata = JSON.parse(new TextDecoder().decode(buildDir.get_child('metadata.json').load_contents(null)[1]));

    // A new window filled like ExtensionPrefsDialog does it. `initial` are settings written before the window is built.
    const settings = new PrefsClass({...metadata, dir: buildDir, path: buildDir.get_path()}).getSettings();
    async function open(initial = {}) {
        for (const key of settings.settings_schema.list_keys())
            settings.reset(key);
        setLang('en');
        for (const [key, value] of Object.entries(initial))
            settings.set_value(key, value);
        const window = new Adw.PreferencesWindow({search_enabled: false});
        const prefs = new PrefsClass({...metadata, dir: buildDir, path: buildDir.get_path()});
        await prefs.fillPreferencesWindow(window);
        return {window, ui: window._todopet, prefs};
    }
    const walk = (widget, fn) => {
        for (let c = widget.get_first_child(); c; c = c.get_next_sibling()) {
            fn(c);
            walk(c, fn);
        }
    };
    const rowsOf = page => {
        const rows = [];
        walk(page, w => w instanceof Adw.PreferencesRow && rows.push(w));
        return rows;
    };
    const descendants = (widget, type) => {
        const found = [];
        walk(widget, w => w instanceof type && found.push(w));
        return found;
    };
    const page = (ui, name) => ui._pages.find(p => p.name === name);
    const row = (ui, name, title) => rowsOf(page(ui, name)).find(r => r.title === title);
    const button = widget => descendants(widget, Gtk.Button)[0];

    // --- Every page, every row ---
    {
        const {window, ui} = await open();
        const specs = settingsPages();
        t.eq(ui._pages.map(p => p.name), [...PAGE_NAMES], 'the window has the nine pages in order');
        t.eq(window.get_visible_page()?.name, 'General', 'it opens on General');
        for (const spec of specs) {
            const p = page(ui, spec.name);
            t.eq([p.title, p.icon_name], [spec.title, spec.icon], `${spec.name}: title and icon`);
            t.eq(rowsOf(p).length, rowCount(spec), `${spec.name}: ${rowCount(spec)} rows`);
        }
        t.eq(specs.map(rowCount).reduce((a, b) => a + b, 0), 51, 'in all 51 rows');

        // Defaults reach the widgets.
        const day = 'Day';
        t.eq(row(ui, day, 'Work starts').get_text(), '08:00', 'work starts reads 08:00');
        t.eq(row(ui, day, 'Work ends').get_text(), '18:00', 'work ends reads 18:00');
        t.eq(row(ui, day, 'Plan by').get_text(), '10:00', 'plan by reads 10:00');
        t.eq(row(ui, day, 'Tasks to plan each day').get_value(), 3, 'daily target 3');
        t.eq(row(ui, day, 'Nudge every').get_value(), 45, 'nudge every 45');
        t.eq(row(ui, 'General', 'Pet name').get_text(), 'Mochi', 'pet name Mochi');
        const scale = descendants(row(ui, 'General', 'Size'), Gtk.Scale)[0];
        t.near(scale.get_value(), 1.0, 1e-9, 'size 1.0');
        t.eq([scale.adjustment.lower, scale.adjustment.upper], [0.7, 1.6], 'size runs 0.7 to 1.6');
        t.eq(row(ui, 'General', 'Sounds').selected, 1, 'sounds: Important only');
        t.eq(row(ui, 'Distractions', 'Distracting websites').sensitive, true, 'sites follow the watch switch (on)');
        window.close();
    }

    // --- Rows write the settings ---
    {
        const {window, ui} = await open();
        row(ui, 'General', 'Pet name').set_text('Bánh');
        t.eq(settings.get_string('pet-name'), 'Bánh', 'typing a pet name writes pet-name');
        row(ui, 'General', 'Chase the mouse cursor when grumpy').set_active(false);
        t.eq(settings.get_boolean('chase-when-angry'), false, 'a switch writes its key');
        row(ui, 'Day', 'Nudge every').set_value(60);
        t.eq(settings.get_int('remind-every'), 60, 'a spin row writes its key');
        row(ui, 'General', 'Sounds').set_selected(2);
        t.eq(settings.get_string('sound-mode'), 'all', 'the sounds combo writes the choice');
        settings.set_string('sound-mode', 'off');
        t.eq(row(ui, 'General', 'Sounds').selected, 0, 'and follows the setting');
        descendants(row(ui, 'General', 'Size'), Gtk.Scale)[0].set_value(1.3);
        t.near(settings.get_double('pet-scale'), 1.3, 1e-9, 'the size slider writes pet-scale');
        settings.set_boolean('watch-browsers', false);
        t.eq(row(ui, 'Distractions', 'Distracting websites').sensitive, false, 'the sites row follows the watch switch (off)');
        settings.set_boolean('use-calendar', false);
        t.eq(row(ui, 'Calendar', 'Remind before meetings').sensitive, false, 'the meeting lead follows use-calendar');
        window.close();
    }

    // --- The work hours limit each other (Swift's steppers) ---
    {
        const {window, ui} = await open();
        const start = row(ui, 'Day', 'Work starts');
        const end = row(ui, 'Day', 'Work ends');
        const plan = row(ui, 'Day', 'Plan by');
        const range = r => [r.adjustment.lower, r.adjustment.upper];
        t.eq([range(start), range(end), range(plan)], [[0, 17], [9, 24], [8, 18]], 'limits at the defaults (8-18)');
        end.set_value(12);
        t.eq([settings.get_int('work-end'), range(start), range(plan)], [12, [0, 11], [8, 12]], 'work ends at 12: start up to 11, plan by 8 to 12');
        start.set_value(11);
        t.eq([range(end), range(plan), plan.get_value()], [[12, 24], [11, 12], 11], 'work starts at 11: end from 12, plan by 11 to 12, the plan hour follows');
        t.eq(start.get_text(), '11:00', 'the hour shows as 11:00');
        window.close();
    }

    // --- Language: the labels follow the setting ---
    {
        const {window, ui} = await open();
        window.set_visible_page_name('Calendar');
        settings.set_string('lang', 'vi');
        t.check(await until(() => ui._pages[0].title === 'Chung'), 'lang vi: the pages are built again in Vietnamese');
        t.eq([ui._pages.map(p => p.name).join(), getLang()], [PAGE_NAMES.join(), 'vi'], 'the page names stay; L() is Vietnamese');
        t.eq(window.get_visible_page()?.name, 'Calendar', 'the page you were on stays visible');
        t.eq(row(ui, 'General', 'Tên pet')?.get_text(), 'Mochi', 'a Vietnamese row is bound too');
        t.eq(ui._pages.reduce((n, p) => n + rowsOf(p).length, 0), 51, 'still 51 rows after the rebuild');
        settings.set_string('lang', 'en');
        t.check(await until(() => ui._pages[0].title === 'General'), 'lang en: back to English');
        window.close();
    }

    // --- Secrets: the stub, never shown, serial bumped ---
    {
        const {window, ui} = await open();
        const entry = row(ui, 'Todoist', 'API token');
        const status = row(ui, 'Todoist', 'Connected');
        t.eq([status.visible, entry.show_apply_button], [false, true], 'no token yet: no Connected row; the entry has an apply button');
        await sleep(100);
        entry.set_text('  secret-token  ');
        entry.emit('apply');
        t.check(await until(() => status.visible), 'after apply the Connected row shows');
        t.eq([settings.get_int('secrets-serial'), entry.get_text(), entry.title], [1, '', 'New token (optional)'],
            'secrets-serial is 1, the entry is empty again, its title says "new"');
        t.eq(await (await ui._secretsApi()).lookup('todoist'), 'secret-token', 'the stub holds the trimmed token');
        entry.set_text('   ');
        entry.emit('apply');
        await sleep(100);
        t.eq(settings.get_int('secrets-serial'), 1, 'a blank token is ignored');
        button(status).emit('clicked');
        t.check(await until(() => !status.visible), 'Disconnect hides the Connected row');
        t.eq([settings.get_int('secrets-serial'), entry.title, await (await ui._secretsApi()).lookup('todoist')], [2, 'API token', null],
            'secrets-serial is 2, the token is gone');

        const key = row(ui, 'Postponed', 'Claude API key (optional)');
        key.set_text('sk-ant-123');
        key.emit('apply');
        t.check(await until(() => row(ui, 'Postponed', 'Claude API key saved').visible), 'the Claude key shows its saved row');
        t.eq(settings.get_int('secrets-serial'), 3, 'and bumps secrets-serial');
        button(row(ui, 'Postponed', 'Claude API key saved')).emit('clicked');
        t.check(await until(() => !row(ui, 'Postponed', 'Claude API key saved').visible), 'Remove key hides it');
        t.eq(settings.get_int('secrets-serial'), 4, 'secrets-serial is 4');
        window.close();
    }

    // --- Developer: the buttons write dev-trigger ---
    {
        const {window, ui} = await open();
        for (const trigger of developerTriggers()) {
            settings.set_string('dev-trigger', '');
            button(row(ui, 'Developer', trigger.title)).emit('clicked');
            t.eq(settings.get_string('dev-trigger'), trigger.value, `Developer: ${trigger.title} writes '${trigger.value}'`);
        }
        row(ui, 'Developer', 'Demo mode').set_active(true);
        t.eq(settings.get_boolean('demo-mode'), true, 'the demo switch writes demo-mode');
        window.close();
    }

    // --- The diary folder: nothing is made ---
    {
        const {window, ui} = await open();
        const toasts = [];
        window.add_toast = toast => toasts.push(toast.title);
        button(row(ui, 'Diary', 'Open diary folder')).emit('clicked');
        t.eq([toasts, GLib.file_test(`${dataDir}/log`, GLib.FileTest.EXISTS)], [['There is no diary yet'], false],
            'no diary folder: a message, and the folder is not created');
        window.close();
    }

    // --- Voice and Join links ---
    {
        const {window, ui} = await open();
        const test = row(ui, 'General', 'Test voice');
        t.eq(test.visible, false, 'the Test voice row is hidden while the voice is off');
        settings.set_boolean('voice-on', true);
        t.eq(test.visible, hasSpeech(), `the Test voice row ${hasSpeech() ? 'shows' : 'stays hidden (no spd-say)'} once it is on`);
        t.eq(row(ui, 'General', 'Pet speaks out loud').sensitive, hasSpeech(), 'the voice switch is disabled without spd-say');
        let ecal = true;
        try {
            await import('gi://ECal?version=2.0');
        } catch {
            ecal = false;
        }
        const join = rowsOf(page(ui, 'Calendar')).find(r => r.title.startsWith('Join links'));
        t.check(await until(() => join.title !== 'Join links'), 'the Join-link row is filled in');
        t.eq([join.title, join.subtitle], ecal ? ['Join links: on', ''] : ['Join links: off', 'install gir1.2-ecal-2.0 for Join links'],
            `ECal is ${ecal ? 'installed: on' : 'missing: the package to install'}`);
        window.close();
    }

    // --- The board shortcut ---
    {
        const {window, ui} = await open();
        window.present();
        const shortcut = row(ui, 'Shortcut', 'Open the task board');
        const [set, reset] = descendants(shortcut, Gtk.Button);
        t.eq([shortcut.subtitle, reset.sensitive], ['Ctrl+Super+T', false], 'the default shows Ctrl+Super+T; Reset is off');
        settings.set_strv('board-hotkey', ['<Alt>F9']);
        t.eq([shortcut.subtitle, reset.sensitive], ['Alt+F9', true], 'a change shows; Reset turns on');
        reset.emit('clicked');
        t.eq(settings.get_strv('board-hotkey'), ['<Control><Super>t'], 'Reset goes back to the default');
        settings.set_strv('board-hotkey', []);
        t.eq(shortcut.subtitle, 'Disabled', 'no shortcut reads Disabled');
        settings.reset('board-hotkey');

        // The capture dialog: press keys the way GTK would deliver them.
        const press = (dialog, keyval, state = 0) => {
            const controllers = dialog.observe_controllers();
            for (let i = 0; i < controllers.get_n_items(); i++) {
                const controller = controllers.get_item(i);
                if (controller instanceof Gtk.EventControllerKey)
                    return controller.emit('key-pressed', keyval, 0, state);
            }
            throw new Error('the capture dialog has no key controller');
        };
        const opened = async () => {
            set.emit('clicked');
            await until(() => window.get_visible_dialog() !== null, 1000);
            return window.get_visible_dialog();
        };
        const captured = async (keyval, state) => {
            const dialog = await opened();
            if (!dialog)
                return null;
            press(dialog, keyval, state);
            await until(() => window.get_visible_dialog() === null, 1500);
            return dialog;
        };
        const CTRL = Gdk.ModifierType.CONTROL_MASK;
        const SUPER = Gdk.ModifierType.SUPER_MASK;
        let dialog = await captured(Gdk.KEY_k, CTRL | SUPER);
        t.check(dialog !== null, 'Set… opens the capture dialog');
        t.eq(settings.get_strv('board-hotkey'), ['<Control><Super>k'], 'Ctrl+Super+K is taken');
        t.eq(window.get_visible_dialog(), null, 'and the dialog closes');
        await captured(Gdk.KEY_K, CTRL | Gdk.ModifierType.SHIFT_MASK);
        t.eq(settings.get_strv('board-hotkey'), ['<Shift><Control>k'], 'a capital K counts as the key k with Shift');

        dialog = await opened();
        press(dialog, Gdk.KEY_Control_L, CTRL);
        t.check(window.get_visible_dialog() !== null, 'a held Control keeps the dialog waiting');
        press(dialog, Gdk.KEY_t, 0);
        t.check(window.get_visible_dialog() !== null && settings.get_strv('board-hotkey')[0] === '<Shift><Control>k', 'a bare letter is refused');
        t.check(dialog.get_body().includes('Ctrl, Alt or Super'), 'and the dialog says why');
        press(dialog, Gdk.KEY_Escape, 0);
        await until(() => window.get_visible_dialog() === null, 1500);
        t.eq([window.get_visible_dialog(), settings.get_strv('board-hotkey')], [null, ['<Shift><Control>k']], 'Escape closes it and changes nothing');

        await captured(Gdk.KEY_BackSpace, 0);
        t.eq([settings.get_strv('board-hotkey'), shortcut.subtitle, window.get_visible_dialog()], [[], 'Disabled', null], 'Backspace turns the shortcut off');
        window.close();
    }

    // --- prefs:<page> from the dev scenes ---
    {
        const {window} = await open({'dev-trigger': new GLib.Variant('s', 'prefs:Calendar')});
        t.eq([window.get_visible_page()?.name, settings.get_string('dev-trigger')], ['Calendar', ''], 'prefs:Calendar shows the Calendar page and resets the key');
        window.close();
        const again = await open({'dev-trigger': new GLib.Variant('s', 'prefs:Nowhere')});
        t.eq([again.window.get_visible_page()?.name, settings.get_string('dev-trigger')], ['General', ''], 'an unknown page is ignored, the key is reset');
        again.window.close();
        const end = await open({'dev-trigger': new GLib.Variant('s', 'prefs:Day:end')});
        t.eq([end.window.get_visible_page()?.name, settings.get_string('dev-trigger')], ['Day', ''], 'prefs:Day:end shows Day');
        end.window.close();
        const plain = await open({'dev-trigger': new GLib.Variant('s', 'parade')});
        t.eq([plain.window.get_visible_page()?.name, settings.get_string('dev-trigger')], ['General', 'parade'], 'another command is not touched');
        plain.window.close();
    }

    t.eq(L('vi', 'en'), 'en', 'the language is English again at the end');
    return 0;
}
