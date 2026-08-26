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

set -euo pipefail

ALLOWED=(
  "packages/core/src/paths.ts"
  "packages/core/src/backup-nest.ts"
  "packages/core/src/db/fixture-go-db.ts"
)

is_allowed() {
  for ok in "${ALLOWED[@]}"; do
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
  --glob '!apps/mobile/**' \
  || true)

if [ -n "$violations" ]; then
  echo "✗ only paths.ts may name the library file — everything else goes"
  echo "  through paths.dbPath(), which is where the active workspace is"
  echo "  resolved (N7c). Opening the nest root directly on a device that has"
  echo "  switched shows somebody an empty library."
  echo "$violations"
  exit 1
fi

echo "✓ the library file is named in one place"
