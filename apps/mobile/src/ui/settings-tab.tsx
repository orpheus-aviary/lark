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
  LOCAL_LLM_API_FORMATS,
  type LocalLlmApiFormat,
  MIB,
  RETRY_LIMITS,
  type RetryLimit,
  isLlmConfigured,
  readCacheLimitMb,
  readLlmEndpoint,
  writeCacheLimitMb,
} from '@lark/core/portable';
import type { NowPlayingMode } from '@lark/shared';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  Keyboard,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { readDeviceUsage } from '../cache/usage';
import { downloadRuntimeOnce } from '../downloads/engine';
import { engineErrors, subscribeEngineErrors } from '../downloads/log';
import { readRetryLimit, writeRetryLimit } from '../downloads/retry';
import { nowPlaying } from '../player';
import { readAutoDownloadNext, writeAutoDownloadNext } from '../player/auto-download';
import { clearApiKey, readApiKey, saveApiKey, saveLlmEndpoint, testLlm } from '../settings/llm';
import { appVersion } from '../sync/context';
import { Chip } from './chip';
import { ConflictsScreen } from './conflicts-screen';
import { useLibrary, useVisibleView } from './library-context';
import { SyncSection } from './sync-section';
import { C, S } from './theme';
import { WorkspacesSection } from './workspaces-section';

export function SettingsTab({ visible }: { visible: boolean }) {
  const { boot } = useLibrary();
  // 🔴 THE ONE THAT MATTERS MOST (`library-context.tsx`). The cache figure
  // below walks every song directory with a `statSync` per row, in EVERY
  // workspace on the phone; this page is now mounted while you are looking at
  // something else, and without the freeze a batch of forty downloads would
  // run forty of those walks for a number nobody is reading.
  const view = useVisibleView(visible);
  // The conflicts screen is a full-screen Modal, and it is owned HERE rather
  // than inside the sync section: a screen that unmounts with the section
  // that opened it would close itself the moment a round changed the status.
  const [conflictsOpen, setConflictsOpen] = useState(false);
  // A Modal outlives the pane behind it (`songs-tab.tsx` says why).
  useEffect(() => {
    if (!visible) setConflictsOpen(false);
  }, [visible]);
  // `limit: 0` fetches no rows and still reports the count.
  const total = view.songs({ limit: 0 }).total;
  return (
    // 🔴 THE WINDOW NO LONGER SHRINKS FOR THE KEYBOARD (2026-09-02, 用户报的
    // 「有些输入框不会随着输入法移动」). `AndroidManifest` still says
    // `adjustResize` and it still reads as if it worked, but this app targets
    // SDK 36: on Android 15+ that means edge-to-edge is ENFORCED
    // (`WindowUtil.updateEdgeToEdgeFeatureFlag` turns it on by itself), the
    // decor stops fitting system windows, and `adjustResize` is disabled with
    // it. So the fields at the bottom of this page — the API key, the sync
    // password — sat under the keyboard with nothing to scroll, because the
    // `ScrollView` below never shrank.
    //
    // WHY THE SHEETS AND PICKERS ARE NOT WRAPPED: RN's `Modal` turns
    // edge-to-edge back OFF for its own dialog window and sets ADJUST_RESIZE
    // on it (`ReactModalHostView`), so every input inside one already moves.
    // Wrapping those too would be a second source of displacement.
    <KeyboardAvoidingView behavior="padding" style={styles.fill}>
      {/* `handled` and not `always`: a tap on 保存 must reach 保存 with the
          keyboard up (§1.8), while a tap on the scroll area still dismisses it. */}
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
        <AutoDownloadNext settings={boot.deviceSettings} />
        <View style={styles.rule} />
        <AutoRetry settings={boot.deviceSettings} />
        <View style={styles.rule} />
        <Cache visible={visible} />
        <View style={styles.rule} />
        {/*
          0.1.1 ⑫: eight diagnostics went from here — the song-directory count,
          schema, protocol, the boot verdict, install_id, device_uuid, the boot
          drain's tally and the Bluetooth-lyrics counter. Every one of them was
          written for a batch that needed to read a number off a device with no
          logcat, and every one of them stayed afterwards, so the page a person
          opens to change one setting was mostly identifiers.
          WHAT STAYED, and why: the song count, because it is the one number
          somebody who is not debugging wants; and the error window below, which
          is still the ONLY way an INTERNAL_ERROR gets off a release build.
        */}
        <Field label="曲库" value={`${total} 首`} />
        {/*
          🔴 NOT ONE OF THE EIGHT (0.5.1，用户). The diagnostics above were
          removed because they were identifiers nobody who is not debugging
          wants. A version is the opposite: this app is not in a store and has
          no auto-update — every copy is an APK somebody installed by hand off a
          Release page — so 「我装的是哪一版」 is the one question a person
          cannot answer any other way. The desktop has said so all along, in its
          「关于」 section.
          Read through `appVersion()`, which reads the embedded config: a version
          that has to be edited in two places is one that will disagree with
          itself.
        */}
        <Field label="版本" value={appVersion()} />
        <EngineErrors />
      </ScrollView>
      <KeyboardProbe />
    </KeyboardAvoidingView>
  );
}

