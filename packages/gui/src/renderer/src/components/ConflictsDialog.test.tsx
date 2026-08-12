// The conflict page (v0.2 T4): what it asks, what it sends, and what happens
// when the row moved on while the user was deciding.

import type { ConflictData, SongSyncPayload } from '@lark/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSync } from '../stores/sync.js';
import { ConflictsDialog } from './ConflictsDialog.js';

function payload(overrides: Partial<SongSyncPayload> = {}): SongSyncPayload {
  return {
    name: '温柔',
    artist: '五月天',
    source_url: 'https://www.bilibili.com/video/BV1',
    source_provider: 'bilibili',
    source_key: 'BV1:100',
    lyrics_offset: 0,
    duration: 250,
    created_at_ms: 1_700_000_000_000,
    updated_at_ms: 1_700_000_000_000,
    lww_counter: 0,
    ...overrides,
  };
}

function conflict(overrides: Partial<ConflictData> = {}): ConflictData {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    entity_type: 'song',
    entity_id: '22222222-2222-4222-8222-222222222222',
    detected_at: 1_700_000_000_000,
    remote_seq: 42,
    local_payload: payload({ artist: '五月天（现场版）' }),
    remote_payload: payload(),
    local_key: { updated_at_ms: 1_700_000_000_000, lww_counter: 1, device_id: 'dev-1' },
    remote_key: { updated_at_ms: 1_700_000_000_500, lww_counter: 0, device_id: 'dev-2' },
    ...overrides,
  };
}

interface Call {
  method: string;
  url: string;
  body: unknown;
}

let calls: Call[] = [];
let served: ConflictData[] = [];
/** Overrides the answer to a resolve when set. */
let resolveResponse: (() => Response) | null = null;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  calls = [];
  served = [conflict()];
  resolveResponse = null;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({
        method,
        url,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      if (url.includes('/resolve')) {
        if (resolveResponse !== null) return Promise.resolve(resolveResponse());
        return Promise.resolve(jsonResponse({ success: true, data: {} }));
      }
      if (url.endsWith('/conflicts')) {
        return Promise.resolve(jsonResponse({ success: true, data: { conflicts: served } }));
      }
      return Promise.resolve(jsonResponse({ success: true, data: {} }));
    }),
  );
  useSync.setState({ conflictList: [], conflicts: 0 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const resolves = (): Call[] => calls.filter((call) => call.url.includes('/resolve'));

async function open(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  render(<ConflictsDialog open onClose={() => {}} />);
  await screen.findByRole('dialog');
  return user;
}

describe('what the page asks', () => {
  it('fetches the receipts when it opens', async () => {
    await open();

    await waitFor(() =>
      expect(calls.some((call) => call.method === 'GET' && call.url.endsWith('/conflicts'))).toBe(
        true,
      ),
    );
  });

  // The difference IS the question; making the user re-read the fields that
  // agree buries it.
  it('lists only the fields that differ', async () => {
    await open();

    expect(await screen.findByText('五月天（现场版）')).toBeDefined();
    expect(screen.getByText('歌手')).toBeDefined();
    expect(screen.queryByText('时长')).toBeNull();
  });

  it('still offers to archive a receipt whose payloads cannot be parsed', async () => {
    served = [conflict({ local_payload: null, remote_payload: null })];
    await open();

    expect(await screen.findByText(/已无法解析/)).toBeDefined();
  });
});

describe('answering', () => {
  // The daemon compares this against the row before writing; without it a
  // restore could bury a third device's change nobody ever saw.
  it('sends the recorded remote key as expected_current', async () => {
    const user = await open();

    await user.click(await screen.findByRole('button', { name: /保留本机版本/ }));

    await waitFor(() => expect(resolves()).toHaveLength(1));
    expect(resolves()[0]?.body).toEqual({
      strategy: 'local',
      expected_current: { updated_at_ms: 1_700_000_000_500, lww_counter: 0, device_id: 'dev-2' },
    });
    expect(resolves()[0]?.url).toContain('/conflicts/11111111-1111-4111-8111-111111111111/resolve');
  });

  it('keeps the remote version without rewriting the row', async () => {
    const user = await open();

    await user.click(await screen.findByRole('button', { name: /保留远端版本/ }));

    await waitFor(() => expect(resolves()).toHaveLength(1));
    expect(resolves()[0]?.body).toMatchObject({ strategy: 'remote' });
  });

  // 409: a third device wrote while this was on screen. Re-ask against what is
  // actually there rather than reporting a generic failure.
  it('re-asks when the row moved on', async () => {
    const error = vi.spyOn(toast, 'error');
    const user = await open();
    resolveResponse = () =>
      jsonResponse(
        {
          success: false,
          error_code: 'CONFLICT_VERSION_MISMATCH',
          message: 'the row has moved on',
        },
        409,
      );

    await user.click(await screen.findByRole('button', { name: /保留本机版本/ }));

    await waitFor(() =>
      expect(error).toHaveBeenCalledWith('这首歌在此期间又被改过了，请对着最新的内容重新选择'),
    );
    // And the list is refetched, so the next decision is made against the
    // current state.
    await waitFor(() =>
      expect(
        calls.filter((call) => call.method === 'GET' && call.url.endsWith('/conflicts')).length,
      ).toBeGreaterThan(1),
    );
    error.mockRestore();
  });
});
