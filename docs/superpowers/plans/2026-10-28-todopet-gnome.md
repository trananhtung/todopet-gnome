# TodoPet for GNOME Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the macOS TodoPet (Swift) to a GNOME Shell 50 extension with full feature parity and only the Mochi pet.

**Architecture:** Pure logic lives in `extension/core/` (plain ES modules, at most GLib/Gio) and is unit-tested with `gjs -m`. Services wrap Todoist, Claude, libsecret, the calendar and Shell signals. `brain.js` is driven by `tick(now)` with injected services and clock, so it is tested without GNOME Shell. UI is St/Clutter in top chrome, verified by scene screenshots taken inside an isolated headless nested GNOME Shell.

**Tech Stack:** GJS 1.88 (ES modules), GNOME Shell 50 extension API, St/Clutter, Cairo + PangoCairo, libsoup 3, libsecret, optional ECal 2.0, libadwaita (prefs), ESLint 10 (dev only, needs Node ≥ 20.19; CI sets up Node 24), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-28-todopet-gnome-design.md`

**Reference source:** `trananhtung/todopet` at commit `8573b98`, cloned read-only to `build/ref/todopet` in Task 1. "Port X.swift" in a step means: same behavior, thresholds, strings and order of rules as that Swift code, written as idiomatic GJS. Its `docs/*.png` are the visual reference.

## Global Constraints

- UUID `todopet@trananhtung.github.io`; GSettings schema id `org.gnome.shell.extensions.todopet`, path `/org/gnome/shell/extensions/todopet/`.
- `metadata.json`: `"shell-version": ["50"]`, `"session-modes": ["user", "unlock-dialog"]`, `"settings-schema": "org.gnome.shell.extensions.todopet"`, `"url": "https://github.com/trananhtung/todopet-gnome"`.
- Extension source lives in `extension/`; `make build` copies it to `build/todopet@trananhtung.github.io/`.
- `extension/core/**` imports nothing except `gi://GLib`, `gi://Gio` and other `core/` files. No `St`, `Clutter`, `Shell`, `Meta`, `resource:///org/gnome/shell/...`.
- Code running inside GNOME Shell never blocks: no `GLib.spawn_sync`, no `*_sync` file/network/D-Bus calls, no blocking Soup send (use `send_and_read_async`). Tests and tools may use sync calls.
- Every user-visible string goes through `L(vi, en)` from `core/l10n.js`. Lines the pet says are ported verbatim from `Lines.swift`.
- Data dir: `$TODOPET_DATA_DIR` if set, else `GLib.get_user_data_dir() + '/todopet'`.
- Default board hotkey `['<Control><Super>t']`. Default Claude model `claude-opus-5-5`.
- Todoist base URL `https://api.todoist.com/api/v1/`; Anthropic `https://api.anthropic.com/v1/messages`.
- No runtime npm dependencies. `package.json` holds only ESLint dev dependencies, pinned to exact versions.
- Tests run with `TZ=Asia/Ho_Chi_Minh` (set by the Makefile).
- License MIT, `Copyright (c) 2026 trananhtung` (same holder as the Swift repo).
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `node`/`npx` come from nvm: run `source ~/.nvm/nvm.sh` first in a fresh shell.

## Review Focus

1. **Todoist errors mid-session** (401, 429, offline): the pet keeps running, shows the Swift error text, asks for a token only on 401 and only once, and keeps the last good task list. Tests in Task 14 (`401 asks for the token once`, `offline keeps old tasks`).
2. **Disable/enable cycles** (screen lock, user toggling the extension): no leaked timers, actors or duplicate keybindings. Scene `reenable` in Task 22 restarts the app 3 times and checks one pet actor and a clean log.
3. **Monitor or work-area changes** (unplugging a screen, dock autohide): the pet stays on screen. `clampToWorkArea` tests and the `workareas-changed` handler in Task 17.
4. **Midnight and sleep across days**: the day closes exactly once and the new day starts fresh. Tests in Task 14 (`midnight closes the day once`, `waking after two days settles both`).
5. **Long, Vietnamese or emoji task titles** in bubbles, board rows and the sign: no split grapheme, no overflow. `shortText` grapheme tests in Task 3, `drawSign` long-title test in Task 13, `long-title` scene in Task 18.

---

## Phase A — Foundation

### Task 1: Repository scaffold, test harness, lint, CI

**Files:**
- Create: `LICENSE`, `.gitignore` (`build/`, `node_modules/`, `out/`), `Makefile`, `package.json`, `eslint.config.js`
- Create: `extension/metadata.json`, `extension/extension.js` (empty `enable()`/`disable()`), `extension/stylesheet.css` (empty)
- Create: `extension/schemas/org.gnome.shell.extensions.todopet.gschema.xml`
- Create: `tests/harness.js`, `tests/run.js`, `tests/smoke.test.js`
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Produces `tests/harness.js`: `class T { check(ok, name); eq(actual, expected, name); near(actual, expected, eps, name); async rejects(promise, predicate, name); failures }`. `eq` compares with `JSON.stringify` after sorting object keys.
- Produces `tests/run.js`: imports the modules listed in its `TESTS` array; each exports `default async function (t)`. Prints `✅ name` / `❌ name (got …)`, then `All good 🎉` or `N failure(s)`, and exits 1 on failure (`import System from 'system'; System.exit(1)`).
- Produces Makefile targets `ref`, `build`, `test`, `lint`, `snapshot`, `nested`, `install`, `pack`.

- [ ] **Step 1: Reference clone.** `make ref` runs `git clone https://github.com/trananhtung/todopet build/ref/todopet && git -C build/ref/todopet checkout 8573b98`. Run it; `build/ref/todopet/Sources/TodoPet/Brain.swift` must exist.
- [ ] **Step 2: Schema** with every key below (type, default), summaries taken from the `Prefs.swift` doc comments:
  `lang` s `''` (empty = system) · `pet-name` s `'Mochi'` · `daily-target` i 3 · `work-start` i 8 · `work-end` i 18 · `plan-deadline` i 10 · `remind-every` i 45 · `focus-minutes` i 25 · `break-minutes` i 5 · `filter-query` s `'today | overdue'` · `distraction-apps` s `'TikTok, Netflix, Steam, Facebook'` · `sound-mode` s `'important'` (choices off, important, all) · `work-saturday` b false · `work-sunday` b false · `pet-scale` d 1.0 · `chase-when-angry` b true · `watch-browsers` b true · `distraction-sites` s `'youtube.com, facebook.com, tiktok.com, instagram.com, x.com, reddit.com, netflix.com'` · `use-calendar` b true · `adapt-target` b true · `meeting-lead` i 5 · `stuck-days` i 3 · `claude-model` s `'claude-opus-5-5'` · `antics` b true · `voice-on` b false · `protect-flow` b true · `still-while-typing` b true · `bubble-gap` i 15 · `keep-log` b true · `first-launch` x 0 (epoch ms, 0 = unset) · `board-hotkey` as `['<Control><Super>t']` · `hidden-until` x 0 · `quiet-until` x 0 · `demo-mode` b false · `dev-screenshot-dir` s `''` · `dev-scenes` as `[]` · `dev-trigger` s `''` · `secrets-serial` i 0.
- [ ] **Step 3: Write `tests/smoke.test.js`**: `t.check(true, 'harness runs')`, and load the compiled schema from `build/todopet@trananhtung.github.io/schemas` with `Gio.SettingsSchemaSource.new_from_directory`, then `t.eq(settings.get_int('daily-target'), 3, 'schema default daily-target')` using a memory backend (`Gio.memory_settings_backend_new()`).
- [ ] **Step 4: Makefile.** `build` copies `extension/` to `build/todopet@trananhtung.github.io/` and runs `glib-compile-schemas` there. `test` depends on `build`, runs `TZ=Asia/Ho_Chi_Minh gjs -m tests/run.js`. `lint` runs `npx eslint extension tests tools`. `install` copies the build to `~/.local/share/gnome-shell/extensions/`. `pack` runs `gnome-extensions pack build/todopet@trananhtung.github.io --force --out-dir=build --extra-source=core --extra-source=services --extra-source=art --extra-source=ui --extra-source=brain.js`.
- [ ] **Step 5: Run `make test`** — expected: `✅ harness runs`, `✅ schema default daily-target`, `All good 🎉`.
- [ ] **Step 6: ESLint.** Flat config, `ecmaVersion: 2024`, `sourceType: 'module'`, globals `global`, `log`, `logError`, `print`, `console`, `TextEncoder`, `TextDecoder`; `eslint:recommended` plus `no-unused-vars` with `argsIgnorePattern: '^_'`. Pin `eslint`, `@eslint/js` and `globals` to exact versions. Run `npm install && make lint` — expected: exit 0, no output.
- [ ] **Step 7: CI** on `ubuntu-latest`: `sudo apt-get install -y gjs gir1.2-soup-3.0 gir1.2-secret-1 gir1.2-pango-1.0 libglib2.0-bin`, `npm ci`, `make lint`, `make test`, `if [ -f tools/snapshot.js ]; then make snapshot; fi`, upload `out/` as an artifact when present.
- [ ] **Step 8: Commit** — `git add -A && git commit -m "Scaffold extension, schema, test harness, lint and CI"`.

### Task 2: Prefs, language and event emitter

**Files:**
- Create: `extension/core/l10n.js`, `extension/core/prefs.js`, `extension/core/emitter.js`
- Test: `tests/core-basics.test.js`

**Interfaces:**
- Produces `core/l10n.js`: `setLang(lang /* 'en'|'vi' */)`, `getLang()`, `L(vi, en) -> string`, `pick(pairs /* [[vi, en], …] */, random = Math.random) -> string`, `systemLang() -> 'vi'|'en'` (`vi` when the first of `GLib.get_language_names()` starts with `vi`).
- Produces `core/prefs.js`: `class Prefs` with one getter per schema key in camelCase (`dailyTarget`, `petScale`, `boardHotkey`, `devScenes`, …), setters for `hiddenUntil`, `quietUntil`, `firstLaunch`, `devTrigger`, `secretsSerial`, and derived getters ported from `Prefs.swift`: `effectiveFilter`, `distractionList`, `siteRules`, `effectiveClaudeModel`, `isWorkday(date)`, plus `effectiveLang` (`lang` or `systemLang()`). Constructors `Prefs.fromSettings(gioSettings)` and `Prefs.memory(overrides = {})` (defaults equal the schema). `onChanged(cb) -> id`, `disconnect(id)`.
- Produces `core/emitter.js`: `class Emitter { on(name, cb) -> id; off(id); emit(name, ...args) }`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/core-basics.test.js
setLang('en'); t.eq(L('Xin chào', 'Hello'), 'Hello', 'English strings');
setLang('vi'); t.eq(L('Xin chào', 'Hello'), 'Xin chào', 'Vietnamese strings');
t.eq(pick([['a', 'A'], ['b', 'B']], () => 0.99), 'b', 'pick uses the random source');
const p = Prefs.memory({distractionSites: 'https://www.YouTube.com,  reddit.com/r/funny ,', filterQuery: '  '});
t.eq(p.siteRules, ['youtube.com', 'reddit.com/r/funny'], 'site rules normalized');
t.eq(p.effectiveFilter, 'today | overdue', 'empty filter falls back');
t.eq(Prefs.memory({distractionApps: 'TikTok, , Steam'}).distractionList, ['tiktok', 'steam'], 'app list lowercased');
t.check(!p.isWorkday(new Date(2026, 9, 25)) && p.isWorkday(new Date(2026, 9, 26)), 'Sunday off, Monday on');
t.eq(Prefs.memory({claudeModel: ' '}).effectiveClaudeModel, 'claude-opus-5-5', 'default Claude model');
const e = new Emitter(); let got = 0; const id = e.on('x', v => { got += v; }); e.emit('x', 2); e.off(id); e.emit('x', 5);
t.eq(got, 2, 'emitter on/off');
```

