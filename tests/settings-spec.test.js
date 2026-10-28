// The settings window's data (Task 23): pages and rows against the schema and Swift's SettingsView, the work-hour
// limits, the shortcut capture rules. prefs.js itself only runs in the preferences process (tools/prefs-check.js).
import Gio from 'gi://Gio';

import {getLang, setLang} from '../extension/core/l10n.js';
import {
    PAGE_NAMES, captureMessage, captureStep, developerTriggers, hourLimits, hourText, joinLinksStatus, percentText,
    rowCount, settingsPages,
} from '../extension/core/settingsSpec.js';
import {parseDevTrigger} from '../extension/ui/devTrigger.js';

const SCHEMA_ID = 'org.gnome.shell.extensions.todopet';
const UUID = 'todopet@trananhtung.github.io';

// Keys the window does not show: the extension writes them itself, or they belong to the dev harness.
const NOT_IN_THE_WINDOW = ['first-launch', 'hidden-until', 'quiet-until', 'dev-screenshot-dir', 'dev-scenes', 'dev-trigger', 'secrets-serial'];

// The GVariant type each kind of row writes.
const KIND_TYPE = {combo: 's', entry: 's', switch: 'b', spin: 'i', scale: 'd', shortcut: 'as'};

export default async function (t) {
    const saved = getLang();
    try {
        const schema = loadSchema(t);
        if (!schema)
            return;
        pagesAndKeys(t, schema);
        swiftRanges(t, schema);
        texts(t);
        hours(t);
        triggers(t);
        capture(t);
        status(t);
    } finally {
        setLang(saved);
    }
}

function loadSchema(t) {
    const repoRoot = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent();
    const schemaDir = repoRoot.resolve_relative_path(`build/${UUID}/schemas`).get_path();
    const source = Gio.SettingsSchemaSource.new_from_directory(schemaDir, Gio.SettingsSchemaSource.get_default(), false);
    const schema = source.lookup(SCHEMA_ID, false);
    t.check(schema !== null, 'the compiled schema is found');
    return schema;
}

const rowsOf = pages => pages.flatMap(p => p.groups.flatMap(g => g.rows));

function pagesAndKeys(t, schema) {
    setLang('en');
    const pages = settingsPages();
    t.eq(pages.map(p => p.name), [...PAGE_NAMES], 'the pages, in order');
    t.eq([...PAGE_NAMES], ['General', 'Day', 'Todoist', 'Distractions', 'Calendar', 'Postponed', 'Diary', 'Shortcut', 'Developer'],
        'the nine page names');
    t.eq(pages.map(p => p.title), [...PAGE_NAMES], 'in English a page is titled with its name');
    t.eq(new Set(pages.map(p => p.icon)).size, pages.length, 'each page has its own icon');
    t.eq(pages.map(rowCount), [8, 13, 4, 3, 3, 5, 2, 1, 12], 'rows per page');

    const rows = rowsOf(pages);
    const shown = new Set();
    for (const r of rows) {
        t.check(r.kind in {...KIND_TYPE, secret: 1, link: 1, action: 1, status: 1, trigger: 1}, `row kind '${r.kind}' is known`);
        if (!r.key)
            continue;
        shown.add(r.key);
        const key = schema.get_key(r.key);
        t.eq(key.get_value_type().dup_string(), KIND_TYPE[r.kind], `${r.key} is bound as ${r.kind} (${KIND_TYPE[r.kind]})`);
        if (r.enabledBy)
            t.eq(schema.get_key(r.enabledBy).get_value_type().dup_string(), 'b', `${r.key} is enabled by a switch`);
    }
    for (const key of schema.list_keys()) {
        if (NOT_IN_THE_WINDOW.includes(key))
            t.check(!shown.has(key), `${key} stays out of the window`);
        else
            t.check(shown.has(key), `${key} has a row`);
    }
    t.eq([...shown].filter(k => rows.filter(r => r.key === k).length > 1), [], 'no key has two rows');

    // Combo choices are the schema's.
    const sound = rows.find(r => r.key === 'sound-mode');
    const [kind, values] = schema.get_key('sound-mode').get_range().deep_unpack();
    t.eq([kind, sound.choices.map(c => c.value)], ['enum', values.deep_unpack()], 'the sound choices are the schema choices');
    t.eq(rows.find(r => r.key === 'lang').choices.map(c => c.value), ['', 'en', 'vi'], 'language: system, English, Vietnamese');

    // A switch is only dependent on a real switch, and the voice row says why it can be off.
    const voice = rows.find(r => r.key === 'voice-on');
    t.check(voice.needs === 'speech' && voice.unavailable.includes('spd-say'), 'the voice row has a hint for a missing spd-say');
    t.eq(rows.filter(r => r.kind === 'secret').map(r => `${r.secret}:${r.status ? 'status' : 'entry'}`),
        ['todoist:status', 'todoist:entry', 'claude:status', 'claude:entry'], 'both secrets have a status row and an entry row');
}

