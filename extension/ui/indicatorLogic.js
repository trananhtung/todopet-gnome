// The top bar indicator's pure parts (port of AppDelegate.updateStatusTitle and AppDelegate.fill): its label and the
// quick menu as data, so the view (ui/indicator.js) only has to draw it. No Shell imports: plain gjs tests it.
//
//   focusText(session, nowMs)        "🍅 24:58" in a focus session, "☕ 4:59" in a break
//   indicatorLabel(brain, nowMs)     the focus clock, else "<mood emoji> <done>/<target>", else "🐾" (no token yet)
//   quickMenu({...})                 the menu's items, in order: {id, title, ...} or {id: 'separator'}
import {L} from '../core/l10n.js';
import {moodEmoji, moodLabel} from '../core/mood.js';

// "Hide pet for 1 hour" and "Quiet for 1 hour".
export const HIDE_MS = 3600 * 1000;
export const QUIET_MINUTES = 60;

// Whole seconds left, cut off (Swift: Int(f.end.timeIntervalSinceNow)), never below zero. Minutes are not padded.
export function focusText(session, nowMs) {
    const left = Math.max(0, Math.trunc((session.end.getTime() - nowMs) / 1000));
    return `${session.isBreak ? '☕' : '🍅'} ${Math.trunc(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

// `brain` needs: focusSession, hasToken, mood, target (the effective daily target) and day {completed, planned}.
// Like the board's header, the plan is the denominator when it is bigger than the target.
export function indicatorLabel(brain, nowMs) {
    if (brain.focusSession)
        return focusText(brain.focusSession, nowMs);
    if (brain.hasToken)
        return `${moodEmoji(brain.mood)} ${brain.day.completed.length}/${Math.max(brain.target, brain.day.planned)}`;
    return '🐾';
}

const SEPARATOR = Object.freeze({id: 'separator'});

// Swift: AppDelegate.fill. The same items in the same order, then the demo switch (new here). Ids name what each one
// does (ui/indicator.js maps them to actions); `hint` is the shortcut shown beside "Open task board"; `toggle` marks a
// switch and holds its state; `sensitive: false` is a label that does nothing.
//   petName, mood       the header: "Mochi 😊 — happy"
//   hasToken            with a token: add a task and focus; without: connect Todoist
//   focusing            a focus session or a break is running (its stop button replaces the start button)
//   focusMinutes        the length "Start focus" says
//   petVisible          the pet is on screen (else: "Show pet" replaces "Hide pet for 1 hour")
//   quiet               reminders are muted (else: "Quiet for 1 hour")
//   demo                demo mode is on
//   hotkey              the board shortcut as text ("Ctrl+Super+T"), '' for none
export function quickMenu({petName, mood, hasToken, focusing, focusMinutes, petVisible, quiet, demo, hotkey}) {
    const items = [
        {id: 'header', title: `${petName} ${moodEmoji(mood)} — ${moodLabel(mood)}`, sensitive: false},
        SEPARATOR,
        {id: 'open', title: L('Mở bảng việc', 'Open task board'), hint: hotkey},
    ];
    if (hasToken) {
        items.push({id: 'add', title: L('Thêm việc…', 'Add a task…')});
        items.push(focusing
            ? {id: 'stopFocus', title: L('Dừng tập trung', 'Stop focus')}
            : {id: 'startFocus', title: L(`Bắt đầu tập trung ${focusMinutes}'`, `Start focus ${focusMinutes}'`)});
    } else {
        items.push({id: 'connect', title: L('Kết nối Todoist…', 'Connect Todoist…')});
    }
    items.push(SEPARATOR);
    items.push({id: 'callOver', title: L(`Gọi ${petName} về đây`, `Call ${petName} over`)});
    items.push(petVisible
        ? {id: 'hide', title: L('Ẩn pet 1 giờ', 'Hide pet for 1 hour')}
        : {id: 'show', title: L('Hiện pet', 'Show pet')});
    items.push(quiet
        ? {id: 'unquiet', title: L('Bật lại nhắc nhở', 'Resume reminders')}
        : {id: 'quiet', title: L('Im lặng 1 giờ', 'Quiet for 1 hour')});
    items.push({id: 'refresh', title: L('Làm mới', 'Refresh')});
    items.push({id: 'diary', title: L('Nhật ký pet…', 'Pet diary…')});
    items.push(SEPARATOR);
    items.push({id: 'settings', title: L('Cài đặt…', 'Settings…')});
    items.push({id: 'demo', title: L('Chế độ demo', 'Demo mode'), toggle: Boolean(demo)});
    return items;
}
