# lark justfile

# ─── The dev/test media toolchain (M7 T0) ───────────────
#
# Vendor first, the machine's own install otherwise. Point the resolver's
# bundle level at `vendor/ffmpeg/` when it is there, so a dev run exercises the
# binaries a `bundled` release actually ships; when it is not, resolution falls
# through to Homebrew and everything still works with `brew install ffmpeg`.
#
# Testing is not distributing, so this level of the search carries no licence
# opinion — `just fetch-ffmpeg` is where the nonfree gate lives.
#
# Empty when absent, which the resolver reads as "unset" (an empty
# `LARK_MEDIA_TOOLS_DIR` is not a broken bundle).

_vendor_ffmpeg := justfile_directory() / "vendor/ffmpeg"
export LARK_MEDIA_TOOLS_DIR := if path_exists(_vendor_ffmpeg / "ffmpeg") == "true" { _vendor_ffmpeg } else { "" }

# ─── Lint & Format ──────────────────────────────────────

[group('lint')]
lint:
    pnpm run lint

[group('lint')]
lint-fix:
    pnpm run lint:fix

[group('lint')]
typecheck:
    pnpm run typecheck

# Dependency direction guards (T3). They rg the SOURCE, not package.json:
# node-linker=hoisted resolves undeclared imports just fine, so a manifest
# check would pass while the import works.

[group('lint')]
core-no-daemon-electron:
    bash scripts/check-core-no-daemon-electron.sh

[group('lint')]
daemon-no-gui-electron:
    bash scripts/check-daemon-no-gui-electron.sh

[group('lint')]
shared-node-free:
    bash scripts/check-shared-node-free.sh

# `@lark/core/portable` is the slice the Android client links (N0a): no Node
# builtins, no better-sqlite3, no reaching back into the rest of core.

[group('lint')]
core-portable:
    bash scripts/check-core-portable.sh

# One device, several libraries, and exactly one place that decides which of
# them a process opens (N7c). Naming `songs.db` anywhere else is how a process
# comes up on the nest root and shows somebody an empty library.

[group('lint')]
workspace-chokepoint:
    bash scripts/check-workspace-chokepoint.sh

# Both Android roots — the N0b platform spike and `apps/mobile` — may reach for
# exactly three of our packages: portable / shared / the skybridge SDK. Third-
# party deps are out of this guard's scope on purpose. Widened from spike-only
# in N2a; same guard, not a new one.

[group('lint')]
mobile-imports:
    bash scripts/check-mobile-imports.sh

# Every self-built Expo module is wired for the native build (N4b-1's cost).
#
# `modules/lark-media` shipped without `android/build.gradle`; autolinking
# skipped it in silence, the apk built and installed, and the first launch died
# with `Cannot find native module 'LarkMedia'`. tsc, biome and the bundle smoke
# all pass on that — the JS face of a native module is in Metro's graph whether
# or not the native half was ever compiled.

[group('lint')]
mobile-native-modules:
    bash scripts/check-mobile-native-modules.sh

# The playback path may not wait on a JS timer — they stop with the display,
# and the teardown between two songs runs with the phone in a pocket (0.1.1 ⑪).
[group('lint')]
mobile-no-js-timers:
    bash scripts/check-mobile-no-js-timers.sh

# The launcher icon is declared and its files are there (0.1.1). Android 0.1.0
# shipped Expo's placeholder, and no offline gate could see it: a missing
# `icon` is not an error — the template has a default and prebuild uses it
# silently. Every other check here is about code; this one is about an asset
# that was simply never named.

[group('lint')]
mobile-icon:
    bash scripts/check-mobile-icon.sh

# The CLI's module graph (M6-21): no daemon / gui / electron, and no STATIC
# import of the core barrel — that one would drag better-sqlite3 into commands
# that never open a database.

[group('lint')]
cli-no-daemon-gui:
    bash scripts/check-cli-no-daemon-gui.sh

# Structured logging hygiene (M2-15): no direct console writes outside the
# terminal-facing lines of cli.ts / boot.ts, and no secret field or whole
# config object handed to a logger call.

[group('lint')]
log-hygiene:
    bash scripts/check-log-hygiene.sh

[group('lint')]
check: lint typecheck core-no-daemon-electron core-portable workspace-chokepoint daemon-no-gui-electron cli-no-daemon-gui shared-node-free mobile-imports mobile-native-modules mobile-no-js-timers mobile-icon mobile-typecheck mobile-bundle-smoke log-hygiene spike-media-test
    @echo "All checks passed."

# ─── Test ───────────────────────────────────────────────

# Every consumer resolves @lark/shared and @lark/core through their `dist`
# (package exports), so a source change is invisible to a test run until the
# dependency is rebuilt — and an M2 daemon test additionally spawns the BUILT
# `dist/testing/boot-child.js` in a child process (M2-17).

[group('test')]
test: ensure-node-abi build-shared build-core build-daemon
    pnpm run test

[group('test')]
test-shared:
    pnpm --filter @lark/shared run test

[group('test')]
test-core: ensure-node-abi build-shared
    pnpm --filter @lark/core run test

[group('test')]
test-daemon: ensure-node-abi build-shared build-core build-daemon
    pnpm --filter @lark/daemon run test

# The CLI links core for its zero-native subpaths (paths / config /
# daemon-control) and, from T3, loads the barrel dynamically for `--direct` —
# so the binding has to be Node-loadable before a test run (M6-16).
[group('test')]
test-cli: ensure-node-abi build-shared build-core
    pnpm --filter @lark/cli run test

# GUI unit tests run under plain Node (the tested main-process modules are
# electron-free by design), so this stays on the Node ABI — no electron-abi
# recipe here (M4-3).
# The multi-device sync e2e (v0.2 T6): three lark libraries against a REAL
# in-process skybridge server. That server is a PRIVATE package, so it is
# resolved at run time — installed package, `LARK_SKYBRIDGE_SERVER`, or the
# sibling checkout's build. `LARK_SYNC_E2E_REQUIRED=1` turns "not found" from a
# skip into a failure, so this recipe cannot be quietly green.
[group('test')]
test-sync-e2e: ensure-node-abi build-shared build-core
    LARK_SYNC_E2E_REQUIRED=1 pnpm --filter @lark/daemon exec vitest run \
        --config vitest.e2e.config.ts