- [ ] **Step 2: Run `make test`** — expected: FAIL with import errors.
- [ ] **Step 3: Implement.** `Prefs.fromSettings` reads with `get_int/get_boolean/get_double/get_string/get_strv/get_int64` by schema type, from one camelCase→kebab-case key table.
- [ ] **Step 4: Run `make test`** — expected: all pass.
- [ ] **Step 5: Commit** — `git commit -m "Add prefs, language switch and emitter"`.

---

## Phase B — Core logic (pure, unit-tested)

### Task 3: Dates, text and Todoist models

**Files:**
- Create: `extension/core/dates.js`, `extension/core/models.js`
- Test: `tests/models.test.js`

**Interfaces:**
- Produces `core/dates.js` (port `DateParse`, `DayMath`, `TextClean` from `Models.swift`): `parseDate(raw) -> Date|null`, `utcString(date)` (`YYYY-MM-DDTHH:MM:SSZ`), `dayKey(date) -> 'YYYY-MM-DD'`, `atHour(hour, minute, date) -> Date`, `hourOf(date)`, `daysBetween(a, b)`, `daysAgo(day, now)`, `timeString(date)` (`HH:MM`), `nextDayKey(key)`, `plainText(s)`, `shortText(s, max = 42)`.
- Produces `core/models.js`: `class Task` with fields `id, content, description, priority, due {date, string, isRecurring, datetime, timezone}, deadline {date}, duration {amount, unit}, projectId, parentId, labels, checked, completedAt, childOrder, dayOrder`, getters `apiPriority`, `uiPriority`, `title`, `isRecurring`, `dueDay`, `dueTime`, `completedDate`, `durationMinutes`, and `static fromApi(json)` (snake_case → camelCase). `statsFromApi(json) -> {streak, completedCount, daysItems: [{date, totalCompleted}], dailyGoal, karma}`. `class DaySnapshot` with arrays `today, overdue, completed, late`, getters `planned, remaining, open, actionable, next`, `static ranked(tasks)`, `static build({active, completed, now})`.

- [ ] **Step 1: Write the failing tests.** Port `DevTools.swift` lines 17–60 and 137–139 (dates, API v1 payload, day snapshot, "first step comes before the big task"), same names and values; copy the JSON payload verbatim and parse its `results[0]` with `Task.fromApi`. Add:

```js
t.eq(shortText('abc', 3), 'abc', 'short text keeps text that fits');
t.eq(shortText('👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦', 2), '👨‍👩‍👧‍👦…', 'short text never splits a grapheme');
t.eq(shortText('Tie\u0302\u0301ng Việt có dấu', 5), 'Tie\u0302\u0301n…', 'combining marks stay with their letter');
t.eq(nextDayKey('2026-12-31'), '2027-01-01', 'next day across the year');
```

- [ ] **Step 2: Run `make test`** — expected: FAIL (modules missing).
- [ ] **Step 3: Implement.** `shortText` counts graphemes with `Intl.Segmenter('und', {granularity: 'grapheme'})` and keeps Swift's rule: the text when it has ≤ `max` graphemes, else the first `max - 1` graphemes + `…`. Floating times (`2026-10-25T09:30:00`) are local, `Z` times are UTC, fractional seconds are stripped before parsing.
- [ ] **Step 4: Run `make test`** — expected: all pass.
- [ ] **Step 5: Commit** — `git commit -m "Port dates, text cleanup and Todoist models"`.

### Task 4: Mood engine, calm rules and typing sampler

**Files:**
- Create: `extension/core/mood.js`, `extension/core/calm.js`
- Test: `tests/mood-calm.test.js`

**Interfaces:**
- Produces `core/mood.js` (port `MoodEngine.swift`): `Mood` frozen enum of strings `happy, normal, annoyed, angry, sleeping, focus, celebrating`; `moodEmoji(mood)`, `moodLabel(mood)`; `defaultMoodInputs()` (Swift defaults, `minutesSinceCelebration: Infinity`); `evaluateMood(inputs) -> {score, mood, reasons: [{delta, text}]}`.
- Produces `core/calm.js` (port `Calm.swift`): `CalmRules = {typingWindow: 8, flowMinutes: 10, flowEndsAfter: 120, engaged(secondsSinceKey, idleSeconds, distracted), engagedSince(current: Date|null, engaged, secondsSinceKey, now) -> Date|null, inFlow(engagedSince, now, minutes = 10), atBreakpoint(secondsSinceKey, secondsSinceAppSwitch), withinBudget(lastBubbleAt, now, minGapMinutes)}`. `class TypingSampler { sample(nowMs, idleMs, pointer /* [x, y] */); secondsSinceKey(nowMs) -> number }`, which returns `1e9` before the first detected key press.

- [ ] **Step 1: Write the failing tests.** Port `DevTools.swift` lines 62–94, 202–205 and 207–220 (moods and calm), same names. Add:

```js
const s = new TypingSampler();
s.sample(1000, 5000, [10, 10]);
t.check(s.secondsSinceKey(1000) >= 1e9, 'no key press before a sample pair');
s.sample(2000, 300, [10, 10]);
t.eq(s.secondsSinceKey(2000), 0, 'idle reset with a still pointer counts as a key press');
s.sample(3000, 400, [50, 10]);
t.eq(s.secondsSinceKey(5000), 3, 'pointer movement is not typing');
s.sample(4000, 1400, [50, 10]);
t.eq(s.secondsSinceKey(4000), 2, 'growing idle adds no key press');
```

- [ ] **Step 2: Run `make test`** — expected: FAIL.
- [ ] **Step 3: Implement.** Sampler rule: a key press happens at `nowMs` when a previous sample exists, `idleMs < 1000`, and `pointer` equals the previous sample's pointer.
- [ ] **Step 4: Run `make test`** — expected: all pass.
- [ ] **Step 5: Commit** — `git commit -m "Port mood engine and calm rules, add typing sampler"`.

### Task 5: Pet life rules

**Files:**
- Create: `extension/core/life.js`
- Test: `tests/life.test.js`

