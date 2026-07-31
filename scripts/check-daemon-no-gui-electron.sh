#!/usr/bin/env bash
# The daemon must run headless — `lark daemon` from a terminal, with no Electron
# anywhere in the process. That is an architecture invariant, not a preference:
# the CLI and agent callers drive a daemon that was never spawned by the GUI.
#
# Greps the SOURCE (see check-core-no-daemon-electron.sh for why).

set -euo pipefail

FORBIDDEN="@lark/gui|electron"

hits=$(rg -n \
  -e "from '($FORBIDDEN)(/[^']*)?'" \
  -e "import '($FORBIDDEN)(/[^']*)?'" \
  -e "require\('($FORBIDDEN)(/[^']*)?'\)" \
  -e "import\('($FORBIDDEN)(/[^']*)?'\)" \
  packages/daemon/src \
  --glob '!**/*.test.ts' \
  || true)

if [ -n "$hits" ]; then
  echo "✗ @lark/daemon must not import @lark/gui / electron"
  echo "$hits"
  exit 1
fi

echo "✓ daemon stays free of gui / electron"
