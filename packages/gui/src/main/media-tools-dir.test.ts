import { describe, expect, it } from 'vitest';
import { bundledMediaToolsDir, withMediaToolsDir } from './media-tools-dir.js';

const RESOURCES = '/Applications/Lark.app/Contents/Resources';
const BUNDLE = `${RESOURCES}/ffmpeg`;

const present =
  (...paths: string[]) =>
  (path: string) =>
    paths.includes(path);

describe('bundledMediaToolsDir', () => {
  it('finds a complete bundle', () => {
    const dir = bundledMediaToolsDir({
      resourcesPath: RESOURCES,
      exists: present(`${BUNDLE}/ffmpeg`, `${BUNDLE}/ffprobe`),
    });
    expect(dir).toBe(BUNDLE);
  });

  it('reports none for a `system` build', () => {
    expect(bundledMediaToolsDir({ resourcesPath: RESOURCES, exists: () => false })).toBeNull();
  });

  // Half a bundle is a broken build. Pointing the daemon at it would turn
  // "this app bundle is incomplete" into "ffprobe is missing".
  it('reports none when only one binary shipped', () => {
    const dir = bundledMediaToolsDir({
      resourcesPath: RESOURCES,
      exists: present(`${BUNDLE}/ffmpeg`),
    });
    expect(dir).toBeNull();
  });
});

describe('withMediaToolsDir', () => {
  it('leaves an inherited value alone when this build has no bundle', () => {
    const env = withMediaToolsDir(
      { LARK_MEDIA_TOOLS_DIR: '/repo/vendor/ffmpeg', LARK_NEST_DIR: '/nest' },
      { resourcesPath: RESOURCES, exists: () => false },
    );
    expect(env).toEqual({ LARK_MEDIA_TOOLS_DIR: '/repo/vendor/ffmpeg', LARK_NEST_DIR: '/nest' });
  });

  // A packaged app must not transcode through whatever a developer's shell
  // happened to export.
  it('overrides an inherited value with its own bundle', () => {
    const env = withMediaToolsDir(
      { LARK_MEDIA_TOOLS_DIR: '/somewhere/else' },
      { resourcesPath: RESOURCES, exists: present(`${BUNDLE}/ffmpeg`, `${BUNDLE}/ffprobe`) },
    );
    expect(env.LARK_MEDIA_TOOLS_DIR).toBe(BUNDLE);
  });
});
