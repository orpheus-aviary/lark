// Sync, on a screen (N5e). Replaces the「同步在 N5 开放。」line that has stood
// in the settings tab since N2f.
//
// A SEPARATE FILE, not another section inside `settings-tab.tsx`: that file
// was already 593 lines, and this is a login form, a status panel, a device
// list and two queues. The repo's rule is 500 lines advisory and 800 a hard
// split, and one screen holding both would have cleared 800 on the first
// draft.
//
// WHAT IT IS NOT. The desktop's `SyncTab.tsx` talks to a daemon over HTTP and
// keeps a zustand store polling `GET /sync/status`. Here the coordinator is in
// this JS heap, so a status is a function call and the hub is a cache with an
// invalidation signal. Every action below is a direct call into
// `@lark/core/portable` — there is no wire, no route and no error envelope to
// unwrap, only the error vocabulary that reached the front end anyway.
//
// The Chinese is `@lark/shared`'s (`sync-labels.ts`, lifted out of the GUI in
// N5a), so the two front ends say the same words about the same states.

import {
  CodedError,
  type CoordinatorContext,
  type FileEffectRuntime,
  listFileOps,
  performSyncLogin,
  performSyncLogout,
  readSyncAllowInsecure,
  writeSyncAllowInsecure,
} from '@lark/core/portable';
import {
  type SyncFileOpSummary,
  authReasonLabel,
  fileOpKindLabel,
  loginErrorMessage,
  syncBadgeView,
} from '@lark/shared';
import { useCallback, useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { downloadRuntimeOnce } from '../downloads/engine';
import { syncContextOnce } from '../sync/context';
import { refreshSync } from '../sync/hub';
import { useSyncNow } from '../sync/use-sync';
import { useLibrary } from './library-context';
import { SyncDevices } from './sync-devices';
import { C, S } from './theme';

export interface SyncSectionProps {
  /** Open the conflicts screen. Owned by the tab, which owns the modal. */
  onConflicts: () => void;
}

/** What the last action had to say. Same shape the LLM section uses. */
interface Said {
  ok: boolean;
  text: string;
}

export function SyncSection({ onConflicts }: SyncSectionProps) {
  const { boot } = useLibrary();
  // Both are once-per-process gates, so asking again is free and asking from
  // here keeps the settings tab's body a list of sections. Same shape as
  // `Cache()` beside it.
  const runtime = useMemo(() => downloadRuntimeOnce(boot), [boot]);
  const ctx = useMemo(
    () => syncContextOnce({ db: boot.db, files: boot.files, fileOps: runtime.fileOps }),
    [boot, runtime],
  );
  const fileOps = runtime.fileOps;
  const { status, conflicts } = useSyncNow();
  const badge = syncBadgeView(status, conflicts);

  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text style={styles.sectionTitle}>同步</Text>
        <Text style={[styles.badge, toneStyle(badge.tone)]}>{badge.label}</Text>
      </View>

      {status === null || !status.configured || !status.authenticated ? (
        <LoginForm ctx={ctx} status={status} />
      ) : (
        <Signed ctx={ctx} />
      )}

      {status?.configured === true && (
        <>
          <Field label="服务器" value={status.server_url ?? '—'} />
          <Field label="待推送" value={`${status.pending_count} 条`} />
          <Field label="进度" value={`已拉 ${status.pulled_seq} · 已推 ${status.pushed_seq}`} />
          <Field label="上次同步" value={describeWhen(status.last_sync_at)} />
          {status.device_id !== null && <Field label="本机设备 ID" value={status.device_id} />}
          {status.quarantined_count > 0 && (
            <Text style={styles.note}>
              {status.quarantined_count} 首歌的文件被移到了 recovered-songs/ 而不是删掉——
              别的设备删了它们，但这台设备上的文件可能是独一份。
            </Text>
          )}
          {status.last_error !== null && <Text style={styles.failed}>{status.last_error}</Text>}
        </>
      )}

      {conflicts > 0 && (
        <Pressable style={styles.button} onPress={onConflicts} accessibilityRole="button">
          <Text style={styles.buttonLabel}>{conflicts} 条冲突待处理</Text>
        </Pressable>
      )}

      {status?.authenticated === true && <SyncDevices ctx={ctx} />}

      {(status?.file_op_failures ?? 0) > 0 && status !== null && (
        <FailedFileOps ctx={ctx} fileOps={fileOps} count={status.file_op_failures} />
      )}
    </View>
  );
}

