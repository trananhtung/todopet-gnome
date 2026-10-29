# TodoPet for GNOME — design

Date: 2026-10-28
Status: draft, waiting for review

## Goal

Bring [TodoPet](https://github.com/trananhtung/todopet) (a macOS Todoist desktop pet written in Swift) to Ubuntu.
The result is a **GNOME Shell extension** with the **same features** as the macOS app, so it works natively
on Ubuntu 26.04 (GNOME 50, Wayland-only session).

Success means: on the author's Ubuntu machine, Mochi walks along the bottom of the screen, reads Todoist,
asks for 3 tasks a day, reminds, runs focus sessions, gets happy or grumpy, eats, grows, wears accessories,
makes mischief, reads meetings from GNOME's calendar, and keeps a diary, in English and Vietnamese.

### Decisions already made

| Decision | Choice | Why |
|---|---|---|
| Platform | Ubuntu (GNOME) only | Windows dropped by the author |
| Technology | GNOME Shell extension in JavaScript (GJS, ES modules) | On Wayland only the compositor can place things anywhere, read the pointer and the focused window, and grab global shortcuts. An extension runs inside GNOME Shell, so it gets all of these. A separate app would need XWayland plus a helper extension anyway. |
| Pets | Only **Mochi**, the original pet | Author's choice |
| Scope | Full parity with the macOS app | Author's choice |
| Repo | `github.com/trananhtung/todopet-gnome`, public, MIT | Author's choice |

### Source of truth

The Swift code at commit `8573b98` of `trananhtung/todopet` is the reference for **behavior**: every
threshold, score, timing, reminder rule, life rule, and every line the pet says (EN + VI). This spec
describes what changes; anything it does not mention behaves exactly as in the Swift code and its README.

## What changes from macOS

| macOS | GNOME |
|---|---|
| Floating `NSWindow` above the Dock | `St.DrawingArea` added as **top chrome** (`Main.layoutManager.addTopChrome`, `trackFullscreen: true`). Only the pet's own actors take input; everything else clicks through. The pet walks along the bottom edge of the primary monitor's work area (`getWorkAreaForMonitor`), so it stands on a bottom dock when the dock reserves space. |
| Cursor position (look at cursor, march toward it) | `global.get_pointer()` |
| Frontmost app (`NSWorkspace`) | `global.display.focus_window` + `Shell.WindowTracker` → app name, `wm_class`, and the window title only when the window is a browser (no other window's title is read). Changes come from `notify::focus-window`, and from `notify::title` on a focused browser window. |
| Active tab URL via AppleScript | **Window-title matching** (see below). URLs are no longer available. |
| `secondsSinceLastEventType(.keyDown)` | **Typing heuristic** (see below) |
| Idle time | `global.backend.get_core_idle_monitor().get_idletime()` (in-process `Meta.IdleMonitor`, no D-Bus round trip) |
| EventKit (Calendar) | `org.gnome.Shell.CalendarServer` D-Bus (the same source as the top bar clock). Calendars added in *Settings › Online Accounts* (Google, Microsoft 365) or in GNOME Calendar/Evolution show up. That server only sends title and times, so it covers meeting reminders, quiet time, free time and time blocks. **Join links** need the event's location/description/URL: when the optional package `gir1.2-ecal-2.0` is installed, the extension reads today's events through Evolution Data Server (`gi://ECal`, async calls only) instead and finds Meet, Zoom and Teams links there. Without it the **Join** button is hidden and the Settings page says which package adds it. |
| Keychain | libsecret (`Secret` GI), GNOME Keyring. Items: Todoist token, Anthropic API key. |
| Menu bar item (`😊 2/3`, `🍅 18:42`) + menu | `PanelMenu.Button` in the top bar with the same label and the same quick menu (add task, focus, hide 1 h, quiet 1 h, diary, settings) |
| Global hotkey ⌃⌥T | `Main.wm.addKeybinding`. Default **Ctrl+Super+T** because Ubuntu uses Ctrl+Alt+T for the Terminal. Changeable in Settings. |
| `AVSpeechSynthesizer` | `spd-say` (speech-dispatcher) with `-l vi` / `-l en`. When `spd-say` is missing the switch shows a hint and can only be turned off. |
| `NSSound` | `global.display.get_sound_player()` with freedesktop theme sounds. Keeps the 3 sound modes (Off, Important only, Everything). |
| Open at login | Removed. The extension starts with GNOME Shell. |
| `NSWorkspace.didWake` | logind `PrepareForSleep(false)` signal, plus a fallback when the gap between two ticks exceeds 2 minutes |
| SwiftUI windows (board, bubble, settings, diary, wardrobe, split) | Bubble, board, split view, wardrobe and diary are St widgets in top chrome. Settings is `prefs.js` (libadwaita, opened with `openPreferences()`). |
| `UserDefaults` | GSettings schema `org.gnome.shell.extensions.todopet` |
| `~/Library/Application Support/TodoPet` | `~/.local/share/todopet/` (life state, postponed-task log, focus session, diary `log/`) |
| `--demo`, `--snapshot`, `--selftest`, `TODOPET_ANTIC` | Developer page in Settings (demo mode, trigger parade / table flip / each celebration), `make snapshot`, `make test` |

### Distracting websites by window title

Browsers put the page title in the window title (`Watch later - YouTube — Mozilla Firefox`).
When the focused window belongs to a browser (Firefox, Chrome, Chromium, Brave, Edge, Vivaldi, Opera, Cốc Cốc),
the title is matched against the same `distractionSites` setting:

- A known domain maps to the brand name that appears in titles: `youtube.com → YouTube`, `facebook.com → Facebook`,
  `tiktok.com → TikTok`, `instagram.com → Instagram`, `x.com → "/ X"` and `Twitter`, `reddit.com → Reddit`,
  `netflix.com → Netflix`.
- Any other domain uses its main label (`vnexpress.net → vnexpress`), matched case-insensitively as a whole word.
- A rule with a path (`youtube.com/shorts`) needs both the domain's name and the last path segment (`Shorts`) in the title.
  This is approximate and the Settings page says so.

The match result has the same shape as `BrowserWatcher.match`, so time-on-site, mood penalty, the table flip and the
distraction report work unchanged. Titles stay in memory only, like URLs on macOS.

### Typing heuristic

GNOME Shell sees all input but there is no "time since last key press" API. The extension samples every second:
if idle time went back to under 1 s while the pointer did not move since the previous sample, that second counts
as a key press. `secondsSinceKey` is the time since the last such second. This feeds `CalmRules` unchanged
(deep work, waiting for a pause, keeping still while typing). Scrolling without moving the pointer counts as typing,
which only makes the pet quieter.

### Screen lock

GNOME disables extensions on the lock screen unless they ask to stay. The extension declares
`"session-modes": ["user", "unlock-dialog"]` so the focus timer, combos and day settlement keep running.
While locked it hides every actor, shows nothing, and counts as "away". A focus session or break that ends while
locked asks its question after the unlock. The focus session's end time is also saved to disk, so a GNOME Shell
restart doesn't lose it.

## Architecture

```
todopet@trananhtung.github.io/
  metadata.json          shell-version ["50"], session-modes, settings-schema
  extension.js           enable()/disable(): builds and tears down everything
  prefs.js               Settings window (libadwaita), same sections as SettingsView.swift + Developer
  stylesheet.css
  schemas/org.gnome.shell.extensions.todopet.gschema.xml
  core/                  plain JS, imports at most GLib/Gio, unit-tested with gjs -m
    dates.js             DateParse, DayMath, TextClean
    models.js            Todo task, due, deadline, duration, stats, DaySnapshot
    mood.js              Mood, MoodInputs, MoodEngine.score
    calm.js              CalmRules + typing heuristic
    life.js              Stage, Accessory, LifeState, LifeRules (feed, dirt, XP, combos, celebrations)
    calendarMath.js      CalendarMath (current event, free gaps, slot suggestions, adaptive target)
    stuck.js             StuckTracker rules
    sites.js             window-title site matching, browser detection
    lines.js / l10n.js   everything the pet says, EN + VI; L(vi, en) like L10n.swift
    diary.js             LogEntry, LogSummary, day files, 14-day retention
  services/
    todoist.js           Todoist API v1 over libsoup3 (async), same endpoints as TodoService.swift
    demo.js              DemoService
    claude.js            Messages API split-into-steps, same request as ClaudeClient.swift
    secrets.js           libsecret store/lookup/clear
    calendar.js          CalEvent list from ECal when gir1.2-ecal-2.0 is installed, else CalendarServer D-Bus
    idle.js              idle time from Meta.IdleMonitor, plus the typing sampler
    focusWatch.js        focused app/title tracking
    speech.js, sound.js
    store.js             JSON files under ~/.local/share/todopet (atomic writes, async)
  brain.js               port of Brain.swift: sync, mood every 15 s, the 13 reminder rules, focus timer, actions
  art/petArt.js          Cairo port of PetArt.swift (moods, stages, accessories, hunger, dirt, celebrations, golden)
  ui/
    pet.js               pet actor: walking, drag & drop with fall, hover, look at cursor, focus chip
    bubble.js            speech bubble + action buttons
    board.js             task board (popover-like: Esc or click outside closes it), token setup, add row,
                         frog card, hover actions, streak, calendar card, life bar
    splitView.js, wardrobe.js, diary.js
    antics.js            sign parade, table flip, fireworks/confetti, sigh/stomp
    indicator.js         top bar button + quick menu
tests/                   gjs -m tests/run.js (ports DevTools.selfTest checks + new ones)
tools/snapshot.js        renders art grids to PNG with Cairo
Makefile                 test, snapshot, lint, install, pack
```

### Runtime rules

- **Never block GNOME Shell.** Network, D-Bus and file I/O are async. No `GLib.spawn_sync`.
- **Animation budget.** The pet repaints at about 30 fps while it moves and at 4 fps or less while it sits still.
  Nothing animates while the pet is hidden.
- **Clean disable.** Every timeout, signal connection, keybinding, D-Bus proxy and actor is tracked and removed
  in `disable()`. Re-enabling restores state from GSettings and the JSON store.
- **Errors stay inside the extension.** Service failures show as the same error states as on macOS
  (bad token, offline). They never throw into Shell code. Unexpected errors are logged with `console.error`.

### Text and fonts

St uses the system font (Ubuntu Sans), which covers Vietnamese. Emoji render in color through the system emoji font.

## Settings (GSettings keys)

All keys from `Prefs.swift` with the same defaults:
`lang`, `pet-name`, `daily-target`, `work-start`, `work-end`, `plan-deadline`, `remind-every`, `focus-minutes`,
`break-minutes`, `filter-query`, `distraction-apps`, `sound-mode`, `work-saturday`, `work-sunday`, `pet-scale`,
`chase-when-angry`, `watch-browsers`, `distraction-sites`, `use-calendar`, `adapt-target`, `meeting-lead`,
`stuck-days`, `claude-model`, `antics`, `voice-on`, `protect-flow`, `still-while-typing`, `bubble-gap`, `keep-log`,
`first-launch`.

New keys: `board-hotkey` (default `['<Control><Super>t']`), `hidden-until`, `quiet-until`, `demo-mode`,
`dev-screenshot-dir` and `dev-scenes` (developer only, see Testing).

## Testing

1. **Unit tests** (`make test` → `gjs -m tests/run.js`): every check in `DevTools.selfTest`, plus window-title matching,
   the typing heuristic, Todoist JSON parsing from recorded responses, and calendar event mapping from recorded
   CalendarServer payloads. Runs on any machine with `gjs`, including CI.
2. **Art snapshots** (`make snapshot` → `out/*.png`): mood grid, life grid (stages, hungry, dirty, accessories,
   celebrations, golden), focus chip, compared by eye with `docs/moods.png` and `docs/life.png` from the Swift repo.
3. **Nested GNOME Shell** (no sudo): `dbus-run-session -- gnome-shell --headless --virtual-monitor 1600x900` with
   its own `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` and `XDG_STATE_HOME` under `build/nested/`, so it never
   touches the real session's extensions or dconf settings. The extension is installed there with `demo-mode` on.
   When `dev-screenshot-dir` and `dev-scenes` are set, the extension plays those scenes and saves stage screenshots
   (pet walking, bubble, board, split view, wardrobe, diary, parade, table flip) with `Shell.Screenshot`.
   Verified on this machine on 2026-10-28 with a throwaway extension.
   The run passes when every scene renders and the journal has no extension errors.
   Optional: with `mutter-dev-bin` installed, `gnome-shell --devkit` shows the same thing live in a window.
4. **Real session** (the author): `make install`, log out and back in, `gnome-extensions enable todopet@trananhtung.github.io`.
5. **CI** (GitHub Actions, `ubuntu-latest`): ESLint, unit tests, snapshots uploaded as an artifact.
   Tags build the extension zip with `gnome-extensions pack` and attach it to a GitHub release.

## Docs

README.md and README.vi.md modeled on the Swift repo: what it does, install, connect Todoist, calendar via
Online Accounts, what differs from the Mac version (window-title site matching, typing heuristic, hotkey),
privacy, development. Screenshots come from the nested-shell run.

## Out of scope

- Windows, macOS, KDE and other desktops.
- Extra pet species.
- Reading exact browser URLs (would need a browser extension).
- Publishing to extensions.gnome.org (the zip is ready for it; submitting is the author's call).
