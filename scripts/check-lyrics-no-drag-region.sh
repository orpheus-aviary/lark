#!/usr/bin/env bash
# The floating lyric window is moved by the pointer, never by a drag region
# (0.5.0 §2.5 判据 19).
#
# 🔴 WHAT THIS EXISTS FOR. `-webkit-app-region: drag` is the obvious way to make
# a frameless window draggable, it was the first way this window did it, and it
# swallows EVERY mouse event over the region — so `mouseenter` never fired and
# the control bar, which is drawn only while the pointer is on the window, could
# not be reached at all. `no-drag` does not rescue it: that punches holes in
# elements already on screen, and the bar is not on screen yet. On top of it,
# macOS treats such a region as a title bar, which is where the stray
# right-click menu on the lyrics came from.
#
# 🔴 AND WHY IT IS A GUARD RATHER THAN A TEST. The component's own tests were
# green through all of it: jsdom fires `mouseEnter` at anything, and knows
# nothing about `-webkit-app-region`. Vitest stubs CSS imports to the empty
# string, so a test cannot read the stylesheet either. The only place this is
# observable without a screen is the source.

set -u
FILES="packages/gui/src/renderer/src/desktop-lyrics packages/gui/src/renderer/lyrics.html"

# The declaration, not the word: both files talk about why it is not here.
hits="$(rg --line-number -- '-webkit-app-region[[:space:]]*:' $FILES || true)"

if [ -n "$hits" ]; then
  echo "✗ the lyric window has a drag region again"
  echo "  A drag region eats every mouse event over it, so the control bar —"
  echo "  which only exists while the pointer is on the window — can never be"
  echo "  hovered. Move the window through the pointer gesture instead:"
  echo "  \`DesktopLyrics.tsx\` starts it, \`main/desktop-lyrics-gesture.ts\` does it."
  echo "$hits" | sed 's/^/  /'
  exit 1
fi

echo "✓ the lyric window is moved by the pointer, not by a drag region"