// Swift's steppers, sliders and defaults.
function swiftRanges(t, schema) {
    const rows = rowsOf(settingsPages());
    const spin = key => rows.find(r => r.key === key);
    const expected = {
        'daily-target': [1, 10, 1], 'work-start': [0, 23, 1], 'work-end': [1, 24, 1], 'plan-deadline': [0, 24, 1],
        'remind-every': [15, 180, 15], 'focus-minutes': [5, 90, 5], 'break-minutes': [1, 30, 1],
        'bubble-gap': [5, 60, 5], 'meeting-lead': [1, 30, 1], 'stuck-days': [2, 10, 1],
    };
    for (const [key, [min, max, step]] of Object.entries(expected)) {
        t.eq([spin(key).min, spin(key).max, spin(key).step], [min, max, step], `${key} runs ${min}...${max} by ${step}`);
        const def = schema.get_key(key).get_default_value().unpack();
        t.check(def >= min && def <= max, `${key} default ${def} lies in its range`);
    }
    for (const key of Object.keys(expected))
        t.check(spin(key).kind === 'spin', `${key} is a spin row`);
    const size = spin('pet-scale');
    t.eq([size.kind, size.min, size.max, size.step], ['scale', 0.7, 1.6, 0.1], 'the size slider runs 0.7...1.6 by 0.1');
    const def = schema.get_key('pet-scale').get_default_value().unpack();
    t.check(def >= size.min && def <= size.max, 'the size default lies in its range');
    t.eq(rows.filter(r => r.hours).map(r => r.key), ['work-start', 'work-end', 'plan-deadline'], 'the three hours show as HH:00');
    t.eq(rows.filter(r => r.enabledBy).map(r => `${r.key}<-${r.enabledBy}`),
        ['distraction-sites<-watch-browsers', 'meeting-lead<-use-calendar'], 'two rows follow their switch');
    t.eq(rows.find(r => r.key === 'board-hotkey').kind, 'shortcut', 'the board hotkey has the capture row');
    t.eq(schema.get_key('board-hotkey').get_default_value().deep_unpack(), ['<Control><Super>t'], 'the default hotkey is Ctrl+Super+T');
}

// Every string is there in both languages; Swift's exact Vietnamese where it had a sentence.
function texts(t) {
    const strings = [];
    for (const lang of ['en', 'vi']) {
        setLang(lang);
        const pages = settingsPages();
        for (const p of pages) {
            strings.push([lang, `${p.name} title`, p.title]);
            for (const g of p.groups) {
                if (g.description !== '')
                    strings.push([lang, `${p.name} description`, g.description]);
                for (const r of g.rows) {
                    strings.push([lang, `${r.key ?? r.id ?? r.value ?? r.secret} title`, r.title]);
                    for (const c of r.choices ?? [])
                        strings.push([lang, `${r.key} choice ${c.value}`, c.label]);
                }
            }
        }
    }
    t.check(strings.every(([, , s]) => typeof s === 'string' && s.trim() !== ''), 'every title is a non-empty string in both languages');
    t.eq(settingsPages().length, 9, 'building the pages again gives the same pages');

    setLang('vi');
    const vi = settingsPages();
    const general = vi[0].groups.flatMap(g => g.rows);
    t.eq(vi.map(p => p.name), [...PAGE_NAMES], 'the page names do not translate');
    t.eq(vi[0].title, 'Chung', 'General in Vietnamese');
    t.eq([general[0].title, general[1].title, general[2].title, general[3].title],
        ['Ngôn ngữ', 'Tên pet', 'Kích thước', 'Âm thanh'], "Swift's Vietnamese for language, name, size, sounds");
    t.eq(general[3].choices.map(c => c.label), ['Tắt', 'Chỉ khi quan trọng', 'Tất cả'], "Swift's sound modes");
    t.check(vi[0].groups[1].description.startsWith('“Chỉ khi quan trọng”: kêu khi sắp họp'), "Swift's help text for the sounds");
    const day = vi[1].groups[0].rows;
    t.eq([day[0].title, day[1].title, day[2].title, day[3].title, day[4].title, day[5].title],
        ['Số việc cần lên kế hoạch mỗi ngày', 'Bắt đầu làm việc', 'Kết thúc', 'Hạn lên kế hoạch', 'Làm việc Thứ 7', 'Làm việc Chủ nhật'],
        "Swift's Vietnamese for the work rhythm");
    t.eq(vi[2].groups[0].rows[0].title, 'Đã kết nối', 'Todoist: connected');
    t.eq(vi[2].groups[1].rows[0].title, 'Bộ lọc “việc của tôi hôm nay”', 'Todoist: the filter');

    setLang('en');
    const en = settingsPages();
    const distractions = en[3].groups.map(g => g.description).join('\n');
    t.check(distractions.includes('matched by the browser window’s title') && distractions.includes('approximate'),
        'the Distractions page says sites are matched by window title and approximately');
    t.check(distractions.includes('youtube.com/shorts') && distractions.includes('Shorts'), 'it explains path rules need the path word in the title');
    t.check(vi[3].groups.map(g => g.description).join('\n').includes('tiêu đề cửa sổ'), 'and in Vietnamese');
}

