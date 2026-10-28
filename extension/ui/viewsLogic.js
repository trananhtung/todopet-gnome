// The three pages of the task board, as data (port of the logic of BreakdownView in PlanningViews.swift, WardrobeView
// in LifeViews.swift and LogView in LogView.swift): the quick template and the step list, what the wardrobe shows
// for a pet, the diary's filters, day picker and rows. Every string goes through L() with Swift's Vietnamese. No
// Shell imports, so plain gjs tests it; the views (ui/splitView.js, ui/wardrobe.js, ui/diary.js) only draw it.
//
//   splitModel({task, stuckDays, hasClaudeKey, steps, firstToday, asking, saving, error, confirming}) -> the split view
//   templateSteps(title), stepPlaceholder(i), filledSteps(texts), addStep/removeStep(steps, ...), stepsFromSuggestion(list)
//   wardrobeModel(lifeState, mood) -> stats, sticker book, accessories with their Wear / Take off button
//   diaryModel({entries, day, today, days, filter, copied, folder}) -> title, day picker, summary, rows, buttons, note
//   filterIncludes(filter, kind), filterEntries(entries, filter), diaryRows(entries, filter), entriesSignature(...)
//   folderURI(dir) -> "file://..." for Open folder
import Gio from 'gi://Gio';

import {LOG_KINDS, LogSummary} from '../core/diary.js';
import {daysBetween, shortText, timeString} from '../core/dates.js';
import {L} from '../core/l10n.js';
import {
    ACCESSORIES, accessoryEmoji, accessoryName, accessoryRequirement, lifeStage, stageName,
} from '../core/life.js';
import {Lines} from '../core/lines.js';
import {Mood} from '../core/mood.js';

// --- The split view ---

// Swift: `steps.count < 6` hides "Add a step"; the view starts with three blank steps.
export const SPLIT = Object.freeze({maxSteps: 6, startSteps: 3});

export const emptySteps = () => Array.from({length: SPLIT.startSteps}, () => '');

// Swift: fillTemplate(). The title is cut to 40 characters.
export function templateSteps(title) {
    const t = shortText(title, 40);
    return [
        L(`Chuẩn bị mọi thứ cần cho “${t}” (10')`, `Gather what you need for “${t}” (10')`),
        L('Làm bản nháp đầu tiên thật nhanh (25\')', 'Make a quick first draft (25\')'),
        L('Hoàn thiện và đánh dấu xong', 'Polish it and mark it done'),
    ];
}

// The hint in the empty field of step `index` (0 based).
export function stepPlaceholder(index) {
    const hints = [
        L('vd: Mở file và đọc lại yêu cầu (10\')', 'e.g. Open the file and reread the brief (10\')'),
        L('vd: Viết dàn ý 5 gạch đầu dòng', 'e.g. Write a 5-bullet outline'),
        L('vd: Làm phần dễ nhất trong 25\'', 'e.g. Do the easiest part in 25\''),
    ];
    return hints[index] ?? L('Bước tiếp theo', 'Next step');
}

// What is saved: the steps with something in them, trimmed (Swift: `filled`).
export const filledSteps = texts => texts.map(s => s.trim()).filter(s => s !== '');

export const canAddStep = count => count < SPLIT.maxSteps;
export const canRemoveStep = count => count > 1;

// The list with a blank step at the end, or the same steps (a copy) once there are 6.
export const addStep = steps => (canAddStep(steps.length) ? [...steps, ''] : [...steps]);

// The list without step `index`; the last step stays, and a step that is not there changes nothing. Always a copy.
export const removeStep = (steps, index) => (canRemoveStep(steps.length) ? steps.filter((_, i) => i !== index) : [...steps]);

// Claude's answer as the step list: the text ones, and at least one field to type in.
export function stepsFromSuggestion(list) {
    const steps = (Array.isArray(list) ? list : []).filter(s => typeof s === 'string');
    return steps.length > 0 ? steps : [''];
}

// What the user reads when Claude (or the keyring) fails: a ClaudeError has its own text for the user.
export function splitErrorText(error) {
    if (typeof error?.userMessage === 'string' && error.userMessage !== '')
        return error.userMessage;
    return typeof error?.message === 'string' ? error.message : String(error);
}

// Swift: `brain.errorText ?? L("Không thêm được vào Todoist.", "Couldn't add to Todoist.")`.
export const saveFailedText = errorText => errorText ?? L('Không thêm được vào Todoist.', 'Couldn\'t add to Todoist.');

// "⏳ On your list for 4 days"; null when the task is not stuck.
export const stuckLine = days => (days === null || days === undefined ? null :
    `⏳ ${L(`Đã nằm trong danh sách ${days} ngày`, `On your list for ${days} days`)}`);

