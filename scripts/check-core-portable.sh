#!/usr/bin/env bash
# `@lark/core/portable` is the slice of core that has to run on a phone (N0a).
#
# It may assume: ECMAScript, `drizzle-orm/sqlite-core` (types + table builders,
# no driver), `@lark/shared`, and a `SqliteLike` handle passed in by its caller.
# Nothing else. Metro has no Node builtins and no better-sqlite3, so an import
# that sneaks in here does not fail a test — it fails to RESOLVE, on a device,
# in a batch that is about something else entirely.
#
# Greps the SOURCE for the same reason every other guard does: `node-linker=
# hoisted` resolves undeclared dependencies just fine, so a manifest check
# would pass while the import works.
#
# Test files are excluded, like the shared guard. They run on the desktop
# runtime and legitimately reach for `node:fs`, better-sqlite3 and
# `createDatabase` to build fixtures; what ships to the phone is the module
# graph reachable from `portable/index.ts`, and no test is in it. Contract
# CASES are not tests — they are plain functions under `portable/contract/`,
# and they stay guarded.
#
# The GLOBAL half (N1) catches what an import list cannot see. `Buffer`,
# `process`, `NodeJS.*` and `__dirname` are ambient on the desktop: they need no
# import, they typecheck, every desktop test passes — and on a phone they are
# `undefined`. There is no compiler setting that removes them, because core's
# NON-portable half legitimately uses all four.
#
# This half reads CODE ONLY — comments are stripped first — and matches how the
# identifiers are USED: a method call, a type position, an errno cast. Both
# halves of that are load bearing, and both were learned by running it.
#
# Matching bare words reds "better-sqlite3 hands back a Buffer" in a comment
# explaining a host difference, and reds an English sentence that ends in "no
# child process." Matching code shape but not stripping comments still reds
# `portable/runtime/base64.ts`, whose entire job is to reproduce what
# `Buffer.from(v, 'base64')` does — a port MUST be able to name the thing it is
# porting, in the file where the reasoning lives.
#
# What survives both filters is the real thing: `Buffer.byteLength(x)`,
# `buffer: Buffer`, `(err as NodeJS.ErrnoException)`, `process.env.X`,
# `require(…)` — none of which need an import, all of which typecheck, and
# every one of which is `undefined` on a phone.
#
# The relative-escape half is DEPTH-COUNTED, not a list of core's directories.
# The first draft matched `(\.\./)+(db|library|…)/`, which reads fine until
# portable grows subdirectories: from `portable/contract/cases/`, the legal
# `../../errors.js` (portable's own) and the illegal `../../../errors.js`
# (core's) are the same pattern at different depths. Counting `../` against how
# deep the file sits below `portable/` decides it exactly — and it catches an
# escape to ANYWHERE, so nobody has to remember to extend a list when core
# grows a new top-level directory.

set -euo pipefail

BUILTINS="assert|async_hooks|buffer|child_process|cluster|console|constants|crypto|dgram|diagnostics_channel|dns|domain|events|fs|http|http2|https|inspector|module|net|os|path|perf_hooks|process|punycode|querystring|readline|repl|stream|string_decoder|sys|timers|tls|trace_events|tty|url|util|v8|vm|wasi|worker_threads|zlib"

# Hosts, native bindings and Node-only libraries. `drizzle-orm/better-sqlite3`
# is named explicitly so that `drizzle-orm/sqlite-core` stays allowed.
HOSTS="better-sqlite3|drizzle-orm/better-sqlite3|electron|pino|pino-roll|smol-toml|@lark/daemon|@lark/gui"

# Self-import through the package name, subpaths included: `@lark/core/config`
# resolves to the Node-only barrel just as surely as `@lark/core` does.
SELF="@lark/core(/[^']*)?"

FORBIDDEN="node:[^']*|$HOSTS|$SELF|$BUILTINS"

module_hits=$(rg -n \
  -e "from '($FORBIDDEN)(/[^']*)?'" \
  -e "import '($FORBIDDEN)(/[^']*)?'" \
  -e "require\('($FORBIDDEN)(/[^']*)?'\)" \
  -e "import\('($FORBIDDEN)(/[^']*)?'\)" \
  packages/core/src/portable \
  --glob '!**/*.test.ts' \
  || true)

