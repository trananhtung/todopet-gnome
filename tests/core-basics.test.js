import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Emitter} from '../extension/core/emitter.js';
import {L, getLang, pick, setLang, systemLang} from '../extension/core/l10n.js';
import {Prefs} from '../extension/core/prefs.js';

const SCHEMA_ID = 'org.gnome.shell.extensions.todopet';
const UUID = 'todopet@trananhtung.github.io';

// A GSettings object over the compiled schema, backed by memory so the real dconf is never touched.
function memorySettings() {
    const repoRoot = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent();
    const schemaDir = repoRoot.resolve_relative_path(`build/${UUID}/schemas`).get_path();
    const source = Gio.SettingsSchemaSource.new_from_directory(
        schemaDir, Gio.SettingsSchemaSource.get_default(), false);
    const schema = source.lookup(SCHEMA_ID, false);
    const settings = Gio.Settings.new_full(
        schema, Gio.memory_settings_backend_new(), '/org/gnome/shell/extensions/todopet/');
    return {schema, settings};
}

const camel = key => key.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());

// Runs fn with LANGUAGE set to `value` (GLib reads it first), then restores it.
function withLanguage(value, fn) {
    const old = GLib.getenv('LANGUAGE');
    GLib.setenv('LANGUAGE', value, true);
    try {
        return fn();
    } finally {
        if (old === null)
            GLib.unsetenv('LANGUAGE');
        else
            GLib.setenv('LANGUAGE', old, true);
    }
}

