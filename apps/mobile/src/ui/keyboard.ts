// Where the keyboard is, for the two kinds of window that have to make room
// for it (2026-09-02).
//
// 🔴 NOTHING HERE IS A MEASURED CONSTANT. The numbers come from the event
// every time it is raised, so a taller IME, a candidate bar opening, a
// three-button navigation bar and a different phone are all the same code
// path. What one device's reading was good for was the yes/no question
// underneath: does `screenY` move at all once edge-to-edge stops the window
// from resizing (it does).
//
// TWO NUMBERS, BECAUSE THERE ARE TWO WINDOWS AND THEY DO NOT SHARE A BOTTOM:
//
//   `top` is the keyboard's top edge in SCREEN coordinates. The app's own
//   window is edge-to-edge — its content runs to the bottom of the display —
//   so what the keyboard takes from IT is `rootHeight - top`.
//
//   `height` is what RN reports, and RN computes it as
//   `ime.bottom - systemBars.bottom` (`ReactRootView.checkForKeyboardEvents`).
//   That is the right number for a window that already stops above the
//   navigation bar — which is exactly what a `Modal` is, because RN turns
//   edge-to-edge back OFF for its dialog (`ReactModalHostView`).
//
// The two always differ by the navigation bar, and they differ by the SAME
// navigation bar the dialog window gave up. That is why neither has to be
// corrected per device: the pair is structurally consistent, not calibrated.

import { useEffect, useState } from 'react';
import { Keyboard } from 'react-native';

export interface KeyboardMetrics {
  /** The keyboard's top edge, in screen coordinates. */
  top: number;
  /** What it covers of a window that stops above the navigation bar. */
  height: number;
}

/** The keyboard as it is now, or `null` while it is down. */
export function useKeyboard(): KeyboardMetrics | null {
  const [metrics, setMetrics] = useState<KeyboardMetrics | null>(null);
  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', (event) => {
      setMetrics({ top: event.endCoordinates.screenY, height: event.endCoordinates.height });
    });
    const hidden = Keyboard.addListener('keyboardDidHide', () => setMetrics(null));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);
  return metrics;
}

/** What the keyboard covers of a `Modal`'s dialog window. Zero when it is down. */
export function useKeyboardSheetInset(): number {
  return useKeyboard()?.height ?? 0;
}
