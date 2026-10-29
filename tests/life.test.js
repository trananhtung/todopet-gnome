import {getLang, setLang} from '../extension/core/l10n.js';
import {atHour, parseDate} from '../extension/core/dates.js';
import {
    ACCESSORIES, CELEBRATION_KINDS, LAZY_SAVE_MS, LifeRules, PetLife, STAGE_THRESHOLDS, Stage,
    accessoryEarned, accessoryEmoji, accessoryName, accessoryRequirement, accessorySlot,
    defaultLifeState, distractionTotal, isHungry, lifeStage, lifeStateFromJSON, stageName,
    stageNextXP, stageOf, stageScale, stageSprouts, wornAccessories,
} from '../extension/core/life.js';

const MINUTE = 60_000;
const HOUR = 3_600_000;

// A life state with some fields overridden, like `var s = LifeState(); s.x = ...` in Swift.
const lifeWith = (changes = {}) => ({...defaultLifeState(), ...changes});

// An in-memory store with the interface PetLife expects; `saves` records every save, in order.
function memoryStore(initial = {}) {
    const data = new Map(Object.entries(initial));
    return {
        saves: [],
        async load(name) {
            return data.get(name) ?? null;
        },
        save(name, obj) {
            this.saves.push([name, JSON.parse(JSON.stringify(obj))]);
            data.set(name, JSON.parse(JSON.stringify(obj)));
        },
    };
}

