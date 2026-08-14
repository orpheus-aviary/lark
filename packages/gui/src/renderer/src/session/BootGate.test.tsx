// Which window this is (0.3.0 T3c, 判据 18).
//
// The three outcomes of one probe. The third — an unreachable daemon falling
// through to the app — is the one worth a test: the tempting implementation
// (block until `/status` answers) turns "the daemon is starting" into a window
// that never renders.

import type { AudioMigrationCounts, StatusData } from '@lark/shared';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMigration } from '../stores/migration.js';
import { BootGate } from './BootGate.js';

function counts(overrides: Partial<AudioMigrationCounts> = {}): AudioMigrationCounts {
  return {
    phase: 'pending',
    state: 'running',
    total: 4,
    done: 1,
    lost: 0,
    kept_unconverted: 0,
    asset_missing: 0,
    blocked: 0,
    blocked_file_op: 0,
    ...overrides,
  };
}

function status(migration: AudioMigrationCounts | undefined): StatusData {
  return {
    status: 'ok',
    pid: 42,
    uptime: 1,
    version: '0.3.0',
    nest_fingerprint: 'a'.repeat(64),
    local_api_version: 5,
    ...(migration === undefined ? {} : { audio_migration: migration }),
  };
}

let answer: () => Promise<Response>;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  useMigration.setState({ phase: 'unknown', counts: null, report: null, probed: false });
  answer = () => Promise.resolve(jsonResponse({ success: true, data: status(undefined) }));
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url.includes('/api/audio-migration')) {
        return Promise.resolve(
          jsonResponse({
            success: true,
            data: {
              counts: counts(),
              reason: null,
              objects: [],
              backup: { file_count: 0, bytes: 0, asset_count: 0, asset_bytes: 0 },
            },
          }),
        );
      }
      return answer();
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('BootGate', () => {
  it('shows the app when the daemon is serving the library', async () => {
    answer = () =>
      Promise.resolve(jsonResponse({ success: true, data: status(counts({ phase: 'normal' })) }));

    render(
      <BootGate>
        <p>曲库</p>
      </BootGate>,
    );

    expect(await screen.findByText('曲库')).toBeDefined();
  });

  it('shows the migration screen while the library is not served', async () => {
    answer = () => Promise.resolve(jsonResponse({ success: true, data: status(counts()) }));

    render(
      <BootGate>
        <p>曲库</p>
      </BootGate>,
    );

    expect(await screen.findByText('正在把曲库转换成 m4a')).toBeDefined();
    expect(screen.queryByText('曲库')).toBeNull();
  });

  it('still refuses the library while activation runs', async () => {
    answer = () =>
      Promise.resolve(
        jsonResponse({ success: true, data: status(counts({ phase: 'activating' })) }),
      );

    render(
      <BootGate>
        <p>曲库</p>
      </BootGate>,
    );

    expect(await screen.findByText('正在把曲库转换成 m4a')).toBeDefined();
  });

  it('falls through to the app when the daemon cannot be reached', async () => {
    answer = () => Promise.reject(new Error('ECONNREFUSED'));

    render(
      <BootGate>
        <p>曲库</p>
      </BootGate>,
    );

    // The app has handled an absent daemon since M4; blocking here would show
    // an empty window instead.
    expect(await screen.findByText('曲库')).toBeDefined();
  });

  it('treats a pre-0.3 daemon as serving', async () => {
    answer = () => Promise.resolve(jsonResponse({ success: true, data: status(undefined) }));

    render(
      <BootGate>
        <p>曲库</p>
      </BootGate>,
    );

    expect(await screen.findByText('曲库')).toBeDefined();
  });

  it('hands over to the app the moment the migration finishes', async () => {
    answer = () => Promise.resolve(jsonResponse({ success: true, data: status(counts()) }));

    render(
      <BootGate>
        <p>曲库</p>
      </BootGate>,
    );
    expect(await screen.findByText('正在把曲库转换成 m4a')).toBeDefined();

    // The daemon activated; the next poll is what the window learns it from.
    answer = () =>
      Promise.resolve(jsonResponse({ success: true, data: status(counts({ phase: 'normal' })) }));
    await waitFor(() => expect(screen.queryByText('曲库')).not.toBeNull(), { timeout: 3000 });
  });
});
