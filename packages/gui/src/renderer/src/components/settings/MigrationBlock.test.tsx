// The settings block the migration leaves behind (0.3.0 T3c, 判据 22/61).
//
// The assertions worth having are about what the user is told BEFORE the
// destructive button: that the irreplaceable share is named, and that nothing
// is deleted until the confirmation is answered.

import type { AudioMigrationData, AudioMigrationObjectData } from '@lark/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMigration } from '../../stores/migration.js';
import { MigrationBlock } from './MigrationBlock.js';

const MIB = 1024 * 1024;

function object(overrides: Partial<AudioMigrationObjectData> = {}): AudioMigrationObjectData {
  return {
    object_key: 'song-1',
    song_id: 'song-1',
    class: 'R',
    status: 'done',
    file_origin: 'downloaded',
    blocked_action: null,
    error_class: null,
    last_error: null,
    backup_file: null,
    reconcile_action: null,
    at: 1_700_000_000_000,
    ...overrides,
  };
}

function report(overrides: Partial<AudioMigrationData> = {}): AudioMigrationData {
  return {
    counts: {
      phase: 'normal',
      state: 'idle',
      total: 3,
      done: 2,
      lost: 0,
      kept_unconverted: 1,
      asset_missing: 0,
      blocked: 0,
      blocked_file_op: 0,
    },
    reason: null,
    objects: [object()],
    backup: { file_count: 3, bytes: 30 * MIB, asset_count: 1, asset_bytes: 10 * MIB },
    ...overrides,
  };
}

interface Call {
  method: string;
  url: string;
  body: unknown;
}

let calls: Call[] = [];
let served: AudioMigrationData | null;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  calls = [];
  served = report();
  useMigration.setState({ report: null, counts: null, clearing: false });
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? 'GET',
        url,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      if (url.includes('/backup/clear')) {
        return Promise.resolve(
          jsonResponse({ success: true, data: { removed_count: 3, freed_bytes: 30 * MIB } }),
        );
      }
      if (url.includes('/api/audio-migration')) {
        return Promise.resolve(jsonResponse({ success: true, data: served }));
      }
      return Promise.resolve(jsonResponse({ success: true, data: {} }));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a library that never migrated', () => {
  it('renders nothing at all', async () => {
    served = report({
      counts: { ...report().counts, total: 0, done: 0, kept_unconverted: 0 },
      objects: [],
      backup: { file_count: 0, bytes: 0, asset_count: 0, asset_bytes: 0 },
    });

    const { container } = render(<MigrationBlock />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));

    expect(container.textContent).toBe('');
  });
});

describe('a library that did (判据 22)', () => {
  it('shows the usage and names the irreplaceable share', async () => {
    render(<MigrationBlock />);

    expect(await screen.findByText('迁移备份')).toBeDefined();
    expect(screen.getByText('30.0 MB（3 个文件）')).toBeDefined();
    expect(screen.getByText(/其中 1 个是无法转换的原件/)).toBeDefined();
  });

  it('opens the directory through main, never by path', async () => {
    render(<MigrationBlock />);
    await userEvent.click(await screen.findByRole('button', { name: '打开备份目录' }));

    expect(window.larkAPI.openMigrationBackup).toHaveBeenCalledTimes(1);
    // The renderer names no path: the IPC takes no argument at all.
    expect(vi.mocked(window.larkAPI.openMigrationBackup).mock.calls[0]).toEqual([]);
  });

  it('deletes nothing until the confirmation is answered (判据 61)', async () => {
    render(<MigrationBlock />);
    await userEvent.click(await screen.findByRole('button', { name: '清空备份' }));

    expect(
      screen.getByText(/其中 1 个是无法转换的原件（10.0 MB）——这些文件没有其他副本/),
    ).toBeDefined();
    expect(calls.some((call) => call.url.includes('/backup/clear'))).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: '清空' }));

    await waitFor(() => {
      const clear = calls.find((call) => call.url.includes('/backup/clear'));
      expect(clear?.method).toBe('POST');
      expect(clear?.body).toEqual({ confirm: true });
    });
  });
});

describe('the songs the migration discarded', () => {
  it('re-downloads each one, forced (判据 22)', async () => {
    served = report({
      counts: { ...report().counts, lost: 2 },
      objects: [
        object({ object_key: 'a', song_id: 'a', status: 'lost' }),
        object({ object_key: 'b', song_id: 'b', status: 'lost' }),
        // An orphan has no library row to re-download into.
        object({ object_key: 'c', song_id: null, status: 'lost' }),
      ],
    });

    render(<MigrationBlock />);
    await userEvent.click(await screen.findByRole('button', { name: '重新下载 2 首' }));

    await waitFor(() => {
      const redownloads = calls.filter((call) => call.url.includes('/redownload'));
      expect(redownloads.map((call) => call.url.split('/songs/')[1])).toEqual([
        'a/redownload',
        'b/redownload',
      ]);
    });
  });
});
