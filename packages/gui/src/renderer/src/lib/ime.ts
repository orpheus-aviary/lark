// Whether a keystroke belongs to the input method rather than to the app (①).
//
// An IME's candidate window swallows the Enter that picks a word — but
// Chromium still reports `e.key === 'Enter'` for it, so a handler that only
// looks at `key` submits the pinyin instead of the word. Typing 「青花瓷」 in
// the download box searched bilibili for `qinghuaci`.
//
// This is not one handler that forgot: `isComposing` / `compositionstart` were
// a repo-wide zero-hit before 0.5.0. The app never had a composition layer, so
// this is the single place that answers "is this keystroke the IME's".

/** The slice of a React keyboard event this needs — the test stays React-free. */
export interface ComposingKeyEvent {
  readonly nativeEvent: { readonly isComposing?: boolean };
  readonly keyCode: number;
}

/**
 * Both signals are checked. `nativeEvent.isComposing` is the standard one;
 * `keyCode === 229` is the only thing older input methods send on some
 * platforms, and one of the two alone lets that case through.
 */
export function isComposingKey(e: ComposingKeyEvent): boolean {
  return e.nativeEvent.isComposing === true || e.keyCode === 229;
}