/**
 * Not signed in — which covers three different states and says which.
 *
 * `configured` false is "never set up"; configured but not authenticated is
 * "logged out, or the server stopped honouring the token", and `auth_reason`
 * is the only thing that tells those apart. Collapsing them into one "请登录"
 * would hide the one case where the person has to do something different.
 */
function LoginForm({
  ctx,
  status,
}: { ctx: CoordinatorContext; status: ReturnType<typeof useSyncNow>['status'] }) {
  const [url, setUrl] = useState(() => status?.server_url ?? '');
  // The status carries no email — it is not a field a status has, and
  // pre-filling it from credentials would print somebody's address on a
  // screen they only opened to look at a number.
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [insecure, setInsecure] = useState(() => readSyncAllowInsecure(ctx.db.sqlite));
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said | null>(null);

  const toggleInsecure = useCallback(
    (next: boolean) => {
      setInsecure(next);
      writeSyncAllowInsecure(ctx.db.sqlite, next);
    },
    [ctx],
  );

  const submit = useCallback(async () => {
    setBusy(true);
    setSaid(null);
    try {
      const result = await performSyncLogin(ctx, {
        server_url: url.trim(),
        email: email.trim(),
        password,
        ...(insecure ? { allow_insecure_http: true } : {}),
      });
      // The password is used once and never stored — forgetting it here is the
      // front end's half of that promise (the desktop does the same).
      setPassword('');
      setSaid({
        ok: true,
        text:
          result.backfill === null
            ? '已登录。'
            : `已登录，本机 ${result.backfill.songs} 首歌 · ${result.backfill.playlists} 个歌单排队上行。`,
      });
    } catch (err) {
      setSaid({ ok: false, text: describeLoginError(err) });
    } finally {
      setBusy(false);
      refreshSync();
    }
  }, [ctx, url, email, password, insecure]);

  const ready = url.trim() !== '' && email.trim() !== '' && password !== '' && !busy;

  return (
    <>
      {status?.configured === true && (
        <Text style={styles.note}>{authReasonLabel(status.auth_reason)}</Text>
      )}
      <LabelledInput
        label="服务器地址"
        value={url}
        onChangeText={setUrl}
        placeholder="https://sync.example.com"
        autoCapitalize="none"
        keyboardType="url"
      />
      <LabelledInput
        label="邮箱"
        value={email}
        onChangeText={setEmail}
        placeholder="you@example.com"
        autoCapitalize="none"
        keyboardType="email-address"
      />
      <LabelledInput
        label="密码"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoCapitalize="none"
      />
      <View style={styles.switchRow}>
        <View style={styles.switchText}>
          <Text style={styles.fieldValue}>允许明文 HTTP</Text>
          <Text style={styles.note}>
            登录会把密码发到服务器。开着这个开关时，http:// 的地址会被接受——
            密码和令牌将以明文穿过网络。只在自己信得过的服务器上开。
          </Text>
        </View>
        <Switch value={insecure} onValueChange={toggleInsecure} />
      </View>
      <Pressable
        style={[styles.button, styles.buttonPrimary, !ready && styles.buttonOff]}
        onPress={() => void submit()}
        disabled={!ready}
        accessibilityRole="button"
      >
        <Text style={styles.buttonLabel}>{busy ? '登录中…' : '登录'}</Text>
      </Pressable>
      {said !== null && (
        <Text style={said.ok ? styles.ok : styles.failed} accessibilityLabel="同步登录结果">
          {said.text}
        </Text>
      )}
    </>
  );
}