export default async function (t) {
    // --- Stages (Stage in PetLife.swift) ---
    t.eq(Stage, {baby: 0, kid: 1, teen: 2, adult: 3, master: 4}, 'Stage numbers match the Swift raw values');
    t.check(Object.isFrozen(Stage) && Object.isFrozen(STAGE_THRESHOLDS), 'Stage and STAGE_THRESHOLDS are frozen');
    t.eq(STAGE_THRESHOLDS, [0, 100, 300, 700, 1500], 'stage XP thresholds');
    t.eq([299, 300, 699, 700, 1499, 1500].map(stageOf), [1, 2, 2, 3, 3, 4], 'stages change exactly at the thresholds');
    t.eq([stageOf(-5), stageOf(NaN), stageOf(undefined)], [0, 0, 0], 'a negative or missing XP is a baby');
    t.eq([0, 1, 2, 3, 4].map(stageScale), [0.8, 0.88, 0.95, 1.02, 1.08], 'stage scale');
    t.eq([0, 1, 2, 3, 4].map(stageSprouts), [2, 1, 0, 0, 0], 'young pets have leaves on their heads');
    t.eq([0, 1, 2, 3, 4].map(stageNextXP), [100, 300, 700, 1500, null], 'XP needed for the next stage (none for master)');
    t.eq([stageName(99), stageScale(99), stageSprouts(99), stageNextXP(99), stageNextXP(-1), stageName('length')],
        ['', 1, 0, null, null, ''], 'an unknown stage has neutral values');
    t.eq(CELEBRATION_KINDS, ['jump', 'spin', 'flip', 'dance', 'fireworks'], 'celebration kinds');

    const savedLang = getLang();
    try {
        setLang('en');
        t.eq([0, 1, 2, 3, 4].map(stageName), ['Baby', 'Kid', 'Teen', 'Grown-up', 'Master'], 'English stage names');
        setLang('vi');
        t.eq([0, 1, 2, 3, 4].map(stageName), ['Em bé', 'Nhóc', 'Thiếu niên',
            'Trưởng thành', 'Cao thủ'], 'Vietnamese stage names');
        t.eq(accessoryName('sunglasses'), 'Kính râm ngầu', 'accessory names follow the language');

        setLang('en');
        t.eq(ACCESSORIES.map(accessoryName), ['Bow', 'Scarf', 'Cool shades', 'Top hat', 'Crown', 'Grad cap'],
            'English accessory names');
        t.eq(ACCESSORIES.map(accessoryRequirement), [
            'Finish your first task', 'A 3-day streak', 'A ×3 combo', 'Finish 25 tasks', 'A 7-day streak',
            'Grow up to Grown-up',
        ], 'English accessory requirements');
        setLang('vi');
        t.eq(ACCESSORIES.map(accessoryRequirement), [
            'Xong việc đầu tiên', 'Chuỗi 3 ngày đạt mục tiêu',
            'Combo ×3', 'Xong 25 việc', 'Chuỗi 7 ngày đạt mục tiêu',
            'Lớn tới giai đoạn Trưởng thành',
        ], 'Vietnamese accessory requirements');
        t.eq(ACCESSORIES.map(accessoryName), ['Nơ xinh', 'Khăn quàng', 'Kính râm ngầu',
            'Mũ quý ông', 'Vương miện', 'Mũ tốt nghiệp'],
        'Vietnamese accessory names');
    } finally {
        setLang(savedLang);
    }

    // --- Accessories ---
    t.eq(ACCESSORIES, ['bow', 'scarf', 'sunglasses', 'tophat', 'crown', 'gradcap'], 'accessories, in the Swift order');
    t.check(Object.isFrozen(ACCESSORIES) && Object.isFrozen(CELEBRATION_KINDS), 'accessory and celebration lists are frozen');
    t.eq(ACCESSORIES.map(accessorySlot), ['head', 'neck', 'face', 'head', 'head', 'head'], 'accessory slots');
    t.eq(ACCESSORIES.map(accessoryEmoji), [
        '\u{1F380}', '\u{1F9E3}', '\u{1F576}\u{FE0F}', '\u{1F3A9}', '\u{1F451}', '\u{1F393}',
    ], 'accessory emoji (sunglasses keep their variation selector)');
    t.eq([accessorySlot('nope'), accessoryEmoji('nope'), accessoryName('nope'), accessoryRequirement('nope')],
        [null, '', '', ''], 'an unknown accessory has no slot, emoji, name or requirement');
    t.eq([
        accessoryEarned('bow', lifeWith({totalDone: 0})), accessoryEarned('bow', lifeWith({totalDone: 1})),
        accessoryEarned('scarf', lifeWith({bestStreak: 2})), accessoryEarned('scarf', lifeWith({bestStreak: 3})),
        accessoryEarned('sunglasses', lifeWith({bestCombo: 2})), accessoryEarned('sunglasses', lifeWith({bestCombo: 3})),
        accessoryEarned('tophat', lifeWith({totalDone: 24})), accessoryEarned('tophat', lifeWith({totalDone: 25})),
        accessoryEarned('crown', lifeWith({bestStreak: 6})), accessoryEarned('crown', lifeWith({bestStreak: 7})),
        accessoryEarned('gradcap', lifeWith({xp: 699})), accessoryEarned('gradcap', lifeWith({xp: 700})),
        accessoryEarned('nope', lifeWith({totalDone: 99, xp: 9999})),
    ], [false, true, false, true, false, true, false, true, false, true, false, true, false],
    'accessory unlock thresholds');

    // --- Life state ---
    const fresh = defaultLifeState();
    t.eq(fresh, {
        satiety: 70, dirt: 0, xp: 0, totalDone: 0, streak: 0, bestStreak: 0, combo: 0, bestCombo: 0, goldens: 0,
        lastDoneAt: null, lastDecayAt: null, perfectDays: [], unlocked: [], wearing: [],
        dayKey: '', dayCompleted: 0, dayPlanned: 0, dayTarget: 3, dayWorkday: true, distraction: {},
    }, 'a new pet: 70 satiety, nothing else');
    fresh.unlocked.push('bow');
    t.eq(defaultLifeState().unlocked, [], 'defaultLifeState returns a fresh object each call');
    t.check(!isHungry(lifeWith({satiety: 30})) && isHungry(lifeWith({satiety: 29.9})), 'hungry below 30');
    t.check(lifeStage(lifeWith({xp: 120})) === Stage.kid, 'lifeStage from XP');
    t.eq(wornAccessories(lifeWith({wearing: ['bow', 'ghost', 'crown']})), ['bow', 'crown'],
        'wornAccessories skips unknown names');
    t.eq(distractionTotal(lifeWith({distraction: {'youtube.com': 720, 'facebook.com': 300}})), 1020,
        'distraction total adds the apps up');
    t.eq(distractionTotal(defaultLifeState()), 0, 'no distraction: 0 seconds');

    // --- Pet life: feeding, combos, golden treats, unlocks (DevTools.swift "Pet life") ---
    t.check(stageOf(0) === Stage.baby && stageOf(99) === Stage.baby && stageOf(100) === Stage.kid &&
        stageOf(5000) === Stage.master, 'growth stages from XP');
    const life = defaultLifeState();
    const t0 = atHour(11, 0, parseDate('2026-10-25'));
    const at = ms => new Date(t0.getTime() + ms);
    const f1 = LifeRules.feed(life, t0, 0.5, 0);
    t.check(f1.combo === 1 && life.xp === 10 && life.satiety === 95 && f1.food === '\u{1F359}' && f1.kind === 'jump',
        'first feed');
    t.check(f1.unlocked.length === 1 && f1.unlocked[0] === 'bow' && life.wearing.length === 1 && life.wearing[0] === 'bow',
        'first task unlocks and wears the bow');
    t.eq(f1, {food: '\u{1F359}', combo: 1, golden: false, kind: 'jump', unlocked: ['bow'], levelUp: null, cleaned: false},
        'a feed result carries food, combo, golden, kind, unlocked, levelUp and cleaned');
    LifeRules.feed(life, at(600_000), 0.5, 0.3);
    const f3 = LifeRules.feed(life, at(1_200_000), 0.5, 0.3);
    t.check(f3.combo === 3 && f3.kind === 'fireworks' && life.xp === 10 + 15 + 20,
        'combo grows within 30 minutes and pays more XP');
    t.check(f3.unlocked.includes('sunglasses') && life.wearing.includes('sunglasses'), 'combo ×3 unlocks sunglasses');
    const f4 = LifeRules.feed(life, at(1_200_000 + 2_400_000), 0.05, 0.9);
    t.check(f4.combo === 1 && f4.golden && f4.food === '\u{1F370}' && life.goldens === 1,
        'combo resets after a gap; 10% golden treat');

    // Hunger and day settlement.
    const hungry = lifeWith({satiety: 50, lastDecayAt: t0.getTime()});
    LifeRules.decay(hungry, at(1_800_000), true);
    t.near(hungry.satiety, 46.5, 0.01, 'hunger: −7 per work hour');
    LifeRules.decay(hungry, at(1_800_000 + 3 * HOUR), true);
    t.near(hungry.satiety, 39.5, 0.01, 'hunger capped at one hour per step (sleep, lunch)');
    LifeRules.decay(hungry, at(1_800_000 + 5 * HOUR), false);
    t.near(hungry.satiety, 39.5, 0.01, 'no hunger outside work');

    const days = lifeWith({dayKey: '2026-10-20'});
    LifeRules.syncDay(days, 3, 3, 3, true);
    LifeRules.closeDay(days, '2026-10-21', () => true);
    t.check(days.streak === 1 && days.perfectDays.length === 1 && days.perfectDays[0] === '2026-10-20' && days.xp === 30,
        'target met: streak +1, perfect-day sticker');
    LifeRules.syncDay(days, 0, 2, 3, true);
    LifeRules.closeDay(days, '2026-10-24', () => true);
    t.check(days.streak === 0 && days.dirt === 3, 'lazy day and two unseen workdays make the pet dirty');
    LifeRules.feed(days, t0, 0.5, 0);
    t.check(days.dirt === 2, 'a finished task washes one layer off');
    const weekend = lifeWith({dayKey: '2026-10-24', streak: 4});
    LifeRules.syncDay(weekend, 0, 0, 3, false);
    LifeRules.closeDay(weekend, '2026-10-25', () => false);
    t.check(weekend.streak === 4 && weekend.dirt === 0, "days off don't break the streak");

    const wardrobe = new PetLife({initial: lifeWith({unlocked: ['bow', 'crown'], wearing: ['bow']})});
    wardrobe.toggle('crown');
    t.check(wardrobe.state.wearing.length === 1 && wardrobe.state.wearing[0] === 'crown', 'one item per slot');
    const old = lifeStateFromJSON({xp: 120});
    t.check(old.xp === 120 && old.satiety === 70, 'saved state with missing fields still loads');

    // --- feed(): the formula in detail ---
    {
        const s = defaultLifeState();
        const golden = LifeRules.feed(s, t0, 0.05, 0.9);
        t.check(golden.golden && s.xp === 30 && s.goldens === 1 && golden.kind === 'fireworks',
            'a golden treat pays 10 + 20 XP and always fireworks');
        t.check(!LifeRules.feed(defaultLifeState(), t0, 0.1, 0).golden, 'roll 0.1 is not golden (strictly below 10%)');
        t.check(LifeRules.feed(defaultLifeState(), t0, 0.0999, 0).golden, 'roll just below 0.1 is golden');

        // Combo XP: 10, 15, 20, 25, 30, 30 ...
        const c = defaultLifeState();
        const gains = [];
        for (let i = 0; i < 7; i++) {
            const before = c.xp;
            LifeRules.feed(c, at(i * 5 * MINUTE), 0.5, 0);
            gains.push(c.xp - before);
        }
        t.eq(gains, [10, 15, 20, 25, 30, 30, 30], 'combo XP bonus is capped at +20');
        t.check(c.combo === 7 && c.bestCombo === 7, 'combo and best combo count up');

        // The combo window is 30 minutes inclusive.
        const w = defaultLifeState();
        LifeRules.feed(w, t0, 0.5, 0);
        t.check(LifeRules.feed(w, at(LifeRules.comboWindowMs), 0.5, 0).combo === 2, 'exactly 30 minutes still counts');
        t.check(LifeRules.feed(w, at(LifeRules.comboWindowMs * 2 + 1), 0.5, 0).combo === 1,
            'one millisecond past 30 minutes resets the combo');
        t.check(w.bestCombo === 2, 'a reset keeps the best combo');
        const backwards = defaultLifeState();
        LifeRules.feed(backwards, at(HOUR), 0.5, 0);
        t.check(LifeRules.feed(backwards, t0, 0.5, 0).combo === 2, 'a clock that went back stays inside the window');
        t.check(w.lastDoneAt === at(LifeRules.comboWindowMs * 2 + 1).getTime(), 'lastDoneAt stores epoch milliseconds');

        // Satiety, dirt, level up.
        const full = lifeWith({satiety: 90});
        LifeRules.feed(full, t0, 0.5, 0);
        t.check(full.satiety === 100, 'satiety tops out at 100');
        const dirty = lifeWith({dirt: 2});
        const washed = LifeRules.feed(dirty, t0, 0.5, 0);
        t.check(washed.cleaned && dirty.dirt === 1, 'a task washes one layer and reports it');
        t.check(!LifeRules.feed(defaultLifeState(), t0, 0.5, 0).cleaned, 'a clean pet has nothing to wash');
        const grower = lifeWith({xp: 95});
        const grew = LifeRules.feed(grower, t0, 0.5, 0);
        t.check(grew.levelUp === Stage.kid && grower.xp === 105, 'crossing 100 XP reports the new stage');
        t.check(LifeRules.feed(grower, at(MINUTE), 0.5, 0).levelUp === null, 'staying in a stage reports no level up');
        t.check(LifeRules.feed(lifeWith({xp: 690, totalDone: 30}), t0, 0.5, 0).unlocked.includes('gradcap'),
            'growing up to Grown-up unlocks the grad cap');

        // Food and dance picks.
        const kinds = [0, 0.25, 0.5, 0.75].map(p => LifeRules.feed(defaultLifeState(), t0, 0.5, p).kind);
        t.eq(kinds, ['jump', 'spin', 'flip', 'dance'], 'pick chooses the dance');
        t.eq(LifeRules.feed(defaultLifeState(), t0, 0.5, 0.999999).kind, 'dance', 'pick just below 1 is the last dance');
        t.eq(LifeRules.feed(defaultLifeState(), t0, 0.5, 1).kind, 'dance', 'pick 1 is clamped to the last dance');
        t.eq(LifeRules.foods, ['\u{1F359}', '\u{1F361}', '\u{1F41F}', '\u{1F9C1}', '\u{1F353}', '\u{1F36A}', '\u{1F95F}', '\u{1F369}'],
            'the eight foods');
        t.check(Object.isFrozen(LifeRules.foods), 'foods are frozen');
        const foodAt = p => LifeRules.feed(defaultLifeState(), t0, 0.5, p).food;
        t.eq([0, 1.5 / 56, 0.3, 0.5, 0.9, 0.999999].map(foodAt),
            ['\u{1F359}', '\u{1F361}', '\u{1F359}', '\u{1F353}', '\u{1F41F}', '\u{1F369}'],
            'the food follows floor(pick * 56) mod 8');
        const odd = LifeRules.feed(defaultLifeState(), t0, 0.5, -1);
        t.check(LifeRules.foods.includes(odd.food) && odd.kind === 'jump', 'a negative pick still gives a food and a dance');
        const nan = LifeRules.feed(defaultLifeState(), t0, 0.5, NaN);
        t.check(LifeRules.foods.includes(nan.food) && nan.kind === 'jump', 'a NaN pick still gives a food and a dance');
        t.eq(LifeRules.comboWindowMs, 1_800_000, 'the combo window is 30 minutes');
        t.eq(LifeRules.hungerPerHour, 7, 'hunger is 7 per work hour');
    }

    // --- unfeed ---
    {
        const s = lifeWith({totalDone: 5, xp: 50, satiety: 60, combo: 3});
        LifeRules.unfeed(s);
        t.check(s.totalDone === 4 && s.xp === 40 && s.satiety === 35 && s.combo === 2, 'undoing a completion reverses one feed');
        const empty = lifeWith({totalDone: 0, xp: 5, satiety: 10, combo: 0});
        LifeRules.unfeed(empty);
        t.check(empty.totalDone === 0 && empty.xp === 0 && empty.satiety === 0 && empty.combo === 0,
            'undo never goes below zero');
    }

    // --- checkUnlocks ---
    {
        const s = lifeWith({totalDone: 25, bestStreak: 7, bestCombo: 3, xp: 700});
        const got = LifeRules.checkUnlocks(s);
        t.eq(got, ['bow', 'scarf', 'sunglasses', 'tophat', 'crown', 'gradcap'], 'everything earned unlocks, in order');
        t.eq(s.wearing, ['bow', 'scarf', 'sunglasses'], 'only one item per slot is put on automatically');
        t.eq(LifeRules.checkUnlocks(s), [], 'nothing unlocks twice');
        const taken = lifeWith({totalDone: 1, unlocked: ['scarf'], wearing: ['scarf']});
        t.eq(LifeRules.checkUnlocks(taken), ['bow'], 'unlocking skips what is already unlocked');
        t.eq(taken.wearing, ['scarf', 'bow'], 'a free slot gets the new item');
        const busy = lifeWith({totalDone: 1, unlocked: ['crown'], wearing: ['crown']});
        LifeRules.checkUnlocks(busy);
        t.eq([busy.unlocked, busy.wearing], [['crown', 'bow'], ['crown']], 'a taken slot keeps what is worn');
        const ghost = lifeWith({totalDone: 1, wearing: ['ghost']});
        LifeRules.checkUnlocks(ghost);
        t.eq(ghost.wearing, ['ghost', 'bow'], 'an unknown worn name does not block a slot');
    }

    // --- decay ---
    {
        const first = defaultLifeState();
        LifeRules.decay(first, t0, true);
        t.check(first.satiety === 70 && first.lastDecayAt === t0.getTime(), 'the first decay only starts the clock');
        const same = lifeWith({satiety: 50, lastDecayAt: t0.getTime()});
        LifeRules.decay(same, t0, true);
        t.check(same.satiety === 50, 'no time passed, no hunger');
        const back = lifeWith({satiety: 50, lastDecayAt: t0.getTime()});
        LifeRules.decay(back, at(-HOUR), true);
        t.check(back.satiety === 50 && back.lastDecayAt === at(-HOUR).getTime(), 'a clock that went back costs nothing');
        const off = lifeWith({satiety: 50, lastDecayAt: t0.getTime()});
        LifeRules.decay(off, at(HOUR), false);
        t.check(off.satiety === 50 && off.lastDecayAt === at(HOUR).getTime(), 'off hours still move the clock');
        const starving = lifeWith({satiety: 3, lastDecayAt: t0.getTime()});
        LifeRules.decay(starving, at(HOUR), true);
        t.eq(starving.satiety, 0, 'satiety never goes below zero');
        const hour = lifeWith({satiety: 50, lastDecayAt: t0.getTime()});
        LifeRules.decay(hour, at(HOUR), true);
        t.near(hour.satiety, 43, 0.0001, 'one work hour costs exactly 7');
    }

    // --- syncDay, addDistraction ---
    {
        const s = lifeWith({dayKey: '2026-10-25'});
        LifeRules.syncDay(s, 2, 5, 4, false);
        t.eq([s.dayCompleted, s.dayPlanned, s.dayTarget, s.dayWorkday], [2, 5, 4, false], 'syncDay stores the day counts');
        LifeRules.addDistraction(s, 'youtube.com', 60);
        LifeRules.addDistraction(s, 'youtube.com', 30);
        LifeRules.addDistraction(s, 'TikTok', 12);
        t.eq(s.distraction, {'youtube.com': 90, TikTok: 12}, 'time on each site adds up');
        t.eq(distractionTotal(s), 102, 'and so does the total');
        LifeRules.addDistraction(s, 'constructor', 5);
        LifeRules.addDistraction(s, '__proto__', 7);
        LifeRules.addDistraction(s, '__proto__', 1);
        t.check(s.distraction.constructor === 5 && Object.getOwnPropertyDescriptor(s.distraction, '__proto__')?.value === 8,
            'labels that look like Object properties are ordinary keys');
        t.check(Object.getPrototypeOf(s.distraction) === Object.prototype, "a label can't replace the prototype");
    }

    // --- closeDay ---
    {
        t.eq(LifeRules.nextDay('2026-10-31'), '2026-11-01', 'next day rolls over the month');
        t.eq(LifeRules.nextDay('2026-12-31'), '2027-01-01', 'next day rolls over the year');
        t.eq(LifeRules.nextDay('garbage'), '9999', 'an unparseable day has no next day');

        const empty = defaultLifeState();
        t.eq(LifeRules.closeDay(empty, '2026-10-25', () => true), [], 'the first day settles nothing');
        t.eq(empty.dayKey, '2026-10-25', 'and starts the stored day');
        const sameDay = lifeWith({dayKey: '2026-10-25', dayCompleted: 2, combo: 2});
        t.eq(LifeRules.closeDay(sameDay, '2026-10-25', () => true), [], 'the same day settles nothing');
        t.eq([sameDay.dayCompleted, sameDay.combo], [2, 2], 'and keeps the day going');
        const earlier = lifeWith({dayKey: '2026-10-26', dayCompleted: 2});
        LifeRules.closeDay(earlier, '2026-10-25', () => true);
        t.eq([earlier.dayKey, earlier.dayCompleted], ['2026-10-26', 2], 'a day key from the future is left alone');

        // A good day.
        const good = lifeWith({dayKey: '2026-10-20', streak: 2, bestStreak: 2, combo: 4, distraction: {x: 5}});
        LifeRules.syncDay(good, 3, 5, 3, true);
        const unlockedByStreak = LifeRules.closeDay(good, '2026-10-21', () => true);
        t.check(good.streak === 3 && good.bestStreak === 3 && good.perfectDays.length === 0 && good.xp === 0,
            'target met but not everything planned: streak grows, no sticker');
        t.eq(unlockedByStreak, ['scarf'], 'closeDay returns the accessories the new streak unlocked');
        t.eq(good.wearing, ['scarf'], 'and puts the free one on');
        t.check(good.dayKey === '2026-10-21' && good.dayCompleted === 0 && good.dayPlanned === 0 && good.combo === 0 &&
            Object.keys(good.distraction).length === 0, 'a new day resets the counters, combo and distraction');

        // A day with target 0 never counts as met.
        const noTarget = lifeWith({dayKey: '2026-10-20', streak: 2});
        LifeRules.syncDay(noTarget, 5, 5, 0, true);
        LifeRules.closeDay(noTarget, '2026-10-21', () => true);
        t.check(noTarget.streak === 0 && noTarget.dirt === 0, 'a zero target is never met, and 5 done is not lazy');

        // Some progress but under target: streak breaks, no dirt.
        const some = lifeWith({dayKey: '2026-10-20', streak: 2});
        LifeRules.syncDay(some, 1, 3, 3, true);
        LifeRules.closeDay(some, '2026-10-21', () => true);
        t.check(some.streak === 0 && some.dirt === 0, 'under target with some progress: streak breaks, pet stays clean');

        // Dirt tops out at 3.
        const filthy = lifeWith({dayKey: '2026-10-20', dirt: 3});
        LifeRules.syncDay(filthy, 0, 0, 3, true);
        LifeRules.closeDay(filthy, '2026-10-21', () => true);
        t.eq(filthy.dirt, 3, 'dirt tops out at 3');

        // Unseen days: workdays only, asked one by one.
        const asked = [];
        const gap = lifeWith({dayKey: '2026-10-20', dayWorkday: false, streak: 5});
        LifeRules.closeDay(gap, '2026-10-24', day => {
            asked.push(day);
            return day !== '2026-10-22';
        });
        t.eq(asked, ['2026-10-21', '2026-10-22', '2026-10-23'], 'unseen days are checked in order, excluding today');
        t.check(gap.streak === 0 && gap.dirt === 2, 'two unseen workdays and one day off');

        // The loop guard.
        let calls = 0;
        const long = lifeWith({dayKey: '2026-01-01', dayWorkday: false});
        LifeRules.closeDay(long, '2026-10-25', () => {
            calls += 1;
            return true;
        });
        t.check(calls === 30 && long.dirt === 3 && long.dayKey === '2026-10-25', 'at most 30 unseen days are checked');

        // An unparseable stored day: no unseen days, but the day still moves on.
        let junkCalls = 0;
        const junk = lifeWith({dayKey: '1999-13-45', dayWorkday: false});
        LifeRules.closeDay(junk, '2026-10-25', () => {
            junkCalls += 1;
            return true;
        });
        t.check(junkCalls === 0 && junk.dayKey === '2026-10-25', 'closeDay survives an unparseable stored day');

        // Perfect days keep the last 60.
        const many = lifeWith({
            dayKey: '2026-10-20',
            perfectDays: Array.from({length: 65}, (_v, i) => `d${i}`),
        });
        LifeRules.syncDay(many, 3, 3, 3, true);
        LifeRules.closeDay(many, '2026-10-21', () => true);
        t.check(many.perfectDays.length === 60 && many.perfectDays[0] === 'd6' && many.perfectDays[59] === '2026-10-20',
            'only the last 60 perfect days are kept');
    }

    // --- lifeStateFromJSON ---
    {
        t.eq(lifeStateFromJSON(null), defaultLifeState(), 'null gives a new pet');
        t.eq(lifeStateFromJSON(undefined), defaultLifeState(), 'undefined gives a new pet');
        t.eq([lifeStateFromJSON('x'), lifeStateFromJSON(5), lifeStateFromJSON([1, 2]), lifeStateFromJSON(true)],
            [defaultLifeState(), defaultLifeState(), defaultLifeState(), defaultLifeState()],
            'garbage that is not an object gives a new pet');

        const full = lifeWith({
            satiety: 12.5, dirt: 2, xp: 800, totalDone: 31, streak: 4, bestStreak: 5, combo: 2, bestCombo: 3, goldens: 1,
            lastDoneAt: 1_792_000_000_000, lastDecayAt: 1_792_000_060_000, perfectDays: ['2026-10-20'],
            unlocked: ['bow', 'scarf'], wearing: ['scarf'], dayKey: '2026-10-25', dayCompleted: 2, dayPlanned: 4,
            dayTarget: 5, dayWorkday: false, distraction: {'youtube.com': 720.5},
        });
        t.eq(lifeStateFromJSON(JSON.parse(JSON.stringify(full))), full, 'a saved state round-trips through JSON');

        const bad = lifeStateFromJSON({
            satiety: 'full', dirt: 1.5, xp: '120', totalDone: null, streak: NaN, bestStreak: [], combo: {}, bestCombo: true,
            goldens: Infinity, lastDoneAt: 'yesterday', lastDecayAt: NaN, perfectDays: 'none', unlocked: [1, 2],
            wearing: {bow: true}, dayKey: 20261025, dayCompleted: '2', dayPlanned: false, dayTarget: null, dayWorkday: 'yes',
            distraction: [1, 2],
        });
        t.eq(bad, defaultLifeState(), 'every wrongly typed field takes its default');
        t.eq(lifeStateFromJSON({xp: 120, extra: 'ignored', satiety: 40}), lifeWith({xp: 120, satiety: 40}),
            'good fields are kept, unknown ones dropped');
        t.eq(lifeStateFromJSON({distraction: {a: 1, b: 'x'}}).distraction, {}, 'a distraction map with a bad value is dropped');
        t.eq(lifeStateFromJSON({lastDoneAt: null, lastDecayAt: 0}).lastDecayAt, 0, 'epoch 0 is a valid time');

        const source = {unlocked: ['bow'], wearing: ['bow'], perfectDays: ['d'], distraction: {a: 1}};
        const copy = lifeStateFromJSON(source);
        copy.unlocked.push('crown');
        copy.wearing.push('crown');
        copy.perfectDays.push('e');
        copy.distraction.b = 2;
        t.eq(source, {unlocked: ['bow'], wearing: ['bow'], perfectDays: ['d'], distraction: {a: 1}},
            'the decoded state shares nothing with its input');
        const proto = lifeStateFromJSON(JSON.parse('{"distraction":{"__proto__":5,"a":1}}'));
        t.check(Object.getPrototypeOf(proto.distraction) === Object.prototype &&
            Object.getOwnPropertyDescriptor(proto.distraction, '__proto__')?.value === 5, 'a __proto__ key stays an ordinary key');
    }

    // --- PetLife ---
    {
        const bare = new PetLife();
        t.eq(bare.state, defaultLifeState(), 'a PetLife starts as a new pet');
        const result = bare.mutate(s => LifeRules.feed(s, t0, 0.5, 0));
        t.check(result.combo === 1 && bare.state.xp === 10 && bare.state.wearing[0] === 'bow',
            'mutate runs the change and returns what it returned');
        await bare.load();
        t.check(bare.state.xp === 10, 'load without a store changes nothing');

        // initial is copied and tolerated.
        const seed = lifeWith({xp: 50});
        const seeded = new PetLife({initial: seed});
        seed.xp = 999;
        t.check(seeded.state.xp === 50, 'the initial state is copied');
        t.eq(new PetLife({initial: {xp: 7}}).state, lifeWith({xp: 7}), 'a partial initial state gets defaults');

        // A thrown change leaves the state alone.
        const before = JSON.stringify(seeded.state);
        let thrown = null;
        try {
            seeded.mutate(s => {
                s.xp = 1;
                s.unlocked.push('crown');
                throw new Error('boom');
            });
        } catch (e) {
            thrown = e;
        }
        t.check(thrown?.message === 'boom' && JSON.stringify(seeded.state) === before,
            'a change that throws is discarded and the error is passed on');

        // An old reference is a snapshot.
        const held = seeded.state;
        seeded.mutate(s => {
            s.xp += 5;
        });
        t.check(held.xp === 50 && seeded.state.xp === 55, 'a state read earlier is not changed by later mutations');

        // Toggle.
        const closet = new PetLife({initial: lifeWith({unlocked: ['bow', 'crown', 'scarf'], wearing: ['bow']})});
        closet.toggle('scarf');
        t.eq(closet.state.wearing, ['bow', 'scarf'], 'a different slot is added');
        closet.toggle('crown');
        t.eq(closet.state.wearing, ['scarf', 'crown'], 'the same slot is replaced');
        closet.toggle('crown');
        t.eq(closet.state.wearing, ['scarf'], 'wearing it again takes it off');
        closet.toggle('tophat');
        t.eq(closet.state.wearing, ['scarf'], "a locked accessory can't be worn");
        closet.toggle('ghost');
        t.eq(closet.state.wearing, ['scarf'], 'an unknown accessory is ignored');
        const odd = new PetLife({initial: lifeWith({unlocked: ['bow', 'ghost'], wearing: ['ghost']})});
        odd.toggle('ghost');
        t.eq(odd.state.wearing, ['ghost'], 'an unknown name in the unlocked list cannot be worn either');
        odd.toggle('bow');
        t.eq(odd.state.wearing, ['ghost', 'bow'], 'and does not take up a slot');

        // Store: load and save.
        const stored = memoryStore({life: {xp: 120, unlocked: ['bow'], wearing: []}});
        const pet = new PetLife({store: stored});
        t.eq(pet.state, defaultLifeState(), 'with a store, the pet is new until load');
        await pet.load();
        t.check(pet.state.xp === 120 && pet.state.satiety === 70 && pet.state.unlocked[0] === 'bow',
            'load reads the stored life, filling in missing fields');
        t.eq(stored.saves, [], 'load does not save');
        pet.toggle('bow');
        t.check(stored.saves.length === 1 && stored.saves[0][0] === 'life' && stored.saves[0][1].wearing[0] === 'bow',
            'toggle saves under the name life');
        pet.mutate(s => {
            s.xp += 1;
        });
        pet.mutate(s => {
            s.xp += 1;
        });
        t.check(stored.saves.length === 3 && stored.saves[1][1].xp === 121 && stored.saves[2][1].xp === 122,
            'every mutate saves, in order');
        pet.toggle('crown');
        t.check(stored.saves.length === 3, 'a locked toggle changes nothing, so saves nothing');

        const empty = new PetLife({store: memoryStore()});
        await empty.load();
        t.eq(empty.state, defaultLifeState(), 'no stored life gives a new pet');
        const garbled = new PetLife({store: memoryStore({life: 'not a pet'})});
        await garbled.load();
        t.eq(garbled.state, defaultLifeState(), 'a garbled stored life gives a new pet');

        const failing = {
            async load() {
                throw new Error('disk gone');
            },
            save() {},
        };
        await t.rejects(new PetLife({store: failing}).load(), e => e.message === 'disk gone',
            'a failing load is passed on (never overwrite a pet we could not read)');

        // A store that fails to save must not break the game.
        const flush = async () => {
            for (let i = 0; i < 5; i++)
                await Promise.resolve();
        };
        const heard = [];
        const throwing = new PetLife({
            store: {load: async () => null, save() {
                throw new Error('no space');
            }},
            onSaveError: e => heard.push(e.message),
        });
        const value = throwing.mutate(s => {
            s.xp = 9;
            return 'ok';
        });
        t.check(value === 'ok' && throwing.state.xp === 9 && heard.length === 1 && heard[0] === 'no space',
            'a store that throws on save is reported and the change stays');
        const heardAsync = [];
        const rejecting = new PetLife({
            store: {load: async () => null, save: () => Promise.reject(new Error('async fail'))},
            onSaveError: e => heardAsync.push(e.message),
        });
        rejecting.mutate(s => {
            s.xp = 4;
        });
        await flush();
        t.check(rejecting.state.xp === 4 && heardAsync.length === 1 && heardAsync[0] === 'async fail',
            'a store that rejects on save is reported and the change stays');

        // Lazy changes (hunger counting down every 15 s) are not written each time: with the next ordinary change,
        // once LAZY_SAVE_MS have passed since the last save, or on flush().
        let clock = t0.getTime();
        const lazyStore = memoryStore();
        const lazy = new PetLife({store: lazyStore, now: () => new Date(clock)});
        const tick = () => lazy.mutate(x => LifeRules.decay(x, new Date(clock), true), {lazy: true});
        tick();
        t.eq(lazyStore.saves.length, 1, 'the first lazy change is saved');
        for (let i = 1; i <= 4; i++) {
            clock += 15_000;
            tick();
        }
        t.check(lazyStore.saves.length === 1 && lazy.state.lastDecayAt === clock,
            'lazy changes within LAZY_SAVE_MS stay in memory');
        lazy.mutate(x => {
            x.xp += 5;
        });
        t.check(lazyStore.saves.length === 2 && lazyStore.saves[1][1].lastDecayAt === clock && lazyStore.saves[1][1].xp === 5,
            'an ordinary change saves at once, with the lazy changes before it');
        clock += 15_000;
        tick();
        t.eq(lazyStore.saves.length, 2, 'the clock starts again at every save');
        clock += LAZY_SAVE_MS - 15_000;
        tick();
        t.check(lazyStore.saves.length === 3 && lazyStore.saves[2][1].lastDecayAt === clock,
            'a lazy change LAZY_SAVE_MS after the last save is saved');
        clock += 15_000;
        tick();
        lazy.flush();
        t.check(lazyStore.saves.length === 4 && lazyStore.saves[3][1].lastDecayAt === clock, 'flush() saves a lazy change');
        lazy.flush();
        t.eq(lazyStore.saves.length, 4, 'flush() with nothing unsaved saves nothing');
        clock -= HOUR;
        tick();
        t.eq(lazyStore.saves.length, 5, 'a clock that went back saves');
        t.check(LAZY_SAVE_MS >= 60_000 && LAZY_SAVE_MS <= 15 * MINUTE, 'LAZY_SAVE_MS is minutes, not seconds');
    }
}