[group('test')]
test-gui: build-shared build-core build-daemon
    pnpm --filter @lark/gui run test

# ─── Build ──────────────────────────────────────────────

[group('build')]
build:
    pnpm run build

[group('build')]
build-shared:
    pnpm --filter @lark/shared run build

[group('build')]
build-core:
    pnpm --filter @lark/core run build

[group('build')]
build-daemon:
    pnpm --filter @lark/daemon run build

# M4: the GUI resolves @lark/core and @lark/daemon dist at runtime (main
# spawns the daemon cli and imports core paths/config), so all three deps
# must be built. Pure build runs no Electron — no ABI recipe (M4-3).
[group('build')]
build-gui: build-shared build-core build-daemon
    pnpm --filter @lark/gui run build

[group('build')]
build-cli: build-shared build-core
    pnpm --filter @lark/cli run build

# ─── Vendored ffmpeg (M7 T0) ────────────────────────────
#
# `bundled` releases carry their own ffmpeg/ffprobe, built here from source.
# Not downloaded from npm: `ffmpeg-static` and `@derhuerst/ffprobe-static` ship
# `--enable-nonfree` binaries, which may not be redistributed under any licence.
# This profile is LGPL and has no external libraries at all (LAME left with the
# mp3 encoder in 0.3.0).
#
# Everything the build needs is in `vendor/ffmpeg.lock.json` (source URLs,
# sha256s, the verbatim configure line). The products land in `vendor/ffmpeg/`,
# which is gitignored — the lock is the artifact, not the binaries.
#
# Verification is what makes this a gate rather than a convenience: the
# configure line must match the lock byte for byte, carry no `--enable-nonfree`,
# cover the frozen capability list, and transcode a real M4A to a real MP3.
# `just package bundled` runs it every time, which is what keeps a stub out of
# a release.
#
# Takes ~4 minutes the first time and is a no-op afterwards. Pass `--force` to
# rebuild, `--verify` to check without ever building.
[group('build')]
fetch-ffmpeg *args: build-shared build-core
    node scripts/vendor-ffmpeg.mjs {{args}}

# ─── ABI toggling (M1-13) ───────────────────────────────
#
# better-sqlite3 ships one compiled .node whose NODE_MODULE_VERSION must match
# the runtime that loads it — host Node 24.13.0 = modules 137, Electron 43.2.0
# = modules 148 — so switching between `just dev` (Electron) and `just test`
# (Node) needs a rebuild.
#
# Both probes instantiate a real Database: merely require()'ing the JS wrapper
# does NOT load the .node binding, so a looser probe would always pass. Each
# side probes truth on disk in its TARGET runtime (owl's "Node load failed →
# assume Electron works" shortcut mistakes a corrupt/missing binding for an
# Electron-ABI one), and every rebuild re-verifies with the same probe — a
# silent rebuild failure is an error, not a skip.

# Guarantee the current better-sqlite3 binding is Node-loadable. Prepended to
# every test / daemon / migrate recipe. No-op (~200ms) when already on Node ABI.
[private]
ensure-node-abi:
    #!/usr/bin/env bash
    set -euo pipefail
    probe() { node -e "const D = require('better-sqlite3'); new D(':memory:').close(); console.log(process.versions.modules);" 2>/dev/null; }
    if v=$(probe); then
        echo "[abi] better-sqlite3 on Node ABI (modules=$v) — skip"
        exit 0
    fi
    echo "[abi] rebuilding better-sqlite3 for Node ABI..."
    # build-release forces node-gyp from source. Plain `pnpm run install` runs
    # `prebuild-install || node-gyp rebuild`, and the prebuilt it grabs targets
    # npm's bundled Node — silently re-breaking the host Node ABI on every
    # `pnpm install` (owl hit this 4x in one session).
    SRC_DIR=$(ls -d node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 2>/dev/null | head -1 || true)
    [ -z "$SRC_DIR" ] && SRC_DIR=node_modules/better-sqlite3   # node-linker=hoisted: no .pnpm dir
    (cd "$SRC_DIR" && pnpm run build-release)
    # Mirror to the hoisted top-level copy when the build happened elsewhere.
    if [ "$SRC_DIR" != node_modules/better-sqlite3 ] && [ -f "$SRC_DIR/build/Release/better_sqlite3.node" ]; then
        cp -p "$SRC_DIR/build/Release/better_sqlite3.node" node_modules/better-sqlite3/build/Release/better_sqlite3.node
    fi
    v=$(probe) || { echo "[abi] ERROR: rebuild finished but Node still cannot load better-sqlite3" >&2; exit 1; }
    echo "[abi] rebuilt for Node ABI (modules=$v)"

# Guarantee the current better-sqlite3 binding is Electron-loadable. Lands in
# M1 but is only wired into recipes in M4 — no Electron entry point loads
# better-sqlite3 before then.
[private]
ensure-electron-abi:
    #!/usr/bin/env bash
    set -euo pipefail
    probe() { ELECTRON_RUN_AS_NODE=1 pnpm exec electron -e "const D = require('better-sqlite3'); new D(':memory:').close(); console.log(process.versions.modules);" 2>/dev/null; }
    if v=$(probe); then
        echo "[abi] better-sqlite3 on Electron ABI (modules=$v) — skip"
        exit 0
    fi
    echo "[abi] rebuilding better-sqlite3 for Electron ABI..."
    # Fixed command contract (M1-13): run from repo root. GUI does not depend on
    # core, so without --module-dir/--which-module electron-rebuild never finds
    # the hoisted top-level better-sqlite3; --version pins Electron explicitly
    # instead of probing; --build-from-source keeps the no-prebuilt principle.
    pnpm exec electron-rebuild --module-dir . --which-module better-sqlite3 --version 43.2.0 --build-from-source
    # macOS >=15 refuses to load freshly built unsigned .node files inside
    # Electron ("Code Signature Invalid" SIGKILL) — ad-hoc sign them + the app.
    if [[ "$(uname)" == "Darwin" ]]; then
        find node_modules -name "*.node" -type f -print0 | xargs -0 -n1 codesign --force --sign - 2>/dev/null || true
        if [[ -d node_modules/electron/dist/Electron.app ]]; then
            codesign --force --deep --sign - node_modules/electron/dist/Electron.app 2>/dev/null || true
        fi
    fi
    v=$(probe) || { echo "[abi] ERROR: rebuild finished but Electron still cannot load better-sqlite3" >&2; exit 1; }
    echo "[abi] rebuilt for Electron ABI (modules=$v)"

