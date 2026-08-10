// Where ffmpeg and ffprobe come from (M7-3, M7-16).
//
// Four levels, most explicit first:
//
//   1. `LARK_FFMPEG_PATH` / `LARK_FFPROBE_PATH` — the user (or a test) naming a
//      binary outright. Set-but-unusable is an error, never a fallthrough:
//      silently ignoring an override is how you debug the wrong binary.
//   2. `LARK_MEDIA_TOOLS_DIR` — a DIRECTORY signal injected by whoever spawned
//      us (the CLI and the GUI both point it at `Resources/ffmpeg` when the app
//      bundle carries one). All-or-nothing: half a bundle is a broken build,
//      and quietly borrowing the user's Homebrew ffmpeg would make a `bundled`
//      release indistinguishable from a `system` one at runtime.
//   3. Homebrew's conventional prefixes. This level exists because of a
//      measured fact: an app launched from Finder/LaunchServices inherits no
//      shell PATH (`launchctl getenv PATH` is empty), so a GUI cold start would
//      never see `brew install ffmpeg` if PATH were the only fallback.
//   4. bare names through PATH — the dev-shell case, and the only one where the
//      binary's existence is unknown until it is executed.
//
// The static npm packages that used to sit at level 2 are gone: their binaries
// are `--enable-nonfree` and cannot be redistributed (M7 T0).

import { constants, accessSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type MediaToolSource = 'env' | 'bundle' | 'homebrew' | 'path';

export interface ResolvedTool {
  path: string;
  source: MediaToolSource;
}

export interface ResolvedMediaTools {
  ffmpeg: ResolvedTool;
  ffprobe: ResolvedTool;
}

export type ResolveOutcome =
  | { ok: true; tools: ResolvedMediaTools }
  | { ok: false; state: 'incompatible'; detail: string };

/** Homebrew on Apple silicon, then the Intel/legacy prefix. */
export const HOMEBREW_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'] as const;

export const MEDIA_TOOLS_DIR_ENV = 'LARK_MEDIA_TOOLS_DIR';

const TOOL_NAMES = ['ffmpeg', 'ffprobe'] as const;
type ToolName = (typeof TOOL_NAMES)[number];

const OVERRIDE_ENV: Record<ToolName, string> = {
  ffmpeg: 'LARK_FFMPEG_PATH',
  ffprobe: 'LARK_FFPROBE_PATH',
};

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  /** Test seam: the directories level 3 searches. */
  homebrewDirs?: readonly string[];
  /** Test seam: "is this an executable regular file". */
  isExecutableFile?: (path: string) => boolean;
  /** Test seam: "is this a directory". */
  isDirectory?: (path: string) => boolean;
}

export function resolveMediaTools(options: ResolveOptions = {}): ResolveOutcome {
  const env = options.env ?? process.env;
  const homebrewDirs = options.homebrewDirs ?? HOMEBREW_BIN_DIRS;
  const isExecutableFile = options.isExecutableFile ?? defaultIsExecutableFile;
  const isDirectory = options.isDirectory ?? defaultIsDirectory;

  const resolved: Partial<Record<ToolName, ResolvedTool>> = {};

  // 1 — explicit per-tool overrides.
  for (const name of TOOL_NAMES) {
    const override = env[OVERRIDE_ENV[name]];
    if (override === undefined || override === '') continue;
    if (!isExecutableFile(override)) {
      return {
        ok: false,
        state: 'incompatible',
        detail: `${OVERRIDE_ENV[name]} 指向的不是可执行文件：${override}`,
      };
    }
    resolved[name] = { path: override, source: 'env' };
  }

  // 2 — the bundle directory signal.
  const bundleDir = env[MEDIA_TOOLS_DIR_ENV];
  if (bundleDir !== undefined && bundleDir !== '') {
    if (!isDirectory(bundleDir)) {
      return {
        ok: false,
        state: 'incompatible',
        detail: `${MEDIA_TOOLS_DIR_ENV} 不是一个目录：${bundleDir}`,
      };
    }
    const incomplete = TOOL_NAMES.filter((name) => !isExecutableFile(join(bundleDir, name)));
    if (incomplete.length > 0) {
      return {
        ok: false,
        state: 'incompatible',
        detail: `应用包内的媒体工具不完整，${bundleDir} 缺少：${incomplete.join('、')}`,
      };
    }
    for (const name of TOOL_NAMES) {
      resolved[name] ??= { path: join(bundleDir, name), source: 'bundle' };
    }
  }

  // 3 and 4 — Homebrew's prefixes, then PATH.
  for (const name of TOOL_NAMES) {
    if (resolved[name] !== undefined) continue;
    const hit = homebrewDirs.map((dir) => join(dir, name)).find(isExecutableFile);
    resolved[name] =
      hit === undefined ? { path: name, source: 'path' } : { path: hit, source: 'homebrew' };
  }

  return {
    ok: true,
    tools: { ffmpeg: resolved.ffmpeg as ResolvedTool, ffprobe: resolved.ffprobe as ResolvedTool },
  };
}

function defaultIsExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
