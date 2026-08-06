// The import dialog (M5-13/M5-15): what the commit sends, and what happens
// when the file changes between the two requests.

import type { PlaylistImportPreviewData } from '@lark/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePlaylists } from '../stores/playlists.js';
import { ImportPlaylistDialog } from './ImportPlaylistDialog.js';

const FILE = '/tmp/歌单.lark-playlist.json';
const DIGEST = 'a'.repeat(64);
const SONG_A = '11111111-1111-4111-8111-111111111111';
const SONG_B = '22222222-2222-4222-8222-222222222222';

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
}

let calls: Call[] = [];
let preview: PlaylistImportPreviewData;
/** Overrides the answer to the commit when set. */
let importResponse: (() => Response) | null = null;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function previewData(
  overrides: Partial<PlaylistImportPreviewData> = {},
): PlaylistImportPreviewData {
  return {
    digest: DIGEST,
    total: 3,
    reuse_count: 1,
    new_count: 2,
    playlist_name: '健身歌单',
    suspects: [],
    ...overrides,
  };
}

beforeEach(() => {
  calls = [];
  preview = previewData();
  importResponse = null;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({
        method,
        url,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      if (url.endsWith('/playlists/import-preview')) {
        return Promise.resolve(jsonResponse({ success: true, data: preview }));
      }
      if (url.endsWith('/playlists/import')) {
        if (importResponse !== null) return Promise.resolve(importResponse());
        return Promise.resolve(
          jsonResponse({
            success: true,
            data: { playlist_id: null, total: 3, created: 2, reused: 1, added: 0 },
          }),
        );
      }
      return Promise.resolve(jsonResponse({ success: true, data: [] }));
    }),
  );
  window.larkAPI = { ...window.larkAPI, pickJsonFile: vi.fn(() => Promise.resolve(FILE)) };
  usePlaylists.setState({ playlists: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const commits = (): Call[] => calls.filter((c) => c.url.endsWith('/playlists/import'));

/** Open the dialog, pick the file, and wait for the preview to land. */
async function openWithFile(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  render(<ImportPlaylistDialog open onClose={() => {}} />);
  await user.click(screen.getByRole('button', { name: '选择文件…' }));
  await screen.findByText(/共 3 首/);
  return user;
}

describe('choosing a file', () => {
  it("previews it and offers the file's own name for a new playlist", async () => {
    await openWithFile();

    expect(calls[0]?.body).toEqual({ file_path: FILE });
    expect((screen.getByLabelText('新歌单名称') as HTMLInputElement).value).toBe('健身歌单');
  });

  it('asks for nothing when the picker is cancelled', async () => {
    window.larkAPI = { ...window.larkAPI, pickJsonFile: vi.fn(() => Promise.resolve(null)) };
    const user = userEvent.setup();
    render(<ImportPlaylistDialog open onClose={() => {}} />);

    await user.click(screen.getByRole('button', { name: '选择文件…' }));

    expect(calls).toEqual([]);
    expect(screen.getByText('尚未选择文件')).toBeTruthy();
  });
});

describe('committing', () => {
  it('sends the previewed digest and the new-playlist target', async () => {
    const user = await openWithFile();

    await user.click(screen.getByRole('button', { name: '导入' }));

    await waitFor(() => expect(commits()).toHaveLength(1));
    expect(commits()[0]?.body).toEqual({
      file_path: FILE,
      digest: DIGEST,
      target: { kind: 'new', name: '健身歌单' },
      reuse: [],
    });
  });

  it('keeps suspects as new songs unless the user says otherwise', async () => {
    preview = previewData({
      suspects: [
        {
          index: 2,
          name: '晴天',
          artist: '周杰伦',
          candidates: [
            { id: SONG_A, name: '晴天', artist: '周杰伦', has_file: true },
            { id: SONG_B, name: '晴天', artist: '周杰伦', has_file: false },
          ],
        },
      ],
    });
    const user = await openWithFile();

    // Checked = "import as a new song", which is the default (R12).
    const asNew = screen.getByRole('checkbox');
    expect(asNew.getAttribute('aria-checked')).toBe('true');
    await user.click(screen.getByRole('button', { name: '导入' }));

    await waitFor(() => expect(commits()).toHaveLength(1));
    expect(commits()[0]?.body?.reuse).toEqual([]);
  });

  it('merges a suspect into its first candidate when unchecked', async () => {
    preview = previewData({
      suspects: [
        {
          index: 2,
          name: '晴天',
          artist: '周杰伦',
          candidates: [{ id: SONG_A, name: '晴天', artist: '周杰伦', has_file: true }],
        },
      ],
    });
    const user = await openWithFile();

    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: '导入' }));

    await waitFor(() => expect(commits()).toHaveLength(1));
    expect(commits()[0]?.body?.reuse).toEqual([{ index: 2, song_id: SONG_A }]);
  });

  it('re-previews the file when the daemon says it changed', async () => {
    const user = await openWithFile();
    importResponse = () =>
      jsonResponse(
        {
          success: false,
          message: '文件在预览之后发生了变化，请重新预览再导入',
          error_code: 'IMPORT_SOURCE_CHANGED',
        },
        400,
      );

    await user.click(screen.getByRole('button', { name: '导入' }));

    // Preview → commit → preview again, with the dialog still open.
    await waitFor(() =>
      expect(calls.filter((c) => c.url.endsWith('/playlists/import-preview'))).toHaveLength(2),
    );
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});
