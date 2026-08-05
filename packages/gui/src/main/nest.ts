// Nest identity for the GUI process (M4-4). Electron-free so the cold-start
// path is unit-testable.

import { mkdirSync, realpathSync } from 'node:fs';
import { larkDir } from '@lark/core/paths';

/**
 * The very first thing main does — BEFORE taking the single-instance lock,
 * which needs this identity in its `additionalData`.
 *
 * The mkdir is not optional tidiness: today the lark data directory is created
 * by daemon boot, so on a cold start against an empty nest the GUI reaches
 * this point first and `realpathSync` would throw ENOENT. Idempotent, so the
 * normal path costs one stat.
 */
export function ensureNestIdentity(): { larkDirPath: string; realLarkDir: string } {
  const larkDirPath = larkDir();
  mkdirSync(larkDirPath, { recursive: true });
  return { larkDirPath, realLarkDir: realpathSync(larkDirPath) };
}

/**
 * `additionalData` a second instance sent with the lock request. Electron
 * hands it over as `unknown` (it crossed a process boundary); a malformed
 * shape must read as "not my nest", never throw.
 */
export function nestDirFromAdditionalData(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const value = (data as Record<string, unknown>).nest_dir;
  return typeof value === 'string' ? value : null;
}