# A relative specifier escapes when it climbs further than the file sits below
# `portable/`. `portable/contract/cases/x.ts` is two levels down, so `../../`
# lands on `portable/` (fine) and `../../../` lands on `src/` (not fine).
escape_hits=""
while IFS=: read -r file lineno spec; do
  [ -n "$file" ] || continue
  rel=${file#packages/core/src/portable/}
  depth=$(printf '%s' "$rel" | tr -cd '/' | wc -c | tr -d ' ')
  ups=$(printf '%s' "$spec" | grep -o '\.\./' | wc -l | tr -d ' ')
  if [ "$ups" -gt "$depth" ]; then
    escape_hits="${escape_hits}${file}:${lineno}: escapes portable/ -> ${spec}"$'\n'
  fi
done < <(rg -n --no-heading -o -r '$1' \
  -e "from '(\.\./[^']*)'" \
  -e "import\('(\.\./[^']*)'\)" \
  packages/core/src/portable \
  --glob '!**/*.test.ts' \
  || true)

global_hits=$(find packages/core/src/portable -name '*.ts' ! -name '*.test.ts' -exec awk '
  # JSDoc continuation lines are prose by construction.
  /^[ \t]*\*/ { next }
  {
    line = $0
    idx = index(line, "//")
    if (idx > 0) line = substr(line, 1, idx - 1)   # …and so is everything after `//`
    if (line ~ /(^|[^A-Za-z])Buffer[ ]*\./ ||
        line ~ /(:|<|as)[ ]*Buffer([^A-Za-z0-9_]|$)/ ||
        line ~ /(^|[^A-Za-z0-9_$])process\.[A-Za-z_$]/ ||
        line ~ /(^|[^A-Za-z0-9_$])NodeJS\.[A-Za-z_$]/ ||
        line ~ /(^|[^A-Za-z0-9_$])__dirname([^A-Za-z0-9_$]|$)/ ||
        line ~ /(^|[^A-Za-z0-9_$.])require\(/)
      printf "%s:%d:%s\n", FILENAME, FNR, $0
  }' {} + || true)

# `sqliteOf(db)` was `db.$client` — the raw handle taken off the drizzle object.
# drizzle's Expo driver has no `$client`, so on a phone that is not a rough edge,
# it is a property that does not exist. It retired in N1c in favour of a pair
# formed at the open (`PortableDb`), and this keeps it retired across the WHOLE
# repo, not just portable: the point is that nobody re-derives one handle from
# the other anywhere.
#
# Code only, same as the global half — this file and `portable/db.ts` both have
# to be able to say the name while explaining why it is gone.
sqlite_of_hits=$(find packages apps -name '*.ts' -not -path '*/node_modules/*' -not -path '*/dist/*' -exec awk '
  /^[ \t]*\*/ { next }
  {
    line = $0
    idx = index(line, "//")
    if (idx > 0) line = substr(line, 1, idx - 1)
    if (line ~ /(^|[^A-Za-z0-9_$.])sqliteOf[ ]*\(/)
      printf "%s:%d:%s\n", FILENAME, FNR, $0
  }' {} + || true)

if [ -n "$module_hits" ] || [ -n "$escape_hits" ] || [ -n "$global_hits" ] || [ -n "$sqlite_of_hits" ]; then
  echo "✗ @lark/core/portable must stay host-free (no node builtins / better-sqlite3 / electron / node-only libs / core itself / ambient Node globals)"
  [ -n "$module_hits" ] && echo "$module_hits"
  [ -n "$escape_hits" ] && echo "$escape_hits"
  [ -n "$global_hits" ] && echo "$global_hits"
  [ -n "$sqlite_of_hits" ] && echo 'sqliteOf retired in N1c — take the pair from createDatabase instead:' && echo "$sqlite_of_hits"
  exit 1
fi

echo "✓ core/portable stays host-free"
