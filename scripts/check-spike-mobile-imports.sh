#!/usr/bin/env bash
# The mobile spike's boundary (N0b, subplan §0).
#
# N0b is a PLATFORM spike, not a verification of core's business graph. core's
# business modules reach for `node:crypto` and `node:fs/promises`, so Metro
# cannot resolve them until N1 ports them — and a spike that quietly copied
# core's logic in order to "verify" it would be verifying the copy. So the
# workspace-internal import surface is an allowlist of three packages, and
# anything a probe needs core to COMPUTE (WBI signatures, signed stream URLs,
# the audio header set) arrives as a fixture produced on the desktop by the
# real core.
#
# SCOPE: only `@lark/*` and `@orpheus-aviary/*`. The whole Expo/React Native
# ecosystem is out of scope by design — this guard is about which of OUR
# packages the spike is entitled to, not about its third-party dependencies.

set -euo pipefail

SPIKE="spikes/mobile-foundation"

ALLOWED=(
  "@lark/core/portable"
  "@lark/shared"
  "@lark/shared/api-paths"
  "@orpheus-aviary/skybridge-client"
  "@orpheus-aviary/skybridge-proto"
)

is_allowed() {
  local spec="$1"
  for ok in "${ALLOWED[@]}"; do
    [ "$spec" = "$ok" ] && return 0
  done
  return 1
}

violations=""
while IFS=: read -r file lineno spec; do
  [ -n "$file" ] || continue
  is_allowed "$spec" || violations="${violations}${file}:${lineno}: ${spec}"$'\n'
done < <(rg -n --no-heading -o -r '$1' \
  -e "from '(@(?:lark|orpheus-aviary)/[^']*)'" \
  -e "import '(@(?:lark|orpheus-aviary)/[^']*)'" \
  -e "require\('(@(?:lark|orpheus-aviary)/[^']*)'\)" \
  -e "import\('(@(?:lark|orpheus-aviary)/[^']*)'\)" \
  "$SPIKE" \
  --glob '!android/**' \
  --glob '!ios/**' \
  || true)

if [ -n "$violations" ]; then
  echo "✗ the mobile spike may only import: ${ALLOWED[*]}"
  echo "  (core's business modules are Node-only until N1; anything they would"
  echo "   compute belongs in a desktop-produced fixture, not in the spike)"
  echo "$violations"
  exit 1
fi

echo "✓ mobile spike stays inside its workspace allowlist"