# ─── Migration (M1) ─────────────────────────────────────

# ─── Dev ────────────────────────────────────────────────

# Launch the GUI. Since M4 it spawns/adopts the daemon itself; the spawned
# daemon runs inside the Electron binary (ELECTRON_RUN_AS_NODE), so
# better-sqlite3 must be on the Electron ABI (148) first.
[group('dev')]
dev: ensure-electron-abi build-shared build-core build-daemon
    pnpm run dev

# Run the daemon in the foreground on 127.0.0.1:47100.
[group('dev')]
dev-daemon: ensure-node-abi build-shared build-core build-daemon
    node packages/daemon/dist/cli.js daemon

# Stop the running daemon: proves identity over /status before signalling, then
# waits for the process to actually exit. No rebuild — it talks to whatever is
# running (M2-3).
[group('dev')]
stop-daemon:
    node packages/daemon/dist/cli.js stop-daemon

# Launch the BUILT renderer through Electron — the only way to observe the
# production CSP (a bare `build` produces no console to watch). M0-5 two-state
# verification: `just dev` for the dev policy, this for the build policy.
[group('dev')]
gui-preview: ensure-electron-abi build-gui
    pnpm --filter @lark/gui run preview

# The M4 acceptance matrix: real GUI (build product) + real daemon, on a copy
# of the nest. Phase order is the contract — build and copy on the Node ABI,
# THEN switch to the Electron ABI (the script does that itself), start the
# daemon before the GUI so the GUI takes its reuse path. `--keep` leaves the
# copy behind.
[group('dev')]
accept-gui *args: ensure-node-abi build-shared build-core build-daemon build-gui spike-media-fixture
    node scripts/accept-gui.mjs {{args}}

# The M5 acceptance matrix: a real daemon on a copy of the nest, with real
# bilibili traffic. Headless — everything a person has to LOOK at (settings
# page, drag feel, sound) stays in the plan's manual list. `--keep` leaves the
# copy behind. Runs on the Node ABI, so no Electron rebuild.
[group('dev')]
accept-m5 *args: ensure-node-abi build-shared build-core build-daemon
    node scripts/accept-m5.mjs {{args}}

# The M6 acceptance matrix (plan §6): a real daemon on a copy of the nest,
# driving the real `lark` binary — exit codes, stdout/stderr discipline, both
# backends, real bilibili downloads, and the identity states. `--keep` leaves
# the copy behind. Node ABI: backupNest and the daemon both load
# better-sqlite3, and no Electron is involved.
[group('accept')]
accept-cli *args: ensure-node-abi build-shared build-core build-daemon build-cli
    node scripts/accept-cli.mjs {{args}}

# The v0.2 sync acceptance matrix (plan §6): a REAL skybridge server, TWO real
# daemons on two nests (a copy of the library through the CLI, and a second one
# over HTTP), and the real GUI. It starts on the Node ABI, switches to Electron
# for the window, and switches back for `sync unbind` — so it leaves the ABI
# where it found it. `--keep` keeps the two nests and the server directory;
# `--skip-e2e` skips the suites when they have just been run.
#
# The server is resolved at run time (sibling checkout, LARK_SKYBRIDGE_SERVER_BIN,
# or an installed @orpheus-aviary/skybridge-server) and its absence FAILS: this
# recipe must never be quietly green. The soak that needs a real network is a
# person's job — docs/plans/2026-08-12-v0.2-soak-checklist.md.
[group('accept')]
accept-sync *args: ensure-node-abi build-shared build-core build-daemon build-cli build-gui
    node scripts/accept-sync.mjs {{args}}

# Copy the nest to a throwaway directory (M4-14⑧). Refuses while a daemon is
# running: an online backup freezes the database only, so songs/ and the config
# would otherwise come from a different moment. Runs on the Node ABI.
[group('dev')]
backup-nest *target: ensure-node-abi build-core
    node packages/core/scripts/backup-nest.mjs {{target}}

# Run the user-facing CLI from dist, e.g. `just cli status --json`.
# This is the workspace build; the published one is `just build-cli-dist`.
[group('dev')]
cli *args: build-cli
    node apps/cli/dist/index.js {{args}}

# ─── CLI release artifact (M7 T3) ───────────────────────

# Bundle the publishable CLI into `apps/cli/dist-publish/` and generate its
# package.json. Separate from `build-cli` (tsc → `dist/`) so the workspace
# build and the published one can never be confused for one another.
[group('build')]
build-cli-dist: build-shared build-core
    #!/usr/bin/env bash
    set -euo pipefail
    cd apps/cli && pnpm exec tsup

