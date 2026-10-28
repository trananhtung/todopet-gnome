// The pet's long-term life (port of PetLife.swift): growth stages, accessories, the saved life state,
// the pure rules for feeding, hunger, dirt and day settlement, and PetLife, which holds the state and saves it.
// Pure: no timers and nothing from GNOME Shell, so it is unit-tested.
import {L} from './l10n.js';
import {nextDayKey} from './dates.js';

// --- Growth stages, reached with XP from finished tasks ---

export const Stage = Object.freeze({baby: 0, kid: 1, teen: 2, adult: 3, master: 4});

export const STAGE_THRESHOLDS = Object.freeze([0, 100, 300, 700, 1500]);

// [vi, en] per stage.
const STAGE_NAMES = Object.freeze([
    ['Em bé', 'Baby'],
    ['Nhóc', 'Kid'],
    ['Thiếu niên', 'Teen'],
    ['Trưởng thành', 'Grown-up'],
    ['Cao thủ', 'Master'],
]);
// Drawn size relative to the grown-up pet.
const STAGE_SCALES = Object.freeze([0.8, 0.88, 0.95, 1.02, 1.08]);
// Little leaves on the head of young pets.
const STAGE_SPROUTS = Object.freeze([2, 1, 0, 0, 0]);

// Table lookup that only accepts a whole-number index, so 'length' or 1.5 never reach a property.
const entry = (table, index) => (Number.isInteger(index) ? table[index] : undefined);

// The stage reached with `xp`: the highest one whose threshold it has passed.
export function stageOf(xp) {
    let stage = Stage.baby;
    STAGE_THRESHOLDS.forEach((threshold, i) => {
        if (xp >= threshold)
            stage = i;
    });
    return stage;
}

export function stageName(stage) {
    const names = entry(STAGE_NAMES, stage);
    return names ? L(names[0], names[1]) : '';
}

export function stageScale(stage) {
    return entry(STAGE_SCALES, stage) ?? 1;
}

export function stageSprouts(stage) {
    return entry(STAGE_SPROUTS, stage) ?? 0;
}

// XP needed for the next stage; null for the last one.
export function stageNextXP(stage) {
    return Number.isInteger(stage) && stage >= 0 ? (STAGE_THRESHOLDS[stage + 1] ?? null) : null;
}

// --- Accessories, unlocked by milestones ---

export const ACCESSORIES = Object.freeze(['bow', 'scarf', 'sunglasses', 'tophat', 'crown', 'gradcap']);

export const CELEBRATION_KINDS = Object.freeze(['jump', 'spin', 'flip', 'dance', 'fireworks']);

// slot is where it is worn; name and requirement are [vi, en]; earned decides from the life state.
const ACCESSORY_INFO = Object.freeze({
    bow: {
        slot: 'head', emoji: '🎀', name: ['Nơ xinh', 'Bow'],
        requirement: ['Xong việc đầu tiên', 'Finish your first task'],
        earned: s => s.totalDone >= 1,
    },
    scarf: {
        slot: 'neck', emoji: '🧣', name: ['Khăn quàng', 'Scarf'],
        requirement: ['Chuỗi 3 ngày đạt mục tiêu', 'A 3-day streak'],
        earned: s => s.bestStreak >= 3,
    },
    sunglasses: {
        // U+1F576 with its emoji variation selector, as in the Swift source.
        slot: 'face', emoji: '\u{1F576}\u{FE0F}', name: ['Kính râm ngầu', 'Cool shades'],
        requirement: ['Combo ×3', 'A ×3 combo'],
        earned: s => s.bestCombo >= 3,
    },
    tophat: {
        slot: 'head', emoji: '🎩', name: ['Mũ quý ông', 'Top hat'],
        requirement: ['Xong 25 việc', 'Finish 25 tasks'],
        earned: s => s.totalDone >= 25,
    },
    crown: {
        slot: 'head', emoji: '👑', name: ['Vương miện', 'Crown'],
        requirement: ['Chuỗi 7 ngày đạt mục tiêu', 'A 7-day streak'],
        earned: s => s.bestStreak >= 7,
    },
    gradcap: {
        slot: 'head', emoji: '🎓', name: ['Mũ tốt nghiệp', 'Grad cap'],
        requirement: ['Lớn tới giai đoạn Trưởng thành', 'Grow up to Grown-up'],
        earned: s => stageOf(s.xp) >= Stage.adult,
    },
});

