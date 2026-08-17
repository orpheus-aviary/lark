// Getting numbers off the phone.
//
// The numeric criteria run on a RELEASE build (§3.2a): no Metro, no dev menu,
// and no guarantee that `console.log` reaches logcat. Transcribing p95s off a
// screenshot is how a plan document acquires a typo that nobody can trace, so
// every panel also POSTs its result to the desktop probe host, which writes it
// to `.runtime/` as JSON.
//
// Deliberately fire-and-forget: no host running is the normal case during
// development, and a panel that failed because nobody was listening would be
// reporting on the wrong thing.

/** Where the desktop peer listens; the device reaches it through `adb reverse`. */
export const PROBE_HOST = 'http://localhost:8099';

export function reportToHost(name: string, payload: unknown): void {
  fetch(`${PROBE_HOST}/results/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {
    // Nobody listening. Expected whenever the panel is run by hand.
  });
}
