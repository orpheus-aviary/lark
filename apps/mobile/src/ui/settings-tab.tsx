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
  type CacheStatus,
  type DeviceSettingsPort,
  type EvictionSummary,
  LATEST_KNOWN_VERSION,
  LOCAL_LLM_API_FORMATS,
  type LocalLlmApiFormat,
  MIB,
  cacheStatus,
  isLlmConfigured,
  readCacheLimitMb,
  readLlmEndpoint,
  writeCacheLimitMb,
} from '@lark/core/portable';
import type { NowPlayingMode } from '@lark/shared';
import { LOCAL_API_VERSION } from '@lark/shared/api-paths';
import { Directory } from 'expo-file-system';
import { useMemo, useState, useSyncExternalStore } from 'react';
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
import { downloadRuntimeOnce } from '../downloads/engine';
import { engineErrors, subscribeEngineErrors } from '../downloads/log';
import { nowPlaying, usePlayback } from '../player';
import { songsRoot } from '../ports/paths';
import { clearApiKey, readApiKey, saveApiKey, saveLlmEndpoint, testLlm } from '../settings/llm';
import { openForeignWorkspaces } from '../workspace/foreign';
import { Chip } from './chip';
import { ConflictsScreen } from './conflicts-screen';
import { useLibrary } from './library-context';
import { SyncSection } from './sync-section';
import { C, S } from './theme';
import { WorkspacesSection } from './workspaces-section';