# Assert the published bundle behaves, on BOTH ABIs (M7-5, criterion 6).
#
# The point is the M6-21 boundary, which the dependency guard cannot see
# because it greps source and this is a bundler's output. So the checks are
# behavioural: under a runtime that CANNOT load better-sqlite3, `--help` and
# `status` must still work, because neither ever intended to open a database.
#
# Run it with no daemon listening — `status` answering exit 4 is the criterion.
[group('accept')]
cli-smoke: build-cli-dist
    #!/usr/bin/env bash
    set -euo pipefail
    ENTRY="apps/cli/dist-publish/index.js"
    NEST="$(mktemp -d /tmp/lark-cli-smoke-XXXXXX)"
    trap 'rm -rf "$NEST"' EXIT
    fail() { echo "  ✗ $1" >&2; exit 1; }

    run() {  # run <runtime> <args...>  → sets OUT and CODE
        set +e
        if [ "$1" = electron ]; then
            OUT=$(ELECTRON_RUN_AS_NODE=1 LARK_NEST_DIR="$NEST" \
                node_modules/electron/dist/Electron.app/Contents/MacOS/Electron "${@:2}" 2>&1)
        else
            OUT=$(LARK_NEST_DIR="$NEST" node "${@:2}" 2>&1)
        fi
        CODE=$?
        set -e
    }

    for runtime in node electron; do
        echo "— $runtime"
        run "$runtime" "$ENTRY" --help
        [ "$CODE" -eq 0 ] || fail "--help exited $CODE"
        echo "  ✓ --help exit 0"

        run "$runtime" "$ENTRY" status --json
        [ "$CODE" -eq 4 ] || fail "status with no daemon exited $CODE, expected 4"
        echo "$OUT" | grep -q '"error_code":"DAEMON_UNAVAILABLE"' \
            || fail "status did not report DAEMON_UNAVAILABLE: $OUT"
        echo "  ✓ status with no daemon → exit 4 + DAEMON_UNAVAILABLE"
    done

    # And the boundary the other way round: `--direct` DOES need the binding,
    # so on the runtime whose ABI it was not built for it must say so —
    # ABI_MISMATCH (exit 3), not a dlopen stack under a generic failure.
    node -e 'const D=require("better-sqlite3"); new D(":memory:").close()' >/dev/null 2>&1 \
        && WRONG=electron || WRONG=node
    node apps/cli/dist-publish/index.js playlist create smoke --direct --json >/dev/null 2>&1 || true
    run "$WRONG" "$ENTRY" songs list --direct --json
    if [ "$CODE" -eq 3 ] && echo "$OUT" | grep -q '"error_code":"ABI_MISMATCH"'; then
        echo "  ✓ --direct on the wrong ABI → exit 3 + ABI_MISMATCH"
    else
        echo "  ! --direct on the wrong ABI: exit $CODE — needs a library to exist first"
        echo "    (the full criterion runs in accept-pack, against the packaged app)"
    fi
    echo "cli-smoke passed."

# Produce the tarball that gets published, at a fixed path (M7-19). The release
# gate verifies THIS file and `npm publish` is handed THIS file — no rebuild in
# between, so what was accepted is what ships.
[group('build')]
pack-cli: build-cli-dist
    #!/usr/bin/env bash
    set -euo pipefail
    cd apps/cli/dist-publish
    npm pack --pack-destination .. >/dev/null
    cd .. && ls -1 orpheus-aviary-lark-cli-*.tgz

# ─── Packaging (M7 T1) ──────────────────────────────────
#
# `just package` / `just package system` — a POSITIONAL parameter, not
# `mode=system`: just parses a `name=value` argument as a variable override
# only BEFORE the recipe name, so `just package mode=system` looks for a second
# recipe called `mode=system` and reports "does not contain recipe" (1.46.0,
# measured).
#
# The two modes differ in exactly one thing — whether ffmpeg rides along — and
# that difference is carried end to end: its own output directory, its own
# NOTICE, its own install instructions. A `system` build tells the user to run
# `brew install ffmpeg`; a `bundled` build carries a vendored LGPL copy whose
# provenance is re-verified against the lock on every single run, which is what
# keeps a stub out of a release.

[group('package')]
package mode="bundled": ensure-electron-abi
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{mode}}" in
        bundled) just fetch-ffmpeg --verify ;;
        system)  ;;
        *) echo "unknown mode '{{mode}}' — use: just package [bundled|system]" >&2; exit 2 ;;
    esac
    # Clean only THIS mode's directory: the other mode's artifact is somebody
    # else's release and must not disappear because of a build here.
    rm -rf "packages/gui/release/{{mode}}"
    cd packages/gui && LARK_FFMPEG_MODE={{mode}} pnpm run package

# The mechanism-only build (M7-16): a stub ffmpeg, so extraResources copying,
# the env injection and the resolver's bundle level can be exercised without a
# four-minute toolchain build. Lands in `release/fixture/` and is NEVER a
# release candidate — the stub cannot pass `fetch-ffmpeg`'s verification, and
# `just package bundled` runs that first.
[group('package')]
package-fixture: ensure-electron-abi
    #!/usr/bin/env bash
    set -euo pipefail
    rm -rf packages/gui/release/fixture
    cd packages/gui && LARK_FFMPEG_MODE=fixture pnpm run package

# Undo `electron-builder install-app-deps`, which rebuilds better-sqlite3 for
# the packaged Electron and leaves the workspace on that ABI. Uses lark's
# build-release path rather than a prebuilt (owl's `unpackage` grabs a binding
# for npm's bundled Node and re-breaks the host).
[group('package')]
unpackage: ensure-node-abi
    @echo "workspace is back on the Node ABI."

# ─── Media spike (M0 T4/T5) ─────────────────────────────
#
# `spikes/media-protocol/` validates lark-media:// before M4 ports it into the
# GUI. It is kept (not deleted after M0) as the porting reference and as the
# regression rig for Electron upgrades — hence two anti-rot layers below.

# Real fixture: 30 min of AAC in mp4, so the throttled stream always has an
# unbuffered far end. It is m4a and not mp3 because the spike must validate the
# protocol lark actually speaks — canonical audio has been m4a since 0.3.0, and
# an mp3 fixture would have the harness assert a Content-Type nothing serves
# (§4-j). `+faststart` for the same reason the pipeline uses it: with `moov` at
# the end, a media element reading over HTTP cannot even report a duration.
# Idempotent; the file is gitignored. Needs system ffmpeg.
[group('spike')]
spike-media-fixture:
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p spikes/media-protocol/fixtures
    if [ -f spikes/media-protocol/fixtures/fixture.m4a ]; then
        echo "[fixture] already present — skip"
    else
        ffmpeg -v error -f lavfi -i "sine=frequency=440:duration=1800" \
            -c:a aac -b:a 192k -ac 2 -movflags +faststart \
            spikes/media-protocol/fixtures/fixture.m4a
        echo "[fixture] generated"
    fi

