#!/usr/bin/env node
// Build (or verify) the vendored ffmpeg/ffprobe for a `bundled` release.
//
//   node scripts/vendor-ffmpeg.mjs           build if missing, then verify
//   node scripts/vendor-ffmpeg.mjs --verify  verify only; never builds
//   node scripts/vendor-ffmpeg.mjs --force   rebuild from scratch
//
// Everything it needs is in `vendor/ffmpeg.lock.json`. Nothing here decides
// policy: the capability list comes from `@lark/core/media-tools`, so the
// binaries this produces are checked against the SAME frozen list the daemon
// probes at runtime. Two lists would eventually disagree, and the one that
// mattered would be the one nobody was looking at.
//
// VERIFICATION IS FIVE THINGS, and the last is the one a fake cannot pass:
//
//   1. every source tarball matches its sha256 (checked at download time);
//   2. both binaries exist and are executable Mach-O files;
//   3. `-show_program_version` reports EXACTLY the configure line in the lock,
//      and that line contains no `--enable-nonfree`;
//   4. the frozen capability list is present, item by item;
//   5. every conversion lark actually performs is performed, on real files,
//      and ffprobe reads the result back (see CLOSED_LOOPS).
//
// A stub that prints plausible `-version` output satisfies 3 and dies on 5.
// That is deliberate: `just package bundled` runs this before every build, and
// it is the only thing standing between a stub and a release DMG.

import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'vendor');
const LOCK_PATH = join(VENDOR, 'ffmpeg.lock.json');
const BUILD = join(VENDOR, 'build');
const SRC = join(BUILD, 'src');
const PREFIX = join(BUILD, 'prefix');
const STAGE = join(BUILD, 'out');
const OUT = join(VENDOR, 'ffmpeg');
const FIXTURES = join(ROOT, 'scripts', 'fixtures');

const args = new Set(process.argv.slice(2));
const verifyOnly = args.has('--verify');
const force = args.has('--force');

const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
const say = (msg) => process.stdout.write(`[ffmpeg] ${msg}\n`);
const die = (msg) => {
  process.stderr.write(`[ffmpeg] ERROR: ${msg}\n`);
  process.exit(1);
};

// ─── Entry ─────────────────────────────────────────────

if (force) rmSync(OUT, { recursive: true, force: true });

if (!binariesPresent()) {
  if (verifyOnly) die(`no vendored ffmpeg at ${OUT} — run \`just fetch-ffmpeg\``);
  await build();
}
await verify();
say('vendored toolchain verified against the lock');

// ─── Build ─────────────────────────────────────────────

function binariesPresent() {
  return existsSync(join(OUT, 'ffmpeg')) && existsSync(join(OUT, 'ffprobe'));
}

function source(name) {
  const entry = lock.sources.find((s) => s.name === name);
  if (entry === undefined) die(`${name} is missing from the lock`);
  return entry;
}

async function build() {
  requireTool('make');
  requireTool('cc');

  mkdirSync(SRC, { recursive: true });
  mkdirSync(OUT, { recursive: true });

  const lame = source('LAME');
  const ffmpeg = source('FFmpeg');
  const lameArchive = await fetchSource(lame);
  const ffmpegArchive = await fetchSource(ffmpeg);

  buildLame(lame, lameArchive);
  buildFfmpeg(ffmpeg, ffmpegArchive);

  for (const name of ['ffmpeg', 'ffprobe']) {
    const built = join(STAGE, 'bin', name);
    if (!existsSync(built)) die(`the build finished but produced no ${name}`);
    execFileSync('/bin/cp', ['-p', built, join(OUT, name)]);
  }
  say(`installed into ${OUT}`);
}

/** Download (unless cached), then refuse anything whose digest is not the lock's. */
async function fetchSource(entry) {
  const archive = join(SRC, entry.archive);
  if (!existsSync(archive)) {
    // Two attempts per URL before moving on: both of these hosts have been
    // observed to drop a TLS handshake and then serve the same file fine a
    // minute later, and failing a four-minute build over that is silly.
    let lastError = null;
    for (const url of entry.urls) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        say(`fetching ${entry.name} ${entry.version} from ${url}`);
        try {
          execFileSync('curl', ['-sSL', '--fail', '--max-time', '300', '-o', archive, url], {
            stdio: ['ignore', 'ignore', 'pipe'],
          });
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          rmSync(archive, { force: true });
          if (attempt === 1) execFileSync('/bin/sleep', ['3']);
        }
      }
      if (lastError === null) break;
    }
    if (lastError !== null) {
      die(`could not download ${entry.name} from any of ${entry.urls.join(', ')}`);
    }
  }

  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
  if (digest !== entry.sha256) {
    rmSync(archive, { force: true });
    die(`${entry.archive} sha256 is ${digest}, the lock says ${entry.sha256}`);
  }
  say(`${entry.name} ${entry.version} sha256 ok`);
  return archive;
}

