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

import type { SyncDeviceData } from '@lark/shared';
import { ApiError } from '@lark/shared';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '../../lib/errors.js';
import { formatRelativeTime } from '../../lib/format.js';
import { authReasonLabel, loginErrorMessage } from '../../lib/sync-labels.js';
import { useSync } from '../../stores/sync.js';
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
}

function LoginForm({ serverUrl }: { serverUrl: string | null }): React.JSX.Element {
  const login = useSync((s) => s.login);
  const [form, setForm] = useState<LoginDraft>({
    serverUrl: serverUrl ?? '',
    email: '',
    password: '',
    allowInsecure: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const submit = async (): Promise<void> => {
    setConfirming(false);
    setBusy(true);
    setError(null);
    try {
      const result = await login({
        server_url: form.serverUrl.trim(),
        email: form.email.trim(),
        password: form.password,
        ...(form.allowInsecure ? { allow_insecure_http: true } : {}),
      });
      // Gone from memory as soon as it has been used.
      setForm((current) => ({ ...current, password: '' }));
      const backfilled = result.backfill;
      toast.success(
        backfilled === null
          ? `已登录：${result.email}`
          : `已登录：${result.email}，首次同步将上传 ${backfilled.songs} 首歌 / ${backfilled.playlists} 个歌单`,
      );
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
    </div>
  );
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

export function SyncTab({ draft, update, errorFor }: SyncTabProps): React.JSX.Element {
  const status = useSync((s) => s.status);
  const devices = useSync((s) => s.devices);
  const devicesError = useSync((s) => s.devicesError);
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

      {authenticated && (
        <Section title="设备" hint="同一个账号下的所有设备；吊销后该设备需要重新登录">
          <div className="space-y-2 text-xs">
            {devicesError !== null ? (
              <p className="text-muted-foreground">读取设备列表失败：{devicesError}</p>
            ) : devices.length === 0 ? (
              <p className="text-muted-foreground">正在读取设备列表…</p>
            ) : (
              <ul className="space-y-2">
                {devices.map((device) => (
                  <DeviceRow key={device.id} device={device} onRevoke={setPendingRevoke} />
                ))}
              </ul>
            )}
            <Button size="sm" variant="secondary" onClick={() => refreshDevices()}>
              刷新
            </Button>
          </div>
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
