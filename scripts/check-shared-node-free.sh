#!/usr/bin/env bash
# @lark/shared is the wire contract + HTTP client. The CLI, the Electron
# renderer and a future mobile client all consume it, so it must stay Node-free:
# no builtins, no Electron, no host packages. Its tsconfig already drops the
# node types and uses lib DOM; this guard catches the imports that would
# re-introduce a Node dependency at runtime.
#
# Node builtins are matched in BOTH forms — `node:fs` and bare `fs`. Matching
# only the prefixed form would miss `import fs from 'fs'`, which resolves fine.

set -euo pipefail

BUILTINS="assert|async_hooks|buffer|child_process|cluster|console|constants|crypto|dgram|diagnostics_channel|dns|domain|events|fs|http|http2|https|inspector|module|net|os|path|perf_hooks|process|punycode|querystring|readline|repl|stream|string_decoder|sys|timers|tls|trace_events|tty|url|util|v8|vm|wasi|worker_threads|zlib"
FORBIDDEN="node:[^']*|electron|@lark/core|@lark/daemon|$BUILTINS"

hits=$(rg -n \
  -e "from '($FORBIDDEN)(/[^']*)?'" \
  -e "import '($FORBIDDEN)(/[^']*)?'" \
  -e "require\('($FORBIDDEN)(/[^']*)?'\)" \
  -e "import\('($FORBIDDEN)(/[^']*)?'\)" \
  packages/shared/src \
  --glob '!**/*.test.ts' \
  || true)

if [ -n "$hits" ]; then
  echo "✗ @lark/shared must stay Node-free (no node builtins / electron / core / daemon)"
  echo "$hits"
  exit 1
fi

echo "✓ shared stays Node-free"
