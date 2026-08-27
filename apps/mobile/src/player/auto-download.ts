// 「自动下载下一首」 on this phone (0.1.1 ⑥).
//
// The rule it feeds is `@lark/shared`'s `decideNext` and it is shared with the
// desktop, which keeps its answer in `lark_config.toml`'s `playback` section.
// Only WHERE the answer lives differs; what it means does not.
//
// ON BY DEFAULT on both hosts. The rule it turns off — 「一首歌自然播完时不许
// 花流量」 — was written for a phone on mobile data (N4g-3), and it produces a
// list that plays in the order things happened to be downloaded rather than in
// the order it is written. Most of the time somebody who put a playlist on
// wants the playlist.

import type { DeviceSettingsPort, StructuredLogger } from '@lark/core/portable';

export const AUTO_DOWNLOAD_NEXT_KEY = 'auto_download_next';

/** On. See the header. */
export const DEFAULT_AUTO_DOWNLOAD_NEXT = true;

/**
 * `'1'` and `'0'`, the same spelling `sync_allow_insecure` uses — one shape
 * for every boolean in this file rather than a second way to write `true`.
 *
 * A value this build cannot read is the DEFAULT rather than `false`: reading
 * an unknown string as "off" would silently take the feature away from
 * somebody who never turned it off.
 */
export function readAutoDownloadNext(
  settings: DeviceSettingsPort,
  logger?: StructuredLogger,
): boolean {
  const stored = settings.get(AUTO_DOWNLOAD_NEXT_KEY);
  if (stored === undefined) return DEFAULT_AUTO_DOWNLOAD_NEXT;
  if (stored === '1') return true;
  if (stored === '0') return false;
  logger?.warn(
    { key: AUTO_DOWNLOAD_NEXT_KEY, stored },
    `${AUTO_DOWNLOAD_NEXT_KEY} is not a value this build wrote — reading it as the default`,
  );
  return DEFAULT_AUTO_DOWNLOAD_NEXT;
}

export async function writeAutoDownloadNext(
  settings: DeviceSettingsPort,
  on: boolean,
): Promise<void> {
  await settings.set({ [AUTO_DOWNLOAD_NEXT_KEY]: on ? '1' : '0' });
}
