// 设置 — one model, one switch, and the diagnostics (N4e-2, decision e).
//
// Split out of `shell.tsx` not because of line count but because of what this
// screen became: it used to be a switch and a list of read-only facts, and it
// is now a FORM WITH DRAFT STATE — four fields that are only real once you
// press 保存, and a 测试连接 that deliberately runs against what is on screen
// rather than what is stored.
//
// THE MODEL IS THE ONLY THING ON THIS PHONE THAT UNLOCKS THE FOUR REFUSALS the
// add page shows (keyword search, 清洗命名, picking an episode out of a
// multi-part video, and finding a song again after its source died). 🔒 And
// this page is its ONLY source: no aviary fallback, no import from the
// desktop, nothing from sync, no built-in endpoint (§0's channel freeze). If a
// reader is looking for the other place a model could come from — there isn't
// one, by decision.

import {
  LATEST_KNOWN_VERSION,
  type LocalLlmApiFormat,
  type SqliteLike,
  isLlmConfigured,
  readLlmEndpoint,
} from '@lark/core/portable';
import type { NowPlayingMode } from '@lark/shared';
import { LOCAL_API_VERSION } from '@lark/shared/api-paths';
import { Directory } from 'expo-file-system';
import { useState, useSyncExternalStore } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { abortSignalSupport, engineErrors, subscribeEngineErrors } from '../downloads/log';
import { nowPlaying, usePlayback } from '../player';
import { nestDirectory } from '../ports/paths';
import { clearApiKey, readApiKey, saveApiKey, saveLlmEndpoint, testLlm } from '../settings/llm';
import { Chip } from './chip';
import { useLibrary } from './library-context';
import { C, S } from './theme';

export function SettingsTab() {
  const { boot, view } = useLibrary();
  // `limit: 0` fetches no rows and still reports the count.
  const total = view.songs({ limit: 0 }).total;
  return (
    // `handled` and not `always`: a tap on 保存 must reach 保存 with the
    // keyboard up (§1.8), while a tap on the scroll area still dismisses it.
    <ScrollView contentContainerStyle={styles.settings} keyboardShouldPersistTaps="handled">
      <Llm sqlite={boot.db.sqlite} />
      <View style={styles.rule} />
      <BluetoothLyrics />
      <NowPlayingCount />
      <Field label="曲库" value={`${total} 首`} />
      {/*
        On DISK, not in the database, and that is the point: deleting a song
        queues the removal of its directory and drains the journal, so a count
        that did not fall is a file half of a delete that never happened
        (criterion 15). Nothing outside the app can see `songs/` — it is
        app-private — so this is where it becomes observable.
      */}
      <Field label="曲库目录" value={`${songDirectories()} 个`} />
      <Field label="schema" value={`v${LATEST_KNOWN_VERSION}`} />
      <Field label="protocol" value={`v${LOCAL_API_VERSION}`} />
      <Field label="启动判定" value={`${boot.decision.action} · ${boot.decision.reason}`} />
      <Field label="install_id" value={boot.installId} />
      <Field label="device_uuid" value={boot.deviceUuid} />
      <Field
        label="启动时执行的文件操作"
        value={`${boot.drained.executed} 条 · ${boot.drained.failed} 失败 · ${boot.drained.skipped} 跳过`}
      />
      <Field label="AbortSignal（临时诊断）" value={abortSignalSupport()} />
      <EngineErrors />
      <Text style={styles.note}>同步在 N5 开放。</Text>
    </ScrollView>
  );
}

/** What the last press of 保存 / 测试连接 / 清除 had to say. */
interface Said {
  ok: boolean;
  text: string;
}

/**
 * The model, in four fields.
 *
 * TWO KINDS OF STATE, and keeping them apart is most of this component. What
 * is STORED (`saved`, `keyStored`) decides the badge and the hints; what is
 * being EDITED (`url` / `model` / `format` / `keyDraft`) is what 测试连接 runs
 * against (decision f) and what 保存 commits. "Try it before you keep it" is
 * the only comfortable order on a phone, and it needs the draft to be real.
 */
