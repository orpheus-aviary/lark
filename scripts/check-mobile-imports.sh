#!/usr/bin/env bash
# What the Android side of this repo is entitled to import (N0b subplan §0,
# scope widened to `apps/mobile` in N2a — this is the SAME guard, not a new
# one).
#
# Two roots, one rule. `spikes/mobile-foundation` is a PLATFORM spike: core's
# business modules used to reach for `node:crypto` and `node:fs/promises`, so
# Metro could not resolve them, and a spike that quietly copied core's logic in
# order to "verify" it would be verifying the copy. `apps/mobile` is the
# product, and its rule has the same shape for a different reason: everything
# it runs must be the same business graph the desktop runs, which means
# `@lark/core/portable` and not a mobile-flavoured re-implementation beside it.
#
# So the workspace-internal import surface is an allowlist of three packages,
# and anything a probe needs core to COMPUTE (WBI signatures, signed stream
# URLs, the audio header set) arrives as a fixture produced on the desktop by
# the real core.
#
# SCOPE: only `@lark/*` and `@orpheus-aviary/*`. The whole Expo/React Native
# ecosystem is out of scope by design — this guard is about which of OUR
# packages these two roots are entitled to, not about their third-party
# dependencies.
#
# ONE EXEMPTION, and it exists to serve the rule rather than to dent it:
# `spikes/mobile-foundation/scripts/*.mjs` are HOST scripts. They run on the
# desktop under Node, they are not in Metro's graph, and their whole job is to
# produce the fixtures the device is forbidden to compute — the WBI
# three-piece, `openAudio()`'s header set, the raw audio bytes. Producing those
# with anything but the real core would be the exact self-agreement the guard
# is written to prevent (N0b-4). So a host script may reach `@lark/core`;
# nothing that Metro bundles may. The exemption is spelled with the spike's
# path on purpose: `apps/mobile` has no host scripts and should not grow one.

set -euo pipefail

ROOTS=(
  "spikes/mobile-foundation"
  "apps/mobile"
)

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

# Host script = directly under the SPIKE's `scripts/`, `.mjs`. Nothing under
# any `src/` matches, and nothing under `apps/mobile` matches at all, so the
# bundles stay on the allowlist no matter what a fixture producer needs.
is_host_script() {
  case "$1" in
    spikes/mobile-foundation/scripts/*.mjs) return 0 ;;
    *) return 1 ;;
  esac
}

violations=""
while IFS=: read -r file lineno spec; do
  [ -n "$file" ] || continue
  is_allowed "$spec" && continue
  case "$spec" in
    @lark/core | @lark/core/*)
      is_host_script "$file" && continue
      ;;
  esac
  violations="${violations}${file}:${lineno}: ${spec}"$'\n'
done < <(rg -n --no-heading -o -r '$1' \
  -e "from '(@(?:lark|orpheus-aviary)/[^']*)'" \
  -e "import '(@(?:lark|orpheus-aviary)/[^']*)'" \
  -e "require\('(@(?:lark|orpheus-aviary)/[^']*)'\)" \
  -e "import\('(@(?:lark|orpheus-aviary)/[^']*)'\)" \
  "${ROOTS[@]}" \
  --glob '!android/**' \
  --glob '!ios/**' \
  || true)

if [ -n "$violations" ]; then
  echo "✗ ${ROOTS[*]} may only import: ${ALLOWED[*]}"
  echo "  (the mobile side runs the SAME business graph as the desktop — that"
  echo "   is what @lark/core/portable is; a second implementation beside it"
  echo "   agrees for a while and then does not)"
  echo "  host scripts — spikes/mobile-foundation/scripts/*.mjs — may also use @lark/core"
  echo "$violations"
  exit 1
fi

echo "✓ spike + apps/mobile stay inside their workspace allowlist"
