// A value that lags the one being typed (P2, 2026-09-02).
//
// The desktop has had this since D6, at 200ms
// (`packages/gui/.../TopBar.tsx`), and the phone never got it — so on a phone,
// which is the slower machine, every keystroke in a search box paid for a
// full-table LIKE, a `Intl.Collator('zh-CN')` sort and a rebuild of everything
// derived from the list. All of it thrown away by the next character.
//
// A JS TIMER IS THE RIGHT TOOL HERE, and that is worth one line because this
// repo has a guard against them. `check-mobile-no-js-timers.sh` covers
// `src/player/` only, and its own comment says why: the question is "is this
// wait still meaningful with the screen off", and only in there is the answer
// always yes. A search box is looked at by definition.

import { useEffect, useState } from 'react';

/** The desktop's number. A search that settles differently on two ends is two products. */
export const SEARCH_DEBOUNCE_MS = 200;

export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}
