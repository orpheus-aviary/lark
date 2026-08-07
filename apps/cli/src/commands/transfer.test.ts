import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlaylistExportData, PlaylistImportPreviewData } from '@lark/shared';
import { sanitizeFileName } from '@lark/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CliError } from '../lib/errors.js';
import { fakeContext, playlist } from '../testing/fake-backend.js';
import { runPlaylistExport, runPlaylistImport } from './transfer.js';

const PL = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const EXPORT: PlaylistExportData = {
  format: 'lark-playlist',
  version: 1,
  exported_at: 1,
  playlist: { name: '收藏/最爱' },
  songs: [
    {
      name: '晴天',
      artist: '周杰伦',
      source_url: null,
      source_provider: null,
      source_key: null,
      lyrics_offset: 0,
      duration: 100,
    },
  ],
};

const PREVIEW: PlaylistImportPreviewData = {
  digest: 'f'.repeat(64),
  total: 2,
  reuse_count: 1,
  new_count: 1,
  playlist_name: '来自文件的歌单',
  suspects: [],
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lark-transfer-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function codeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return (err as CliError).code;
  }
}

describe('sanitizeFileName', () => {
  it.each([
    ['收藏/最爱', '收藏最爱'],
    ['..hidden', 'hidden'],
    ['/', 'playlist'],
    ['a:b*c?d', 'abcd'],
  ])('%s → %s', (input, expected) => {
    // The name is free text and becomes a path component: a `/` would silently
    // redirect the write, a leading `.` would hide the file.
    expect(sanitizeFileName(input)).toBe(expected);
  });
});

describe('playlist export', () => {
  it('requires -o rather than defaulting into the cwd', async () => {
    const ctx = fakeContext({
      playlists: [playlist({ id: PL, name: '收藏' })],
      exportData: EXPORT,
    });
    expect(await codeOf(() => runPlaylistExport(ctx, '收藏', {}))).toBe('USAGE_ERROR');
    expect(ctx.backend.names()).not.toContain('exportPlaylist');
  });

  it('writes the file the daemon produced, verbatim', async () => {
    const target = join(dir, 'out.json');
    const ctx = fakeContext({
      playlists: [playlist({ id: PL, name: '收藏' })],
      exportData: EXPORT,
    });

    await runPlaylistExport(ctx, '收藏', { output: target });

    expect(JSON.parse(readFileSync(target, 'utf-8'))).toEqual(EXPORT);
    expect(ctx.streams.stdout.join('\n')).toContain(target);
  });

  it('appends a sanitised name when the target is a directory', async () => {
    const ctx = fakeContext({
      playlists: [playlist({ id: PL, name: '收藏' })],
      exportData: EXPORT,
    });

    await runPlaylistExport(ctx, '收藏', { output: dir });

    // From `收藏/最爱` — the slash must not have made a subdirectory.
    expect(readdirSync(dir)).toEqual(['收藏最爱.lark-playlist.json']);
  });

  it('exports the virtual all playlist', async () => {
    const ctx = fakeContext({ exportData: EXPORT });
    await runPlaylistExport(ctx, 'all', { output: join(dir, 'all.json') });
    expect(ctx.backend.argsOf('exportPlaylist')).toEqual(['all']);
  });

  it('asks before overwriting, and leaves the old file alone when refused', async () => {
    const target = join(dir, 'out.json');
    writeFileSync(target, 'PRECIOUS');
    const ctx = fakeContext(
      { playlists: [playlist({ id: PL, name: '收藏' })], exportData: EXPORT },
      { yes: false },
    );

    expect(await codeOf(() => runPlaylistExport(ctx, '收藏', { output: target }))).toBe(
      'USAGE_ERROR',
    );
    expect(readFileSync(target, 'utf-8')).toBe('PRECIOUS');
  });

  it('leaves no temp file behind', async () => {
    const ctx = fakeContext({
      playlists: [playlist({ id: PL, name: '收藏' })],
      exportData: EXPORT,
    });
    await runPlaylistExport(ctx, '收藏', { output: join(dir, 'out.json') });
    expect(readdirSync(dir)).toEqual(['out.json']);
  });

  it('--json reports where it landed', async () => {
    const target = join(dir, 'out.json');
    const ctx = fakeContext(
      { playlists: [playlist({ id: PL, name: '收藏' })], exportData: EXPORT },
      { json: true },
    );

    await runPlaylistExport(ctx, '收藏', { output: target });

    const envelope = JSON.parse(ctx.streams.stdout[0] as string) as { data: { path: string } };
    expect(envelope.data.path).toBe(target);
  });
});