// The whole split view as data. `stuckDays`: how long the task has been on the list (null when it is not stuck).
export function splitModel({task, stuckDays, hasClaudeKey, steps, firstToday, asking, saving, error, confirming}) {
    const count = steps.length;
    return {
        title: L('Chia nhỏ việc ✂️', 'Split a task ✂️'),
        task: task.title,
        stuck: stuckLine(stuckDays),
        intro: L('Việc to hay mơ hồ thì khó bắt đầu. Mỗi bước nên xong trong 15–30 phút, bước 1 càng dễ càng tốt.',
            'Big or vague tasks are hard to start. Each step should take 15–30 minutes; make step 1 as easy as possible.'),
        ask: {
            label: L('✨ Nhờ Claude gợi ý', '✨ Ask Claude'),
            enabled: !asking && Boolean(hasClaudeKey),
            busy: Boolean(asking),
            tooltip: L('Gửi tên và ghi chú của việc tới Claude API', 'Sends the task\'s title and notes to the Claude API'),
        },
        template: L('Mẫu nhanh', 'Quick template'),
        keyHint: hasClaudeKey ? null
            : L('Thêm API key Claude trong Cài đặt để nhận gợi ý tự động.', 'Add a Claude API key in Settings for automatic suggestions.'),
        rows: steps.map((_, i) => ({number: `${i + 1}.`, placeholder: stepPlaceholder(i), removable: canRemoveStep(count)})),
        addStep: {visible: canAddStep(count), label: L('Thêm bước', 'Add a step')},
        firstToday: {label: L('Đưa bước 1 vào kế hoạch hôm nay', 'Put step 1 on today\'s plan'), checked: Boolean(firstToday)},
        error: error ? `⚠️ ${error}` : null,
        confirm: confirming ? {text: Lines.confirmDelete(task), cancel: L('Huỷ', 'Cancel'), delete: L('Xoá', 'Delete')} : null,
        drop: {
            label: L('Bỏ khỏi kế hoạch', 'Drop from plan'),
            tooltip: L('Bỏ hạn của việc (vẫn giữ trong Todoist)', 'Removes the due date (the task stays in Todoist)'),
        },
        deleteTooltip: L('Xoá việc', 'Delete task'),
        save: {
            label: L('Thêm vào Todoist', 'Add to Todoist'),
            enabled: filledSteps(steps).length > 0 && !saving,
            busy: Boolean(saving),
        },
    };
}

// --- The wardrobe ---

// The sticker book shows the last 14 perfect days.
const STICKERS_SHOWN = 14;

// Swift: WardrobeView. `s` is the pet's life state. An accessory is owned when the pet unlocked it (not merely when
// it could earn it now); only owned ones have a button.
export function wardrobeModel(s, mood) {
    const stage = lifeStage(s);
    const days = s.perfectDays.slice(-STICKERS_SHOWN);
    const count = s.perfectDays.length;
    return {
        title: L('Tủ đồ & thành tích', 'Wardrobe & achievements'),
        previewMood: mood === Mood.sleeping ? Mood.normal : mood,
        stats: [
            {icon: '⭐', label: L('Giai đoạn', 'Stage'), value: `${stageName(stage)} · ${s.xp} XP`},
            {icon: '✅', label: L('Việc đã xong', 'Tasks done'), value: `${s.totalDone}`},
            {icon: '🔥', label: L('Chuỗi ngày', 'Streak'),
                value: L(`${s.streak} (kỷ lục ${s.bestStreak})`, `${s.streak} (best ${s.bestStreak})`)},
            {icon: '⚡️', label: L('Combo cao nhất', 'Best combo'), value: `×${s.bestCombo}`},
            {icon: '🍰', label: L('Bánh vàng hiếm', 'Golden treats'), value: `${s.goldens}`},
        ],
        stickers: {
            title: L(`Sổ sticker — ngày làm trọn kế hoạch: ${count}`, `Sticker book — perfect days: ${count}`),
            empty: count === 0
                ? L('Làm xong hết kế hoạch một ngày để nhận sticker 🌟 đầu tiên.', 'Finish a whole day\'s plan to earn your first 🌟 sticker.')
                : null,
            stars: days.map(() => '🌟').join(''),
            days: days.join(', '),
        },
        accessories: ACCESSORIES.map(id => {
            const owned = s.unlocked.includes(id);
            const worn = s.wearing.includes(id);
            return {
                id,
                emoji: accessoryEmoji(id),
                name: accessoryName(id),
                owned,
                worn,
                status: owned ? L('Đã mở khoá', 'Unlocked') : `🔒 ${accessoryRequirement(id)}`,
                button: owned ? {label: worn ? L('Cởi ra', 'Take off') : L('Đeo', 'Wear'), primary: !worn} : null,
            };
        }),
    };
}

