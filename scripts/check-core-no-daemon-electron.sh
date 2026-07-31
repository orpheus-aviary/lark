#!/usr/bin/env bash
# Dependency direction: shared ← core ← daemon ← gui. @lark/core is the business
# layer the daemon AND the CLI (`--direct`, M6) both link, so it must never
# reach up into the daemon or into Electron.
#
# Greps the SOURCE, not package.json: with `node-linker=hoisted` an undeclared
# dependency still resolves at runtime, so a declaration check would pass while
# the import works.

set -euo pipefail

FORBIDDEN="@lark/daemon|@lark/gui|electron"

hits=$(rg -n \
  -e "from '($FORBIDDEN)(/[^']*)?'" \
  -e "import '($FORBIDDEN)(/[^']*)?'" \
  -e "require\('($FORBIDDEN)(/[^']*)?'\)" \
  -e "import\('($FORBIDDEN)(/[^']*)?'\)" \
  packages/core/src \
  --glob '!**/*.test.ts' \
  || true)

if [ -n "$hits" ]; then
  echo "✗ @lark/core must not import @lark/daemon / @lark/gui / electron"
  echo "$hits"
  exit 1
fi

echo "✓ core stays free of daemon / gui / electron"
