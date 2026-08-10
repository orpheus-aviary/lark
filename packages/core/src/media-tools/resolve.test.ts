import { describe, expect, it } from 'vitest';
import { resolveMediaTools } from './resolve.js';

/** Every seam injected: no env stubbing, no binaries, no machine dependence. */
function resolve(
  env: NodeJS.ProcessEnv,
  present: readonly string[] = [],
  directories: readonly string[] = [],
) {
  return resolveMediaTools({
    env,
    homebrewDirs: ['/brew/bin', '/legacy/bin'],
    isExecutableFile: (p) => present.includes(p),
    isDirectory: (p) => directories.includes(p),
  });
}

describe('resolveMediaTools', () => {
  it('falls back to bare names when nothing else is on the machine', () => {
    const outcome = resolve({});
    expect(outcome).toEqual({
      ok: true,
      tools: {
        ffmpeg: { path: 'ffmpeg', source: 'path' },
        ffprobe: { path: 'ffprobe', source: 'path' },
      },
    });
  });

  it("prefers Homebrew's prefix over PATH — a Finder launch inherits no PATH", () => {
    const outcome = resolve({}, ['/brew/bin/ffmpeg', '/brew/bin/ffprobe']);
    expect(outcome).toMatchObject({
      ok: true,
      tools: {
        ffmpeg: { path: '/brew/bin/ffmpeg', source: 'homebrew' },
        ffprobe: { path: '/brew/bin/ffprobe', source: 'homebrew' },
      },
    });
  });

  it('takes the Apple-silicon prefix before the legacy one', () => {
    const outcome = resolve({}, ['/brew/bin/ffmpeg', '/legacy/bin/ffmpeg', '/legacy/bin/ffprobe']);
    expect(outcome).toMatchObject({
      ok: true,
      tools: {
        ffmpeg: { path: '/brew/bin/ffmpeg', source: 'homebrew' },
        ffprobe: { path: '/legacy/bin/ffprobe', source: 'homebrew' },
      },
    });
  });

  it('uses the bundle directory when the spawner injects one', () => {
    const outcome = resolve(
      { LARK_MEDIA_TOOLS_DIR: '/App/Resources/ffmpeg' },
      ['/App/Resources/ffmpeg/ffmpeg', '/App/Resources/ffmpeg/ffprobe', '/brew/bin/ffmpeg'],
      ['/App/Resources/ffmpeg'],
    );
    expect(outcome).toMatchObject({
      ok: true,
      tools: {
        ffmpeg: { path: '/App/Resources/ffmpeg/ffmpeg', source: 'bundle' },
        ffprobe: { path: '/App/Resources/ffmpeg/ffprobe', source: 'bundle' },
      },
    });
  });

  // The point of the all-or-nothing rule: silently borrowing Homebrew here
  // would make a broken `bundled` build behave exactly like a working one.
  it('refuses a half-populated bundle instead of falling back to Homebrew', () => {
    const outcome = resolve(
      { LARK_MEDIA_TOOLS_DIR: '/App/Resources/ffmpeg' },
      ['/App/Resources/ffmpeg/ffmpeg', '/brew/bin/ffmpeg', '/brew/bin/ffprobe'],
      ['/App/Resources/ffmpeg'],
    );
    expect(outcome).toMatchObject({ ok: false, state: 'incompatible' });
    expect(outcome.ok === false && outcome.detail).toContain('ffprobe');
  });

  it('refuses a bundle directory that is not a directory', () => {
    const outcome = resolve({ LARK_MEDIA_TOOLS_DIR: '/App/Resources/ffmpeg' });
    expect(outcome).toMatchObject({ ok: false, state: 'incompatible' });
  });

  it('lets an explicit override win over everything', () => {
    const outcome = resolve(
      { LARK_FFMPEG_PATH: '/custom/ffmpeg', LARK_MEDIA_TOOLS_DIR: '/App/Resources/ffmpeg' },
      ['/custom/ffmpeg', '/App/Resources/ffmpeg/ffmpeg', '/App/Resources/ffmpeg/ffprobe'],
      ['/App/Resources/ffmpeg'],
    );
    expect(outcome).toMatchObject({
      ok: true,
      tools: {
        ffmpeg: { path: '/custom/ffmpeg', source: 'env' },
        ffprobe: { path: '/App/Resources/ffmpeg/ffprobe', source: 'bundle' },
      },
    });
  });

  // Ignoring a set-but-broken override is how you spend an afternoon debugging
  // a binary you thought you had replaced.
  it('fails on an override that points at nothing', () => {
    const outcome = resolve({ LARK_FFPROBE_PATH: '/gone/ffprobe' }, ['/brew/bin/ffprobe']);
    expect(outcome).toMatchObject({ ok: false, state: 'incompatible' });
    expect(outcome.ok === false && outcome.detail).toContain('LARK_FFPROBE_PATH');
  });

  it('treats an empty override as unset rather than resolving to ""', () => {
    const outcome = resolve({ LARK_FFMPEG_PATH: '' }, ['/brew/bin/ffmpeg']);
    expect(outcome).toMatchObject({
      ok: true,
      tools: { ffmpeg: { path: '/brew/bin/ffmpeg', source: 'homebrew' } },
    });
  });
});
