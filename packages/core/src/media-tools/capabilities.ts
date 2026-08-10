// What "ffmpeg works" means here, frozen (M7-18).
//
// The old check was `-version` exiting 0. That is not a capability check: a
// three-line shell script passes it, and so does a real ffmpeg built without
// libmp3lame — which then fails at the end of a download, after the bytes are
// already on disk. Readiness is therefore the whole list below, verified item
// by item against ffmpeg's own inventory.
//
// The list is exactly what the pipeline asks for and nothing more:
//
//   file protocol       every input and output is a local path
//   demuxer mov         bilibili's DASH audio is fragmented MP4 (m4a/AAC)
//   demuxer mp3         re-probing the transcode result, and import
//   decoder aac         ditto — the input side
//   decoder mp3         ditto — the import side
//   encoder libmp3lame  the ONLY mp3 encoder; ffmpeg has no native one
//   muxer   mp3         `-f mp3` into songs/<uuid>/song.mp3
//   ffprobe JSON        `-print_format json`; probeAudio parses that
//
// Names are matched against comma-split inventory entries, because ffmpeg
// reports one demuxer as `mov,mp4,m4a,3gp,3g2,mj2` — asking for that literal
// string would break the day upstream adds a container to the list.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ResolvedMediaTools } from './resolve.js';

const execFileAsync = promisify(execFile);

/** Hard deadline per probe invocation. A tool slower than this is unusable. */
export const PROBE_TIMEOUT_MS = 2000;

export const REQUIRED_CAPABILITIES = {
  protocols: ['file'],
  demuxers: ['mov', 'mp3'],
  decoders: ['aac', 'mp3'],
  encoders: ['libmp3lame'],
  muxers: ['mp3'],
} as const;

export type CapabilityKind = keyof typeof REQUIRED_CAPABILITIES;

/** The `-<kind>` flag whose output is searched for each requirement. */
const INVENTORY_FLAG: Record<CapabilityKind, string> = {
  protocols: '-protocols',
  demuxers: '-demuxers',
  decoders: '-decoders',
  encoders: '-encoders',
  muxers: '-muxers',
};

export type MediaToolsState = 'ready' | 'missing' | 'incompatible';

export interface CapabilityProbeResult {
  state: MediaToolsState;
  /** Safe to show a user: no staging paths, no secrets. `null` when ready. */
  detail: string | null;
  /** ffprobe's reported version, when it answered. */
  version: string | null;
  /** ffprobe's configure string — what the packaging gate diffs. */
  configuration: string | null;
}

/**
 * Run one tool and return its stdout. Injected by tests so the matrix of
 * states (missing binary, hang, half-built ffmpeg) does not need real
 * binaries on disk.
 */
export type ToolRunner = (
  binary: string,
  args: readonly string[],
  signal: AbortSignal,
) => Promise<string>;

export interface CapabilityProbeOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  run?: ToolRunner;
}

const defaultRunner: ToolRunner = async (binary, args, signal) => {
  const { stdout } = await execFileAsync(binary, [...args], {
    signal,
    maxBuffer: 4 * 1024 * 1024, // `-decoders` on a full build is ~60KB
    windowsHide: true,
  });
  return stdout;
};

/**
 * Probe both tools. Never throws: the outcome IS the return value, because
 * every caller (capabilities route, download engine, import) has to render
 * the failure rather than propagate it.
 *
 * All six invocations run concurrently — they are independent, each is ~20ms,
 * and serialising them would put the worst case at six timeouts instead of one.
 */
