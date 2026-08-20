// HOST script (Node, desktop) — criterion 3b (N3a).
//
// Reads the merged manifest of the BUILT APK, not `app.config.ts`. The config
// file is an intention; the manifest inside the apk is what Android reads, and
// it is the only place a plugin default that came back on an SDK upgrade would
// show up. Same instrument and same reasoning as the backup audit (N0b-5a),
// which is where the "read the apk, not the source" rule was learned.
//
// Three questions:
//
//   1. POST_NOTIFICATIONS is declared. On Android 13+ the media notification
//      IS the lock screen controls, so without it playback works and the lock
//      screen stays empty — how the spike's first soak failed.
//   2. RECORD_AUDIO is NOT declared. `expo-audio`'s plugin asks for the
//      microphone by default; a music player that does is a permission dialog
//      nobody understands. `recordAudioAndroid: false` is what removes it, and
//      that option is exactly the kind of line an upgrade drops.
//   3. The media playback foreground service is registered — the other half of
//      background playback, added by `enableBackgroundPlayback`.
//
//     node scripts/audio-manifest-audit.mjs [apk]   # or: just mobile-audio-audit

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ANDROID_HOME = process.env.ANDROID_HOME ?? '/opt/homebrew/share/android-commandlinetools';
const AAPT2 = `${ANDROID_HOME}/build-tools/36.0.0/aapt2`;
const APP_ROOT = process.env.LARK_APP_ROOT ?? fileURLToPath(new URL('..', import.meta.url));
const APK = process.argv[2] ?? `${APP_ROOT}/android/app/build/outputs/apk/release/app-release.apk`;

if (!existsSync(APK)) {
  console.error(`✗ no APK at ${APK}`);
  console.error('  build one first: just mobile-android-release');
  process.exit(2);
}

const manifest = execFileSync(AAPT2, ['dump', 'xmltree', APK, '--file', 'AndroidManifest.xml'], {
  encoding: 'utf-8',
  maxBuffer: 64 * 1024 * 1024,
});

console.log(`APK: ${APK}\n`);

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${name}\n    ${detail}`);
};

/** `uses-permission` entries carry the name as a literal string attribute. */
const declares = (permission) => manifest.includes(`"android.permission.${permission}"`);

check(
  'POST_NOTIFICATIONS is declared (= the lock screen controls can be shown)',
  declares('POST_NOTIFICATIONS'),
  declares('POST_NOTIFICATIONS')
    ? 'android.permission.POST_NOTIFICATIONS present'
    : 'MISSING — playback will work and the lock screen will stay empty',
);

check(
  'RECORD_AUDIO is NOT declared (recordAudioAndroid: false held)',
  !declares('RECORD_AUDIO'),
  declares('RECORD_AUDIO')
    ? "PRESENT — expo-audio's plugin default came back; a music player is asking for the microphone"
    : 'no microphone permission, as configured',
);

// The service class names come from expo-audio's own config plugin
// (`plugin/build/withAudio.js`), which is the only thing that puts them in the
// manifest — reading them from anywhere else would be inventing a contract.
const PLAYBACK_SERVICE = 'expo.modules.audio.service.AudioControlsService';
const RECORDING_SERVICE = 'expo.modules.audio.service.AudioRecordingService';

check(
  'the media-playback foreground service is registered',
  declares('FOREGROUND_SERVICE_MEDIA_PLAYBACK') && manifest.includes(PLAYBACK_SERVICE),
  [
    `FOREGROUND_SERVICE_MEDIA_PLAYBACK=${declares('FOREGROUND_SERVICE_MEDIA_PLAYBACK')}`,
    `${PLAYBACK_SERVICE}=${manifest.includes(PLAYBACK_SERVICE)}`,
  ].join(' · '),
);

// A DIFFERENT option, and saying so is the point. `recordAudioAndroid` gates
// the permission above; the recording service is gated by
// `enableBackgroundRecording` (`withAudio.js:71`), which we never set. Both
// were counter-tested by turning each one on and watching THIS line — and its
// neighbour — go red, one at a time. Calling this "the other half of
// recordAudioAndroid" would have been a sentence that reads well and is false.
check(
  'the recording service is NOT registered',
  !manifest.includes(RECORDING_SERVICE),
  manifest.includes(RECORDING_SERVICE)
    ? `PRESENT — ${RECORDING_SERVICE} came back with the plugin default`
    : 'no recording service, as configured',
);

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