# Terminal 1 — the mock daemon (throttled, real fixture). Ctrl-C rotates the
# token; that is the criterion-6 trigger.
[group('spike')]
spike-media-server: spike-media-fixture
    node spikes/media-protocol/server.mjs

# Terminal 2 — the Electron app. Separate recipe on purpose: restarting the
# server must not take the app down with it.
[group('spike')]
spike-media-app:
    pnpm --filter @lark/spike-media-protocol exec electron main.mjs

# Fast anti-rot layer — no ffmpeg, no display. Part of `just check`.
[group('spike')]
spike-media-test:
    #!/usr/bin/env bash
    set -euo pipefail
    for f in spikes/media-protocol/*.mjs; do node --check "$f"; done
    node spikes/media-protocol/harness.mjs

# Full layer — real fixture, throttling, and `electron main.mjs --smoke` against
# the live server. Run at M0 acceptance, on protocol changes, and on EVERY
# Electron major upgrade (Range/seek behaviour rides on Chromium).
[group('spike')]
spike-media-check: spike-media-fixture
    node spikes/media-protocol/harness.mjs --full

# ─── Android (apps/mobile + the N0b spike) ──────────────
#
# JAVA_HOME is pinned HERE and not exported globally: this machine's default
# JDK is 25, which the rest of the repo is happy with and which React Native's
# Gradle line is not. Every recipe that shells into Gradle sets it itself.
#
# `android/` is generated (CNG) and untracked in both roots — `prebuild` is
# cheap and reproducible, and anything that can only be expressed by
# hand-editing it belongs in a config plugin instead.

_jdk17 := `/usr/libexec/java_home -v 17 2>/dev/null || echo ""`
# The SDK location is pinned the same way JAVA_HOME is, and for the same
# reason: it lives in the user's interactive shell profile, so a recipe that
# only inherits it works by hand and fails from anything else with
# "spawn adb ENOENT" several minutes into a Gradle build.
_android_home := env_var_or_default("ANDROID_HOME", "/opt/homebrew/share/android-commandlinetools")
_adb := _android_home / "platform-tools/adb"
_mobile := justfile_directory() / "apps/mobile"
# lark's own signing key (D14 / N0b-5b). The DIRECTORY travels; the password
# never does — Gradle reads its 0600 file at signing time, which is what
# `android-keystore/README.md` says every build does (decision g). Overridable
# so the drill can point at a copy.
_keystore_dir := env_var_or_default("LARK_ANDROID_KEYSTORE_DIR", justfile_directory() / "../android-keystore")
# Public fingerprint of that key, recorded at generation (N0 subplan §9). Not a
# secret: it is what a Play "limited distribution" registration would carry.
_release_cert_sha256 := "38:54:4C:9F:69:A3:9E:13:1E:F8:79:C9:EE:C9:61:21:E0:AA:10:96:AD:94:04:7B:14:1F:BD:5E:EC:BA:F6:3D"

# ─── The product app (Phase B N2) ───────────────────────

# Types only — `apps/mobile` is deliberately NOT in the root tsconfig
# references (`tsc -b` would drag React Native's types into every desktop
# build), so without this line its types are never checked at all. In `check`
# for that reason; the spike's equivalent is not, because a spike may rot.
[group('mobile')]
mobile-typecheck: build-shared build-core
    pnpm --filter @lark/mobile exec tsc --noEmit

# Does portable RESOLVE under Metro, in BOTH roots? The rg guard reads source;
# this reads the graph Metro actually builds, which is the only thing that
# answers for a dependency's own imports and for export maps (N1a criterion 19,
# widened to apps/mobile in N2a criterion 4).
#
# Two bundles, because with `disableHierarchicalLookup` a dependency declared
# by one root is not resolvable from the other — one going green says nothing
# about the other. `build-core` first is load bearing: both consume core
# through `dist`, so a source change is invisible to Metro until it is compiled
# (N0b-5b).
[group('mobile')]
mobile-bundle-smoke: build-shared build-core
    node scripts/check-portable-bundles.mjs

# The other direction of decision o⑥: with the flag on, the acceptance modules
# MUST be in the graph. A fork that silently stopped forking would leave the
# production assertion green forever while every acceptance run measured the
# product — this is the only thing that notices.
[group('mobile')]
mobile-acceptance-smoke: build-shared build-core
    LARK_ACCEPTANCE=1 node scripts/check-portable-bundles.mjs apps/mobile

# Regenerate `apps/mobile/android/` from app.config.ts. Safe at any time; the
# only sanctioned way that directory comes into existence.
[group('mobile')]
mobile-prebuild:
    JAVA_HOME="{{_jdk17}}" ANDROID_HOME="{{_android_home}}" pnpm --filter @lark/mobile exec expo prebuild --platform android --clean

# Build + install the dev client, then serve Metro. Debug variant: development
# only. Every NUMERIC criterion (N0 §3.2a) uses `mobile-android-release`.
[group('mobile')]
mobile-android: build-shared build-core
    JAVA_HOME="{{_jdk17}}" ANDROID_HOME="{{_android_home}}" pnpm --filter @lark/mobile exec expo run:android

# The build every NUMERIC criterion is measured on. `--no-bundler` because a
# release APK carries its own bytecode.
#
# The `rm` is not tidiness. Gradle's bundle task hashes the app's own inputs,
# and `@lark/core`'s dist is reached through a workspace symlink OUTSIDE them:
# rebuilding core leaves the task up to date and the APK carries YESTERDAY'S
# core (MEASURED, N0b-5b). Deleting the bundle is what makes "build" mean it.
#
# SIGNED WITH LARK'S KEY since N6d, and VERIFIED right after — not as a
# ceremony: `plugins/with-release-signing.js` falls back to the debug key when
# the property is absent (it has to, or every debug build and every fresh clone
# would break), so the only thing that can tell a signed APK from Expo's
# default is the artifact itself.
[group('mobile')]
mobile-android-release: build-shared build-core
    rm -rf {{_mobile}}/android/app/build/generated/assets/react/release
    JAVA_HOME="{{_jdk17}}" ANDROID_HOME="{{_android_home}}" ORG_GRADLE_PROJECT_LARK_KEYSTORE_DIR="{{_keystore_dir}}" pnpm --filter @lark/mobile exec expo run:android --variant release --no-bundler
    just mobile-verify-apk

# The SAME release build, without a phone attached (release day).
#
# `expo run:android` refuses to build when no device is connected — it is a
# run command that happens to build. A release needs the artifact, not the
# install, and requiring a plugged-in phone to CUT a release is how a release
# ends up depending on which desk somebody is sitting at.
#
# Same three things the recipe above does and in the same order: delete the
# bundle (the N0b-5b trap — Gradle cannot see that `@lark/core`'s dist moved),
# build with the release keystore property present, then verify the signature
# on the artifact itself.
[group('mobile')]
mobile-android-apk: build-shared build-core
    rm -rf {{_mobile}}/android/app/build/generated/assets/react/release
    cd {{_mobile}}/android && JAVA_HOME="{{_jdk17}}" ANDROID_HOME="{{_android_home}}" ORG_GRADLE_PROJECT_LARK_KEYSTORE_DIR="{{_keystore_dir}}" ./gradlew assembleRelease
    just mobile-verify-apk

# The acceptance artifact (decision o②): the SAME package and signing as the
# product, built with Metro's root redirected to `src/acceptance/`. Not a flag
# on top of the release build — a second artifact, so the two cannot be
# installed side by side and D16's criteria are measured on the package the
# user actually gets.
#
# The `rm` matters more here than anywhere: switching LARK_ACCEPTANCE does not
# change any input Gradle hashes, so without it the APK carries whichever
# bundle was built last (the N0b-5b trap, one flag over).
[group('mobile')]
mobile-acceptance-release: build-shared build-core
    rm -rf {{_mobile}}/android/app/build/generated/assets/react/release
    JAVA_HOME="{{_jdk17}}" ANDROID_HOME="{{_android_home}}" LARK_ACCEPTANCE=1 ORG_GRADLE_PROJECT_LARK_KEYSTORE_DIR="{{_keystore_dir}}" pnpm --filter @lark/mobile exec expo run:android --variant release --no-bundler
    just mobile-verify-apk

# Criterion 95. Reads the BUILT apk and refuses anything but lark's own
# certificate — the Android debug key included, which is what an unsigned
# release looks like and is otherwise indistinguishable from a good one.
#
# `apksigner` comes from the build tools; the version is pinned by
# `expo-build-properties` (36.0.0) rather than by whatever is first on PATH.
#
# It also reads the version the apk actually CARRIES and compares it with
# `app.config.ts`. MEASURED on 0.1.1's release day: `android/` is prebuild
# output and gitignored, `mobile-android-release` does not re-run prebuild, so
# bumping the config and building installed an apk that still said 0.1.0 /
# versionCode 1. Nothing else can notice — the build is legitimate, the
# signature is right, and no test reads the manifest.
[group('mobile')]
mobile-verify-apk apk=(_mobile / "android/app/build/outputs/apk/release/app-release.apk"):
    #!/usr/bin/env bash
    set -euo pipefail
    apksigner="$(ls -d {{_android_home}}/build-tools/*/apksigner | sort -V | tail -1)"
    printed="$("$apksigner" verify --print-certs "{{apk}}")"
    # Every signer, deduped: one apk signed by two keys would otherwise pass on
    # whichever line came first.
    actual="$(echo "$printed" | grep -i 'certificate SHA-256 digest' | awk '{print $NF}' | sort -u | tr '\n' ' ' | sed 's/ $//')"
    expected="$(echo '{{_release_cert_sha256}}' | tr -d ':' | tr '[:upper:]' '[:lower:]')"
    if [ "$actual" != "$expected" ]; then
        echo "✗ {{apk}} is signed with the WRONG certificate" >&2
        echo "    expected $expected" >&2
        echo "    actual   $actual" >&2
        echo "  (Android's debug key is the usual answer — check that ORG_GRADLE_PROJECT_LARK_KEYSTORE_DIR reached Gradle)" >&2
        exit 1
    fi
    echo "✓ signed with lark's release key ($actual)"
    aapt2="$(ls -d {{_android_home}}/build-tools/*/aapt2 | sort -V | tail -1)"
    badging="$("$aapt2" dump badging "{{apk}}")"
    apk_name="$(echo "$badging" | sed -n "1s/.*versionName='\([^']*\)'.*/\1/p")"
    apk_code="$(echo "$badging" | sed -n "1s/.*versionCode='\([^']*\)'.*/\1/p")"
    want_name="$(sed -n "s/^  version: '\(.*\)',$/\1/p" {{_mobile}}/app.config.ts)"
    want_code="$(sed -n "s/^    versionCode: \([0-9]*\),$/\1/p" {{_mobile}}/app.config.ts)"
    if [ -z "$want_name" ] || [ -z "$want_code" ]; then
        echo "✗ could not read version / versionCode out of app.config.ts" >&2
        exit 1
    fi
    if [ "$apk_name" != "$want_name" ] || [ "$apk_code" != "$want_code" ]; then
        echo "✗ {{apk}} carries $apk_name (versionCode $apk_code)" >&2
        echo "    app.config.ts says $want_name (versionCode $want_code)" >&2
        echo "  (android/ is prebuild OUTPUT: run \`just mobile-prebuild\` after a version bump, then rebuild)" >&2
        exit 1
    fi
    echo "✓ apk carries $apk_name (versionCode $apk_code), matching app.config.ts"