export async function probeCapabilities(
  tools: ResolvedMediaTools,
  options: CapabilityProbeOptions = {},
): Promise<CapabilityProbeResult> {
  const run = options.run ?? defaultRunner;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const deadline = (): AbortSignal =>
    options.signal === undefined
      ? AbortSignal.timeout(timeoutMs)
      : AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]);

  const kinds = Object.keys(REQUIRED_CAPABILITIES) as CapabilityKind[];
  const [versionOutcome, ...inventoryOutcomes] = await Promise.all([
    attempt(() =>
      run(
        tools.ffprobe.path,
        ['-v', 'quiet', '-print_format', 'json', '-show_program_version'],
        deadline(),
      ),
    ),
    ...kinds.map((kind) =>
      attempt(() =>
        run(tools.ffmpeg.path, ['-hide_banner', '-v', 'quiet', INVENTORY_FLAG[kind]], deadline()),
      ),
    ),
  ]);

  // A tool that is not on disk is `missing` — the user installs something. A
  // tool that IS there and still cannot answer is `incompatible` — the user
  // replaces something. Conflating them sends people to the wrong fix.
  const notFound = [
    ...(isNotFound(versionOutcome.error) ? [tools.ffprobe.path] : []),
    ...(inventoryOutcomes.some((o) => isNotFound(o.error)) ? [tools.ffmpeg.path] : []),
  ];
  if (notFound.length > 0) {
    return fail('missing', `没有找到：${notFound.join('、')}`);
  }

  for (const [index, outcome] of inventoryOutcomes.entries()) {
    if (outcome.error !== undefined) {
      return fail(
        'incompatible',
        `ffmpeg ${INVENTORY_FLAG[kinds[index]]} 失败：${reason(outcome.error)}`,
      );
    }
  }
  if (versionOutcome.error !== undefined) {
    return fail('incompatible', `ffprobe 无法报告版本：${reason(versionOutcome.error)}`);
  }

  const gaps: string[] = [];
  for (const [index, kind] of kinds.entries()) {
    const inventory = parseInventory(kind, inventoryOutcomes[index].value ?? '');
    for (const required of REQUIRED_CAPABILITIES[kind]) {
      if (!inventory.has(required)) gaps.push(`${kind.slice(0, -1)} ${required}`);
    }
  }
  if (gaps.length > 0) {
    return fail('incompatible', `这个 ffmpeg 缺少：${gaps.join('、')}`);
  }

  const program = readProgramVersion(versionOutcome.value ?? '');
  if (program === null) {
    return fail('incompatible', 'ffprobe 的 -print_format json 没有输出可解析的 JSON');
  }
  return { state: 'ready', detail: null, ...program };
}

// ─── Inventory parsing ─────────────────────────────────

/**
 * ffmpeg's list output is a header, a rule, then one entry per line:
 *
 *     File formats:
 *      D.. = Demuxing supported
 *      ---
 *      D   mov,mp4,m4a,3gp,3g2,mj2 QuickTime / MOV
 *
 * so the name is the second whitespace-separated token, comma-split. The rule
 * is matched as "two or more dashes and nothing else" rather than a literal:
 * it is `--` in some sections and `---` in others, and the widths move between
 * releases (8.1 grew a device column).
 *
 * Protocols are the exception — a bare name per line under `Input:`/`Output:`.
 */
export function parseInventory(kind: CapabilityKind, stdout: string): ReadonlySet<string> {
  const names = new Set<string>();
  if (kind === 'protocols') {
    for (const line of stdout.split('\n')) {
      const name = line.trim();
      if (name === '' || name.endsWith(':')) continue;
      names.add(name);
    }
    return names;
  }

  let past = false;
  for (const line of stdout.split('\n')) {
    if (!past) {
      if (/^-{2,}$/.test(line.trim())) past = true;
      continue;
    }
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 2) continue;
    for (const name of tokens[1].split(',')) {
      if (name !== '') names.add(name);
    }
  }
  return names;
}

function readProgramVersion(stdout: string): { version: string; configuration: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const program = (parsed as { program_version?: { version?: unknown; configuration?: unknown } })
    ?.program_version;
  if (program === undefined || program === null) return null;
  return {
    version: typeof program.version === 'string' ? program.version : '',
    configuration: typeof program.configuration === 'string' ? program.configuration : '',
  };
}

// ─── Outcomes ──────────────────────────────────────────

interface Attempt {
  value?: string;
  error?: unknown;
}

async function attempt(fn: () => Promise<string>): Promise<Attempt> {
  try {
    return { value: await fn() };
  } catch (error) {
    return { error };
  }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function reason(error: unknown): string {
  const e = error as (NodeJS.ErrnoException & { killed?: boolean }) | undefined;
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError' || e?.killed === true) {
    return `超过 ${PROBE_TIMEOUT_MS}ms 没有响应`;
  }
  return e?.message ?? String(error);
}

function fail(state: 'missing' | 'incompatible', detail: string): CapabilityProbeResult {
  return { state, detail, version: null, configuration: null };
}
