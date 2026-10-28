import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {getLang, setLang} from '../extension/core/l10n.js';
import {atHour, dayKey, parseDate} from '../extension/core/dates.js';
import {DaySnapshot, Task} from '../extension/core/models.js';
import {Mood} from '../extension/core/mood.js';
import {Stage} from '../extension/core/life.js';
import {LOG_KINDS, LogSummary, PetLog, logLine} from '../extension/core/diary.js';
import {Lines, setLinesRandom} from '../extension/core/lines.js';
import {MemoryFiles, MemoryStore, tmpDir} from './helpers.js';

const MINUTE = 60_000;
const DAY = 86_400_000;

// Lets promise callbacks that are already queued (and the ones they queue) run.
async function settle() {
    for (let i = 0; i < 20; i++)
        await Promise.resolve();
}

// Runs the check once per language. `pickIndex` of `pickCount` selects the variant of a pick() line.
function says(t, name, call, en, vi, pickIndex = 0, pickCount = 1) {
    setLinesRandom(() => (pickIndex + 0.5) / pickCount);
    const before = getLang();
    try {
        setLang('en');
        t.eq(call(), en, `${name} EN`);
        setLang('vi');
        t.eq(call(), vi, `${name} VI`);
    } finally {
        setLang(before);
        setLinesRandom();
    }
}

export default async function (t) {
    const before = getLang();
    try {
        await diaryTests(t);
        linesTests(t);
    } finally {
        setLang(before);
        setLinesRandom();
    }
}

