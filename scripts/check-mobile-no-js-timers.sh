#!/usr/bin/env bash
# The playback path may not wait on a JS timer (0.1.1 ⑪).
#
# 🔴 THE MEASUREMENT THIS EXISTS FOR. React Native's `setTimeout` rides the
# Choreographer, which stops when the display does — so on the frozen device,
# 2026-08-26, the 300ms settle inside `driver.destroy()` took **63 537ms** and
# finished only when the phone was unlocked. Every other step of the
# auto-advance was native and arrived on time: the end-of-song event at +0ms,
# the queue decision at +55ms, the pause at +56ms. One JS timer held the whole
# thing, and the symptom was「锁屏播完一首就自动暂停，解锁之后才播下一首」.
#
# WHY A GUARD AND NOT A TEST. `player/driver.ts` imports expo-audio, so it can
# never be collected by `apps/mobile/vitest.config.ts` — there is no unit test
# that can go red here, and the device only answers this once per release. A
# `rg` over one directory is the whole of what can be checked on a laptop, and
# it is enough: the failure mode is somebody reaching for the reflex.
#
# SCOPED TO `src/player/` ON PURPOSE. Elsewhere a JS timer is a judgement call
# — N4f-2's grace period before stopping the foreground service was DELETED
# rather than made native, because what it defended against (a double tap) does
# not happen behind a dark screen. The question is always "is this wait still
# meaningful with the screen off", and only in here is the answer always yes.

set -u
DIR="apps/mobile/src/player"

hits="$(rg --line-number --no-heading '\b(setTimeout|setInterval|requestAnimationFrame)\s*\(' "$DIR" --glob '!*.test.ts' || true)"

if [ -n "$hits" ]; then
  echo "✗ a JS timer reached the playback path"
  echo "  Use \`nativeDelay\` from \`modules/lark-app\` instead — JS timers are"
  echo "  frozen while the screen is off (measured: 300ms became 63.5 SECONDS)."
  echo "$hits" | sed 's/^/  /'
  exit 1
fi

echo "✓ the playback path waits on the platform, not on JS timers"
