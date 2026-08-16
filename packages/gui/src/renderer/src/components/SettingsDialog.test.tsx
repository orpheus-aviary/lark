// The settings page (M5-1): what a save actually sends, how a rejection is
// shown, and the two refreshes an open costs.

import type { CacheStatusData, PublicLarkConfig } from '@lark/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCache } from '../stores/cache.js';
import { useConfig } from '../stores/config.js';
import { useMediaTools } from '../stores/media-tools.js';
import { useSettingsUi } from '../stores/settings-ui.js';
import { SettingsDialog } from './SettingsDialog.js';

const MIB = 1024 * 1024;

function publicConfig(overrides: Partial<PublicLarkConfig> = {}): PublicLarkConfig {
  return {
    llm: { url: 'https://llm.example', model: 'm', api_format: 'openai', has_api_key: true },
    window: { width: 1024, height: 768 },
    theme: { mode: 'system' },
    font: { global_font_size: 14, lyrics_font_size: 14 },
    log: { level: 'info', max_size_mb: 10, max_backups: 5 },
    storage: { cache_limit_mb: 0 },
    sync: { interval_min: 5 },
    ...overrides,
  };
}

function cacheStatus(overrides: Partial<CacheStatusData> = {}): CacheStatusData {
  return {
    used_bytes: 3 * MIB,
    file_count: 3,
    limit_mb: 0,
    eligible_bytes: 2 * MIB,
    unreclaimable_bytes: 1 * MIB,
    limit_satisfied: true,
    ...overrides,
  };
}

interface Call {
  method: string;
  url: string;
  body: unknown;
}

let calls: Call[] = [];
let config: PublicLarkConfig;
/** Overrides the answer to `PATCH /config` when set. */
let patchResponse: (() => Response) | null = null;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  calls = [];
  config = publicConfig();
  patchResponse = null;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({
        method,
        url,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      if (url.endsWith('/cache/status')) {
        return Promise.resolve(jsonResponse({ success: true, data: cacheStatus() }));
      }
      if (url.endsWith('/cache/evict')) {
        return Promise.resolve(
          jsonResponse({
            success: true,
            data: {
              ...cacheStatus({ used_bytes: 1 * MIB }),
              evicted_count: 2,
              freed_bytes: 2 * MIB,
              skipped_unverified_count: 1,
              skipped_unverified_bytes: MIB,
            },
          }),
        );
      }
      if (url.endsWith('/config') && method === 'PATCH') {
        if (patchResponse !== null) return Promise.resolve(patchResponse());
        return Promise.resolve(jsonResponse({ success: true, data: config }));
      }
      return Promise.resolve(jsonResponse({ success: true, data: config }));
    }),
  );
  useConfig.setState({ config });
  useCache.setState({ status: null, loading: false, evicting: false });
  // The dialog's open flag lives in a store now (v0.2 T4), so it outlives the
  // unmount and would leak into the next test.
  useSettingsUi.setState({ open: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Open the dialog and wait for the refreshes it triggers. */
async function open(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  render(<SettingsDialog />);
  await user.click(screen.getByRole('button', { name: '设置' }));
  await screen.findByRole('dialog');
  return user;
}

const patches = (): Call[] => calls.filter((c) => c.method === 'PATCH');

describe('opening', () => {
  it('refetches the config and the cache status', async () => {
    await open();

    await waitFor(() => {
      expect(calls.some((c) => c.method === 'GET' && c.url.endsWith('/config'))).toBe(true);
      expect(calls.some((c) => c.url.endsWith('/cache/status'))).toBe(true);
    });
  });

  it('never puts the stored api key in the field', async () => {
    await open();
    const key = screen.getByLabelText('API Key') as HTMLInputElement;
    expect(key.value).toBe('');
    expect(key.placeholder).toBe('已设置（留空保持不变）');
  });
});

describe('saving', () => {
  it('sends only the sections that changed', async () => {
    const user = await open();

    await user.clear(screen.getByLabelText('界面字号'));
    await user.type(screen.getByLabelText('界面字号'), '16');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]?.body).toEqual({ font: { global_font_size: 16 } });
  });

  it('leaves the api key alone when the field is empty, and clears it on request', async () => {
    const user = await open();

    await user.click(screen.getByRole('button', { name: '清除' }));
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]?.body).toEqual({ llm: { api_key: '' } });
  });

  it('closes without a request when nothing changed', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(patches()).toHaveLength(0);
  });

  // The daemon answers `details.path`, so the page can mark the field without
  // parsing the English message (M5-20).
  it('marks the offending field from details.path and stays open', async () => {
    const user = await open();
    patchResponse = () =>
      jsonResponse(
        {
          success: false,
          error_code: 'INVALID_CONFIG',
          message: 'log.max_backups must be an integer',
          details: { path: 'log.max_backups' },
        },
        400,
      );

    await user.clear(screen.getByLabelText('保留份数'));
    await user.type(screen.getByLabelText('保留份数'), '2.5');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText('log.max_backups must be an integer')).toBeDefined();
    expect(screen.queryByRole('dialog')).not.toBeNull();
  });
});

