#!/usr/bin/env bash
# Every `setVisibleOnAllWorkspaces` in the Electron main process says out loud
# what it wants done to the PROCESS (0.5.1 §1).
#
# 🔴 WHAT THIS EXISTS FOR. `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen:
# true })` — the obvious, documented way to float a window over a full-screen
# app — additionally runs
# `TransformProcessType(kProcessTransformToUIElementApplication)` on the whole
# process. lark then has no dock icon, no menu bar and no Cmd+Q, while the
# process keeps running and playing. Nothing transforms it back: the transform
# was never tied to the window that asked for it, so turning the lyrics off
# leaves the app exactly as unreachable. 0.5.0 shipped this way.
#
# 🔴 AND WHY IT IS A GUARD RATHER THAN A TEST. What broke is a property of the
# process, set by a real Electron on a real macOS. vitest has neither, and the
# window is built by `createDesktopLyricsWindow` — the one part of the feature
# that is not behind the injectable factory `desktop-lyrics-window.ts` exists to
# provide. The only place this is observable without launching the app is the
# source.
#
# The flag is demanded on EVERY call, including `visible: false` ones that would
# transform the other way and be harmless. The default is the trap; a call site
# that has not said which way it wants the process to go has not thought about
# it.

set -u
DIR="packages/gui/src/main"

sites="$(rg --line-number --with-filename -- 'setVisibleOnAllWorkspaces\(' "$DIR" || true)"
if [ -z "$sites" ]; then
  echo "✓ no setVisibleOnAllWorkspaces call in the main process"
  exit 0
fi

# Whitespace-flattened so a call spread over several lines is one string; there
# are no nested parens in these argument lists.
flat="$(cat "$DIR"/*.ts | tr '\n' ' ')"
total="$(printf '%s' "$flat" | grep -o 'setVisibleOnAllWorkspaces(' | wc -l | tr -d ' ')"
guarded="$(printf '%s' "$flat" \
  | grep -oE 'setVisibleOnAllWorkspaces\([^)]*skipTransformProcessType:[[:space:]]*true[^)]*\)' \
  | wc -l | tr -d ' ')"

if [ "$total" != "$guarded" ]; then
  echo "✗ a setVisibleOnAllWorkspaces call does not pass skipTransformProcessType: true"
  echo "  ($total call site(s), $guarded of them guarded)"
  echo "  Without it Electron transforms the PROCESS into a UIElement app:"
  echo "  the dock icon, the menu bar and Cmd+Q all go, and only relaunching"
  echo "  brings them back. Pass the flag and set the window level instead."
  echo "$sites" | sed 's/^/  /'
  exit 1
fi

echo "✓ every setVisibleOnAllWorkspaces call keeps the process a foreground app"
