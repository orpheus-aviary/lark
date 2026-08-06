// The settings page (M5-1): one scrolling Dialog, a local form draft, and a
// single `PATCH /config` on save.
//
// Three decisions worth keeping in mind while reading:
//
//   THE DRAFT IS LOCAL. Typing must not write; only [保存] does, and it sends
//   ONLY the sections that actually changed — a PATCH is a whitelist, so
//   sending everything would rewrite fields the user never touched.
//
//   THE API KEY IS WRITE-ONLY. `GET /config` answers `has_api_key`, never the
//   key (R14). Leaving the field empty keeps whatever is stored; the explicit
//   [清除] button is the only way to remove it, and it sends `''`.
//
//   OPENING REFETCHES. The main process PATCHes the window size behind the
//   renderer's back (M5-3), so the mirror can be stale in exactly the section
//   this page shows.

import type { ConfigPatchRequest, LogLevel, PublicLarkConfig, ThemeMode } from '@lark/shared';
import { ApiError, LOG_LEVELS, THEME_MODES } from '@lark/shared';
import { Settings } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '../lib/errors.js';
import { useCache } from '../stores/cache.js';
import { useConfig } from '../stores/config.js';
import { Button } from './ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.js';
import { Input } from './ui/input.js';
import { Label } from './ui/label.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select.js';

const THEME_LABELS: Record<ThemeMode, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
};

const LOG_LEVEL_LABELS: Record<LogLevel, string> = {
  trace: 'trace',
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
  fatal: 'fatal',
};

const API_FORMATS = ['openai', 'anthropic'] as const;

/** The cache-limit choices, in MiB — 0 is "no limit" (M5-18). */
const CACHE_LIMITS = [
  { value: 0, label: '不限' },
  { value: 128, label: '128 MB' },
  { value: 256, label: '256 MB' },
  { value: 512, label: '512 MB' },
  { value: 1024, label: '1 GB' },
  { value: 2048, label: '2 GB' },
  { value: 5120, label: '5 GB' },
  { value: 10240, label: '10 GB' },
] as const;

const MIB = 1024 * 1024;

function formatSize(bytes: number): string {
  if (bytes >= MIB * 1024) return `${(bytes / (MIB * 1024)).toFixed(2)} GB`;
  return `${(bytes / MIB).toFixed(1)} MB`;
}

/** Everything the form edits, as strings where the input is a text field. */
interface Draft {
  llmUrl: string;
  llmModel: string;
  llmFormat: string;
  /** Empty means "leave the stored key alone" — never the stored value (R14). */
  apiKey: string;
  clearApiKey: boolean;
  theme: ThemeMode;
  globalFontSize: string;
  lyricsFontSize: string;
  cacheLimitMb: number;
  windowWidth: string;
  windowHeight: string;
  logLevel: LogLevel;
  logMaxSizeMb: string;
  logMaxBackups: string;
}

function toDraft(config: PublicLarkConfig): Draft {
  return {
    llmUrl: config.llm.url,
    llmModel: config.llm.model,
    llmFormat: config.llm.api_format,
    apiKey: '',
    clearApiKey: false,
    theme: config.theme.mode,
    globalFontSize: String(config.font.global_font_size),
    lyricsFontSize: String(config.font.lyrics_font_size),
    cacheLimitMb: config.storage.cache_limit_mb,
    windowWidth: String(config.window.width),
    windowHeight: String(config.window.height),
    logLevel: config.log.level,
    logMaxSizeMb: String(config.log.max_size_mb),
    logMaxBackups: String(config.log.max_backups),
  };
}

/** `NaN` for anything the daemon would reject anyway — it answers with a path. */
const num = (value: string): number => Number(value.trim() === '' ? Number.NaN : value);