**Interfaces:**
- Produces (port `PetLife.swift`): `Stage = {baby: 0, kid: 1, teen: 2, adult: 3, master: 4}`, `STAGE_THRESHOLDS = [0, 100, 300, 700, 1500]`, `stageOf(xp)`, `stageName(stage)`, `stageScale(stage)`, `stageSprouts(stage)`, `stageNextXP(stage)`.
- `ACCESSORIES = ['bow', 'scarf', 'sunglasses', 'tophat', 'crown', 'gradcap']`, `accessorySlot(a) -> 'head'|'face'|'neck'`, `accessoryEmoji(a)`, `accessoryName(a)`, `accessoryRequirement(a)`, `accessoryEarned(a, state)`; `CELEBRATION_KINDS = ['jump', 'spin', 'flip', 'dance', 'fireworks']`.
- `defaultLifeState()`, `lifeStateFromJSON(obj)` (missing fields take defaults; `lastDoneAt`/`lastDecayAt` are epoch ms or null), `lifeStage(state)`, `isHungry(state)`, `wornAccessories(state)`, `distractionTotal(state)`.
- `LifeRules = {comboWindowMs: 1800000, foods, hungerPerHour: 7, feed(state, now, roll, pick) -> {food, combo, golden, kind, unlocked, levelUp, cleaned}, unfeed(state), checkUnlocks(state), decay(state, now, working), syncDay(state, completed, planned, target, workday), addDistraction(state, label, seconds), closeDay(state, today, isWorkday) -> string[], nextDay(key)}`, all mutating `state` in place.
- `class PetLife { constructor({store = null, initial = null}); state; async load(); mutate(fn) -> result; toggle(accessory) }`. With a store it saves under the name `life` after every mutation.

- [ ] **Step 1: Write the failing tests.** Port `DevTools.swift` lines 148–200, same names and values (`LifeRules.feed(&life, now: t0, roll: 0.5, pick: 0)` → `LifeRules.feed(life, t0, 0.5, 0)`; `PetLife(persist: false, initial:)` → `new PetLife({initial})`; the JSON `{"xp":120}` → `lifeStateFromJSON({xp: 120})`).
- [ ] **Step 2: Run `make test`** — expected: FAIL.
- [ ] **Step 3: Implement** by porting `LifeRules` and `PetLife`.
- [ ] **Step 4: Run `make test`** — expected: all pass.
- [ ] **Step 5: Commit** — `git commit -m "Port pet life: feeding, growth, dirt, combos, accessories"`.

### Task 6: Calendar math, postponed tasks and site matching

**Files:**
- Create: `extension/core/calendarMath.js`, `extension/core/stuck.js`, `extension/core/sites.js`
- Test: `tests/planning.test.js`

**Interfaces:**
- Produces `core/calendarMath.js` (port `CalendarMath`). A CalEvent is `{id, title, start: Date, end: Date, joinURL: string|null}`. Functions: `busy(events, from, to) -> [{start, end}]`, `freeSlots(events, from, to, minMinutes = 30)`, `freeMinutes(events, from, to)`, `targetFor(freeMinutes, maxTarget)`, `currentEvent(events, at)`, `nextEvent(events, after)`, `suggest(tasks, events, now, dayEnd, limit = 3) -> [{task, start, end}]`, `hoursText(minutes)`, `joinURL(url, texts) -> string|null`. Mappers: `eventsFromServer(tuples)` (a tuple is `[id, summary, startSec, endSec, extras]`) and `eventFromComp({uid, rid, summary, start, end, allDay, cancelled, transparent, declined, url, location, description}) -> CalEvent|null`. Both drop what `CalendarWatcher.events(on:)` drops; `eventsFromServer` also sorts by start.
- Produces `core/stuck.js` (port `StuckTracker.swift`): `stuckDays(seen, dueDay, today)`; `class StuckTracker { constructor({store = null}); async load(); record(tasks, now); seenDays(id); pretend(id, days, now); stuck(tasks, minDays, now) -> [{task, days}] }`, saved under the store name `stuck`.
- Produces `core/sites.js`: `isBrowser(wmClass) -> bool`, `titleKeywords(rule) -> {words: string[], path: string|null}`, `matchTitle(title, rules) -> string|null`. Browser classes (lowercase prefix match): `firefox`, `org.mozilla.firefox`, `google-chrome`, `chromium`, `brave-browser`, `microsoft-edge`, `vivaldi`, `opera`, `coccoc`. Known brands: `youtube.com→YouTube`, `facebook.com→Facebook`, `tiktok.com→TikTok`, `instagram.com→Instagram`, `x.com→["/ X", "Twitter"]`, `reddit.com→Reddit`, `netflix.com→Netflix`; any other domain uses its label before the TLD. Words match case-insensitively as whole words: `(?<![\p{L}\p{N}])word(?![\p{L}\p{N}])` with flags `iu`.

- [ ] **Step 1: Write the failing tests.** Port `DevTools.swift` lines 108–136 (calendar math, postponed tasks), same names. Add:

```js
const ev = eventsFromServer([['b', 'Sync', 1792908000, 1792909800, {}], ['a', 'Standup', 1792900000, 1792901800, {}],
  ['d', 'Holiday', Date.UTC(2026, 9, 24, 17) / 1000, Date.UTC(2026, 9, 25, 17) / 1000, {}]]);
t.eq(ev.map(e => e.id), ['a', 'b'], 'server events sorted, all-day dropped');
t.eq(eventFromComp({uid: 'x', summary: 'Call', start: new Date(), end: new Date(Date.now() + 1800000),
  description: 'Join https://meet.google.com/abc-defg-hij'}).joinURL, 'https://meet.google.com/abc-defg-hij', 'join link from notes');
t.eq(eventFromComp({uid: 'y', summary: 'Gone', start: new Date(), end: new Date(), cancelled: true}), null, 'cancelled dropped');
const rules = ['youtube.com', 'x.com', 'vnexpress.net', 'youtube.com/shorts'];
t.eq(matchTitle('Lofi beats - YouTube — Mozilla Firefox', ['youtube.com']), 'youtube.com', 'brand in title');
t.eq(matchTitle('Home / X - Google Chrome', rules), 'x.com', 'X by its title suffix');
t.eq(matchTitle('Tin mới - VnExpress — Mozilla Firefox', rules), 'vnexpress.net', 'unknown domain by its label');
t.eq(matchTitle('YouTubers notes - Google Docs', ['youtube.com']), null, 'whole words only');
t.eq(matchTitle('Cat #shorts - YouTube', ['youtube.com/shorts']), 'youtube.com/shorts', 'path rule needs the segment');
t.eq(matchTitle('Lofi - YouTube', ['youtube.com/shorts']), null, 'path rule without the segment');
t.check(isBrowser('firefox') && isBrowser('Google-chrome') && !isBrowser('gnome-terminal-server'), 'browser classes');
```

  (The Holiday times are local midnight to midnight in `Asia/Ho_Chi_Minh`.)
- [ ] **Step 2: Run `make test`** — expected: FAIL.
- [ ] **Step 3: Implement.** A server event is all-day when it starts at local midnight and lasts a whole number of days (≥ 1).
- [ ] **Step 4: Run `make test`** — expected: all pass.
- [ ] **Step 5: Commit** — `git commit -m "Port calendar math and postponed tasks, add window-title site matching"`.

### Task 7: Diary and the pet's lines

**Files:**
- Create: `extension/core/diary.js`, `extension/core/lines.js`, `tests/helpers.js`
- Test: `tests/diary-lines.test.js`

**Interfaces:**
- Produces `core/diary.js` (port `PetLog.swift`): `LOG_KINDS` with icons; `class LogSummary { constructor(entries); bubbles, ignored, dismissed, holds, flows, flowMinutes, antics, distractedMinutes; text }`; `class PetLog { static async open({files = null, now = new Date()}); enabled; today; add(kind, text, {tag, minutes, throttle, every, now} = {}); async load(day); async days(); static exportText(entries, day) }`. `files` implements `{append(day, line), read(day) -> Promise<string>, list() -> Promise<string[]>, remove(day)}`. Keeps 14 days, pruned on open and on day change.
- Produces `core/lines.js`: `Lines` with every function of `Lines.swift`, same names (`greeting`, `hello`, `morning`, `plan`, `nudge`, …, `tip`). Tasks are `Task`, events are CalEvents, slots are suggestions. `setLinesRandom(fn)` makes `pick` deterministic in tests.
- Produces `tests/helpers.js` (first part): `MemoryStore` (`load`, `save`, `flush`), `MemoryFiles` (diary `files` interface), `tmpDir()`.

- [ ] **Step 1: Write the failing tests.** Port `DevTools.swift` lines 223–234 (in-memory diary: entries, throttling, summary, new day) with `MemoryFiles`. The on-disk checks (lines 235–247) come in Task 8. Add:

```js
setLang('en'); t.eq(Lines.added('Write report'), 'Added “Write report” ✔︎', 'added line EN');
setLang('vi'); t.eq(Lines.added('Viết báo cáo'), 'Đã thêm “Viết báo cáo” ✔︎', 'added line VI');
t.check(Lines.distractionSummary({YouTube: 600, Facebook: 300}).includes('YouTube 10\''), 'summary lists top sites');
```

- [ ] **Step 2: Run `make test`** — expected: FAIL.
- [ ] **Step 3: Implement.** Port `Lines.swift` verbatim in both languages.
- [ ] **Step 4: Run `make test`** — expected: all pass.
- [ ] **Step 5: Commit** — `git commit -m "Port the pet diary and every line the pet says"`.

---

## Phase C — Services

