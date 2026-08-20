// HOST script (Node, desktop) — press the panel's buttons from here.
//
// Tapping fixed coordinates is how a run ends up measuring the wrong button:
// the panel grows a section, everything below it moves, and the screenshot
// afterwards still looks plausible. This finds the button by its LABEL in the
// accessibility tree (`uiautomator dump`), scrolls until it is on screen, and
// taps its centre.
//
// It also refuses to work when the target app is not in the foreground — twice
// during N0b the phone was showing one of the user's own apps and the evidence
// captured was of that (N0b-1 and N0b-2, both recorded in docs/LESSONS.md).
//
// The target is `LARK_PACKAGE` / `LARK_APP_ROOT`, defaulting to the spike
// (N2a). `just mobile-drive` points it at `apps/mobile` instead — same driver,
// two apps, because the product deliberately does not share the spike's
// applicationId.
//
//   node scripts/drive.mjs dump                 # every label currently visible
//   node scripts/drive.mjs tap "Run contract"   # scroll to the top, then to it, tap it
//   node scripts/drive.mjs tap-visible "删除"    # tap what is on screen NOW — modals
//   node scripts/drive.mjs type "hello"          # into whatever holds focus (ASCII)
//   node scripts/drive.mjs shot out.png         # screencap, foreground-checked
//   node scripts/drive.mjs top                  # what is actually in front
//   node scripts/drive.mjs audio                # who is holding the speaker (criterion 19)
//   node scripts/drive.mjs senders              # who the system says handles a text share (24)
//   node scripts/drive.mjs share "text"         # ACTION_SEND into the spike, app left running
//   node scripts/drive.mjs share-cold "text"    # same, but force-stop first (the launch path)
//
// Scrolling is slow and starts away from the screen edges on purpose: a fast
// swipe, or one that starts at the very bottom, is taken as the system home
// gesture and puts the spike in the background (N0b-1).

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ANDROID_HOME = process.env.ANDROID_HOME ?? '/opt/homebrew/share/android-commandlinetools';
const ADB = `${ANDROID_HOME}/platform-tools/adb`;

// Which app on the phone (N2a). This used to be one hard-coded string, which
// was fine while the spike was the only thing installed and became a way to
// drive the wrong app the moment `apps/mobile` existed — the two are
// deliberately different packages. `just mobile-drive` sets both of these;
// bare `node scripts/drive.mjs` still means the spike, and every foreground
// refusal below prints the package it was looking for.
const PACKAGE = process.env.LARK_PACKAGE ?? 'com.orpheusaviary.lark.spike';
/** Where `.runtime/` lives — the host side of what the device POSTs back. */
const APP_ROOT = process.env.LARK_APP_ROOT ?? fileURLToPath(new URL('..', import.meta.url));

