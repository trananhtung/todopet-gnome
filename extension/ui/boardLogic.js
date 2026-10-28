// The task board's pure parts (port of the data side of BoardView, FrogCard, TaskRow, AddTaskRow in BoardView.swift,
// CalendarCard in PlanningViews.swift and LifeBar in LifeViews.swift): where the board goes, how tall its task list
// may be, and boardModel(), which turns the brain's state into plain data the view (ui/board.js) only has to draw.
// No Shell imports, so plain gjs tests it.
//
//   placeBoard({petFrame, size, workArea, unit}) -> {x, y, side}   above the pet, else beside it, inside the work area
//   listHeight({natural, others, available, unit}) -> px             the scrolling task list's height
//   boardModel({brain, prefs, now, hasJoinLinks, confirmId, showDone}) -> the whole board as data, by section:
//     header, life, view ('setup' | 'tasks'), demo, nag, frog, calendar, lists {overdue, today, done}, error, footer
//   Task rows keep their Task (`task`) for the actions.
import {atHour, daysAgo, timeString} from '../core/dates.js';
import {currentEvent, freeMinutes, hoursText, nextEvent} from '../core/calendarMath.js';
import {L} from '../core/l10n.js';
import {STAGE_THRESHOLDS, distractionTotal, lifeStage, stageName, stageNextXP} from '../core/life.js';
import {Lines} from '../core/lines.js';
import {moodEmoji, moodLabel} from '../core/mood.js';

export const BOARD = Object.freeze({
    // Swift: .frame(width: 370); the stylesheet sets it.
    width: 370,
    // The task list scrolls past this height (Swift: .frame(maxHeight: 220)); on a short screen it may shrink to
    // listMin so the whole board still fits.
    listCap: 220,
    listMin: 80,
    // Space kept from the work area's edges, and between the board and the pet.
    margin: 8,
    gap: 6,
    // The pet's body starts this far down its frame (Swift: PetHitView, the lower 72%).
    bodyTop: 0.28,
    // At most 10 renders a second while the brain changes.
    renderMs: 100,
    // The header's little pet is redrawn 10 times a second while the board is open.
    miniPetMs: 100,
    todoistURL: 'https://app.todoist.com/app/today',
    tokenURL: 'https://app.todoist.com/app/settings/integrations/developer',
});

// --- Placement ---

// Where the board goes (stage pixels), as Swift's popover with preferredEdge .maxY: above the pet, centered on it,
// ending just over its body. Without room above, beside the pet on the side with more room, its bottom edge level
// with the pet's; without room there either, over the pet. Always inside the work area (8 px from its edges). With
// no pet on screen, the top right corner, under the panel (where the indicator is).
export function placeBoard({petFrame, size, workArea: wa, unit = 1}) {
    const margin = BOARD.margin * unit;
    const gap = BOARD.gap * unit;
    const {width, height} = size;
    const minX = wa.x + margin;
    const maxX = wa.x + wa.width - margin - width;
    const minY = wa.y + margin;
    const maxY = wa.y + wa.height - margin - height;
    const clampX = x => Math.round(Math.max(minX, Math.min(x, maxX)));
    const clampY = y => Math.round(Math.max(minY, Math.min(y, maxY)));

    if (!petFrame)
        return {x: clampX(maxX), y: clampY(minY), side: 'corner'};

    const center = petFrame.x + petFrame.width / 2;
    const bottom = petFrame.y + Math.round(petFrame.height * BOARD.bodyTop) - gap;
    if (bottom - height >= minY)
        return {x: clampX(center - width / 2), y: Math.round(Math.min(bottom, wa.y + wa.height - margin) - height), side: 'above'};

    const level = clampY(petFrame.y + petFrame.height - height);
    const roomLeft = petFrame.x - gap - minX;
    const roomRight = wa.x + wa.width - margin - (petFrame.x + petFrame.width + gap);
    if (Math.max(roomLeft, roomRight) >= width) {
        if (roomLeft >= roomRight)
            return {x: Math.round(petFrame.x - gap - width), y: level, side: 'left'};
        return {x: Math.round(petFrame.x + petFrame.width + gap), y: level, side: 'right'};
    }
    return {x: clampX(center - width / 2), y: level, side: 'over'};
}

