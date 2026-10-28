<h1 align="center">TodoPet for GNOME</h1>

<p align="center">
A desktop pet for Ubuntu (GNOME Shell) that walks along the bottom of your screen, reads your <a href="https://todoist.com">Todoist</a> tasks,
and gets <b>happy when you work</b> and <b>grumpy when you don't</b>.<br>
English · <a href="README.vi.md">Tiếng Việt</a>
</p>

![Moods](docs/moods.png)

This is a port of the macOS app [trananhtung/todopet](https://github.com/trananhtung/todopet) to a **GNOME Shell extension**. It has the same features, thresholds and lines (in English and Vietnamese). See [Differences from the Mac version](#differences-from-the-mac-version) for what had to change.

## What it does

- **Walks around your screen.** Mochi wanders along the bottom of your screen (on top of a bottom dock, if you have one), looks at your pointer, and stops when you hover it. Drag it anywhere and it falls back down.
- **Asks "what are we doing today?"** If today has fewer than **3 tasks** (configurable), it asks you to plan, gently in the morning and more insistently once the planning deadline passes.
- **Reminds you of the right task.** It picks the next task with "eat the frog" ordering (highest priority, then earliest time), nudges you every 45 minutes, and pings you 10 minutes before timed tasks.
- **Has real moods.** It celebrates every completed task (including ones you tick off in the Todoist app), and gets annoyed, then grumpy, when tasks are overdue, nothing moves for hours, or you sit in a distracting app. When grumpy it marches toward your pointer 😤
- **Lets you work with Todoist from the pet.** Click the pet to see today's tasks, complete them, add new ones (Today / Tomorrow / No date, priority, or full Todoist quick-add syntax like `Call Anna 3pm p1 #Work`), move tasks to today or tomorrow, delete tasks (after a confirmation, since Todoist can't restore them), and see your Todoist streak.
- **Has a built-in focus timer.** Start a 25-minute session on a task and the pet puts on a headband and sits quietly in a corner. When time's up it asks if you finished; if you did, it completes the task in Todoist and starts your break.
- **Runs an end-of-day review.** 30 minutes before work ends it shows what you finished and offers to move the rest to tomorrow.
- **Catches distracting websites.** It reads the title of the focused browser window (Firefox, Chrome, Chromium, Brave, Edge, Vivaldi, Opera, Cốc Cốc, including the Flatpak builds). Two minutes on YouTube or Facebook during work hours and the pet starts frowning. You choose the sites, and rules like `youtube.com/shorts` match only part of a site. Matching is by title, so it is approximate (see [below](#differences-from-the-mac-version)).
- **Knows your meetings.** It reads today's events from the GNOME calendar (including Google or Microsoft 365 accounts added in Settings › Online Accounts). It reminds you 5 minutes before a meeting, stays quiet during meetings, and doesn't count meeting time as slacking. On a meeting-heavy day it lowers the daily target, roughly one important task per two free hours. A **Join** button for Meet, Zoom and Teams links needs one optional package (see [Calendar](#calendar)).
- **Suggests time blocks.** It slots your next tasks into today's free gaps ("10:00–11:00 Write the report"). One click gives the task that time in Todoist, so the pet reminds you right on time.
- **Spots tasks you keep postponing.** When a task has sat on your list for 3+ days, the pet asks whether to split it into 15–30 minute steps (added as Todoist sub-tasks, with step 1 on today's plan) or drop it from the plan. With a Claude API key, **Ask Claude** suggests the steps for you.
- **Speaks English and Vietnamese**, switchable in Settings (the default follows your system language).

### A pet that lives with your work

![Growth, hunger, accessories and celebrations](docs/life.png)

- **Feed it by finishing tasks.** Every finished task drops a treat into its mouth (+25% fullness). Fullness drains about 7% per work hour, so a lazy day leaves it thin, hungry and rumbling. Each workday you do nothing makes it dirtier, up to 3 levels with flies buzzing around, and each finished task washes one layer off. All of this carries over to the next day.
- **Watch it grow.** Tasks earn XP, and the pet grows from Baby (with little leaves on its head) to Kid, Teen, Grown-up and Master.
- **Surprise celebrations.** Each finished task gets a random dance: jump, spin, back-flip or disco. One in ten is a rare golden treat with a golden pet. Finishing tasks within 30 minutes of each other builds a combo (×2, ×3…) worth more XP, ending in fireworks.
- **Unlock things to wear.** The pet earns a bow, scarf, sunglasses, top hat, crown and grad cap through milestones like your first task, a 3-day streak, a ×3 combo, 25 tasks and a 7-day streak. A sticker book collects every day you finish your whole plan.
- **Mischief that escalates when you slack.** After 10 minutes annoyed, it sighs and stomps. After 10 minutes grumpy, it marches across the screen dragging a sign with the task you're avoiding. Five minutes on YouTube while grumpy and it leaps into the middle of the screen with a (╯°□°)╯︵ ┻━┻. At the end of the day it reports, sulking, how long you spent on distractions. It can also say its lines out loud (off by default).
- **It plays fair.** No mischief during meetings or focus sessions or while you're away. At most one big stunt every 20 minutes. Every stunt has a **Spare me 15'** button, and clicking the pet calls it off. You can turn mischief off in Settings.

| Wardrobe | Mischief |
|---|---|
| ![Wardrobe](docs/wardrobe.png) | ![Sign](docs/sign.png)<br>![Sign parade](docs/parade.png)<br>![Table flip](docs/bubble-block.png) |

| Board | Bubble | Split a task |
|---|---|---|
| ![Board](docs/board.png) | ![Bubble](docs/bubble.png)<br>![Postponed task](docs/bubble-stuck.png) | ![Split](docs/split.png) |

The screenshots come from a headless GNOME Shell running the built-in demo data (`make snapshot` and `tools/nested.sh`, see [Development](#development)).

## Install

You need **GNOME Shell 50** (Ubuntu 26.04) in a **Wayland** session, plus `git` and `make`.

TodoPet keeps your Todoist token and Claude key in GNOME Keyring through libsecret, which needs the `gir1.2-secret-1` package. It is usually installed already; if not:

```bash
sudo apt install gir1.2-secret-1
```

Without it the pet still runs, but it can't keep a Todoist token or a Claude key.

```bash
git clone https://github.com/trananhtung/todopet-gnome.git
cd todopet-gnome
make install
```

`make install` compiles the settings schema and copies the extension to `~/.local/share/gnome-shell/extensions/todopet@trananhtung.github.io` (use `EXT_DIR=/some/dir` to put it somewhere else). It touches nothing else.

Then **log out and back in**. On Wayland, GNOME Shell can't reload itself, so it only finds a new extension at login. After that, turn it on:

```bash
gnome-extensions enable todopet@trananhtung.github.io
```

Mochi appears at the bottom of your screen, and `🐾` (or `😊 0/3` once you are connected) shows in the top bar.

To update, `git pull`, run `make install` again and log out and back in. To remove it, run `gnome-extensions uninstall todopet@trananhtung.github.io`. Your data stays in `~/.local/share/todopet` and your tokens in GNOME Keyring until you delete them.

Tagged releases on GitHub also carry a ready-made `todopet@trananhtung.github.io.shell-extension.zip`, which you can install with `gnome-extensions install --force <zip>` (then log out and in).

Want to look around first? Click the pet and press **Try demo** (or use **Demo mode** in the top bar menu, or Settings › Developer). You get sample tasks and meetings, and nothing is sent anywhere.

Optional packages:

| Package | What it adds |
|---|---|
| `gir1.2-ecal-2.0` | **Join** buttons for meeting links (see [Calendar](#calendar)) |
| `speech-dispatcher` (the `spd-say` command, usually installed) | The pet can say its lines out loud |

## Connect Todoist

1. In Todoist open **Settings → Integrations → Developer** ([direct link](https://app.todoist.com/app/settings/integrations/developer)) and copy your **API token**.
2. Click the pet, paste the token in the setup view and press **Save & connect**. (You can also paste it in Settings › Todoist; the board picks it up.)

The token is stored in **GNOME Keyring** (through libsecret) and is only ever sent to `api.todoist.com` (Todoist API v1). It is never written to the extension's settings or to a file. To disconnect, use the **Disconnect** button in Settings › Todoist.

### Calendar

TodoPet reads today's events from the same calendar service as the clock in the top bar. To get your calendars in:

- Add your account in **Settings › Online Accounts** (Google, Microsoft 365), or add calendars in GNOME Calendar or Evolution.
- Switch **Read the GNOME calendar** on or off in Settings › Calendar (on by default).

That gives the pet meeting reminders, quiet time during meetings, free time, time-block suggestions and the lower target on busy days.

The shell's calendar service only passes on titles and times, so there are **no Join buttons** by default. To get them, install the optional Evolution Data Server bindings:

```bash
sudo apt install gir1.2-ecal-2.0
```

Then log out and back in. With the package present, TodoPet reads events through Evolution Data Server instead and finds Meet, Zoom and Teams links in the location, notes and URL of each event. Settings › Calendar shows whether Join links are on, and which package to install if not.

> **Heads-up:** the Join-link path (the `gi://ECal` code) was written against the libecal 2.0 API and its event mapping is unit-tested, but it could **not be run on the development machine**, because `gir1.2-ecal-2.0` was not installed there. The default path (the shell's calendar service) is tested end to end. If Join links don't appear after installing the package, please [open an issue](https://github.com/trananhtung/todopet-gnome/issues) with the output of `journalctl --user -b | grep -i todopet`.

### Splitting tasks with Claude (optional)

Add an Anthropic API key in **Settings › Postponed** ([get one](https://console.anthropic.com/settings/keys)); it is stored in GNOME Keyring. When you press **Ask Claude** in the split view, the task's title and notes are sent to the Claude API, which returns 3–5 small steps. The default model is `claude-opus-5-5` at low effort, with server-side fallback enabled in case a request is declined. Each request costs roughly 1–2 US cents, and you can change the model in Settings. Without a key you can type the steps yourself or start from the quick template.

### Spoken lines (optional)

Switch on **Pet speaks out loud** in Settings › General. Lines are spoken with `spd-say` (speech-dispatcher) in English or Vietnamese, offline if your voice is. It is off by default, and the switch is disabled with a hint when `spd-say` isn't installed.

### Using Todoist from Claude or other AI apps (MCP)

TodoPet talks to Todoist directly with your API token. If you also want to manage tasks by chatting with an AI assistant, connect Todoist's official MCP server at `https://ai.todoist.net/mcp`. In Claude Code that's `claude mcp add --transport http todoist https://ai.todoist.net/mcp`, and in Claude Desktop you add it as a custom connector. Tasks you create there show up on the pet within 3 minutes, or right away when you click it.

## Using it

| Action | What happens |
|---|---|
| Click the pet | Opens the task board (Esc or a click outside closes it) |
| Hover a task on the board | ▶︎ focus · ✂️ split · → move · 🗑 delete (asks first; sub-tasks and recurring series go too, and it can't be undone) |
| Drag the pet | Moves it; let go and it drops back to the bottom |
| Hover | It stops walking and blushes |
| Right-click the pet / click the top bar indicator | Quick menu: open the board, add task, focus, call the pet over, hide for 1 hour, quiet for 1 hour, refresh, diary, settings |
| <kbd>Ctrl</kbd><kbd>Super</kbd><kbd>T</kbd> | Opens the board with the add field focused, from any app |

![Quick menu](docs/menu.png)

The top bar shows the mood and today's progress (`😊 2/3`), or the timer during focus (`🍅 18:42`, and `☕` for a break). Without a token it shows `🐾`.

### The hotkey

The default is **Ctrl+Super+T** (Ubuntu keeps Ctrl+Alt+T for the Terminal). Change it in **Settings › Shortcut**: press **Set…**, then the keys you want. It needs Ctrl, Alt or Super together with a key. In the capture window Esc cancels and Backspace turns the shortcut off; **Reset** brings back Ctrl+Super+T. If another program already holds the combination, the board won't open from it, so pick a different one.

### Settings

Open Settings from the board's gear button, the quick menu, or `gnome-extensions prefs todopet@trananhtung.github.io`. It is a normal GNOME (libadwaita) window.

![Settings](docs/settings.png)

## How the mood works

Mochi keeps a 0–100 happiness score, recalculated every 15 seconds. Hover the reason line on the board to see the breakdown.

| Makes it happier | Makes it grumpier |
|---|---|
| +8 per task completed today | −7 per overdue task |
| +30 when today's plan is fully done | −4 per task that's past its time |
| Up to +15 right after you finish something | −12 to −50 when fewer than 3 tasks are planned after the planning deadline |
| +10 during a focus session | Up to −30 when nothing moves for more than 90 minutes |
| Meeting time counts as work | Up to −35 after 2+ minutes in a distracting app or website |
| | −3 per task that keeps getting postponed (up to −9) |
| | Up to −15 when it's hungry (below 30% full) |
| | −5 per level of dirt |

Score ≥ 75 is happy, ≥ 50 is chill, ≥ 30 is annoyed, and anything lower is grumpy. Outside work hours, at night, during meetings, or when you've been away for 10 minutes, it calms down or falls asleep, and it never nags while you're away.

## When it talks

In priority order, at most one bubble at a time:

1. A few minutes before a meeting (even during a focus session), then silence until the meeting ends
2. 10 minutes before, and at the time of, any task with a time
3. Morning greeting with today's plan (or a request to plan) and a summary of the day's meetings and free time
4. "What are our 3 things today?" every 30 minutes after the planning deadline until there are enough tasks
5. A distracting app or website open for more than 2 minutes
6. A task that keeps getting postponed: split it or drop it
7. Hungry: begging for a finished task, at most hourly
8. Mischief while you slack: grumbling, then the sign parade (the table flip comes with rule 5)
9. Overdue tasks, every 90 minutes
10. Once a day, a time block for the next task
11. End-of-day review, then a sulky distraction report if you spent 10+ minutes on distractions
12. A nudge with the next task, every 45 minutes
13. A productivity tip now and then, only when the mood is good

All timings are in **Settings**: daily target, work hours, work days, planning deadline, reminder interval, focus and break length, distracting apps and websites, calendar options, when a task counts as postponed, a custom Todoist filter for "my day" (for example `(today | overdue) & #Work`), pet size, sounds, mischief, spoken lines, and focus protection.

When the screen is locked the pet and its bubbles hide, but the extension keeps running: a focus timer carries on and the day's settlement isn't lost. A running focus session is also saved to disk, so restarting GNOME Shell doesn't lose it.

## Designed not to break your focus

A reminder app that interrupts deep work does more harm than good, so the pet follows what interruption research recommends:

| Rule | Why |
|---|---|
| **Interrupt at a pause.** Non-urgent bubbles wait until you stop typing for a few seconds or switch apps. Meeting and due-time reminders still arrive on time. | Interruptions at task boundaries cause less frustration and faster resumption than mid-task ones (Adamczyk & Bailey 2004; Iqbal & Bailey 2008). |
| **Protect deep work.** After 10 minutes of steady typing in work apps the pet shows 🎧, holds everything non-urgent, and counts the time as progress. No grumpiness, no mischief. | Getting back on track after an interruption is slow and stressful (Mark et al. 2008). |
| **Fewer bubbles.** At least 15 minutes between unsolicited bubbles (configurable), one at a time. | Batched, less frequent notifications improve attention and well-being (Fitz et al. 2019). |
| **Keep still while you type.** The pet stops walking and dampens its movements, and walks again when you pause. | Motion at the edge of vision grabs attention involuntarily (Bartram et al. 2003). |
| **Quiet by default.** Sounds are "important only" (meetings, due times, end of focus, finished tasks) and soft. Ordinary bubbles fade in silently. | Calm technology informs from the periphery and only moves to the center when needed (Weiser & Brown 1996). |
| **Mischief targets slacking, not work.** Antics never fire while you're typing, during meetings or focus sessions, or while you're away. | Nagging someone who's already working only breaks their flow. |

Sounds have three levels in Settings: **Off**, **Important only** (default) and **Everything**. They are soft chimes from the system sound theme.

### The pet diary

To tune all of this to how you actually work, the pet keeps a diary (the 📜 button on the board, or **Pet diary…** in the quick menu). It records:
- every reminder and the reason it fired
- what you did with it (tapped a button, closed it, or let it fade)
- every reminder it held back (you were in the zone, typing, or it had spoken recently)
- meetings, focus sessions, mood changes with their top reasons, time on distracting sites, feedings and the end-of-day settlement

A summary line shows how many reminders you got and how many you ignored. **Copy** puts the whole day on the clipboard, so you can paste it into Claude and ask for adjustments. The diary stays on your computer (`~/.local/share/todopet/log`, one file per day), keeps 14 days, and can be turned off in Settings › Diary. **Open folder** shows the files.

![Pet diary](docs/diary.png)

## Why these features

The behavior is based on well-known productivity practices, kept deliberately simple:

- **Rule of 3**: plan three meaningful outcomes per day instead of an endless list (J.D. Meier, *Getting Results the Agile Way*).
- **Eat the frog**: start with the most important task (Brian Tracy).
- **Implementation intentions**: tasks with a concrete time ("at 2pm I'll…") are more likely to get done (Peter Gollwitzer). The pet reminds you right on time.
- **Pomodoro**: short, timed focus blocks with breaks (Francesco Cirillo).
- **Interruptions are expensive**: getting back on task after a switch takes a long time (Gloria Mark's research), so the pet calls out distracting apps and websites and stays silent during focus and meetings.
- **Time blocking**: giving tasks a slot in the calendar protects time for them; the pet finds the slots between your meetings.
- **Procrastination often means the task is too big or vague**: breaking it into a small, concrete first step makes starting easier, so the pet suggests splitting tasks you keep postponing.
- **Shutdown ritual**: close the day by reviewing and rescheduling (Cal Newport).
- **Emotional feedback**: a character that visibly reacts to your progress makes progress feel rewarding, and slacking slightly uncomfortable.
- **Caring for a pet** (the "Tamagotchi effect", used by apps like Finch): you work partly to keep it fed and clean, and the consequences last across days. Losing something you have motivates more than an equal gain.
- **Variable rewards**: unpredictable celebrations and rare golden treats stay exciting longer than a fixed reward, which is why games use them.

## Differences from the Mac version

Everything else (thresholds, scores, reminder rules, life rules and every line the pet says) behaves as in the Mac app. What differs:

| Mac app | GNOME extension |
|---|---|
| Floating window above the Dock | Drawn by GNOME Shell itself, along the bottom of the primary monitor's work area. Only the pet and its bubbles take clicks; everything else clicks through. |
| Reads the **address** of the active browser tab | Matches the **title of the focused browser window** against your site list, because Wayland gives no access to a browser's address. See below. |
| Knows when you press a key | **Infers typing**: a second counts as typing when there was input but the pointer did not move. There is no keylogger and nothing reads which keys you press. |
| ⌃⌥T opens the board | **Ctrl+Super+T** (Ubuntu uses Ctrl+Alt+T for the Terminal). Changeable in Settings › Shortcut. |
| EventKit calendar | The GNOME calendar (Online Accounts, GNOME Calendar, Evolution). **Join** links need `gir1.2-ecal-2.0`. |
| Keychain | GNOME Keyring (libsecret) |
| macOS voice | `spd-say` (speech-dispatcher) |
| macOS sounds | Soft chimes from the freedesktop sound theme |
| "Open at login" setting | None. GNOME Shell starts the extension itself. |
| Menu bar item | Top bar indicator with the same label and menu |
| Settings window | A libadwaita settings window (plus a **Developer** page with demo mode and triggers for the mischief and celebrations) |

Buttons and highlights follow your system accent color (Settings › Appearance), as the Mac app follows the macOS one.

### Distracting websites are matched by window title

Browsers put the page title in the window title (`Watch later - YouTube — Mozilla Firefox`), so that is what TodoPet matches. It is **approximate**:

- A well-known domain is recognised by the name that appears in titles: `youtube.com` by "YouTube", `facebook.com` by "Facebook", `x.com` by "/ X" or "Twitter", and so on.
- Any other domain is matched by its main label (`vnexpress.net` by "vnexpress"), case-insensitively as a whole word.
- A rule with a path, like `youtube.com/shorts`, needs the site's name **and** the path's last word ("Shorts") in the title.
- A page whose title doesn't mention the site won't be caught, and a page that mentions it in a headline might be.
- Distracting **apps** (the Distractions list) are matched by app name or window class. Flatpak browsers are recognised too.

## Privacy

- No analytics and no servers of its own. Network traffic goes to `api.todoist.com`, and to `api.anthropic.com` only when you press **Ask Claude** (only the task's title and notes are sent).
- Distraction detection reads the **name of the focused app** and, if it is a browser, the **title of its window**. Titles stay in memory and are never stored or sent anywhere. No screen recording and no extra permissions are needed.
- "Typing" is a guess from input timing (input while the pointer is still). TodoPet reads only how long ago the last input was and where the pointer is. It never reads which keys you press and has no keylogger.
- The calendar is read locally from GNOME's calendar service (or Evolution Data Server); events never leave your computer through TodoPet.
- Your Todoist token and Anthropic key live in GNOME Keyring, not in a file or in dconf.
- The "postponed tasks" log is just task IDs and dates, and the pet's life (fullness, XP, accessories, today's distraction minutes per site) is stored locally, both as JSON files in `~/.local/share/todopet`. The diary is in `~/.local/share/todopet/log` and notes reminders, meeting titles, sites and task names; it never leaves your computer and you can turn it off. Delete the folder to start over.
- Spoken lines use speech-dispatcher, on your computer.
- Idle detection only reads "seconds since the last input" from GNOME Shell.

## Development

```bash
make test          # logic tests (dates, API parsing, moods, site matching, calendar mapping, ...); ends with "All good 🎉"
make lint          # ESLint (run `npm ci` once; Node 20.19+)
make snapshot      # render the moods, life grid and sign to out/*.png (no GNOME Shell needed)
make prefs-check   # build the settings window on a throw-away GTK display and check every page
tools/nested.sh    # play every dev scene in an isolated, headless nested GNOME Shell; screenshots go to build/nested/shots
tools/nested.sh board split diary   # or only some scenes ('prefs:Day' opens a settings page)
make build         # copy the extension to build/todopet@trananhtung.github.io/ and compile the schema
make pack          # build the extension zip in build/ (needs the gnome-extensions command from the gnome-shell package)
```

`tools/nested.sh` never touches your real session: it starts its own `gnome-shell --headless` with its own `XDG_*` directories under `build/nested/`, installs the extension there with demo mode on, and never reads your keyring. It takes about 4 minutes for all scenes and fails if the log contains a JavaScript error.

The Mac app's `TODOPET_ANTIC=parade` shortcut is replaced by **Settings › Developer**, which can trigger the parade, the table flip and every celebration on demand.

The sources are in `extension/` (the Mac file each part comes from is named in the comments):

| Path | Role |
|---|---|
| `extension/core/` | Plain logic that imports at most GLib and Gio, unit-tested with `gjs`: dates, mood, calm rules, life, calendar math, stuck tracker, site matching, lines (EN + VI), diary |
| `extension/brain.js`, `extension/brain/` | Sync, mood, reminder rules, focus timer, actions (port of `Brain.swift`) |
| `extension/services/` | Todoist, Claude, calendar (ECal and CalendarServer), GNOME Keyring, idle and typing, focus tracking, speech, sound, JSON store |
| `extension/art/` | The pet, drawn in code with Cairo for every mood |
| `extension/ui/` | Pet, bubble, board, split view, wardrobe, diary, antics, top bar indicator |
| `extension/prefs.js` | The settings window |
| `tests/` | The test suite (`gjs -m tests/run.js`) |

It is plain JavaScript (GJS, ES modules) with no runtime dependencies. GitHub Actions runs lint, tests and snapshots on every push, and builds the extension zip for every `v*` tag.

## License

[MIT](LICENSE)