const adb = (...args) =>
  execFileSync(ADB, args, { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
const adbRaw = (...args) => execFileSync(ADB, args, { maxBuffer: 64 * 1024 * 1024 });

function topActivity() {
  const out = adb('shell', 'dumpsys', 'activity', 'activities');
  const line = out.split('\n').find((l) => l.includes('topResumedActivity=')) ?? '';
  const match = /topResumedActivity=ActivityRecord\{\S+ \S+ (\S+)/.exec(line);
  return match?.[1] ?? 'unknown';
}

function requireForeground() {
  const top = topActivity();
  if (!top.startsWith(PACKAGE)) {
    console.error(`✗ ${PACKAGE} is not in front — ${top} is.`);
    console.error('  `pidof` would have said yes anyway; that is why this checks the activity.');
    console.error('  (set LARK_PACKAGE if you meant to drive the other app.)');
    process.exit(2);
  }
}

/**
 * Every labelled node with its centre, in draw order.
 *
 * BOTH `text` and `content-desc`, and the second one arrived in N3c. Until
 * then every control in this app carried its label as visible text, so
 * matching `text` was enough — and `sheet.tsx` even wrote that constraint down
 * as a rule. A transport row cannot follow it: play, pause, next and the queue
 * are icons in every music player there is, and their label lives in
 * `accessibilityLabel`, which Android exposes as `content-desc`. Reading only
 * `text` made those buttons invisible to every run.
 *
 * A node can carry both; the visible text wins, because that is what a person
 * reading the screen would name.
 */
function visibleNodes() {
  adb('shell', 'uiautomator', 'dump', '/sdcard/lark-ui-dump.xml');
  const xml = adb('shell', 'cat', '/sdcard/lark-ui-dump.xml');
  const nodes = [];
  const pattern =
    /text="([^"]*)"[^>]*content-desc="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
  for (const m of xml.matchAll(pattern)) {
    const [, text, description, x1, y1, x2, y2] = m;
    const label = text.trim() === '' ? description : text;
    if (label.trim() === '') continue;
    nodes.push({
      text: label,
      x: Math.round((Number(x1) + Number(x2)) / 2),
      y: Math.round((Number(y1) + Number(y2)) / 2),
      bottom: Number(y2),
    });
  }
  return nodes;
}

function screenHeight() {
  const out = adb('shell', 'wm', 'size');
  const match = /Override size: (\d+)x(\d+)|Physical size: (\d+)x(\d+)/.exec(out);
  return Number(match?.[2] ?? match?.[4] ?? 2376);
}

function swipe(fromFraction, toFraction) {
  const height = screenHeight();
  // Start well inside the screen and take 400ms: at the edge, or faster, this
  // is the home gesture.
  adb(
    'shell',
    'input',
    'swipe',
    '540',
    String(Math.round(height * fromFraction)),
    '540',
    String(Math.round(height * toFraction)),
    '400',
  );
}

const scrollDown = () => swipe(0.75, 0.35);
const scrollUp = () => swipe(0.35, 0.75);

/**
 * Back to the top before searching.
 *
 * `tapByText` only ever scrolls DOWN, so a button ABOVE the current position is
 * invisible to it — and the panel ends every run scrolled to wherever the last
 * button was. Re-running an earlier panel then fails with "never found", which
 * reads like the button is gone rather than like the page is in the wrong
 * place (measured: the second bilibili run, N0b-4a).
 */
function scrollToTop() {
  for (let i = 0; i < 25; i += 1) scrollUp();
}

/**
 * Tap what is ALREADY on screen, without scrolling to find it.
 *
 * MEASURED (N2f): `tapByText` scrolls to the top first, and 25 swipes across
 * an open modal land on its backdrop — one of them registers as a press, the
 * sheet dismisses, and the label is then genuinely not there. Every result
 * that followed was of the screen behind it. So anything modal is driven with
 * this, and the scroll stays where it earned its place: long lists.
 */
function tapVisible(needle) {
  requireForeground();
  const node = pick(visibleNodes(), needle);
  if (!node) {
    console.error(`✗ nothing on screen contains "${needle}"`);
    process.exit(1);
  }
  adb('shell', 'input', 'tap', String(node.x), String(node.y));
  console.log(`tapped "${node.text}" at ${node.x},${node.y}`);
  return true;
}

/**
 * Type into whatever holds focus.
 *
 * `adb shell input text` is ASCII-only and takes %s for a space, which is why
 * acceptance names are ASCII: the criterion is that the write path works, and
 * the trimming and Chinese rules are the LibraryContract's to assert.
 */
function typeText(value) {
  requireForeground();
  // `input text` is ASCII-only: anything else comes back as a Java stack
  // trace out of `InputShellCommand.sendText`, which reads like a device
  // fault rather than "that character cannot be typed this way" (MEASURED).
  const offending = [...value].find((ch) => ch.charCodeAt(0) > 0x7f);
  if (offending !== undefined) {
    console.error(`✗ \`input text\` cannot type ${JSON.stringify(offending)} — ASCII only.`);
    console.error('  (a Chinese needle needs an IME; the contract covers that half instead.)');
    process.exit(1);
  }
  adb('shell', 'input', 'text', value.replace(/ /g, '%s'));
  console.log(`typed ${JSON.stringify(value)}`);
}

/**
 * EXACT match first, substring only as a fallback.
 *
 * MEASURED (N2f): the 设置 tab grew a field labelled `歌曲目录`, and every
 * `tap "歌曲"` after that pressed the field instead of the tab — silently,
 * because a label that contains the needle is a plausible answer. Substring
 * matching is still wanted (`Run file op scenarios` is tapped as a phrase),
 * but an exact hit is never the wrong one.
 */
function pick(nodes, needle) {
  return nodes.find((n) => n.text === needle) ?? nodes.find((n) => n.text.includes(needle));
}

function tapByText(needle, { attempts = 12 } = {}) {
  requireForeground();
  scrollToTop();
  for (let i = 0; i < attempts; i += 1) {
    const node = pick(visibleNodes(), needle);
    if (node) {
      adb('shell', 'input', 'tap', String(node.x), String(node.y));
      console.log(`tapped "${node.text}" at ${node.x},${node.y}`);
      return true;
    }
    scrollDown();
  }
  console.error(`✗ never found a node containing "${needle}" after ${attempts} scrolls`);
  process.exit(1);
}

/**
 * What the audio system says is playing, and which media session exists.
 *
 * JS cannot hear the speaker, so "release() stopped the sound" and "the
 * background service is still alive" are not questions the app can answer about
 * itself — `dumpsys audio` lists the active players by uid/state and
 * `dumpsys media_session` shows the session behind the lock screen controls.
 */
function audioState() {
  const audio = adb('shell', 'dumpsys', 'audio');
  const players = [];
  let inPlayers = false;
  for (const line of audio.split('\n')) {
    if (line.includes('players:')) {
      inPlayers = true;
      continue;
    }
    if (inPlayers) {
      if (line.trim() === '' || /^\s*[a-z].*:\s*$/i.test(line)) break;
      players.push(line.trimEnd());
    }
  }
  const active = players.filter((l) => l.includes('state:started'));
  console.log(`active players (state:started): ${active.length}`);
  for (const line of active) console.log(`  ${line.trim()}`);
  if (active.length === 0 && players.length > 0) {
    console.log('  (idle/paused entries only)');
  }

  const sessions = adb('shell', 'dumpsys', 'media_session');
  const ours = sessions.split('\n').filter((l) => l.includes(PACKAGE));
  console.log(`media sessions mentioning ${PACKAGE}: ${ours.length}`);
  for (const line of ours.slice(0, 6)) console.log(`  ${line.trim()}`);
}

/** Quote for the DEVICE's shell: `adb shell` joins our argv into one line. */
const deviceQuote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Hand the spike a text share the way another app would (criterion 24).
 *
 * `-p <package>` sets Intent.setPackage instead of naming the component with
 * `-n`: the intent still has to MATCH an intent-filter inside the package, so
 * this exercises the filter the config plugin added. Naming the activity
 * directly would start it whether or not the app is advertised as a share
 * target, which is most of what the criterion is asking about.
 */
async function sendShare(text, { cold }) {
  const sentAt = Date.now();
  if (cold) {
    // The launch path: no process, so the intent goes through the singleton
    // that the lifecycle listener fills in `onCreate`.
    adb('shell', 'am', 'force-stop', PACKAGE);
  }
  const out = adb(
    'shell',
    'am',
    'start',
    '-a',
    'android.intent.action.SEND',
    '-t',
    'text/plain',
    '-p',
    PACKAGE,
    '--es',
    'android.intent.extra.TEXT',
    deviceQuote(text),
  );
  console.log(out.trim());
  console.log(`sent ${cold ? 'cold' : 'warm'} share (${[...text].length} chars)`);
  await confirmArrival(text, sentAt);
}

/**
 * Compare what came back with what went out, character for character.
 *
 * Reading the text off the screen proves it arrived and looks right; a screen
 * cannot show a trailing newline, a stripped emoji or a `%20` that used to be a
 * space. The device POSTs every arrival to the probe host, so the file it wrote
 * is the copy that can be diffed — which is why this needs
 * `just spike-mobile-probe-host` running.
 */
async function confirmArrival(text, sentAt) {
  const dir = `${APP_ROOT}/.runtime/`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const newest = (existsSync(dir) ? readdirSync(dir) : [])
      .filter((f) => f.startsWith('share-intent-') && f.endsWith('.json'))
      .map((f) => ({ f, at: statSync(`${dir}${f}`).mtimeMs }))
      .filter((e) => e.at >= sentAt)
      .sort((a, b) => b.at - a.at)[0];
    if (newest) {
      const payload = JSON.parse(readFileSync(`${dir}${newest.f}`, 'utf-8'));
      const got = payload.arrival?.text ?? null;
      console.log(`arrival recorded in ${newest.f} (${payload.runtime})`);
      if (got === text) {
        console.log('✓ text round-tripped byte for byte');
        return;
      }
      console.error('✗ text differs');
      console.error(`  sent: ${JSON.stringify(text)}`);
      console.error(`  got:  ${JSON.stringify(got)}`);
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.error('✗ no arrival reached the probe host within 15s');
  console.error('  (is `just spike-mobile-probe-host` running? it is the only machine-readable');
  console.error('   channel on a release build — see N0b-3)');
  process.exit(1);
}

/**
 * Every activity the system would offer for a plain-text share.
 *
 * This is the objective half of "does lark show up in the share sheet" — the
 * sheet itself is a picture, this is the resolver's own answer.
 */
function shareTargets() {
  const out = adb(
    'shell',
    'cmd',
    'package',
    'query-activities',
    '-a',
    'android.intent.action.SEND',
    '-t',
    'text/plain',
    '--brief',
  );
  const lines = out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes('/'));
  const ours = lines.filter((l) => l.includes(PACKAGE));
  console.log(`text/plain SEND handlers: ${lines.length}`);
  for (const line of ours) console.log(`  ${line}`);
  if (ours.length === 0) {
    console.error(`✗ ${PACKAGE} is not among them`);
    process.exit(1);
  }
}

const [command, ...rest] = process.argv.slice(2);
// JOINED, not `rest[0]`. `just mobile-drive tap "Run file system scenarios"`
// loses the quoting on its way through just's `*ARGS`, so the needle used to
// arrive as "Run" — which matched the FIRST button whose label starts that
// way and reported a confident `tapped "Run D16 scenarios"`. MEASURED: an
// entire suite's results were read off the wrong panel.
const argument = rest.length > 0 ? rest.join(' ') : undefined;

switch (command) {
  case 'top':
    console.log(topActivity());
    break;
  case 'audio':
    audioState();
    break;
  case 'dump':
    requireForeground();
    for (const node of visibleNodes()) console.log(`${node.y}\t${node.text}`);
    break;
  case 'tap':
    if (!argument) {
      console.error('usage: drive.mjs tap "<label substring>"');
      process.exit(64);
    }
    tapByText(argument);
    break;
  case 'tap-visible':
    if (!argument) {
      console.error('usage: drive.mjs tap-visible "<label substring>"');
      process.exit(64);
    }
    tapVisible(argument);
    break;
  case 'type':
    if (!argument) {
      console.error('usage: drive.mjs type "<ascii text>"');
      process.exit(64);
    }
    typeText(argument);
    break;
  case 'senders':
    shareTargets();
    break;
  case 'share':
  case 'share-cold':
    if (!argument) {
      console.error('usage: drive.mjs share|share-cold "<text to share>"');
      process.exit(64);
    }
    await sendShare(argument, { cold: command === 'share-cold' });
    break;
  case 'shot': {
    requireForeground();
    const out = argument ?? '.runtime/shot.png';
    writeFileSync(out, adbRaw('exec-out', 'screencap', '-p'));
    console.log(`wrote ${out}`);
    break;
  }
  default:
    console.error(
      'commands: top | audio | senders | dump | tap "<label>" | tap-visible "<label>" | type "<text>" | share[-cold] "<text>" | shot [file]',
    );
    process.exit(64);
}