async function diaryTests(t) {
    setLang('en');
    const t0 = atHour(11, 0, parseDate('2026-10-25'));
    const at = seconds => new Date(t0.getTime() + seconds * 1000);

    // --- Test doubles ---
    const store = new MemoryStore({life: {xp: 5}});
    t.eq(await store.load('life'), {xp: 5}, 'MemoryStore loads what it was given');
    t.eq(await store.load('nope'), null, 'MemoryStore has no value for an unknown name');
    const given = {xp: 7};
    store.save('life', given);
    given.xp = 8;
    t.eq([await store.load('life'), store.saves], [{xp: 7}, [['life', {xp: 7}]]], 'MemoryStore copies on save and records saves');
    t.eq(await store.flush(), undefined, 'MemoryStore flush resolves');

    const files0 = new MemoryFiles({'2026-10-24': 'x\n'});
    await files0.append('2026-10-24', 'y\n');
    await files0.append('2026-10-25', 'z\n');
    t.eq([await files0.read('2026-10-24'), await files0.read('2026-10-25'), await files0.read('2026-01-01')],
        ['x\ny\n', 'z\n', ''], 'MemoryFiles appends and reads, a missing day is empty');
    t.eq(await files0.list(), ['2026-10-24', '2026-10-25'], 'MemoryFiles lists the days it has');
    await files0.remove('2026-10-24');
    t.eq([...files0.data.keys()], ['2026-10-25'], 'MemoryFiles removes a day');

    const dir = tmpDir();
    const dir2 = tmpDir();
    t.check(dir !== dir2 && GLib.file_test(dir, GLib.FileTest.IS_DIR) && dir.startsWith(GLib.get_tmp_dir()),
        'tmpDir makes a new directory under the temp dir each time');
    for (const d of [dir, dir2])
        Gio.File.new_for_path(d).delete(null);

    // --- Kinds ---
    t.eq(Object.keys(LOG_KINDS), ['bubble', 'response', 'antic', 'hold', 'flow', 'meeting', 'focus', 'mood', 'life',
        'distraction', 'sync', 'system'], 'diary kinds, in the Swift order');
    t.eq(Object.values(LOG_KINDS), ['💬', '↳', '😤', '⏸', '🎧', '📅', '🍅', '🎭', '🍙', '👀', '🔄', '⚙\uFE0F'],
        'diary kind icons');
    t.check(Object.isFrozen(LOG_KINDS), 'LOG_KINDS is frozen');

    // --- DevTools.swift "Pet diary": the same checks, in memory only and with MemoryFiles ---
    for (const [label, files] of [['memory only', null], ['with files', new MemoryFiles()]]) {
        const memo = await PetLog.open({files, now: t0});
        memo.add('bubble', 'a', {now: t0});
        memo.add('response', 'b', {tag: 'ignored', now: t0});
        memo.add('hold', 'c', {throttle: 'h', every: 10, now: t0});
        memo.add('hold', 'c', {throttle: 'h', every: 10, now: at(120)});
        memo.add('flow', 'd', {tag: 'flowEnd', minutes: 30, now: t0});
        const sum = new LogSummary(memo.today);
        t.check(memo.today.length === 4 && sum.bubbles === 1 && sum.ignored === 1 && sum.holds === 1 && sum.flowMinutes === 30,
            `diary entries, throttling and summary (${label})`);
        memo.add('system', 'next day', {now: at(86_400)});
        t.check(memo.today.length === 1, `diary starts fresh on a new day (${label})`);
        await memo.flush();
    }

    // --- Entries ---
    const log = await PetLog.open({now: t0});
    t.check(log.enabled === true && log.today.length === 0, 'a new diary is enabled and empty');
    log.add('bubble', 'one', {now: t0});
    log.add('response', 'two', {tag: 'picked', minutes: 5, now: at(30)});
    const [one, two] = log.today;
    t.check(typeof one.id === 'string' && one.id.length > 0 && one.id !== two.id, 'entries get their own ids');
    t.check(one.time instanceof Date && one.time.getTime() === t0.getTime() && one.time !== t0,
        'the entry time is a copy of the given date');
    t.eq([one.kind, one.text, 'tag' in one, 'minutes' in one], ['bubble', 'one', false, false],
        'tag and minutes are left out when not given');
    t.eq([two.kind, two.text, two.tag, two.minutes], ['response', 'two', 'picked', 5], 'tag and minutes are kept');
    log.today.push(one);
    t.eq(log.today.length, 2, 'the list read from today is a copy');
    t.eq(logLine(one), '11:00 💬 one', 'an entry line is "time icon text"');
    t.eq(logLine(two), '11:00 ↳ two', 'an entry line for another kind');
    t.eq(logLine({time: new Date(t0.getTime() + 5 * MINUTE + 9 * 3_600_000), kind: 'system', text: 'x'}),
        '20:05 ⚙\uFE0F x', 'an entry line pads the time');
    let thrown = null;
    try {
        log.add('shout', 'x', {now: t0});
    } catch (e) {
        thrown = e;
    }
    t.check(thrown instanceof TypeError && log.today.length === 2, 'an unknown kind is refused');

    // Throttle: at most once per `every` minutes per key, exactly like Swift's lastByKey.
    const th = await PetLog.open({now: t0});
    th.add('hold', 'a', {throttle: 'k', every: 10, now: t0});
    th.add('hold', 'b', {throttle: 'k', every: 10, now: at(599)});
    th.add('hold', 'c', {throttle: 'k', every: 10, now: at(600)});
    th.add('hold', 'd', {throttle: 'other', every: 10, now: at(601)});
    th.add('hold', 'e', {now: at(602)});
    th.add('hold', 'f', {now: at(602)});
    t.eq(th.today.map(e => e.text), ['a', 'c', 'd', 'e', 'f'],
        'a throttled key waits the full interval, other keys and unthrottled entries are not held back');
    th.add('hold', 'g', {throttle: 'zero', now: at(700)});
    th.add('hold', 'h', {throttle: 'zero', now: at(700)});
    t.eq(th.today.map(e => e.text).slice(-2), ['g', 'h'], 'a throttle without an interval never holds an entry back');
    th.add('hold', 'i', {throttle: 'k', every: 10, now: at(1000)});
    t.eq(th.today.at(-1).text, 'h', 'a held-back entry does not restart the wait');
    th.add('hold', 'j', {throttle: 'k', every: 10, now: at(1200)});
    t.eq(th.today.at(-1).text, 'j', 'the wait counts from the last entry that was logged');

    // enabled
    const off = await PetLog.open({files: new MemoryFiles(), now: t0});
    off.enabled = false;
    off.add('bubble', 'x', {throttle: 'k', every: 10, now: t0});
    t.eq(off.today.length, 0, 'a disabled diary adds nothing');
    off.enabled = true;
    off.add('bubble', 'y', {throttle: 'k', every: 10, now: t0});
    t.eq(off.today.map(e => e.text), ['y'], 'a disabled diary does not start a throttle either');

    // Only the last 1000 entries of the day stay in memory.
    const big = await PetLog.open({now: t0});
    for (let i = 0; i < 1005; i++)
        big.add('system', `n${i}`, {now: t0});
    t.check(big.today.length === 1000 && big.today[0].text === 'n5' && big.today.at(-1).text === 'n1004',
        'the diary keeps the last 1000 entries of the day');

    // --- Summary ---
    const entries = [
        ...[0, 1, 2].map(i => ({id: `b${i}`, time: t0, kind: 'bubble', text: 'x'})),
        {id: 'r1', time: t0, kind: 'response', text: 'x', tag: 'ignored'},
        {id: 'r2', time: t0, kind: 'response', text: 'x', tag: 'closed'},
        {id: 'r3', time: t0, kind: 'response', text: 'x', tag: 'closed'},
        {id: 'r4', time: t0, kind: 'response', text: 'x', tag: 'picked'},
        {id: 'r5', time: t0, kind: 'response', text: 'x'},
        {id: 'h1', time: t0, kind: 'hold', text: 'x'},
        {id: 'f1', time: t0, kind: 'flow', text: 'x', tag: 'flowEnd', minutes: 60},
        {id: 'f2', time: t0, kind: 'flow', text: 'x', tag: 'flowEnd', minutes: 30},
        {id: 'f3', time: t0, kind: 'flow', text: 'x', tag: 'flowStart', minutes: 99},
        {id: 'a1', time: t0, kind: 'antic', text: 'x'},
        {id: 'd1', time: t0, kind: 'distraction', text: 'x', tag: 'end', minutes: 12},
        {id: 'd2', time: t0, kind: 'distraction', text: 'x', tag: 'start', minutes: 50},
        {id: 'd3', time: t0, kind: 'distraction', text: 'x'},
        {id: 's1', time: t0, kind: 'sync', text: 'x'},
    ];
    const summary = new LogSummary(entries);
    t.eq({...summary}, {bubbles: 3, ignored: 1, dismissed: 2, holds: 1, flows: 2, flowMinutes: 90, antics: 1,
        distractedMinutes: 12}, 'summary counts by kind and tag');
    t.eq(summary.text,
        "💬 3 reminders · you ignored 1, closed 2 · ⏸ held 1× · 🎧 in the zone 2× (1h30) · 😤 1 antic(s) · 👀 distracted 12'",
        'summary text EN');
    setLang('vi');
    t.eq(summary.text,
        "💬 3 lời nhắc · bạn bỏ qua 1, đóng 2 · ⏸ hoãn 1 lần · 🎧 vào guồng 2 lần (1h30) · 😤 quậy 1 lần · 👀 xao nhãng 12'",
        'summary text VI');
    setLang('en');
    t.eq(new LogSummary([]).text, '💬 0 reminders', 'an empty diary summary is just the reminder count');
    t.eq(new LogSummary([{kind: 'flow', tag: 'flowEnd', time: t0, text: 'x'}]).flowMinutes, 0,
        'a flow end without minutes counts as 0');
    t.eq(new LogSummary([{kind: 'response', tag: 'closed', time: t0, text: 'x'}]).text,
        '💬 0 reminders · you ignored 0, closed 1', 'ignored and closed are shown together');

    // --- Files: what is written ---
    const files = new MemoryFiles();
    const disk = await PetLog.open({files, now: t0});
    disk.add('bubble', '“Viết báo cáo” — vì 45 phút', {now: t0});
    disk.add('response', 'Bạn bấm “Để sau”', {tag: 'picked', minutes: 3, now: at(30)});
    await disk.flush();
    const text = files.data.get('2026-10-25');
    const lines = text.split('\n');
    t.check(lines.length === 3 && lines[2] === '' && text.endsWith('\n'), 'each entry is one line of its day file, ending in a newline');
    const first = JSON.parse(lines[0]);
    t.eq([Object.keys(first), first.time, first.kind, first.text], [['id', 'time', 'kind', 'text'],
        '2026-10-25T04:00:00.000Z', 'bubble', '“Viết báo cáo” — vì 45 phút'], 'a stored entry is JSON with an ISO time');
    t.eq(Object.keys(JSON.parse(lines[1])), ['id', 'time', 'kind', 'text', 'tag', 'minutes'], 'tag and minutes are stored when present');

    // Read back.
    const reread = await PetLog.open({files, now: t0});
    t.eq(reread.today.map(e => e.text), ['“Viết báo cáo” — vì 45 phút', 'Bạn bấm “Để sau”'], 'the diary is read back from its files');
    t.check(reread.today[1].time instanceof Date && reread.today[1].time.getTime() === at(30).getTime()
        && reread.today[1].tag === 'picked' && reread.today[1].minutes === 3 && reread.today[0].id === disk.today[0].id,
        'read-back entries keep time, tag, minutes and id');
    reread.add('bubble', 'later', {now: at(60)});
    await reread.flush();
    t.eq((await PetLog.open({files, now: t0})).today.length, 3, 'new entries are added after the ones read back');

    // A damaged file keeps its good lines.
    const damaged = new MemoryFiles({
        '2026-10-25': [
            JSON.stringify({id: 'g1', time: '2026-10-25T04:00:00.000Z', kind: 'bubble', text: 'ok'}),
            '',
            '{}',
            'not json',
            JSON.stringify({id: 'x', time: '2026-10-25T04:00:00.000Z', kind: 'shout', text: 'unknown kind'}),
            JSON.stringify({id: 'x', time: 'yesterday', kind: 'bubble', text: 'bad time'}),
            JSON.stringify({id: 'x', time: '2026-10-25T04:00:00.000Z', kind: 'bubble'}),
            JSON.stringify({time: '2026-10-25T04:01:00Z', kind: 'hold', text: 'no id', tag: 5, minutes: 'x'}),
            '[1,2]',
            JSON.stringify({id: 'g2', time: '2026-10-25T04:02:00Z', kind: 'flow', text: 'fine', tag: 'flowEnd', minutes: 7}),
        ].join('\n'),
    });
    const patched = await PetLog.open({files: damaged, now: t0});
    t.eq(patched.today.map(e => e.text), ['ok', 'no id', 'fine'], 'lines that are not diary entries are skipped');
    t.check(typeof patched.today[1].id === 'string' && patched.today[1].id.length > 0
        && !('tag' in patched.today[1]) && !('minutes' in patched.today[1]) && patched.today[2].minutes === 7,
        'a missing id is made up and wrongly typed tag or minutes are dropped');

    // --- Files: other days, days(), load() ---
    const yesterday = dayKey(new Date(t0.getTime() - DAY));
    const multi = new MemoryFiles({
        [yesterday]: `${JSON.stringify({id: 'y', time: '2026-10-24T04:00:00Z', kind: 'mood', text: 'yesterday'})}\n`,
        'notes.txt': 'not a day',
    });
    const mlog = await PetLog.open({files: multi, now: t0});
    t.eq(await mlog.days(), ['2026-10-25', yesterday], 'days lists today and the days that have a file, newest first');
    t.eq(multi.data.has('notes.txt'), true, 'files that are not days are left alone');
    t.eq((await mlog.load(yesterday)).map(e => e.text), ['yesterday'], 'load reads another day');
    t.eq(await mlog.load('2020-01-01'), [], 'load gives nothing for a day without a file');
    t.eq(await mlog.load('2026-10-25'), [], 'load gives an empty today');
    mlog.add('bubble', 'now', {now: t0});
    t.eq((await mlog.load('2026-10-25')).map(e => e.text), ['now'], 'load gives today from memory');
    t.eq(await (await PetLog.open({now: t0})).days(), ['2026-10-25'], 'without files, days is just today');
    t.eq(await (await PetLog.open({now: t0})).load(yesterday), [], 'without files, load gives nothing');
    t.eq(await (await PetLog.open({files: new MemoryFiles({'2026-10-20.jsonl': ''}), now: t0})).days(), ['2026-10-25', '2026-10-20'],
        'a file name with the .jsonl ending counts as its day');

    // --- Retention: 14 days, pruned on open and on a day change ---
    const day = back => dayKey(new Date(t0.getTime() - back * DAY));
    const old = new MemoryFiles({[day(20)]: '{}\n', [day(15)]: 'x\n', [day(14)]: 'y\n', [day(13)]: 'z\n'});
    await PetLog.open({files: old, now: t0});
    t.eq([...old.data.keys()].sort(), [day(14), day(13)].sort(), 'diary files older than 14 days are removed on open');
    const roll = await PetLog.open({files: old, now: t0});
    roll.add('bubble', 'tomorrow', {now: at(86_400)});
    await roll.flush();
    t.eq([...old.data.keys()].sort(), [day(13), dayKey(at(86_400))].sort(),
        'and again when the day changes (the day that is now 15 days old goes)');
    t.eq(roll.today.map(e => e.text), ['tomorrow'], 'the new day starts empty');
    t.eq((await roll.days()).slice(0, 2), [dayKey(at(86_400)), day(13)], 'the new day is listed first');

    // --- Failing and slow files never break the pet ---
    const errors = [];
    const flaky = {
        failAppend: true,
        appended: [],
        async append(d, line) {
            if (this.failAppend)
                throw new Error('disk full');
            this.appended.push([d, line]);
        },
        async read() {
            throw new Error('unreadable');
        },
        async list() {
            throw new Error('no listing');
        },
        async remove() {},
    };
    const fl = await PetLog.open({files: flaky, now: t0, onError: e => errors.push(e.message)});
    t.eq(fl.today, [], 'a diary that cannot be read starts empty');
    t.eq(errors, ['no listing', 'unreadable'], 'and says why');
    fl.add('bubble', 'kept in memory', {now: t0});
    await fl.flush();
    t.check(fl.today.length === 1 && errors.length === 3 && errors[2] === 'disk full', 'a failed write is reported and the entry stays in memory');
    flaky.failAppend = false;
    fl.add('bubble', 'second', {now: at(1)});
    await fl.flush();
    t.check(flaky.appended.length === 1 && JSON.parse(flaky.appended[0][1]).text === 'second', 'writing carries on after a failure');
    t.eq(await fl.days(), ['2026-10-25'], 'a failing listing leaves just today');

    // Writes happen in order, one after the other, and add() does not wait for them.
    const calls = [];
    const gates = [];
    const slow = {
        append(d, line) {
            calls.push(JSON.parse(line).text);
            return new Promise(resolve => gates.push(resolve));
        },
        async read() {
            return '';
        },
        async list() {
            return [];
        },
        async remove() {},
    };
    const sl = await PetLog.open({files: slow, now: t0});
    sl.add('bubble', 'first', {now: t0});
    sl.add('bubble', 'second', {now: t0});
    t.eq(sl.today.length, 2, 'add returns without waiting for the file');
    await settle();
    t.eq(calls, ['first'], 'the second write waits for the first');
    gates[0]();
    await settle();
    t.eq(calls, ['first', 'second'], 'and goes once it is done');
    gates[1]();
    await sl.flush();

    // A files object that throws at once (not just a rejected promise) is handled the same way.
    const hasty = [];
    const sync = {
        append() {
            throw new Error('sync failure');
        },
        read: async () => '',
        list: async () => [],
        remove: async () => {},
    };
    const quiet = await PetLog.open({files: sync, now: t0, onError: e => hasty.push(e.message)});
    quiet.add('bubble', 'x', {now: t0});
    await quiet.flush();
    t.check(quiet.today.length === 1 && hasty.length === 1 && hasty[0] === 'sync failure', 'add never throws because of the files');

    // --- Export ---
    const exp = [
        {id: '2', time: at(120), kind: 'hold', text: 'second'},
        {id: '1', time: t0, kind: 'bubble', text: '“Viết báo cáo” — vì 45 phút'},
    ];
    t.eq(PetLog.exportText(exp, '2026-10-25'),
        "TodoPet — diary 2026-10-25\n💬 1 reminders · ⏸ held 1×\n\n11:00 💬 “Viết báo cáo” — vì 45 phút\n11:02 ⏸ second",
        'export: header, summary, blank line, then the entries oldest first');
    t.check(exp[0].id === '2', 'export leaves the given list alone');
    setLang('vi');
    t.eq(PetLog.exportText([], '2026-10-25').split('\n')[0], 'TodoPet — nhật ký 2026-10-25', 'export header VI');
    setLang('en');
    t.eq(PetLog.exportText([], '2026-10-25'), 'TodoPet — diary 2026-10-25\n💬 0 reminders\n', 'export of an empty diary');
}

