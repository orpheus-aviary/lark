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

[group('lint')]
check: lint typecheck core-no-daemon-electron daemon-no-gui-electron shared-node-free
    @echo "All checks passed."

# ─── Test ───────────────────────────────────────────────

[group('test')]
test:
    pnpm run test

[group('test')]
test-shared:
    pnpm --filter @lark/shared run test

[group('test')]
test-core:
    pnpm --filter @lark/core run test

[group('test')]
test-daemon:
    pnpm --filter @lark/daemon run test

[group('test')]
test-cli:
    pnpm --filter @lark/cli run test

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

[group('build')]
build-gui: build-shared
    pnpm --filter @lark/gui run build

[group('build')]
build-cli: build-shared
    pnpm --filter @lark/cli run build

# ─── ABI toggling (M1) ──────────────────────────────────
#
# better-sqlite3 ships one compiled .node whose ABI must match the runtime that
# loads it, so switching between `just dev` (Electron) and `just test` (Node)
# needs a rebuild. `ensure-node-abi` / `ensure-electron-abi` land here in M1
# together with better-sqlite3. Two lessons from owl to carry over:
#   - rebuild with `pnpm run build-release` (force node-gyp from source), NOT
#     `pnpm run install` — the latter grabs a prebuilt for npm's bundled Node
#     and silently re-breaks the local Node ABI on every `pnpm install`;
#   - under node-linker=hoisted there is no `.pnpm/better-sqlite3@*` directory,
#     so the source lookup needs the top-level `node_modules/better-sqlite3`
#     fallback.
# Record BOTH `process.versions.modules` values when it lands (host Node and
# Electron) — copying owl's 137/132 pair would be wrong for lark's versions.

# ─── Dev ────────────────────────────────────────────────

# Launch the GUI (daemon must be started separately in M0 — GUI spawn is M4).
[group('dev')]
dev: build-shared build-core build-daemon
    pnpm run dev

# Run the daemon in the foreground on 127.0.0.1:47100.
[group('dev')]
dev-daemon: build-shared build-core build-daemon
    node packages/daemon/dist/cli.js daemon

# Launch the BUILT renderer through Electron — the only way to observe the
# production CSP (a bare `build` produces no console to watch). M0-5 two-state
# verification: `just dev` for the dev policy, this for the build policy.
[group('dev')]
gui-preview: build-gui
    pnpm --filter @lark/gui run preview

# Run the user-facing CLI from dist, e.g. `just cli status --json`.
# No global `lark` bin exists until M6/M7.
[group('dev')]
cli *args: build-cli
    node apps/cli/dist/index.js {{args}}

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