### Task 8: JSON store, diary files and secrets

**Files:**
- Create: `extension/services/store.js`, `extension/services/secrets.js`
- Modify: `tests/diary-lines.test.js` (on-disk part)
- Test: `tests/store.test.js`

**Interfaces:**
- Produces `services/store.js`: `dataDir()`, `class JsonStore { constructor(dir = dataDir()); async load(name) -> object|null; save(name, obj); async flush() }`. Saves are debounced 500 ms and written atomically with `replace_contents_bytes_async` to `<dir>/<name>.json`. `class DiaryFiles { constructor(dir = dataDir() + '/log') }` implements the diary `files` interface with async Gio, files named `<day>.jsonl`.
- Produces `services/secrets.js`: `SECRET_TODOIST = 'todoist-token'`, `SECRET_ANTHROPIC = 'anthropic-key'`, `async lookupSecret(item) -> string|null`, `async storeSecret(item, value)`, `async clearSecret(item)`. Schema `org.gnome.shell.extensions.todopet.Secret`, attribute `item`, collection `Secret.COLLECTION_DEFAULT`.

- [ ] **Step 1: Write the failing tests.** JsonStore round trip in `tmpDir()` (`save('life', {xp: 5}); await flush(); await load('life')` → `{xp: 5}`); missing file → `null`; corrupt file → `null` and renamed to `<name>.json.bad`. Port `DevTools.swift` lines 235–247 with `DiaryFiles(tmpDir())`, same names. Secrets: store, look up and clear `'test-item'` when `Secret.Service` is reachable; otherwise `t.check(true, 'secrets skipped: no Secret Service')`.
- [ ] **Step 2: Run `make test`** — expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `make test`** — expected: all pass (secrets run locally; CI prints the skip line).
- [ ] **Step 5: Commit** — `git commit -m "Add JSON store, diary files and libsecret storage"`.

### Task 9: Todoist, demo and Claude clients

**Files:**
- Create: `extension/services/http.js`, `extension/services/todoist.js`, `extension/services/demo.js`, `extension/services/claude.js`
- Modify: `tests/helpers.js` (`FakeTransport`)
- Test: `tests/services.test.js`

**Interfaces:**
- Produces `services/http.js`: `class SoupTransport { async request({method, url, headers, body /* string|null */}) -> {status, text} }` (libsoup 3, `send_and_read_async`, 20 s timeout). Network failures reject with an `Error` whose `name` is `'NetworkError'`. `tests/helpers.js` gains `FakeTransport(script)`: same `request`, records `calls`, replays `{status, text}` items or rejects on `{throws: message}`.
- Produces `services/todoist.js` (port `TodoistClient`): `class TodoError extends Error { kind: 'unauthorized'|'rateLimited'|'http'|'network'; status; userMessage }` with the Swift messages through `L()`. `class TodoistClient { constructor(token, transport = new SoupTransport()) }` implements the TodoService interface: `activeTasks(filter)`, `completedTasks(since, until)`, `stats()`, `addTask({content, dueString = null, priority, parentId = null}) -> Task|null`, `quickAdd(text)`, `close(id)`, `reopen(id)`, `reschedule(id, dueString)`, `delete(id)`. Same paths, query keys sorted, spaces as `%20`, `+` as `%2B`, `limit=200`, at most 10 pages, `X-Request-Id` on non-GET, `due_lang: 'en'`.
- Produces `services/demo.js`: `class DemoService` (port `DemoService`, same sample tasks relative to `now()`), same interface, and `demoEvents(now)` returning the Swift demo events.
- Produces `services/claude.js` (port `ClaudeClient.swift`): `DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5'`, `class ClaudeError extends Error { kind: 'refused'|'noKey'|'http'|'network'|'decoding' }`, `buildBreakdownRequest({key, model, title, notes}) -> {method, url, headers, body}`, `parseSteps(text) -> string[]`, `class ClaudeClient { constructor(key, model, transport = new SoupTransport()); breakdown(title, notes) -> Promise<string[]> }`.

- [ ] **Step 1: Write the failing tests**

```js
const tr = new FakeTransport([{status: 200, text: '{"results":[],"next_cursor":"c2"}'}, {status: 200, text: '{"results":[],"next_cursor":null}'}]);
await new TodoistClient('tok', tr).activeTasks('today | overdue');
t.eq(tr.calls[0].url, 'https://api.todoist.com/api/v1/tasks/filter?limit=200&query=today%20%7C%20overdue', 'filter query encoded');
t.check(tr.calls[1].url.includes('cursor=c2'), 'follows the cursor');
t.eq(tr.calls[0].headers.Authorization, 'Bearer tok', 'bearer token');
const tr2 = new FakeTransport([{status: 200, text: '{"id":"1","content":"A"}'}]);
await new TodoistClient('tok', tr2).addTask({content: 'A', dueString: 'tomorrow', priority: 4, parentId: 'p'});
t.eq(JSON.parse(tr2.calls[0].body), {content: 'A', priority: 4, due_string: 'tomorrow', due_lang: 'en', parent_id: 'p'}, 'add body');
t.check(typeof tr2.calls[0].headers['X-Request-Id'] === 'string', 'request id on POST');
await t.rejects(new TodoistClient('t', new FakeTransport([{status: 401, text: ''}])).close('1'), e => e.kind === 'unauthorized', '401');
await t.rejects(new TodoistClient('t', new FakeTransport([{status: 429, text: ''}])).close('1'), e => e.kind === 'rateLimited', '429');
await t.rejects(new TodoistClient('t', new FakeTransport([{throws: 'offline'}])).close('1'), e => e.kind === 'network', 'network');
const plus = new FakeTransport([{status: 200, text: '{"results":[]}'}]);
await new TodoistClient('t', plus).activeTasks('#A+B');
t.check(plus.calls[0].url.includes('%2B'), 'plus encoded');
const req = buildBreakdownRequest({key: 'k', model: 'claude-opus-5-5', title: 'T', notes: 'N'});
const body = JSON.parse(req.body);
t.eq([body.model, body.fallbacks, body.output_config.effort], ['claude-opus-5-5', 'default', 'low'], 'Claude request');
t.eq(req.headers['anthropic-beta'], 'server-side-fallback-2026-07-01', 'fallback beta header');
```

  Port the Claude answer checks from `DevTools.swift` lines 141–146 (`parseSteps` takes the response text). Demo: after `close(id)` the task leaves `activeTasks` and shows up in `completedTasks`.
- [ ] **Step 2: Run `make test`** — expected: FAIL.
- [ ] **Step 3: Implement.** Copy the system prompt, JSON schema, `max_tokens` and headers from `ClaudeClient.swift`.
- [ ] **Step 4: Run `make test`** — expected: all pass.
- [ ] **Step 5: Commit** — `git commit -m "Add Todoist v1, demo and Claude clients"`.

### Task 10: Nested-shell harness and composition root

**Files:**
- Create: `tools/nested.sh`, `extension/ui/app.js`, `extension/ui/devScenes.js`
- Modify: `extension/extension.js`, `Makefile` (`nested` target runs `tools/nested.sh`)

**Interfaces:**
- Produces `ui/app.js`: `class App { constructor(extension); async start(); stop(); settings; prefs; brain; pet; bubble; board; antics; indicator }`. Here `start()` only builds `prefs`, sets `first-launch` to now when it is 0, and runs dev scenes; later tasks add members. `extension.js`: `enable() { this._app = new App(this); this._app.start().catch(logError); }`, `disable() { this._app?.stop(); this._app = null; }`.
- Produces `ui/devScenes.js`: `registerScene(id, async ctx => …)`, `async runScenes(app, ids, dir)`, with `ctx = {app, wait(ms), shot(name)}`. `shot` writes `<dir>/<name>.png` with `Shell.Screenshot.screenshot`. A scene id may carry an argument after `:` (`prefs:Day`). After the last scene it logs `TODOPET SCENES DONE` and calls `global.context.terminate()`. It runs only when `dev-scenes` is not empty. Built-in scene `smoke`: hide the overview, wait 1 s, shot `smoke`.
- Produces `tools/nested.sh [scene…]` (default: every registered scene, listed in a `SCENES` variable at the top of the script):
  1. `make build`, recreate `build/nested/{data,config,cache,state,shots}`, copy the build to `build/nested/data/gnome-shell/extensions/todopet@trananhtung.github.io`.
  2. `env XDG_DATA_HOME=… XDG_CONFIG_HOME=… XDG_CACHE_HOME=… XDG_STATE_HOME=… dbus-run-session -- bash -c '…'`, where the inner script runs `dconf write` for `/org/gnome/shell/enabled-extensions`, `/org/gnome/shell/disable-user-extensions false`, and `/org/gnome/shell/extensions/todopet/{demo-mode,dev-screenshot-dir,dev-scenes}`, then `timeout 180 gnome-shell --headless --virtual-monitor 1600x900`. All output goes to `build/nested/shell.log`.
  3. Exit 1 when the log contains `JS ERROR`, an error line mentioning `todopet`, or no `TODOPET SCENES DONE`. Print the PNG paths.