# Criterion 10①, and the only place it can be answered: two real threads and a
# barrier, in `modules/lark-fs/android/src/androidTest/`. A JS-side poll loop
# cannot see the window — same thread, so it only runs after the move returns,
# and a delete-then-rename implementation would pass exactly as convincingly.
#
# Needs the device. The counter-test asserts it SAW the window; point it at the
# atomic implementation and it fails, which is what stops the atomic case from
# being vacuous (MEASURED).
[group('mobile')]
mobile-fs-instrumentation:
    cd {{_mobile}}/android && JAVA_HOME="{{_jdk17}}" ANDROID_HOME="{{_android_home}}" ./gradlew :lark-fs:connectedAndroidTest

# The spike's driver and backup auditor, pointed at the product app. Same
# scripts, two targets (decision d keeps the spike alive and its host-side
# tooling with it); the package is echoed in their output so a run cannot
# quietly be about the other app.
[group('mobile')]
mobile-drive *ARGS:
    LARK_PACKAGE=com.orpheusaviary.lark LARK_APP_ROOT="{{_mobile}}" node spikes/mobile-foundation/scripts/drive.mjs {{ARGS}}

# Criteria 14 and 15, through the PRODUCT's UI (N2f).
#
# Needs the production artifact installed and the fixture already imported by
# the acceptance one — the script says so if either is missing. The full dance,
# because the two artifacts cannot be installed at once (decision o③):
#
#     just backup-nest /tmp/lark-fixture
#     just mobile-acceptance-release      # tap "Import pushed fixture" once to
#     just mobile-push-fixture /tmp/lark-fixture   #   create the directory
#     # tap "Import pushed fixture" again
#     just mobile-android-release
#     just mobile-accept-library /tmp/lark-fixture
[group('mobile')]
mobile-accept-library NEST:
    node spikes/mobile-foundation/scripts/accept-library.mjs {{NEST}}

