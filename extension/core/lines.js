// Everything the pet says, in both languages; the tone follows the mood (port of Lines.swift).
// The strings are the Swift ones, word for word. The invisible characters in them are written as escapes so a
// reviewer can see them: \uFE0E and \uFE0F are variation selectors (text and emoji style), \u200D joins emoji.
// Swift's labelled arguments are positional here; where Swift has three or more, one object with the Swift labels.
import {L, pick} from './l10n.js';
import {hourOf, shortText, timeString} from './dates.js';
import {hoursText} from './calendarMath.js';
import {Mood} from './mood.js';
import {accessoryEmoji, accessoryName, stageName} from './life.js';

let random = Math.random;

/** Makes the lines that pick one variant at random use `fn() -> [0, 1)`; no argument restores Math.random. */
export function setLinesRandom(fn) {
    random = fn ?? Math.random;
}

// Picks one random bilingual variant from [[vi, en], ...] with this module's random source.
const choose = pairs => pick(pairs, random);

/** @param {Task} task  The task title in curly quotes, shortened to 42 characters. */
function q(task) {
    return `“${shortText(task.title)}”`;
}

/** @param {Date} now  Greets by the hour of the day. */
function greeting(now) {
    const hour = hourOf(now);
    if (hour < 11)
        return L('Chào buổi sáng! ☀\uFE0F', 'Good morning! ☀\uFE0F');
    if (hour < 13)
        return L('Chào buổi trưa! 🌤', 'Good day! 🌤');
    if (hour < 18)
        return L('Chào buổi chiều! 🌇', 'Good afternoon! 🌇');
    return L('Chào buổi tối! 🌙', 'Good evening! 🌙');
}

/** @param {string} name  The pet's name; the first thing it says, before it has a Todoist token. */
function hello(name) {
    return L(`Xin chào! Mình là ${name} 🐾 Cho mình API token Todoist để mình giữ nhịp làm việc cho bạn nhé.`,
        `Hi! I'm ${name} 🐾 Give me your Todoist API token and I'll keep you on track.`);
}

/** @param {Date} now  @param {DaySnapshot} day  @param {number} target  The first thing in the morning. */
function morning(now, day, target) {
    const g = greeting(now);
    if (day.planned < target) {
        return g + ' ' + L(`Hôm nay mình làm ${target} việc gì nào? Mới có ${day.planned}/${target} việc thôi 📝`,
            `What are our ${target} things today? Only ${day.planned}/${target} planned so far 📝`);
    }
    const next = day.next;
    if (next) {
        return g + ' ' + L(`Hôm nay có ${day.open.length} việc. Ăn con ếch trước: ${q(next)} 🐸`,
            `${day.open.length} tasks today. Eat the frog first: ${q(next)} 🐸`);
    }
    return g;
}

/** @param {{mood: string, planned: number, target: number}} args  Asks for the missing tasks of the day plan. */
function plan({mood, planned, target}) {
    const k = target - planned;
    switch (mood) {
    case Mood.angry:
        return choose([
            [`Muộn thế này rồi mà chưa có kế hoạch?! Đặt ngay ${k} việc nữa đi 😤`,
                `It's this late and still no plan?! Add ${k} more tasks now 😤`],
            [`Không có kế hoạch = không có tiến độ! Thêm ${k} việc NGAY 💢`,
                `No plan = no progress! Add ${k} tasks NOW 💢`],
        ]);
    case Mood.annoyed:
        return choose([
            [`Này… hôm nay vẫn chưa đủ ${target} việc đâu nha 😒 (${planned}/${target})`,
                `Hey… still not ${target} tasks for today 😒 (${planned}/${target})`],
            [`Hôm nay làm gì vậy? Mình vẫn chờ ${k} việc nữa đó 😑`,
                `So what are we doing today? Still waiting for ${k} more 😑`],
        ]);
    default:
        return choose([
            [`Hôm nay mình làm ${target} việc gì nào? Mới có ${planned}/${target} việc 📝`,
                `What are our ${target} things today? ${planned}/${target} planned 📝`],
            [`Chọn ${k} việc quan trọng nhất cho hôm nay nhé ✍\uFE0F`,
                `Pick the ${k} most important tasks for today ✍\uFE0F`],
        ]);
    }
}

