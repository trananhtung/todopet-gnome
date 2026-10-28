// The Settings window (port of SettingsView.swift). GNOME opens it from the Extensions app or from the top bar menu
// (`openPreferences()`), in its own gjs process (org.gnome.Shell.Extensions): nothing here runs inside GNOME Shell.
// core/settingsSpec.js says which pages and rows there are; this file draws them with libadwaita and binds each row
// to the extension's Gio.Settings. The extension reacts to every setting by itself, so the window only writes.
//
// - A language change rebuilds the pages in place (one idle later), so the labels follow at once.
// - The Todoist token and the Claude key go to the keyring and are never shown; the rows show "saved" and a Remove
//   button. After a change `secrets-serial` is incremented, and the extension reads the keyring again. With
//   TODOPET_NO_SECRETS=1 (the nested test shell) an in-memory stub replaces the keyring.
// - `dev-trigger` = 'prefs:<page>' (set by the dev scenes) opens that page ('prefs:<page>:end' scrolls it to the end);
//   the window resets the key.
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {L, getLang, setLang} from './core/l10n.js';
import {SECRET_ANTHROPIC, SECRET_TODOIST} from './core/secretNames.js';
import {
    SPEECH_TEST_LINE, captureMessage, captureStep, hourLimits, hourText, joinLinksStatus, percentText, settingsPages,
} from './core/settingsSpec.js';
import {hasSpeech, speak} from './services/speech.js';
import {dataDir} from './services/store.js';
import {hotkeyLabel} from './ui/boardLogic.js';

const BIND = Gio.SettingsBindFlags;

// Row and group titles, subtitles and descriptions are Pango markup in libadwaita; ours are plain text.
const esc = text => GLib.markup_escape_text(text, -1);

// --- Secrets: the keyring, or a stub in memory for the nested test shell ---

function memorySecrets() {
    const values = new Map();
    return {
        items: {todoist: 'todoist', claude: 'claude'},
        lookup: async item => values.get(item) ?? null,
        store: async (item, value) => void values.set(item, value),
        clear: async item => void values.delete(item),
    };
}

// services/secrets.js needs libsecret; it is imported on first use, so a missing typelib breaks only the two secret rows.
async function keyringSecrets() {
    const secrets = await import('./services/secrets.js');
    return {
        items: {todoist: SECRET_TODOIST, claude: SECRET_ANTHROPIC},
        lookup: secrets.lookupSecret,
        store: secrets.storeSecret,
        clear: secrets.clearSecret,
    };
}

// True when gir1.2-ecal-2.0 (Evolution Data Server) is installed: the extension then finds Join links.
async function hasEcal() {
    try {
        await import('gi://ECal?version=2.0');
        return true;
    } catch {
        return false;
    }
}

// The first widget of `type` below `widget` (depth first).
function findDescendant(widget, type) {
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) {
        if (child instanceof type)
            return child;
        const found = findDescendant(child, type);
        if (found)
            return found;
    }
    return null;
}

class SettingsWindow {
    constructor(window, settings) {
        this._window = window;
        this._settings = settings;
        this._pages = [];
        this._build = null; // what belongs to the pages on screen: {dead, ids, limitRows, secretRows}
        this._langId = 0;
        this._rebuildSource = 0;
        this._scrollSource = 0;
        this._focusSource = 0;
        this._secrets = null; // Promise of the secrets API, made on first use
        this._ecal = null; // Promise<boolean>
    }

    start() {
        this._langId = this._settings.connect('changed::lang', () => this._scheduleRebuild());
        this._window.connect('close-request', () => {
            this._close();
            return false;
        });
        this._buildPages();
    }

    _close() {
        if (this._rebuildSource !== 0)
            GLib.source_remove(this._rebuildSource);
        this._rebuildSource = 0;
        for (const source of [this._scrollSource, this._focusSource]) {
            if (source !== 0)
                GLib.source_remove(source);
        }
        this._scrollSource = 0;
        this._focusSource = 0;
        if (this._langId !== 0)
            this._settings.disconnect(this._langId);
        this._langId = 0;
        this._endBuild();
    }

    _endBuild() {
        if (!this._build)
            return;
        this._build.dead = true;
        for (const id of this._build.ids)
            this._settings.disconnect(id);
        this._build = null;
    }

