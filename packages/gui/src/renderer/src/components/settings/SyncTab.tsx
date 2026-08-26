// The sync half of the settings page (v0.2 T4, §4.7).
//
// This is where sync is turned on, turned off, and pointed at a server. Three
// rules hold it together:
//
//   THE PASSWORD IS USED ONCE. It lives in local state until the request is
//   sent and is cleared the moment the login lands. It is never logged, never
//   put in a URL and never kept for a retry.
//
//   PLAINTEXT HTTP IS CONFIRMED TWICE (§3.7). A login sends a password, so the
//   breaker is a checkbox AND a dialog — one deliberate act each, and neither
//   alone gets `allow_insecure_http` onto the request.
//
//   THE DEVICE LIST IS A REMOTE READ. It is fetched when this tab opens and on
//   demand, never on a timer, and a failure is shown next to the list instead
//   of as a toast.

import type { SyncDeviceData, WorkspaceData, WorkspaceOriginChoice } from '@lark/shared';
import {
  ApiError,
  REVOKED_DEVICES_NOTE,
  authReasonLabel,
  hiddenDevicesNote,
  loginErrorMessage,
  revokedDevicesLabel,
  splitLarkDevices,
  splitRevokedDevices,
} from '@lark/shared';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '../../lib/errors.js';
import { formatRelativeTime } from '../../lib/format.js';
import { useSync } from '../../stores/sync.js';
import { useWorkspaces } from '../../stores/workspaces.js';
import { ConfirmDialog } from '../ConfirmDialog.js';
import { DISCARD_FILE_OP_DESCRIPTION, SyncFileOpsList } from '../SyncFileOpsList.js';
import { Button } from '../ui/button.js';
import { Checkbox } from '../ui/checkbox.js';
import { Input } from '../ui/input.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select.js';
import type { Draft } from './draft.js';
import { Field, Section } from './fields.js';

/** Background-pull cadence. A floor, not the whole story: SSE and mutations fire sooner. */
const SYNC_INTERVALS = [1, 5, 15, 30, 60] as const;

interface SyncTabProps {
  draft: Draft;
  update: (patch: Partial<Draft>) => void;
  errorFor: (path: string) => string | undefined;
}

interface LoginDraft {
  serverUrl: string;
  email: string;
  password: string;
  allowInsecure: boolean;
  /** N7: what to do when this account has no library on this machine yet. */
  origin: WorkspaceOriginChoice;
}

