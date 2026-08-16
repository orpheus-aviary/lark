// The sync badge (v0.2 T4): what it says in each state, and the two ways out
// of a stuck file operation.

import type { SyncFileOpSummary, SyncStatusData } from '@lark/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsUi } from '../stores/settings-ui.js';
import { useSync } from '../stores/sync.js';
import { SyncBadge } from './SyncBadge.js';

function syncStatus(overrides: Partial<SyncStatusData> = {}): SyncStatusData {
  return {
    configured: true,
    authenticated: true,
    bound: true,
    server_url: 'https://sync.example',
    device_id: 'dev-1',
    workspace_id: 'ws-1',
    pending_count: 0,
    pulled_seq: 41,
    pushed_seq: 39,
    last_sync_at: null,
    state: 'idle',
    auth_reason: null,
    last_error: null,
    dead_letters: { in: 0, out: 0 },
    duplicate_source_keys: 0,
    pending_file_ops: 0,
    file_op_failures: 0,
    quarantined_count: 0,
    last_file_error: null,
    ...overrides,
  };
}

function fileOp(overrides: Partial<SyncFileOpSummary> = {}): SyncFileOpSummary {
  return {
    id: 7,
    kind: 'write_lyrics',
    song_id: 'song-1',
    attempts: 5,
    last_error: 'EACCES: permission denied',
    next_retry_at: null,
    created_at: 1_700_000_000_000,
    inline: { size: 1024, sha256: 'abc' },
    ...overrides,
  };
}

interface Call {
  method: string;
  url: string;
  body: unknown;
}

let calls: Call[] = [];
/** What the daemon answers — opening the popover refetches all three. */
let served: { status: SyncStatusData; conflicts: number; fileOps: SyncFileOpSummary[] };