/**
 * 🔴 TEMPORARY — delete it with the batch that added it
 * (`docs/plans/2026-09-02-mobile-input-list-downloads.md` §1).
 *
 * Whether the `KeyboardAvoidingView` above can work at all comes down to one
 * number: `endCoordinates.screenY`, which is what it measures against. RN
 * takes that from `getWindowVisibleDisplayFrame()` (`ReactRootView`), and a
 * window that is no longer resized may report a CONSTANT — in which case the
 * view computes a displacement of zero and does nothing, silently. The three
 * outcomes lead to three different fixes, and telling them apart on the phone
 * needs the number: a release build reaches no logcat, so it is on screen.
 */
function KeyboardProbe() {
  const [line, setLine] = useState('键盘：还没弹起过');
  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', (event) => {
      const { screenY, height } = event.endCoordinates;
      const window = Math.round(Dimensions.get('window').height);
      setLine(`screenY ${Math.round(screenY)} · 高 ${Math.round(height)} · 窗口 ${window}`);
    });
    const hidden = Keyboard.addListener('keyboardDidHide', () => setLine('键盘：已收起'));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);
  return <Text style={styles.probe}>{line}</Text>;
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
 * 「自动下载下一首」 (0.1.1 ⑥).
 *
 * The rule is `@lark/shared`'s and the desktop has the same switch, so a list
 * plays the same way on both. ON by default: the behaviour it replaces —
 * skipping a song whose file is not here — plays a list in the order things
 * happened to be downloaded rather than in the order it is written.
 *
 * Turning it off is the answer for somebody on metered data, which is who the
 * original rule was written for.
 */
function AutoDownloadNext({ settings }: { settings: DeviceSettingsPort }) {
  const [on, setOn] = useState(() => readAutoDownloadNext(settings));
  return (
    <View style={styles.switchRow}>
      <View style={styles.switchText}>
        <Text style={styles.fieldValue}>自动下载下一首</Text>
        <Text style={styles.note}>
          一首歌自然播完时，如果下一首的文件不在本机，就先取回来再播——并且会在当前这首还在播的时候
          就开始取，所以通常听不出停顿。关掉则跳过它，直接放下一首已经有文件的歌。
          随机播放下不预取：下一首是播完那一刻才抽的。
        </Text>
      </View>
      <Switch
        value={on}
        onValueChange={(next) => {
          setOn(next);
          void writeAutoDownloadNext(settings, next).catch(() => {
            // The switch has already moved and there is no form to report to;
            // a failed write costs the next launch's answer, which is on.
            setOn(readAutoDownloadNext(settings));
          });
        }}
        accessibilityLabel="自动下载下一首"
      />
    </View>
  );
}