function Llm({ sqlite }: { sqlite: SqliteLike }) {
  const [saved, setSaved] = useState(() => readLlmEndpoint(sqlite));
  const [keyStored, setKeyStored] = useState(() => readApiKey() !== '');
  const [url, setUrl] = useState(saved.url);
  const [model, setModel] = useState(saved.model);
  const [format, setFormat] = useState<LocalLlmApiFormat>(saved.api_format);
  /** Empty means "leave the stored key alone" — never "delete it" (§2.3). */
  const [keyDraft, setKeyDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said | null>(null);

  // The stored config, judged by core's rule: url + model, never the key — a
  // local llama.cpp endpoint legitimately has none.
  const configured = isLlmConfigured({ ...saved, api_key: '' });

  const save = (): void => {
    saveLlmEndpoint(sqlite, { url, model, api_format: format });
    if (keyDraft.trim() !== '') {
      saveApiKey(keyDraft);
      setKeyDraft('');
    }
    // Read back rather than assume the write won, and show what actually
    // landed: `writeLlmEndpoint` trims, and a person who pasted a URL with a
    // trailing space should see it gone rather than wonder.
    const next = readLlmEndpoint(sqlite);
    setSaved(next);
    setUrl(next.url);
    setModel(next.model);
    setFormat(next.api_format);
    setKeyStored(readApiKey() !== '');
    setSaid({ ok: true, text: '已保存。' });
  };

  const clear = async (): Promise<void> => {
    await clearApiKey();
    setKeyDraft('');
    setKeyStored(readApiKey() !== '');
    setSaid({ ok: true, text: 'API Key 已清除。' });
  };

  const test = async (): Promise<void> => {
    setBusy(true);
    setSaid(null);
    const result = await testLlm({
      url,
      model,
      api_format: format,
      // The typed key if there is one, the stored key otherwise. Without the
      // fallback there would be no way to test a key that is already saved —
      // the field never echoes it back.
      api_key: keyDraft.trim() === '' ? readApiKey() : keyDraft.trim(),
    });
    // The provider's own words, VERBATIM — no redaction (§8.2, the user's
    // decision). Most providers do not put the key in an error; some echo a
    // masked prefix and a debugging gateway can echo the whole request. That
    // is what criterion 30② goes and looks at rather than assumes.
    setSaid(
      result.ok
        ? { ok: true, text: `通了 · 模型回了「${result.reply}」` }
        : { ok: false, text: result.message },
    );
    setBusy(false);
  };

  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text style={styles.sectionTitle}>模型</Text>
        <Text style={[styles.badge, configured ? styles.badgeOn : styles.badgeOff]}>
          {configured ? '已配置' : '未配置'}
        </Text>
      </View>
      <Text style={styles.note}>
        关键词搜索、清洗命名、多 P
        选集和「来源失效后重新找回」都要用它。只存在这台手机上，不同步、不从电脑导入。
      </Text>

      <LabelledInput
        label="接口地址"
        value={url}
        onChangeText={setUrl}
        placeholder="https://api.example.com/v1"
        keyboardType="url"
      />
      <LabelledInput
        label="模型名称"
        value={model}
        onChangeText={setModel}
        placeholder="deepseek-chat"
      />

      <View style={styles.row}>
        <Text style={styles.fieldLabel}>接口格式</Text>
        <Chip label="openai" on={format === 'openai'} onPress={() => setFormat('openai')} />
        <Chip
          label="anthropic"
          on={format === 'anthropic'}
          onPress={() => setFormat('anthropic')}
        />
      </View>

      <LabelledInput
        label="API Key"
        value={keyDraft}
        onChangeText={setKeyDraft}
        placeholder={keyStored ? '已配置 · 留空表示不改动' : '本地端点可以留空'}
        secureTextEntry
      />
      {keyStored && (
        <Pressable
          onPress={() => void clear()}
          accessibilityRole="button"
          accessibilityLabel="清除 API Key"
        >
          <Text style={styles.link}>清除 API Key</Text>
        </Pressable>
      )}
      {/*
        The state a restored phone is ALWAYS in (§1.7, decision g): SecureStore
        keys do not come back from a backup — that asymmetry is what D16 uses
        to tell "my library" from "somebody else's" — while url and model live
        in the library and do. It looks exactly like "nothing is configured",
        so it gets its own sentence. It does not claim to know WHICH of the two
        cases this is, because it cannot: a keyless local endpoint reads the
        same.
      */}
      {configured && !keyStored && (
        <Text style={styles.note}>
          接口地址与模型都在，但这台设备上没有 API
          Key。本地端点本来就不需要；如果你填过，它不随备份恢复，得重新填一次。
        </Text>
      )}

      {/* Buttons follow the fields — never pinned to the bottom of the screen,
          where the keyboard covers them (§1.8, MEASURED in N4d). */}
      <View style={styles.buttons}>
        <Pressable
          style={[styles.button, busy && styles.buttonOff]}
          onPress={() => void test()}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="测试连接"
        >
          {busy ? (
            <ActivityIndicator size="small" color={C.muted} />
          ) : (
            <Text style={styles.buttonLabel}>测试连接</Text>
          )}
        </Pressable>
        <Pressable
          style={[styles.button, styles.buttonPrimary]}
          onPress={save}
          accessibilityRole="button"
          accessibilityLabel="保存"
        >
          <Text style={styles.buttonLabel}>保存</Text>
        </Pressable>
      </View>
      {said !== null && (
        <Text style={said.ok ? styles.ok : styles.failed} accessibilityLabel="模型设置结果">
          {said.text}
        </Text>
      )}
    </View>
  );
}

