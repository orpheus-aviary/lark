/**
 * Renderer script for the media spike — an EXTERNAL file on purpose: the strict
 * CSP in index.html (`script-src 'self'`) blocks inline scripts, which is half
 * of what criterion 5 is verifying.
 *
 * Loaded as a classic script, not a module: `loadFile` serves from file://,
 * where module scripts are blocked by CORS.
 */

/* global document */

const SONG_ID = '9e107d9d-372b-4e39-a3ee-8b2f3d1c4a5b';
const BURST_SEEKS = 12;

const audio = document.getElementById('audio');
const logEl = document.getElementById('log');

function log(message) {
  const stamp = new Date().toISOString().slice(11, 23);
  logEl.textContent = `${stamp}  ${message}\n${logEl.textContent}`.slice(0, 8000);
  // Mirrored into the terminal by main's `console-message` hook, so the renderer
  // timeline can be read next to the server log without devtools.
  console.log(message);
}

function bufferedSummary() {
  const ranges = [];
  for (let i = 0; i < audio.buffered.length; i++) {
    ranges.push(`${audio.buffered.start(i).toFixed(1)}–${audio.buffered.end(i).toFixed(1)}`);
  }
  return ranges.length > 0 ? ranges.join(', ') : '(none)';
}

function seekToFraction(fraction) {
  if (!Number.isFinite(audio.duration)) {
    log(`seek skipped — duration unknown (readyState=${audio.readyState})`);
    return;
  }
  const target = audio.duration * fraction;
  audio.currentTime = target;
  log(`seek → ${target.toFixed(1)}s (buffered ${bufferedSummary()})`);
}

for (const type of [
  'loadedmetadata',
  'canplay',
  'playing',
  'waiting',
  'stalled',
  'seeking',
  'seeked',
  'ended',
]) {
  audio.addEventListener(type, () => {
    log(`${type} @ ${audio.currentTime.toFixed(1)}s / ${audio.duration.toFixed(1)}s`);
  });
}

audio.addEventListener('error', () => {
  const err = audio.error;
  log(`ERROR code=${err ? err.code : '?'} ${err ? err.message : ''}`);
});

document.getElementById('play').addEventListener('click', async () => {
  if (audio.paused) {
    await audio.play();
    log('play()');
  } else {
    audio.pause();
    log('pause()');
  }
});

// Criterion 2/3: the far end is guaranteed unbuffered by the server throttle,
// so this must produce a NEW request in the server log, not a silent in-buffer seek.
document.getElementById('seek-far').addEventListener('click', () => seekToFraction(0.9));

// Criterion 4: rapid out-of-order seeks. Every aborted response must release its
// file stream — watch `[spike] streams audio=N files=N` fall back to 1.
document.getElementById('burst').addEventListener('click', () => {
  log(`burst ${BURST_SEEKS} seeks`);
  for (let i = 0; i < BURST_SEEKS; i++) {
    setTimeout(() => seekToFraction(0.1 + (((i * 7) % 9) + 1) / 12), i * 60);
  }
});

// Criterion 6: a server restart aborts the in-flight media request and the
// element can land in an error state, after which seeking issues nothing. This
// is HTMLMediaElement semantics (a signed-URL scheme has it too), so recovery
// via load() on the SAME token-free src is a legitimate way to reach the goal.
document.getElementById('recover').addEventListener('click', () => {
  log('load() then seek — recovering after a server restart');
  audio.load();
  audio.addEventListener('loadedmetadata', () => seekToFraction(0.9), { once: true });
});

audio.src = `lark-media://song/${SONG_ID}`;
log(`src = ${audio.src}`);