describe('the cache block', () => {
  it('shows what is used and what is reclaimable', async () => {
    await open();

    expect(await screen.findByText('3.0 MB')).toBeDefined(); // used
    expect(screen.getByText('2.0 MB')).toBeDefined(); // eligible
  });

  it('reports both what was freed and what could not be verified', async () => {
    const success = vi.spyOn(toast, 'success');
    const user = await open();
    await screen.findByRole('button', { name: '立即清理' });

    await user.click(screen.getByRole('button', { name: '立即清理' }));

    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/cache/evict'))).toBe(true));
    // The two outcomes are separate facts: what actually went, and what the
    // probe could not confirm (M5-18).
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith(
        '清理 2 首，释放 2.0 MB；另有 1 首暂未能联网确认可重下，已跳过',
      ),
    );
    success.mockRestore();
  });
});

// M7-9: the licences ship inside the app bundle, and a document nobody can
// open from inside the app is a document nobody reads.
describe('the about block', () => {
  it('shows the licence that was actually shipped', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog />);
    await user.click(screen.getByRole('button', { name: '设置' }));

    await user.click(await screen.findByRole('button', { name: '许可证' }));

    expect(window.larkAPI.readLegal).toHaveBeenCalledWith('license');
    expect(await screen.findByText(/MIT License/)).toBeTruthy();
  });

  // Absent is reported rather than rendered as an empty box: in a packaged
  // build it cannot happen, so seeing it means something is genuinely wrong.
  it('says so when the document is not in the bundle', async () => {
    const user = userEvent.setup();
    vi.mocked(window.larkAPI.readLegal).mockResolvedValueOnce(null);
    render(<SettingsDialog />);
    await user.click(screen.getByRole('button', { name: '设置' }));

    await user.click(await screen.findByRole('button', { name: '第三方软件声明' }));

    expect(await screen.findByText(/不在应用包内/)).toBeTruthy();
  });
});

// ─── The LLM block (§7 F5/F6 — criteria 39, 40) ─────────

describe('the LLM block', () => {
  it('shows "follow aviary" as itself, with what that currently resolves to', async () => {
    config = publicConfig({
      llm: { url: '', model: '', api_format: '', has_api_key: false },
    });
    // Both: the store is what the first render draws, the fetch stub is what
    // the open refetches (the dialog does both, and this test is about neither).
    useConfig.setState({ config });
    useMediaTools.setState({ llmEffectiveFormat: 'anthropic' });
    render(<SettingsDialog />);
    useSettingsUi.getState().openSettings();

    // The trigger renders the SELECTED item's label, so this is the mapping
    // under test: `''` on the wire reads as "follow aviary", with what it
    // currently resolves to — not as the protocol it used to claim.
    const trigger = await screen.findByLabelText('接口格式');
    await waitFor(() => expect(trigger.textContent).toBe('跟随 aviary（当前：anthropic）'));
  });

  it('says an empty key is not the same as no key', async () => {
    config = publicConfig({
      llm: { url: '', model: '', api_format: '', has_api_key: false },
    });
    useConfig.setState({ config });
    render(<SettingsDialog />);
    useSettingsUi.getState().openSettings();

    const key = (await screen.findByLabelText('API Key')) as HTMLInputElement;
    // The aviary fallback keeps the model working, so "未设置" alone was the
    // opposite of what happens (§7 F6).
    expect(key.placeholder).toContain('aviary');
  });
});

// ─── Which tab it opens on (§7 F4 — criterion 38) ───────

describe('the tab it lands on', () => {
  it('opens where the caller asked, and stays there across opens', async () => {
    render(<SettingsDialog />);

    useSettingsUi.getState().openSettings('sync');
    expect((await screen.findByRole('tab', { name: '同步' })).getAttribute('aria-selected')).toBe(
      'true',
    );

    // Closed and reopened from the gear icon: back to the general tab. The
    // Tabs are controlled, so this is a state change rather than a remount —
    // which is exactly what `defaultValue` could not do.
    useSettingsUi.getState().setOpen(false);
    useSettingsUi.getState().openSettings();
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: '常规' }).getAttribute('aria-selected')).toBe('true'),
    );
  });
});