function buildLame(entry, archive) {
  const dir = join(BUILD, `lame-${entry.version}`);
  if (existsSync(join(PREFIX, 'lib', 'libmp3lame.a'))) {
    say('LAME already built');
    return;
  }
  rmSync(dir, { recursive: true, force: true });
  run('tar', ['-xf', archive, '-C', BUILD]);

  const env = macEnv();
  // `--disable-frontend`: only the library is used, and the CLI drags in extras.
  run('./configure', entry.configure.replace('<prefix>', PREFIX).split(' '), { cwd: dir, env });
  run('make', [`-j${cpus().length}`], { cwd: dir, env });
  run('make', ['install'], { cwd: dir, env });
  say('LAME built');
}

function buildFfmpeg(entry, archive) {
  const dir = join(BUILD, `ffmpeg-${entry.version}`);
  rmSync(dir, { recursive: true, force: true });
  rmSync(STAGE, { recursive: true, force: true });
  run('tar', ['-xf', archive, '-C', BUILD]);

  // The configure line is taken VERBATIM from the lock, and its paths are
  // relative to this directory — that is what makes the string that ends up
  // inside the binary identical on every machine, and therefore comparable.
  run('./configure', splitConfigure(lock.configure), { cwd: dir, env: macEnv() });
  run('make', [`-j${cpus().length}`], { cwd: dir, env: macEnv() });
  run('make', ['install'], { cwd: dir, env: macEnv() });
  say(`FFmpeg ${entry.version} built`);
}

function macEnv() {
  const min = `-mmacosx-version-min=${lock.target.macos_min}`;
  return { ...process.env, CFLAGS: `${min} -O2`, LDFLAGS: min };
}