/** @param {{mood: string, next: Task, hoursIdle: number}} args  Points at the next task; angry counts idle hours. */
function nudge({mood, next, hoursIdle}) {
    switch (mood) {
    case Mood.happy:
        return choose([
            [`Đang ngon trớn! Tiếp theo là ${q(next)} nha ✨`, `On a roll! Next up: ${q(next)} ✨`],
            [`Mình thích nhịp này! Làm luôn ${q(next)} nhé 💪`, `Love this pace! Let's do ${q(next)} 💪`],
        ]);
    case Mood.annoyed:
        return choose([
            [`Ừm… ${q(next)} vẫn nằm đó. Làm 10 phút thôi cũng được mà 😑`,
                `Ahem… ${q(next)} is still waiting. Even 10 minutes helps 😑`],
            [`Mình hơi buồn đó… bắt đầu ${q(next)} đi 😒`, `I'm a bit sad… start ${q(next)} 😒`],
        ]);
    case Mood.angry: {
        const h = Number.isFinite(hoursIdle) ? Math.max(1, Math.round(hoursIdle)) : 1;
        return choose([
            [`${h} tiếng rồi chưa xong việc nào! Làm ${q(next)} NGAY 😠`, `${h}h and nothing done! Do ${q(next)} NOW 😠`],
            [`Mình giận thật rồi đó 💢 ${q(next)} — bắt đầu đi!`, `I'm really mad 💢 ${q(next)} — start it!`],
        ]);
    }
    default:
        return choose([
            [`Việc tiếp theo: ${q(next)}. Làm một phiên tập trung không?`, `Next: ${q(next)}. Want a focus session?`],
            [`Nhắc nhẹ: ${q(next)} đang chờ bạn 🙂`, `Gentle nudge: ${q(next)} is waiting 🙂`],
        ]);
    }
}

/** @param {string} mood  @param {number} count  Overdue tasks; angry shouts. */
function overdue(mood, count) {
    if (mood === Mood.angry)
        return L(`${count} việc QUÁ HẠN kìa!! 💢 Làm hoặc dời đi chứ!`, `${count} OVERDUE tasks!! 💢 Do them or move them!`);
    return L(`Có ${count} việc quá hạn 😬 Làm luôn hay dời vào hôm nay?`, `${count} overdue task(s) 😬 Do them or move to today?`);
}

/** @param {{mood: string, app: string, left: number, next: ?Task}} args  Caught on a distracting app or site. */
function distraction({mood, app, left, next}) {
    if (mood === Mood.angry && next) {
        return L(`${app} nữa hả?!! Đóng lại đi, ${q(next)} đang chờ 😤`, `${app} AGAIN?! Close it, ${q(next)} is waiting 😤`);
    }
    return choose([
        [`Ê! Đang ${app} đó hả? 👀 Còn ${left} việc kìa.`, `Hey! On ${app}? 👀 ${left} task(s) left.`],
        [`Mình thấy bạn mở ${app} nha 👀 Quay lại làm việc chứ?`, `I see ${app} 👀 Back to work?`],
    ]);
}

/** @param {Task} task  @param {number} completed  @param {number} target  Cheers a finished task. */
function done(task, completed, target) {
    if (completed === target)
        return L(`Đủ ${target} việc rồi!!! Bạn là nhất 🏆`, `That's ${target}!!! You're the best 🏆`);
    return choose([
        [`Xong ${q(task)}! 🎉 (${completed}/${target})`, `Done: ${q(task)}! 🎉 (${completed}/${target})`],
        [`Tuyệt vời! ✔\uFE0E ${q(task)}`, `Awesome! ✔\uFE0E ${q(task)}`],
        [`Yay! Mình vui quá 🥳 (${completed}/${target})`, `Yay! So happy 🥳 (${completed}/${target})`],
        ['Giỏi quá! Tiếp tục giữ nhịp nhé 💪', 'Nice! Keep the rhythm 💪'],
    ]);
}

