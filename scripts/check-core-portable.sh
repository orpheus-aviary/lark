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
# OBLIGATION: the escape patterns below enumerate core's top-level directories
# and root modules. Adding one to `packages/core/src` means adding it here, or
# portable gains a hole exactly where the newest code is.

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

# Relative escapes, depth-independent: `../db/index.js` and
# `../../../db/index.js` are the same mistake written from different depths.
CORE_DIRS="config|daemon-control|db|download|library|logger|media-tools|migration|sync|testing"
CORE_ROOT_MODULES="backup-nest|errors|index|native-probe|paths"

escape_hits=$(rg -n \
  -e "from '(\.\./)+($CORE_DIRS)/" \
  -e "from '(\.\./)+($CORE_ROOT_MODULES)\.js'" \
  -e "import\('(\.\./)+($CORE_DIRS)/" \
  -e "import\('(\.\./)+($CORE_ROOT_MODULES)\.js'" \
  packages/core/src/portable \
  --glob '!**/*.test.ts' \
  || true)

if [ -n "$module_hits" ] || [ -n "$escape_hits" ]; then
  echo "✗ @lark/core/portable must stay host-free (no node builtins / better-sqlite3 / electron / node-only libs / core itself)"
  [ -n "$module_hits" ] && echo "$module_hits"
  [ -n "$escape_hits" ] && echo "$escape_hits"
  exit 1
fi

echo "✓ core/portable stays host-free"
