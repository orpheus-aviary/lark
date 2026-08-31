// "Which parts?" — raised by a refusal, answered as one batch (0.5.1 §7.3).
//
// 🔴 A HOOK RATHER THAN MORE OF `DownloadBar`. The flow is three pieces of
// state and two requests, and folding it into the bar pushed that component
// past the complexity ceiling — which is the lint rule doing its job: the bar
// is about an input and a status line, and this is a conversation.
//
// The refusal IS the question. A pasted link is classified offline, so nothing
// here knows a video has parts until the daemon says so — and it says so for
// free, because the preflight answers before a task exists. Probing every link
// instead would put a request in front of the single-part videos that are
// almost all of them.

import { ApiError, type DownloadNamingMode, type DownloadPartData } from '@lark/shared';
import { useState } from 'react';
import { errorMessage } from '../lib/errors.js';
import { useDownloads } from '../stores/download.js';

export interface PartsPrompt {
  bvid: string;
  title: string;
  parts: readonly DownloadPartData[];
  /**
   * The answer the person already gave in the naming dialog, carried across
   * the refusal: asking the same question twice in one submission reads as a
   * bug, not as care.
   */
  naming: DownloadNamingMode;
}

export interface UsePartsPrompt {
  prompt: PartsPrompt | null;
  submitting: boolean;
  /**
   * Was this the multi-part refusal? If so the parts are fetched and `prompt`
   * becomes non-null; the caller shows the dialog and stops treating the error
   * as an error. `false` means "not mine — report it".
   *
   * A failure to LIST the parts is reported through `onError` rather than
   * re-thrown: the person would otherwise be told to pick a part and given no
   * way to pick one.
   */
  offer: (bvid: string, err: unknown, naming: DownloadNamingMode) => Promise<boolean>;
  dismiss: () => void;
  /** Submit the picked pages as one atomic batch. Answers whether it went. */
  confirm: (
    pages: readonly number[],
    naming: DownloadNamingMode,
    playlistId: string | undefined,
  ) => Promise<boolean>;
}

export function usePartsPrompt(onError: (message: string) => void): UsePartsPrompt {
  const fetchParts = useDownloads((s) => s.fetchParts);
  const submitBatch = useDownloads((s) => s.submitBatch);
  const [prompt, setPrompt] = useState<PartsPrompt | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function offer(bvid: string, err: unknown, naming: DownloadNamingMode): Promise<boolean> {
    if (!(err instanceof ApiError) || err.errorCode !== 'MULTI_PART_UNRESOLVED') return false;
    try {
      const data = await fetchParts(bvid);
      setPrompt({ bvid, title: data.title, parts: data.parts, naming });
    } catch (partsErr) {
      onError(errorMessage(partsErr));
    }
    return true;
  }

  async function confirm(
    pages: readonly number[],
    naming: DownloadNamingMode,
    playlistId: string | undefined,
  ): Promise<boolean> {
    const current = prompt;
    if (current === null) return false;
    setSubmitting(true);
    try {
      await submitBatch([
        {
          target:
            playlistId === undefined
              ? { kind: 'all' }
              : { kind: 'playlist', playlist_id: playlistId },
          // NO `source`: these parts came from a pasted link, not from a list.
          // Inventing a list identity is a lie the download record then
          // repeats forever (0.5.0 ④).
          items: pages.map((page) => ({
            kind: 'video' as const,
            bvid: current.bvid,
            page,
            // `null`, deliberately: the pipeline reads the part's own title out
            // of the page list it fetches anyway (§7.4). Sending one here would
            // mean two sources for the same string, and they would drift.
            title: null,
            naming,
          })),
        },
      ]);
      setPrompt(null);
      return true;
    } catch (err) {
      onError(errorMessage(err));
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  return { prompt, submitting, offer, dismiss: () => setPrompt(null), confirm };
}
