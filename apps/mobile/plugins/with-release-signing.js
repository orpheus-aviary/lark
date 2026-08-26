// Signing the release APK with lark's own key (N6d, criterion 95).
//
// 🔴 WHAT THIS REPLACES. Expo's `build.gradle` template ships
// `signingConfig signingConfigs.debug` inside the RELEASE build type, with a
// comment telling you to fix it. Until this plugin existed, every APK from
// `just mobile-android-release` was signed with the Android debug key — a
// key every SDK install shares — and nothing in the repo said so, because
// `android/` is a CNG product and is not tracked. So the fix cannot be an edit
// to the generated file: the next `expo prebuild` would take it away.
//
// THE PASSWORD IS NEVER COPIED. `android-keystore/README.md` (decision g,
// 2026-08-18) is explicit: nothing puts it in the repository, in
// `gradle.properties`, in an environment file or in CI. So what travels
// through the environment is the DIRECTORY, and Gradle reads the 0600 password
// file itself at signing time — which is what that README already described
// this config would do.
//
// THE FALLBACK IS REAL AND IS COVERED ELSEWHERE. With no
// `LARK_KEYSTORE_DIR` the release type keeps the debug config, because the
// alternative — refusing at configuration time — would break every debug build
// and every fresh clone, which is most of what anyone runs. The failure mode
// that leaves is "a release APK signed with the debug key, silently", and the
// answer to it is not in this file: `just mobile-android-release` sets the
// property and then VERIFIES the built APK's certificate against the recorded
// SHA-256 (`just mobile-verify-apk`). A guard that reads the artifact cannot
// be fooled by a plugin that did not run.

const { withAppBuildGradle } = require('@expo/config-plugins');

/** Written into the generated file so a second pass can tell it already ran. */
const MARKER = 'lark release signing — plugins/with-release-signing.js';

/**
 * The Gradle property carrying the keystore directory.
 *
 * Set it as `ORG_GRADLE_PROJECT_LARK_KEYSTORE_DIR`, which Gradle turns into a
 * project property on its own — no `-P` to thread through Expo's CLI.
 */
const PROPERTY = 'LARK_KEYSTORE_DIR';

const SIGNING_CONFIG = `
        // ${MARKER}
        //
        // Reads the password from its own 0600 file at signing time. The only
        // thing this build is told is where the directory is.
        release {
            def larkKeystoreDir = project.findProperty('${PROPERTY}')
            if (larkKeystoreDir != null) {
                storeFile file("\${larkKeystoreDir}/lark-release.jks")
                storePassword file("\${larkKeystoreDir}/keystore-password.txt").text.trim()
                keyAlias 'lark'
                // One password for both, as generated (N0b-5b).
                keyPassword file("\${larkKeystoreDir}/keystore-password.txt").text.trim()
            }
        }
`;

const RELEASE_SIGNING_CONFIG = `signingConfig project.findProperty('${PROPERTY}') != null ? signingConfigs.release : signingConfigs.debug`;

/**
 * Insert the `release` signing config, and point the release build type at it.
 *
 * Both edits are anchored on structure rather than on the template's comment
 * text, and both THROW when the anchor is missing. An Expo upgrade that
 * reshapes this file should stop the build, not quietly leave it debug-signed —
 * which is the exact failure this plugin exists to end.
 */
function addReleaseSigning(contents) {
  if (contents.includes(MARKER)) return contents;

  const signingConfigs = contents.indexOf('signingConfigs {');
  if (signingConfigs === -1) {
    throw new Error(
      '[with-release-signing] no `signingConfigs {` block in the generated app/build.gradle',
    );
  }
  const afterOpen = signingConfigs + 'signingConfigs {'.length;
  let next = `${contents.slice(0, afterOpen)}${SIGNING_CONFIG}${contents.slice(afterOpen)}`;

  // The release build type's own line, found by walking from `buildTypes {` so
  // that the debug type's identical line above it cannot be hit by accident.
  const buildTypes = next.indexOf('buildTypes {');
  if (buildTypes === -1) {
    throw new Error(
      '[with-release-signing] no `buildTypes {` block in the generated app/build.gradle',
    );
  }
  const releaseType = next.indexOf('release {', buildTypes);
  if (releaseType === -1) {
    throw new Error('[with-release-signing] no `release {` build type to sign');
  }
  const debugLine = next.indexOf('signingConfig signingConfigs.debug', releaseType);
  if (debugLine === -1) {
    throw new Error(
      '[with-release-signing] the release build type does not carry the template’s `signingConfig signingConfigs.debug` — check what it points at now before assuming this plugin is still needed',
    );
  }
  next =
    next.slice(0, debugLine) +
    RELEASE_SIGNING_CONFIG +
    next.slice(debugLine + 'signingConfig signingConfigs.debug'.length);

  return next;
}

module.exports = (config) =>
  withAppBuildGradle(config, (config) => {
    if (config.modResults.language !== 'groovy') {
      throw new Error(
        `[with-release-signing] app/build.gradle is ${config.modResults.language}, not groovy`,
      );
    }
    config.modResults.contents = addReleaseSigning(config.modResults.contents);
    return config;
  });
