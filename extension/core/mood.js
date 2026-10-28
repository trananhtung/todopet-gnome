// The pet's mood (port of MoodEngine.swift): "how is my day going" becomes a 0-100 happiness score and a mood.
// Pure, so it is unit-tested.
import {L} from './l10n.js';

export const Mood = Object.freeze({
    happy: 'happy',
    normal: 'normal',
    annoyed: 'annoyed',
    angry: 'angry',
    sleeping: 'sleeping',
    focus: 'focus',
    celebrating: 'celebrating',
});

const EMOJI = Object.freeze({
    happy: '😊',
    normal: '🙂',
    annoyed: '😒',
    angry: '😤',
    sleeping: '😴',
    focus: '🎯',
    celebrating: '🥳',
});

// [vi, en] per mood.
const LABELS = Object.freeze({
    happy: ['đang vui', 'happy'],
    normal: ['bình thường', 'chill'],
    annoyed: ['đang nhăn nhó', 'annoyed'],
    angry: ['nổi cáu rồi', 'grumpy'],
    sleeping: ['đang ngủ', 'sleeping'],
    focus: ['đang canh bạn tập trung', 'guarding your focus'],
    celebrating: ['đang ăn mừng', 'celebrating'],
});

export function moodEmoji(mood) {
    return EMOJI[mood] ?? '';
}

export function moodLabel(mood) {
    const pair = LABELS[mood];
    return pair ? L(pair[0], pair[1]) : '';
}

// A fresh set of inputs with the Swift defaults (a calm, empty workday), ready to be overridden field by field.
export function defaultMoodInputs() {
    return {
        hasToken: true,
        workday: true,
        inWorkHours: true,
        night: false,
        hoursAfterPlanDeadline: -1, // < 0 means the deadline hasn't passed yet
        target: 3,
        planned: 0,
        completed: 0,
        remaining: 0,
        overdue: 0,
        late: 0,
        minutesSinceProgress: 0,
        minutesSinceCelebration: Infinity,
        distractedMinutes: 0,
        distractionApp: '',
        idleMinutes: 0,
        focusing: false,
        celebratingNow: false,
        inMeeting: false,
        stuck: 0,
        satiety: 70,
        dirt: 0,
    };
}

// Swift's Double.rounded(): halves round away from zero (Math.round rounds -1.5 to -1).
const roundAway = d => Math.sign(d) * Math.round(Math.abs(d));

// Swift's String(format: "%.1f"): exact binary ties (x.25, x.75) round to even, toFixed(1) rounds them up.
function oneDecimal(x) {
    const tenths = x * 10;
    if (Number.isInteger(x * 4) && Math.abs(tenths % 1) === 0.5) {
        const down = Math.floor(tenths);
        return ((down % 2 === 0 ? down : down + 1) / 10).toFixed(1);
    }
    return x.toFixed(1);
}

// Returns {score, mood, reasons: [{delta, text}]}; reasons are sorted by size, biggest first.
export function evaluateMood(i) {
    const reasons = [];
    let s = 60;
    const add = (d, text) => {
        if (Math.abs(d) < 1)
            return;
        s += d;
        reasons.push({delta: roundAway(d), text});
    };

    if (i.completed > 0)
        add(Math.min(i.completed, 5) * 8, L(`đã xong ${i.completed} việc hôm nay`, `${i.completed} task(s) done today`));
    if (i.completed > 0 && i.remaining === 0 && i.overdue === 0 && i.planned >= i.target)
        add(30, L('xong hết kế hoạch hôm nay', "today's plan is complete"));
    if (i.minutesSinceCelebration < 30)
        add(15 * (1 - i.minutesSinceCelebration / 30), L('vừa hoàn thành một việc', 'just finished something'));
    if (i.overdue > 0)
        add(-Math.min(i.overdue, 5) * 7, L(`${i.overdue} việc quá hạn`, `${i.overdue} overdue task(s)`));
    if (i.late > 0)
        add(-Math.min(i.late, 3) * 4, L(`${i.late} việc đã trễ giờ`, `${i.late} task(s) past their time`));
    if (i.satiety < 30) {
        const percent = Math.trunc(i.satiety);
        add(-(30 - i.satiety) / 2, L(`đang đói (no ${percent}%)`, `hungry (${percent}% full)`));
    }
    if (i.dirt > 0)
        add(-i.dirt * 5, L(`bẩn vì ${i.dirt} ngày lười`, `dirty after ${i.dirt} lazy day(s)`));
    if (i.stuck > 0)
        add(-Math.min(i.stuck, 3) * 3, L(`${i.stuck} việc bị dời mãi`, `${i.stuck} task(s) keep getting postponed`));
    if (i.workday && i.inWorkHours && !i.inMeeting) {
        if (i.hoursAfterPlanDeadline >= 0 && i.planned < i.target) {
            const gap = i.target - i.planned;
            add(-(12 + gap * 6 + Math.min(20, i.hoursAfterPlanDeadline * 8)),
                L(`mới lên kế hoạch ${i.planned}/${i.target} việc`, `only ${i.planned}/${i.target} tasks planned`));
        }
        if (i.remaining + i.overdue > 0 && i.minutesSinceProgress > 90) {
            const hours = oneDecimal(i.minutesSinceProgress / 60);
            add(-Math.min(30, (i.minutesSinceProgress - 90) / 60 * 10),
                L(`${hours} giờ chưa có tiến triển`, `no progress for ${hours}h`));
        }
        if (i.distractedMinutes >= 2) {
            add(-Math.min(35, 15 + i.distractedMinutes * 2),
                L(`đang xao nhãng với ${i.distractionApp}`, `distracted by ${i.distractionApp}`));
        }
    }
    if (i.focusing)
        add(10, L('đang tập trung', 'focusing'));

    // Outside work hours the pet relaxes, it only remembers the bad stuff a little.
    if (!(i.workday && i.inWorkHours) && s < 55)
        s = 55;
    s = Math.min(100, Math.max(0, s));

    let mood;
    if (i.celebratingNow)
        mood = Mood.celebrating;
    else if (!i.hasToken)
        mood = Mood.normal;
    else if (i.focusing)
        mood = Mood.focus;
    else if (i.night || i.idleMinutes > 10)
        mood = Mood.sleeping;
    else if (s >= 75)
        mood = Mood.happy;
    else if (s >= 50)
        mood = Mood.normal;
    else if (s >= 30)
        mood = Mood.annoyed;
    else
        mood = Mood.angry;

    // Array.prototype.sort is stable, so equal-sized reasons keep the order they were added in.
    reasons.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    return {score: s, mood, reasons};
}
