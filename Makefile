UUID       := todopet@trananhtung.github.io
BUILD_DIR  := build/$(UUID)
PACK_DIR   := build/pack/$(UUID)
EXT_DIR    ?= $(HOME)/.local/share/gnome-shell/extensions
REF_REPO   := https://github.com/trananhtung/todopet
REF_DIR    := build/ref/todopet
REF_COMMIT := 8573b98

.PHONY: ref build test lint snapshot nested prefs-check install pack

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

# Builds the settings window (prefs.js) on a throw-away GTK Broadway display and checks its pages, rows and behavior.
prefs-check: build
	gjs -m tools/prefs-check.js

# Installs into the current user's GNOME Shell extensions directory (override with EXT_DIR=...).
install: build
	mkdir -p $(EXT_DIR)
	rm -rf $(EXT_DIR)/$(UUID)
	cp -R $(BUILD_DIR) $(EXT_DIR)/$(UUID)

# The release zip, made from a copy of the build without the dev-only scene runner (ui/devScenes.js drives a virtual
# pointer and keyboard and ends the shell; only tools/nested.sh plays it, from `make build`).
pack: build
	rm -rf $(PACK_DIR)
	mkdir -p $(dir $(PACK_DIR))
	cp -R $(BUILD_DIR) $(PACK_DIR)
	rm $(PACK_DIR)/ui/devScenes.js
	gnome-extensions pack $(PACK_DIR) --force --out-dir=build \
		--extra-source=core --extra-source=services --extra-source=art \
		--extra-source=ui --extra-source=brain --extra-source=brain.js
