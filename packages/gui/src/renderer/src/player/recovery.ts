// daemonGeneration recovery (M4-8). A new daemon process means a new token
// and new media URLs, so the media element is remounted — and a remount
// destroys everything the old element held: position, buffered data, the
// playing state. Restoring it is a state machine with a FAILURE terminal:
// waiting only for `loadedmetadata` would leave the player (and reporting)
// frozen forever whenever the new pipeline errors outright.
//
// Three outcomes race and exactly one settles: metadata, the element's own
// error event, and a timeout. `isCurrent` is the generation guard — a second
// daemon restart during recovery cancels this run rather than letting two
// recoveries write the same element.

import { errorMessage } from '../lib/errors.js';
import type { MediaElement } from './media.js';

export const RECOVERY_TIMEOUT_MS = 10_000;

export type RecoveryOutcome =
  | { ok: true }
  | { ok: false; reason: 'error' | 'timeout' | 'play-rejected' | 'superseded'; message: string };

export interface RecoveryDeps {
  audio: MediaElement;
  src: string;
  /** Where playback was when the old daemon went away. */
  position: number;
  /** The INTENT from before the outage — never the paused flag a media error left behind. */
  resume: boolean;
  /** False once a newer generation took over. */
  isCurrent: () => boolean;
  timeoutMs?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export async function runRecovery(deps: RecoveryDeps): Promise<RecoveryOutcome> {
  const { audio, isCurrent } = deps;

  const settled = new Promise<'metadata' | 'error' | 'timeout'>((resolve) => {
    let done = false;
    const finish = (result: 'metadata' | 'error' | 'timeout'): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      audio.removeEventListener('loadedmetadata', onMetadata);
      audio.removeEventListener('error', onError);
      resolve(result);
    };
    const onMetadata = (): void => finish('metadata');
    const onError = (): void => finish('error');
    const timer = setTimeout(() => finish('timeout'), deps.timeoutMs ?? RECOVERY_TIMEOUT_MS);
    audio.addEventListener('loadedmetadata', onMetadata);
    audio.addEventListener('error', onError);
  });

  audio.src = deps.src;
  audio.load();

  const outcome = await settled;
  if (!isCurrent()) return { ok: false, reason: 'superseded', message: '' };
  if (outcome === 'timeout') return { ok: false, reason: 'timeout', message: '媒体加载超时' };
  if (outcome === 'error') return { ok: false, reason: 'error', message: '媒体加载失败' };

  // A fresh element reports its own duration; before it does, trust the
  // position we saved rather than clamping it to zero.
  const limit =
    Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : deps.position;
  audio.currentTime = clamp(deps.position, 0, limit);

  if (!deps.resume) return { ok: true };
  try {
    await audio.play();
  } catch (err) {
    return { ok: false, reason: 'play-rejected', message: errorMessage(err) };
  }
  if (!isCurrent()) return { ok: false, reason: 'superseded', message: '' };
  return { ok: true };
}
