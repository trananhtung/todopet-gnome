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

lint:
	@npx eslint extension tests tools

# Renders the art sheets to out/*.png.
snapshot:
	gjs -m tools/snapshot.js out

# Runs the isolated nested GNOME Shell and plays the dev scenes (all of them, or ARGS="prefs:General ...").
nested:
	tools/nested.sh $(ARGS)

# Installs into the current user's GNOME Shell extensions directory (override with EXT_DIR=...).
install: build
	mkdir -p $(EXT_DIR)
	rm -rf $(EXT_DIR)/$(UUID)
	cp -R $(BUILD_DIR) $(EXT_DIR)/$(UUID)

pack: build
	gnome-extensions pack $(BUILD_DIR) --force --out-dir=build \
		--extra-source=core --extra-source=services --extra-source=art \
		--extra-source=ui --extra-source=brain --extra-source=brain.js
