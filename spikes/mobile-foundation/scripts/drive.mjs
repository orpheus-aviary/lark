// HOST script (Node, desktop) — press the panel's buttons from here.
//
// Tapping fixed coordinates is how a run ends up measuring the wrong button:
// the panel grows a section, everything below it moves, and the screenshot
// afterwards still looks plausible. This finds the button by its LABEL in the
// accessibility tree (`uiautomator dump`), scrolls until it is on screen, and
// taps its centre.
//
// It also refuses to work when the spike is not in the foreground — twice
// during N0b the phone was showing one of the user's own apps and the evidence
// captured was of that (N0b-1 and N0b-2, both recorded in CLAUDE.md).
//
//   node scripts/drive.mjs dump                 # every label currently visible
//   node scripts/drive.mjs tap "Run contract"   # scroll to the top, then to it, tap it
//   node scripts/drive.mjs shot out.png         # screencap, foreground-checked
//   node scripts/drive.mjs top                  # what is actually in front
//
// Scrolling is slow and starts away from the screen edges on purpose: a fast
// swipe, or one that starts at the very bottom, is taken as the system home
// gesture and puts the spike in the background (N0b-1).

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const ANDROID_HOME = process.env.ANDROID_HOME ?? '/opt/homebrew/share/android-commandlinetools';
const ADB = `${ANDROID_HOME}/platform-tools/adb`;
const PACKAGE = 'com.orpheusaviary.lark.spike';

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
    console.error(`✗ the spike is not in front — ${top} is.`);
    console.error('  `pidof` would have said yes anyway; that is why this checks the activity.');
    process.exit(2);
  }
}

/** Every labelled node with its centre, in draw order. */
function visibleNodes() {
  adb('shell', 'uiautomator', 'dump', '/sdcard/lark-spike-dump.xml');
  const xml = adb('shell', 'cat', '/sdcard/lark-spike-dump.xml');
  const nodes = [];
  for (const m of xml.matchAll(/text="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)) {
    const [, text, x1, y1, x2, y2] = m;
    if (text.trim() === '') continue;
    nodes.push({
      text,
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

function tapByText(needle, { attempts = 12 } = {}) {
  requireForeground();
  scrollToTop();
  for (let i = 0; i < attempts; i += 1) {
    const node = visibleNodes().find((n) => n.text.includes(needle));
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

const [command, argument] = process.argv.slice(2);

switch (command) {
  case 'top':
    console.log(topActivity());
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
  case 'shot': {
    requireForeground();
    const out = argument ?? '.runtime/shot.png';
    writeFileSync(out, adbRaw('exec-out', 'screencap', '-p'));
    console.log(`wrote ${out}`);
    break;
  }
  default:
    console.error('commands: top | dump | tap "<label>" | shot [file]');
    process.exit(64);
}
