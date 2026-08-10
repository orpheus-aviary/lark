// Turning a native-ABI probe into something the reader can act on (M7-14).
//
// The probe reports a REASON; the repair depends on where this `lark` came
// from, and only the CLI knows that:
//
//   in the repo   `just test-core` rebuilds for Node, `just dev` for Electron
//   installed     there is no justfile — reinstall or rebuild the module
//
// Guessing wrong is worse than saying less: telling someone who installed from
// npm to run a just recipe sends them looking for a repository they do not
// have.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NativeAbiProbe } from '@lark/core/native-probe';
import { CliError } from './errors.js';

/**
 * Is this build running out of the workspace?
 *
 * Same walk as `workspaceRoot()`, minus the throwing: here "no workspace" is
 * an answer rather than a failure.
 */
export function inWorkspace(from: string = fileURLToPath(import.meta.url)): boolean {
  let dir = dirname(from);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

export interface AbiMessageOptions {
  /** Test seam, and the seam accept-pack uses to check both phrasings. */
  workspace?: boolean;
}

export function abiErrorMessage(
  probe: Extract<NativeAbiProbe, { ok: false }>,
  options: AbiMessageOptions = {},
): string {
  const workspace = options.workspace ?? inWorkspace();
  if (probe.reason === 'abi-mismatch') {
    const fix = workspace
      ? '跑一次 `just test-core`（会自愈到 Node ABI）或 `just dev`（Electron ABI）后重试。'
      : '重装 lark（`npm i -g @orpheus-aviary/lark-cli`），或在安装目录里跑 `npm rebuild better-sqlite3`。';
    return `better-sqlite3 是为另一个运行时（Node / Electron）编译的，当前进程加载不了它。${fix}\n${probe.detail}`;
  }
  return `无法加载原生模块 better-sqlite3：${probe.detail}`;
}

/** `ABI_MISMATCH` (exit 3) for either failure — both mean "not this runtime". */
export function abiError(
  probe: Extract<NativeAbiProbe, { ok: false }>,
  options: AbiMessageOptions = {},
): CliError {
  return new CliError('ABI_MISMATCH', abiErrorMessage(probe, options));
}
