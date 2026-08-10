// The packaged app (M7-1, M7-16).
//
// A .mjs config rather than owl's .yml because one thing here is conditional:
// a `bundled` release carries ffmpeg in `Resources/ffmpeg` and a `system` one
// carries none. Everything else is owl's baseline.
//
// The mode arrives as `LARK_FFMPEG_MODE`, set by the `just package` recipe.
// It is re-validated here rather than trusted, because this file is also
// reachable through `pnpm package` directly and an unset variable must not
// silently produce a `system` build labelled `bundled`.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GUI_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(GUI_DIR, '../..');

const MODES = ['bundled', 'system', 'fixture'];
const mode = process.env.LARK_FFMPEG_MODE;
if (!MODES.includes(mode)) {
  throw new Error(
    `LARK_FFMPEG_MODE must be one of ${MODES.join(' | ')}, got ${JSON.stringify(mode)} — use \`just package [bundled|system]\``,
  );
}

/**
 * Where the ffmpeg to embed comes from.
 *
 * `fixture` is the mechanism-only build (M7-16/H6): it exercises extraResources
 * copying, the env injection and the bundle level of the resolver with a stub,
 * and lands in `release/fixture/` so it can never be mistaken for something
 * publishable. `just package bundled` re-verifies the vendored toolchain
 * against the lock every time, which a stub cannot pass.
 */
const FFMPEG_SOURCE = {
  bundled: join(ROOT, 'vendor/ffmpeg'),
  fixture: join(GUI_DIR, 'test/fixtures/ffmpeg-stub'),
  system: null,
};

const ffmpegDir = FFMPEG_SOURCE[mode];
if (ffmpegDir !== null && !existsSync(ffmpegDir)) {
  throw new Error(`${mode} build needs ${ffmpegDir} — run \`just fetch-ffmpeg\``);
}

const NOTICES = join(GUI_DIR, `release/staging/${mode}/THIRD-PARTY-NOTICES.md`);

export default {
  appId: 'com.orpheusaviary.lark',
  productName: 'Lark',
  directories: {
    // Per mode, so a bundled and a system build of the same version cannot
    // overwrite each other and the release gate always names which it took.
    output: `release/${mode}`,
    buildResources: 'resources',
  },

  files: [
    'out/**',
    'package.json',
    '!**/*.{ts,map,flow}',
    '!**/node_modules/*/{test,tests,__tests__,example,examples,doc,docs}/**',
  ],
  // Workspace deps (@lark/core, @lark/daemon and their transitive deps) come in
  // through packages/gui/package.json's dependencies — "path A", the shape owl
  // proved in 0.6.2.

  // better-sqlite3's .node and the ffmpeg binaries both have to be real files
  // on disk that dlopen and execve can reach (R17).
  asar: false,

  mac: {
    target: [{ target: 'dmg', arch: ['arm64'] }],
    category: 'public.app-category.music',
    icon: 'resources/icon.icns',
    // No notarisation, no hardened runtime: this is an ad-hoc signed personal
    // build (R28). Signing at all is not optional — macOS Sequoia calls an
    // unsigned bundle "damaged".
    hardenedRuntime: false,
    gatekeeperAssess: false,
    identity: '-',
  },
  // electron-builder 25 treated `identity: '-'` as a keychain name and fell
  // through to "skip signing", which is why owl re-signs in afterPack. 26.x
  // claims to handle it; the acceptance criterion asserts the result either
  // way (`flags=0x2(adhoc)`), and this hook is idempotent, so it stays as the
  // belt to that config's braces.
  afterPack: 'scripts/codesign-adhoc.mjs',

  dmg: {
    artifactName: 'Lark-${version}-${arch}.${ext}',
    writeUpdateInfo: false,
  },

  extraResources: [
    { from: NOTICES, to: '.' },
    { from: join(ROOT, 'LICENSE'), to: '.' },
    ...(ffmpegDir === null ? [] : [{ from: ffmpegDir, to: 'ffmpeg' }]),
  ],
};