/** No params. Everything planned for today is done. */
function allDone() {
    return L('Xong hết việc hôm nay rồi! 🎉 Nghỉ ngơi, hoặc chọn sẵn 3 việc cho mai nhé.',
        "Everything's done for today! 🎉 Rest, or pick tomorrow's 3 tasks.");
}

/** @param {{completed: number, planned: number, remaining: number}} args  The end-of-day review. */
function review({completed, planned, remaining}) {
    return L(`Sắp hết giờ làm. Hôm nay xong ${completed}/${planned} việc. Còn ${remaining} việc — dời sang mai?`,
        `Almost end of day: ${completed}/${planned} done. Move the remaining ${remaining} to tomorrow?`);
}

/** @param {Task} task  Greets you back after a break away. */
function welcomeBack(task) {
    return L(`Bạn về rồi! 👋 Tiếp tục với ${q(task)} nhé?`, `Welcome back! 👋 Continue with ${q(task)}?`);
}

/** @param {Task} task  @param {number} minutes  A timed task starts soon. */
function soon(task, minutes) {
    return L(`⏰ ${minutes} phút nữa: ${q(task)}`, `⏰ In ${minutes} min: ${q(task)}`);
}

/** @param {Task} task  A timed task is due now. */
function dueNow(task) {
    return L(`⏰ Đến giờ rồi: ${q(task)}!`, `⏰ It's time: ${q(task)}!`);
}

/** @param {?Task} task  @param {number} minutes  A focus session starts, with or without a task. */
function focusStart(task, minutes) {
    if (task) {
        return L(`Bắt đầu ${minutes} phút cho ${q(task)}. Mình sẽ ngồi im canh bạn 🤫`,
            `${minutes} minutes on ${q(task)}. I'll sit quietly and guard 🤫`);
    }
    return L(`Bắt đầu ${minutes} phút tập trung. Mình ngồi im canh nhé 🤫`, `${minutes} minutes of focus. I'll stay quiet 🤫`);
}

/** @param {?Task} task  @param {number} minutes  A focus session ends. */
function focusEnd(task, minutes) {
    if (task)
        return L(`Hết ${minutes} phút rồi! ${q(task)} xong chưa?`, `${minutes} minutes up! Is ${q(task)} done?`);
    return L(`Hết ${minutes} phút rồi! Nghỉ chút nhé?`, `${minutes} minutes up! Take a break?`);
}

/** No params. A break ends. */
function breakEnd() {
    return L('Hết giờ nghỉ! Quay lại thôi 💪', "Break's over! Let's go 💪");
}

/** @param {string} title  A task was added; the title is shortened to 42 characters. */
function added(title) {
    return L(`Đã thêm “${shortText(title)}” ✔\uFE0E`, `Added “${shortText(title)}” ✔\uFE0E`);
}

/** @param {number} target  @param {?Task} next  The day plan has enough tasks. */
function planComplete(target, next) {
    if (next) {
        return L(`Đủ ${target} việc cho hôm nay rồi! Bắt đầu với ${q(next)} nhé 🐸`,
            `${target} tasks planned! Start with ${q(next)} 🐸`);
    }
    return L(`Đủ ${target} việc cho hôm nay rồi! 🐸`, `${target} tasks planned for today! 🐸`);
}

/** No params. Sends you to bed. */
function lateNight() {
    return L('Khuya rồi đó… đi ngủ để mai làm tốt hơn nha 😴', "It's late… sleep now, crush it tomorrow 😴");
}

/** @param {string} e  The error text. Todoist could not be reached. */
function error(e) {
    return L(`Mình không kết nối được Todoist 😵 ${e}`, `I can't reach Todoist 😵 ${e}`);
}