// The table row for a known accessory, null for anything else.
const accessoryInfo = accessory => (ACCESSORIES.includes(accessory) ? ACCESSORY_INFO[accessory] : null);

// 'head', 'face' or 'neck'; null for an unknown accessory.
export function accessorySlot(accessory) {
    return accessoryInfo(accessory)?.slot ?? null;
}

export function accessoryEmoji(accessory) {
    return accessoryInfo(accessory)?.emoji ?? '';
}

export function accessoryName(accessory) {
    const info = accessoryInfo(accessory);
    return info ? L(info.name[0], info.name[1]) : '';
}

export function accessoryRequirement(accessory) {
    const info = accessoryInfo(accessory);
    return info ? L(info.requirement[0], info.requirement[1]) : '';
}

export function accessoryEarned(accessory, state) {
    return accessoryInfo(accessory)?.earned(state) ?? false;
}

// --- Life state: everything the pet remembers across days ---

// A new pet. lastDoneAt and lastDecayAt are epoch milliseconds (or null).
export function defaultLifeState() {
    return {
        satiety: 70,
        dirt: 0,
        xp: 0,
        totalDone: 0,
        streak: 0,
        bestStreak: 0,
        combo: 0,
        bestCombo: 0,
        goldens: 0,
        lastDoneAt: null,
        lastDecayAt: null,
        perfectDays: [],
        unlocked: [],
        wearing: [],
        // The day in progress, settled when the date changes.
        dayKey: '',
        dayCompleted: 0,
        dayPlanned: 0,
        dayTarget: 3,
        dayWorkday: true,
        // Seconds spent today in each distracting app or site.
        distraction: {},
    };
}

const isRecord = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const finiteOr = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const wholeOr = (v, fallback) => (Number.isSafeInteger(v) ? v : fallback);
const stringOr = (v, fallback) => (typeof v === 'string' ? v : fallback);
const boolOr = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
const stringsOr = (v, fallback) => (Array.isArray(v) && v.every(x => typeof x === 'string') ? [...v] : fallback);

// Labels come from app and site names, so keys like 'constructor' or '__proto__' must stay ordinary keys.
function setOwn(record, key, value) {
    Object.defineProperty(record, key, {value, writable: true, enumerable: true, configurable: true});
}

// A copy of a {label: seconds} map, or null when it is not one.
function secondsMapOr(v) {
    if (!isRecord(v))
        return null;
    const copy = {};
    for (const [label, seconds] of Object.entries(v)) {
        if (typeof seconds !== 'number' || !Number.isFinite(seconds))
            return null;
        setOwn(copy, label, seconds);
    }
    return copy;
}

// Reads a saved life state. Tolerates missing or wrongly typed fields, so adding fields later never wipes the
// pet's progress; null, undefined or garbage give a new pet. The result shares nothing with `obj`.
export function lifeStateFromJSON(obj) {
    const d = defaultLifeState();
    if (!isRecord(obj))
        return d;
    return {
        satiety: finiteOr(obj.satiety, d.satiety),
        dirt: wholeOr(obj.dirt, d.dirt),
        xp: wholeOr(obj.xp, d.xp),
        totalDone: wholeOr(obj.totalDone, d.totalDone),
        streak: wholeOr(obj.streak, d.streak),
        bestStreak: wholeOr(obj.bestStreak, d.bestStreak),
        combo: wholeOr(obj.combo, d.combo),
        bestCombo: wholeOr(obj.bestCombo, d.bestCombo),
        goldens: wholeOr(obj.goldens, d.goldens),
        lastDoneAt: finiteOr(obj.lastDoneAt, d.lastDoneAt),
        lastDecayAt: finiteOr(obj.lastDecayAt, d.lastDecayAt),
        perfectDays: stringsOr(obj.perfectDays, d.perfectDays),
        unlocked: stringsOr(obj.unlocked, d.unlocked),
        wearing: stringsOr(obj.wearing, d.wearing),
        dayKey: stringOr(obj.dayKey, d.dayKey),
        dayCompleted: wholeOr(obj.dayCompleted, d.dayCompleted),
        dayPlanned: wholeOr(obj.dayPlanned, d.dayPlanned),
        dayTarget: wholeOr(obj.dayTarget, d.dayTarget),
        dayWorkday: boolOr(obj.dayWorkday, d.dayWorkday),
        distraction: secondsMapOr(obj.distraction) ?? d.distraction,
    };
}

