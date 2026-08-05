// The import flow behind the folder button (D20). The native dialog itself is
// not scriptable — CDP cannot drive it and contextBridge freezes `larkAPI`, so
// the fake picker lives here and the real dialog stays a manual check
// (M4-14⑥).

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
let importResult = {
  imported: [{ song_id: 's1', name: '第一首' }],
  failed: [] as { path: string; reason: string }[],
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
  const pickMp3 = vi.fn(() => Promise.resolve([...paths]));
  Object.defineProperty(window, 'larkAPI', {
    value: { ...window.larkAPI, pickMp3 },
    writable: true,
    configurable: true,
  });
  return pickMp3;
}

beforeEach(() => {
  stubFetch();
  importResult = { imported: [{ song_id: 's1', name: '第一首' }], failed: [] };
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

    await user.click(screen.getByRole('button', { name: '导入本地 MP3' }));

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
      failed: [{ path: '/music/broken.mp3', reason: '不是有效的 mp3' }],
    };
    withPicker(['/music/broken.mp3']);
    render(<Controls />);

    await user.click(screen.getByRole('button', { name: '导入本地 MP3' }));

    await waitFor(() =>
      expect(failure).toHaveBeenCalledWith(expect.stringContaining('/music/broken.mp3')),
    );
    failure.mockRestore();
  });

  it('does nothing when the picker was cancelled', async () => {
    const user = userEvent.setup();
    const pickMp3 = withPicker([]);
    render(<Controls />);

    await user.click(screen.getByRole('button', { name: '导入本地 MP3' }));

    await waitFor(() => expect(pickMp3).toHaveBeenCalled());
    expect(calls.some((call) => call.url.endsWith('/songs/import'))).toBe(false);
  });
});