// --- Calendar ---

/** @param {CalEvent} event  @param {number} minutes  A meeting starts soon. */
function meetingSoon(event, minutes) {
    return L(`📅 ${minutes} phút nữa họp: “${shortText(event.title)}” (${timeString(event.start)})`,
        `📅 Meeting in ${minutes} min: “${shortText(event.title)}” (${timeString(event.start)})`);
}

/**
 * @param {{meetings: number, busyMinutes: number, freeMinutes: number, target: number, reduced: boolean}} args
 * What the calendar does to today; `reduced` adds the lowered task target.
 */
function calendarDay({meetings, busyMinutes, freeMinutes, target, reduced}) {
    const busy = hoursText(busyMinutes);
    const free = hoursText(freeMinutes);
    const base = L(`📅 Hôm nay ${meetings} cuộc họp (${busy}), còn ${free} trống`,
        `📅 ${meetings} meeting(s) today (${busy}), ${free} free`);
    return base + (reduced ? L(` → ${target} việc là vừa sức.`, ` → ${target} task(s) is realistic.`) : '.');
}

/** @param {{task: Task, start: Date, end: Date}} slot  Suggests a time block for a task. */
function timeBlock(slot) {
    return L(`Gắn giờ cho dễ bắt đầu: ${timeString(slot.start)}–${timeString(slot.end)} làm ${q(slot.task)} nhé?`,
        `A set time makes it easier to start: ${timeString(slot.start)}–${timeString(slot.end)} for ${q(slot.task)}?`);
}

/** @param {Task} task  @param {Date} at  A task was given a time. */
function timeSet(task, at) {
    return L(`Đã hẹn ${q(task)} lúc ${timeString(at)}. Mình sẽ nhắc đúng giờ ⏰`,
        `Scheduled ${q(task)} at ${timeString(at)}. I'll remind you ⏰`);
}

// --- Postponed tasks ---

/** @param {{task: Task, days: number}} item  @param {string} mood  A task that keeps being pushed back. */
function stuck(item, mood) {
    if (mood === Mood.angry) {
        return L(`${q(item.task)} nằm đó ${item.days} ngày rồi đấy!! 💢 Chia nhỏ hoặc bỏ đi.`,
            `${q(item.task)} has been sitting there for ${item.days} days!! 💢 Split it or drop it.`);
    }
    return choose([
        [`${q(item.task)} bị dời ${item.days} ngày rồi 😑 Chắc nó to quá? Chia thành bước nhỏ cho dễ bắt đầu nhé.`,
            `${q(item.task)} has been pushed for ${item.days} days 😑 Too big? Let's split it into small steps.`],
        [`Mình thấy ${q(item.task)} cứ bị dời mãi (${item.days} ngày). Bước nhỏ nhất để bắt đầu là gì?`,
            `${q(item.task)} keeps getting postponed (${item.days} days). What's the tiniest first step?`],
    ]);
}

/** @param {number} count  @param {string} first  A task was split into `count` steps; `first` is the first one. */
function splitDone(count, first) {
    return L(`Đã chia thành ${count} bước ✂\uFE0F Bắt đầu với “${shortText(first)}” nhé — chỉ 15–30 phút thôi!`,
        `Split into ${count} steps ✂\uFE0F Start with “${shortText(first)}” — just 15–30 minutes!`);
}

/** @param {Task} task  A task was deleted. */
function deleted(task) {
    return L(`Đã xoá ${q(task)} 🗑 Danh sách gọn hơn rồi!`, `Deleted ${q(task)} 🗑 One less thing on your list!`);
}

/** @param {Task} task  Confirmation text before deleting; warns that sub-tasks and a recurring series go too. */
function confirmDelete(task) {
    let s = L('Xoá hẳn khỏi Todoist (kèm việc con nếu có)', 'Delete from Todoist for good (with any sub-tasks)');
    if (task.isRecurring)
        s += L(', cả chuỗi lặp lại', ', including the whole recurring series');
    return s + L('? Không khôi phục được.', "? This can't be undone.");
}