/** Split on spaces, but keep `--x='a b'` in one piece. */
function splitConfigure(line) {
  return (line.match(/(?:[^\s']+|'[^']*')+/g) ?? []).map((token) => token.replaceAll("'", ''));
}

function requireTool(name) {
  try {
    execFileSync('/usr/bin/which', [name], { stdio: 'ignore' });
  } catch {
    die(`${name} is required to build ffmpeg (install the Xcode command line tools)`);
  }
}

function run(command, commandArgs, options = {}) {
  try {
    execFileSync(command, commandArgs, { stdio: ['ignore', 'ignore', 'pipe'], ...options });
  } catch (err) {
    const stderr = err.stderr?.toString().trim().split('\n').slice(-20).join('\n') ?? '';
    die(`${command} failed\n${stderr}`);
  }
}

// ─── Verify ────────────────────────────────────────────

async function verify() {
  const { probeCapabilities } = await import('../packages/core/dist/media-tools/index.js');

  const tools = {
    ffmpeg: { path: join(OUT, 'ffmpeg'), source: 'bundle' },
    ffprobe: { path: join(OUT, 'ffprobe'), source: 'bundle' },
  };

  for (const [name, tool] of Object.entries(tools)) {
    const kind = execFileSync('/usr/bin/file', ['-b', tool.path]).toString();
    if (!kind.includes('Mach-O') || !kind.includes('arm64')) {
      die(`${name} is not a Mach-O arm64 executable: ${kind.trim()}`);
    }
  }

  const probe = await probeCapabilities(tools, { timeoutMs: 10_000 });
  if (probe.state !== 'ready') die(`${probe.state}: ${probe.detail}`);

  if (probe.configuration.includes('--enable-nonfree')) {
    die('this build is --enable-nonfree and cannot be redistributed');
  }
  if (probe.configuration !== lock.configure) {
    die(
      `configure does not match the lock.\n  binary: ${probe.configuration}\n  lock:   ${lock.configure}`,
    );
  }
  say(`capabilities ok (ffmpeg ${probe.version}, ${lock.license})`);

  await closedLoop(tools);
}

/**
 * One entry per conversion the shipped pipeline performs. `input` is resolved
 * lazily so the WAV can be synthesised without a fixture on disk.
 *
 * The mp3 fixture is checked in precisely because this list is about to lose
 * the ability to produce one: T1b removes LAME, and from then on the migration
 * loop's input can only be a file somebody kept.
 */
function closedLoops() {
  return [
    {
      label: 'WAV → AAC → m4a (import)',
      input: () => writeToneWav(),
      encode: ['-vn', '-c:a', 'aac', '-b:a', '192k', '-f', 'ipod'],
      out: 'closed-loop-import.m4a',
      format: 'm4a',
      codec: 'aac',
    },
    {
      label: 'M4A → copy → m4a (bilibili remux)',
      input: () => fixture('tone-1s.m4a'),
      encode: ['-vn', '-c', 'copy', '-f', 'ipod'],
      out: 'closed-loop-remux.m4a',
      format: 'm4a',
      codec: 'aac',
    },
    {
      label: 'MP3 → AAC → m4a (0.3.0 migration)',
      input: () => fixture('tone-1s.mp3'),
      encode: ['-vn', '-c:a', 'aac', '-b:a', '192k', '-f', 'ipod'],
      out: 'closed-loop-migration.m4a',
      format: 'm4a',
      codec: 'aac',
    },
    {
      // Legacy: what 0.2.x wrote. Dies with LAME in T1b.
      label: 'M4A → MP3 (0.2.x downloads)',
      input: () => fixture('tone-1s.m4a'),
      encode: ['-vn', '-acodec', 'libmp3lame', '-ab', '192k', '-ar', '44100', '-f', 'mp3'],
      out: 'closed-loop-legacy.mp3',
      format: 'mp3',
      codec: 'mp3',
    },
  ];
}

function fixture(name) {
  const path = join(FIXTURES, name);
  if (!existsSync(path)) die(`the closed-loop fixture is missing: ${path}`);
  return path;
}

/**
 * The same 440Hz tone the unit suites use, so there is one fixture story.
 *
 * Imported by exact path rather than through `@lark/core/testing`: that barrel
 * also carries the Go-era db fixture, which loads better-sqlite3 — and this
 * script runs whenever `just package` does, i.e. with the workspace binding
 * built for Electron's ABI, not Node's.
 */
async function writeToneWav() {
  const { toneWav } = await import('../packages/core/dist/testing/tone-wav.js');
  const path = join(BUILD, 'closed-loop-tone.wav');
  writeFileSync(path, toneWav(1));
  return path;
}

/** Every conversion in `closedLoops()`, with the binaries we are about to ship. */
async function closedLoop(tools) {
  for (const loop of closedLoops()) {
    await runClosedLoop(tools, loop);
  }
  writeBuildInfo();
}

async function runClosedLoop(tools, loop) {
  const input = await loop.input();
  const out = join(BUILD, loop.out);
  rmSync(out, { force: true });

  try {
    await execFileAsync(tools.ffmpeg.path, [
      '-nostdin',
      '-v',
      'error',
      '-i',
      input,
      ...loop.encode,
      '-y',
      out,
    ]);
  } catch (err) {
    die(`closed loop "${loop.label}" failed: ${err.stderr?.toString().trim() ?? err.message}`);
  }

  const { stdout } = await execFileAsync(tools.ffprobe.path, [
    '-v',
    'error',
    '-select_streams',
    'a:0',
    '-show_entries',
    'format=duration,format_name:stream=codec_name',
    '-of',
    'json',
    out,
  ]);
  assertProduced(loop, stdout);
  rmSync(out, { force: true });
  say(`closed loop ok — ${loop.label}`);
}

/** Container, codec and length: a copy that silently dropped the audio fails here. */
function assertProduced(loop, probeJson) {
  const probed = JSON.parse(probeJson);
  const format = probed.format;
  const codec = probed.streams?.[0]?.codec_name;
  if (!String(format?.format_name).split(',').includes(loop.format)) {
    die(`"${loop.label}" produced ${format?.format_name}, not ${loop.format}`);
  }
  if (codec !== loop.codec) {
    die(`"${loop.label}" produced a ${codec} stream, not ${loop.codec}`);
  }
  if (!(Number(format.duration) > 0.5)) {
    die(`"${loop.label}" produced ${format.duration}s of audio`);
  }
}

function writeBuildInfo() {
  writeFileSync(
    join(OUT, 'BUILD-INFO.json'),
    `${JSON.stringify(
      {
        profile: lock.profile,
        license: lock.license,
        configure: lock.configure,
        sources: lock.sources.map((s) => ({
          name: s.name,
          version: s.version,
          license: s.license,
          sha256: s.sha256,
          urls: s.urls,
        })),
      },
      null,
      2,
    )}\n`,
  );
}