/** Only what changed. An unchanged section is left out of the PATCH entirely. */
function buildPatch(draft: Draft, config: PublicLarkConfig): ConfigPatchRequest {
  const patch: ConfigPatchRequest = {};

  const llm: NonNullable<ConfigPatchRequest['llm']> = {};
  if (draft.llmUrl !== config.llm.url) llm.url = draft.llmUrl;
  if (draft.llmModel !== config.llm.model) llm.model = draft.llmModel;
  if (draft.llmFormat !== config.llm.api_format) llm.api_format = draft.llmFormat;
  if (draft.clearApiKey) llm.api_key = '';
  else if (draft.apiKey !== '') llm.api_key = draft.apiKey;
  if (Object.keys(llm).length > 0) patch.llm = llm;

  if (draft.theme !== config.theme.mode) patch.theme = { mode: draft.theme };

  const font: NonNullable<ConfigPatchRequest['font']> = {};
  if (num(draft.globalFontSize) !== config.font.global_font_size) {
    font.global_font_size = num(draft.globalFontSize);
  }
  if (num(draft.lyricsFontSize) !== config.font.lyrics_font_size) {
    font.lyrics_font_size = num(draft.lyricsFontSize);
  }
  if (Object.keys(font).length > 0) patch.font = font;

  if (draft.cacheLimitMb !== config.storage.cache_limit_mb) {
    patch.storage = { cache_limit_mb: draft.cacheLimitMb };
  }

  const window: NonNullable<ConfigPatchRequest['window']> = {};
  if (num(draft.windowWidth) !== config.window.width) window.width = num(draft.windowWidth);
  if (num(draft.windowHeight) !== config.window.height) window.height = num(draft.windowHeight);
  if (Object.keys(window).length > 0) patch.window = window;

  const log: NonNullable<ConfigPatchRequest['log']> = {};
  if (draft.logLevel !== config.log.level) log.level = draft.logLevel;
  if (num(draft.logMaxSizeMb) !== config.log.max_size_mb) log.max_size_mb = num(draft.logMaxSizeMb);
  if (num(draft.logMaxBackups) !== config.log.max_backups) {
    log.max_backups = num(draft.logMaxBackups);
  }
  if (Object.keys(log).length > 0) patch.log = log;

  return patch;
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="space-y-3 border-border border-t pt-4 first:border-t-0 first:pt-0">
      <div>
        <h3 className="font-medium text-sm">{title}</h3>
        {hint !== undefined && <p className="text-muted-foreground text-xs">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Field({
  label,
  htmlFor,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string | undefined;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-[8rem_1fr] items-center gap-3">
      <Label htmlFor={htmlFor} className="justify-end text-muted-foreground">
        {label}
      </Label>
      <div className="space-y-1">
        {children}
        {error !== undefined && <p className="text-destructive text-xs">{error}</p>}
      </div>
    </div>
  );
}

function CacheBlock(): React.JSX.Element {
  const status = useCache((s) => s.status);
  const evicting = useCache((s) => s.evicting);
  const evict = useCache((s) => s.evict);

  const runEviction = async (): Promise<void> => {
    try {
      const result = await evict();
      const freed = `清理 ${result.evicted_count} 首，释放 ${formatSize(result.freed_bytes)}`;
      const skipped =
        result.skipped_unverified_count > 0
          ? `；另有 ${result.skipped_unverified_count} 首暂未能联网确认可重下，已跳过`
          : '';
      toast.success(`${freed}${skipped}`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  if (status === null) return <p className="text-muted-foreground text-xs">正在读取缓存状态…</p>;

  return (
    <div className="space-y-2 rounded-md border border-border p-3 text-xs">
      <div className="grid grid-cols-2 gap-y-1">
        <span className="text-muted-foreground">已用</span>
        <span className="tabular-nums">{formatSize(status.used_bytes)}</span>
        <span className="text-muted-foreground">按资格可清理（未验证）</span>
        <span className="tabular-nums">{formatSize(status.eligible_bytes)}</span>
        <span className="text-muted-foreground">不可回收</span>
        <span className="tabular-nums">{formatSize(status.unreclaimable_bytes)}</span>
      </div>
      {/* The two reasons a limit can stay unmet are different problems, so they
          are stated separately rather than blamed on pins and imports (M5-18). */}
      {!status.limit_satisfied && (
        <p className="text-muted-foreground">
          当前超出上限：其中 {formatSize(status.unreclaimable_bytes)} 属固定 / 导入 /
          正在使用的文件，无法回收。
        </p>
      )}
      <Button size="sm" variant="secondary" disabled={evicting} onClick={() => void runEviction()}>
        {evicting ? '清理中…' : '立即清理'}
      </Button>
    </div>
  );
}

export function SettingsDialog(): React.JSX.Element {
  const config = useConfig((s) => s.config);
  const refreshConfig = useConfig((s) => s.refresh);
  const patchConfig = useConfig((s) => s.patch);
  const refreshCache = useCache((s) => s.refresh);
  const watchCache = useCache((s) => s.setWatching);

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  /** Field path → message, straight from the daemon's `details.path` (M5-20). */
  const [fieldError, setFieldError] = useState<{ path: string; message: string } | null>(null);

  // Opening always refetches: the main process writes the window section
  // without the renderer knowing (M5-3), and the cache numbers are a snapshot.
  useEffect(() => {
    if (!open) {
      watchCache(false);
      return;
    }
    watchCache(true);
    refreshConfig();
    refreshCache();
    setFieldError(null);
  }, [open, refreshConfig, refreshCache, watchCache]);

  // The draft follows the mirror while the dialog is closed, and is left alone
  // once it is open — a background refresh must not discard what was typed.
  useEffect(() => {
    if (config === null) return;
    setDraft((current) => (current === null ? toDraft(config) : current));
  }, [config]);

  const openWith = (next: boolean): void => {
    setOpen(next);
    if (!next) setDraft(null);
    else if (config !== null) setDraft(toDraft(config));
  };

  const save = async (): Promise<void> => {
    if (config === null || draft === null) return;
    const patch = buildPatch(draft, config);
    if (Object.keys(patch).length === 0) {
      openWith(false);
      return;
    }
    setSaving(true);
    try {
      await patchConfig(patch);
      setFieldError(null);
      openWith(false);
      toast.success('设置已保存');
    } catch (err) {
      const path = err instanceof ApiError ? err.details?.path : undefined;
      if (typeof path === 'string') setFieldError({ path, message: errorMessage(err) });
      else toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const errorFor = (path: string): string | undefined =>
    fieldError?.path === path ? fieldError.message : undefined;

  const update = (patch: Partial<Draft>): void =>
    setDraft((current) => (current === null ? current : { ...current, ...patch }));

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="设置"
        title="设置"
        onClick={() => openWith(true)}
      >
        <Settings />
      </Button>

      <Dialog open={open} onOpenChange={openWith}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>设置</DialogTitle>
            <DialogDescription>改动在点击「保存」后才会写入配置文件。</DialogDescription>
          </DialogHeader>

          {draft === null ? (
            <p className="text-muted-foreground text-sm">正在读取配置…</p>
          ) : (
            <div className="max-h-[60vh] space-y-5 overflow-y-auto pr-1">
              <Section title="LLM" hint="留空的字段会回退到 aviary 的共享配置">
                <Field label="接口地址" htmlFor="llm-url" error={errorFor('llm.url')}>
                  <Input
                    id="llm-url"
                    value={draft.llmUrl}
                    onChange={(e) => update({ llmUrl: e.target.value })}
                  />
                </Field>
                <Field label="模型" htmlFor="llm-model" error={errorFor('llm.model')}>
                  <Input
                    id="llm-model"
                    value={draft.llmModel}
                    onChange={(e) => update({ llmModel: e.target.value })}
                  />
                </Field>
                <Field label="接口格式" htmlFor="llm-format" error={errorFor('llm.api_format')}>
                  <Select
                    value={draft.llmFormat === '' ? 'openai' : draft.llmFormat}
                    onValueChange={(value) => update({ llmFormat: value })}
                  >
                    <SelectTrigger id="llm-format">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {API_FORMATS.map((format) => (
                        <SelectItem key={format} value={format}>
                          {format}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="API Key" htmlFor="llm-key" error={errorFor('llm.api_key')}>
                  <div className="flex gap-2">
                    <Input
                      id="llm-key"
                      type="password"
                      value={draft.apiKey}
                      disabled={draft.clearApiKey}
                      placeholder={
                        config?.llm.has_api_key === true ? '已设置（留空保持不变）' : '未设置'
                      }
                      onChange={(e) => update({ apiKey: e.target.value })}
                    />
                    <Button
                      type="button"
                      variant={draft.clearApiKey ? 'default' : 'secondary'}
                      onClick={() => update({ clearApiKey: !draft.clearApiKey, apiKey: '' })}
                    >
                      {draft.clearApiKey ? '将清除' : '清除'}
                    </Button>
                  </div>
                </Field>
              </Section>

              <Section title="外观">
                <Field label="主题" htmlFor="theme-mode" error={errorFor('theme.mode')}>
                  <Select
                    value={draft.theme}
                    onValueChange={(value) => update({ theme: value as ThemeMode })}
                  >
                    <SelectTrigger id="theme-mode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {THEME_MODES.map((mode) => (
                        <SelectItem key={mode} value={mode}>
                          {THEME_LABELS[mode]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field
                  label="界面字号"
                  htmlFor="font-global"
                  error={errorFor('font.global_font_size')}
                >
                  <Input
                    id="font-global"
                    type="number"
                    min={1}
                    value={draft.globalFontSize}
                    onChange={(e) => update({ globalFontSize: e.target.value })}
                  />
                </Field>
                <Field
                  label="歌词字号"
                  htmlFor="font-lyrics"
                  error={errorFor('font.lyrics_font_size')}
                >
                  <Input
                    id="font-lyrics"
                    type="number"
                    min={1}
                    value={draft.lyricsFontSize}
                    onChange={(e) => update({ lyricsFontSize: e.target.value })}
                  />
                </Field>
              </Section>

              <Section title="存储" hint="上限只约束下载的文件；导入和固定的歌曲永不清理">
                <Field
                  label="缓存上限"
                  htmlFor="cache-limit"
                  error={errorFor('storage.cache_limit_mb')}
                >
                  <Select
                    value={String(draft.cacheLimitMb)}
                    onValueChange={(value) => update({ cacheLimitMb: Number(value) })}
                  >
                    <SelectTrigger id="cache-limit">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CACHE_LIMITS.map((limit) => (
                        <SelectItem key={limit.value} value={String(limit.value)}>
                          {limit.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <CacheBlock />
              </Section>

              <Section title="窗口" hint="下次启动生效；之后拖动窗口会覆盖这里的值">
                <Field label="宽度" htmlFor="window-width" error={errorFor('window.width')}>
                  <Input
                    id="window-width"
                    type="number"
                    min={600}
                    value={draft.windowWidth}
                    onChange={(e) => update({ windowWidth: e.target.value })}
                  />
                </Field>
                <Field label="高度" htmlFor="window-height" error={errorFor('window.height')}>
                  <Input
                    id="window-height"
                    type="number"
                    min={400}
                    value={draft.windowHeight}
                    onChange={(e) => update({ windowHeight: e.target.value })}
                  />
                </Field>
              </Section>

              <Section title="日志" hint="重启 daemon 后生效">
                <Field label="级别" htmlFor="log-level" error={errorFor('log.level')}>
                  <Select
                    value={draft.logLevel}
                    onValueChange={(value) => update({ logLevel: value as LogLevel })}
                  >
                    <SelectTrigger id="log-level">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LOG_LEVELS.map((level) => (
                        <SelectItem key={level} value={level}>
                          {LOG_LEVEL_LABELS[level]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="单文件上限" htmlFor="log-size" error={errorFor('log.max_size_mb')}>
                  <Input
                    id="log-size"
                    type="number"
                    min={1}
                    value={draft.logMaxSizeMb}
                    onChange={(e) => update({ logMaxSizeMb: e.target.value })}
                  />
                </Field>
                <Field label="保留份数" htmlFor="log-backups" error={errorFor('log.max_backups')}>
                  <Input
                    id="log-backups"
                    type="number"
                    min={1}
                    value={draft.logMaxBackups}
                    onChange={(e) => update({ logMaxBackups: e.target.value })}
                  />
                </Field>
              </Section>
            </div>
          )}

          <DialogFooter>
            <Button variant="secondary" onClick={() => openWith(false)}>
              取消
            </Button>
            <Button disabled={saving || draft === null} onClick={() => void save()}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