// --- The diary ---

export const DIARY = Object.freeze({
    // Days in the picker (Swift: log.days().prefix(14)).
    pickerDays: 14,
    // The list draws at most this many rows (the newest). Swift's LazyVStack only builds what is on screen; St would
    // build every row, and a busy day has up to 1000 entries.
    maxRows: 300,
});

// [id, [vi, en], kinds it lets through]; null kinds: everything.
const FILTERS = Object.freeze([
    ['all', ['Tất cả', 'All'], null],
    ['reminders', ['Nhắc & quậy', 'Reminders'], ['bubble', 'response', 'antic']],
    ['quiet', ['Im lặng', 'Held back'], ['hold', 'flow', 'meeting', 'focus']],
    ['pet', ['Pet', 'Pet'], ['mood', 'life', 'distraction']],
]);

// Rows of these kinds are drawn in the dim color.
const QUIET_KINDS = Object.freeze(['hold', 'flow', 'meeting', 'focus', 'system', 'response']);

export const filterChoices = () => FILTERS.map(([id, [vi, en]]) => ({id, label: L(vi, en)}));

export function filterIncludes(filter, kind) {
    const row = FILTERS.find(([id]) => id === filter);
    if (!row)
        return false;
    return row[2] === null || row[2].includes(kind);
}

export const filterEntries = (entries, filter) => entries.filter(e => filterIncludes(filter, e.kind));

// "Today", "Yesterday", or the day's own key.
export function dayLabel(key, today) {
    switch (daysBetween(key, today)) {
    case 0:
        return L('Hôm nay', 'Today');
    case 1:
        return L('Hôm qua', 'Yesterday');
    default:
        return key;
    }
}

// The picker's choices: the newest 14 of `days` (newest first, as the diary lists them).
export const dayChoices = (days, today) => days.slice(0, DIARY.pickerDays).map(key => ({key, label: dayLabel(key, today)}));

// The rows of the list: the entries the filter lets through, newest first, at most DIARY.maxRows of them; `hidden`
// counts the older ones that are left out.
export function diaryRows(entries, filter) {
    const sorted = filterEntries(entries, filter).sort((a, b) => b.time.getTime() - a.time.getTime());
    const rows = sorted.slice(0, DIARY.maxRows).map(e => ({
        id: e.id,
        time: timeString(e.time),
        icon: LOG_KINDS[e.kind] ?? '',
        text: e.text,
        quiet: QUIET_KINDS.includes(e.kind),
    }));
    return {rows, hidden: sorted.length - rows.length};
}

// Changes whenever what the list shows changes (entries are only ever added at the end): lets the view skip a redraw.
export function entriesSignature(entries, filter, day) {
    return `${day}|${filter}|${entries.length}|${entries.at(-1)?.id ?? ''}`;
}

// The whole diary page as data. `entries` are the shown day's (all kinds), `days` the days that have a file, `folder`
// the diary's folder (null when it is only in memory).
export function diaryModel({entries, day, today, days, filter, copied, folder}) {
    const {rows, hidden} = diaryRows(entries, filter);
    return {
        title: L('📜 Nhật ký pet', '📜 Pet diary'),
        dayLabel: dayLabel(day, today),
        days: dayChoices(days, today),
        summary: new LogSummary(entries).text,
        filters: filterChoices(),
        filter,
        rows,
        hiddenNote: hidden > 0
            ? L(`… còn ${hidden} dòng cũ hơn (Sao chép có đủ)`, `… ${hidden} older entries (Copy has them all)`) : null,
        empty: rows.length === 0 ? L('Chưa có gì trong nhật ký.', 'Nothing in the diary yet.') : null,
        copy: {
            label: copied ? L('Đã sao chép ✔︎', 'Copied ✔︎') : L('Sao chép', 'Copy'),
            tooltip: L('Sao chép cả ngày để dán cho Claude khi muốn chỉnh pet',
                'Copy the whole day to paste into Claude when tuning the pet'),
        },
        folder: folder ? {label: L('Mở thư mục', 'Open folder')} : null,
        note: L('Chỉ lưu trên máy này, giữ 14 ngày. Dán cho Claude khi muốn chỉnh ngưỡng nhắc.',
            'Stored on this computer only, kept 14 days. Paste it into Claude when you want to tune the pet.'),
    };
}

// "file:///.../log" for a folder path; null without a folder.
export const folderURI = dir => (dir ? Gio.File.new_for_path(dir).get_uri() : null);
