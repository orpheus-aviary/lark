// Somebody else's app handing lark a link (N4d-3, decisions p and e).
//
// THE HOOK IS AT THE ROOT AND THE DRAFT IS A MODULE SINGLETON, and neither is
// an implementation detail — they are decision p and decision e, and each fixes
// a way this feature is silently broken.
//
// WHY THE ROOT (decision p). `shell.tsx` renders the add tab CONDITIONALLY —
// `{tab === '添加' && <AddTab />}` — and the default tab is 歌曲. A share that
// launches the app cold therefore arrives while the only component that could
// read it does not exist. Worse, the payload is volatile: `resetOnBackground`
// is the library's default and MEASURED (N0b-4c) to clear both the hook's value
// and the native side when the app is backgrounded, so "it will still be there
// when they tap 添加" is not true either. The hook goes where something is
// always mounted — `App`, above the boot state — and what it collects waits
// here.
//
// WHERE IT GOES is `share/draft.ts` — an in-memory singleton, consumed once
// (decision e). It is a separate file because it imports nothing and can
// therefore be tested; this one cannot, since importing it loads a native
// module.
//
// WHAT IT KEEPS IS THE RAW TEXT. bilibili 8.83.0 sends 「标题 空格 短链」 with
// `EXTRA_TITLE` empty (N0b-4c), and `webUrl` is the library's own extraction of
// the link out of it — recorded by the spike, deliberately never relied on.
// `downloads/preflight.ts` does that job with `parseSongInput` doing the
// judging, so the honest thing to hand it is what actually arrived.

import { useShareIntent } from 'expo-share-intent';
import { useEffect, useRef } from 'react';
import { putShareDraft } from './draft';

/**
 * Module constant, not an inline literal.
 *
 * `useShareIntent` puts `options` in effect dependency arrays, so a fresh
 * object every render is a fresh native subscription every render (the spike
 * hit this). `debug` is off: a release build has no logcat to send it to.
 */
const OPTIONS = { debug: false } as const;

/** The root's one line. Mount it above everything, including the boot state. */
export function useShareIntentBridge(): void {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent(OPTIONS);
  // The hook hands out a NEW object per delivery, so identity is the honest
  // "have I already taken this one" test — comparing text would collapse two
  // shares of the same video into one (the spike's `lastLogged`, same reason).
  const taken = useRef<unknown>(null);

  useEffect(() => {
    if (!hasShareIntent) return;
    if (taken.current === shareIntent) return;
    taken.current = shareIntent;

    putShareDraft(shareIntent.text ?? shareIntent.webUrl ?? '');
    // Clear the native side too. What we did not keep — a file share, an empty
    // one — is not something a later arrival should find lying around.
    resetShareIntent(true);
  }, [hasShareIntent, shareIntent, resetShareIntent]);
}
