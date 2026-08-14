// The general half of the settings page (M5-1; split out of SettingsDialog in
// v0.2 T4, contents unchanged). Everything here edits the local draft — the
// dialog's [保存] is the only writer.

import type { LogLevel, PublicLarkConfig, ThemeMode } from '@lark/shared';
import { LOG_LEVELS, THEME_MODES } from '@lark/shared';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select.js';
import { MigrationBlock } from './MigrationBlock.js';
import { CacheBlock, LegalBlock, MediaToolsBlock } from './blocks.js';
import type { Draft } from './draft.js';
import { Field, Section } from './fields.js';

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

interface GeneralTabProps {
  draft: Draft;
  config: PublicLarkConfig;
  update: (patch: Partial<Draft>) => void;
  errorFor: (path: string) => string | undefined;
}

export function GeneralTab({
  draft,
  config,
  update,
  errorFor,
}: GeneralTabProps): React.JSX.Element {
  return (
    <>
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
              placeholder={config.llm.has_api_key ? '已设置（留空保持不变）' : '未设置'}
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
        <Field label="界面字号" htmlFor="font-global" error={errorFor('font.global_font_size')}>
          <Input
            id="font-global"
            type="number"
            min={1}
            value={draft.globalFontSize}
            onChange={(e) => update({ globalFontSize: e.target.value })}
          />
        </Field>
        <Field label="歌词字号" htmlFor="font-lyrics" error={errorFor('font.lyrics_font_size')}>
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
        <Field label="缓存上限" htmlFor="cache-limit" error={errorFor('storage.cache_limit_mb')}>
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

      <Section title="媒体工具" hint="下载与导入都要用 ffmpeg 转码和识别格式">
        <MediaToolsBlock />
      </Section>

      {/* Owns its own <Section>: on a library that never ran the one-time
          mp3 → m4a migration it renders nothing at all, and a titled empty box
          would be a section about a version this install never saw. */}
      <MigrationBlock />

      <Section title="关于" hint={`lark ${window.larkAPI.guiVersion}`}>
        <LegalBlock />
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
    </>
  );
}