function LabelledInput({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  secureTextEntry = false,
}: {
  label: string;
  value: string;
  onChangeText: (next: string) => void;
  placeholder: string;
  keyboardType?: 'url';
  secureTextEntry?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={C.faint}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={secureTextEntry}
        {...(keyboardType === undefined ? {} : { keyboardType })}
        accessibilityLabel={label}
      />
    </View>
  );
}

/**
 * The Bluetooth lyrics switch (N3d, criterion 16).
 *
 * Off by default and stored per install (`local_metadata.now_playing_mode`),
 * because a phone that lives in a car and a phone that never sees one want
 * different answers. The bridge does the writing — this reads back what it
 * stored rather than assuming the tap won, since a value the library refuses
 * reads as the default.
 */
function BluetoothLyrics() {
  const [mode, setMode] = useState<NowPlayingMode>(() => nowPlaying.mode());
  return (
    <View style={styles.switchRow}>
      <View style={styles.switchText}>
        <Text style={styles.fieldValue}>蓝牙歌词</Text>
        <Text style={styles.note}>
          把当前这句歌词写进「正在播放」的标题，车机和耳机屏上就能看见。关掉是歌名。
        </Text>
      </View>
      <Switch
        value={mode === 'lyrics'}
        onValueChange={(on) => {
          nowPlaying.setMode(on ? 'lyrics' : 'title');
          setMode(nowPlaying.mode());
        }}
        accessibilityLabel="蓝牙歌词"
      />
    </View>
  );
}

/**
 * How many times we have handed the system a new title for this song, and how
 * close together two of them ever came (criterion 17).
 *
 * Its own component ON PURPOSE: it subscribes to the playback tick so the
 * number is live, and the tab around it must not — `songDirectories()` lists a
 * directory on disk, and doing that twice a second would be a diagnostics
 * screen that costs more than what it diagnoses.
 */
function NowPlayingCount() {
  const time = usePlayback((state) => state.currentTime);
  const { published, minGapMs } = nowPlaying.stats();
  return (
    <Field
      label="蓝牙歌词发送（本首）"
      value={`${published} 次 · 最短间隔 ${minGapMs ?? '—'} ms · 播放到 ${time.toFixed(1)}s`}
    />
  );
}

/** ⚠️ TEMPORARY (`downloads/log.ts`): the raw side of "详情见日志". */
function EngineErrors() {
  const lines = useSyncExternalStore(subscribeEngineErrors, engineErrors);
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>最近的引擎错误（临时诊断）</Text>
      {lines.length === 0 ? (
        <Text style={styles.fieldValue}>—</Text>
      ) : (
        lines.map((line) => (
          <Text key={line} style={styles.note} selectable>
            {line}
          </Text>
        ))
      )}
    </View>
  );
}

function songDirectories(): number {
  const songs = new Directory(nestDirectory(), 'songs');
  return songs.exists ? songs.list().filter((entry) => entry instanceof Directory).length : 0;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={styles.fieldValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  settings: { padding: S.pad, gap: S.pad },
  section: { gap: S.gap },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: S.gap },
  sectionTitle: { color: C.text, fontSize: 16, fontWeight: '600', flex: 1 },
  badge: { fontSize: 12, paddingHorizontal: 8, paddingVertical: 3, borderRadius: S.radius },
  badgeOn: { color: C.ok, backgroundColor: C.surface },
  badgeOff: { color: C.faint, backgroundColor: C.surface },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: C.border },
  note: { color: C.faint, fontSize: 12, lineHeight: 18 },
  row: { flexDirection: 'row', alignItems: 'center', gap: S.gap },
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
});
