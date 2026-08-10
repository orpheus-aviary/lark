import { describe, expect, it } from 'vitest';
import { parseInventory, probeCapabilities } from './capabilities.js';
import type { ResolvedMediaTools } from './resolve.js';

const TOOLS: ResolvedMediaTools = {
  ffmpeg: { path: '/bin/ffmpeg', source: 'path' },
  ffprobe: { path: '/bin/ffprobe', source: 'path' },
};

/**
 * Trimmed copies of REAL output, headers and rules verbatim — including the
 * `---` rule and the device column that ffmpeg 8.1 prints. The parser was
 * written against a `--` rule and reported a perfectly good Homebrew build as
 * missing every single capability.
 */
const INVENTORY: Record<string, string> = {
  '-protocols': 'Supported file protocols:\nInput:\n  file\n  pipe\nOutput:\n  file\n  pipe\n',
  '-demuxers':
    'Formats:\n D.. = Demuxing supported\n .E. = Muxing supported\n ..d = Is a device\n ---\n D   mov,mp4,m4a,3gp,3g2,mj2 QuickTime / MOV\n D   mp3             MP2/3 (MPEG audio layer 2/3)\n',
  '-decoders':
    'Decoders:\n V..... = Video\n ------\n A....D aac      AAC (Advanced Audio Coding)\n A....D mp3      MP3 (MPEG audio layer 3)\n A....D mp3float MP3 (MPEG audio layer 3)\n',
  '-encoders': 'Encoders:\n V..... = Video\n ------\n A....D libmp3lame  libmp3lame MP3\n',
  '-muxers': 'Formats:\n D.. = Demuxing supported\n ---\n  E  mp3             MP2/3\n',
};

const VERSION_JSON = JSON.stringify({
  program_version: { version: '8.1.2', configuration: '--enable-libmp3lame' },
});

interface StubOptions {
  inventory?: Record<string, string>;
  version?: string;
  fail?: (binary: string, args: readonly string[]) => Error | undefined;
}

function stubRunner(options: StubOptions = {}) {
  const inventory = { ...INVENTORY, ...options.inventory };
  return async (binary: string, args: readonly string[]): Promise<string> => {
    const failure = options.fail?.(binary, args);
    if (failure !== undefined) throw failure;
    if (args.includes('-show_program_version')) return options.version ?? VERSION_JSON;
    const flag = args.find((a) => a.startsWith('-') && a in inventory);
    return flag === undefined ? '' : inventory[flag];
  };
}

function errno(code: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(code);
  err.code = code;
  return err;
}

describe('parseInventory', () => {
  it('splits the comma-joined demuxer name so `mov` is findable', () => {
    const names = parseInventory('demuxers', INVENTORY['-demuxers']);
    expect(names.has('mov')).toBe(true);
    expect(names.has('m4a')).toBe(true);
    expect(names.has('mp3')).toBe(true);
  });

  it('ignores everything above the rule', () => {
    const names = parseInventory('demuxers', INVENTORY['-demuxers']);
    expect(names.has('=')).toBe(false);
    expect(names.has('Demuxing')).toBe(false);
  });

  it('accepts a rule of any width — 8.1 prints `---`, older builds `--`', () => {
    const twoDash = ' D. = Demuxing supported\n --\n D  mp3   MP3\n';
    expect(parseInventory('demuxers', twoDash).has('mp3')).toBe(true);
  });

  it('reads protocols from the Input/Output sections', () => {
    const names = parseInventory('protocols', INVENTORY['-protocols']);
    expect(names.has('file')).toBe(true);
    expect(names.has('Input')).toBe(false);
  });
});

describe('probeCapabilities', () => {
  it('is ready when the whole frozen list is present', async () => {
    const result = await probeCapabilities(TOOLS, { run: stubRunner() });
    expect(result).toMatchObject({ state: 'ready', detail: null, version: '8.1.2' });
    expect(result.configuration).toBe('--enable-libmp3lame');
  });

  // The old check was `-version` exiting 0, which this build passes.
  it('is incompatible when ffmpeg runs but cannot encode mp3', async () => {
    const result = await probeCapabilities(TOOLS, {
      run: stubRunner({ inventory: { '-encoders': 'Encoders:\n --\n A....D aac  AAC\n' } }),
    });
    expect(result.state).toBe('incompatible');
    expect(result.detail).toContain('libmp3lame');
  });

  it('names every gap, not just the first', async () => {
    const result = await probeCapabilities(TOOLS, {
      run: stubRunner({
        inventory: {
          '-encoders': 'Encoders:\n --\n',
          '-muxers': 'File formats:\n --\n',
        },
      }),
    });
    expect(result.detail).toContain('libmp3lame');
    expect(result.detail).toContain('mp3');
  });

  it('is missing — not incompatible — when a binary is not on disk', async () => {
    const result = await probeCapabilities(TOOLS, {
      run: stubRunner({
        fail: (binary) => (binary.endsWith('ffprobe') ? errno('ENOENT') : undefined),
      }),
    });
    expect(result).toMatchObject({ state: 'missing' });
    expect(result.detail).toContain('/bin/ffprobe');
  });

  it('is incompatible when a tool is there but refuses to run', async () => {
    const result = await probeCapabilities(TOOLS, {
      run: stubRunner({
        fail: (binary) => (binary.endsWith('ffmpeg') ? errno('EACCES') : undefined),
      }),
    });
    expect(result.state).toBe('incompatible');
  });

  it('is incompatible when ffprobe cannot produce JSON', async () => {
    const result = await probeCapabilities(TOOLS, {
      run: stubRunner({ version: 'ffprobe version 8.1.2' }),
    });
    expect(result.state).toBe('incompatible');
    expect(result.detail).toContain('JSON');
  });

  it('treats a hang as incompatible rather than waiting it out', async () => {
    const result = await probeCapabilities(TOOLS, {
      timeoutMs: 10,
      run: (_binary, _args, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason as Error));
        }),
    });
    expect(result.state).toBe('incompatible');
    expect(result.detail).toContain('没有响应');
  });
});
