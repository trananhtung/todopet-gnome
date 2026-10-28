UUID       := todopet@trananhtung.github.io
BUILD_DIR  := build/$(UUID)
EXT_DIR    ?= $(HOME)/.local/share/gnome-shell/extensions
REF_REPO   := https://github.com/trananhtung/todopet
REF_DIR    := build/ref/todopet
REF_COMMIT := 8573b98

.PHONY: ref build test lint snapshot nested install pack

# Read-only clone of the Swift app, used as the behavior and visual reference.
ref:
	@test -d $(REF_DIR)/.git || git clone $(REF_REPO) $(REF_DIR)
	git -C $(REF_DIR) checkout $(REF_COMMIT)

# Copy the extension sources to build/<uuid>/ and compile the GSettings schema there.
build:
	rm -rf $(BUILD_DIR)
	mkdir -p $(BUILD_DIR)
	cp -R extension/. $(BUILD_DIR)/
	glib-compile-schemas --strict $(BUILD_DIR)/schemas

test: build
	TZ=Asia/Ho_Chi_Minh gjs -m tests/run.js

# tools/ is empty (so untracked by git) until the first tool lands; don't fail on that.
lint:
	@npx eslint --no-error-on-unmatched-pattern extension tests tools

# Renders the art to out/*.png (tools/snapshot.js arrives with the snapshot task).
snapshot:
	@test -f tools/snapshot.js || { echo "tools/snapshot.js does not exist yet" >&2; exit 1; }
	gjs -m tools/snapshot.js out

# Runs the isolated nested GNOME Shell; pass scenes as ARGS="prefs:General ..."
# (tools/nested.sh arrives with the nested-harness task).
nested:
	@test -f tools/nested.sh || { echo "tools/nested.sh does not exist yet" >&2; exit 1; }
	tools/nested.sh $(ARGS)

# Installs into the current user's GNOME Shell extensions directory (override with EXT_DIR=...).
install: build
	mkdir -p $(EXT_DIR)
	rm -rf $(EXT_DIR)/$(UUID)
	cp -R $(BUILD_DIR) $(EXT_DIR)/$(UUID)

pack: build
	gnome-extensions pack $(BUILD_DIR) --force --out-dir=build \
		--extra-source=core --extra-source=services --extra-source=art \
		--extra-source=ui --extra-source=brain.js
