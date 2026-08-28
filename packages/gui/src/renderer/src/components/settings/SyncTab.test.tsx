// The sync settings tab (v0.2 T4): logging in (including the two-step
// plaintext-HTTP breaker), what a bound library refuses, and the device list.

import type { PublicLarkConfig, SyncDeviceData, SyncStatusData, WorkspaceData } from '@lark/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSync } from '../../stores/sync.js';
import { SyncTab } from './SyncTab.js';
import { type Draft, toDraft } from './draft.js';

function publicConfig(): PublicLarkConfig {
  return {
    llm: { url: '', model: '', api_format: 'openai', has_api_key: false },
    window: { width: 1024, height: 768 },
    theme: { mode: 'system' },
    font: { global_font_size: 14, lyrics_font_size: 14 },
    log: { level: 'info', max_size_mb: 10, max_backups: 5 },
    storage: { cache_limit_mb: 0 },
    playback: { auto_download_next: true },
    desktop_lyrics: {
      enabled: false,
      lines: 1,
      font_size: 32,
      preset: 'classic',
      locked: false,
      x: 0,
      y: 0,
      width: 900,
      height: 120,
    },
    sync: { interval_min: 5 },
  };
}

function syncStatus(overrides: Partial<SyncStatusData> = {}): SyncStatusData {
  return {
    configured: false,
    authenticated: false,
    bound: false,
    server_url: null,
    device_id: null,
    workspace_id: null,
    pending_count: 0,
    pulled_seq: 0,
    pushed_seq: 0,
    last_sync_at: null,
    state: 'auth_required',
    auth_reason: 'missing_session',
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

function device(overrides: Partial<SyncDeviceData> = {}): SyncDeviceData {
  return {
    id: 'dev-2',
    name: 'studio-mac',
    platform: 'darwin',
    // `lark <version>` is what registration actually writes
    // (`coordinator/login.ts`), and since N7c it is also what decides whether
    // a row belongs on this screen at all.
    app_version: 'lark 0.3.0',
    client_version: '0.1.4',
    created_at: 1_700_000_000_000,
    last_seen_at: 1_700_000_000_000,
    revoked_at: null,
    is_current: false,
    ...overrides,
  };
}

interface Call {
  method: string;
  url: string;
  body: unknown;
}

let calls: Call[] = [];
let devices: SyncDeviceData[] = [];
let workspaces: WorkspaceData[] = [];
let syncTraces = false;
/** Overrides the answer to `POST /sync/login` when set. */
let loginResponse: (() => Response) | null = null;
let updates: Partial<Draft>[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderTab(): ReturnType<typeof userEvent.setup> {
  const user = userEvent.setup();
  render(
    <SyncTab
      draft={toDraft(publicConfig())}
      update={(patch) => updates.push(patch)}
      errorFor={() => undefined}
    />,
  );
  return user;
}

beforeEach(() => {
  calls = [];
  devices = [];
  workspaces = [{ id: 'local', label: '', server_url: '', active: true, songs: 3, playlists: 1 }];
  syncTraces = false;
  loginResponse = null;
  updates = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({
        method,
        url,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      if (url.includes('/sync/login')) {
        if (loginResponse !== null) return Promise.resolve(loginResponse());
        return Promise.resolve(
          jsonResponse({
            success: true,
            data: {
              server_url: 'https://sync.example',
              user_id: 'u-1',
              email: 'me@example.com',
              device_id: 'dev-1',
              device_name: 'laptop',
              device_reused: false,
              workspace_id: 'ws-1',
              backfill: null,
              rebased_entities: 0,
              device_stamp: 'first-registration',
              local_workspace_id: 'local',
              local_workspace_created: false,
              restart_required: false,
            },
          }),
        );
      }
      if (url.includes('/workspaces/switch')) {
        return Promise.resolve(
          jsonResponse({
            success: true,
            data: { id: 'other', previous: 'local', changed: true, restart_required: true },
          }),
        );
      }
      if (url.includes('/workspaces')) {
        return Promise.resolve(
          jsonResponse({
            success: true,
            data: {
              workspaces,
              serving: 'local',
              serving_has_sync_traces: syncTraces,
            },
          }),
        );
      }
      if (url.includes('/sync/devices')) {
        return Promise.resolve(jsonResponse({ success: true, data: { devices } }));
      }
      if (url.includes('/sync/logout')) {
        return Promise.resolve(
          jsonResponse({ success: true, data: { had_session: true, revoked_remotely: true } }),
        );
      }
      if (url.includes('/sync/status')) {
        return Promise.resolve(jsonResponse({ success: true, data: syncStatus() }));
      }
      return Promise.resolve(jsonResponse({ success: true, data: {} }));
    }),
  );
  useSync.setState({
    status: null,
    conflicts: 0,
    failedFileOps: [],
    running: false,
    devices: [],
    devicesError: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const posted = (path: string): Call | undefined =>
  calls.find((call) => call.method === 'POST' && call.url.endsWith(path));

async function fillLogin(
  user: ReturnType<typeof userEvent.setup>,
  serverUrl = 'https://sync.example',
): Promise<void> {
  await user.type(screen.getByLabelText('服务器地址'), serverUrl);
  await user.type(screen.getByLabelText('邮箱'), 'me@example.com');
  await user.type(screen.getByLabelText('密码'), 'hunter2');
}

describe('logging in', () => {
  it('sends the form and forgets the password afterwards', async () => {
    useSync.setState({ status: syncStatus() });
    const user = renderTab();

    await fillLogin(user);
    await user.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => expect(posted('/sync/login')).toBeDefined());
    expect(posted('/sync/login')?.body).toEqual({
      // 并入 by default: logging in has always made THIS library the
      // account's, and N7 keeps that as the default rather than the only
      // option.
      workspace_origin: 'claim',
      server_url: 'https://sync.example',
      email: 'me@example.com',
      password: 'hunter2',
    });
    // The field is cleared the moment the login lands; nothing keeps it for a
    // retry.
    await waitFor(() => expect((screen.getByLabelText('密码') as HTMLInputElement).value).toBe(''));
  });

  // §3.7: a login sends a password, so plaintext HTTP takes TWO deliberate
  // acts — the checkbox alone must not put the breaker on the request.
  it('asks a second time before allowing plaintext http', async () => {
    useSync.setState({ status: syncStatus() });
    const user = renderTab();

    await fillLogin(user, 'http://sync.example');
    await user.click(screen.getByLabelText(/允许明文 HTTP/));
    await user.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByRole('dialog')).toBeDefined();
    expect(posted('/sync/login')).toBeUndefined();

    await user.click(screen.getByRole('button', { name: '继续登录' }));

    await waitFor(() => expect(posted('/sync/login')).toBeDefined());
    expect(posted('/sync/login')?.body).toMatchObject({ allow_insecure_http: true });
  });

  it('leaves the breaker off when the box is not ticked', async () => {
    useSync.setState({ status: syncStatus() });
    const user = renderTab();

    await fillLogin(user, 'http://sync.example');
    await user.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => expect(posted('/sync/login')).toBeDefined());
    expect(posted('/sync/login')?.body).not.toHaveProperty('allow_insecure_http');
  });

  // The daemon's message is written for the CLI ("run `lark sync unbind`"),
  // which is the wrong instruction to give someone looking at a window.
  it('explains a binding mismatch in the window, not in CLI terms', async () => {
    useSync.setState({ status: syncStatus() });
    loginResponse = () =>
      jsonResponse(
        {
          success: false,
          error_code: 'SYNC_BINDING_MISMATCH',
          message: 'this library is bound to a different workspace',
        },
        409,
      );
    const user = renderTab();

    await fillLogin(user);
    await user.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByText(/已经绑定到另一个账号或 workspace/)).toBeDefined();
  });
});

describe('an account that is logged in', () => {
  const bound = syncStatus({
    configured: true,
    authenticated: true,
    bound: true,
    server_url: 'https://sync.example',
    device_id: 'dev-1',
    workspace_id: 'ws-1',
    state: 'idle',
    auth_reason: null,
  });

  it('lists the devices and revokes one behind a confirmation', async () => {
    devices = [device(), device({ id: 'dev-1', name: 'laptop', is_current: true })];
    useSync.setState({ status: bound });
    const user = renderTab();

    expect(await screen.findByText(/studio-mac/)).toBeDefined();
    await user.click(screen.getByRole('button', { name: '吊销设备 studio-mac' }));

    expect((await screen.findByRole('dialog')).textContent).toContain('studio-mac');
    expect(posted('/sync/revoke-device')).toBeUndefined();

    await user.click(screen.getByRole('button', { name: '吊销' }));

    await waitFor(() =>
      expect(posted('/sync/revoke-device')?.body).toEqual({ device_id: 'dev-2' }),
    );
  });

  // Revoking the machine you are sitting at is allowed (a stolen laptop's
  // replacement is a real case) but it has to say what it costs.
  it('warns differently when the device being revoked is this one', async () => {
    devices = [device({ id: 'dev-1', name: 'laptop', is_current: true })];
    useSync.setState({ status: bound });
    const user = renderTab();

    await user.click(await screen.findByRole('button', { name: '吊销设备 laptop' }));

    expect((await screen.findByRole('dialog')).textContent).toContain('这是本机');
  });

  // Criterion 111. The same skybridge account carries owl's registrations, and
  // the judgement is `@lark/shared`'s so the two front ends cannot drift.
  it('shows only lark’s devices, and says how many it is not showing', async () => {
    devices = [
      device({ id: 'dev-1', name: 'laptop', app_version: 'lark 0.3.0' }),
      device({ id: 'dev-2', name: 'owl-cloud', app_version: 'owl 0.5.0' }),
      device({ id: 'dev-3', name: 'jayncp mac (owl)', app_version: 'owl 0.5.0' }),
      // Unknown stays: this list is where somebody revokes a device they no
      // longer trust, and an unprovable row must not be hidden.
      device({ id: 'dev-4', name: 'something old', app_version: null }),
    ];
    useSync.setState({ status: bound });
    renderTab();

    expect(await screen.findByText(/laptop/)).toBeDefined();
    expect(screen.getByText(/something old/)).toBeDefined();
    expect(screen.queryByText(/owl-cloud/)).toBeNull();
    // Counted and said out loud: those two hold this account's credentials.
    expect(screen.getByText(/另有 2 台设备/)).toBeDefined();
  });

  // N7g-3. The server cannot delete a revoked device (the change log's
  // `device_id` is ON DELETE RESTRICT) and a re-login registers a NEW one
  // instead of reusing it — so the same machine revoked twice is three rows.
  // Folded, not filtered: this list is where somebody checks what holds their
  // credentials, and dropping rows would answer that wrongly.
  it('folds revoked devices away, and opens them with their reason', async () => {
    devices = [
      device({ id: 'dev-1', name: 'laptop' }),
      device({ id: 'dev-2', name: 'old-phone', revoked_at: 1_700_000_000_000 }),
      device({ id: 'dev-3', name: 'older-phone', revoked_at: 1_600_000_000_000 }),
    ];
    useSync.setState({ status: bound });
    const user = renderTab();

    expect(await screen.findByText(/laptop/)).toBeDefined();
    expect(screen.queryByText(/old-phone/)).toBeNull();

    await user.click(screen.getByRole('button', { name: '显示已撤销的 2 台' }));

    expect(screen.getByText(/^old-phone/)).toBeDefined();
    expect(screen.getByText(/older-phone/)).toBeDefined();
    // Opening it raises "can I delete these?", and the answer has to be there.
    expect(screen.getByText(/哪台设备写的/)).toBeDefined();

    await user.click(screen.getByRole('button', { name: '收起已撤销的 2 台' }));
    expect(screen.queryByText(/older-phone/)).toBeNull();
  });

  it('has no fold when nothing is revoked', async () => {
    devices = [device({ id: 'dev-1', name: 'laptop' })];
    useSync.setState({ status: bound });
    renderTab();

    expect(await screen.findByText(/laptop/)).toBeDefined();
    expect(screen.queryByText(/已撤销的/)).toBeNull();
  });

  it('says nothing about other tools when there are none', async () => {
    devices = [device({ id: 'dev-1', name: 'laptop' })];
    useSync.setState({ status: bound });
    renderTab();

    expect(await screen.findByText(/laptop/)).toBeDefined();
    expect(screen.queryByText(/另有/)).toBeNull();
  });

  // ── The libraries on this machine (N7e-3) ────────────────────────────────
  //
  // Criterion 115 on screen: a switch is behind a confirmation that says what
  // it costs, and the app goes on showing the library it has open until
  // somebody restarts.
  describe('the workspace switcher', () => {
    const other = {
      id: '0d37bfbdb385448f80a53bd8ba7e61d3',
      label: 'me@example.com',
      server_url: 'https://sync.example',
      active: false,
      songs: 12,
      playlists: 2,
    };

    it('lists what is here and which one is in use', async () => {
      workspaces = [
        { id: 'local', label: '', server_url: '', active: true, songs: 3, playlists: 1 },
        other,
      ];
      const user = renderTab();

      expect(await screen.findByRole('button', { name: /切换到 me@example.com/ })).toBeDefined();
      expect(screen.getByText(/正在使用/)).toBeDefined();
      expect(screen.getByText(/me@example.com/)).toBeDefined();
      expect(screen.getByText(/12 首歌/)).toBeDefined();
      // The one already in use offers no switch.
      expect(screen.queryByRole('button', { name: /切换到 本机曲库/ })).toBeNull();
      void user;
    });

    it('asks before switching, and says a restart is what opens it', async () => {
      workspaces = [
        { id: 'local', label: '', server_url: '', active: true, songs: 3, playlists: 1 },
        other,
      ];
      const user = renderTab();

      await user.click(await screen.findByRole('button', { name: /切换到 me@example.com/ }));
      const dialog = await screen.findByRole('dialog');
      expect(dialog.textContent).toContain('需要重启');
      // §2.5: nothing is written until somebody agrees.
      expect(posted('/workspaces/switch')).toBeUndefined();

      await user.click(screen.getByRole('button', { name: '同意' }));

      await waitFor(() =>
        expect(posted('/workspaces/switch')?.body).toEqual({ workspace_id: other.id }),
      );
      // And then it offers the restart rather than performing one.
      expect((await screen.findByRole('dialog')).textContent).toContain('重启');
    });

    it('writes nothing when the confirmation is declined', async () => {
      workspaces = [
        { id: 'local', label: '', server_url: '', active: true, songs: 3, playlists: 1 },
        other,
      ];
      const user = renderTab();

      await user.click(await screen.findByRole('button', { name: /切换到 me@example.com/ }));
      await user.click(screen.getByRole('button', { name: '取消' }));

      expect(posted('/workspaces/switch')).toBeUndefined();
    });

    it('says which one the next launch opens when they differ', async () => {
      // The window between a switch and the restart that honours it — the one
      // moment a person has to be told these are two different things.
      workspaces = [
        { id: 'local', label: '', server_url: '', active: false, songs: 3, playlists: 1 },
        { ...other, active: true },
      ];
      renderTab();

      expect(await screen.findByText(/正在使用/)).toBeDefined();
      expect(screen.getByText(/重启后使用/)).toBeDefined();
    });
  });

  it('says the binding survives a logout', async () => {
    useSync.setState({ status: bound });
    const user = renderTab();

    expect(screen.getByText(/登出只清除本机凭证/)).toBeDefined();
    await user.click(screen.getByRole('button', { name: '登出' }));

    await waitFor(() => expect(posted('/sync/logout')).toBeDefined());
  });

  // The interval is config, so it rides the dialog's save like every other
  // field — it must not write on change.
  it('edits the poll interval through the draft, not the wire', async () => {
    useSync.setState({ status: bound });
    const user = renderTab();

    await user.click(screen.getByLabelText('轮询间隔'));
    await user.click(await screen.findByRole('option', { name: '15 分钟' }));

    expect(updates).toEqual([{ syncIntervalMin: 15 }]);
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
  });
});

describe('choosing where a login lands', () => {
  it('warns before claiming a library that carries another account’s traces', async () => {
    syncTraces = true;
    useSync.setState({ status: syncStatus() });
    renderTab();
    // owl's B8 warning: claiming it would republish what the old account
    // already had.
    expect(await screen.findByText(/上一个账号的同步痕迹/)).toBeDefined();
  });

  it('says nothing when there is nothing to warn about', async () => {
    syncTraces = false;
    useSync.setState({ status: syncStatus() });
    renderTab();
    await screen.findByLabelText('邮箱');
    expect(screen.queryByText(/上一个账号的同步痕迹/)).toBeNull();
  });

  it('offers the restart when the account’s library is a different one', async () => {
    useSync.setState({ status: syncStatus() });
    loginResponse = () =>
      jsonResponse({
        success: true,
        data: {
          server_url: 'https://sync.example',
          user_id: 'u-1',
          email: 'me@example.com',
          device_id: 'dev-1',
          device_name: 'laptop',
          device_reused: false,
          workspace_id: 'ws-1',
          backfill: null,
          rebased_entities: 0,
          device_stamp: 'first-registration',
          local_workspace_id: '0d37bfbdb385448f80a53bd8ba7e61d3',
          local_workspace_created: true,
          restart_required: true,
        },
      });
    const user = renderTab();

    await screen.findByLabelText('邮箱');
    await fillLogin(user);
    await user.click(screen.getByRole('button', { name: '登录' }));

    // Without this the login looks like it did not take: the song list does
    // not change and nothing syncs.
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('重启');
    expect(dialog.textContent).toContain('不会开始同步');
  });
});