- [ ] **Step 1: Write the script and scene runner; run `tools/nested.sh smoke`.** Expected: exit 0 and `build/nested/shots/smoke.png` exists. Open it: it shows the Ubuntu desktop.
- [ ] **Step 2: Isolation check.** In your own session, `dconf read /org/gnome/shell/enabled-extensions` must not list `todopet@trananhtung.github.io`, and `~/.local/share/gnome-shell/extensions/` must not contain it.
- [ ] **Step 3: Commit** — `git commit -m "Add isolated nested-shell harness and app composition root"`.

### Task 11: Shell services: idle, focus, calendar, speech, sound, session

**Files:**
- Create: `extension/services/idle.js`, `extension/services/focusWatch.js`, `extension/services/calendar.js`, `extension/services/speech.js`, `extension/services/sound.js`, `extension/services/session.js`
- Modify: `extension/ui/app.js`, `extension/ui/devScenes.js` (scene `services`)
- Test: `tests/platform.test.js` (pure parts)

**Interfaces:**
- Produces `services/idle.js`: `class IdleWatch { start(); stop(); idleSeconds(); secondsSinceKey() }`. Every 1 s it feeds `global.backend.get_core_idle_monitor().get_idletime()` and `global.get_pointer()` into a `TypingSampler`.
- Produces `services/focusWatch.js`: `class FocusWatch extends Emitter { start(); stop(); current -> {appName, wmClass, title, isBrowser, since: Date}|null; lastSwitch: Date }`, emitting `changed`. It follows `global.display` `notify::focus-window` and the focused window's `notify::title`; app names come from `Shell.WindowTracker`.
- Produces `services/calendar.js`: `class CalendarSource extends Emitter { async start(); stop(); events(day: Date) -> CalEvent[]; hasJoinLinks; refresh() }`, emitting `changed`. It tries `await import('gi://ECal?version=2.0')` and `gi://EDataServer?version=1.2`; if both load, today's events come from `EDataServer.SourceRegistry.new`, `ECal.Client.connect` and `generate_instances` (all async), mapped with `eventFromComp`, and `hasJoinLinks = true`. Otherwise it uses a `Gio.DBusProxy` to `org.gnome.Shell.CalendarServer` (`SetTimeRange(dayStart, dayEnd, false)`, `EventsAddedOrUpdated`, `EventsRemoved`) with `eventsFromServer`, and `hasJoinLinks = false`. It refreshes every 10 minutes and at midnight. With `demo-mode` it returns `demoEvents(now)`.
- Produces `services/speech.js`: `speechArgs(text, lang) -> ['spd-say', '-l', lang, '--', text]` (pure), `hasSpeech()` (`GLib.find_program_in_path('spd-say')`), `speak(text, lang)` (`Gio.Subprocess`, never waited on).
- Produces `services/sound.js`: `CHIME_SOUNDS = {chatter: 'message', important: 'bell', celebrate: 'complete', big: 'complete', grumble: 'dialog-warning'}`, `shouldPlay(chime, soundMode) -> bool` (port the gate in `Brain.play`), `playChime(chime, soundMode)` with `global.display.get_sound_player().play_from_theme(name, desc, null)`.
- Produces `services/session.js`: `class SessionWatch extends Emitter { start(); stop(); locked }`. It emits `wake` on logind `PrepareForSleep(false)` (system-bus proxy to `org.freedesktop.login1.Manager`) and `lock-changed` from `Main.sessionMode` `updated` (`isLocked`).

- [ ] **Step 1: Write the failing tests:** `t.eq(speechArgs('Xin chào', 'vi'), ['spd-say', '-l', 'vi', '--', 'Xin chào'], 'speech args')`; `t.check(!shouldPlay('chatter', 'important') && shouldPlay('important', 'important') && !shouldPlay('celebrate', 'off') && shouldPlay('grumble', 'all'), 'sound modes')`.
- [ ] **Step 2: Run `make test`** — expected: FAIL. Implement; run again — expected: PASS.
- [ ] **Step 3: Scene `services`** logs `TODOPET services idle=<n> key=<n> focus=<wmClass|none> calendar=<ecal|server|demo> events=<n> speech=<bool>`. Run `tools/nested.sh services`; expected: exit 0 and the line is in `build/nested/shell.log`.
- [ ] **Step 4: Commit** — `git commit -m "Add Shell services: idle and typing, focus, calendar, speech, sound, session"`.

---

## Phase D — Art

### Task 12: Mochi drawn with Cairo: body, face and moods

**Files:**
- Create: `extension/art/petArt.js`, `extension/art/motion.js`, `tools/snapshot.js`
- Test: `tests/art.test.js`

**Interfaces:**
- Produces `art/petArt.js` (port `PetArt.swift`): `defaultPose(mood, t) -> PetPose`, with the same fields and defaults as Swift's `PetPose` (`mood, t, facing, walking, walkPhase, lookX, hovered, held, prevMood, blend, calm, stageScale, sprouts, hungry, dirt, wearing, celebration, golden, food, foodT`); `decoratePose(pose, lifeState)`; `petPalette(mood)`; `mixPalette(a, b, k)`; `drawPet(cr, width, height, pose)`, which fills the given size the way `PetArt.draw` fills its `size`. This task covers body, face, arms, feet, shadow, mood colors and mood effects (sparkles, sweat, anger mark and steam, Zz, headband, confetti for `celebrating`).
- Produces `art/motion.js`: `class PetMotion` (port of `PetMotion` in `PetWindow.swift`): fields `facing, walking, walkPhase, lookX, hovered, held, calm`, `pose(mood, t) -> PetPose` with the 0.8 s color blend.
- Produces `tools/snapshot.js <outDir>`: writes `moods.png` laid out like the reference `docs/moods.png` (8 columns × 2 rows: happy, normal, annoyed, angry, sleeping, focus, celebrating, held/petted; the second row at another `t`), labels drawn with PangoCairo. Makefile `snapshot` runs `gjs -m tools/snapshot.js out`.

- [ ] **Step 1: Write the failing tests:** for every mood, `drawPet` on a 200×200 `Cairo.ImageSurface` does not throw, the center pixel's alpha is > 0 and the corner pixel's alpha is 0. `PetMotion` blend is 0 right after a mood change and 1 after 0.8 s.
- [ ] **Step 2: Run `make test`** — expected: FAIL.
- [ ] **Step 3: Implement** by porting the drawing shape by shape: SwiftUI paths → `cr.moveTo/curveTo/arc`, gradients → `Cairo.LinearGradient`/`RadialGradient`, glyphs (Zz, marks) → PangoCairo.
- [ ] **Step 4: Run `make test && make snapshot`.** Open `out/moods.png` next to `build/ref/todopet/docs/moods.png`. Expected: same shapes, colors and expressions for every mood; fix differences before committing.
- [ ] **Step 5: Commit** — `git commit -m "Draw Mochi with Cairo: body, face and every mood"`.

### Task 13: Life visuals: growth, hunger, dirt, accessories, celebrations, sign

**Files:**
- Modify: `extension/art/petArt.js`, `tools/snapshot.js`
- Test: `tests/art.test.js`

**Interfaces:**
- Consumes: `PetPose` life fields and `decoratePose` from Task 12.
- Produces: `drawPet` handles sprouts, the thinner hungry body, dirt layers with flies, each accessory in its slot, falling food, jump/spin/flip/dance/fireworks and the golden pet. `drawSign(cr, width, height, text)` draws the dragged sign from `Antics.swift` (`SignView`). `snapshot.js` also writes `life.png`, laid out like `docs/life.png`.

- [ ] **Step 1: Write the failing tests:** drawing with each accessory, `dirt` 0–3, `hungry`, each celebration kind, `golden` and `food: '🍙'` does not throw. The golden pose's center pixel is yellow-dominant (`r > 200 && g > 160 && b < 140`). `drawSign` with a 120-character Vietnamese title on a 260×90 surface does not throw.
- [ ] **Step 2: Run `make test`** — expected: FAIL.
- [ ] **Step 3: Implement** by porting the rest of `PetArt.swift` and `SignView`.
- [ ] **Step 4: Run `make test && make snapshot`.** Compare `out/life.png` with `build/ref/todopet/docs/life.png`; expected: every cell matches in shape and color.
- [ ] **Step 5: Commit** — `git commit -m "Draw growth, hunger, dirt, accessories, celebrations and the sign"`.

---

## Phase E — Brain

The brain is ported from `Brain.swift` in three tasks. It never touches Shell objects; everything comes through its constructor:

```
new Brain({prefs, todoFactory, calendar, claudeFactory, env, store, files, now = () => new Date(), random = Math.random})
  todoFactory(token|null, demo: bool) -> TodoService|null
  calendar: {events(day) -> CalEvent[], hasJoinLinks, on('changed', cb)}
  claudeFactory(key, model) -> ClaudeClient
  env: {idleSeconds(), secondsSinceKey(), focus() -> {appName, wmClass, title, isBrowser, since}|null, lastAppSwitch() -> Date,
        speak(text), play(chime), lookupSecret(item), storeSecret(item, v), clearSecret(item), openURL(url)}
```