function hours(t) {
    // Swift: workStart in 0...(max(0, workEnd - 1)), workEnd in (workStart + 1)...24, planDeadline in workStart...max(workStart, workEnd).
    const at = (workStart, workEnd) => ({workStart, workEnd});
    t.eq(hourLimits('workStart', at(8, 18)), [0, 17], 'work starts: 0 to one before the end');
    t.eq(hourLimits('workEnd', at(8, 18)), [9, 24], 'work ends: one after the start to 24');
    t.eq(hourLimits('planDeadline', at(8, 18)), [8, 18], 'plan by: from the start to the end');
    t.eq(hourLimits('workStart', at(0, 0)), [0, 0], 'work starts never goes below 0 (end at 0)');
    t.eq(hourLimits('planDeadline', at(20, 18)), [20, 20], 'plan by: never below the start (end before start)');
    t.eq(hourLimits('workEnd', at(23, 24)), [24, 24], 'work ends at its tightest');
    let threw = false;
    try {
        hourLimits('nope', at(8, 18));
    } catch {
        threw = true;
    }
    t.check(threw, 'an unknown limit throws');
    t.eq([hourText(8), hourText(0), hourText(18), hourText(24)], ['08:00', '00:00', '18:00', '24:00'], 'hours read HH:00');
    t.eq([percentText(1), percentText(0.7), percentText(1.6), percentText(1.1)], ['100%', '70%', '160%', '110%'], 'sizes read as percentages');
}

function triggers(t) {
    setLang('en');
    const list = developerTriggers();
    t.eq(list.map(x => x.value), [
        'parade', 'block', 'grumble', 'celebrate:jump', 'celebrate:spin', 'celebrate:flip', 'celebrate:dance',
        'celebrate:fireworks', 'golden', 'bubble',
    ], 'the Developer page plays the brief\'s ten commands');
    for (const x of list) {
        const kind = parseDevTrigger(x.value).kind;
        t.check(kind !== 'unknown' && kind !== 'none' && kind !== 'prefs', `the extension understands '${x.value}' (${kind})`);
    }
    const dev = settingsPages().at(-1);
    t.eq(dev.groups[0].rows.map(r => r.key ?? r.id), ['demo-mode', 'diaryFolder'], 'Developer: demo switch and diary folder');
    t.eq(dev.groups[1].rows.map(r => r.value), list.map(x => x.value), 'and one button per command');
}

function capture(t) {
    const step = (key, accel, valid = true) => captureStep({key, accel, valid});
    t.eq(step('Escape', 'Escape'), {action: 'cancel'}, 'Escape cancels');
    t.eq(step('BackSpace', 'BackSpace'), {action: 'clear'}, 'Backspace turns the shortcut off');
    t.eq(step('Control_L', '<Control>', false), {action: 'ignore'}, 'a held Control waits for the key');
    t.eq(step('Super_L', '<Super>', false), {action: 'ignore'}, 'a held Super waits');
    t.eq(step('ISO_Level3_Shift', '', false), {action: 'ignore'}, 'AltGr waits');
    t.eq(step('Caps_Lock', '', false), {action: 'ignore'}, 'Caps Lock waits');
    t.eq(step('t', '<Control><Super>t'), {action: 'accept', accel: '<Control><Super>t'}, 'Ctrl+Super+T is taken');
    t.eq(step('F9', '<Alt>F9'), {action: 'accept', accel: '<Alt>F9'}, 'Alt+F9 is taken');
    t.eq(step('t', '<Primary>t'), {action: 'accept', accel: '<Primary>t'}, 'Primary counts as Ctrl');
    t.eq(step('t', 't'), {action: 'reject', reason: 'modifier'}, 'a letter alone is refused');
    t.eq(step('F1', 'F1'), {action: 'reject', reason: 'modifier'}, 'F1 alone is refused');
    t.eq(step('t', '<Shift>t'), {action: 'reject', reason: 'modifier'}, 'Shift alone is not enough');
    t.eq(step('t', '<Control>t', false), {action: 'reject', reason: 'invalid'}, 'Gtk says invalid: refused');
    t.eq(step('BackSpace', '<Control>BackSpace'), {action: 'accept', accel: '<Control>BackSpace'}, 'Ctrl+Backspace is a shortcut, not a clear');
    t.eq(step('Escape', '<Control>Escape'), {action: 'accept', accel: '<Control>Escape'}, 'Ctrl+Escape is a shortcut, not a cancel');
    setLang('en');
    t.check(captureMessage('modifier').includes('Ctrl') && captureMessage('invalid') !== captureMessage('modifier'),
        'the two refusals have different messages');
    setLang('vi');
    t.check(captureMessage('modifier').includes('Ctrl'), 'and one in Vietnamese');
}

function status(t) {
    setLang('en');
    t.eq(joinLinksStatus(true), {title: 'Join links: on', subtitle: ''}, 'ECal present: Join links: on');
    t.eq(joinLinksStatus(false), {title: 'Join links: off', subtitle: 'install gir1.2-ecal-2.0 for Join links'},
        'ECal missing: the package to install');
    setLang('vi');
    t.check(joinLinksStatus(false).subtitle.includes('gir1.2-ecal-2.0') && joinLinksStatus(true).title.includes('bật'), 'in Vietnamese too');
}