/** @param {Task} task  A task was taken off today's plan. */
function unplanned(task) {
    return L(`Đã bỏ ${q(task)} khỏi kế hoạch (vẫn còn trong Todoist, không hạn). Nhẹ đầu hơn chưa? 🙂`,
        `Took ${q(task)} off the plan (still in Todoist, no date). Feels lighter? 🙂`);
}

// --- Pet life ---

/** No params. A rare golden treat. */
function golden() {
    return L('✨ HIẾM! Bánh vàng cho bạn! ✨', '✨ RARE! A golden treat! ✨');
}

/** @param {number} n  The combo count. */
function combo(n) {
    return L(`🔥 Combo ×${n}! Đang cháy quá!`, `🔥 Combo ×${n}! You're on fire!`);
}

/** @param {number} dirtLeft  How much dirt is left after a bath. */
function cleaned(dirtLeft) {
    return dirtLeft === 0 ? L('🛁 Mình sạch bong rồi!', '🛁 Squeaky clean again!') : L('🛁 Sạch hơn chút rồi…', '🛁 A bit cleaner…');
}

/** @param {number} stage  The Stage the pet grew into. */
function levelUp(stage) {
    return L(`⬆\uFE0F Mình lớn lên thành ${stageName(stage)}!`, `⬆\uFE0F I grew up: ${stageName(stage)}!`);
}

/** @param {string[]} items  Accessory ids that were just unlocked. */
function unlocked(items) {
    return L('🎁 Mở khoá: ', '🎁 Unlocked: ') + items.map(a => `${accessoryEmoji(a)} ${accessoryName(a)}`).join(', ');
}

/** @param {number} n  Days in a row the goal was reached. */
function streak(n) {
    return L(`🔥 Chuỗi ${n} ngày đạt mục tiêu — giữ nhé!`, `🔥 ${n}-day streak — keep it going!`);
}

/** @param {number} dirt  The pet's dirt level, in lazy days. */
function dirty(dirt) {
    return L(`🪰 Mình bẩn quá… ${dirt} ngày rồi bạn không làm gì. Xong 1 việc để tắm cho mình nhé.`,
        `🪰 I'm filthy… ${dirt} lazy day(s). Finish a task to give me a bath.`);
}

/** @param {number} satiety  0-100; under 10 is starving.  @param {?Task} next  Asked to finish before feeding. */
function hungry(satiety, next) {
    const n = next ? L(` Xong ${q(next)} cho mình ăn với 🥺`, ` Finish ${q(next)} and feed me 🥺`) : '';
    return satiety < 10
        ? L('Đói lả rồi… 😵\u200D💫', 'Starving… 😵\u200D💫') + n
        : L('Bụng mình réo rồi nè 🍙', 'My tummy is rumbling 🍙') + n;
}

/** @param {Task} next  Grumbles about a task nobody touched. */
function grumble(next) {
    return choose([
        [`Haizzz… 😮\u200D💨 ${q(next)} vẫn chưa ai đụng tới.`, `Sigh… 😮\u200D💨 Nobody has touched ${q(next)} yet.`],
        [`*giậm chân* Mình chờ ${q(next)} lâu lắm rồi đó 😤`, `*stomps* I've been waiting for ${q(next)} forever 😤`],
    ]);
}

/** @param {Task} next  The pet marches until the task is done. */
function parade(next) {
    return L(`Mình sẽ diễu hành tới khi bạn làm ${q(next)} thì thôi! 📢`, `I'm marching until you do ${q(next)}! 📢`);
}

/** @param {string} app  The blocked app or site.  @param {?Task} next  Sent to do this instead. */
function block(app, next) {
    const n = next ? L(` Làm ${q(next)} đi!`, ` Go do ${q(next)}!`) : '';
    return L(`(╯°□°)╯︵ ┻━┻ ĐỦ RỒI ${app.toUpperCase()}!`, `(╯°□°)╯︵ ┻━┻ ENOUGH ${app.toUpperCase()}!`) + n;
}

