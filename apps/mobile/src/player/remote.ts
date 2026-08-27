// What a car stereo asked for, in this app's vocabulary (0.1.1 ⑬).
//
// The request comes from outside the app — an AVRCP passthrough from a head
// unit, a headset button, the lock screen, the notification — and lands as an
// expo-audio `remoteCommand` event carrying `{ command: 'next' | 'previous' }`
// (`patches/expo-audio@57.0.3.patch`). Two vocabularies meet here: the media
// session says `previous`, `decideNext` says `prev`, and a translation done at
// the call site is a translation nobody can test.
//
// 🔴 AN UNRECOGNISED COMMAND IS `null`, NOT A GUESS. The payload crosses a
// native boundary that a patched dependency owns: a version of the module that
// sends something this build does not know about must do NOTHING, because the
// alternative is a car stereo whose 上一首 skips forward. It is also the shape
// an OTA JS update lands in — new JavaScript against the native code already
// installed — so "unknown" is a state this file will really be in one day.

import type { QueueTrigger } from '@lark/shared';

/**
 * The trigger this payload asks for, or `null` when it asks for nothing this
 * build understands.
 *
 * `ended` is deliberately not reachable from here: nothing outside the app can
 * claim a song finished, and `decideNext` treats that trigger differently
 * (rule 3 — whether a list may spend data on its own).
 */
export function remoteTriggerOf(payload: unknown): QueueTrigger | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const command = (payload as { command?: unknown }).command;
  if (command === 'next') return 'next';
  if (command === 'previous') return 'prev';
  return null;
}