`tests/helpers.js` gains:
- `at('2026-10-27T11:00')` (local Date), `task(id, dueDate, apiPriority = 1, extra = {})`, `done(id, completedAtISO)`, `meeting(startLocalISO, minutes, joinURL = null)`.
- `FakeTodo` (TodoService over in-memory lists; records `calls` as `[method, arg]`; `completeRemotely(id)` moves a task to completed as if done in the Todoist app; `failWith(kind|null)` makes every call reject with that `TodoError` kind).
- `FakeCalendar(events)`, `FakeEnv(overrides)`.
- `makeBrain(opts)`: builds a Brain with `Prefs.memory(opts.prefs)`, `opts.store ?? new MemoryStore()`, `MemoryFiles`, a settable clock (`opts.now`), `random: () => 0`, and FakeTodo seeded from `opts.active`, `opts.completed`, `opts.overdue` (a count of tasks due yesterday) and `opts.todoError`. Test seams: `opts.mood` + `opts.angrySince`/`opts.annoyedSince` pin the mood state, `opts.inMeeting` pins the meeting flag, `opts.env.typingSince` makes `secondsSinceKey()` 0 and pre-sets `engagedSince` to that time, `opts.env.focus` sets the focused window, and `opts.firedToday` (default `['morning']`) calls `brain.markFired(\`${key}-${dayKey(now)}\`)` for each key, so the once-a-day morning greeting does not pre-empt the rule under test.

### Task 14: Brain state, sync, mood and talking

**Files:**
- Create: `extension/brain.js`
- Modify: `tests/helpers.js`
- Test: `tests/brain-core.test.js`

**Interfaces:**
- Produces properties: `mood, score, reasons, day: DaySnapshot, streak, errorText, bubble, focusSession, celebration, antic, calmMotion, events, suggestions, stuckTasks, hasToken, demo, life: PetLife, diary: PetLog, lastRule, todo, store` and, for tests, `closeDayCalls`.
- Produces methods: `async start()`, `stop()`, `tick(now)` (every 1 s; recompute every 15 s, sync every 3 min as in Swift; a gap > 120 s since the last tick calls `onWake`), `recompute(now)`, `async refresh()`, `refreshSoon()`, `settle() -> Promise` (resolves when in-flight actions finish), `say(bubble, {chime = 'chatter', why = null, antic = false} = {})`, `noteResponse({picked: title}|'closed'|'ignored')`, `quiet(minutes|null)`, `onWake(now)`, `setLocked(bool)`, `async setToken(raw) -> bool`, `removeToken()`, `useDemo()`, `setClaudeKey(key|null)`. Test-only: `forceDue(ruleKey)` clears the timestamps that `every`/`isDue` keep for that rule; `markFired(onceKey)` records a `once` key (same key format as Swift, e.g. `morning-2026-10-27`) as already fired.
- Produces events (`brain.on(name, cb)`): `changed`, `bubble`, `celebrate`, `antic`, `antic-end`. A bubble is `{id, text, actions: [{title, primary, run}], seconds = 12, urgent, reminder}`.
- Produces app hooks: `openBoard(focusAdd)`, `openBreakdown(task)`, `openSettings()`.

- [ ] **Step 1: Write the failing tests**

```js
const b = makeBrain({active: [task('a', '2026-10-27', 4)], now: at('2026-10-27T11:00')});
await b.start(); await b.refresh();
t.eq(b.day.today.map(x => x.id), ['a'], 'refresh loads today');
b.todo.completeRemotely('a'); await b.refresh();
t.check(b.celebration && b.life.state.totalDone === 1, 'finished in the Todoist app: celebrate and feed');
const fresh = makeBrain({completed: [done('z', '2026-10-27T01:00:00Z')], now: at('2026-10-27T11:00')});
await fresh.start(); await fresh.refresh();
t.eq(fresh.celebration, null, 'first sync does not celebrate earlier completions');
const err = makeBrain({todoError: 'unauthorized'}); await err.start(); await err.refresh(); await err.refresh();
t.eq(err.diary.today.filter(e => e.tag === 'askToken').length, 1, '401 asks for the token once');
const off = makeBrain({active: [task('a', '2026-10-27', 1)], now: at('2026-10-27T11:00')}); await off.start(); await off.refresh();
off.todo.failWith('network'); await off.refresh();
t.eq(off.day.today.length, 1, 'offline keeps old tasks');
t.check(!!off.errorText, 'offline shows the error');
const mid = makeBrain({now: at('2026-10-27T23:59:50')}); await mid.start();
mid.tick(at('2026-10-28T00:00:05')); mid.tick(at('2026-10-28T00:00:06'));
t.eq([mid.life.state.dayKey, mid.closeDayCalls], ['2026-10-28', 1], 'midnight closes the day once');
const sleepy = makeBrain({now: at('2026-10-26T18:00')}); await sleepy.start();
sleepy.onWake(at('2026-10-28T09:00'));
t.eq(sleepy.life.state.dayKey, '2026-10-28', 'waking after two days settles both');
b.noteResponse({picked: 'Later'});
t.eq(b.diary.today.at(-1).tag, 'picked', 'responses go to the diary');
```

  The `askToken` diary tag is written where the Swift `askForToken()` shows its bubble.
- [ ] **Step 2: Run `make test`** — expected: FAIL.
- [ ] **Step 3: Implement** by porting the `Brain.swift` sections *Token / demo*, *Sync*, *Mood*, *Talking* and `settleLife`, plus `resetDay`. The mood context reads idle, typing and focus from `env`; for browsers (`watchBrowsers` on) it uses `matchTitle(focus.title, prefs.siteRules)`, and for other apps `prefs.distractionList` against `appName`/`wmClass`.
- [ ] **Step 4: Run `make test`** — expected: all pass.
- [ ] **Step 5: Commit** — `git commit -m "Port the brain: sync, mood, life settlement and talking"`.

### Task 15: Reminder rules, flow, distraction and mischief

**Files:**
- Modify: `extension/brain.js`
- Test: `tests/brain-rules.test.js`

**Interfaces:**
- Produces: `runRules(now)` (from `tick`), `updateFlow(now)`, `trackDistraction(now)`, `endAntic()`. When a rule fires, `lastRule` is one of `meeting, due, morning, plan, distraction, stuck, hungry, antic, overdue, timeblock, review, nudge, tip`; a held bubble writes a diary `hold` entry instead. `antic` is `{id, kind: 'grumble'|'parade'|'block', text, start}`.

- [ ] **Step 1: Write the failing tests** (all `makeBrain` calls use `random: () => 0`):

```js
setLang('en');
const m = makeBrain({events: [meeting('2026-10-27T10:04', 30, 'https://meet.google.com/x')], overdue: 3, now: at('2026-10-27T10:00')});
await m.start(); await m.refresh(); m.tick(at('2026-10-27T10:00:01'));
t.eq(m.lastRule, 'meeting', 'meeting reminder beats everything');
t.check(m.bubble.actions.some(a => a.title === 'Join ↗'), 'join button with a link');
const p = makeBrain({active: [task('a', '2026-10-27', 1)], now: at('2026-10-27T11:05')});
await p.start(); await p.refresh(); p.tick(at('2026-10-27T11:05:01'));
t.eq(p.lastRule, 'plan', 'asks to plan after the deadline when below target');
const three = () => [task('a', '2026-10-27'), task('b', '2026-10-27'), task('c', '2026-10-27')];
const f = makeBrain({active: three(), env: {typingSince: at('2026-10-27T14:00')}, now: at('2026-10-27T14:11')});
await f.start(); await f.refresh(); f.forceDue('nudge'); f.tick(at('2026-10-27T14:11:01'));
t.check(f.lastRule !== 'nudge' && f.diary.today.some(e => e.kind === 'hold'), 'deep work holds the nudge');
const g = makeBrain({active: three(), overdue: 1, now: at('2026-10-27T14:00')});
await g.start(); await g.refresh(); g.tick(at('2026-10-27T14:00:01'));
t.eq(g.lastRule, 'overdue', 'overdue tasks get a reminder');
g.lastRule = null; g.forceDue('overdue'); g.tick(at('2026-10-27T14:10:00'));
t.check(g.lastRule === null && g.diary.today.some(e => e.kind === 'hold'), 'bubble gap of 15 minutes holds the next reminder');
const d = makeBrain({active: three(), now: at('2026-10-27T15:03'),
  env: {focus: {appName: 'Firefox', wmClass: 'firefox', title: 'Cats - YouTube — Mozilla Firefox', isBrowser: true, since: at('2026-10-27T15:00')}}});
await d.start(); await d.refresh(); d.tick(at('2026-10-27T15:03:01'));
t.eq(d.lastRule, 'distraction', 'three minutes on YouTube, matched by window title');
const a = makeBrain({active: three(), mood: 'angry', angrySince: at('2026-10-27T15:00'), now: at('2026-10-27T15:11')});
await a.start(); await a.refresh(); a.tick(at('2026-10-27T15:11:01'));
t.eq(a.antic?.kind, 'parade', 'ten grumpy minutes start the sign parade');
const q = makeBrain({active: three(), mood: 'angry', angrySince: at('2026-10-27T15:00'), inMeeting: true, now: at('2026-10-27T15:11')});
await q.start(); await q.refresh(); q.tick(at('2026-10-27T15:11:01'));
t.eq(q.antic, null, 'no mischief during meetings');
```