/** @param {Object<string, number>} d  Seconds spent today per distracting app or site; lists the top three. */
function distractionSummary(d) {
    const entries = Object.entries(d);
    const total = Math.trunc(entries.reduce((sum, [, seconds]) => sum + seconds, 0) / 60);
    const top = entries
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([label, seconds]) => `${label} ${Math.trunc(seconds / 60)}'`)
        .join(', ');
    return L(`Hôm nay bạn ở mấy chỗ xao nhãng ${total} phút đó 😒 (${top})`,
        `You spent ${total} minutes on distractions today 😒 (${top})`);
}

// --- Spoken lines (short, no emoji) ---

/** No params. A bored sigh. */
function voiceGrumble() {
    return choose([['Haizzz. Làm việc đi chứ.', 'Sigh. Get to work.'], ['Mình chán quá à.', "I'm so bored."]]);
}

/** @param {Task} task  Tells you off about a task; the title is shortened to 30 characters. */
function voiceAngry(task) {
    return L(`Ê! Làm ${shortText(task.title, 30)} ngay!`, `Hey! Do ${shortText(task.title, 30)} now!`);
}

/** @param {string} app  The app or site to close. */
function voiceBlock(app) {
    return L(`Tắt ${app} đi!`, `Close ${app}!`);
}

/** No params. */
function voiceHungry() {
    return L('Mình đói quá.', "I'm so hungry.");
}

/** No params. */
function voiceCheer() {
    return choose([['Tuyệt vời!', 'Awesome!'], ['Hoan hô!', 'Hooray!']]);
}

/** @param {number} minutes  Minutes spent on distractions today. */
function voiceSummary(minutes) {
    return L(`Hôm nay bạn lướt mạng ${minutes} phút đó.`, `You goofed off for ${minutes} minutes today.`);
}

/** No params. A short, evidence-based productivity tip the pet drops occasionally. */
function tip() {
    return choose([
        ['Mẹo: làm việc khó nhất trước (Eat the frog 🐸) — năng lượng đầu ngày là tốt nhất.',
            'Tip: do the hardest task first (eat the frog 🐸) — early energy is your best.'],
        ['Mẹo: việc to quá? Chia thành bước 15–30 phút rồi thêm vào Todoist.',
            'Tip: task too big? Split it into 15–30 minute steps in Todoist.'],
        ['Mẹo: gắn giờ cụ thể (“14h làm X”) giúp bạn dễ bắt tay vào việc hơn hẳn.',
            'Tip: give tasks a concrete time (“2pm: do X”) — it makes starting much easier.'],
        ['Mẹo: cuối ngày dành 5 phút chọn sẵn 3 việc cho mai — sáng mai vào việc ngay.',
            "Tip: spend 5 minutes at day's end picking tomorrow's 3 tasks."],
        ['Mẹo: mỗi lần bị gián đoạn cần khá lâu để tập trung lại — tắt thông báo khi tập trung nhé.',
            'Tip: every interruption costs a long refocus — mute notifications while focusing.'],
        ['Mẹo: uống nước & đứng dậy vươn vai sau mỗi phiên tập trung 💧',
            'Tip: drink water and stretch after each focus session 💧'],
    ]);
}

export const Lines = Object.freeze({
    q, greeting, hello, morning, plan, nudge, overdue, distraction, done, allDone, review, welcomeBack, soon, dueNow,
    focusStart, focusEnd, breakEnd, added, planComplete, lateNight, error,
    meetingSoon, calendarDay, timeBlock, timeSet,
    stuck, splitDone, deleted, confirmDelete, unplanned,
    golden, combo, cleaned, levelUp, unlocked, streak, dirty, hungry, grumble, parade, block, distractionSummary,
    voiceGrumble, voiceAngry, voiceBlock, voiceHungry, voiceCheer, voiceSummary, tip,
});