function linesTests(t) {
    setLang('en');
    const task = (title, extra = {}) => new Task({id: title, content: title, ...extra});
    const rep = task('Write report');
    const day0 = parseDate('2026-10-25');
    const hourAt = h => atHour(h, 0, day0);
    const SUN = '☀\uFE0F';

    // --- Random source ---
    setLinesRandom(() => 0);
    t.eq([Lines.voiceCheer(), Lines.voiceCheer()], ['Awesome!', 'Awesome!'], 'setLinesRandom makes pick deterministic');
    setLinesRandom(() => 0.99);
    t.eq(Lines.voiceCheer(), 'Hooray!', 'and follows the random value');
    setLinesRandom();
    const seen = new Set();
    for (let i = 0; i < 200; i++)
        seen.add(Lines.voiceCheer());
    t.eq([...seen].sort(), ['Awesome!', 'Hooray!'], 'without a random source, both variants come up');
    t.check(Object.isFrozen(Lines), 'Lines is frozen');

    // --- Brief examples ---
    setLang('en');
    t.eq(Lines.added('Write report'), 'Added “Write report” ✔\uFE0E', 'added line EN');
    setLang('vi');
    t.eq(Lines.added('Viết báo cáo'), 'Đã thêm “Viết báo cáo” ✔\uFE0E', 'added line VI');
    t.check(Lines.distractionSummary({YouTube: 600, Facebook: 300}).includes('YouTube 10\''), 'summary lists top sites');
    setLang('en');

    // --- q and greeting ---
    t.eq(Lines.q(rep), '“Write report”', 'q quotes the task title');
    t.eq(Lines.q(task('**Write** [the report](https://x.y)')), '“Write the report”', 'q uses the plain title');
    t.eq(Lines.q(task('x'.repeat(50))), `“${'x'.repeat(41)}…”`, 'q shortens long titles to 42 characters');
    t.eq([10, 11, 12, 13, 17, 18, 23, 0, 3].map(h => {
        setLang('en');
        return Lines.greeting(hourAt(h));
    }), [`Good morning! ${SUN}`, 'Good day! 🌤', 'Good day! 🌤', 'Good afternoon! 🌇', 'Good afternoon! 🌇',
        'Good evening! 🌙', 'Good evening! 🌙', `Good morning! ${SUN}`, `Good morning! ${SUN}`], 'greeting follows the hour');
    says(t, 'greeting at 8', () => Lines.greeting(hourAt(8)), `Good morning! ${SUN}`, `Chào buổi sáng! ${SUN}`);
    says(t, 'greeting at 12', () => Lines.greeting(hourAt(12)), 'Good day! 🌤', 'Chào buổi trưa! 🌤');
    says(t, 'greeting at 15', () => Lines.greeting(hourAt(15)), 'Good afternoon! 🌇', 'Chào buổi chiều! 🌇');
    says(t, 'greeting at 20', () => Lines.greeting(hourAt(20)), 'Good evening! 🌙', 'Chào buổi tối! 🌙');
    says(t, 'hello', () => Lines.hello('Mochi'),
        "Hi! I'm Mochi 🐾 Give me your Todoist API token and I'll keep you on track.",
        'Xin chào! Mình là Mochi 🐾 Cho mình API token Todoist để mình giữ nhịp làm việc cho bạn nhé.');

    // --- morning ---
    const two = new DaySnapshot({today: [task('A'), task('B')]});
    says(t, 'morning with too few tasks', () => Lines.morning(hourAt(9), two, 3),
        `Good morning! ${SUN} What are our 3 things today? Only 2/3 planned so far 📝`,
        `Chào buổi sáng! ${SUN} Hôm nay mình làm 3 việc gì nào? Mới có 2/3 việc thôi 📝`);
    const three = new DaySnapshot({
        today: DaySnapshot.ranked([task('A', {priority: 1}), task('Write report', {priority: 4}), task('C')]),
        overdue: [task('Old')],
    });
    says(t, 'morning with a full plan eats the frog', () => Lines.morning(hourAt(9), three, 3),
        `Good morning! ${SUN} 4 tasks today. Eat the frog first: “Write report” 🐸`,
        `Chào buổi sáng! ${SUN} Hôm nay có 4 việc. Ăn con ếch trước: “Write report” 🐸`);
    says(t, 'morning with nothing to do is only the greeting', () => Lines.morning(hourAt(9), new DaySnapshot(), 0),
        `Good morning! ${SUN}`, `Chào buổi sáng! ${SUN}`);

    // --- plan ---
    const planWith = mood => () => Lines.plan({mood, planned: 1, target: 3});
    says(t, 'plan angry 1', planWith(Mood.angry), "It's this late and still no plan?! Add 2 more tasks now 😤",
        'Muộn thế này rồi mà chưa có kế hoạch?! Đặt ngay 2 việc nữa đi 😤', 0, 2);
    says(t, 'plan angry 2', planWith(Mood.angry), 'No plan = no progress! Add 2 tasks NOW 💢',
        'Không có kế hoạch = không có tiến độ! Thêm 2 việc NGAY 💢', 1, 2);
    says(t, 'plan annoyed 1', planWith(Mood.annoyed), 'Hey… still not 3 tasks for today 😒 (1/3)',
        'Này… hôm nay vẫn chưa đủ 3 việc đâu nha 😒 (1/3)', 0, 2);
    says(t, 'plan annoyed 2', planWith(Mood.annoyed), 'So what are we doing today? Still waiting for 2 more 😑',
        'Hôm nay làm gì vậy? Mình vẫn chờ 2 việc nữa đó 😑', 1, 2);
    for (const mood of [Mood.normal, Mood.happy, Mood.focus]) {
        says(t, `plan ${mood} 1`, planWith(mood), 'What are our 3 things today? 1/3 planned 📝',
            'Hôm nay mình làm 3 việc gì nào? Mới có 1/3 việc 📝', 0, 2);
        says(t, `plan ${mood} 2`, planWith(mood), 'Pick the 2 most important tasks for today ✍\uFE0F',
            'Chọn 2 việc quan trọng nhất cho hôm nay nhé ✍\uFE0F', 1, 2);
    }

    // --- nudge ---
    const nudge = (mood, hoursIdle = 0) => () => Lines.nudge({mood, next: rep, hoursIdle});
    says(t, 'nudge happy 1', nudge(Mood.happy), 'On a roll! Next up: “Write report” ✨',
        'Đang ngon trớn! Tiếp theo là “Write report” nha ✨', 0, 2);
    says(t, 'nudge happy 2', nudge(Mood.happy), "Love this pace! Let's do “Write report” 💪",
        'Mình thích nhịp này! Làm luôn “Write report” nhé 💪', 1, 2);
    says(t, 'nudge annoyed 1', nudge(Mood.annoyed), 'Ahem… “Write report” is still waiting. Even 10 minutes helps 😑',
        'Ừm… “Write report” vẫn nằm đó. Làm 10 phút thôi cũng được mà 😑', 0, 2);
    says(t, 'nudge annoyed 2', nudge(Mood.annoyed), "I'm a bit sad… start “Write report” 😒",
        'Mình hơi buồn đó… bắt đầu “Write report” đi 😒', 1, 2);
    says(t, 'nudge angry 1', nudge(Mood.angry, 3.4), '3h and nothing done! Do “Write report” NOW 😠',
        '3 tiếng rồi chưa xong việc nào! Làm “Write report” NGAY 😠', 0, 2);
    says(t, 'nudge angry 2', nudge(Mood.angry, 3.4), "I'm really mad 💢 “Write report” — start it!",
        'Mình giận thật rồi đó 💢 “Write report” — bắt đầu đi!', 1, 2);
    says(t, 'nudge angry rounds the hours', nudge(Mood.angry, 2.5), '3h and nothing done! Do “Write report” NOW 😠',
        '3 tiếng rồi chưa xong việc nào! Làm “Write report” NGAY 😠', 0, 2);
    says(t, 'nudge angry is at least one hour', nudge(Mood.angry, 0.2), '1h and nothing done! Do “Write report” NOW 😠',
        '1 tiếng rồi chưa xong việc nào! Làm “Write report” NGAY 😠', 0, 2);
    says(t, 'nudge angry with no idle time is one hour', nudge(Mood.angry, NaN), '1h and nothing done! Do “Write report” NOW 😠',
        '1 tiếng rồi chưa xong việc nào! Làm “Write report” NGAY 😠', 0, 2);
    for (const mood of [Mood.normal, Mood.sleeping, Mood.celebrating]) {
        says(t, `nudge ${mood} 1`, nudge(mood), 'Next: “Write report”. Want a focus session?',
            'Việc tiếp theo: “Write report”. Làm một phiên tập trung không?', 0, 2);
        says(t, `nudge ${mood} 2`, nudge(mood), 'Gentle nudge: “Write report” is waiting 🙂',
            'Nhắc nhẹ: “Write report” đang chờ bạn 🙂', 1, 2);
    }

    // --- overdue, distraction ---
    says(t, 'overdue angry', () => Lines.overdue(Mood.angry, 3), '3 OVERDUE tasks!! 💢 Do them or move them!',
        '3 việc QUÁ HẠN kìa!! 💢 Làm hoặc dời đi chứ!');
    says(t, 'overdue', () => Lines.overdue(Mood.normal, 3), '3 overdue task(s) 😬 Do them or move to today?',
        'Có 3 việc quá hạn 😬 Làm luôn hay dời vào hôm nay?');
    says(t, 'distraction angry', () => Lines.distraction({mood: Mood.angry, app: 'YouTube', left: 2, next: rep}),
        'YouTube AGAIN?! Close it, “Write report” is waiting 😤', 'YouTube nữa hả?!! Đóng lại đi, “Write report” đang chờ 😤');
    for (const [label, args] of [['calm', {mood: Mood.normal, next: rep}], ['angry without a task', {mood: Mood.angry, next: null}],
        ['angry with next left out', {mood: Mood.angry}]]) {
        says(t, `distraction ${label} 1`, () => Lines.distraction({app: 'YouTube', left: 2, ...args}),
            'Hey! On YouTube? 👀 2 task(s) left.', 'Ê! Đang YouTube đó hả? 👀 Còn 2 việc kìa.', 0, 2);
        says(t, `distraction ${label} 2`, () => Lines.distraction({app: 'YouTube', left: 2, ...args}),
            'I see YouTube 👀 Back to work?', 'Mình thấy bạn mở YouTube nha 👀 Quay lại làm việc chứ?', 1, 2);
    }

    // --- done, allDone, review ---
    says(t, 'done at the target', () => Lines.done(rep, 3, 3), "That's 3!!! You're the best 🏆", 'Đủ 3 việc rồi!!! Bạn là nhất 🏆');
    const doneLines = [
        ['Done: “Write report”! 🎉 (1/3)', 'Xong “Write report”! 🎉 (1/3)'],
        ['Awesome! ✔\uFE0E “Write report”', 'Tuyệt vời! ✔\uFE0E “Write report”'],
        ['Yay! So happy 🥳 (1/3)', 'Yay! Mình vui quá 🥳 (1/3)'],
        ['Nice! Keep the rhythm 💪', 'Giỏi quá! Tiếp tục giữ nhịp nhé 💪'],
    ];
    doneLines.forEach(([en, vi], i) => says(t, `done ${i + 1}`, () => Lines.done(rep, 1, 3), en, vi, i, 4));
    says(t, 'allDone', () => Lines.allDone(), "Everything's done for today! 🎉 Rest, or pick tomorrow's 3 tasks.",
        'Xong hết việc hôm nay rồi! 🎉 Nghỉ ngơi, hoặc chọn sẵn 3 việc cho mai nhé.');
    says(t, 'review', () => Lines.review({completed: 2, planned: 3, remaining: 1}),
        'Almost end of day: 2/3 done. Move the remaining 1 to tomorrow?',
        'Sắp hết giờ làm. Hôm nay xong 2/3 việc. Còn 1 việc — dời sang mai?');

    // --- Reminders, focus ---
    says(t, 'welcomeBack', () => Lines.welcomeBack(rep), 'Welcome back! 👋 Continue with “Write report”?',
        'Bạn về rồi! 👋 Tiếp tục với “Write report” nhé?');
    says(t, 'soon', () => Lines.soon(rep, 10), '⏰ In 10 min: “Write report”', '⏰ 10 phút nữa: “Write report”');
    says(t, 'dueNow', () => Lines.dueNow(rep), "⏰ It's time: “Write report”!", '⏰ Đến giờ rồi: “Write report”!');
    says(t, 'focusStart', () => Lines.focusStart(rep, 25), "25 minutes on “Write report”. I'll sit quietly and guard 🤫",
        'Bắt đầu 25 phút cho “Write report”. Mình sẽ ngồi im canh bạn 🤫');
    says(t, 'focusStart without a task', () => Lines.focusStart(null, 25), "25 minutes of focus. I'll stay quiet 🤫",
        'Bắt đầu 25 phút tập trung. Mình ngồi im canh nhé 🤫');
    says(t, 'focusEnd', () => Lines.focusEnd(rep, 25), '25 minutes up! Is “Write report” done?',
        'Hết 25 phút rồi! “Write report” xong chưa?');
    says(t, 'focusEnd without a task', () => Lines.focusEnd(null, 25), '25 minutes up! Take a break?',
        'Hết 25 phút rồi! Nghỉ chút nhé?');
    says(t, 'breakEnd', () => Lines.breakEnd(), "Break's over! Let's go 💪", 'Hết giờ nghỉ! Quay lại thôi 💪');
    says(t, 'added shortens the title', () => Lines.added('y'.repeat(50)), `Added “${'y'.repeat(41)}…” ✔\uFE0E`,
        `Đã thêm “${'y'.repeat(41)}…” ✔\uFE0E`);
    says(t, 'planComplete', () => Lines.planComplete(3, rep), '3 tasks planned! Start with “Write report” 🐸',
        'Đủ 3 việc cho hôm nay rồi! Bắt đầu với “Write report” nhé 🐸');
    says(t, 'planComplete without a task', () => Lines.planComplete(3, null), '3 tasks planned for today! 🐸',
        'Đủ 3 việc cho hôm nay rồi! 🐸');
    says(t, 'lateNight', () => Lines.lateNight(), "It's late… sleep now, crush it tomorrow 😴",
        'Khuya rồi đó… đi ngủ để mai làm tốt hơn nha 😴');
    says(t, 'error', () => Lines.error('timeout'), "I can't reach Todoist 😵 timeout", 'Mình không kết nối được Todoist 😵 timeout');

    // --- Calendar ---
    const standup = {id: 'e', title: 'Standup', start: atHour(14, 30, day0), end: atHour(15, 0, day0), joinURL: null};
    says(t, 'meetingSoon', () => Lines.meetingSoon(standup, 10), '📅 Meeting in 10 min: “Standup” (14:30)',
        '📅 10 phút nữa họp: “Standup” (14:30)');
    const cal = reduced => () => Lines.calendarDay({meetings: 2, busyMinutes: 150, freeMinutes: 330, target: 2, reduced});
    says(t, 'calendarDay reduced', cal(true), '📅 2 meeting(s) today (2h30), 5h30 free → 2 task(s) is realistic.',
        '📅 Hôm nay 2 cuộc họp (2h30), còn 5h30 trống → 2 việc là vừa sức.');
    says(t, 'calendarDay', cal(false), '📅 2 meeting(s) today (2h30), 5h30 free.', '📅 Hôm nay 2 cuộc họp (2h30), còn 5h30 trống.');
    says(t, 'timeBlock', () => Lines.timeBlock({task: rep, start: atHour(10, 30, day0), end: atHour(11, 0, day0)}),
        'A set time makes it easier to start: 10:30–11:00 for “Write report”?',
        'Gắn giờ cho dễ bắt đầu: 10:30–11:00 làm “Write report” nhé?');
    says(t, 'timeSet', () => Lines.timeSet(rep, atHour(15, 0, day0)), "Scheduled “Write report” at 15:00. I'll remind you ⏰",
        'Đã hẹn “Write report” lúc 15:00. Mình sẽ nhắc đúng giờ ⏰');

    // --- Postponed tasks ---
    const stuck = {task: rep, days: 4};
    says(t, 'stuck angry', () => Lines.stuck(stuck, Mood.angry), '“Write report” has been sitting there for 4 days!! 💢 Split it or drop it.',
        '“Write report” nằm đó 4 ngày rồi đấy!! 💢 Chia nhỏ hoặc bỏ đi.');
    says(t, 'stuck 1', () => Lines.stuck(stuck, Mood.normal),
        '“Write report” has been pushed for 4 days 😑 Too big? Let\'s split it into small steps.',
        '“Write report” bị dời 4 ngày rồi 😑 Chắc nó to quá? Chia thành bước nhỏ cho dễ bắt đầu nhé.', 0, 2);
    says(t, 'stuck 2', () => Lines.stuck(stuck, Mood.annoyed),
        '“Write report” keeps getting postponed (4 days). What\'s the tiniest first step?',
        'Mình thấy “Write report” cứ bị dời mãi (4 ngày). Bước nhỏ nhất để bắt đầu là gì?', 1, 2);
    says(t, 'splitDone', () => Lines.splitDone(3, 'Open file'), 'Split into 3 steps ✂\uFE0F Start with “Open file” — just 15–30 minutes!',
        'Đã chia thành 3 bước ✂\uFE0F Bắt đầu với “Open file” nhé — chỉ 15–30 phút thôi!');
    says(t, 'deleted', () => Lines.deleted(rep), 'Deleted “Write report” 🗑 One less thing on your list!',
        'Đã xoá “Write report” 🗑 Danh sách gọn hơn rồi!');
    says(t, 'confirmDelete', () => Lines.confirmDelete(rep), "Delete from Todoist for good (with any sub-tasks)? This can't be undone.",
        'Xoá hẳn khỏi Todoist (kèm việc con nếu có)? Không khôi phục được.');
    const weekly = task('Water plants', {due: {date: '2026-10-25', isRecurring: true}});
    says(t, 'confirmDelete of a recurring task', () => Lines.confirmDelete(weekly),
        "Delete from Todoist for good (with any sub-tasks), including the whole recurring series? This can't be undone.",
        'Xoá hẳn khỏi Todoist (kèm việc con nếu có), cả chuỗi lặp lại? Không khôi phục được.');
    says(t, 'unplanned', () => Lines.unplanned(rep), 'Took “Write report” off the plan (still in Todoist, no date). Feels lighter? 🙂',
        'Đã bỏ “Write report” khỏi kế hoạch (vẫn còn trong Todoist, không hạn). Nhẹ đầu hơn chưa? 🙂');

    // --- Pet life ---
    says(t, 'golden', () => Lines.golden(), '✨ RARE! A golden treat! ✨', '✨ HIẾM! Bánh vàng cho bạn! ✨');
    says(t, 'combo', () => Lines.combo(4), "🔥 Combo ×4! You're on fire!", '🔥 Combo ×4! Đang cháy quá!');
    says(t, 'cleaned all', () => Lines.cleaned(0), '🛁 Squeaky clean again!', '🛁 Mình sạch bong rồi!');
    says(t, 'cleaned some', () => Lines.cleaned(2), '🛁 A bit cleaner…', '🛁 Sạch hơn chút rồi…');
    says(t, 'levelUp', () => Lines.levelUp(Stage.teen), '⬆\uFE0F I grew up: Teen!', '⬆\uFE0F Mình lớn lên thành Thiếu niên!');
    says(t, 'unlocked', () => Lines.unlocked(['bow', 'sunglasses']), '🎁 Unlocked: 🎀 Bow, \u{1F576}\uFE0F Cool shades',
        '🎁 Mở khoá: 🎀 Nơ xinh, \u{1F576}\uFE0F Kính râm ngầu');
    says(t, 'streak', () => Lines.streak(5), '🔥 5-day streak — keep it going!', '🔥 Chuỗi 5 ngày đạt mục tiêu — giữ nhé!');
    says(t, 'dirty', () => Lines.dirty(3), '🪰 I\'m filthy… 3 lazy day(s). Finish a task to give me a bath.',
        '🪰 Mình bẩn quá… 3 ngày rồi bạn không làm gì. Xong 1 việc để tắm cho mình nhé.');
    says(t, 'hungry', () => Lines.hungry(20, rep), 'My tummy is rumbling 🍙 Finish “Write report” and feed me 🥺',
        'Bụng mình réo rồi nè 🍙 Xong “Write report” cho mình ăn với 🥺');
    says(t, 'hungry with no task', () => Lines.hungry(20, null), 'My tummy is rumbling 🍙', 'Bụng mình réo rồi nè 🍙');
    says(t, 'starving', () => Lines.hungry(9.9, rep), 'Starving… 😵\u200D💫 Finish “Write report” and feed me 🥺',
        'Đói lả rồi… 😵\u200D💫 Xong “Write report” cho mình ăn với 🥺');
    says(t, 'starving with no task', () => Lines.hungry(0, undefined), 'Starving… 😵\u200D💫', 'Đói lả rồi… 😵\u200D💫');
    says(t, 'hungry from ten up is only rumbling', () => Lines.hungry(10, null), 'My tummy is rumbling 🍙', 'Bụng mình réo rồi nè 🍙');
    says(t, 'grumble 1', () => Lines.grumble(rep), 'Sigh… 😮\u200D💨 Nobody has touched “Write report” yet.',
        'Haizzz… 😮\u200D💨 “Write report” vẫn chưa ai đụng tới.', 0, 2);
    says(t, 'grumble 2', () => Lines.grumble(rep), "*stomps* I've been waiting for “Write report” forever 😤",
        '*giậm chân* Mình chờ “Write report” lâu lắm rồi đó 😤', 1, 2);
    says(t, 'parade', () => Lines.parade(rep), "I'm marching until you do “Write report”! 📢",
        'Mình sẽ diễu hành tới khi bạn làm “Write report” thì thôi! 📢');
    says(t, 'block', () => Lines.block('youtube', rep), '(╯°□°)╯︵ ┻━┻ ENOUGH YOUTUBE! Go do “Write report”!',
        '(╯°□°)╯︵ ┻━┻ ĐỦ RỒI YOUTUBE! Làm “Write report” đi!');
    says(t, 'block with no task', () => Lines.block('youtube', null), '(╯°□°)╯︵ ┻━┻ ENOUGH YOUTUBE!',
        '(╯°□°)╯︵ ┻━┻ ĐỦ RỒI YOUTUBE!');
    says(t, 'distractionSummary', () => Lines.distractionSummary({YouTube: 600, Facebook: 300}),
        "You spent 15 minutes on distractions today 😒 (YouTube 10', Facebook 5')",
        "Hôm nay bạn ở mấy chỗ xao nhãng 15 phút đó 😒 (YouTube 10', Facebook 5')");
    says(t, 'distractionSummary lists the top three, longest first',
        () => Lines.distractionSummary({a: 60, b: 600, c: 300, d: 120}),
        "You spent 18 minutes on distractions today 😒 (b 10', c 5', d 2')",
        "Hôm nay bạn ở mấy chỗ xao nhãng 18 phút đó 😒 (b 10', c 5', d 2')");
    says(t, 'distractionSummary drops partial minutes', () => Lines.distractionSummary({a: 59, b: 59}),
        "You spent 1 minutes on distractions today 😒 (a 0', b 0')", "Hôm nay bạn ở mấy chỗ xao nhãng 1 phút đó 😒 (a 0', b 0')");
    says(t, 'distractionSummary of nothing', () => Lines.distractionSummary({}),
        'You spent 0 minutes on distractions today 😒 ()', 'Hôm nay bạn ở mấy chỗ xao nhãng 0 phút đó 😒 ()');

    // --- Spoken lines ---
    says(t, 'voiceGrumble 1', () => Lines.voiceGrumble(), 'Sigh. Get to work.', 'Haizzz. Làm việc đi chứ.', 0, 2);
    says(t, 'voiceGrumble 2', () => Lines.voiceGrumble(), "I'm so bored.", 'Mình chán quá à.', 1, 2);
    says(t, 'voiceAngry', () => Lines.voiceAngry(rep), 'Hey! Do Write report now!', 'Ê! Làm Write report ngay!');
    says(t, 'voiceAngry shortens the title to 30', () => Lines.voiceAngry(task('z'.repeat(40))),
        `Hey! Do ${'z'.repeat(29)}… now!`, `Ê! Làm ${'z'.repeat(29)}… ngay!`);
    says(t, 'voiceBlock', () => Lines.voiceBlock('YouTube'), 'Close YouTube!', 'Tắt YouTube đi!');
    says(t, 'voiceHungry', () => Lines.voiceHungry(), "I'm so hungry.", 'Mình đói quá.');
    says(t, 'voiceCheer 1', () => Lines.voiceCheer(), 'Awesome!', 'Tuyệt vời!', 0, 2);
    says(t, 'voiceCheer 2', () => Lines.voiceCheer(), 'Hooray!', 'Hoan hô!', 1, 2);
    says(t, 'voiceSummary', () => Lines.voiceSummary(15), 'You goofed off for 15 minutes today.', 'Hôm nay bạn lướt mạng 15 phút đó.');

    // --- Tips ---
    const tips = [
        ['Tip: do the hardest task first (eat the frog 🐸) — early energy is your best.',
            'Mẹo: làm việc khó nhất trước (Eat the frog 🐸) — năng lượng đầu ngày là tốt nhất.'],
        ['Tip: task too big? Split it into 15–30 minute steps in Todoist.',
            'Mẹo: việc to quá? Chia thành bước 15–30 phút rồi thêm vào Todoist.'],
        ['Tip: give tasks a concrete time (“2pm: do X”) — it makes starting much easier.',
            'Mẹo: gắn giờ cụ thể (“14h làm X”) giúp bạn dễ bắt tay vào việc hơn hẳn.'],
        ["Tip: spend 5 minutes at day's end picking tomorrow's 3 tasks.",
            'Mẹo: cuối ngày dành 5 phút chọn sẵn 3 việc cho mai — sáng mai vào việc ngay.'],
        ['Tip: every interruption costs a long refocus — mute notifications while focusing.',
            'Mẹo: mỗi lần bị gián đoạn cần khá lâu để tập trung lại — tắt thông báo khi tập trung nhé.'],
        ['Tip: drink water and stretch after each focus session 💧',
            'Mẹo: uống nước & đứng dậy vươn vai sau mỗi phiên tập trung 💧'],
    ];
    tips.forEach(([en, vi], i) => says(t, `tip ${i + 1}`, () => Lines.tip(), en, vi, i, tips.length));

    // Every function the Swift enum has.
    t.eq(Object.keys(Lines).sort(), [
        'added', 'allDone', 'block', 'breakEnd', 'calendarDay', 'cleaned', 'combo', 'confirmDelete', 'deleted', 'dirty',
        'distraction', 'distractionSummary', 'done', 'dueNow', 'error', 'focusEnd', 'focusStart', 'golden', 'greeting',
        'grumble', 'hello', 'hungry', 'lateNight', 'levelUp', 'meetingSoon', 'morning', 'nudge', 'overdue', 'parade',
        'plan', 'planComplete', 'q', 'review', 'soon', 'splitDone', 'streak', 'stuck', 'timeBlock', 'timeSet', 'tip',
        'unlocked', 'unplanned', 'voiceAngry', 'voiceBlock', 'voiceCheer', 'voiceGrumble', 'voiceHungry', 'voiceSummary',
        'welcomeBack',
    ], 'Lines has every function of Lines.swift');
}
