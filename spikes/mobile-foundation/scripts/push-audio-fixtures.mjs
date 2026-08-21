// HOST script — the two probe tracks, with the duration the device must
// reproduce (N4b, criteria 8 and the contract's `valid` scenario).
//
// The phone has no ffprobe. What criterion 8 asks is whether
// MediaMetadataRetriever — a DIFFERENT extractor from both ffprobe and the one
// ExoPlayer uses — reads the same length out of bilibili's raw fMP4 as ffprobe
// does, and a device that computed its own expectation would be grading itself.
// So the number is produced here, by core's real `probeAudio` over the real
// vendored ffprobe, and travels with the bytes.
//
// The two tracks are N0b-4a's, saved with no remux whatsoever (2:17 and 37:07).
// They are already in `spikes/mobile-foundation/fixtures/`, pushed there for
// the platform spike; this puts them where the PRODUCT's package can read
// them, which is a different app id and therefore a different external
// directory.
//
// THE APP MAKES THE DIRECTORY, NOT THIS (measured, N2f, and the same rule
// `mobile-push-fixture` carries): `adb push` to a path that does not exist yet
// creates the intermediate directories as `shell`, and the app is then denied
// at `Android/data`. So this pushes into `lark-fixture/audio/` — under the
// directory the acceptance build already creates through
// `LarkFs.externalDirectory` — and refuses if that is not there yet.
//
//     just mobile-acceptance-release
//     acceptance artifact → "Import pushed fixture"   (makes lark-fixture/)
//     just mobile-push-audio-fixtures

import { execFile } from 'node:child_process';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { probeAudio, resolveMediaTools } from '@lark/core';

const execFileAsync = promisify(execFile);

const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url));
const DEVICE_DIR = '/sdcard/Android/data/com.orpheusaviary.lark/files/lark-fixture/audio';
const ADB = `${process.env.ANDROID_HOME ?? '/opt/homebrew/share/android-commandlinetools'}/platform-tools/adb`;

const adb = async (...args) => (await execFileAsync(ADB, args)).stdout.trim();

const tools = resolveMediaTools();
if (!tools.ok) {
  console.error(`no usable ffprobe: ${tools.detail}`);
  console.error('run `just fetch-ffmpeg` first');
  process.exit(1);
}
const ffprobe = tools.tools.ffprobe.path;

// `short-…m4a` and `long-…m4a`, by prefix rather than by full name: the bvid is
// part of the filename and a re-made fixture may carry a different one.
const files = (await readdir(FIXTURE_DIR)).filter((name) => name.endsWith('.m4a')).sort();
if (files.length === 0) {
  console.error(`no .m4a fixtures in ${FIXTURE_DIR}`);
  console.error('run `node scripts/make-network-fixtures.mjs --audio` first');
  process.exit(1);
}

try {
  await adb('shell', 'test', '-d', DEVICE_DIR.replace(/\/audio$/, ''));
} catch {
  console.error(`${DEVICE_DIR.replace(/\/audio$/, '')} is not there yet.`);
  console.error(
    'tap "Import pushed fixture" once — the app has to create it, or nothing can read it.',
  );
  process.exit(1);
}

const entries = [];
for (const name of files) {
  const path = join(FIXTURE_DIR, name);
  const probe = await probeAudio(ffprobe, path);
  const { size } = await stat(path);
  const [key, bvid] = name.replace(/\.m4a$/, '').split('-');
  entries.push({
    name,
    // The key the device looks the expectation up by. `short` / `long` are
    // N0b-4a's names for these two.
    key,
    // Which video these bytes came from. Criterion 6 downloads it AGAIN, on the
    // phone, and compares what lands against `durationSec` below — so the
    // expectation still comes from the desktop's ffprobe, over the same part.
    bvid,
    bytes: size,
    durationSec: probe.duration,
    codec: probe.codec,
    container: probe.container,
  });
  console.log(`  ${name}: ${probe.duration}s · ${probe.codec} · ${(size / 1e6).toFixed(1)}MB`);
}

const manifest = join(tmpdir(), 'lark-audio-fixtures.json');
await writeFile(
  manifest,
  JSON.stringify({ ffprobe: tools.tools.ffprobe.source, entries }, null, 2),
);

await adb('shell', 'mkdir', '-p', DEVICE_DIR);
for (const entry of entries)
  await adb('push', join(FIXTURE_DIR, entry.name), `${DEVICE_DIR}/${entry.name}`);
// Last, so a half-finished push cannot look complete: the device reads the
// manifest to know what to look for.
await adb('push', manifest, `${DEVICE_DIR}/manifest.json`);
console.log(await adb('shell', 'du', '-sh', DEVICE_DIR));
