// The import flow behind the folder button (D20). The native dialog itself is
// not scriptable — CDP cannot drive it and contextBridge freezes `larkAPI`, so
// the fake picker lives here and the real dialog stays a manual check
// (M4-14⑥).

import type { ImportResultData } from '@lark/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDownloads } from '../stores/download.js';
import { Controls } from './Controls.js';

interface Call {
  url: string;
  body: unknown;
}

let calls: Call[] = [];
let importResult: ImportResultData = {
  imported: [{ song_id: 's1', name: '第一首', warnings: [] }],
  failed: [],
};

function stubFetch(): void {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      return Promise.resolve(
        new Response(JSON.stringify({ success: true, data: importResult }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }),
  );
}

/**
 * Swap the whole `larkAPI` object: its fields are readonly because
 * contextBridge freezes what it exposes — the same freeze that makes the
 * picker impossible to stub from outside the renderer.
 */
function withPicker(paths: readonly string[]): ReturnType<typeof vi.fn> {
  const pickAudio = vi.fn(() => Promise.resolve([...paths]));
  Object.defineProperty(window, 'larkAPI', {
    value: { ...window.larkAPI, pickAudio },
    writable: true,
    configurable: true,
  });
  return pickAudio;
}

beforeEach(() => {
  stubFetch();
  importResult = { imported: [{ song_id: 's1', name: '第一首', warnings: [] }], failed: [] };
  useDownloads.setState({ tasks: [], batches: [], cancelling: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('local import', () => {
  it('sends what the picker returned and reports the count', async () => {
    const user = userEvent.setup();
    const success = vi.spyOn(toast, 'success');
    withPicker(['/music/a.mp3', '/music/b.mp3']);
    render(<Controls />);

    await user.click(screen.getByRole('button', { name: '导入本地音频' }));

    await waitFor(() =>
      expect(calls.find((call) => call.url.endsWith('/songs/import'))?.body).toEqual({
        file_paths: ['/music/a.mp3', '/music/b.mp3'],
      }),
    );
    expect(success).toHaveBeenCalledWith('已导入 1 首');
    success.mockRestore();
  });

  it('says which files failed instead of swallowing them', async () => {
    const user = userEvent.setup();
    const failure = vi.spyOn(toast, 'error');
    importResult = {
      imported: [],
      failed: [{ path: '/music/broken.mp3', reason: '无法读取音频', error_code: 'FFMPEG_FAILED' }],
    };
    withPicker(['/music/broken.mp3']);
    render(<Controls />);

    await user.click(screen.getByRole('button', { name: '导入本地音频' }));

    await waitFor(() =>
      expect(failure).toHaveBeenCalledWith(expect.stringContaining('/music/broken.mp3')),
    );
    failure.mockRestore();
  });

  // Criterion 53: an import that SUCCEEDED can still owe the user a sentence
  // — the library holds one format, so a FLAC arrives re-encoded.
  it('says what an accepted file lost on the way in', async () => {
    const user = userEvent.setup();
    const success = vi.spyOn(toast, 'success');
    const warn = vi.spyOn(toast, 'warning');
    importResult = {
      imported: [
        {
          song_id: 's1',
          name: '无损原盘',
          warnings: ['flac 是无损格式，已转码为 AAC 192k（有损）'],
        },
      ],
      failed: [],
    };
    withPicker(['/music/lossless.flac']);
    render(<Controls />);

    await user.click(screen.getByRole('button', { name: '导入本地音频' }));

    // Imported AND warned: the song is in the library either way, so this is
    // not an error toast.
    await waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('无损原盘')));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('AAC 192k'));
    expect(success).toHaveBeenCalledWith('已导入 1 首');
    warn.mockRestore();
    success.mockRestore();
  });

  it('does nothing when the picker was cancelled', async () => {
    const user = userEvent.setup();
    const pickAudio = withPicker([]);
    render(<Controls />);

    await user.click(screen.getByRole('button', { name: '导入本地音频' }));

    await waitFor(() => expect(pickAudio).toHaveBeenCalled());
    expect(calls.some((call) => call.url.endsWith('/songs/import'))).toBe(false);
  });
});
