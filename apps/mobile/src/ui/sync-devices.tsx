// Which devices are in this workspace (N5e, decision f).
//
// READ-ONLY. The desktop's list has a 撤销 button per row; this one does not,
// and that is decision f rather than an omission: revoking is the one action
// here that cannot be undone, it is worth its own confirmation flow, and the
// person most likely to need it — somebody whose phone was stolen — is by
// definition not holding this phone. It goes to N6 with a design of its own.
//
// ON DEMAND, unlike the desktop, which fetches the list whenever the sync tab
// opens. This is a network round trip, and the settings tab is also where the
// cache, the model and the Bluetooth switch live: opening it to change a limit
// should not talk to a server. So there is a button.

import { type CoordinatorContext, callSkybridge, requireSession } from '@lark/core/portable';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
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
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setFailed(null);
    try {
      const session = requireSession(ctx);
      const devices = await callSkybridge('device list', () => session.client.listDevices());
      setRows(
        devices.map((device) => ({
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
        </View>
      ))}
      {rows?.length === 0 && <Text style={styles.note}>没有其它设备。</Text>}
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
  buttonOff: { opacity: 0.4 },
  buttonLabel: { color: C.text, fontSize: 15, fontWeight: '600' },
});
