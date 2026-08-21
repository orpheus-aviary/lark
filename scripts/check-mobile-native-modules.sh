#!/usr/bin/env bash
# Every self-built Expo module is actually WIRED (N4b-1's cost).
#
# `modules/lark-media` shipped with its Kotlin, its `expo-module.config.json`
# and its TypeScript face — and no `android/build.gradle`. Autolinking skipped
# it silently, the app built and installed, and the first launch died with
# `Cannot find native module 'LarkMedia'` before any screen rendered. Nothing
# offline could see it: tsc passes, biome passes, and the Metro bundle graph
# contains the JS side of a native module whether or not the native side was
# ever compiled.
#
# So the four files that make one of these a module are checked against each
# other:
#
#   expo-module.config.json          names the Kotlin class
#   android/build.gradle             is what autolinking looks for AT ALL
#   the class's own .kt file         exists, at the path the package implies
#   index.ts                         the JS face
#
# It does not prove the module works — only that a build will contain it. That
# is exactly the gap that cost a device round trip.

set -euo pipefail

MODULES_DIR="apps/mobile/modules"
problems=""

for dir in "$MODULES_DIR"/*/; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  config="${dir}expo-module.config.json"

  [ -f "$config" ] || { problems="${problems}${name}: no expo-module.config.json"$'\n'; continue; }
  [ -f "${dir}index.ts" ] || problems="${problems}${name}: no index.ts"$'\n'
  # The one that was missing. Without it the directory is not a Gradle project,
  # so `useExpoModules()` walks straight past it and says nothing.
  [ -f "${dir}android/build.gradle" ] || problems="${problems}${name}: no android/build.gradle — autolinking will skip it in SILENCE"$'\n'

  # Every class the config advertises has to be somewhere under android/.
  while read -r class; do
    [ -n "$class" ] || continue
    path="${dir}android/src/main/java/$(echo "$class" | tr '.' '/').kt"
    [ -f "$path" ] || problems="${problems}${name}: config names ${class}, but ${path} is not there"$'\n'
  done < <(sed -n 's/.*"\(expo\.modules\.[A-Za-z0-9_.]*\)".*/\1/p' "$config")
done

if [ -n "$problems" ]; then
  echo "✗ a self-built Expo module is not wired for the native build"
  echo "  (compare against modules/lark-fs, which is the shape all of them take)"
  echo "$problems"
  exit 1
fi

echo "✓ every apps/mobile native module is wired for autolinking"