/** Signed in: the two things a person does from here. */
function Signed({ ctx }: { ctx: CoordinatorContext }) {
  const [busy, setBusy] = useState<'run' | 'out' | null>(null);
  const [said, setSaid] = useState<Said | null>(null);

  const runNow = useCallback(async () => {
    setBusy('run');
    setSaid(null);
    try {
      const result = await ctx.sync.run('manual');
      setSaid(
        result === null
          ? { ok: true, text: '没有需要同步的内容。' }
          : {
              ok: true,
              text: `同步完成：上行 ${result.pushed} · 下行 ${result.applied}${
                result.conflicts > 0 ? ` · 冲突 ${result.conflicts}` : ''
              }`,
            },
      );
    } catch (err) {
      setSaid({ ok: false, text: describeError(err, '同步失败') });
    } finally {
      setBusy(null);
      refreshSync();
    }
  }, [ctx]);

  const signOut = useCallback(() => {
    Alert.alert('退出登录', '这台设备会停止同步。曲库一首歌都不会少，重新登录就能继续。', [
      { text: '取消', style: 'cancel' },
      {
        text: '退出',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            setBusy('out');
            try {
              await performSyncLogout(ctx);
              setSaid({ ok: true, text: '已退出登录。' });
            } catch (err) {
              setSaid({ ok: false, text: describeError(err, '退出登录失败') });
            } finally {
              setBusy(null);
              refreshSync();
            }
          })();
        },
      },
    ]);
  }, [ctx]);

  return (
    <>
      <View style={styles.buttons}>
        <Pressable
          style={[styles.button, styles.buttonPrimary, busy !== null && styles.buttonOff]}
          onPress={() => void runNow()}
          disabled={busy !== null}
          accessibilityRole="button"
        >
          <Text style={styles.buttonLabel}>{busy === 'run' ? '同步中…' : '立即同步'}</Text>
        </Pressable>
        <Pressable
          style={[styles.button, busy !== null && styles.buttonOff]}
          onPress={signOut}
          disabled={busy !== null}
          accessibilityRole="button"
        >
          <Text style={styles.buttonLabel}>退出登录</Text>
        </Pressable>
      </View>
      {said !== null && (
        <Text style={said.ok ? styles.ok : styles.failed} accessibilityLabel="同步操作结果">
          {said.text}
        </Text>
      )}
    </>
  );
}

/**
 * File effects that gave up, and the two ways out.
 *
 * It only appears when there are any — this is a number that should be zero
 * forever, and a permanent empty panel would train people not to look at it.
 */
function FailedFileOps({
  ctx,
  fileOps,
  count,
}: { ctx: CoordinatorContext; fileOps: FileEffectRuntime; count: number }) {
  const [busy, setBusy] = useState(false);
  /** Re-read after retry / discard, before the status has caught up. */
  const [, bump] = useState(0);

  // Read during render, like the conflicts screen and for the same reason: a
  // list that should be empty forever, queried synchronously, is not worth an
  // effect that renders the stale version first.
  const rows: readonly SyncFileOpSummary[] = listFileOps(ctx.db.sqlite, 'failed');

  const retryAll = useCallback(async () => {
    setBusy(true);
    try {
      await fileOps.retry();
    } finally {
      setBusy(false);
      bump((n) => n + 1);
      refreshSync();
    }
  }, [fileOps]);

  const discard = useCallback(
    (op: SyncFileOpSummary) => {
      Alert.alert(
        '放弃这个操作',
        `「${fileOpKindLabel(op)}」将永远不会发生。曲库里的那一行已经改过了，只有文件这一步会被跳过。`,
        [
          { text: '取消', style: 'cancel' },
          {
            text: '放弃',
            style: 'destructive',
            onPress: () => {
              fileOps.discard(op.id);
              bump((n) => n + 1);
              refreshSync();
            },
          },
        ],
      );
    },
    [fileOps],
  );

  return (
    <View style={styles.section}>
      <Text style={styles.fieldLabel}>文件操作失败 {count} 条</Text>
      {rows.map((op) => (
        <View key={op.id} style={styles.opRow}>
          <View style={styles.opText}>
            <Text style={styles.fieldValue}>{fileOpKindLabel(op)}</Text>
            <Text style={styles.note}>
              {op.attempts} 次尝试{op.last_error === null ? '' : ` · ${op.last_error}`}
            </Text>
          </View>
          <Pressable onPress={() => discard(op)} accessibilityRole="button">
            <Text style={styles.link}>放弃</Text>
          </Pressable>
        </View>
      ))}
      <Pressable
        style={[styles.button, busy && styles.buttonOff]}
        onPress={() => void retryAll()}
        disabled={busy}
        accessibilityRole="button"
      >
        <Text style={styles.buttonLabel}>{busy ? '重试中…' : '全部重试'}</Text>
      </Pressable>
    </View>
  );
}