// A copy of a state that already has the right shape.
function cloneLifeState(state) {
    return {
        ...state,
        perfectDays: [...state.perfectDays],
        unlocked: [...state.unlocked],
        wearing: [...state.wearing],
        distraction: {...state.distraction},
    };
}

export function lifeStage(state) {
    return stageOf(state.xp);
}

export function isHungry(state) {
    return state.satiety < 30;
}

// What the pet is wearing, as known accessory names.
export function wornAccessories(state) {
    return state.wearing.filter(name => ACCESSORIES.includes(name));
}

// Seconds spent today in all distracting apps and sites together.
export function distractionTotal(state) {
    return Object.values(state.distraction).reduce((sum, seconds) => sum + seconds, 0);
}

// --- Rules for feeding, hunger, growth and day settlement ---

const COMBO_WINDOW_MS = 30 * 60 * 1000;
export const FOODS = Object.freeze(['🍙', '🍡', '🐟', '🧁', '🍓', '🍪', '🥟', '🍩']);
export const GOLDEN_FOOD = '🍰';
const HUNGER_PER_HOUR = 7;
const DANCES = CELEBRATION_KINDS.slice(0, 4);

// Whole number >= 0 from a pick; anything else (negative, NaN) counts as 0 instead of indexing outside a table.
const wholeAtLeastZero = x => (Number.isFinite(x) ? Math.max(0, Math.trunc(x)) : 0);

// Gives one finished task to the pet. `now` is a Date; `roll` decides a rare golden treat (10%), `pick` the food
// and the dance (both 0...1). Returns what happened, for the celebration.
function feed(s, now, roll, pick) {
    const before = lifeStage(s);
    const nowMs = now.getTime();
    s.combo = Number.isFinite(s.lastDoneAt) && nowMs - s.lastDoneAt <= COMBO_WINDOW_MS ? s.combo + 1 : 1;
    s.lastDoneAt = nowMs;
    s.bestCombo = Math.max(s.bestCombo, s.combo);
    s.totalDone += 1;
    const golden = roll < 0.1;
    if (golden)
        s.goldens += 1;
    s.xp += 10 + 5 * Math.min(Math.max(s.combo - 1, 0), 4) + (golden ? 20 : 0);
    s.satiety = Math.min(100, s.satiety + 25);
    const cleaned = s.dirt > 0;
    if (cleaned)
        s.dirt -= 1;
    const dance = DANCES[Math.min(wholeAtLeastZero(pick * DANCES.length), DANCES.length - 1)];
    const kind = (golden || s.combo >= 3) ? 'fireworks' : dance;
    const food = golden ? GOLDEN_FOOD : FOODS[wholeAtLeastZero(pick * FOODS.length * 7) % FOODS.length];
    const unlocked = checkUnlocks(s);
    const after = lifeStage(s);
    return {food, combo: s.combo, golden, kind, unlocked, levelUp: after !== before ? after : null, cleaned};
}

// Reverses one feed (when you undo a completion).
function unfeed(s) {
    s.totalDone = Math.max(0, s.totalDone - 1);
    s.xp = Math.max(0, s.xp - 10);
    s.satiety = Math.max(0, s.satiety - 25);
    s.combo = Math.max(0, s.combo - 1);
}

// Unlocks every accessory the pet has now earned and puts it on if nothing else is in that slot.
// Returns the newly unlocked names.
function checkUnlocks(s) {
    const unlocked = [];
    for (const accessory of ACCESSORIES) {
        if (s.unlocked.includes(accessory) || !accessoryEarned(accessory, s))
            continue;
        s.unlocked.push(accessory);
        unlocked.push(accessory);
        const slot = accessorySlot(accessory);
        if (!wornAccessories(s).some(worn => accessorySlot(worn) === slot))
            s.wearing.push(accessory);
    }
    return unlocked;
}

// Hunger grows during work hours only (at most one hour per step, so sleep or lunch doesn't starve the pet).
function decay(s, now, working) {
    const nowMs = now.getTime();
    if (working && Number.isFinite(s.lastDecayAt) && nowMs > s.lastDecayAt) {
        const seconds = Math.min((nowMs - s.lastDecayAt) / 1000, 3600);
        s.satiety = Math.max(0, s.satiety - HUNGER_PER_HOUR * seconds / 3600);
    }
    s.lastDecayAt = nowMs;
}

function syncDay(s, completed, planned, target, workday) {
    s.dayCompleted = completed;
    s.dayPlanned = planned;
    s.dayTarget = target;
    s.dayWorkday = workday;
}