export default async function (t) {
    // --- l10n ---
    setLang('en');
    t.eq(L('Xin chào', 'Hello'), 'Hello', 'English strings');
    setLang('vi');
    t.eq(L('Xin chào', 'Hello'), 'Xin chào', 'Vietnamese strings');
    t.eq(getLang(), 'vi', 'getLang returns the language set');
    t.eq(pick([['a', 'A'], ['b', 'B']], () => 0.99), 'b', 'pick uses the random source');
    t.eq(pick([['a', 'A'], ['b', 'B']], () => 0), 'a', 'pick takes the first variant at 0');
    setLang('en');
    t.eq(pick([['a', 'A'], ['b', 'B']], () => 0.99), 'B', 'pick follows the current language');
    t.eq(pick([['a', 'A']], () => 1), 'A', 'pick never indexes past the end');
    t.eq(pick([]), '', 'pick of nothing is empty');
    const sampled = new Set();
    for (let i = 0; i < 200; i++)
        sampled.add(pick([['a', 'A'], ['b', 'B'], ['c', 'C']]));
    t.eq([...sampled].sort(), ['A', 'B', 'C'], 'pick defaults to Math.random');

    t.eq(withLanguage('vi_VN.UTF-8:en_US', systemLang), 'vi', 'systemLang: Vietnamese first');
    t.eq(withLanguage('vi', systemLang), 'vi', 'systemLang: bare vi');
    t.eq(withLanguage('en_US.UTF-8:vi_VN', systemLang), 'en', 'systemLang: only the first language counts');
    t.eq(withLanguage('C', systemLang), 'en', 'systemLang: C locale falls back to en');
    t.eq(withLanguage('fr_FR.UTF-8', systemLang), 'en', 'systemLang: other languages fall back to en');
    setLang('');
    t.check(['en', 'vi'].includes(getLang()), 'setLang of an unknown value follows the system language');
    setLang('fr');
    t.check(['en', 'vi'].includes(getLang()), 'setLang never stores an unsupported language');
    setLang('en');

    // --- Prefs: derived values ---
    const p = Prefs.memory({distractionSites: 'https://www.YouTube.com,  reddit.com/r/funny ,', filterQuery: '  '});
    t.eq(p.siteRules, ['youtube.com', 'reddit.com/r/funny'], 'site rules normalized');
    t.eq(Prefs.memory({distractionSites: 'HTTP://Example.com/a, www.b.org, https://c.io'}).siteRules,
        ['example.com/a', 'b.org', 'c.io'], 'site rules strip each scheme and www prefix');
    t.eq(Prefs.memory({distractionSites: ''}).siteRules, [], 'no site rules');
    t.eq(p.effectiveFilter, 'today | overdue', 'empty filter falls back');
    t.eq(Prefs.memory({filterQuery: ' p1 & today '}).effectiveFilter, 'p1 & today', 'filter is trimmed');
    t.eq(Prefs.memory({distractionApps: 'TikTok, , Steam'}).distractionList, ['tiktok', 'steam'], 'app list lowercased');
    t.eq(Prefs.memory().distractionList, ['tiktok', 'netflix', 'steam', 'facebook'], 'default app list');
    t.check(!p.isWorkday(new Date(2026, 9, 25)) && p.isWorkday(new Date(2026, 9, 26)), 'Sunday off, Monday on');
    t.check(!p.isWorkday(new Date(2026, 9, 24)), 'Saturday off by default');
    t.check(Prefs.memory({workSaturday: true}).isWorkday(new Date(2026, 9, 24)), 'Saturday on when enabled');
    t.check(Prefs.memory({workSunday: true}).isWorkday(new Date(2026, 9, 25)), 'Sunday on when enabled');
    t.check(Prefs.memory().isWorkday(new Date(2026, 9, 28)), 'Wednesday is always a workday');
    t.eq(Prefs.memory({claudeModel: ' '}).effectiveClaudeModel, 'claude-opus-5-5', 'default Claude model');
    t.eq(Prefs.memory({claudeModel: ' claude-x '}).effectiveClaudeModel, 'claude-x', 'custom Claude model is trimmed');
    setLang('vi');
    t.eq(Prefs.memory({lang: 'en'}).effectiveLang, 'en', 'explicit language wins');
    t.eq(Prefs.memory({lang: 'vi'}).effectiveLang, 'vi', 'explicit Vietnamese wins');
    t.eq(withLanguage('vi_VN.UTF-8', () => Prefs.memory({lang: ''}).effectiveLang), 'vi', 'empty language follows a Vietnamese system');
    t.eq(withLanguage('en_US.UTF-8', () => Prefs.memory({lang: ''}).effectiveLang), 'en', 'empty language follows an English system');
    t.eq(withLanguage('en_US.UTF-8', () => Prefs.memory({lang: 'fr'}).effectiveLang), 'en', 'unsupported language follows the system');
    setLang('en');

    // --- Prefs: memory behaviour ---
    const m = Prefs.memory({dailyTarget: 5});
    t.eq([m.dailyTarget, m.petName, m.petScale, m.soundMode], [5, 'Mochi', 1.0, 'important'], 'overrides win, defaults fill the rest');
    t.eq(m.boardHotkey, ['<Control><Super>t'], 'default board hotkey');
    t.eq(m.devScenes, [], 'no dev scenes by default');
    const hotkey = m.boardHotkey;
    hotkey.push('x');
    t.eq(m.boardHotkey, ['<Control><Super>t'], 'array values are copies');
    let threw = false;
    try {
        Prefs.memory({noSuchPref: 1});
    } catch {
        threw = true;
    }
    t.check(threw, 'an unknown override name throws');
    t.eq(Prefs.memory().firstLaunch, 0, 'firstLaunch starts unset');

    const seen = [];
    const id = m.onChanged(name => seen.push(name));
    m.hiddenUntil = 123;
    m.quietUntil = 456;
    m.firstLaunch = 789;
    m.devTrigger = 'parade';
    m.secretsSerial = 4;
    t.eq([m.hiddenUntil, m.quietUntil, m.firstLaunch, m.devTrigger, m.secretsSerial],
        [123, 456, 789, 'parade', 4], 'setters store the value');
    t.eq(seen, ['hiddenUntil', 'quietUntil', 'firstLaunch', 'devTrigger', 'secretsSerial'], 'memory setters notify with camelCase names');
    m.disconnect(id);
    m.hiddenUntil = 0;
    t.eq(seen.length, 5, 'disconnect stops notifications');

    // --- Prefs.fromSettings: one defaults table, no drift from the schema ---
    const {schema, settings} = memorySettings();
    const fromSettings = Prefs.fromSettings(settings);
    const memory = Prefs.memory();
    const schemaKeys = schema.list_keys();
    t.check(schemaKeys.length > 0, 'schema lists keys');
    for (const key of schemaKeys) {
        const name = camel(key);
        t.check(memory[name] !== undefined, `Prefs has a getter for ${key}`);
        t.eq(fromSettings[name], memory[name], `memory default equals schema default for ${key}`);
    }
    // A name in the table without a schema key would be missing from the loop above.
    const tableNames = Object.getOwnPropertyNames(Prefs.prototype)
        .filter(n => Object.getOwnPropertyDescriptor(Prefs.prototype, n).get && !['effectiveFilter', 'distractionList', 'siteRules', 'effectiveClaudeModel', 'effectiveLang'].includes(n))
        .sort();
    t.eq(tableNames, schemaKeys.map(camel).sort(), 'prefs getters and schema keys are the same set');

    // Reads follow the live GSettings values, one getter type per schema type.
    settings.set_int('daily-target', 7);
    settings.set_string('pet-name', 'Kuro');
    settings.set_double('pet-scale', 1.5);
    settings.set_boolean('work-saturday', true);
    settings.set_strv('dev-scenes', ['a', 'b']);
    settings.set_int64('first-launch', 1790000000000);
    settings.set_string('sound-mode', 'all');
    t.eq([fromSettings.dailyTarget, fromSettings.petName, fromSettings.petScale, fromSettings.workSaturday,
        fromSettings.devScenes, fromSettings.firstLaunch, fromSettings.soundMode],
    [7, 'Kuro', 1.5, true, ['a', 'b'], 1790000000000, 'all'], 'fromSettings reads live values');
    t.check(fromSettings.isWorkday(new Date(2026, 9, 24)), 'derived values follow GSettings');

    // Writes go through to GSettings.
    fromSettings.hiddenUntil = 1790000999000;
    fromSettings.quietUntil = 1790000555000;
    fromSettings.firstLaunch = 1780000000000;
    fromSettings.devTrigger = 'golden';
    fromSettings.secretsSerial = 9;
    t.eq([settings.get_int64('hidden-until'), settings.get_int64('quiet-until'), settings.get_int64('first-launch'),
        settings.get_string('dev-trigger'), settings.get_int('secrets-serial')],
    [1790000999000, 1790000555000, 1780000000000, 'golden', 9], 'fromSettings setters write to GSettings');

    // Change notifications use camelCase names and can be disconnected.
    const changes = [];
    const cid = fromSettings.onChanged(name => changes.push(name));
    settings.set_int('bubble-gap', 20);
    fromSettings.secretsSerial = 10;
    t.eq(changes, ['bubbleGap', 'secretsSerial'], 'fromSettings notifies with camelCase names');
    fromSettings.disconnect(cid);
    settings.set_int('bubble-gap', 21);
    t.eq(changes.length, 2, 'fromSettings disconnect stops notifications');

    // --- Emitter ---
    const e = new Emitter(); let got = 0; const eid = e.on('x', v => { got += v; }); e.emit('x', 2); e.off(eid); e.emit('x', 5);
    t.eq(got, 2, 'emitter on/off');

    const order = [];
    const em = new Emitter();
    em.on('a', (...args) => order.push(['first', ...args]));
    em.on('a', (...args) => order.push(['second', ...args]));
    em.on('b', () => order.push('b'));
    em.emit('a', 1, 'two');
    t.eq(order, [['first', 1, 'two'], ['second', 1, 'two']], 'listeners run in order with every argument, only for their event');
    em.emit('nobody-listens');
    t.check(true, 'emitting an event with no listeners is fine');
    em.off(9999);
    t.check(true, 'off of an unknown id is fine');

    const e2 = new Emitter();
    const calls = [];
    const idA = e2.on('x', () => { calls.push('A'); e2.off(idB); });
    const idB = e2.on('x', () => calls.push('B'));
    e2.on('x', () => { calls.push('C'); e2.on('x', () => calls.push('late')); });
    e2.emit('x');
    t.eq(calls, ['A', 'C'], 'a listener removed during emit is skipped, one added during emit waits');
    e2.off(idA);
    calls.length = 0;
    e2.emit('x');
    t.eq(calls, ['C', 'late'], 'later emits see the listener added during the previous one');

    const e3 = new Emitter();
    const ids = new Set([e3.on('x', () => {}), e3.on('x', () => {}), e3.on('y', () => {})]);
    t.eq(ids.size, 3, 'ids are unique across event names');
    const after = [];
    e3.on('x', () => { throw new Error('boom'); });
    e3.on('x', () => after.push('survived'));
    const reported = [];
    e3._reportError = (name, error) => reported.push(`${name}: ${error.message}`);
    e3.emit('x');
    t.eq(after, ['survived'], 'a throwing listener does not stop the others');
    t.check(reported.length === 1 && reported[0] === 'x: boom', 'a throwing listener is reported, not swallowed');
}