- [ ] **Step 2: Run `make test`** — expected: FAIL.
- [ ] **Step 3: Implement** by porting `tick`, `updateFlow`, `trackDistraction`, `runRules` (same order and timings), `isDue`, `reasonSuffix`, `planActions`, `spareAction` and the antic escalation, recording the time on site with `LifeRules.addDistraction`.
- [ ] **Step 4: Run `make test`** — expected: all pass.
- [ ] **Step 5: Commit** — `git commit -m "Port reminder rules, flow protection, distraction tracking and mischief"`.

### Task 16: Actions and focus sessions

**Files:**
- Modify: `extension/brain.js`
- Test: `tests/brain-actions.test.js`

**Interfaces:**
- Produces: `complete(task)`, `undoComplete(task)`, `async add(text, due /* 'today'|'tomorrow'|'none'|'smart' */, priority /* API priority 1–4 */) -> bool`, `reschedule(task, dueString)`, `pullOverdueToToday()`, `moveTodayToTomorrow()`, `schedule(slot)`, `delete(task)`, `unplan(task)`, `async suggestSteps(task) -> string[]`, `async split(task, steps, firstToday) -> bool`, `startFocus(task|null, minutes = prefs.focusMinutes)`, `startBreak()`, `stopFocus()`. `focusSession` is `{task, start, end, isBreak, minutes}`, saved to the store as `focus` and restored by `start()`. Ending a focus session sets `lastRule = 'focusEnd'`.

- [ ] **Step 1: Write the failing tests**

```js
const b = makeBrain({active: [task('a', '2026-10-27', 4)], now: at('2026-10-27T11:00')}); await b.start(); await b.refresh();
b.complete(b.day.today[0]); await b.settle();
t.eq(b.todo.calls.at(-1), ['close', 'a'], 'complete closes in Todoist');
await b.refresh();
t.eq(b.life.state.totalDone, 1, 'completing via the pet feeds once');
b.undoComplete(b.day.completed[0]); await b.settle();
t.check(b.todo.calls.at(-1)[0] === 'reopen' && b.life.state.totalDone === 0, 'undo reopens and unfeeds');
await b.add('Call Anna', 'tomorrow', 3);
t.eq(b.todo.calls.at(-1), ['addTask', {content: 'Call Anna', dueString: 'tomorrow', priority: 3, parentId: null}], 'add tomorrow');
await b.add('Call Anna 3pm p1 #Work', 'smart', 4);
t.eq(b.todo.calls.at(-1), ['quickAdd', 'Call Anna 3pm p1 #Work'], 'Todoist syntax uses quick add');
await b.split(task('s', '2026-10-27', 2), ['Open file', ' ', 'Outline'], true);
t.eq(b.todo.calls.filter(c => c[0] === 'addTask').slice(-2).map(c => [c[1].content, c[1].parentId, c[1].dueString, c[1].priority]),
  [['Open file', 's', 'today', 2], ['Outline', 's', null, 2]], 'split adds sub-tasks, step 1 today');
b.startFocus(null, 25);
const r = makeBrain({now: at('2026-10-27T11:00'), store: b.store}); await r.start();
t.eq([r.focusSession?.minutes, r.focusSession?.isBreak], [25, false], 'focus session survives a restart');
b.tick(new Date(at('2026-10-27T11:00').getTime() + 25 * 60000 + 1000));
t.eq(b.lastRule, 'focusEnd', 'focus end asks if you finished');
```

- [ ] **Step 2: Run `make test`** — expected: FAIL.
- [ ] **Step 3: Implement** by porting *Actions* and *Focus (Pomodoro)* from `Brain.swift`, plus `celebrate()`.
- [ ] **Step 4: Run `make test`** — expected: all pass.
- [ ] **Step 5: Commit** — `git commit -m "Port task actions, splitting and focus sessions"`.

---

## Phase F — UI in GNOME Shell