/**
 * How many extra goes a failed download gets by itself (0.1.1 ⑧).
 *
 * WHICH failures is not a setting and never will be: retrying a dead link or
 * bilibili's risk control is a worse answer at any count, so the allowlist is
 * `downloads/retry.ts`'s and the number is the only question left. One by
 * default — the failure this is for is a connection that dropped for a moment.
 *
 * Written on the tap, like the naming chips on the add page: somebody who
 * changed their mind and then closed the app still changed their mind.
 */
function AutoRetry({ settings }: { settings: DeviceSettingsPort }) {
  const [limit, setLimit] = useState<number>(() => readRetryLimit(settings));
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>下载失败自动重试</Text>
      <Text style={styles.note}>
        只重试网络类的失败——超时、连不上、流断了。链接失效、风控、没配模型这些重试多少次都一样，会直接留在下载记录里等你处理。
      </Text>
      <View style={styles.row}>
        {RETRY_LIMITS.map((option) => (
          <Chip
            key={option}
            label={option === 0 ? '不重试' : `${option} 次`}
            on={limit === option}
            onPress={() => {
              setLimit(option);
              void writeRetryLimit(settings, option as RetryLimit).catch(() => {
                // The chip has already moved and there is no form to report
                // to; what a failed write costs is the next launch's answer,
                // which falls back to one retry.
                setLimit(readRetryLimit(settings));
              });
            }}
          />
        ))}
      </View>
      {limit === 0 && <Text style={styles.note}>失败就是失败，记录里点「重下」再试。</Text>}
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
function Cache({ visible }: { visible: boolean }) {
  const { boot } = useLibrary();
  const view = useVisibleView(visible);
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
  const usage = useMemo(
    () =>
      readDeviceUsage({
        statusHere: (options) => view.cacheStatus(options),
        options: { ...runtime.cache.options(), limitBytes: limitMb * MIB },
        workspace: boot.workspace,
      }),
    [view, runtime, limitMb, boot],
  );
  const status: CacheStatus = usage.here;

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
      {usage.otherFiles > 0 && (
        <Field
          label="其他曲库"
          value={`${mib(usage.otherBytes)}（${usage.otherFiles} 个文件，清理时先动这些）`}
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
 * The raw side of "详情见日志" — on a phone the log is a screen (`downloads/log.ts`).
 *
 * FOLDED since 0.1.1 ⑫, and unfolding is a tap rather than a scroll past ten
 * lines of stack frames: this window should be empty forever, and the count is
 * the whole message when it is. It stays on the page because a release build
 * reaches no logcat — take it away and an INTERNAL_ERROR becomes unexplainable
 * by construction, which is the state N4e-2 added it to get out of.
 */
function EngineErrors() {
  const lines = useSyncExternalStore(subscribeEngineErrors, engineErrors);
  const [open, setOpen] = useState(false);
  if (lines.length === 0) {
    return <Field label="最近的错误" value="—" />;
  }
  return (
    <View style={styles.field}>
      <Pressable
        onPress={() => setOpen((shown) => !shown)}
        accessibilityRole="button"
        accessibilityLabel={`最近的错误 ${lines.length} 条`}
      >
        <Text style={styles.fieldLabel}>最近的错误</Text>
        <Text style={styles.fieldValue}>
          {lines.length} 条 · {open ? '收起' : '展开'}
        </Text>
      </Pressable>
      {open &&
        lines.map((line) => (
          <Text key={line} style={styles.note} selectable>
            {line}
          </Text>
        ))}
    </View>
  );
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
  fill: { flex: 1 },
  settings: { padding: S.pad, gap: S.pad },
  /** 🔴 TEMPORARY, with `KeyboardProbe`. */
  probe: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: C.surfaceOn,
    color: C.text,
    fontSize: 11,
    textAlign: 'center',
    paddingVertical: 3,
  },
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