function LoginForm({ serverUrl }: { serverUrl: string | null }): React.JSX.Element {
  const login = useSync((s) => s.login);
  const refreshWorkspaces = useWorkspaces((s) => s.refresh);
  const hasSyncTraces = useWorkspaces((s) => s.servingHasSyncTraces);
  const [form, setForm] = useState<LoginDraft>({
    serverUrl: serverUrl ?? '',
    email: '',
    password: '',
    allowInsecure: false,
    // 并入 is the default because it is what logging in used to do: this
    // library becomes the account's.
    origin: 'claim',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  /** Set when the account's library is not the one this app has open. */
  const [restartNeeded, setRestartNeeded] = useState(false);

  const submit = async (): Promise<void> => {
    setConfirming(false);
    setBusy(true);
    setError(null);
    try {
      const result = await login({
        server_url: form.serverUrl.trim(),
        email: form.email.trim(),
        password: form.password,
        workspace_origin: form.origin,
        ...(form.allowInsecure ? { allow_insecure_http: true } : {}),
      });
      // Gone from memory as soon as it has been used.
      setForm((current) => ({ ...current, password: '' }));
      refreshWorkspaces();
      const backfilled = result.backfill;
      toast.success(
        backfilled === null
          ? `已登录：${result.email}`
          : `已登录：${result.email}，首次同步将上传 ${backfilled.songs} 首歌 / ${backfilled.playlists} 个歌单`,
      );
      // The account's library is a different file, and this app has the old
      // one open. Saying nothing here would look like a login that did not
      // take: the song list would not change and nothing would sync.
      setRestartNeeded(result.restart_required);
    } catch (err) {
      setError(
        err instanceof ApiError ? loginErrorMessage(err.errorCode, err.message) : errorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  };

  const start = (): void => {
    // Second of the two confirmations: the checkbox said "I know", the dialog
    // says what it costs.
    if (form.allowInsecure) setConfirming(true);
    else void submit();
  };

  return (
    <div className="space-y-3">
      <Field label="服务器地址" htmlFor="sync-server">
        <Input
          id="sync-server"
          placeholder="https://sync.example.com"
          value={form.serverUrl}
          onChange={(e) => setForm({ ...form, serverUrl: e.target.value })}
        />
      </Field>
      <Field label="邮箱" htmlFor="sync-email">
        <Input
          id="sync-email"
          type="email"
          autoComplete="off"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
        />
      </Field>
      <Field label="密码" htmlFor="sync-password">
        <Input
          id="sync-password"
          type="password"
          autoComplete="off"
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') start();
          }}
        />
      </Field>

      <Field
        label="这个账号的曲库"
        htmlFor="sync-origin"
        hint="只在这个账号还没有本机曲库时用到；已经有的话直接打开它"
      >
        <Select
          value={form.origin}
          onValueChange={(value) => setForm({ ...form, origin: value as WorkspaceOriginChoice })}
        >
          <SelectTrigger id="sync-origin">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="claim">并入当前曲库（复制一份，当前曲库保持不变）</SelectItem>
            <SelectItem value="fresh">给这个账号新建一个空曲库</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {form.origin === 'claim' && hasSyncTraces && (
        <p className="grid grid-cols-[8rem_1fr] gap-3 text-xs">
          <span />
          <span className="text-destructive">
            当前曲库里还留着上一个账号的同步痕迹。并入之后，这些内容会被当作新账号的内容重新上传一遍。
          </span>
        </p>
      )}

      <div className="grid grid-cols-[8rem_1fr] items-start gap-3 text-xs">
        <span />
        <label htmlFor="sync-insecure" className="flex cursor-pointer items-start gap-2">
          <Checkbox
            id="sync-insecure"
            checked={form.allowInsecure}
            onCheckedChange={(checked) => setForm({ ...form, allowInsecure: checked === true })}
          />
          <span className="text-muted-foreground">
            允许明文 HTTP（登录会发送密码，只有在本机或完全可信的网络里才该勾选）
          </span>
        </label>
      </div>

      {error !== null && <p className="text-destructive text-xs">{error}</p>}

      <div className="grid grid-cols-[8rem_1fr] gap-3">
        <span />
        <div>
          <Button
            size="sm"
            disabled={busy || form.serverUrl.trim() === '' || form.email.trim() === ''}
            onClick={start}
          >
            {busy ? '登录中…' : '登录'}
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirming}
        title="使用明文 HTTP 登录"
        description="密码会以明文发送，同一网络上的任何人都可能读到它。确定继续吗？"
        confirmLabel="继续登录"
        destructive
        onConfirm={() => void submit()}
        onCancel={() => setConfirming(false)}
      />

      {/* The login worked and this app still has the OLD library open. Not a
          dialog: the login already happened, so there is nothing left to
          agree to — only something to do when it suits. */}
      <ConfirmDialog
        open={restartNeeded}
        title="重启后打开这个账号的曲库"
        description="登录已经完成，这个账号的曲库已经准备好了。lark 现在打开的还是原来的曲库——重启一次才会切过去，在那之前不会开始同步。"
        confirmLabel="立即重启"
        cancelLabel="稍后手动重启"
        onConfirm={() => {
          setRestartNeeded(false);
          void window.larkAPI.restartApp();
        }}
        onCancel={() => setRestartNeeded(false)}
      />
    </div>
  );
}

/**
 * The libraries on this machine (N7e-3).
 *
 * 🔴 IT SHOWS TWO DIFFERENT FACTS AND MUST NOT COLLAPSE THEM: the library this
 * app currently has OPEN, and the one it will open next time. They differ from
 * the moment somebody switches until they restart, and that window is exactly
 * when a person needs to be told which is which.
 */
function WorkspacesSection(): React.JSX.Element {
  const workspaces = useWorkspaces((s) => s.workspaces);
  const serving = useWorkspaces((s) => s.serving);
  const error = useWorkspaces((s) => s.error);
  const refresh = useWorkspaces((s) => s.refresh);
  const switchTo = useWorkspaces((s) => s.switchTo);
  const [pending, setPending] = useState<WorkspaceData | null>(null);
  const [restartNeeded, setRestartNeeded] = useState(false);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const confirmSwitch = async (): Promise<void> => {
    const target = pending;
    setPending(null);
    if (target === null) return;
    try {
      const result = await switchTo(target.id);
      setRestartNeeded(result.restart_required);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <Section title="曲库" hint="每个账号在本机有各自的曲库，互不可见；没有登录过的那个在最上面">
      <div className="space-y-2 text-xs">
        {error !== null && <p className="text-muted-foreground">读取曲库列表失败：{error}</p>}
        {workspaces === null ? (
          <p className="text-muted-foreground">正在读取曲库列表…</p>
        ) : (
          <ul className="space-y-2">
            {workspaces.map((workspace) => (
              <li
                key={workspace.id}
                className="flex items-start justify-between gap-3 rounded-md border border-border p-2"
              >
                <div className="min-w-0">
                  <p className="truncate">
                    {workspaceTitle(workspace)}
                    {workspace.id === serving && (
                      <span className="ml-1 text-muted-foreground">（正在使用）</span>
                    )}
                    {workspace.active && workspace.id !== serving && (
                      <span className="ml-1 text-destructive">（重启后使用）</span>
                    )}
                  </p>
                  <p className="text-muted-foreground">
                    {workspace.songs} 首歌 · {workspace.playlists} 个歌单
                    {workspace.server_url === '' ? '' : ` · ${workspace.server_url}`}
                  </p>
                </div>
                {!workspace.active && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`切换到 ${workspaceTitle(workspace)}`}
                    onClick={() => setPending(workspace)}
                  >
                    切换
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={pending !== null}
        title="切换曲库需要重启应用"
        description="切换只是改一行记录，lark 现在打开的曲库不会受影响。重启之后才会打开新的曲库；在那之前，正在播放和正在下载的都照旧。同意吗？"
        confirmLabel="同意"
        cancelLabel="取消"
        onConfirm={() => void confirmSwitch()}
        onCancel={() => setPending(null)}
      />

      <ConfirmDialog
        open={restartNeeded}
        title="已记下，重启后生效"
        description="下次启动 lark 会打开你选的曲库。现在重启吗？"
        confirmLabel="立即重启"
        cancelLabel="稍后手动重启"
        onConfirm={() => {
          setRestartNeeded(false);
          void window.larkAPI.restartApp();
        }}
        onCancel={() => setRestartNeeded(false)}
      />
    </Section>
  );
}

/** What a person recognises: the account, or the words for the one with none. */
function workspaceTitle(workspace: WorkspaceData): string {
  if (workspace.id === 'local') return '本机曲库';
  return workspace.label === '' ? `账号曲库 ${workspace.id.slice(0, 8)}` : workspace.label;
}

function DeviceRow({
  device,
  onRevoke,
}: {
  device: SyncDeviceData;
  onRevoke: (device: SyncDeviceData) => void;
}): React.JSX.Element {
  return (
    <li className="flex items-start justify-between gap-3 rounded-md border border-border p-2">
      <div className="min-w-0">
        <p className="truncate">
          {device.name}
          {device.is_current && <span className="ml-1 text-muted-foreground">（本机）</span>}
          {device.revoked_at !== null && <span className="ml-1 text-destructive">（已吊销）</span>}
        </p>
        <p className="text-muted-foreground">
          {[device.platform, device.app_version].filter(Boolean).join(' · ') || '—'} · 最近活动{' '}
          {formatRelativeTime(device.last_seen_at, Date.now()) || '未知'}
        </p>
      </div>
      {device.revoked_at === null && (
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive"
          aria-label={`吊销设备 ${device.name}`}
          onClick={() => onRevoke(device)}
        >
          吊销
        </Button>
      )}
    </li>
  );
}

/**
 * The devices on this account, in two groups.
 *
 * 🔴 DEVICES ARE PER ACCOUNT, NOT PER WORKSPACE (N7c, criterion 111): the same
 * skybridge account carries owl's registrations too. The judgement is
 * `@lark/shared`'s so the two front ends cannot drift — a device the phone
 * hides and this shows is a device nobody can reason about.
 *
 * 🔴 AND REVOKED ONES NEVER GO AWAY (N7g-3, `@lark/shared/sync-devices.ts`
 * says why): the server soft-revokes because the change log's `device_id` is
 * ON DELETE RESTRICT, and a re-login after a revoke registers a NEW device
 * rather than reusing the closed one. So this list only grows. Folded rather
 * than filtered — this is the screen somebody comes to when they want to know
 * what holds their credentials, and hiding rows outright would answer that
 * question wrongly.
 */
function DeviceList({
  onRevoke,
}: {
  onRevoke: (device: SyncDeviceData) => void;
}): React.JSX.Element {
  const devices = useSync((s) => s.devices);
  const devicesError = useSync((s) => s.devicesError);
  const refreshDevices = useSync((s) => s.refreshDevices);
  const [showRevoked, setShowRevoked] = useState(false);

  const larkOnly = useMemo(
    () => splitLarkDevices(devices, (device) => device.app_version),
    [devices],
  );
  const byRevoked = useMemo(
    () => splitRevokedDevices(larkOnly.shown, (device) => device.revoked_at),
    [larkOnly],
  );
  const hiddenNote = hiddenDevicesNote(larkOnly.hidden);
  const revokedLabel = revokedDevicesLabel(byRevoked.revoked.length, showRevoked);

  const list = (rows: readonly SyncDeviceData[]) => (
    <ul className="space-y-2">
      {rows.map((device) => (
        <DeviceRow key={device.id} device={device} onRevoke={onRevoke} />
      ))}
    </ul>
  );

  return (
    <div className="space-y-2 text-xs">
      {devicesError !== null ? (
        <p className="text-muted-foreground">读取设备列表失败：{devicesError}</p>
      ) : devices.length === 0 ? (
        <p className="text-muted-foreground">正在读取设备列表…</p>
      ) : (
        <>
          {byRevoked.active.length === 0 ? (
            <p className="text-muted-foreground">这个账号下还没有 lark 的设备。</p>
          ) : (
            list(byRevoked.active)
          )}
          {revokedLabel !== null && (
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              aria-expanded={showRevoked}
              onClick={() => setShowRevoked((open) => !open)}
            >
              {revokedLabel}
            </Button>
          )}
          {showRevoked && (
            <>
              <p className="text-muted-foreground">{REVOKED_DEVICES_NOTE}</p>
              {list(byRevoked.revoked)}
            </>
          )}
          {hiddenNote !== null && <p className="text-muted-foreground">{hiddenNote}</p>}
        </>
      )}
      <Button size="sm" variant="secondary" onClick={() => refreshDevices()}>
        刷新
      </Button>
    </div>
  );
}

export function SyncTab({ draft, update, errorFor }: SyncTabProps): React.JSX.Element {
  const status = useSync((s) => s.status);
  const refreshDevices = useSync((s) => s.refreshDevices);
  const logout = useSync((s) => s.logout);
  const revokeDevice = useSync((s) => s.revokeDevice);
  const discardFileOp = useSync((s) => s.discardFileOp);

  const [pendingRevoke, setPendingRevoke] = useState<SyncDeviceData | null>(null);

  const [pendingDiscard, setPendingDiscard] = useState<number | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  const authenticated = status?.authenticated === true;

  // A remote read, so it happens when this tab is on screen and authenticated
  // — not on every settings open.
  useEffect(() => {
    if (authenticated) refreshDevices();
  }, [authenticated, refreshDevices]);

  const runLogout = async (): Promise<void> => {
    setLoggingOut(true);
    try {
      const result = await logout();
      toast.success(
        result.revoked_remotely ? '已登出' : '已登出（服务器没能收到通知，本机凭证已清除）',
      );
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoggingOut(false);
    }
  };

  const confirmRevoke = async (): Promise<void> => {
    const target = pendingRevoke;
    setPendingRevoke(null);
    if (target === null) return;
    try {
      await revokeDevice(target.id);
      toast.success(`已吊销设备：${target.name}`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const confirmDiscard = async (): Promise<void> => {
    const id = pendingDiscard;
    setPendingDiscard(null);
    if (id === null) return;
    try {
      await discardFileOp(id);
      toast.success('已放弃该文件操作');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <>
      <Section
        title="账号"
        hint="同步歌曲与歌单的元数据和歌词；音频文件不上传，其他设备按来源链接自行下载"
      >
        {status === null ? (
          <p className="text-muted-foreground text-xs">正在读取同步状态…</p>
        ) : authenticated ? (
          <div className="space-y-2 text-xs">
            <div className="grid grid-cols-[8rem_1fr] gap-y-1">
              <span className="text-muted-foreground">服务器</span>
              <span className="break-all">{status.server_url}</span>
              <span className="text-muted-foreground">本机设备 ID</span>
              <span className="break-all font-mono">{status.device_id}</span>
              <span className="text-muted-foreground">workspace</span>
              <span className="break-all font-mono">{status.workspace_id}</span>
            </div>
            <p className="text-muted-foreground">
              登出只清除本机凭证，绑定关系与未同步的变更都保留，重新登录即可继续。
            </p>
            <Button
              size="sm"
              variant="secondary"
              disabled={loggingOut}
              onClick={() => void runLogout()}
            >
              {loggingOut ? '登出中…' : '登出'}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-muted-foreground text-xs">{authReasonLabel(status.auth_reason)}</p>
            <LoginForm serverUrl={status.server_url} />
          </div>
        )}
      </Section>

      <WorkspacesSection />

      {authenticated && (
        <Section title="设备" hint="这个账号下 lark 的设备；吊销后该设备需要重新登录">
          <DeviceList onRevoke={setPendingRevoke} />
        </Section>
      )}

      <Section
        title="同步"
        hint="后台还会在收到服务器推送和本机改动后立刻同步，这里只是兜底的轮询间隔"
      >
        {/* §7 F1: the timer is rebuilt on save now, so the hint can promise
          when it takes effect — the honest version of a promise nobody made
          while the daemon went on using the interval it read at boot. */}
        <Field
          label="轮询间隔"
          htmlFor="sync-interval"
          hint="保存后立即生效，新的周期从保存那一刻开始算"
          error={errorFor('sync.interval_min')}
        >
          <Select
            value={String(draft.syncIntervalMin)}
            onValueChange={(value) => update({ syncIntervalMin: Number(value) })}
          >
            <SelectTrigger id="sync-interval">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SYNC_INTERVALS.map((minutes) => (
                <SelectItem key={minutes} value={String(minutes)}>
                  {minutes} 分钟
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {status?.bound === true && (
          <div className="grid grid-cols-[8rem_1fr] gap-y-1 text-xs">
            <span className="text-muted-foreground">待推送</span>
            <span className="tabular-nums">{status.pending_count}</span>
            <span className="text-muted-foreground">上次同步</span>
            <span>
              {status.last_sync_at === null
                ? '从未'
                : formatRelativeTime(status.last_sync_at, Date.now())}
            </span>
          </div>
        )}
      </Section>

      {(status?.file_op_failures ?? 0) > 0 && (
        <Section title="文件操作" hint="同步引起的文件改动失败了；重试或放弃之前，同步不会自动再试">
          <SyncFileOpsList onDiscard={setPendingDiscard} />
        </Section>
      )}

      <ConfirmDialog
        open={pendingRevoke !== null}
        title="吊销设备"
        description={
          pendingRevoke?.is_current === true
            ? '这是本机。吊销后本机的同步会在下一轮停止，需要重新登录。确定吗？'
            : `吊销「${pendingRevoke?.name ?? ''}」后，该设备需要重新登录才能继续同步。确定吗？`
        }
        confirmLabel="吊销"
        destructive
        onConfirm={() => void confirmRevoke()}
        onCancel={() => setPendingRevoke(null)}
      />

      <ConfirmDialog
        open={pendingDiscard !== null}
        title="放弃文件操作"
        description={DISCARD_FILE_OP_DESCRIPTION}
        confirmLabel="放弃"
        destructive
        onConfirm={() => void confirmDiscard()}
        onCancel={() => setPendingDiscard(null)}
      />
    </>
  );
}
