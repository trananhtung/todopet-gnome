import {getLang, setLang} from '../extension/core/l10n.js';
import {PetLog} from '../extension/core/diary.js';
import {ACCESSORIES, defaultLifeState, lifeStateFromJSON} from '../extension/core/life.js';
import {Task} from '../extension/core/models.js';
import {Mood} from '../extension/core/mood.js';
import {
    DIARY, SPLIT, addStep, canAddStep, canRemoveStep, dayChoices, dayLabel, diaryModel, diaryRows, emptySteps,
    entriesSignature, filterChoices, filterEntries, filterIncludes, filledSteps, folderURI, removeStep, saveFailedText,
    splitErrorText, splitModel, stepPlaceholder, stepsFromSuggestion, stuckLine, templateSteps, wardrobeModel,
} from '../extension/ui/viewsLogic.js';

// Wednesday 28 October 2026 (the tests run with TZ=Asia/Ho_Chi_Minh).
const TODAY = '2026-10-28';
const at = (h, m = 0) => new Date(2026, 9, 28, h, m);

const REPLY = new Task({id: '3', content: 'Reply to the boss\'s email', priority: 1, due: {date: '2026-10-25', string: 'Monday'}});
const RECURRING = new Task({id: '4', content: 'Water the plants', priority: 1, due: {date: '2026-10-28', string: 'every day', isRecurring: true}});

// LifeState.demo, as the brain keeps it for the demo.
const DEMO_LIFE = lifeStateFromJSON({
    satiety: 55, xp: 320, totalDone: 31, streak: 4, bestStreak: 4, bestCombo: 2, goldens: 1,
    unlocked: ['bow', 'scarf', 'tophat'], wearing: ['scarf'], perfectDays: ['2026-10-20', '2026-10-21', '2026-10-23'],
});

// A diary like docs/diary.png's, built with a real PetLog.
function sampleDiary() {
    const log = new PetLog({now: at(9)});
    const add = (minutes, kind, text, extra = {}) => log.add(kind, text, {now: new Date(at(9).getTime() + minutes * 60_000), ...extra});
    add(0, 'bubble', 'Good morning!');
    add(1, 'response', 'You tapped “＋ Add tasks”', {tag: 'picked'});
    add(12, 'flow', 'You\'re in the zone', {tag: 'flowStart'});
    add(40, 'hold', 'A reminder is due but you\'re in the zone — later');
    add(64, 'flow', 'Left the zone after 52 minutes', {tag: 'flowEnd', minutes: 52});
    add(65, 'life', 'Done “Write the weekly report” → 95% full');
    add(90, 'distraction', 'On youtube.com for 2+ minutes');
    add(91, 'bubble', '“Hey! On youtube.com? 👀”');
    add(91.8, 'response', 'No response (faded away)', {tag: 'ignored'});
    add(98, 'distraction', 'Left youtube.com after 8 minutes', {tag: 'end', minutes: 8});
    add(99, 'mood', 'Mood: chill → annoyed (score 41)');
    add(100, 'sync', 'Todoist synced');
    add(101, 'meeting', 'In a meeting');
    add(102, 'focus', 'Started a 25-minute focus session');
    add(103, 'antic', 'The pet grumbled');
    add(104, 'system', 'You came back after 5 minutes');
    return log.today;
}

