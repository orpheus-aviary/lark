// The audio session lark plays under (N3a).
//
// Four conditions, not one switch — N0b-4b measured every one of them:
//
//   1. `shouldPlayInBackground` alone is not background playback. Android
//      stops it after about three minutes unless the player is ALSO active for
//      the lock screen (`driver.ts` does that half).
//   2. `interruptionMode: 'doNotMix'` is a requirement, not a preference:
//      expo-audio's own note says the lock screen controls need it.
//   3. `POST_NOTIFICATIONS` has to be asked for AT RUN TIME. Declaring it in
//      the manifest (`app.config.ts`) is only half — the spike's first soak ran
//      with `granted=false` and playback was perfect while the lock screen
//      stayed empty, because on Android 13+ the media notification IS the lock
//      screen controls.
//   4. The permission is asked on the FIRST PLAY, not at launch. A dialog on
//      cold start, before anything is playing, is a dialog with no context —
//      and the boot sequence already has the identity gate and the migration
//      on it (§2.2).
//
// Once per process. `configured` is the promise, not a boolean, so two taps
// racing to be the first play await the same configuration instead of running
// it twice.

import { requestNotificationPermissionsAsync, setAudioModeAsync } from 'expo-audio';

export interface AudioSessionState {
  /** False means playback works and the lock screen shows nothing (see 3). */
  notificationsGranted: boolean;
}

let configured: Promise<AudioSessionState> | null = null;

async function configure(): Promise<AudioSessionState> {
  await setAudioModeAsync({
    playsInSilentMode: true,
    interruptionMode: 'doNotMix',
    shouldPlayInBackground: true,
  });
  const permission = await requestNotificationPermissionsAsync();
  return { notificationsGranted: permission.granted };
}

export function ensureAudioSession(): Promise<AudioSessionState> {
  configured ??= configure();
  return configured;
}
