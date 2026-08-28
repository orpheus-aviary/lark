#!/usr/bin/env bash
# Every Enter handler in the renderer asks the input method first (0.5.0 ①).
#
# 🔴 WHAT THIS EXISTS FOR. Chromium reports `e.key === 'Enter'` for the Enter
# that picks an IME candidate, so a handler that only reads `key` commits the
# pinyin. Before 0.5.0 `isComposing` was a repo-wide zero-hit and ALL FIVE
# handlers were wrong the same way — this is a reflex, not one slip, and the
# sixth one somebody adds will be wrong too.
#
# FILE-LEVEL, NOT LINE-LEVEL, ON PURPOSE. A row-activation handler (SongRow's
# table row) legitimately needs no guard, and pinning the check to a line would
# either fail that one or need an exception list that goes stale. Asking that a
# file which handles Enter also mentions `isComposingKey` is coarse but has no
# false positives in either direction that matter: the unit tests are what say
# the guard is in the RIGHT handler.

set -u
DIR="packages/gui/src/renderer/src"

missing=""
while IFS= read -r file; do
  [ -n "$file" ] || continue
  case "$file" in *.test.ts|*.test.tsx) continue ;; esac
  if ! rg --quiet 'isComposingKey' "$file"; then
    missing="$missing$file"$'\n'
  fi
done <<< "$(rg --files-with-matches --glob '*.tsx' --glob '*.ts' "key === 'Enter'" "$DIR" || true)"

if [ -n "$missing" ]; then
  echo "✗ an Enter handler does not ask the input method first"
  echo "  Guard it with \`isComposingKey\` from \`lib/ime.ts\`: an IME's commit"
  echo "  key reports \`key === 'Enter'\` too, and submitting there sends the"
  echo "  pinyin instead of the word."
  echo "$missing" | sed 's/^/  /'
  exit 1
fi

echo "✓ every renderer Enter handler goes through the IME check"
