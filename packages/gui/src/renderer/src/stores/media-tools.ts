// What this daemon can do, as the GUI sees it (M7-18).
//
// The daemon is the only one who knows: it owns the registry, the four-level
// resolution and the capability probe. So the GUI never looks for a binary —
// it reads `GET /api/capabilities` and renders the verdict. Named for
// `media_tools` because that was the whole answer until 0.3.0 added
// `llm_available`; both come from the same response, and asking twice for one
// payload would be worse than a store whose name lags its contents.
//
// Its own lane, like `cache-status`: a settings dialog reopened mid-flight
// supersedes the older request instead of racing it.

import type { CapabilitiesData, MediaToolsInfo } from '@lark/shared';
import { API_PATHS, request } from '@lark/shared';
import { create } from 'zustand';
import { createLane } from '../lib/lanes.js';

const lane = createLane();

interface MediaToolsState {
  /** `null` until the first answer arrives — "unknown", not "broken". */
  info: MediaToolsInfo | null;
  /**
   * Is an LLM configured (§3.6-1)? `null` until the first answer, and treated
   * as "assume it is there" by the UI: greying out `clean` on a daemon that
   * simply has not answered yet would be the same lie in the other direction.
   */
  llmAvailable: boolean | null;
  refresh: () => void;
}

export const useMediaTools = create<MediaToolsState>((set) => ({
  info: null,
  llmAvailable: null,

  refresh: () => {
    void lane
      .run((signal) =>
        request<CapabilitiesData>('GET', API_PATHS.capabilities, undefined, { signal }),
      )
      .then((envelope) => {
        if (envelope === null) return; // superseded; the newer run owns the state
        // Shape-checked rather than trusted: `media_tools` is only required
        // from LOCAL_API_VERSION 4, and "unknown" has to stay distinguishable
        // from "no ffmpeg" — the second one accuses the user's machine.
        const info = envelope.data?.media_tools;
        if (isMediaToolsInfo(info)) set({ info });
        const llm = envelope.data?.llm_available;
        if (typeof llm === 'boolean') set({ llmAvailable: llm });
      })
      .catch(() => {
        // Leave the last known answer in place. A failed capabilities fetch
        // means the daemon is unreachable, which the session banner already
        // says far better than a fake "no ffmpeg" would.
      });
  },
}));

function isMediaToolsInfo(value: unknown): value is MediaToolsInfo {
  const state = (value as MediaToolsInfo | undefined)?.state;
  return state === 'ready' || state === 'missing' || state === 'incompatible';
}

/** One sentence a user can act on, or `null` when everything is fine. */
export function mediaToolsWarning(info: MediaToolsInfo | null | undefined): string | null {
  if (info === null || info === undefined || info.state === 'ready') return null;
  return info.state === 'missing'
    ? '没有找到 ffmpeg，下载与导入都不可用 —— 运行 `brew install ffmpeg` 后重试。'
    : `ffmpeg 不可用：${info.detail ?? '原因未知'}`;
}