// The task list's height: its own (`natural`), at most 220 px; when the rest of the board (`others`) leaves less room
// than that in the `available` height, less, but never under 80 px (or under its own height when that is smaller).
export function listHeight({natural, others, available, unit = 1}) {
    const wanted = Math.min(natural, BOARD.listCap * unit);
    return Math.max(Math.min(wanted, available - others), Math.min(natural, BOARD.listMin * unit));
}

// --- Header ---

// One dot per task of the day (Swift: max(target, planned) circles): 'done' (green), 'planned' (filled), 'open'
// (dashed: a task still missing from the plan).
export function dayDots({completed, planned, target}) {
    const count = Math.max(target, planned);
    return Array.from({length: count}, (_, i) => {
        if (i < completed)
            return 'done';
        return i < planned ? 'planned' : 'open';
    });
}

export function progressText({completed, planned, target}) {
    const of = Math.max(planned, target);
    return L(`Xong ${completed}/${of} hôm nay`, `${completed}/${of} done today`);
}

// The mood's biggest reason under the title: ▲ when it adds points, ▼ when it costs some.
export function reasonLine(reasons) {
    const r = reasons?.[0];
    if (!r)
        return null;
    return {label: `${r.delta > 0 ? '▲' : '▼'} ${r.text}`, up: r.delta > 0};
}

// The hover breakdown of the reason line: every reason with its points, one per line.
export function reasonBreakdown(reasons) {
    return (reasons ?? []).map(r => `${r.delta > 0 ? '+' : ''}${r.delta}  ${r.text}`).join('\n');
}

// --- Life bar (Swift: LifeBar) ---

const MINUTE_SECONDS = 60;

export function lifeModel(s) {
    const tone = s.satiety < 30 ? 'red' : s.satiety < 60 ? 'orange' : 'green';
    const stage = lifeStage(s);
    const next = stageNextXP(stage);
    let bar;
    if (next === null) {
        bar = {label: `⭐ ${stageName(stage)}`, fraction: null, xp: `${s.xp} XP · MAX`};
    } else {
        const base = STAGE_THRESHOLDS[stage];
        bar = {label: `⭐ ${stageName(stage)}`, fraction: (s.xp - base) / (next - base), xp: `${s.xp}/${next} XP`};
    }
    let distraction = null;
    if (distractionTotal(s) >= MINUTE_SECONDS) {
        const top = Object.entries(s.distraction)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([label, seconds]) => `${label} ${Math.trunc(seconds / MINUTE_SECONDS)}'`)
            .join(' · ');
        distraction = `👀 ${L('Xao nhãng hôm nay: ', 'Distracted today: ')}${top}`;
    }
    return {
        satiety: {text: `${Math.trunc(s.satiety)}%`, fraction: Math.min(Math.max(s.satiety / 100, 0), 1), tone},
        dirt: s.dirt > 0 ? `🪰 ×${s.dirt}` : null,
        streak: s.streak > 0 ? `🔥 ${s.streak}` : null,
        stage: bar,
        distraction,
        wardrobe: L('👗 Tủ đồ', '👗 Wardrobe'),
    };
}

// --- Task rows (Swift: TaskRow) ---