function stepTests(t) {
    t.eq(SPLIT, {maxSteps: 6, startSteps: 3}, 'at most 6 steps, 3 to start with (Swift: steps.count < 6, ["", "", ""])');
    t.eq(emptySteps(), ['', '', ''], 'three blank steps to start with');
    t.eq(templateSteps('Write the report'), [
        'Gather what you need for “Write the report” (10\')',
        'Make a quick first draft (25\')',
        'Polish it and mark it done',
    ], 'the quick template, in English');
    const long = 'A very long task title that goes on and on and on forever';
    t.eq(templateSteps(long)[0], 'Gather what you need for “A very long task title that goes on and…” (10\')',
        'a long title is cut to 40 characters (39 and an ellipsis) in the template');
    t.eq(templateSteps('Short')[0].includes('“Short”'), true, 'a short title stays whole');

    t.eq([0, 1, 2].map(stepPlaceholder), [
        'e.g. Open the file and reread the brief (10\')',
        'e.g. Write a 5-bullet outline',
        'e.g. Do the easiest part in 25\'',
    ], 'the first three steps have example hints');
    t.eq([3, 4, 5].map(stepPlaceholder), ['Next step', 'Next step', 'Next step'], 'the others say "Next step"');

    t.eq(filledSteps(['  a ', '', '\n', 'b\t', '   ']), ['a', 'b'], 'blank steps are dropped and the rest trimmed');
    t.eq(filledSteps([]), [], 'no steps, nothing to save');

    t.check(canAddStep(5) && !canAddStep(6) && !canAddStep(7), 'a step can be added below 6');
    t.check(!canRemoveStep(1) && canRemoveStep(2), 'a step can be removed while there are 2 or more');
    t.eq(addStep(['a', 'b']), ['a', 'b', ''], 'adding puts a blank step at the end');
    t.eq(addStep(['1', '2', '3', '4', '5', '6']), ['1', '2', '3', '4', '5', '6'], 'adding stops at 6');
    const same = ['a'];
    t.check(addStep(same) !== same && same.length === 1, 'adding gives a new list and leaves the old one');
    t.eq(removeStep(['a', 'b', 'c'], 1), ['a', 'c'], 'removing takes that step out');
    t.eq(removeStep(['a'], 0), ['a'], 'the last step stays');
    t.eq(removeStep(['a', 'b'], 5), ['a', 'b'], 'removing a step that is not there changes nothing');

    t.eq(stepsFromSuggestion(['x', 'y', 'z']), ['x', 'y', 'z'], 'Claude\'s steps become the list');
    t.eq(stepsFromSuggestion([]), [''], 'no suggestion still leaves one step to type in');
    t.eq(stepsFromSuggestion(['a', 5, null, 'b']), ['a', 'b'], 'only text becomes a step');
}

function messageTests(t) {
    const claude = Object.assign(new Error('raw'), {userMessage: 'No Claude API key yet (add one in Settings).'});
    t.eq(splitErrorText(claude), 'No Claude API key yet (add one in Settings).', 'a ClaudeError shows its userMessage');
    t.eq(splitErrorText(new Error('boom')), 'boom', 'any other error shows its message');
    t.eq(splitErrorText('plain'), 'plain', 'a thrown string shows itself');
    t.eq(splitErrorText(null), 'null', 'nothing at all still says something');
    t.eq(saveFailedText(null), 'Couldn\'t add to Todoist.', 'no error text from the brain: Swift\'s own message');
    t.eq(saveFailedText('Todoist 429'), 'Todoist 429', 'the brain\'s error text wins');
    t.eq(stuckLine(4), '⏳ On your list for 4 days', 'how long a task has been on the list');
    t.eq(stuckLine(null), null, 'a task that is not stuck has no line');
}

