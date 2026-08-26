// Which devices are in this workspace, and how one leaves (N5e decision f,
// N6c criteria 93–94).
//
// REVOKING ARRIVED IN N6c, with the confirmation flow decision f said it was
// worth waiting for. The copy lives in `sync/devices.ts` because a phone can
// only ever show one of the two versions, and the interesting one is the
// version for THIS phone: revoking the device you are holding is allowed on
// purpose (`daemon/src/routes/sync.ts:152` — refusing would be the wrong
// protection for somebody whose credentials leaked), and the consequence
// lands on the screen you are looking at.
//
// NOTHING IS TORN DOWN LOCALLY after revoking this device, which matches the
// daemon exactly. The session keeps its token until the server stops honouring
// it, and then the ordinary auth path says so — `noteAuthRequired` at the next
// round. Hand-rolling a logout here would be a second way to end a session,
// and the confirmation already told the person what to expect.
//
// ON DEMAND, unlike the desktop, which fetches the list whenever the sync tab
// opens. This is a network round trip, and the settings tab is also where the
// cache, the model and the Bluetooth switch live: opening it to change a limit
// should not talk to a server. So there is a button.

import { type CoordinatorContext, callSkybridge, requireSession } from '@lark/core/portable';
import { hiddenDevicesNote, splitLarkDevices } from '@lark/shared';
import { useCallback, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { canRevoke, revokePrompt } from '../sync/devices';
import { refreshSync } from '../sync/hub';
import { C, S } from './theme';

interface Row {
  id: string;
  name: string;
  platform: string | null;
  appVersion: string | null;
  lastSeenAt: number;
  revokedAt: number | null;
  isCurrent: boolean;
}

export function SyncDevices({ ctx }: { ctx: CoordinatorContext }) {
  const [rows, setRows] = useState<readonly Row[] | null>(null);
  /** Other tools' devices on this account — counted, never listed. */
  const [hidden, setHidden] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setFailed(null);
    try {
      const session = requireSession(ctx);
      const devices = await callSkybridge('device list', () => session.client.listDevices());
      // Filtered here rather than in the render so the count is taken once,
      // off the answer the server actually gave.
      const mine = splitLarkDevices(devices, (device) => device.appVersion);
      setHidden(mine.hidden);
      setRows(
        mine.shown.map((device) => ({
          id: device.id,
          name: device.name,
          platform: device.platform,
          appVersion: device.appVersion,
          lastSeenAt: device.lastSeenAt,
          revokedAt: device.revokedAt,
          isCurrent: device.id === session.deviceId,
        })),
      );
    } catch (err) {
      setFailed(err instanceof Error ? err.message : '读取设备列表失败');
    } finally {
      setBusy(false);
    }
  }, [ctx]);

  const revoke = useCallback(
    (row: Row) => {
      const prompt = revokePrompt(row);
      Alert.alert(prompt.title, prompt.message, [
        { text: '取消', style: 'cancel' },
        {
          text: prompt.confirm,
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setBusy(true);
              setFailed(null);
              try {
                const session = requireSession(ctx);
                await callSkybridge('device revoke', () => session.client.revokeDevice(row.id));
              } catch (err) {
                setFailed(err instanceof Error ? err.message : '撤销失败');
              } finally {
                setBusy(false);
                // The badge is what says "this phone needs to log in again",
                // and after revoking THIS device it is about to change.
                refreshSync();
              }
              // Outside the try: a refresh that fails should report reading,
              // not revoking, and the revoke may well have succeeded.
              await load();
            })();
          },
        },
      ]);
    },
    [ctx, load],
  );

  return (
    <View style={styles.block}>
      {rows?.map((row) => (
        <View key={row.id} style={styles.row}>
          <View style={styles.text}>
            <Text style={styles.name} numberOfLines={1}>
              {row.name}
              {row.isCurrent ? '（本机）' : ''}
            </Text>
            <Text style={styles.note}>
              {row.platform ?? '未知平台'} · {row.appVersion ?? '版本未知'} ·{' '}
              {describeSeen(row.lastSeenAt)}
              {row.revokedAt === null ? '' : ' · 已撤销'}
            </Text>
          </View>
          {canRevoke(row) && (
            <Pressable
              style={[styles.revoke, busy && styles.buttonOff]}
              onPress={() => revoke(row)}
              disabled={busy}
              accessibilityRole="button"
            >
              <Text style={styles.revokeLabel}>撤销</Text>
            </Pressable>
          )}
        </View>
      ))}
      {rows?.length === 0 && <Text style={styles.note}>没有其它设备。</Text>}
      {hiddenDevicesNote(hidden) !== null && (
        <Text style={styles.note}>{hiddenDevicesNote(hidden)}</Text>
      )}
      {failed !== null && <Text style={styles.failed}>{failed}</Text>}
      <Pressable
        style={[styles.button, busy && styles.buttonOff]}
        onPress={() => void load()}
        disabled={busy}
        accessibilityRole="button"
      >
        <Text style={styles.buttonLabel}>
          {busy ? '读取中…' : rows === null ? '查看设备列表' : '刷新设备列表'}
        </Text>
      </Pressable>
    </View>
  );
}

function describeSeen(atMs: number): string {
  const minutes = Math.floor((Date.now() - atMs) / 60_000);
  if (minutes < 1) return '刚刚在线';
  if (minutes < 60) return `${minutes} 分钟前在线`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} 小时前在线` : `${Math.floor(hours / 24)} 天前在线`;
}

const styles = StyleSheet.create({
  block: { gap: S.gap },
  row: { flexDirection: 'row', alignItems: 'center', gap: S.gap },
  text: { flex: 1, gap: 2 },
  name: { color: C.text, fontSize: 14 },
  note: { color: C.faint, fontSize: 12, lineHeight: 18 },
  failed: { color: C.danger, fontSize: 12, lineHeight: 18 },
  button: {
    backgroundColor: C.surface,
    borderRadius: S.radius,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  revoke: { paddingHorizontal: 12, justifyContent: 'center', minHeight: 44 },
  revokeLabel: { color: C.danger, fontSize: 13 },
  buttonOff: { opacity: 0.4 },
  buttonLabel: { color: C.text, fontSize: 15, fontWeight: '600' },
});