function addDistraction(s, label, seconds) {
    const soFar = Object.hasOwn(s.distraction, label) ? s.distraction[label] : 0;
    setOwn(s.distraction, label, soFar + seconds);
}

// Settles the stored day once the date changed: streak, perfect-day sticker, and dirt for lazy workdays.
// Workdays the app never saw (computer off) count as lazy too. `isWorkday` maps a day key to true or false.
// Returns the accessories this unlocked.
function closeDay(s, today, isWorkday) {
    if (s.dayKey === '' || !(s.dayKey < today)) {
        if (s.dayKey === '')
            s.dayKey = today;
        return [];
    }
    if (s.dayWorkday) {
        if (s.dayTarget > 0 && s.dayCompleted >= s.dayTarget) {
            s.streak += 1;
            s.bestStreak = Math.max(s.bestStreak, s.streak);
            if (s.dayCompleted >= s.dayPlanned) {
                s.perfectDays.push(s.dayKey);
                s.xp += 30;
            }
        } else {
            s.streak = 0;
            if (s.dayCompleted === 0)
                s.dirt = Math.min(3, s.dirt + 1);
        }
    }
    let day = nextDayKey(s.dayKey);
    let guardCount = 0;
    while (day < today && guardCount < 30) {
        if (isWorkday(day)) {
            s.streak = 0;
            s.dirt = Math.min(3, s.dirt + 1);
        }
        day = nextDayKey(day);
        guardCount += 1;
    }
    s.dayKey = today;
    s.dayCompleted = 0;
    s.dayPlanned = 0;
    s.combo = 0;
    s.distraction = {};
    s.perfectDays = s.perfectDays.slice(-60);
    return checkUnlocks(s);
}

// Every rule takes the state first and changes it in place.
export const LifeRules = {
    comboWindowMs: COMBO_WINDOW_MS,
    foods: FOODS,
    hungerPerHour: HUNGER_PER_HOUR,
    feed,
    unfeed,
    checkUnlocks,
    decay,
    syncDay,
    addDistraction,
    closeDay,
    nextDay: nextDayKey,
};

// --- PetLife: holds the pet's life and saves it after every change ---

const STORE_NAME = 'life';

export class PetLife {
    // `store` is {load(name) -> Promise<object|null>, save(name, obj)}; without one nothing is persisted.
    // `initial` is a state (or part of one) to start from, for demos and tests.
    // `onSaveError(error)` hears about saves that failed; by default they go to the log.
    constructor({store = null, initial = null, onSaveError = null} = {}) {
        this._store = store;
        this._onSaveError = onSaveError;
        this._state = lifeStateFromJSON(initial);
    }

    // The current state. Treat it as read-only: it is a snapshot that mutate() replaces, never edits.
    get state() {
        return this._state;
    }

    // Replaces the state with the saved one (a new pet when nothing is saved). A failing read is passed on, so a
    // pet that could not be read is never overwritten with a new one.
    async load() {
        if (!this._store)
            return;
        this._state = lifeStateFromJSON(await this._store.load(STORE_NAME));
    }

    // Runs `change` on a copy of the state, keeps the copy, saves it and returns what `change` returned.
    // When `change` throws the state stays as it was.
    mutate(change) {
        const next = cloneLifeState(this._state);
        const result = change(next);
        this._state = next;
        this._save();
        return result;
    }

    // Wears an unlocked accessory (replacing whatever is in the same slot) or takes it off.
    toggle(accessory) {
        if (!ACCESSORIES.includes(accessory) || !this._state.unlocked.includes(accessory))
            return;
        this.mutate(s => {
            if (s.wearing.includes(accessory)) {
                s.wearing = s.wearing.filter(name => name !== accessory);
            } else {
                const slot = accessorySlot(accessory);
                s.wearing = s.wearing.filter(name => accessorySlot(name) !== slot);
                s.wearing.push(accessory);
            }
        });
    }

    // A store that cannot save must not break the game: log it and carry on with the in-memory state.
    _save() {
        if (!this._store)
            return;
        try {
            Promise.resolve(this._store.save(STORE_NAME, this._state)).catch(e => this._reportSaveError(e));
        } catch (e) {
            this._reportSaveError(e);
        }
    }

    _reportSaveError(e) {
        if (this._onSaveError)
            this._onSaveError(e);
        else
            console.error(`TodoPet: could not save the pet's life: ${e?.message ?? e}`);
    }
}