/** Seed the store AND the daemon's answers; the popover refetches on open. */
function seed(
  status: SyncStatusData,
  extra: { conflicts?: number; fileOps?: SyncFileOpSummary[] } = {},
): void {
  served = {
    status,
    conflicts: extra.conflicts ?? 0,
    fileOps: extra.fileOps ?? [],
  };
  useSync.setState({
    status,
    conflicts: served.conflicts,
    failedFileOps: served.fileOps,
    running: false,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  calls = [];
  served = { status: syncStatus(), conflicts: 0, fileOps: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({
        method,
        url,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      if (url.includes('/sync/status')) {
        return Promise.resolve(jsonResponse({ success: true, data: served.status }));
      }
      if (url.includes('/conflicts/count')) {
        return Promise.resolve(jsonResponse({ success: true, data: { count: served.conflicts } }));
      }
      if (url.includes('/sync/file-ops/retry')) {
        return Promise.resolve(
          jsonResponse({ success: true, data: { executed: 1, failed: 0, skipped: 0 } }),
        );
      }
      if (url.includes('/sync/file-ops')) {
        return Promise.resolve(jsonResponse({ success: true, data: { file_ops: served.fileOps } }));
      }
      if (url.includes('/sync/run')) {
        return Promise.resolve(
          jsonResponse({
            success: true,
            data: {
              pulled: 3,
              pushed: 2,
              applied: 3,
              skipped: 0,
              dead_lettered: 0,
              conflicts: 0,
              cancelled: false,
              pulled_seq: 44,
              pushed_seq: 41,
            },
          }),
        );
      }
      return Promise.resolve(jsonResponse({ success: true, data: { id: 7 } }));
    }),
  );
  useSync.setState({ status: null, conflicts: 0, failedFileOps: [], running: false });
  useSettingsUi.setState({ open: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const urls = (method: string): string[] =>
  calls.filter((call) => call.method === method).map((call) => call.url);

describe('what the badge says', () => {
  it('offers sync to a library that never enabled it', () => {
    seed(syncStatus({ configured: false, bound: false, state: 'idle' }));
    render(<SyncBadge />);

    expect(screen.getByRole('button', { name: '同步：未启用同步' })).toBeDefined();
  });

  it('counts what is waiting to be pushed', () => {
    seed(syncStatus({ pending_count: 3 }));
    render(<SyncBadge />);

    expect(screen.getByRole('button', { name: '同步：待同步 3' })).toBeDefined();
  });

  // Conflicts and dead file ops are the two things only a person can clear, so
  // they share one number — the badge's whole job is to be worth looking at.
  it('adds conflicts and dead file ops into one attention count', () => {
    seed(syncStatus({ file_op_failures: 1 }), { conflicts: 2, fileOps: [fileOp()] });
    render(<SyncBadge />);

    expect(screen.getByRole('button', { name: '同步：已同步' }).textContent).toContain('3');
  });

  it('says why sync stopped instead of just "error"', async () => {
    const user = userEvent.setup();
    seed(syncStatus({ state: 'error', last_error: '服务器返回 500' }));
    render(<SyncBadge />);

    await user.click(screen.getByRole('button', { name: '同步：同步出错' }));

    expect(await screen.findByText('服务器返回 500')).toBeDefined();
  });
});

describe('opening the popover', () => {
  it('refetches the status, the conflict count and the failed file ops', async () => {
    const user = userEvent.setup();
    seed(syncStatus());
    render(<SyncBadge />);

    await user.click(screen.getByRole('button', { name: '同步：已同步' }));

    await waitFor(() => {
      expect(urls('GET').some((url) => url.endsWith('/sync/status'))).toBe(true);
      expect(urls('GET').some((url) => url.endsWith('/conflicts/count'))).toBe(true);
      expect(urls('GET').some((url) => url.endsWith('/sync/file-ops?state=failed'))).toBe(true);
    });
  });

  // A round needs credentials; offering the button without them would produce
  // a 503 the user cannot do anything about.
  it('refuses to run a round before login, and points at the settings instead', async () => {
    const user = userEvent.setup();
    seed(
      syncStatus({ authenticated: false, state: 'auth_required', auth_reason: 'missing_session' }),
    );
    render(<SyncBadge />);

    await user.click(screen.getByRole('button', { name: '同步：需要登录' }));

    expect((await screen.findByRole('button', { name: '立即同步' })).hasAttribute('disabled')).toBe(
      true,
    );
    await user.click(screen.getByRole('button', { name: '去登录…' }));
    expect(useSettingsUi.getState().open).toBe(true);
    // §7 F4 / criterion 38: the door decides the room. This button exists
    // because sync said something, so it opens on the sync tab.
    expect(useSettingsUi.getState().tab).toBe('sync');
  });

  it('runs a round on demand and reports what moved', async () => {
    const success = vi.spyOn(toast, 'success');
    const user = userEvent.setup();
    seed(syncStatus());
    render(<SyncBadge />);

    await user.click(screen.getByRole('button', { name: '同步：已同步' }));
    await user.click(await screen.findByRole('button', { name: '立即同步' }));

    await waitFor(() => expect(urls('POST').some((url) => url.endsWith('/sync/run'))).toBe(true));
    // §7 F9: the number is `applied`, so the word is "应用". The fixture had
    // pulled === applied, which is exactly why the old label read as true.
    await waitFor(() => expect(success).toHaveBeenCalledWith('同步完成：应用 3 项，推送 2 项'));
    success.mockRestore();
  });
});

describe('a file operation that gave up', () => {
  beforeEach(() => {
    seed(syncStatus({ file_op_failures: 1 }), { fileOps: [fileOp()] });
  });

  it('shows what failed and retries just that row', async () => {
    const user = userEvent.setup();
    render(<SyncBadge />);

    await user.click(screen.getByRole('button', { name: '同步：已同步' }));

    expect(await screen.findByText('EACCES: permission denied')).toBeDefined();
    await user.click(screen.getByRole('button', { name: '重试文件操作 #7' }));

    await waitFor(() => {
      const retry = calls.find((call) => call.url.endsWith('/sync/file-ops/retry'));
      expect(retry?.body).toEqual({ id: 7 });
    });
  });

  // Discard destroys a file effect for good, so it is confirmed — and the
  // popover closes first, because a Dialog opened inside one fights it.
  it('confirms before discarding, and closes the popover to ask', async () => {
    const user = userEvent.setup();
    render(<SyncBadge />);

    await user.click(screen.getByRole('button', { name: '同步：已同步' }));
    await user.click(await screen.findByRole('button', { name: '放弃文件操作 #7' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('放弃后这次文件操作永远不会执行');
    expect(calls.some((call) => call.url.endsWith('/sync/file-ops/discard'))).toBe(false);

    await user.click(screen.getByRole('button', { name: '放弃' }));

    await waitFor(() => {
      const discard = calls.find((call) => call.url.endsWith('/sync/file-ops/discard'));
      expect(discard?.body).toEqual({ id: 7 });
    });
  });
});
