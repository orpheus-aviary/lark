#!/usr/bin/env bash
# The launcher icon is actually declared, and its files are actually there.
#
# Android 0.1.0 shipped Expo's placeholder icon. Nothing caught it, and nothing
# could have: a missing `icon` is NOT an error — the template carries a default
# and `expo prebuild` uses it without a word. tsc, biome, the bundle smoke and
# the native-module guard are all blind to it, because every one of them is
# about code and this is about an asset that was never named.
#
# So the guard is about the naming. Four facts, all cheap:
#
#   app.config.ts declares `icon`
#   app.config.ts declares an adaptiveIcon with BOTH halves
#     (minSdk is 26, so the adaptive icon is the one every supported device
#      shows; `icon` alone would leave the launcher to invent a backdrop)
#   both referenced files exist
#
# It does NOT check what is IN them — that a human has to look at, and the
# recipe in `apps/mobile/assets/README.md` says what "right" means (the
# artwork spanning the inner 72 of 108dp).

set -u
CONFIG="apps/mobile/app.config.ts"
ASSETS="apps/mobile/assets"
problems=""

need() { # $1 = rg pattern, $2 = what is missing
  rg --quiet "$1" "$CONFIG" || problems="${problems}  ${2}"$'\n'
}

need "^\s*icon:\s*'\./assets/" "app.config.ts declares no \`icon\`"
need "adaptiveIcon:\s*\{"      "app.config.ts declares no \`android.adaptiveIcon\` (minSdk 26 — this is THE icon)"
need "foregroundImage:\s*'\./assets/" "the adaptiveIcon has no \`foregroundImage\`"
need "backgroundColor:\s*'#"   "the adaptiveIcon has no \`backgroundColor\`"

# Every asset the config points at has to be on disk. A path typo would
# otherwise fail at prebuild time — or worse, not fail at all.
while read -r asset; do
  [ -n "$asset" ] || continue
  [ -f "${ASSETS}/${asset}" ] || problems="${problems}  ${CONFIG} points at assets/${asset}, which is not there"$'\n'
done < <(rg --only-matching --replace '$1' "'\./assets/([A-Za-z0-9._-]+)'" "$CONFIG")

if [ -n "$problems" ]; then
  echo "✗ the Android launcher icon is not wired up"
  echo "  (a missing icon is not a build error — Expo's placeholder ships instead)"
  echo "$problems"
  exit 1
fi

echo "✓ the Android launcher icon is declared and its files are present"