describe('playlist import', () => {
  const seedFile = (): string => {
    const file = join(dir, 'in.lark-playlist.json');
    writeFileSync(file, JSON.stringify(EXPORT));
    return file;
  };

  it('previews first, then commits with the previewed digest', async () => {
    // The digest is what makes the user's answer still mean something at
    // commit time: identical bytes, identical entries (M5-13).
    const file = seedFile();
    const ctx = fakeContext({ preview: PREVIEW });

    await runPlaylistImport(ctx, file, {});

    expect(ctx.backend.names()).toEqual(['importPreview', 'importPlaylist']);
    expect(ctx.backend.argsOf('importPlaylist')).toEqual([
      { file_path: file, digest: PREVIEW.digest, target: { kind: 'new', name: '来自文件的歌单' } },
    ]);
  });

  it('defaults to a NEW playlist named by the file', async () => {
    const ctx = fakeContext({ preview: PREVIEW });
    await runPlaylistImport(ctx, seedFile(), {});
    expect(ctx.streams.stdout.join('\n')).toContain('来自文件的歌单');
  });

  it('--new overrides the name', async () => {
    const ctx = fakeContext({ preview: PREVIEW });
    await runPlaylistImport(ctx, seedFile(), { new: '我的' });
    expect((ctx.backend.argsOf('importPlaylist') as [{ target: unknown }])[0].target).toEqual({
      kind: 'new',
      name: '我的',
    });
  });

  it('--to resolves an existing playlist by name', async () => {
    const ctx = fakeContext({ preview: PREVIEW, playlists: [playlist({ id: PL, name: '收藏' })] });
    await runPlaylistImport(ctx, seedFile(), { to: '收藏' });
    expect((ctx.backend.argsOf('importPlaylist') as [{ target: unknown }])[0].target).toEqual({
      kind: 'playlist',
      playlist_id: PL,
    });
  });

  it('--to all means library-only', async () => {
    const ctx = fakeContext({ preview: PREVIEW });
    await runPlaylistImport(ctx, seedFile(), { to: 'all' });
    expect((ctx.backend.argsOf('importPlaylist') as [{ target: unknown }])[0].target).toEqual({
      kind: 'all',
    });
  });

  it('refuses --to together with --new', async () => {
    const ctx = fakeContext({ preview: PREVIEW });
    expect(
      await codeOf(() => runPlaylistImport(ctx, seedFile(), { to: '收藏', new: '我的' })),
    ).toBe('USAGE_ERROR');
    expect(ctx.backend.names()).toEqual([]);
  });

  it('reports a missing file before asking the daemon', async () => {
    const ctx = fakeContext({ preview: PREVIEW });
    expect(await codeOf(() => runPlaylistImport(ctx, join(dir, 'nope.json'), {}))).toBe(
      'NOT_FOUND',
    );
    expect(ctx.backend.names()).toEqual([]);
  });

  it('asks before committing', async () => {
    const ctx = fakeContext({ preview: PREVIEW }, { yes: false });
    expect(await codeOf(() => runPlaylistImport(ctx, seedFile(), {}))).toBe('USAGE_ERROR');
    // The preview ran — it writes nothing — but the commit did not.
    expect(ctx.backend.names()).toEqual(['importPreview']);
  });

  it('warns about suspects, which default to being imported as new', async () => {
    const ctx = fakeContext({
      preview: {
        ...PREVIEW,
        suspects: [{ index: 0, name: '晴天', artist: '周杰伦', candidates: [] }],
      },
    });

    await runPlaylistImport(ctx, seedFile(), {});

    expect(ctx.streams.stdout.join('\n')).toContain('同名同歌手');
  });

  it('refuses a file over the 20MB cap without reading it into memory', async () => {
    const file = join(dir, 'huge.json');
    // Sparse file: the check reads the SIZE, so 21MB costs no disk here.
    writeFileSync(file, '');
    truncateSync(file, 21 * 1024 * 1024);

    const ctx = fakeContext({ preview: PREVIEW });
    expect(await codeOf(() => runPlaylistImport(ctx, file, {}))).toBe('USAGE_ERROR');
    expect(ctx.backend.names()).toEqual([]);
  });
});

describe('export/import round trip on disk', () => {
  it('writes a file the import command accepts as input', async () => {
    const exportDir = join(dir, 'nested');
    mkdirSync(exportDir);
    const exportCtx = fakeContext({
      playlists: [playlist({ id: PL, name: '收藏' })],
      exportData: EXPORT,
    });

    await runPlaylistExport(exportCtx, '收藏', { output: exportDir });
    const written = join(exportDir, readdirSync(exportDir)[0] as string);
    expect(existsSync(written)).toBe(true);

    const importCtx = fakeContext({ preview: PREVIEW });
    await runPlaylistImport(importCtx, written, {});
    expect(importCtx.backend.argsOf('importPreview')).toEqual([written]);
  });
});