export function SettingsTab() {
  const { boot, view } = useLibrary();
  // The conflicts screen is a full-screen Modal, and it is owned HERE rather
  // than inside the sync section: a screen that unmounts with the section
  // that opened it would close itself the moment a round changed the status.
  const [conflictsOpen, setConflictsOpen] = useState(false);
  // `limit: 0` fetches no rows and still reports the count.
  const total = view.songs({ limit: 0 }).total;
  return (
    // `handled` and not `always`: a tap on 保存 must reach 保存 with the
    // keyboard up (§1.8), while a tap on the scroll area still dismisses it.
    <ScrollView contentContainerStyle={styles.settings} keyboardShouldPersistTaps="handled">
      <SyncSection onConflicts={() => setConflictsOpen(true)} />
      {conflictsOpen && <ConflictsScreen db={boot.db} onClose={() => setConflictsOpen(false)} />}
      <View style={styles.rule} />
      <WorkspacesSection />
      <View style={styles.rule} />
      <Llm settings={boot.deviceSettings} />
      <View style={styles.rule} />
      <BluetoothLyrics />
      <View style={styles.rule} />
      <Cache />
      <View style={styles.rule} />
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
      <EngineErrors />
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
function Llm({ settings }: { settings: DeviceSettingsPort }) {
  const [saved, setSaved] = useState(() => readLlmEndpoint(settings));
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

  const save = async (): Promise<void> => {
    // Since N7a the endpoint is a file on this device rather than a row in the
    // library, so a save can fail the way a file can. Saying so beats a form
    // that reports success and forgets on the next launch.
    try {
      await saveLlmEndpoint(settings, { url, model, api_format: format });
    } catch (err) {
      setSaid({ ok: false, text: err instanceof Error ? err.message : '保存失败' });
      return;
    }
    if (keyDraft.trim() !== '') {
      saveApiKey(keyDraft);
      setKeyDraft('');
    }
    // Read back rather than assume the write won, and show what actually
    // landed: `writeLlmEndpoint` trims, and a person who pasted a URL with a
    // trailing space should see it gone rather than wonder.
    const next = readLlmEndpoint(settings);
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

      {/* Rendered FROM the domain, not beside it: `LOCAL_LLM_API_FORMATS` is
          what the library will accept back (decision a), and two chips written
          out by hand are a second place for that to drift. */}
      <View style={styles.row}>
        <Text style={styles.fieldLabel}>接口格式</Text>
        {LOCAL_LLM_API_FORMATS.map((option) => (
          <Chip
            key={option}
            label={option}
            on={format === option}
            onPress={() => setFormat(option)}
          />
        ))}
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
          onPress={() => void save()}
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
 * What the audio is taking up, and the one number that bounds it (N4g-2,
 * decision e).
 *
 * FOUR THINGS STAY ON SCREEN — used, file count, limit, 立即清理 — and
 * everything else a drain knows is said once, in its receipt. The desktop's
 * dialog keeps 「可回收」 and 「不可回收」 permanently visible; on a phone those
 * are two byte counts nobody reads, while "this run deleted 3 songs and left 2
 * it could not confirm" is a sentence about something that just happened.
 *
 * THE LIMIT IS PER INSTALL and lives in `local_metadata` (`cache-limit.ts`) —
 * not in `lark_config.toml`, which this phone does not have and is not getting.
 * Saving it starts a drain, because a limit that took effect "some time later"
 * would look like a limit that did not work.
 *
 * 立即清理 is the ONLY place in the app that waits for a drain and shows what
 * it did. The other three triggers (launch, a finished download, a saved limit)
 * are fire-and-forget by design — a background drain that reported to a screen
 * would be a screen reporting on work nobody asked for.
 */
function Cache() {
  const { view, boot } = useLibrary();
  const runtime = useMemo(() => downloadRuntimeOnce(boot), [boot]);
  /** The saved limit, as this screen last read it BACK from the library. */
  const [limitMb, setLimitMb] = useState(() => readCacheLimitMb(boot.deviceSettings));
  const [draft, setDraft] = useState(() => String(limitMb));
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said | null>(null);

  // `view` is the dependency that makes a delete, a download or an eviction
  // show up here: every one of them announces itself, and the announcement is
  // what replaces the reader (`library-context.tsx`). Walking the song
  // directories is what `cacheStatus` does — cheap for a phone's library, and
  // this screen is not a hot path.
  // How much room lark takes on this PHONE, in one walk (N7f): the library on
  // screen and every other one. The limit is a device setting, so a figure
  // counting only the first would say this phone is inside a limit it is over
  // — and a drain frees the others FIRST, which is worth saying next to them.
  const usage = useMemo(() => {
    const here = view.cacheStatus({ ...runtime.cache.options(), limitBytes: limitMb * MIB });
    const opened = openForeignWorkspaces(boot.workspace);
    try {
      let bytes = 0;
      let files = 0;
      for (const workspace of opened.workspaces) {
        const each = cacheStatus(workspace.files, workspace.db, {
          limitBytes: 0,
          isExcluded: () => false,
          streamCount: () => 0,
        });
        bytes += each.used_bytes;
        files += each.file_count;
      }
      return { here, other: { bytes, files } };
    } finally {
      opened.close();
    }
  }, [view, runtime, limitMb, boot]);
  const status: CacheStatus = usage.here;
  const other = usage.other;

  const save = async (): Promise<void> => {
    const parsed = Number(draft.trim());
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      setSaid({ ok: false, text: '请填一个不小于 0 的整数（MB），0 表示不限。' });
      return;
    }
    try {
      await writeCacheLimitMb(boot.deviceSettings, parsed);
    } catch (err) {
      setSaid({ ok: false, text: err instanceof Error ? err.message : '保存失败' });
      return;
    }
    // Read back rather than assume the write won — the same rule the model
    // form above follows.
    const saved = readCacheLimitMb(boot.deviceSettings);
    setLimitMb(saved);
    setDraft(String(saved));
    setSaid({ ok: true, text: saved === 0 ? '已保存：不限。' : `已保存：${saved}MB。` });
    // Trigger three (§2.2). Not awaited: this one is a preference, and the
    // drain it starts reports through the numbers above.
    runtime.cache.schedule('limit-changed');
  };

  const clean = async (): Promise<void> => {
    setBusy(true);
    setSaid(null);
    try {
      setSaid({ ok: true, text: describeEviction(await runtime.cache.run()) });
    } catch (err) {
      setSaid({ ok: false, text: err instanceof Error ? err.message : '清理失败' });
    }
    setBusy(false);
  };

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>缓存</Text>
      <Field
        label="当前曲库"
        value={`${mib(status.used_bytes)}（${status.file_count} 个音频文件）`}
      />
      {other.files > 0 && (
        <Field
          label="其他曲库"
          value={`${mib(other.bytes)}（${other.files} 个文件，清理时先动这些）`}
        />
      )}
      {/*
        Both halves of "still over the limit" are said, because they are
        different problems (M5-18): what is left may be pinned, imported or in
        use, and none of those is something a second tap on 立即清理 will fix.
      */}
      {!status.limit_satisfied && (
        <Text style={styles.note}>
          仍超出上限：其中 {mib(status.unreclaimable_bytes)} 是固定 / 正在使用 /
          没有来源的文件，清不掉。
        </Text>
      )}

      <View style={styles.row}>
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>上限（MB，0 = 不限）</Text>
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            keyboardType="number-pad"
            placeholder="0"
            placeholderTextColor={C.faint}
            accessibilityLabel="缓存上限"
          />
        </View>
        <Pressable
          style={[styles.button, styles.buttonPrimary, styles.buttonNarrow]}
          onPress={() => void save()}
          accessibilityRole="button"
          accessibilityLabel="保存上限"
        >
          <Text style={styles.buttonLabel}>保存</Text>
        </Pressable>
      </View>

      <Pressable
        style={[styles.button, busy && styles.buttonOff]}
        onPress={() => void clean()}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel="立即清理"
      >
        {busy ? (
          <ActivityIndicator size="small" color={C.muted} />
        ) : (
          <Text style={styles.buttonLabel}>立即清理</Text>
        )}
      </Pressable>
      <Text style={styles.note}>
        只清理下载来的音频，导入的文件和固定的歌不会被删；来源确认不了还能重下的，也留着。歌词永远不清。
      </Text>
      {said !== null && (
        <Text style={said.ok ? styles.ok : styles.failed} accessibilityLabel="缓存操作结果">
          {said.text}
        </Text>
      )}
    </View>
  );
}

/** One receipt for one drain — the same three facts the GUI toast and `lark cache evict` report. */
function describeEviction(summary: EvictionSummary): string {
  // Criterion 37's sentence, and it gets its own branch because it is the
  // outcome an offline phone always reaches: fail-closed is not an error and
  // must not read like one. An unreachable network and a dead source look
  // identical from here, and both mean "keep the file".
  const kept =
    summary.skipped_unverified_count === 0
      ? ''
      : `${summary.skipped_unverified_count} 首（${mib(summary.skipped_unverified_bytes)}）没能确认可重下，先留着。`;

  if (summary.evicted_count === 0) {
    return kept === '' ? '没有需要清理的文件。' : `一个文件都没删：${kept}`;
  }
  const freed = `清理了 ${summary.evicted_count} 首，释放 ${mib(summary.freed_bytes)}`;
  return kept === '' ? `${freed}。` : `${freed}；另有 ${kept}`;
}

function mib(bytes: number): string {
  return `${(bytes / MIB).toFixed(1)}MB`;
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

/** The raw side of "详情见日志" — on a phone the log is a screen (`downloads/log.ts`). */
function EngineErrors() {
  const lines = useSyncExternalStore(subscribeEngineErrors, engineErrors);
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>最近的错误</Text>
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
  const songs = songsRoot();
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
  // Beside a field rather than across the row: the input is the wide half.
  buttonNarrow: { flex: 0, paddingHorizontal: 20, alignSelf: 'flex-end' },
  buttonOff: { opacity: 0.4 },
  buttonLabel: { color: C.text, fontSize: 15, fontWeight: '600' },
  ok: { color: C.ok, fontSize: 12, lineHeight: 18 },
  failed: { color: C.danger, fontSize: 12, lineHeight: 18 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: S.pad },
  switchText: { flex: 1, gap: 2 },
});
