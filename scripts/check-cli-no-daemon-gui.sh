#!/usr/bin/env bash
# The CLI's module graph (M6-21). Two rules, both about what a command LOADS
# before it does anything:
#
#   1. No @lark/daemon, no @lark/gui, no electron. The CLI drives a daemon over
#      HTTP or opens the library itself; importing the daemon package would
#      make `lark status` depend on Fastify and on better-sqlite3.
#   2. No STATIC import of @lark/core's barrel. The barrel pulls in
#      better-sqlite3, so a repo currently built for the Electron ABI would
#      fail `lark status` on a native module that command never uses. Core is
#      reached through its zero-native subpaths (`/paths`, `/config`,
#      `/daemon-control`, `/native-probe`); the barrel is loaded with a DYNAMIC
#      import, on the `--direct` branch only.
#
# Greps the SOURCE (see check-core-no-daemon-electron.sh for why).

set -euo pipefail

FORBIDDEN="@lark/daemon|@lark/gui|electron"

hits=$(rg -n \
  -e "from '($FORBIDDEN)(/[^']*)?'" \
  -e "import '($FORBIDDEN)(/[^']*)?'" \
  -e "require\('($FORBIDDEN)(/[^']*)?'\)" \
  -e "import\('($FORBIDDEN)(/[^']*)?'\)" \
  apps/cli/src \
  --glob '!**/*.test.ts' \
  || true)

if [ -n "$hits" ]; then
  echo "✗ @lark/cli must not import @lark/daemon / @lark/gui / electron"
  echo "$hits"
  exit 1
fi

# Static barrel imports only. A dynamic `await import('@lark/core')` is the
# sanctioned form and is not matched by these patterns.
barrel=$(rg -n \
  -e "^import .* from '@lark/core';" \
  -e "^import '@lark/core';" \
  apps/cli/src \
  --glob '!**/*.test.ts' \
  || true)

if [ -n "$barrel" ]; then
  echo "✗ @lark/cli must not statically import the @lark/core barrel (it loads better-sqlite3)"
  echo "  use a subpath (@lark/core/paths, /config, /daemon-control, /native-probe),"
  echo "  or a dynamic import on the --direct branch."
  echo "$barrel"
  exit 1
fi

echo "✓ cli stays free of daemon / gui / electron, and off the core barrel"
