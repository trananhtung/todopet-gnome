#!/usr/bin/env bash
# Runs GNOME Shell headless in an isolated profile under build/nested/, with the extension enabled, plays dev
# scenes and checks the log. Never touches the real session: the extension is installed only into
# build/nested/data, and the settings are written to a dconf database under build/nested/config.
#
#   tools/nested.sh [scene...]     scenes default to $SCENES below; 'prefs:Day' passes an argument to a scene
#
# Exit 0: every scene ran and the log has no errors. Exit 1: the reason is printed.
set -euo pipefail

# Scenes played by default, in this order. A task that adds a scene appends its id here.
SCENES=(smoke)

UUID=todopet@trananhtung.github.io
MONITOR=1600x900
TIMEOUT_SECONDS=180
ERROR_GRACE_SECONDS=20
# What counts as an error in the log: uncaught JS exceptions, anything logged with console.error or logError
# (GNOME Shell turns those into "GNOME Shell-CRITICAL"), failed scenes, and any line that mentions todopet and
# an error. Warnings from mutter, GTK and D-Bus are noise on a headless run and do not count.
ERROR_PATTERN='JS ERROR|GNOME Shell-CRITICAL|TODOPET SCENE ERROR|todopet.*error|error.*todopet'

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
NESTED="$ROOT/build/nested"

die() {
    echo "nested: $*" >&2
    exit 1
}

# rm -rf below must never leave the repo, even if build/ or build/nested is a symlink.
[[ "$(realpath -m "$NESTED")" == "$ROOT/build/nested" ]] || die "refusing to run: $NESTED resolves outside the repository"

for tool in make realpath setsid timeout dbus-run-session dconf gnome-shell glib-compile-schemas; do
    command -v "$tool" > /dev/null || die "'$tool' is not installed"
done

if (($# > 0)); then
    SCENES=("$@")
fi
for scene in "${SCENES[@]}"; do
    [[ "$scene" =~ ^[A-Za-z0-9_.:-]+$ ]] || die "bad scene id '$scene' (letters, digits and _ . : - only)"
done
[[ "$NESTED" != *[\'\\]* ]] || die "the repository path must not contain ' or \\"

# dconf wants GVariant text: ['smoke', 'prefs:Day']
scenes_gvariant="["
for scene in "${SCENES[@]}"; do
    scenes_gvariant+="'$scene', "
done
scenes_gvariant="${scenes_gvariant%, }]"

make --no-print-directory -C "$ROOT" build

rm -rf "$NESTED"
mkdir -p "$NESTED"/{data,config,cache,state,shots}
mkdir -p "$NESTED/data/gnome-shell/extensions"
cp -R "$ROOT/build/$UUID" "$NESTED/data/gnome-shell/extensions/$UUID"

LOG="$NESTED/shell.log"
SHOTS="$NESTED/shots"

echo "nested: scenes ${SCENES[*]} (log: $LOG)"

# setsid gives the shell its own process group, so a run that cannot succeed any more can be stopped whole.
setsid env \
    XDG_DATA_HOME="$NESTED/data" \
    XDG_CONFIG_HOME="$NESTED/config" \
    XDG_CACHE_HOME="$NESTED/cache" \
    XDG_STATE_HOME="$NESTED/state" \
    dbus-run-session -- bash -c '
        set -e
        uuid=$1 shots=$2 scenes=$3 monitor=$4 limit=$5
        dconf write /org/gnome/shell/enabled-extensions "[\"$uuid\"]"
        dconf write /org/gnome/shell/disable-user-extensions false
        dconf write /org/gnome/shell/extensions/todopet/demo-mode true
        dconf write /org/gnome/shell/extensions/todopet/dev-screenshot-dir "\"$shots\""
        dconf write /org/gnome/shell/extensions/todopet/dev-scenes "$scenes"
        exec timeout "$limit" gnome-shell --headless --virtual-monitor "$monitor"
    ' _ "$UUID" "$SHOTS" "$scenes_gvariant" "$MONITOR" "$TIMEOUT_SECONDS" > "$LOG" 2>&1 &
runner=$!
# Ctrl-C (or any exit) must not leave a shell behind in its own process group.
trap 'kill -TERM -- "-$runner" 2> /dev/null || true' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

# The shell ends itself after the last scene. Do not sit out the whole timeout when it never will: stop at
# once when the extension failed to load, and ERROR_GRACE seconds after the first error when the scenes
# still have not finished.
status=0
aborted=""
first_error=""
while kill -0 "$runner" 2> /dev/null; do
    sleep 0.5
    grep -q 'TODOPET SCENES DONE' "$LOG" && continue
    if grep -q "Extension $UUID: " "$LOG"; then
        aborted="the extension failed to load"
    elif grep -qiE "$ERROR_PATTERN" "$LOG"; then
        [[ -n "$first_error" ]] || first_error=$SECONDS
        ((SECONDS - first_error < ERROR_GRACE_SECONDS)) ||
            aborted="the scenes had not finished $ERROR_GRACE_SECONDS s after the first error"
    fi
    if [[ -n "$aborted" ]]; then
        kill -TERM -- "-$runner" 2> /dev/null || true
        break
    fi
done
wait "$runner" || status=$?
# Helper daemons and a shell that is still shutting down need a moment; do not start the next run on top of them.
for _ in {1..50}; do
    kill -0 -- "-$runner" 2> /dev/null || break
    sleep 0.2
done
kill -KILL -- "-$runner" 2> /dev/null || true

reasons=()
if [[ -n "$aborted" ]]; then
    reasons+=("stopped early: $aborted")
elif ((status == 124)); then
    reasons+=("gnome-shell did not exit within $TIMEOUT_SECONDS s")
elif ((status != 0)); then
    reasons+=("gnome-shell exited with status $status")
fi

error_lines=$(grep -niE "$ERROR_PATTERN" "$LOG" || true)
[[ -z "$error_lines" ]] || reasons+=("the log has error lines")
grep -q 'TODOPET SCENES DONE' "$LOG" ||
    reasons+=("the log has no 'TODOPET SCENES DONE' line (the extension did not load, or the scenes did not finish)")

shots=()
while IFS= read -r -d '' png; do
    shots+=("$png")
    [[ -s "$png" ]] || reasons+=("empty screenshot $png")
done < <(find "$SHOTS" -maxdepth 1 -name '*.png' -print0 | sort -z)

if ((${#reasons[@]} > 0)); then
    echo "nested: FAIL" >&2
    for reason in "${reasons[@]}"; do
        echo "  - $reason" >&2
    done
    if [[ -n "$error_lines" ]]; then
        echo "  log lines (first 20, from $LOG):" >&2
        echo "$error_lines" | head -n 20 | sed 's/^/    /' >&2
    else
        echo "  last log lines ($LOG):" >&2
        tail -n 15 "$LOG" | sed 's/^/    /' >&2
    fi
    exit 1
fi

echo "nested: PASS"
for png in "${shots[@]}"; do
    echo "$png"
done
