import { describe, expect, it } from 'vitest';
import { MediaToolsUnavailableError } from '../errors.js';
import { MediaToolsRegistry } from './registry.js';

const READY = JSON.stringify({ program_version: { version: '8.1.2', configuration: '-' } });

const INVENTORY: Record<string, string> = {
  '-protocols': 'Input:\n  file\n',
  '-demuxers': ' ---\n D  mov,mp4,m4a,3gp,3g2,mj2 x\n D  mp3 x\n',
  '-decoders': ' ---\n A aac x\n A mp3 x\n',
  '-encoders': ' ---\n A aac x\n',
  '-muxers': ' ---\n E ipod x\n',
};

/**
 * A registry over a scripted world: `state.ok` is whether the fake binaries
 * exist at all, `state.runs` counts probe invocations, and the clock is a
 * variable.
 */
function harness(options: { present?: boolean } = {}) {
  const present = options.present ?? true;
  const state = { ok: present, runs: 0, now: 0 };
  const registry = new MediaToolsRegistry({
    now: () => state.now,
    resolve: {
      env: {},
      homebrewDirs: ['/brew/bin'],
      isExecutableFile: (p) => present && p.startsWith('/brew/bin/'),
      isDirectory: () => false,
    },
    probe: {
      run: async (_binary, args) => {
        state.runs++;
        if (!state.ok) {
          const err: NodeJS.ErrnoException = new Error('ENOENT');
          err.code = 'ENOENT';
          throw err;
        }
        if (args.includes('-show_program_version')) return READY;
        const flag = args.find((a) => a in INVENTORY);
        return flag === undefined ? '' : INVENTORY[flag];
      },
    },
  });
  return { registry, state };
}

describe('MediaToolsRegistry', () => {
  it('reports the resolved pair once ready', async () => {
    const { registry } = harness();
    const snapshot = await registry.refresh();
    expect(snapshot).toMatchObject({
      state: 'ready',
      ffmpeg: { path: '/brew/bin/ffmpeg', source: 'homebrew' },
      ffprobe: { path: '/brew/bin/ffprobe', source: 'homebrew' },
      detail: null,
    });
  });

  it('caches a ready verdict instead of re-probing per call', async () => {
    const { registry, state } = harness();
    await registry.refresh();
    const after = state.runs;
    await registry.refresh();
    await registry.acquire();
    expect(state.runs).toBe(after);
  });

  it('shares one probe between concurrent callers', async () => {
    const { registry, state } = harness();
    await Promise.all([registry.refresh(), registry.refresh(), registry.acquire()]);
    // Six invocations = ONE probe (five inventories + the version call).
    expect(state.runs).toBe(6);
  });

  it('throttles re-probing while the answer is bad', async () => {
    const { registry, state } = harness({ present: false });
    await registry.refresh();
    const after = state.runs;
    await registry.refresh();
    expect(state.runs).toBe(after);

    // …but recovers on its own once the floor has passed: `brew install ffmpeg`
    // in one window and a settings refresh in the other, no restart.
    state.now += 5000;
    await registry.refresh();
    expect(state.runs).toBeGreaterThan(after);
  });

  it('throws MEDIA_TOOLS_UNAVAILABLE from acquire when nothing is usable', async () => {
    const { registry } = harness({ present: false });
    await expect(registry.acquire()).rejects.toThrow(MediaToolsUnavailableError);
    await expect(registry.acquire()).rejects.toMatchObject({
      code: 'MEDIA_TOOLS_UNAVAILABLE',
      state: 'missing',
    });
  });

  it('never names a binary it could not verify', async () => {
    const { registry } = harness({ present: false });
    const snapshot = await registry.refresh();
    expect(snapshot).toMatchObject({ state: 'missing', ffmpeg: null, ffprobe: null });
    expect(snapshot.detail).not.toBeNull();
  });

  // The app bundle was replaced under a running daemon: the cached `ready` is
  // now a lie, and only an execution failure can reveal it.
  it('invalidates a ready verdict when a run fails with ENOENT', async () => {
    const { registry, state } = harness();
    await registry.acquire();
    const after = state.runs;

    state.ok = false;
    const spawnFailure: NodeJS.ErrnoException = new Error('spawn ffmpeg ENOENT');
    spawnFailure.code = 'ENOENT';
    await expect(
      registry.use(async () => {
        throw spawnFailure;
      }),
    ).rejects.toThrow(spawnFailure);

    await expect(registry.acquire()).rejects.toThrow(MediaToolsUnavailableError);
    expect(state.runs).toBeGreaterThan(after);
  });

  // A corrupt download is not evidence about the toolchain. Re-probing on
  // every bad file would turn one broken source into a probe storm.
  it('keeps the verdict when a run fails on the media itself', async () => {
    const { registry, state } = harness();
    await registry.acquire();
    const after = state.runs;

    await expect(
      registry.use(async () => {
        throw new Error('ffmpeg failed: Invalid data found when processing input');
      }),
    ).rejects.toThrow(/Invalid data/);

    await registry.acquire();
    expect(state.runs).toBe(after);
  });

  it('unwraps the cause when the failure is wrapped', async () => {
    const { registry, state } = harness();
    await registry.acquire();
    const after = state.runs;

    const cause: NodeJS.ErrnoException = new Error('spawn ENOENT');
    cause.code = 'ENOENT';
    await expect(
      registry.use(async () => {
        throw new Error('ffmpeg not found at /brew/bin/ffmpeg', { cause });
      }),
    ).rejects.toThrow();

    state.ok = false;
    await expect(registry.acquire()).rejects.toThrow(MediaToolsUnavailableError);
    expect(state.runs).toBeGreaterThan(after);
  });

  it('answers a snapshot before anything has probed', () => {
    const { registry, state } = harness();
    expect(registry.snapshot()).toMatchObject({ state: 'missing', ffmpeg: null });
    expect(state.runs).toBe(0);
  });
});