function splitModelTests(t) {
    const base = {
        task: REPLY, stuckDays: 4, hasClaudeKey: false, steps: ['', '', ''], firstToday: true, asking: false, saving: false,
        error: null, confirming: false,
    };
    const m = splitModel(base);
    t.eq(m.title, 'Split a task ✂️', 'title');
    t.eq(m.task, 'Reply to the boss\'s email', 'the task');
    t.eq(m.stuck, '⏳ On your list for 4 days', 'the stuck line');
    t.eq(m.intro, 'Big or vague tasks are hard to start. Each step should take 15–30 minutes; make step 1 as easy as possible.', 'intro');
    t.eq(m.ask, {label: '✨ Ask Claude', enabled: false, busy: false,
        tooltip: 'Sends the task\'s title and notes to the Claude API'}, 'Ask Claude is off without a key');
    t.eq(m.template, 'Quick template', 'template button');
    t.eq(m.keyHint, 'Add a Claude API key in Settings for automatic suggestions.', 'the hint when there is no key');
    t.eq(m.rows.map(r => r.number), ['1.', '2.', '3.'], 'numbered steps');
    t.eq(m.rows.map(r => r.removable), [true, true, true], 'three steps can each be removed');
    t.eq(m.rows[0].placeholder, 'e.g. Open the file and reread the brief (10\')', 'first hint');
    t.eq([m.addStep.visible, m.addStep.label], [true, 'Add a step'], 'add a step');
    t.eq(m.firstToday, {label: 'Put step 1 on today\'s plan', checked: true}, 'step 1 goes on today\'s plan');
    t.eq(m.error, null, 'no error');
    t.eq(m.confirm, null, 'no delete question');
    t.eq(m.drop, {label: 'Drop from plan', tooltip: 'Removes the due date (the task stays in Todoist)'}, 'drop from plan');
    t.eq(m.deleteTooltip, 'Delete task', 'delete tooltip');
    t.eq(m.save, {label: 'Add to Todoist', enabled: false, busy: false}, 'nothing to save while every step is blank');

    const keyed = splitModel({...base, hasClaudeKey: true, steps: ['a', '', '']});
    t.eq([keyed.ask.enabled, keyed.keyHint, keyed.save.enabled], [true, null, true], 'with a key: Ask Claude on, no hint; a filled step saves');
    t.eq(splitModel({...base, hasClaudeKey: true, asking: true}).ask, {label: '✨ Ask Claude', enabled: false, busy: true,
        tooltip: 'Sends the task\'s title and notes to the Claude API'}, 'while asking: busy and off');
    t.eq(splitModel({...base, steps: ['a'], saving: true}).save, {label: 'Add to Todoist', enabled: false, busy: true}, 'while saving: busy and off');
    t.eq(splitModel({...base, steps: ['  ', 'x']}).save.enabled, true, 'one real step is enough');
    t.eq(splitModel({...base, steps: ['  ', '\t']}).save.enabled, false, 'blank steps do not count');

    t.eq(splitModel({...base, steps: ['a']}).rows.map(r => r.removable), [false], 'the last step cannot be removed');
    t.eq(splitModel({...base, steps: ['1', '2', '3', '4', '5']}).addStep.visible, true, 'five steps: one more can be added');
    const six = splitModel({...base, steps: ['1', '2', '3', '4', '5', '6']});
    t.eq([six.addStep.visible, six.rows[5].placeholder, six.rows[5].number], [false, 'Next step', '6.'], 'six steps: no more, and hints beyond 3');
    t.eq(splitModel({...base, stuckDays: null}).stuck, null, 'no stuck line for a task that is not stuck');
    t.eq(splitModel({...base, firstToday: false}).firstToday.checked, false, 'the toggle follows the choice');
    t.eq(splitModel({...base, error: 'No Claude API key yet'}).error, '⚠️ No Claude API key yet', 'errors start with the warning sign');

    const asking = splitModel({...base, confirming: true}).confirm;
    t.eq(asking, {
        text: 'Delete from Todoist for good (with any sub-tasks)? This can\'t be undone.', cancel: 'Cancel', delete: 'Delete',
    }, 'the delete question');
    t.eq(splitModel({...base, task: RECURRING, confirming: true}).confirm.text,
        'Delete from Todoist for good (with any sub-tasks), including the whole recurring series? This can\'t be undone.',
        'it warns about a recurring series');
    t.eq(JSON.stringify(splitModel(base)) === JSON.stringify(splitModel({...base})), true, 'the model is plain data (stringifiable)');
}