// ── bits ──

function describeLoginError(err: unknown): string {
  if (err instanceof CodedError) return loginErrorMessage(err.code, err.message);
  return describeError(err, '登录失败');
}

function describeError(err: unknown, fallback: string): string {
  if (err instanceof CodedError) return err.message;
  return err instanceof Error && err.message !== '' ? err.message : fallback;
}

function describeWhen(atMs: number | null): string {
  if (atMs === null) return '还没有同步过';
  const minutes = Math.floor((Date.now() - atMs) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} 小时前` : `${Math.floor(hours / 24)} 天前`;
}

function toneStyle(tone: ReturnType<typeof syncBadgeView>['tone']) {
  switch (tone) {
    case 'ok':
      return styles.badgeOk;
    case 'busy':
      return styles.badgeBusy;
    case 'warn':
      return styles.badgeWarn;
    case 'error':
      return styles.badgeError;
    case 'off':
      return styles.badgeOff;
  }
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={styles.fieldValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function LabelledInput({
  label,
  ...input
}: { label: string } & React.ComponentProps<typeof TextInput>) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.input}
        placeholderTextColor={C.faint}
        accessibilityLabel={label}
        {...input}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: S.gap },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: S.gap },
  sectionTitle: { color: C.text, fontSize: 16, fontWeight: '600', flex: 1 },
  badge: { fontSize: 12, paddingHorizontal: 8, paddingVertical: 3, borderRadius: S.radius },
  badgeOk: { color: C.ok, backgroundColor: C.surface },
  badgeBusy: { color: C.active, backgroundColor: C.surface },
  badgeWarn: { color: C.active, backgroundColor: C.surface },
  badgeError: { color: C.danger, backgroundColor: C.surface },
  badgeOff: { color: C.faint, backgroundColor: C.surface },
  note: { color: C.faint, fontSize: 12, lineHeight: 18 },
  field: { gap: 2 },
  fieldLabel: { color: C.faint, fontSize: 12 },
  fieldValue: { color: C.text, fontSize: 14 },
  input: {
    color: C.text,
    fontSize: 14,
    backgroundColor: C.surface,
    borderRadius: S.radius,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  link: { color: C.muted, fontSize: 13 },
  buttons: { flexDirection: 'row', gap: S.gap, marginTop: 4 },
  button: {
    flex: 1,
    backgroundColor: C.surface,
    borderRadius: S.radius,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  buttonPrimary: { backgroundColor: C.surfaceOn },
  buttonOff: { opacity: 0.4 },
  buttonLabel: { color: C.text, fontSize: 15, fontWeight: '600' },
  ok: { color: C.ok, fontSize: 12, lineHeight: 18 },
  failed: { color: C.danger, fontSize: 12, lineHeight: 18 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: S.pad },
  switchText: { flex: 1, gap: 2 },
  opRow: { flexDirection: 'row', alignItems: 'center', gap: S.gap },
  opText: { flex: 1, gap: 2 },
});
