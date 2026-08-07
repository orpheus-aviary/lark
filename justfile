# lark justfile

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
check: lint typecheck core-no-daemon-electron daemon-no-gui-electron cli-no-daemon-gui shared-node-free log-hygiene spike-media-test
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

# One-shot Go songs.db migration. Interactive y/N. M1 never migrates the real
# library — point LARK_NEST_DIR at a copied nest for the acceptance run; the
# real migration date is the user's call once the GUI is usable.
[group('migration')]
migrate-go: ensure-node-abi build-core
    node packages/core/scripts/migrate-go.mjs

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

# Copy the nest to a throwaway directory (M4-14⑧). Refuses while a daemon is
# running: an online backup freezes the database only, so songs/ and the config
# would otherwise come from a different moment. Runs on the Node ABI.
[group('dev')]
backup-nest *target: ensure-node-abi build-core
    node packages/core/scripts/backup-nest.mjs {{target}}

# Run the user-facing CLI from dist, e.g. `just cli status --json`.
# No global `lark` bin exists until M6/M7.
[group('dev')]
cli *args: build-cli
    node apps/cli/dist/index.js {{args}}

# ─── Media spike (M0 T4/T5) ─────────────────────────────
#
# `spikes/media-protocol/` validates lark-media:// before M4 ports it into the
# GUI. It is kept (not deleted after M0) as the porting reference and as the
# regression rig for Electron upgrades — hence two anti-rot layers below.

# Real fixture: 320kbps CBR / 30 min, so the throttled stream always has an
# unbuffered far end. Idempotent; the file is gitignored. Needs system ffmpeg.
[group('spike')]
spike-media-fixture:
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p spikes/media-protocol/fixtures
    if [ -f spikes/media-protocol/fixtures/fixture.mp3 ]; then
        echo "[fixture] already present — skip"
    else
        ffmpeg -v error -f lavfi -i "sine=frequency=440:duration=1800" -b:a 320k -ac 2 \
            spikes/media-protocol/fixtures/fixture.mp3
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
    rm -rf packages/*/dist apps/*/dist packages/gui/out
    rm -rf packages/*/*.tsbuildinfo apps/*/*.tsbuildinfo

[group('clean')]
clean-all: clean
    rm -rf node_modules packages/*/node_modules apps/*/node_modules spikes/*/node_modules

# ─── Setup ──────────────────────────────────────────────

[group('setup')]
install:
    pnpm install

[group('setup')]
reinstall: clean-all install
