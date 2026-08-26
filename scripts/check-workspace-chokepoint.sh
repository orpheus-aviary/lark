#!/usr/bin/env bash
# Nobody names the library file but `paths.ts` (N7c, criterion 109).
#
# Since N7 one device holds several libraries, and WHICH one a process opens is
# decided in exactly one place: `resolveActiveWorkspace()` in
# `packages/core/src/paths.ts`, which every path function routes through. The
# three entry points that open a library — daemon boot, `lark --direct`, and
# the GUI's precheck via the daemon it spawns — all reach it through
# `paths.dbPath()`, so there is no "old path" to bypass the resolver to.
#
# That property is one careless `join(larkDir(), 'songs.db')` away from being
# false, and the failure is silent in the worst way: a process that opens the
# nest root while the real library lives under `libraries/<id>/` does not
# crash. It creates an empty library and shows it to somebody.
#
# So: the string `songs.db` may only appear in CODE in the files below. It
# matches the name inside STRING quotes only — prose in this repo spells file
# names in backticks, so comments and documentation are unaffected.
#
# THE ALLOWLIST, with why each one is on it:
#
#   paths.ts               the chokepoint itself — it is the only module
#                          entitled to say where a library lives.
#   backup-nest.ts         copies the whole NEST, not one workspace. It walks
#                          `larkDir()` on purpose and must keep doing so.
#   db/fixture-go-db.ts    builds a Go-era library in a temp directory for the
#                          migration tests; it never touches a real nest.
#
# Tests are out of scope: a test that hard-codes a path is testing a path.

#
# THE PHONE HAS THE SAME RULE, spelled differently (N7d). Its layout is
# expo `Directory` objects rather than strings, so the thing to guard is who
# may reach `nestDirectory()` — the DEVICE root. Everything about a library
# hangs off `libraryDirectory()`, which is the active workspace, and that one
# function is the whole reason two workspaces cannot see each other's songs.

set -euo pipefail

ALLOWED=(
  "packages/core/src/paths.ts"
  "packages/core/src/backup-nest.ts"
  "packages/core/src/db/fixture-go-db.ts"
  # The phone's own layout module, and the only place `DATABASE_NAME` is set.
  "apps/mobile/src/ports/paths.ts"
)

# Who may name the DEVICE root on the phone.
NEST_ALLOWED=(
  "apps/mobile/src/ports/paths.ts"
  # Acceptance scratch, both of them outside any library: a directory the
  # harness writes probe files into, and one it drops a generated tone in.
  "apps/mobile/src/acceptance/fs.ts"
  "apps/mobile/src/acceptance/playback.ts"
)

is_allowed() {
  for ok in "${ALLOWED[@]}"; do
    [ "$1" = "$ok" ] && return 0
  done
  return 1
}

is_nest_allowed() {
  for ok in "${NEST_ALLOWED[@]}"; do
    [ "$1" = "$ok" ] && return 0
  done
  return 1
}

violations=""
while IFS=: read -r file lineno rest; do
  [ -n "$file" ] || continue
  is_allowed "$file" && continue
  violations="${violations}${file}:${lineno}:${rest}"$'\n'
done < <(rg -n --no-heading \
  -e "['\"]songs\.db['\"]" \
  -e "['\"]songs\.db-" \
  packages apps \
  --glob '!**/dist/**' \
  --glob '!**/node_modules/**' \
  --glob '!*.test.ts' \
  --glob '!**/*.e2e.ts' \
  || true)

if [ -n "$violations" ]; then
  echo "✗ only paths.ts may name the library file — everything else goes"
  echo "  through paths.dbPath(), which is where the active workspace is"
  echo "  resolved (N7c). Opening the nest root directly on a device that has"
  echo "  switched shows somebody an empty library."
  echo "$violations"
  exit 1
fi

nest_violations=""
while IFS=: read -r file lineno rest; do
  [ -n "$file" ] || continue
  is_nest_allowed "$file" && continue
  nest_violations="${nest_violations}${file}:${lineno}:${rest}"$'\n'
done < <(rg -n --no-heading \
  -e "\\bnestDirectory\\b" \
  apps/mobile/src \
  --glob '!*.test.ts' \
  || true)

if [ -n "$nest_violations" ]; then
  echo "✗ on the phone, only ports/paths.ts may reach the DEVICE root."
  echo "  Anything about a library goes through libraryDirectory(), which is"
  echo "  the active workspace (N7d) — that one function is why two"
  echo "  workspaces cannot see each other's songs."
  echo "$nest_violations"
  exit 1
fi

# ─── The sentences N7 made false (criterion 118) ────────────────────────────
#
# Before N7 a device had one library and it could be bound to one account for
# ever; the settings page said so, twice, and told people the only way out was
# to wipe the app. Both sentences are now wrong in the most expensive
# direction: somebody would clear their data to do something the switcher does
# in two taps.
#
# So they are banned rather than merely edited. A phrase that was true for two
# milestones is exactly the kind of thing that gets copied back in.

copy_violations=""
while IFS=: read -r file lineno rest; do
  [ -n "$file" ] || continue
  copy_violations="${copy_violations}${file}:${lineno}:${rest}"$'\n'
done < <(rg -n --no-heading \
  -e "清除应用数据重来" \
  -e "清除应用数据重新开始" \
  -e "不能改绑" \
  -e "只能绑一个账号" \
  apps/mobile/src packages/gui/src \
  --glob '!*.test.*' \
  || true)

if [ -n "$copy_violations" ]; then
  echo "✗ that sentence stopped being true in N7: an account gets its own"
  echo "  library on this device, and switching between them is two taps."
  echo "  Telling somebody to clear their app data would cost them everything"
  echo "  that has not synced, to do something they did not need to do."
  echo "$copy_violations"
  exit 1
fi

echo "✓ the library file is named in one place, on both hosts"
echo "✓ nothing still says a library can only ever have one account"