    // --- Pages ---

    _buildPages() {
        setLang(this._settings.get_string('lang'));
        this._build = {dead: false, ids: [], limitRows: [], secretRows: new Map()};
        for (const spec of settingsPages()) {
            const page = new Adw.PreferencesPage({name: spec.name, title: spec.title, icon_name: spec.icon});
            for (const g of spec.groups) {
                const group = new Adw.PreferencesGroup({title: esc(g.title), description: esc(g.description)});
                for (const r of g.rows)
                    group.add(this._row(r));
                page.add(group);
            }
            this._window.add(page);
            this._pages.push(page);
        }
        this._applyLimits();
        const connect = key => this._build.ids.push(this._settings.connect(`changed::${key}`, () => this._applyLimits()));
        connect('work-start');
        connect('work-end');
        this._refreshSecrets();
    }

    _scheduleRebuild() {
        if (this._rebuildSource !== 0)
            return;
        // One idle later: the combo row that changed the language is still closing its popover.
        this._rebuildSource = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._rebuildSource = 0;
            const visible = this._window.get_visible_page()?.name ?? null;
            this._endBuild();
            for (const page of this._pages)
                this._window.remove(page);
            this._pages = [];
            this._buildPages();
            if (visible)
                this._window.set_visible_page_name(visible);
            return GLib.SOURCE_REMOVE;
        });
    }

    // Opens the page named by `dev-trigger` = 'prefs:<page>' and resets the key. 'prefs:<page>:end' also scrolls the page
    // to its last row (the dev scenes shoot the pages that do not fit the window twice).
    showRequestedPage() {
        const value = this._settings.get_string('dev-trigger');
        if (!value.startsWith('prefs:'))
            return;
        const [, name, where] = value.split(':');
        const page = this._pages.find(p => p.name === name);
        if (page) {
            this._window.set_visible_page_name(name);
            // The window is shown right after this. Without this the key focus would land in the page's first text
            // field (selected, with a focus ring).
            this._focusSource = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._focusSource = 0;
                this._window.set_focus(null);
                return GLib.SOURCE_REMOVE;
            });
            if (where === 'end')
                this._scrollToEnd(page);
        }
        this._settings.set_string('dev-trigger', '');
    }

    // Once the window has its size (the page is scrolled where it can be).
    _scrollToEnd(page) {
        this._scrollSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            this._scrollSource = 0;
            const scrolled = findDescendant(page, Gtk.ScrolledWindow);
            if (scrolled)
                scrolled.vadjustment.value = scrolled.vadjustment.upper - scrolled.vadjustment.page_size;
            return GLib.SOURCE_REMOVE;
        });
    }

    // --- Rows ---

    _row(r) {
        switch (r.kind) {
        case 'combo': return this._comboRow(r);
        case 'entry': return this._entryRow(r);
        case 'switch': return this._switchRow(r);
        case 'spin': return this._spinRow(r);
        case 'scale': return this._scaleRow(r);
        case 'secret': return r.status ? this._secretStatusRow(r) : this._secretEntryRow(r);
        case 'link': return this._linkRow(r);
        case 'action': return this._actionRow(r);
        case 'shortcut': return this._shortcutRow(r);
        case 'status': return this._joinLinksRow(r);
        case 'trigger': return this._triggerRow(r);
        default: throw new Error(`Unknown settings row '${r.kind}'`);
        }
    }

    _bind(key, widget, property, flags = BIND.DEFAULT) {
        this._settings.bind(key, widget, property, flags);
    }

    _comboRow(r) {
        const row = new Adw.ComboRow({
            title: esc(r.title), subtitle: esc(r.subtitle ?? ''),
            model: Gtk.StringList.new(r.choices.map(choice => choice.label)),
        });
        let syncing = false;
        const show = () => {
            const index = r.choices.findIndex(choice => choice.value === this._settings.get_string(r.key));
            syncing = true;
            row.selected = Math.max(0, index);
            syncing = false;
        };
        show();
        row.connect('notify::selected', () => {
            const choice = r.choices[row.selected];
            if (!syncing && choice && choice.value !== this._settings.get_string(r.key))
                this._settings.set_string(r.key, choice.value);
        });
        this._build.ids.push(this._settings.connect(`changed::${r.key}`, show));
        return row;
    }

    _entryRow(r) {
        const row = new Adw.EntryRow({title: esc(r.title)});
        this._bind(r.key, row, 'text');
        if (r.enabledBy)
            this._bind(r.enabledBy, row, 'sensitive', BIND.GET);
        return row;
    }

    _switchRow(r) {
        const row = new Adw.SwitchRow({title: esc(r.title), subtitle: esc(r.subtitle ?? '')});
        this._bind(r.key, row, 'active');
        if (r.needs === 'speech' && !hasSpeech()) {
            row.sensitive = false;
            row.subtitle = esc(r.unavailable);
        }
        return row;
    }

    _spinRow(r) {
        const row = new Adw.SpinRow({
            // A numeric spin button refuses "08:00" as its text.
            title: esc(r.title), subtitle: esc(r.subtitle ?? ''), numeric: !r.hours,
            adjustment: new Gtk.Adjustment({
                lower: r.min, upper: r.max, step_increment: r.step, page_increment: r.step, value: r.min,
            }),
        });
        if (r.hours) {
            // "08:00" like Swift. Typing a plain number still works.
            row.connect('output', () => {
                row.set_text(hourText(row.get_value()));
                return true;
            });
        }
        if (r.limits)
            this._build.limitRows.push({row, which: r.limits});
        this._bind(r.key, row, 'value');
        if (r.enabledBy)
            this._bind(r.enabledBy, row, 'sensitive', BIND.GET);
        return row;
    }

    // Swift's work-hour steppers limit each other. Re-set whenever the start or the end changes.
    _applyLimits() {
        if (!this._build || this._build.applying)
            return;
        this._build.applying = true;
        try {
            const values = {workStart: this._settings.get_int('work-start'), workEnd: this._settings.get_int('work-end')};
            for (const {row, which} of this._build.limitRows) {
                const [lower, upper] = hourLimits(which, values);
                const a = row.adjustment;
                a.configure(Math.min(Math.max(a.value, lower), upper), lower, upper, a.step_increment, a.page_increment, 0);
            }
        } finally {
            this._build.applying = false;
        }
    }

    // The pet's size: a slider from 70 % to 160 % like Swift's.
    _scaleRow(r) {
        const row = new Adw.ActionRow({title: esc(r.title)});
        const scale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL, draw_value: true, value_pos: Gtk.PositionType.RIGHT, digits: 1,
            hexpand: true, valign: Gtk.Align.CENTER, width_request: 260,
            adjustment: new Gtk.Adjustment({lower: r.min, upper: r.max, step_increment: r.step, page_increment: r.step, value: r.min}),
        });
        scale.set_format_value_func((_scale, value) => percentText(value));
        scale.update_property([Gtk.AccessibleProperty.LABEL], [r.title]);
        row.add_suffix(scale);
        this._bind(r.key, scale.adjustment, 'value');
        return row;
    }

    // --- Secrets ---

    _secretsApi() {
        this._secrets ??= GLib.getenv('TODOPET_NO_SECRETS') === '1' ? Promise.resolve(memorySecrets()) : keyringSecrets();
        return this._secrets;
    }

    _secretStatusRow(r) {
        const row = new Adw.ActionRow({title: esc(r.title), visible: false});
        row.add_prefix(new Gtk.Image({icon_name: 'emblem-ok-symbolic', css_classes: ['success']}));
        const button = new Gtk.Button({label: r.button, valign: Gtk.Align.CENTER, css_classes: ['destructive-action']});
        button.connect('clicked', () => this._removeSecret(r.secret));
        row.add_suffix(button);
        this._secretRows(r.secret).status = row;
        return row;
    }

    _secretEntryRow(r) {
        const row = new Adw.PasswordEntryRow({title: esc(r.title), show_apply_button: true});
        row.connect('apply', () => this._saveSecret(r.secret, row));
        Object.assign(this._secretRows(r.secret), {entry: row, titles: [r.title, r.titleSaved]});
        return row;
    }

    _secretRows(secret) {
        if (!this._build.secretRows.has(secret))
            this._build.secretRows.set(secret, {status: null, entry: null, titles: null});
        return this._build.secretRows.get(secret);
    }

    // Shows "saved" (the status row, "new ..." on the entry) for each secret that is in the keyring. Never reads it out.
    async _refreshSecrets() {
        const build = this._build;
        if (!build)
            return;
        for (const [secret, rows] of build.secretRows) {
            let saved = false;
            let failure = null;
            try {
                const api = await this._secretsApi();
                saved = Boolean(await api.lookup(api.items[secret]));
            } catch (e) {
                failure = e;
                console.warn(`TodoPet prefs: could not read the ${secret} secret: ${e?.message ?? e}`);
            }
            if (build.dead)
                return;
            rows.status.visible = saved;
            rows.entry.title = esc(rows.titles[saved ? 1 : 0]);
            rows.entry.sensitive = failure === null;
            rows.entry.tooltip_text = failure ? L('Không mở được GNOME Keyring', 'GNOME Keyring is not available') : null;
        }
    }

    async _saveSecret(secret, entry) {
        const value = entry.get_text().trim();
        if (value === '')
            return;
        try {
            const api = await this._secretsApi();
            await api.store(api.items[secret], value);
            entry.set_text('');
            this._bumpSecretsSerial();
            this._toast(secret === 'todoist'
                ? L('Đã lưu token. TodoPet sẽ kết nối ngay.', 'Token saved. TodoPet will connect now.')
                : L('Đã lưu key.', 'Key saved.'));
        } catch (e) {
            console.error(`TodoPet prefs: could not save the ${secret} secret: ${e?.message ?? e}`);
            this._toast(L('Không lưu được vào GNOME Keyring', 'Could not save to GNOME Keyring'));
        }
        this._refreshSecrets();
    }

    async _removeSecret(secret) {
        try {
            const api = await this._secretsApi();
            await api.clear(api.items[secret]);
            this._bumpSecretsSerial();
            this._toast(secret === 'todoist' ? L('Đã ngắt kết nối', 'Disconnected') : L('Đã xoá key', 'Key removed'));
        } catch (e) {
            console.error(`TodoPet prefs: could not remove the ${secret} secret: ${e?.message ?? e}`);
            this._toast(L('Không xoá được khỏi GNOME Keyring', 'Could not remove it from GNOME Keyring'));
        }
        this._refreshSecrets();
    }

    // The extension reads the keyring again when this changes.
    _bumpSecretsSerial() {
        this._settings.set_int('secrets-serial', this._settings.get_int('secrets-serial') + 1);
    }

    // --- Buttons and links ---

    _linkRow(r) {
        const row = new Adw.ActionRow({title: esc(r.title), activatable: true});
        row.connect('activated', () => {
            Gtk.show_uri(this._window, r.uri, Gdk.CURRENT_TIME);
        });
        return row;
    }

    _actionRow(r) {
        const row = new Adw.ActionRow({title: esc(r.title)});
        const button = new Gtk.Button({label: r.button, valign: Gtk.Align.CENTER});
        row.add_suffix(button);
        row.activatable_widget = button;
        if (r.id === 'voiceTest') {
            button.connect('clicked', () => speak(L(...SPEECH_TEST_LINE), getLang()));
            row.visible = false;
            if (hasSpeech())
                this._bind(r.showWhen, row, 'visible', BIND.GET);
        } else if (r.id === 'diaryFolder') {
            button.connect('clicked', () => this._openDiaryFolder());
        }
        return row;
    }

    // The diary lives in <data dir>/log. Opening it makes nothing: a folder that is not there yet is only said.
    _openDiaryFolder() {
        const folder = Gio.File.new_for_path(`${dataDir()}/log`);
        if (!folder.query_exists(null)) {
            this._toast(L('Chưa có nhật ký nào', 'There is no diary yet'));
            return;
        }
        try {
            Gio.AppInfo.launch_default_for_uri(folder.get_uri(), null);
        } catch (e) {
            console.error(`TodoPet prefs: could not open the diary folder: ${e?.message ?? e}`);
            this._toast(L('Không mở được thư mục nhật ký', 'Could not open the diary folder'));
        }
    }

    _triggerRow(r) {
        const row = new Adw.ActionRow({title: esc(r.title)});
        const button = new Gtk.Button({label: L('Chạy', 'Play'), valign: Gtk.Align.CENTER});
        // The extension plays the command and sets the key back to '' (so the same button works again).
        button.connect('clicked', () => this._settings.set_string('dev-trigger', r.value));
        row.add_suffix(button);
        row.activatable_widget = button;
        return row;
    }

    _joinLinksRow(r) {
        const row = new Adw.ActionRow({title: esc(r.title)});
        const icon = new Gtk.Image({icon_name: 'content-loading-symbolic'});
        row.add_prefix(icon);
        const build = this._build;
        this._ecal ??= hasEcal();
        this._ecal.then(available => {
            if (build.dead)
                return;
            const status = joinLinksStatus(available);
            row.title = esc(status.title);
            row.subtitle = esc(status.subtitle);
            icon.icon_name = available ? 'emblem-ok-symbolic' : 'dialog-information-symbolic';
            if (available)
                icon.add_css_class('success');
        });
        return row;
    }

    _toast(message) {
        this._window.add_toast(new Adw.Toast({title: message, timeout: 3, use_markup: false}));
    }

    // --- The board shortcut ---

    _shortcutRow(r) {
        const row = new Adw.ActionRow({title: esc(r.title)});
        const set = new Gtk.Button({label: L('Đặt…', 'Set…'), valign: Gtk.Align.CENTER});
        const reset = new Gtk.Button({label: L('Mặc định', 'Reset'), valign: Gtk.Align.CENTER});
        set.connect('clicked', () => this._captureShortcut(r.key));
        reset.connect('clicked', () => this._settings.reset(r.key));
        row.add_suffix(set);
        row.add_suffix(reset);
        const show = () => {
            const accels = this._settings.get_strv(r.key);
            row.subtitle = esc(hotkeyLabel(accels) || L('Đã tắt', 'Disabled'));
            // The schema's default is the one to go back to (settings.reset).
            reset.sensitive = accels.join('\n') !== this._settings.get_default_value(r.key).deepUnpack().join('\n');
        };
        show();
        this._build.ids.push(this._settings.connect(`changed::${r.key}`, show));
        return row;
    }

    // A small dialog that waits for the new shortcut: Escape cancels, Backspace turns the shortcut off, a key with
    // Ctrl, Alt or Super sets it. The window asks the compositor to leave its own shortcuts alone meanwhile (best
    // effort), so the current board shortcut and other Super combinations reach the dialog.
    _captureShortcut(key) {
        const dialog = new Adw.AlertDialog({
            heading: L('Nhấn phím tắt mới', 'Press the new shortcut'),
            body: L('Esc để huỷ, Backspace để tắt phím tắt.', 'Esc cancels, Backspace turns the shortcut off.'),
        });
        dialog.add_response('cancel', L('Huỷ', 'Cancel'));
        dialog.set_close_response('cancel');

        const surface = this._window.get_surface();
        try {
            surface?.inhibit_system_shortcuts?.(null);
        } catch (e) {
            console.warn(`TodoPet prefs: could not inhibit the system shortcuts: ${e?.message ?? e}`);
        }
        dialog.connect('closed', () => {
            try {
                surface?.restore_system_shortcuts?.();
            } catch {
                // The surface is gone with the window.
            }
        });

        const keys = new Gtk.EventControllerKey({propagation_phase: Gtk.PropagationPhase.CAPTURE});
        keys.connect('key-pressed', (_controller, keyval, _keycode, state) => {
            const lower = Gdk.keyval_to_lower(keyval);
            const mask = state & Gtk.accelerator_get_default_mod_mask();
            const step = captureStep({
                key: Gdk.keyval_name(keyval) ?? '',
                accel: Gtk.accelerator_name(lower, mask),
                valid: Gtk.accelerator_valid(lower, mask),
            });
            switch (step.action) {
            case 'cancel':
                dialog.close();
                break;
            case 'clear':
                this._settings.set_strv(key, []);
                dialog.close();
                break;
            case 'accept':
                this._settings.set_strv(key, [step.accel]);
                dialog.close();
                break;
            case 'reject':
                dialog.set_body(captureMessage(step.reason));
                break;
            default:
                break;
            }
            return true;
        });
        dialog.add_controller(keys);
        dialog.present(this._window);
    }
}

export default class TodoPetPrefs extends ExtensionPreferences {
    async fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(780, 760);
        const ui = new SettingsWindow(window, settings);
        window._todopet = ui; // the window keeps it alive; its handlers go when the window closes
        ui.start();
        ui.showRequestedPage();
    }
}