# The two probe tracks + the ffprobe reading criterion 8 measures against (N4b).
#
# The phone has no ffprobe, and a device that computed its own expectation would
# be grading itself — so the number is produced here, by core's real
# `probeAudio`, and travels with the bytes. The landing contract's `valid`
# scenario needs the same files: only a file MMR can really decode produces a
# duration greater than zero.
#
#     just mobile-acceptance-release
#     acceptance artifact → "Import pushed fixture"   (makes lark-fixture/)
#     just mobile-push-audio-fixtures
#     acceptance artifact → "Run landing scenarios"
[group('mobile')]
mobile-push-audio-fixtures: build-shared build-core
    node spikes/mobile-foundation/scripts/push-audio-fixtures.mjs

# Criterion 17 (N3d): how many times ONE song's lyrics should reach the system.
#
# Computed here, out of the same library and the same `lyrics.lrc` that were
# pushed to the phone, with the same `nowPlayingTitle` the app calls — so the
# device is only asked to reproduce a number, never to grade itself. Play the
# song through without touching anything and read 设置 → 蓝牙歌词发送（本首）.
#
#     just mobile-now-playing-expect /tmp/lark-fixture <歌名的一部分>
[group('mobile')]
mobile-now-playing-expect NEST SONG:
    node spikes/mobile-foundation/scripts/now-playing-expect.mjs {{NEST}} {{SONG}}

# Criterion 3b (N3a): the audio half of the merged manifest. Reads the BUILT
# apk for the same reason the backup audit does — `app.config.ts` is what we
# meant, the manifest is what Android will read, and a plugin default that
# comes back on an SDK upgrade only shows up in the second one.
[group('mobile')]
mobile-audio-audit *ARGS:
    LARK_APP_ROOT="{{_mobile}}" node {{_mobile}}/scripts/audio-manifest-audit.mjs {{ARGS}}

[group('mobile')]
mobile-backup-audit *ARGS:
    LARK_PACKAGE=com.orpheusaviary.lark LARK_APP_ROOT="{{_mobile}}" node spikes/mobile-foundation/scripts/backup-audit.mjs {{ARGS}}

# Push a real desktop library to the phone for criterion 14 (decision o④).
#
# NEST is a `just backup-nest` copy, never the live one.
#
# THE APP MAKES THE DIRECTORY, NOT THIS (measured, N2f). `adb push` to a path
# that does not exist yet creates the intermediate directories as `shell`, and
# the app is then denied at `Android/data` — right string, unreadable place. So
# the destination must already be there, made by `getExternalFilesDir` inside
# the app, and this refuses rather than recreating it wrong.
#
#     just backup-nest /tmp/lark-fixture
#     acceptance artifact → "Import pushed fixture"   (makes the directory)
#     just mobile-push-fixture /tmp/lark-fixture
#     acceptance artifact → "Import pushed fixture"   (imports it)
[group('mobile')]
mobile-push-fixture NEST:
    #!/usr/bin/env bash
    set -euo pipefail
    src="{{NEST}}/lark"
    dst="/sdcard/Android/data/com.orpheusaviary.lark/files/lark-fixture"
    adb="{{_android_home}}/platform-tools/adb"
    test -f "$src/songs.db" || { echo "no songs.db under $src"; exit 1; }
    # A -wal beside it means the copy was not checkpointed; pushing the main
    # file alone would silently drop whatever is still in the log.
    for sidecar in -wal -shm; do
        test ! -e "$src/songs.db$sidecar" || { echo "$src carries a songs.db$sidecar — use backup-nest"; exit 1; }
    done
    "$adb" shell test -d "$dst" || {
        echo "$dst is not there yet."
        echo "tap \"Import pushed fixture\" once — the app has to create it, or nothing can read it."
        exit 1
    }
    "$adb" shell rm -rf "$dst/songs" "$dst/songs.db"
    "$adb" push "$src/songs.db" "$dst/songs.db"
    test ! -d "$src/songs" || "$adb" push "$src/songs" "$dst/songs"
    "$adb" shell du -sh "$dst"

# ─── Mobile foundation spike (Phase B N0b) ──────────────

# Types only — the spike is deliberately NOT in the root tsconfig references
# (`tsc -b` would drag React Native's types into every desktop build).
[group('spike')]
spike-mobile-typecheck: build-shared build-core
    pnpm --filter @lark/spike-mobile-foundation exec tsc --noEmit

# Regenerate `android/` from app.config.ts. Safe to run at any time; it is the
# only sanctioned way that directory comes into existence.
[group('spike')]
spike-mobile-prebuild:
    JAVA_HOME="{{_jdk17}}" ANDROID_HOME="{{_android_home}}" pnpm --filter @lark/spike-mobile-foundation exec expo prebuild --platform android --clean