Every UI task ends with `tools/nested.sh <its scenes>` and opening each PNG. A task passes when the script exits 0 and each scene matches the matching screenshot in `build/ref/todopet/docs/` (or the Swift view's layout) in content and layout. The nested shell runs in demo mode, so scenes need no token.

### Task 17: The pet on screen

**Files:**
- Create: `extension/ui/pet.js`
- Modify: `extension/ui/app.js` (services, brain with real `env`, 1 s tick, pet), `extension/ui/devScenes.js`
- Test: `tests/pet-geometry.test.js`

**Interfaces:**
- Consumes: `drawPet`, `PetMotion`, Brain events, `IdleWatch`, `FocusWatch`, `CalendarSource`, `SessionWatch`.
- Produces in `ui/pet.js` the pure helpers `clampToWorkArea(x, petWidth, workArea) -> x` and `groundY(workArea, petHeight) -> y`, plus `class PetActor extends Emitter { constructor(app); show(); hide(); destroy(); actor; frame -> {x, y, width, height}; comeHere(); startParade(text); startBlock(); endAntic() }`, emitting `clicked`, `right-clicked` and `moved`. The actor is an `St.DrawingArea` named `todopet-pet` (`reactive: true`, `track_hover: true`), added with `Main.layoutManager.addTopChrome(actor, {trackFullscreen: true})`. Walking, speeds and idle times are ported from `PetController.step/chooseNext/speed/idleTime`. Dragging uses `global.stage.grab(actor)`; on release the pet falls back to the ground. It looks at `global.get_pointer()`, marches toward the pointer when angry and `chaseWhenAngry` is on, and repaints from a `Clutter.Timeline`: ~30 fps while moving, ≤ 4 fps while still, none while hidden. It shows the focus chip during focus. Size is `petScale × stageScale`. It re-clamps on `workareas-changed` and `monitors-changed`.
- App wiring: `brain.calmMotion` with `prefs.stillWhileTyping` keeps the pet still while typing; visibility follows `hidden-until` and the lock state.

- [ ] **Step 1: Write the failing tests:** `t.eq(clampToWorkArea(-50, 120, {x: 0, y: 32, width: 1600, height: 868}), 0, 'clamp left')`; `t.eq(clampToWorkArea(1590, 120, {x: 0, y: 32, width: 1600, height: 868}), 1480, 'clamp right')`; `t.eq(clampToWorkArea(700, 120, {x: 1600, y: 0, width: 1920, height: 1080}), 1600, 'monitor moved')`; `t.eq(groundY({x: 0, y: 32, width: 1600, height: 868}, 120), 780, 'ground')`.
- [ ] **Step 2: Run `make test`** — expected: FAIL. Implement; run — expected: PASS.
- [ ] **Step 3: Scenes** `walk` (two shots 2 s apart), `hover`, `drag` (moves the actor up 300 px; shots mid-air and after landing), `focus-chip`, `sleeping` (work hours set so it is night). Run `tools/nested.sh walk hover drag focus-chip sleeping`. Expected: exit 0; Mochi stands on the bottom edge of the work area; the two walk shots differ in x; the drag shots show the pet in the air and then back on the ground.
- [ ] **Step 4: Commit** — `git commit -m "Put Mochi on screen: walking, drag and drop, hover, looking around"`.

### Task 18: Speech bubble

**Files:**
- Create: `extension/ui/bubble.js`
- Modify: `extension/ui/app.js`, `extension/stylesheet.css`, `extension/ui/devScenes.js`

**Interfaces:**
- Produces `class BubbleView { constructor(app); show(bubble, petFrame, mood); hide(); follow(petFrame); destroy() }`, a port of `Bubble.swift`: the shape with a tail toward the pet, pill buttons (primary style), a close button, auto-hide after `bubble.seconds`, fade-in. It reports `brain.noteResponse` with `ignored` (faded), `closed` or `{picked: title}`. Max width 320 px; text wraps with `Pango.WrapMode.WORD_CHAR`. An `urgent` bubble replaces one on screen; otherwise it waits. Sounds and speech go through `env.play`/`env.speak`.

- [ ] **Step 1: Scenes** `bubble` (morning greeting with two actions), `bubble-stuck` (postponed-task bubble), `long-title` (a 150-character Vietnamese title with emoji). Run `tools/nested.sh bubble bubble-stuck long-title`. Expected: matches `docs/bubble-light.png` and `docs/bubble-stuck.png`; the long title wraps inside the bubble with nothing clipped.
- [ ] **Step 2: Commit** — `git commit -m "Add the speech bubble"`.

### Task 19: Task board

**Files:**
- Create: `extension/ui/board.js`, `extension/ui/widgets.js` (pill button, priority dot, section header, mini pet)
- Modify: `extension/ui/app.js`, `extension/stylesheet.css`, `extension/ui/devScenes.js`

**Interfaces:**
- Produces `class Board { constructor(app); open({focusAdd = false} = {}); close(); toggle(); isOpen; handleKey(keyval) -> bool; destroy() }`, a port of `BoardView.swift`:
  - Header: mood, reason line with a hover breakdown, streak, 📜 diary, wardrobe, settings.
  - Token setup view: paste token, *Save & connect*, *Try demo*.
  - Frog card and task rows with hover actions (▶ focus, ✂ split, → move, 🗑 delete with confirmation).
  - Add row: Today / Tomorrow / No date / ✨ Todoist syntax, and priority.
  - Calendar card (`CalendarCard` from `PlanningViews.swift`; Join hidden when `!calendar.hasJoinLinks`) and life bar (`LifeBar`).
  - Open-Todoist link (`https://app.todoist.com/app/today`).
  - Placement: next to the pet, kept on screen. While open it holds `Main.pushModal(board.actor)`; Esc (through `handleKey`) or a click outside closes it with `Main.popModal`. `focusAdd` puts key focus in the add entry.

- [ ] **Step 1: Scenes** `board` (demo data), `board-setup` (no token, demo off), `board-delete` (delete confirmation open), `add` (`entry.set_text('Call Anna')`, then a shot). Run `tools/nested.sh board board-setup board-delete add`. Expected: `board` matches `docs/board-light.png` in content and order; `board-setup` shows the token field.
- [ ] **Step 2: Close check.** At the end of scene `board`, call `board.handleKey(Clutter.KEY_Escape)` and log `TODOPET board closed=<!board.isOpen>`. Expected: `closed=true` in the log.
- [ ] **Step 3: Commit** — `git commit -m "Add the task board"`.

### Task 20: Split view, wardrobe and diary

**Files:**
- Create: `extension/ui/splitView.js`, `extension/ui/wardrobe.js`, `extension/ui/diary.js`
- Modify: `extension/ui/board.js` (shows them in place of the task list), `extension/ui/devScenes.js`

**Interfaces:**
- Each exports `build(app, onBack) -> St.Widget`. `splitView.js` (port `BreakdownView`): steps list, quick template, *Ask Claude* when a key exists, *first step today* toggle, save → `brain.split`. `wardrobe.js` (port `WardrobeView`): accessories, achievements, sticker book. `diary.js` (port `LogView`): day picker, filter, summary line, *Copy* via `St.Clipboard`, *Open folder* via `Gio.AppInfo.launch_default_for_uri`.

- [ ] **Step 1: Scenes** `split`, `wardrobe`, `diary`. Run `tools/nested.sh split wardrobe diary`. Expected: they match `docs/split.png`, `docs/wardrobe.png` and `docs/diary.png`.
- [ ] **Step 2: Commit** — `git commit -m "Add split view, wardrobe and diary"`.

### Task 21: Mischief and celebrations on screen

**Files:**
- Create: `extension/ui/antics.js`
- Modify: `extension/ui/app.js`, `extension/ui/pet.js`, `extension/ui/devScenes.js`

**Interfaces:**
- Produces `class Antics { constructor(app); run(antic); stop(); celebrate(event); destroy() }`.
  - Grumble: sighs and stomps in place.
  - Parade: the pet marches across the screen dragging `drawSign` with the avoided task.
  - Block: the pet leaps to the screen center with the table-flip bubble.
  - Each antic has a *Spare me 15'* action and is cancelled by clicking the pet.
  - `celebrate`: falling food, the dance, a combo badge, and fireworks or confetti in a non-reactive overlay actor (`reactive: false`) above the pet.
  - Voice lines go through `env.speak` when `voiceOn`.

- [ ] **Step 1: Scenes** `celebrate-jump`, `celebrate-fireworks`, `golden`, `parade`, `block`, `grumble`. Run them. Expected: `parade` shows the sign with the task title behind the pet (compare `docs/sign.png`); `block` shows the table-flip bubble (compare `docs/bubble-block.png`); the celebration shots match the bottom row of `docs/life.png`.
- [ ] **Step 2: Commit** — `git commit -m "Add mischief and celebrations"`.

### Task 22: Top bar indicator, hotkey, hide and quiet, lock, re-enable

**Files:**
- Create: `extension/ui/indicator.js`
- Modify: `extension/ui/app.js`, `extension/ui/devScenes.js`

**Interfaces:**
- Produces `TodoPetIndicator` (`GObject.registerClass`, extends `PanelMenu.Button`). Its label is `<mood emoji> <completed>/<target>`, or `🍅 MM:SS` during focus; it updates on brain `changed` and every second during focus. The quick menu is ported from `AppDelegate.fill`: add task, focus on the next task, hide 1 hour, quiet 1 hour (or *Unquiet*), diary, settings (`extension.openPreferences()`), demo toggle.
- Hotkey: `Main.wm.addKeybinding('board-hotkey', settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => board.open({focusAdd: true}))`, removed with `Main.wm.removeKeybinding` in `stop()`.
- `dev-trigger` watcher: `parade`, `block`, `grumble`, `celebrate:<kind>`, `golden`, `bubble`. The extension resets the key to `''` after acting.
- Lock: on `lock-changed` true, hide every actor and call `brain.setLocked(true)`; restore on unlock.

- [ ] **Step 1: Scenes** `menu` (opens the indicator menu), `reenable` (runs `app.stop()` then `app.start()` 3 times and logs `TODOPET actors=<count of actors named todopet-pet under global.stage>`), `locked` (emits `lock-changed` true, then a shot). Run them. Expected: the menu has the macOS quick-menu items; the log has `actors=1`; the locked shot shows no pet; no errors in the log.
- [ ] **Step 2: Commit** — `git commit -m "Add top bar indicator, hotkey, hide and quiet, lock handling"`.

### Task 23: Settings window

**Files:**
- Create: `extension/prefs.js`
- Modify: `extension/ui/devScenes.js` (scene `prefs`)

**Interfaces:**
- Produces `export default class TodoPetPrefs extends ExtensionPreferences { fillPreferencesWindow(window) }`, with `Adw.PreferencesPage`s ported from `SettingsView.swift`:
  - **General:** language, pet name, size, sounds, voice (with a hint when `spd-say` is missing), mischief, chase.
  - **Day:** target, work hours, work days, plan deadline, reminder interval, focus and break, bubble gap, protect flow, still while typing, adapt target.
  - **Todoist:** token `Adw.PasswordEntryRow`, saved with `storeSecret` and then `secrets-serial += 1`; filter.
  - **Distractions:** apps, watch browsers, sites, with a note that sites are matched by window title.
  - **Calendar:** use calendar, meeting lead, Join-link status ("install gir1.2-ecal-2.0" when ECal is missing).
  - **Postponed:** stuck days, Anthropic key, model.
  - **Diary:** keep log, open folder.
  - **Shortcut:** board hotkey capture.
  - **Developer:** demo mode and `dev-trigger` buttons.
- The extension reloads secrets whenever `secrets-serial` changes.

- [ ] **Step 1: Scene `prefs:<Page>`** sets `dev-trigger` to `prefs:<Page>`, calls `app.extension.openPreferences()`, waits 3 s and takes a shot. `fillPreferencesWindow` reads `dev-trigger`: when it starts with `prefs:` it shows that page (`window.set_visible_page_name`) and resets the key to `''`. Each page's `name` is its English title. Run `tools/nested.sh prefs:General prefs:Day prefs:Calendar`. Expected: each shot shows that page with every row. If the prefs window never appears in the headless session, record that in the task report, then verify `prefs.js` by running `gjs -m tools/prefs-check.js`, which builds every page into an `Adw.PreferencesWindow` without presenting it and checks the row count of each page.
- [ ] **Step 2: Commit** — `git commit -m "Add the Settings window"`.

---

## Phase G — Ship

### Task 24: Docs, release workflow, final verification, GitHub repo

**Files:**
- Create: `README.md`, `README.vi.md`, `docs/*.png` (copied from `out/` and `build/nested/shots/`), `.github/workflows/release.yml`

- [ ] **Step 1: READMEs** modeled on the Swift repo's two READMEs. Sections:
  - What it does.
  - Install: `git clone`, `make install`, log out and back in, `gnome-extensions enable todopet@trananhtung.github.io`.
  - Connect Todoist.
  - Calendar: Online Accounts, and the optional `sudo apt install gir1.2-ecal-2.0` for Join links.
  - The hotkey.
  - Differences from the Mac version: window-title site matching, typing heuristic, Ctrl+Super+T.
  - Privacy.
  - Development: `make test`, `make snapshot`, `tools/nested.sh`.
  - Screenshots: moods, life, board, bubble, sign, wardrobe, split, diary.
- [ ] **Step 2: Release workflow.** On tags `v*`: `make pack`, then `gh release create "$GITHUB_REF_NAME" build/*.shell-extension.zip --generate-notes` with `GH_TOKEN: ${{ github.token }}` and `permissions: contents: write`.
- [ ] **Step 3: Full verification.** Run `make lint && make test && make snapshot && tools/nested.sh` (all scenes). Expected: lint clean, `All good 🎉`, every scene PNG present and checked, no `JS ERROR` in `build/nested/shell.log`.
- [ ] **Step 4: Commit** — `git commit -m "Add READMEs, screenshots and release workflow"`.
- [ ] **Step 5: Create the GitHub repo and push:** `gh repo create trananhtung/todopet-gnome --public --description "A GNOME desktop pet that reads your Todoist tasks, asks you to plan 3 tasks a day, reminds you, and gets happy or grumpy with your progress. English & Vietnamese." --source . --push`. Expected: the repo URL is printed and the CI run on `main` passes (`gh run watch`).
- [ ] **Step 6: Hand-off.** The real-session test is the author's: `make install`, log out and back in, enable, connect Todoist.
