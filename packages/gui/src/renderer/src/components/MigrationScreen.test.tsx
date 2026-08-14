// The progress screen (0.3.0 T3c, 判据 18/59).
//
// Three states matter: running (a number a user can watch), stopped by the
// machine (a reason and a button that re-checks it), and blocked by a sync file
// op (the list that is the only way out of the boot screen).

import type { AudioMigrationCounts, AudioMigrationData, SyncFileOpSummary } from '@lark/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMigration } from '../stores/migration.js';
import { useSync } from '../stores/sync.js';
import { MigrationScreen } from './MigrationScreen.js';

function counts(overrides: Partial<AudioMigrationCounts> = {}): AudioMigrationCounts {
  return {
    phase: 'pending',
    state: 'running',
    total: 10,
    done: 3,
    lost: 1,
    kept_unconverted: 1,
    asset_missing: 0,
    blocked: 0,
    blocked_file_op: 0,
    ...overrides,
  };
}

function report(overrides: Partial<AudioMigrationData> = {}): AudioMigrationData {
  return {
    counts: counts(),
    reason: null,
    objects: [],
    backup: { file_count: 0, bytes: 0, asset_count: 0, asset_bytes: 0 },
    ...overrides,
  };
}

interface Call {
  method: string;
  url: string;
}

let calls: Call[] = [];
let served: AudioMigrationData;
/** The screen refetches the file-op list on mount, so the stub owns it too. */
let servedFileOps: SyncFileOpSummary[] = [];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Put the store where a poll would have left it, and serve the same thing. */
function seed(data: AudioMigrationData, fileOps: SyncFileOpSummary[] = []): void {
  served = data;
  servedFileOps = fileOps;
  useMigration.setState({ phase: 'pending', counts: data.counts, report: data, probed: true });
  useSync.setState({ failedFileOps: fileOps });
}

beforeEach(() => {
  calls = [];
  served = report();
  servedFileOps = [];
  useMigration.setState({ retrying: false, clearing: false });
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', url });
      if (url.includes('/api/audio-migration/retry')) {
        return Promise.resolve(
          jsonResponse({
            success: true,
            data: { started: true, counts: served.counts, reason: null },
          }),
        );
      }
      if (url.includes('/api/audio-migration')) {
        return Promise.resolve(jsonResponse({ success: true, data: served }));
      }
      if (url.includes('/sync/file-ops/discard')) {
        return Promise.resolve(jsonResponse({ success: true, data: { id: 7 } }));
      }
      if (url.includes('/sync/file-ops')) {
        return Promise.resolve(jsonResponse({ success: true, data: { file_ops: servedFileOps } }));
      }
      return Promise.resolve(jsonResponse({ success: true, data: {} }));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('while the pass is running', () => {
  it('says how far along it is', () => {
    seed(report());
    render(<MigrationScreen />);

    // done + lost + kept, over the total the scan froze.
    expect(screen.getByText(/5 \/ 10 首已处理/)).toBeDefined();
    expect((screen.getByRole('progressbar') as HTMLProgressElement).value).toBe(5);
  });
});

describe('when the machine stopped it', () => {
  it('shows the reason and offers to re-check (判据 59)', async () => {
    seed(
      report({
        counts: counts({ state: 'blocked_environment' }),
        reason: '磁盘剩余 12MB，音频迁移需要 500MB——清理一些空间后重试',
      }),
    );
    render(<MigrationScreen />);

    expect(screen.getByText(/迁移已暂停，没有删除任何文件/)).toBeDefined();
    expect(screen.getByText(/磁盘剩余 12MB/)).toBeDefined();

    await userEvent.click(screen.getByRole('button', { name: '重新检测并继续' }));

    await waitFor(() =>
      expect(
        calls.some(
          (call) => call.method === 'POST' && call.url.includes('/api/audio-migration/retry'),
        ),
      ).toBe(true),
    );
  });
});

describe('when a sync file op owns a directory', () => {
  it('offers the list that is the way out (判据 16)', async () => {
    seed(report({ counts: counts({ blocked_file_op: 2 }) }), [
      {
        id: 7,
        kind: 'delete_song_files',
        song_id: 'song-1',
        attempts: 5,
        last_error: 'EACCES: permission denied',
        next_retry_at: null,
        created_at: 1_700_000_000_000,
        inline: null,
      },
    ]);
    render(<MigrationScreen />);

    expect(screen.getByText(/有 2 首歌的目录被未完成的同步文件操作占用/)).toBeDefined();

    // Discarding is destructive, so it is confirmed here rather than fired.
    await userEvent.click(screen.getByRole('button', { name: '放弃文件操作 #7' }));
    expect(screen.getByText(/放弃后这次文件操作永远不会执行/)).toBeDefined();

    await userEvent.click(screen.getByRole('button', { name: '放弃' }));
    await waitFor(() =>
      expect(
        calls.some((call) => call.method === 'POST' && call.url.includes('/sync/file-ops/discard')),
      ).toBe(true),
    );
  });
});

describe('when a file needs a person', () => {
  it('names it, without saying where it lives', () => {
    seed(
      report({
        counts: counts({ blocked: 1 }),
        objects: [
          {
            object_key: 'e0f1-2233',
            song_id: 'e0f1-2233',
            class: 'A',
            status: 'blocked',
            file_origin: 'imported',
            blocked_action: 'backup_mp3',
            error_class: 'file_action',
            last_error: "EACCES: permission denied, rename '<lark>/songs/e0f1-2233/song.mp3'",
            backup_file: null,
            reconcile_action: null,
            at: 1_700_000_000_000,
          },
        ],
      }),
    );
    render(<MigrationScreen />);

    expect(screen.getByText('e0f1-2233')).toBeDefined();
    expect(screen.getByText(/<lark>\/songs\/e0f1-2233\/song.mp3/)).toBeDefined();
  });
});