// One row: the title, the details under it (time, how late, how long it keeps being pushed, repeat, labels), where
// "move" sends it (an overdue task to today, another one to tomorrow; a recurring one stays) and, while it asks,
// the delete confirmation.
export function taskRow(task, {overdue, stuckDays = null, now, confirming = false}) {
    const meta = [];
    const time = task.dueTime;
    if (time)
        meta.push({kind: 'time', text: timeString(time)});
    if (overdue && task.dueDay)
        meta.push({kind: 'ago', text: daysAgo(task.dueDay, now)});
    if (stuckDays !== null)
        meta.push({kind: 'stuck', text: L(`⏳ dời ${stuckDays} ngày`, `⏳ ${stuckDays} days`)});
    if (task.isRecurring)
        meta.push({kind: 'repeat', text: ''});
    for (const label of task.labels ?? [])
        meta.push({kind: 'label', text: `@${label}`});
    let move = null;
    if (!task.isRecurring) {
        move = overdue
            ? {due: 'today', tooltip: L('Dời vào hôm nay', 'Move to today')}
            : {due: 'tomorrow', tooltip: L('Dời sang mai', 'Move to tomorrow')};
    }
    return {
        task,
        id: task.id,
        title: task.title,
        priority: task.uiPriority,
        overdue,
        meta,
        move,
        confirm: confirming ? Lines.confirmDelete(task) : null,
    };
}

// --- Calendar card (Swift: CalendarCard) ---

// The meeting going on or the next one (with its join link when the calendar can have them), the free time until
// the end of the work day, and the suggested time blocks.
export function calendarModel({events, suggestions, now, prefs, target, hasJoinLinks}) {
    const meetingOf = (event, label) => ({
        label, title: event.title, joinURL: hasJoinLinks && event.joinURL ? event.joinURL : null,
    });
    let meeting = null;
    const current = currentEvent(events, now);
    const next = current ? null : nextEvent(events, now);
    if (current)
        meeting = meetingOf(current, L(`Đang họp đến ${timeString(current.end)}`, `In a meeting until ${timeString(current.end)}`));
    else if (next)
        meeting = meetingOf(next, L(`Họp tiếp lúc ${timeString(next.start)}`, `Next meeting at ${timeString(next.start)}`));

    const end = atHour(prefs.workEnd, 0, now);
    const workStart = atHour(prefs.workStart, 0, now);
    const from = now > workStart ? now : workStart;
    const free = hoursText(Math.max(0, freeMinutes(events, from, end)));
    let summary = L(`Còn trống ${free} đến ${timeString(end)}`, `${free} free until ${timeString(end)}`);
    if (target < prefs.dailyTarget)
        summary += L(` · nhiều họp nên mục tiêu hôm nay: ${target} việc`, ` · busy day, so today's target: ${target}`);

    return {
        meeting,
        none: meeting ? null : `📅 ${L('Không còn cuộc họp nào hôm nay', 'No more meetings today')}`,
        summary,
        blocksTitle: L('Gợi ý khung giờ', 'Suggested time blocks'),
        blocks: suggestions.map(slot => ({
            slot, time: `${timeString(slot.start)}–${timeString(slot.end)}`, title: slot.task.title,
        })),
    };
}

// --- Add row (Swift: AddTaskRow) ---

export function dueChoices() {
    return [
        {id: 'today', label: L('Hôm nay', 'Today')},
        {id: 'tomorrow', label: L('Ngày mai', 'Tomorrow')},
        {id: 'none', label: L('Không hạn', 'No date')},
        {id: 'smart', label: L('✨ Cú pháp Todoist', '✨ Todoist syntax')},
    ];
}

// P1 is Todoist's API priority 4 (Swift's Picker tags).
export function priorityChoices() {
    return [{value: 4, label: 'P1'}, {value: 3, label: 'P2'}, {value: 2, label: 'P3'}, {value: 1, label: 'P4'}];
}

export function addPlaceholder(due) {
    return due === 'smart'
        ? L('vd: Gọi khách 3pm p1 #Work', 'e.g. Call client 3pm p1 #Work')
        : L('Thêm việc… (Enter để lưu)', 'Add a task… (Enter to save)');
}

const KEY_NAMES = Object.freeze({control: 'Ctrl', ctrl: 'Ctrl', primary: 'Ctrl', alt: 'Alt', shift: 'Shift',
    super: 'Super', meta: 'Meta', hyper: 'Hyper'});

// '<Control><Super>t' -> 'Ctrl+Super+T': the first board shortcut, for the hint next to the add row.
export function hotkeyLabel(accels) {
    const accel = (accels ?? [])[0] ?? '';
    const parts = [];
    const key = accel.replace(/<([^>]+)>/g, (_m, name) => {
        parts.push(KEY_NAMES[name.toLowerCase()] ?? name);
        return '';
    });
    if (key === '')
        return '';
    parts.push(key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1));
    return parts.join('+');
}

