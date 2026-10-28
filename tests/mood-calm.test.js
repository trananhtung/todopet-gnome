import {getLang, setLang} from '../extension/core/l10n.js';
import {CalmRules, TypingSampler} from '../extension/core/calm.js';
import {Mood, defaultMoodInputs, evaluateMood, moodEmoji, moodLabel} from '../extension/core/mood.js';

// Fresh defaults with a few fields overridden, like `var i = MoodInputs(); i.x = ...` in Swift.
const inputs = (changes = {}) => ({...defaultMoodInputs(), ...changes});
const mood = changes => evaluateMood(inputs(changes)).mood;

export default async function (t) {
    // --- Mood enum, emoji and labels ---
    t.eq(Object.values(Mood), ['happy', 'normal', 'annoyed', 'angry', 'sleeping', 'focus', 'celebrating'],
        'Mood has the seven moods, in the Swift order');
    t.check(Object.isFrozen(Mood), 'Mood is frozen');
    t.eq(Object.values(Mood).map(moodEmoji), [
        '\u{1F60A}', '\u{1F642}', '\u{1F612}', '\u{1F624}', '\u{1F634}', '\u{1F3AF}', '\u{1F973}',
    ], 'every mood has its emoji');

    const savedLang = getLang();
    try {
        setLang('en');
        t.eq(Object.values(Mood).map(moodLabel),
            ['happy', 'chill', 'annoyed', 'grumpy', 'sleeping', 'guarding your focus', 'celebrating'],
            'English mood labels');
        setLang('vi');
        t.eq(Object.values(Mood).map(moodLabel), [
            'đang vui', 'bình thường', 'đang nhăn nhó', 'nổi cáu rồi', 'đang ngủ',
            'đang canh bạn tập trung', 'đang ăn mừng',
        ], 'Vietnamese mood labels');
    } finally {
        setLang(savedLang);
    }

    // --- Defaults ---
    t.eq(defaultMoodInputs(), {
        hasToken: true, workday: true, inWorkHours: true, night: false, hoursAfterPlanDeadline: -1,
        target: 3, planned: 0, completed: 0, remaining: 0, overdue: 0, late: 0, minutesSinceProgress: 0,
        minutesSinceCelebration: Infinity, distractedMinutes: 0, distractionApp: '', idleMinutes: 0,
        focusing: false, celebratingNow: false, inMeeting: false, stuck: 0, satiety: 70, dirt: 0,
    }, 'MoodInputs defaults match Swift (celebration never happened)');
    const first = defaultMoodInputs();
    first.completed = 9;
    t.eq(defaultMoodInputs().completed, 0, 'defaultMoodInputs returns a fresh object each call');
    const blank = evaluateMood(defaultMoodInputs());
    t.eq([blank.score, blank.mood, blank.reasons], [60, 'normal', []], 'a blank day scores 60 and chills');

    // --- Moods (DevTools.swift "Moods") ---
    t.check(mood({hoursAfterPlanDeadline: -1.5}) === Mood.normal, 'before plan deadline with nothing planned: chill');
    t.check(mood({hoursAfterPlanDeadline: 2}) === Mood.angry, '2h after plan deadline, nothing planned: grumpy');
    t.check(mood({planned: 3, completed: 2, remaining: 1, minutesSinceCelebration: 3}) === Mood.happy,
        '2/3 done and just finished one: happy');
    const allDone = evaluateMood(inputs({planned: 3, completed: 3, remaining: 0}));
    t.check(allDone.mood === Mood.happy && allDone.score >= 99, 'all done: happiest');
    t.check(mood({planned: 3, remaining: 3, overdue: 3, minutesSinceProgress: 240}) === Mood.angry,
        'overdue + 4h without progress: grumpy');
    const distracted = mood({
        planned: 3, remaining: 3, minutesSinceProgress: 30, distractedMinutes: 5, distractionApp: 'TikTok',
    });
    t.check(distracted === Mood.annoyed || distracted === Mood.angry, 'distraction app: annoyed');
    t.check(mood({night: true}) === Mood.sleeping, 'night: sleeping');
    t.check(mood({inWorkHours: false, overdue: 5, planned: 0}) === Mood.normal, 'outside work hours: relaxed');
    t.check(mood({focusing: true}) === Mood.focus, 'focus session');
    t.check(mood({planned: 3, remaining: 3, minutesSinceProgress: 300, inMeeting: true}) === Mood.normal,
        'no grumpiness during meetings');
    t.check(mood({satiety: 0, dirt: 3}) === Mood.annoyed, 'starving and dirty pet is annoyed');

    // --- Score arithmetic ---
    t.eq(allDone.score, 100, 'the score is clamped to 100');
    const doom = evaluateMood(inputs({overdue: 9, late: 9, dirt: 20, stuck: 9, satiety: 0}));
    t.eq([doom.score, doom.mood], [0, 'angry'], 'the score is clamped to 0');
    const relaxed = evaluateMood(inputs({inWorkHours: false, overdue: 5}));
    t.eq([relaxed.score, relaxed.mood], [55, 'normal'], 'outside work hours the score never drops below 55');
    const weekend = evaluateMood(inputs({workday: false, overdue: 5}));
    t.eq(weekend.score, 55, 'a day off relaxes the pet too');
    const relaxedHigh = evaluateMood(inputs({inWorkHours: false, completed: 1}));
    t.eq(relaxedHigh.score, 68, 'outside work hours a good score is left alone');
    t.eq(evaluateMood(inputs({inWorkHours: false, planned: 0, hoursAfterPlanDeadline: 2})).reasons, [],
        'work-hour penalties do not apply outside work hours');
    t.eq(evaluateMood(inputs({inMeeting: true, minutesSinceProgress: 300, remaining: 2, distractedMinutes: 9})).reasons, [],
        'work-hour penalties do not apply in a meeting');

    // --- Mood thresholds: >= 75 happy, >= 50 chill, >= 30 annoyed, below angry ---
    const at = changes => evaluateMood(inputs(changes));
    t.eq([at({minutesSinceCelebration: 0}).score, at({minutesSinceCelebration: 0}).mood], [75, 'happy'], 'a score of 75 is happy');
    t.eq([at({completed: 1}).score, at({completed: 1}).mood], [68, 'normal'], 'a score just under 75 is chill');
    t.eq([at({satiety: 10}).score, at({satiety: 10}).mood], [50, 'normal'], 'a score of 50 is chill');
    t.eq([at({satiety: 8}).score, at({satiety: 8}).mood], [49, 'annoyed'], 'a score just under 50 is annoyed');
    t.eq([at({dirt: 6}).score, at({dirt: 6}).mood], [30, 'annoyed'], 'a score of 30 is annoyed');
    t.eq([at({dirt: 7}).score, at({dirt: 7}).mood], [25, 'angry'], 'a score under 30 is grumpy');

    // --- Mood precedence ---
    t.eq(mood({celebratingNow: true, hasToken: false, focusing: true, night: true, dirt: 9}), 'celebrating',
        'celebrating beats everything');
    t.eq(mood({hasToken: false, focusing: true, night: true, dirt: 9}), 'normal', 'without a token the pet only chills');
    t.eq(mood({focusing: true, night: true}), 'focus', 'focus beats sleeping');
    t.eq(mood({idleMinutes: 10.5, dirt: 9}), 'sleeping', 'more than 10 idle minutes: sleeping');
    t.eq(mood({idleMinutes: 10}), 'normal', 'exactly 10 idle minutes is still awake');

    // --- Reasons: delta, text in both languages, order ---
    const sink = inputs({
        planned: 3, completed: 2, remaining: 1, overdue: 2, late: 1, stuck: 2, dirt: 1, satiety: 20, focusing: true,
    });
    try {
        setLang('en');
        t.eq(evaluateMood(sink), {
            score: 52,
            mood: 'focus',
            reasons: [
                {delta: 16, text: '2 task(s) done today'},
                {delta: -14, text: '2 overdue task(s)'},
                {delta: 10, text: 'focusing'},
                {delta: -6, text: '2 task(s) keep getting postponed'},
                {delta: -5, text: 'hungry (20% full)'},
                {delta: -5, text: 'dirty after 1 lazy day(s)'},
                {delta: -4, text: '1 task(s) past their time'},
            ],
        }, 'reasons are sorted by size, with English texts');
        setLang('vi');
        t.eq(evaluateMood(sink).reasons.map(r => r.text), [
            'đã xong 2 việc hôm nay', '2 việc quá hạn', 'đang tập trung', '2 việc bị dời mãi',
            'đang đói (no 20%)', 'bẩn vì 1 ngày lười', '1 việc đã trễ giờ',
        ], 'reasons carry Vietnamese texts');

        setLang('en');
        t.eq(evaluateMood(inputs({planned: 1, target: 3, hoursAfterPlanDeadline: 2})).reasons,
            [{delta: -(12 + 2 * 6 + 16), text: 'only 1/3 tasks planned'}], 'late planning penalty and text');
        t.eq(evaluateMood(inputs({planned: 3, remaining: 3, minutesSinceProgress: 30, distractedMinutes: 5,
            distractionApp: 'TikTok'})).reasons, [{delta: -25, text: 'distracted by TikTok'}],
        'distraction penalty is 15 + 2 per minute');
        t.eq(evaluateMood(inputs({distractedMinutes: 40, distractionApp: 'X'})).reasons,
            [{delta: -35, text: 'distracted by X'}], 'distraction penalty is capped at 35');
        t.eq(evaluateMood(inputs({distractedMinutes: 1.9, distractionApp: 'X'})).reasons, [],
            'under two distracted minutes costs nothing');
        t.eq(evaluateMood(inputs({remaining: 1, minutesSinceProgress: 240})).reasons,
            [{delta: -25, text: 'no progress for 4.0h'}], 'no-progress penalty and one-decimal hours');
        t.eq(evaluateMood(inputs({remaining: 1, minutesSinceProgress: 90})).reasons, [],
            '90 minutes without progress is still fine');
        t.eq(evaluateMood(inputs({overdue: 1, minutesSinceProgress: 600})).reasons.map(r => r.delta), [-30, -7],
            'no-progress penalty is capped at 30');
        t.eq(evaluateMood(inputs({minutesSinceProgress: 600})).reasons, [],
            'no-progress penalty needs something left to do');
        setLang('vi');
        t.eq(evaluateMood(inputs({planned: 1, target: 3, hoursAfterPlanDeadline: 2})).reasons[0].text,
            'mới lên kế hoạch 1/3 việc', 'Vietnamese planning text');
        t.eq(evaluateMood(inputs({remaining: 1, minutesSinceProgress: 240})).reasons[0].text,
            '4.0 giờ chưa có tiến triển', 'Vietnamese no-progress text');
        t.eq(evaluateMood(inputs({distractedMinutes: 5, distractionApp: 'TikTok'})).reasons[0].text,
            'đang xao nhãng với TikTok', 'Vietnamese distraction text');
        t.eq(evaluateMood(inputs({planned: 3, completed: 3})).reasons.map(r => r.text),
            ['xong hết kế hoạch hôm nay', 'đã xong 3 việc hôm nay'], 'Vietnamese plan-complete text');
        setLang('en');
        t.eq(evaluateMood(inputs({planned: 3, completed: 3})).reasons,
            [{delta: 30, text: "today's plan is complete"}, {delta: 24, text: '3 task(s) done today'}],
            'plan complete bonus, sorted before the per-task bonus');
        t.eq(evaluateMood(inputs({planned: 2, completed: 3, remaining: 0, overdue: 1})).reasons.map(r => r.delta),
            [24, -7], 'no plan bonus with an overdue task');
        t.eq(evaluateMood(inputs({planned: 2, completed: 3})).reasons.map(r => r.delta), [24],
            'no plan bonus below the daily target');
        t.eq(evaluateMood(inputs({completed: 9, remaining: 1})).reasons, [{delta: 40, text: '9 task(s) done today'}],
            'per-task bonus stops at 5 tasks');
        t.eq(evaluateMood(inputs({overdue: 9})).reasons, [{delta: -35, text: '9 overdue task(s)'}],
            'overdue penalty stops at 5 tasks');
        t.eq(evaluateMood(inputs({late: 9})).reasons, [{delta: -12, text: '9 task(s) past their time'}],
            'late penalty stops at 3 tasks');
        t.eq(evaluateMood(inputs({stuck: 9})).reasons, [{delta: -9, text: '9 task(s) keep getting postponed'}],
            'stuck penalty stops at 3 tasks');

        // The celebration bonus fades over 30 minutes and is skipped once it is under 1 point.
        t.eq(evaluateMood(inputs({minutesSinceCelebration: 15})).reasons,
            [{delta: 8, text: 'just finished something'}], 'half way through the fade: 7.5 rounds up to 8');
        t.eq(evaluateMood(inputs({minutesSinceCelebration: 3})).reasons,
            [{delta: 14, text: 'just finished something'}], 'a recent celebration is worth about 14');
        t.eq(evaluateMood(inputs({minutesSinceCelebration: 29})).reasons, [], 'a 0.5 point bonus is skipped');
        t.eq(evaluateMood(inputs({minutesSinceCelebration: 30})).reasons, [], 'no bonus after 30 minutes');

        // Swift rounds halves away from zero and prints exact ties with printf, JS defaults differ.
        const hungry = evaluateMood(inputs({satiety: 27.9}));
        t.eq(hungry.reasons, [{delta: -1, text: 'hungry (27% full)'}], 'hunger text truncates the percentage');
        t.near(hungry.score, 60 - 1.05, 1e-9, 'hunger penalty is (30 - satiety) / 2');
        t.eq(evaluateMood(inputs({satiety: 27})).reasons, [{delta: -2, text: 'hungry (27% full)'}],
            '-1.5 rounds to -2, away from zero');
        t.eq(evaluateMood(inputs({satiety: 29})).reasons, [], 'a 0.5 point hunger penalty is skipped');
        t.eq(evaluateMood(inputs({satiety: 30})).reasons, [], 'not hungry at 30');
        t.eq(evaluateMood(inputs({remaining: 1, minutesSinceProgress: 135})).reasons,
            [{delta: -8, text: 'no progress for 2.2h'}], '-7.5 rounds to -8 and 2.25h prints as 2.2h');
        t.eq(evaluateMood(inputs({remaining: 1, minutesSinceProgress: 165})).reasons,
            [{delta: -13, text: 'no progress for 2.8h'}], '-12.5 rounds to -13 and 2.75h prints as 2.8h');
        t.eq(evaluateMood(inputs({remaining: 1, minutesSinceProgress: 91})).reasons, [],
            'a penalty under one point is skipped');
        t.eq(evaluateMood(inputs({remaining: 1, minutesSinceProgress: 100})).reasons,
            [{delta: -2, text: 'no progress for 1.7h'}], '-1.67 rounds to -2 and 1.667h prints as 1.7h');
    } finally {
        setLang(savedLang);
    }

    // --- CalmRules (DevTools.swift "Calm") ---
    const t0 = new Date(2026, 9, 25, 9, 0, 0);
    const later = minutes => new Date(t0.getTime() + minutes * 60_000);

    t.eq([CalmRules.typingWindow, CalmRules.flowMinutes, CalmRules.flowEndsAfter], [8, 10, 120],
        'calm constants match Swift');
    t.check(CalmRules.engaged(5, 5, false), 'typing in a work app = engaged');
    t.check(!CalmRules.engaged(5, 5, true), "typing on a distracting site isn't work");
    t.check(CalmRules.engaged(44.9, 59.9, false) && !CalmRules.engaged(45, 5, false) && !CalmRules.engaged(5, 60, false),
        'engaged needs a key within 45 s and the user within 60 s');

    const start = CalmRules.engagedSince(null, true, 3, t0);
    t.check(start === t0 && CalmRules.engagedSince(start, false, 60, t0) === t0,
        'a short pause keeps the streak of work');
    t.eq(CalmRules.engagedSince(start, false, 200, t0), null, 'two minutes without typing ends it');
    t.eq(CalmRules.engagedSince(start, false, 120, later(5)), start, 'exactly two minutes keeps the streak');
    t.eq(CalmRules.engagedSince(null, false, 10, t0), null, 'no streak stays no streak');
    t.check(CalmRules.engagedSince(t0, true, 3, later(5)) === t0, 'being engaged again keeps the original start');

    t.check(!CalmRules.inFlow(t0, later(9)) && CalmRules.inFlow(t0, later(10)),
        '10 minutes of steady work = in the zone');
    t.check(!CalmRules.inFlow(null, later(60)), 'no streak is never the zone');
    t.check(CalmRules.inFlow(t0, later(5), 5) && !CalmRules.inFlow(t0, later(4.9), 5), 'the zone length can be changed');

    t.check(!CalmRules.atBreakpoint(2, 300), 'mid-typing is not a good moment');
    t.check(CalmRules.atBreakpoint(12, 300) && CalmRules.atBreakpoint(2, 3), 'a typing pause or an app switch is');
    t.check(CalmRules.atBreakpoint(8, 300) && !CalmRules.atBreakpoint(7.9, 10) && CalmRules.atBreakpoint(7.9, 9.9),
        'breakpoint edges: 8 s of typing pause, 10 s since the switch');

    t.check(!CalmRules.withinBudget(t0, later(10), 15) && CalmRules.withinBudget(t0, later(16), 15), 'bubbles spaced out');
    t.check(CalmRules.withinBudget(t0, later(15), 15), 'exactly the minimum gap is allowed');
    t.check(CalmRules.withinBudget(new Date(0), t0, 15), 'a pet that never spoke may speak');

    // --- TypingSampler ---
    const s = new TypingSampler();
    s.sample(1000, 5000, [10, 10]);
    t.check(s.secondsSinceKey(1000) >= 1e9, 'no key press before a sample pair');
    s.sample(2000, 300, [10, 10]);
    t.eq(s.secondsSinceKey(2000), 0, 'idle reset with a still pointer counts as a key press');
    s.sample(3000, 400, [50, 10]);
    t.eq(s.secondsSinceKey(5000), 3, 'pointer movement is not typing');
    s.sample(4000, 1400, [50, 10]);
    t.eq(s.secondsSinceKey(4000), 2, 'growing idle adds no key press');

    const fresh = new TypingSampler();
    t.eq(fresh.secondsSinceKey(0), 1e9, 'a new sampler has never seen a key press');
    fresh.sample(1000, 100, [5, 5]);
    t.eq(fresh.secondsSinceKey(1000), 1e9, 'the very first sample has no previous one to compare with');
    fresh.sample(2000, 999, [5, 5]);
    t.eq(fresh.secondsSinceKey(2500), 0.5, 'idle under 1000 ms with a still pointer is a key press');
    fresh.sample(3000, 1000, [5, 5]);
    t.eq(fresh.secondsSinceKey(3000), 1, 'idle of exactly 1000 ms is not a key press');
    fresh.sample(4000, 10, [5, 6]);
    t.eq(fresh.secondsSinceKey(4000), 2, 'a one-pixel move on the y axis is movement');
    fresh.sample(5000, 10, [6, 6]);
    t.eq(fresh.secondsSinceKey(5000), 3, 'a one-pixel move on the x axis is movement');
    fresh.sample(6000, 10, [6, 6]);
    t.eq(fresh.secondsSinceKey(6000), 0, 'typing resumes once the pointer is still again');
    t.eq(fresh.secondsSinceKey(5000), 0, 'secondsSinceKey never goes negative');
}