function wardrobeTests(t) {
    const m = wardrobeModel(DEMO_LIFE, Mood.angry);
    t.eq(m.title, 'Wardrobe & achievements', 'title');
    t.eq(m.previewMood, Mood.angry, 'the preview shows the pet\'s mood');
    t.eq(wardrobeModel(DEMO_LIFE, Mood.sleeping).previewMood, Mood.normal, 'a sleeping pet is shown awake in the wardrobe');
    t.eq(m.stats, [
        {icon: '⭐', label: 'Stage', value: 'Teen · 320 XP'},
        {icon: '✅', label: 'Tasks done', value: '31'},
        {icon: '🔥', label: 'Streak', value: '4 (best 4)'},
        {icon: '⚡️', label: 'Best combo', value: '×2'},
        {icon: '🍰', label: 'Golden treats', value: '1'},
    ], 'the five stats, as docs/wardrobe.png');
    t.eq(m.stickers, {
        title: 'Sticker book — perfect days: 3', empty: null, stars: '🌟🌟🌟', days: '2026-10-20, 2026-10-21, 2026-10-23',
    }, 'three perfect days, three stars');
    t.eq(m.accessories.map(a => a.id), ACCESSORIES, 'every accessory, in order');
    t.eq(m.accessories.map(a => a.name), ['Bow', 'Scarf', 'Cool shades', 'Top hat', 'Crown', 'Grad cap'], 'names');
    t.eq(m.accessories.map(a => a.emoji), ['🎀', '🧣', '\u{1F576}\u{FE0F}', '🎩', '👑', '🎓'], 'emoji');
    t.eq(m.accessories.map(a => a.owned), [true, true, false, true, false, false], 'owned: the unlocked ones');
    t.eq(m.accessories.map(a => a.status), [
        'Unlocked', 'Unlocked', '🔒 A ×3 combo', 'Unlocked', '🔒 A 7-day streak', '🔒 Grow up to Grown-up',
    ], 'unlocked, or what it takes');
    t.eq(m.accessories.map(a => a.button), [
        {label: 'Wear', primary: true}, {label: 'Take off', primary: false}, null,
        {label: 'Wear', primary: true}, null, null,
    ], 'Wear (primary), Take off, and nothing for the locked ones');
    t.eq(m.accessories.map(a => a.worn), [false, true, false, false, false, false], 'worn: the scarf');

    const fresh = wardrobeModel(defaultLifeState(), Mood.normal);
    t.eq(fresh.stickers, {
        title: 'Sticker book — perfect days: 0', empty: 'Finish a whole day\'s plan to earn your first 🌟 sticker.', stars: '', days: '',
    }, 'a new pet has an empty sticker book');
    t.eq(fresh.accessories.every(a => !a.owned && a.button === null && a.status.startsWith('🔒 ')), true, 'and nothing to wear');
    t.eq(fresh.stats[0].value, 'Baby · 0 XP', 'a baby');

    const many = wardrobeModel({...DEMO_LIFE, perfectDays: Array.from({length: 20}, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`)}, Mood.happy);
    t.eq(many.stickers.title, 'Sticker book — perfect days: 20', 'the title counts them all');
    t.eq([many.stickers.stars === '🌟'.repeat(14), many.stickers.days.split(', ')[0], many.stickers.days.split(', ').length],
        [true, '2026-10-07', 14], 'but only the last 14 are shown');
    const master = wardrobeModel({...DEMO_LIFE, xp: 1500, bestStreak: 7, bestCombo: 3}, Mood.normal);
    t.eq([master.stats[0].value, master.accessories[2].owned], ['Master · 1500 XP', false],
        'owned is what the pet unlocked, not what it could earn (Swift: unlocked.contains)');
}

function filterTests(t) {
    t.eq(filterChoices().map(c => c.id), ['all', 'reminders', 'quiet', 'pet'], 'four filters');
    t.eq(filterChoices().map(c => c.label), ['All', 'Reminders', 'Held back', 'Pet'], 'filter labels');
    const kinds = ['bubble', 'response', 'antic', 'hold', 'flow', 'meeting', 'focus', 'mood', 'life', 'distraction', 'sync', 'system'];
    const included = filter => kinds.filter(k => filterIncludes(filter, k));
    t.eq(included('all'), kinds, 'All lets everything through');
    t.eq(included('reminders'), ['bubble', 'response', 'antic'], 'Reminders: bubbles, responses, antics');
    t.eq(included('quiet'), ['hold', 'flow', 'meeting', 'focus'], 'Held back: holds, flow, meetings, focus');
    t.eq(included('pet'), ['mood', 'life', 'distraction'], 'Pet: mood, life, distractions');
    t.eq(filterIncludes('nonsense', 'bubble'), false, 'an unknown filter lets nothing through');

    const entries = sampleDiary();
    t.eq(entries.length, 16, 'the sample diary has 16 entries');
    t.eq(filterEntries(entries, 'all').length, 16, 'All keeps every entry');
    t.eq(filterEntries(entries, 'reminders').map(e => e.kind), ['bubble', 'response', 'bubble', 'response', 'antic'], 'Reminders');
    t.eq(filterEntries(entries, 'quiet').map(e => e.kind), ['flow', 'hold', 'flow', 'meeting', 'focus'], 'Held back');
    t.eq(filterEntries(entries, 'pet').map(e => e.kind), ['life', 'distraction', 'distraction', 'mood'], 'Pet');
    t.eq(filterEntries(entries, 'all') !== entries, true, 'a filter gives a new list');
}

function dayTests(t) {
    t.eq(dayLabel(TODAY, TODAY), 'Today', 'today');
    t.eq(dayLabel('2026-10-27', TODAY), 'Yesterday', 'yesterday');
    t.eq(dayLabel('2026-10-25', TODAY), '2026-10-25', 'any other day shows its date');
    t.eq(dayLabel('2026-10-29', TODAY), '2026-10-29', 'so does a day that has not come yet');
    const days = Array.from({length: 20}, (_, i) => new Date(2026, 9, 28 - i, 12)).map(d =>
        `2026-10-${String(d.getDate()).padStart(2, '0')}`).filter(d => d <= TODAY);
    const choices = dayChoices(days, TODAY);
    t.eq(choices.length, 14, 'the picker lists the last 14 days');
    t.eq(choices.slice(0, 3), [
        {key: '2026-10-28', label: 'Today'}, {key: '2026-10-27', label: 'Yesterday'}, {key: '2026-10-26', label: '2026-10-26'},
    ], 'newest first');
    t.eq(dayChoices([TODAY], TODAY), [{key: TODAY, label: 'Today'}], 'one day, one choice');
}

function rowTests(t) {
    const entries = sampleDiary();
    const {rows, hidden} = diaryRows(entries, 'all');
    t.eq(hidden, 0, 'nothing hidden');
    t.eq(rows.map(r => r.time).slice(0, 4), ['10:44', '10:43', '10:42', '10:41'], 'newest first (Swift: sorted by time, descending)');
    t.eq(rows[0], {id: entries[15].id, time: '10:44', icon: '⚙️', text: 'You came back after 5 minutes', quiet: true},
        'a row: time, icon, text, and whether it is dimmed');
    const byKind = Object.fromEntries(rows.map(r => [r.icon, r.quiet]));
    t.eq([byKind['💬'], byKind['😤'], byKind['🎭'], byKind['🍙'], byKind['👀'], byKind['🔄']], [false, false, false, false, false, false],
        'bubbles, antics, mood, life, distraction and sync are in full color');
    t.eq([byKind['↳'], byKind['⏸'], byKind['🎧'], byKind['📅'], byKind['🍅'], byKind['⚙️']], [true, true, true, true, true, true],
        'responses, holds, flow, meetings, focus and system are dimmed');

    const quiet = diaryRows(entries, 'quiet').rows;
    t.eq(quiet.map(r => r.icon), ['🍅', '📅', '🎧', '⏸', '🎧'], 'a filter picks the rows');
    const shuffled = [entries[3], entries[0], entries[2], entries[1]];
    t.eq(diaryRows(shuffled, 'all').rows.map(r => r.time), ['09:40', '09:12', '09:01', '09:00'], 'sorted by time whatever the order given');
    t.eq(diaryRows([], 'all'), {rows: [], hidden: 0}, 'an empty diary has no rows');

    const many = Array.from({length: 450}, (_, i) => ({
        id: `e${i}`, time: new Date(2026, 9, 28, 8, 0, i), kind: 'bubble', text: `line ${i}`,
    }));
    const capped = diaryRows(many, 'all');
    t.eq([DIARY.maxRows, capped.rows.length, capped.hidden], [300, 300, 150], 'a very long day shows the newest 300 and counts the rest');
    t.eq(capped.rows[0].id, 'e449', 'the newest first');
    t.eq(diaryRows(many, 'pet').hidden, 0, 'a filter that matches nothing hides nothing');

    t.eq(entriesSignature(entries, 'all', TODAY) === entriesSignature(entries.slice(), 'all', TODAY), true, 'the same entries: the same signature');
    t.eq(entriesSignature(entries, 'all', TODAY) !== entriesSignature(entries.slice(0, 15), 'all', TODAY), true, 'a new entry changes it');
    t.eq(entriesSignature(entries, 'all', TODAY) !== entriesSignature(entries, 'quiet', TODAY), true, 'so does the filter');
    t.eq(entriesSignature(entries, 'all', TODAY) !== entriesSignature(entries, 'all', '2026-10-27'), true, 'and the day');
    t.eq(entriesSignature([], 'all', TODAY), entriesSignature([], 'all', TODAY), 'an empty diary has one');
}

function diaryModelTests(t) {
    const entries = sampleDiary();
    const base = {entries, day: TODAY, today: TODAY, days: [TODAY], filter: 'all', copied: false, folder: null};
    const m = diaryModel(base);
    t.eq(m.title, '📜 Pet diary', 'title');
    t.eq(m.dayLabel, 'Today', 'the picker shows today');
    t.eq(m.days, [{key: TODAY, label: 'Today'}], 'the days to pick from');
    t.eq(m.summary, '💬 2 reminders · you ignored 1, closed 0 · ⏸ held 1× · 🎧 in the zone 1× (0h52) · 😤 1 antic(s) · 👀 distracted 8\'',
        'the summary counts the whole day');
    t.eq(diaryModel({...base, filter: 'pet'}).summary, m.summary, 'a filter does not change the summary');
    t.eq(m.filters.map(f => f.label), ['All', 'Reminders', 'Held back', 'Pet'], 'filters');
    t.eq(m.filter, 'all', 'the chosen filter');
    t.eq(m.empty, null, 'there are entries');
    t.eq(m.rows.length, 16, 'rows');
    t.eq(m.copy, {label: 'Copy', tooltip: 'Copy the whole day to paste into Claude when tuning the pet'}, 'copy');
    t.eq(diaryModel({...base, copied: true}).copy.label, 'Copied ✔︎', 'copied');
    t.eq(m.folder, null, 'no folder: no Open folder button');
    t.eq(diaryModel({...base, folder: '/tmp/x/log'}).folder, {label: 'Open folder'}, 'a folder: Open folder');
    t.eq(m.note, 'Stored on this computer only, kept 14 days. Paste it into Claude when you want to tune the pet.', 'the note');
    t.eq(diaryModel({...base, entries: []}).empty, 'Nothing in the diary yet.', 'an empty diary says so');
    t.eq(diaryModel({...base, filter: 'reminders', entries: entries.filter(e => e.kind === 'mood')}).empty,
        'Nothing in the diary yet.', 'so does a filter that matches nothing');
    t.eq(diaryModel({...base, entries: sampleDiary(), day: '2026-10-27'}).dayLabel, 'Yesterday', 'another day: its label');
    t.eq(diaryModel({...base, days: [TODAY, '2026-10-27', '2026-10-20'], day: '2026-10-20'}).dayLabel, '2026-10-20',
        'an older day shows its date');
    const more = diaryModel({...base, entries: Array.from({length: 450}, (_, i) => ({
        id: `e${i}`, time: new Date(2026, 9, 28, 8, 0, i), kind: 'bubble', text: `line ${i}`,
    }))});
    t.eq([more.rows.length, more.hiddenNote], [300, '… 150 older entries (Copy has them all)'], 'rows past the cap are announced');
    t.eq(m.hiddenNote, null, 'no note when nothing is hidden');
}

function folderTests(t) {
    t.eq(folderURI('/home/me/.local/share/todopet/log'), 'file:///home/me/.local/share/todopet/log', 'a folder as a file:// URI');
    t.eq(folderURI('/tmp/with space/log'), 'file:///tmp/with%20space/log', 'spaces are escaped');
    t.eq(folderURI(null), null, 'no folder, no URI');
    const files = {dir: '/home/me/.local/share/todopet/log', append: async () => {}, read: async () => '', list: async () => [], remove: async () => {}};
    t.eq(new PetLog({files}).folder, '/home/me/.local/share/todopet/log', 'the diary\'s folder is its files\' folder');
    t.eq(new PetLog().folder, null, 'a diary that is only in memory has no folder');
}

function vietnameseTests(t) {
    setLang('vi');
    t.eq(templateSteps('Báo cáo'), [
        'Chuẩn bị mọi thứ cần cho “Báo cáo” (10\')', 'Làm bản nháp đầu tiên thật nhanh (25\')', 'Hoàn thiện và đánh dấu xong',
    ], 'VI template');
    t.eq([stepPlaceholder(0), stepPlaceholder(1), stepPlaceholder(2), stepPlaceholder(3)], [
        'vd: Mở file và đọc lại yêu cầu (10\')', 'vd: Viết dàn ý 5 gạch đầu dòng', 'vd: Làm phần dễ nhất trong 25\'', 'Bước tiếp theo',
    ], 'VI hints');
    t.eq(stuckLine(4), '⏳ Đã nằm trong danh sách 4 ngày', 'VI stuck');
    t.eq(saveFailedText(null), 'Không thêm được vào Todoist.', 'VI save failed');
    const m = splitModel({task: REPLY, stuckDays: 4, hasClaudeKey: false, steps: ['a'], firstToday: true, asking: false,
        saving: false, error: null, confirming: true});
    t.eq([m.title, m.ask.label, m.ask.tooltip, m.template, m.addStep.label, m.firstToday.label, m.drop.label, m.drop.tooltip,
        m.deleteTooltip, m.save.label], [
        'Chia nhỏ việc ✂️', '✨ Nhờ Claude gợi ý', 'Gửi tên và ghi chú của việc tới Claude API', 'Mẫu nhanh', 'Thêm bước',
        'Đưa bước 1 vào kế hoạch hôm nay', 'Bỏ khỏi kế hoạch', 'Bỏ hạn của việc (vẫn giữ trong Todoist)', 'Xoá việc', 'Thêm vào Todoist',
    ], 'VI split view');
    t.eq(m.intro, 'Việc to hay mơ hồ thì khó bắt đầu. Mỗi bước nên xong trong 15–30 phút, bước 1 càng dễ càng tốt.', 'VI intro');
    t.eq(m.keyHint, 'Thêm API key Claude trong Cài đặt để nhận gợi ý tự động.', 'VI key hint');
    t.eq([m.confirm.cancel, m.confirm.delete], ['Huỷ', 'Xoá'], 'VI delete question buttons');

    const w = wardrobeModel(DEMO_LIFE, Mood.normal);
    t.eq(w.title, 'Tủ đồ & thành tích', 'VI wardrobe title');
    t.eq(w.stats.map(s => `${s.label}: ${s.value}`), [
        'Giai đoạn: Thiếu niên · 320 XP', 'Việc đã xong: 31', 'Chuỗi ngày: 4 (kỷ lục 4)', 'Combo cao nhất: ×2', 'Bánh vàng hiếm: 1',
    ], 'VI stats');
    t.eq(w.stickers.title, 'Sổ sticker — ngày làm trọn kế hoạch: 3', 'VI sticker book');
    t.eq(wardrobeModel(defaultLifeState(), Mood.normal).stickers.empty, 'Làm xong hết kế hoạch một ngày để nhận sticker 🌟 đầu tiên.',
        'VI empty sticker book');
    t.eq(w.accessories.map(a => [a.name, a.status, a.button?.label ?? null]), [
        ['Nơ xinh', 'Đã mở khoá', 'Đeo'], ['Khăn quàng', 'Đã mở khoá', 'Cởi ra'],
        ['Kính râm ngầu', '🔒 Combo ×3', null], ['Mũ quý ông', 'Đã mở khoá', 'Đeo'],
        ['Vương miện', '🔒 Chuỗi 7 ngày đạt mục tiêu', null], ['Mũ tốt nghiệp', '🔒 Lớn tới giai đoạn Trưởng thành', null],
    ], 'VI accessories');

    t.eq(filterChoices().map(c => c.label), ['Tất cả', 'Nhắc & quậy', 'Im lặng', 'Pet'], 'VI filters');
    t.eq([dayLabel(TODAY, TODAY), dayLabel('2026-10-27', TODAY)], ['Hôm nay', 'Hôm qua'], 'VI day labels');
    const d = diaryModel({entries: [], day: TODAY, today: TODAY, days: [TODAY], filter: 'all', copied: true, folder: '/x'});
    t.eq([d.title, d.empty, d.copy.label, d.copy.tooltip, d.folder.label], [
        '📜 Nhật ký pet', 'Chưa có gì trong nhật ký.', 'Đã sao chép ✔︎', 'Sao chép cả ngày để dán cho Claude khi muốn chỉnh pet', 'Mở thư mục',
    ], 'VI diary');
    t.eq(d.note, 'Chỉ lưu trên máy này, giữ 14 ngày. Dán cho Claude khi muốn chỉnh ngưỡng nhắc.', 'VI note');
    t.eq(diaryModel({entries: [], day: TODAY, today: TODAY, days: [TODAY], filter: 'all', copied: false, folder: null}).summary,
        '💬 0 lời nhắc', 'VI summary');
}

export default async function (t) {
    const savedLang = getLang();
    setLang('en');
    try {
        stepTests(t);
        messageTests(t);
        splitModelTests(t);
        wardrobeTests(t);
        filterTests(t);
        dayTests(t);
        rowTests(t);
        diaryModelTests(t);
        folderTests(t);
        vietnameseTests(t);
    } finally {
        setLang(savedLang);
    }
}