// --- The whole board ---

// `brain` needs: hasToken, demo, mood, reasons, streak, day, target, life.state, errorText, events, suggestions,
// stuckTasks, focusSession, loading, lastSync. `prefs`: petName, focusMinutes, useCalendar, workStart, workEnd,
// dailyTarget. `confirmId` is the task whose deletion is being confirmed; `showDone` opens "Done today".
export function boardModel({brain, prefs, now, hasJoinLinks, confirmId = null, showDone = false}) {
    const day = brain.day;
    const target = brain.target;
    const completed = day.completed.length;
    const planned = day.planned;
    const focus = brain.focusSession;
    const tasks = brain.hasToken;

    const header = {
        title: `${prefs.petName} ${moodLabel(brain.mood)} ${moodEmoji(brain.mood)}`,
        dots: dayDots({completed, planned, target}),
        progress: progressText({completed, planned, target}),
        reason: reasonLine(brain.reasons),
        breakdown: reasonBreakdown(brain.reasons),
        streak: brain.streak > 0 ? {value: `🔥 ${brain.streak}`, label: L('ngày liên tiếp', 'day streak')} : null,
    };

    const stuck = new Map((brain.stuckTasks ?? []).map(s => [s.task.id, s.days]));
    const row = (task, overdue) => taskRow(task, {
        overdue, stuckDays: stuck.get(task.id) ?? null, now, confirming: task.id === confirmId,
    });
    const next = day.next;
    const lists = {
        overdue: day.overdue.length === 0 ? null : {
            title: `${L('Quá hạn', 'Overdue')} · ${day.overdue.length}`,
            moveAll: day.overdue.some(t => !t.isRecurring) ? L('Dời hết vào hôm nay', 'Move all to today') : null,
            rows: day.overdue.map(t => row(t, true)),
        },
        today: {
            title: `${L('Hôm nay', 'Today')} · ${day.today.length}`,
            empty: day.today.length === 0 ? L('Chưa có việc nào cho hôm nay.', 'Nothing planned for today yet.') : null,
            rows: day.today.map(t => row(t, false)),
        },
        done: completed === 0 ? null : {
            label: L(`Đã xong hôm nay (${completed})`, `Done today (${completed})`),
            open: showDone,
            titles: day.completed.map(t => t.title),
        },
    };

    let focusButton;
    if (focus)
        focusButton = {label: focus.isBreak ? L('Dừng nghỉ', 'End break') : L('Dừng tập trung', 'Stop focus'), stop: true, enabled: true};
    else
        focusButton = {label: L(`Tập trung ${prefs.focusMinutes}'`, `Focus ${prefs.focusMinutes}'`), stop: false, enabled: tasks};

    return {
        header,
        life: tasks ? lifeModel(brain.life.state) : null,
        view: tasks ? 'tasks' : 'setup',
        demo: brain.demo ? L('Đang chạy chế độ demo — dữ liệu giả.', 'Demo mode — sample data.') : null,
        nag: planned < target
            ? L(`Hôm nay mới có ${planned}/${target} việc. Thêm việc quan trọng nhất trước nhé!`,
                `Only ${planned}/${target} tasks planned. Add the most important one first!`)
            : null,
        frog: next ? {
            task: next,
            label: L('Làm ngay việc này', 'Do this first'),
            title: next.title,
            focus: focus ? null : `▶︎ ${prefs.focusMinutes}'`,
        } : null,
        calendar: prefs.useCalendar
            ? calendarModel({events: brain.events, suggestions: brain.suggestions, now, prefs, target, hasJoinLinks})
            : null,
        lists,
        error: brain.errorText ? `⚠️ ${brain.errorText}` : null,
        footer: {
            focus: focusButton,
            loading: Boolean(brain.loading),
            lastSync: brain.lastSync ? timeString(brain.lastSync) : null,
        },
    };
}