# Build + install the dev client on the connected device, then serve Metro.
# Debug variant: development only. Every NUMERIC criterion (§3.2a) uses
# `spike-mobile-android-release` instead — a debug build measures the debugger.
[group('spike')]
spike-mobile-android: build-shared build-core
    JAVA_HOME="{{_jdk17}}" ANDROID_HOME="{{_android_home}}" pnpm --filter @lark/spike-mobile-foundation exec expo run:android

# The build every NUMERIC criterion is measured on (§3.2a). `--no-bundler`
# because a release APK carries its own bytecode: starting a dev server would
# only fight the one a debug session may already have on 8081, and a release
# measurement must not be able to attach to it by accident.
#
# The `rm` is not tidiness. Gradle's bundle task hashes the app's own inputs,
# and `@lark/core`'s dist is reached through a workspace symlink OUTSIDE them:
# rebuilding core (which `build-core` just did) leaves the task up to date and
# the APK carries YESTERDAY'S core (MEASURED, N0b-5b — a contract case fixed on
# the desktop kept failing on the phone, with the old assertion text still in
# the panel). Deleting the bundle is what makes "build" mean it.
[group('spike')]
spike-mobile-android-release: build-shared build-core
    rm -rf spikes/mobile-foundation/android/app/build/generated/assets/react/release
    JAVA_HOME="{{_jdk17}}" ANDROID_HOME="{{_android_home}}" pnpm --filter @lark/spike-mobile-foundation exec expo run:android --variant release --no-bundler

# The desktop peer for criterion 21's fetch rows, and the sink the panels POST
# their numbers to (a release build has no Metro to print them to). `adb
# reverse` is what makes `http://localhost:8099` on the phone arrive here.
[group('spike')]
spike-mobile-probe-host:
    {{_adb}} reverse tcp:8099 tcp:8099
    node spikes/mobile-foundation/scripts/probe-host.mjs

# Recompute the expected digests / byte lengths / base64 decodes that the phone
# is checked against, using node:crypto and Buffer — the implementations core
# itself calls. Committed output; run it when a sample changes.
[group('spike')]
spike-mobile-fixtures:
    node spikes/mobile-foundation/scripts/make-desktop-fixtures.mjs

# N0b-4's fixtures: the WBI three-piece, `openAudio()`'s real header set and the
# two audio tracks, produced by the REAL core client (criteria 19/23 — the spike
# is not allowed to compute any of it). Output is untracked and SHORT-LIVED:
# bilibili's stream URLs expire in about two hours, so re-run this before a
# device session rather than trusting yesterday's file.
#
#   just spike-mobile-fixtures-network             # metadata only, seconds
#   just spike-mobile-fixtures-network --audio     # + download ~55MB and adb push
[group('spike')]
spike-mobile-fixtures-network *ARGS: build-shared build-core
    node spikes/mobile-foundation/scripts/make-network-fixtures.mjs {{ARGS}}

# A real skybridge server for criterion 22, on a throwaway database with a fresh
# account. Resolves the private server package at run time (install →
# LARK_SKYBRIDGE_SERVER → sibling checkout) and sets up its own `adb reverse`.
[group('spike')]
spike-mobile-sync-host:
    node spikes/mobile-foundation/scripts/sync-host.mjs

# Criterion 26's backup-exclusion half, in three layers: the BUILT APK's merged
# manifest, the two rule files read out of its compiled resources, and the
# backup manager's own answer (`bmgr`, with a control package that does allow
# backup so that a refusal means something).
[group('spike')]
spike-mobile-backup-audit *ARGS:
    node spikes/mobile-foundation/scripts/backup-audit.mjs {{ARGS}}

# ─── Live probes (M3) ───────────────────────────────────

# Hit the real api.bilibili.com and assert the SHAPE every download path
# depends on. Deliberately outside `just check` / CI — the network is not a
# unit test. Run it on the first day of a bilibili-facing change and at
# acceptance; the fake upstream in `@lark/core/testing` is built from its
# output, so a drift shows up here first.
#
# Ids are discovered from one keyword search; pin any of them when a specific
# case matters:
#   PROBE_KEYWORD PROBE_BVID PROBE_MID PROBE_SEASON_ID PROBE_MEDIA_ID
[group('probe')]
probe-bilibili:
    node scripts/probe-bilibili.mjs

# ─── Clean ──────────────────────────────────────────────

[group('clean')]
clean:
    rm -rf packages/*/dist apps/*/dist apps/*/dist-publish packages/gui/out
    rm -rf packages/*/*.tsbuildinfo apps/*/*.tsbuildinfo
    # Packaging output. `vendor/ffmpeg` is deliberately NOT here: it costs four
    # minutes to rebuild and `fetch-ffmpeg` re-verifies it anyway.
    rm -rf packages/gui/release apps/cli/*.tgz

[group('clean')]
clean-all: clean
    rm -rf node_modules packages/*/node_modules apps/*/node_modules spikes/*/node_modules

# ─── Setup ──────────────────────────────────────────────

[group('setup')]
install:
    pnpm install

[group('setup')]
reinstall: clean-all install

# The M7 acceptance matrix (plan §3.5), against the artifacts about to be
# published. THREE positional parameters, all required — the mode decides what
# the app is even supposed to contain, and the two paths are the exact files
# the release gate will upload and publish.
#
#   just accept-pack bundled packages/gui/release/bundled/Lark-0.2.0-arm64.dmg \
#                            apps/cli/orpheus-aviary-lark-cli-0.2.0.tgz
#
# The dmg is mounted READ-ONLY and everything app-shaped is checked inside that
# mount — never `release/<mode>/mac-arm64/Lark.app`. Its sha256 is taken before
# and after, so "we verified the thing we are shipping" is a fact rather than a
# habit. Every runtime UNDER TEST brings its own binding, but the harness is not
# under test: it imports core to copy the nest, and it runs on Node — while the
# step right before it (`just package`) leaves the workspace on the Electron
# ABI. Hence `ensure-node-abi`, which is a no-op whenever it is already right.
[group('accept')]
accept-pack mode dmg tgz *args: ensure-node-abi build-shared build-core
    node scripts/accept-pack.mjs {{mode}} {{dmg}} {{tgz}} {{args}}
