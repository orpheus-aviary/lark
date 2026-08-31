import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigUnsafePermissionsError } from '../errors.js';
import {
  DEFAULT_CONFIG,
  loadConfig,
  loadConfigReadonly,
  redactConfig,
  resolveLlmConfig,
  saveConfig,
} from './index.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lark-config-test-'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const cfgPath = () => join(dir, 'lark_config.toml');

/** The real Go-era file shape (§2.1): four sections, no api_format, 0644. */
const GO_LEGACY_TOML = `
[llm]
url = "https://api.example.com/v1"
model = "some-model"
api_key = "sk-legacy-key"

[window]
width = 1200
height = 800

[font]
global_font_size = 15
lyrics_font_size = 18

[log]
level = "debug"
max_size_mb = 20
max_backups = 3
max_age_days = 30

[display]
show_duration = true

[download]
uploader_video_limit = 100

[daemon]
port = 47020
`;

function writeGoLegacyFile(mode = 0o644): void {
  writeFileSync(cfgPath(), GO_LEGACY_TOML, 'utf-8');
  chmodSync(cfgPath(), mode);
}

describe('loadConfig', () => {
  it('missing file: writes defaults at 0600 and returns them', () => {
    const cfg = loadConfig(cfgPath());
    expect(cfg).toEqual(DEFAULT_CONFIG);
    expect(existsSync(cfgPath())).toBe(true);
    expect(statSync(cfgPath()).mode & 0o777).toBe(0o600);
    // the written file parses back to the same defaults
    expect(loadConfig(cfgPath())).toEqual(DEFAULT_CONFIG);
  });

  it('parses the Go-era four-section file; absent sections get defaults', () => {
    writeGoLegacyFile();
    const cfg = loadConfig(cfgPath());
    expect(cfg.llm).toEqual({
      url: 'https://api.example.com/v1',
      model: 'some-model',
      api_key: 'sk-legacy-key',
      api_format: '', // absent on disk stays unset — resolveLlmConfig's job
    });
    expect(cfg.window).toEqual({ width: 1200, height: 800 });
    expect(cfg.font).toEqual({ global_font_size: 15, lyrics_font_size: 18 });
    expect(cfg.log.level).toBe('debug');
    expect(cfg.log.max_size_mb).toBe(20);
    expect(cfg.log.max_backups).toBe(3);
    expect(cfg.storage).toEqual({ cache_limit_mb: 0 });
    // A Go-era file has no `[playback]` at all, so the default is what a
    // library that predates 0.1.1 gets: on.
    expect(cfg.playback).toEqual({ auto_download_next: true });
  });

  it('reads a playback flag it does not understand as the default, not as off', () => {
    // The config's first boolean (0.1.1 ⑥). Converging an unreadable value to
    // `false` would silently take the feature away from somebody who never
    // turned it off — the same rule every other field here follows.
    writeFileSync(cfgPath(), '[playback]\nauto_download_next = "yes"\n');
    expect(loadConfig(cfgPath()).playback.auto_download_next).toBe(true);

    writeFileSync(cfgPath(), '[playback]\nauto_download_next = false\n');
    expect(loadConfig(cfgPath()).playback.auto_download_next).toBe(false);
  });

  it('tightens an existing 0644 file to 0600 even on a load-only path', () => {
    writeGoLegacyFile(0o644);
    loadConfig(cfgPath());
    expect(statSync(cfgPath()).mode & 0o777).toBe(0o600);
  });

  it('leaves an already-private mode alone', () => {
    writeGoLegacyFile(0o400);
    loadConfig(cfgPath());
    expect(statSync(cfgPath()).mode & 0o777).toBe(0o400);
  });

  it.runIf(process.platform === 'darwin')('throws when tightening fails', () => {
    writeGoLegacyFile(0o644);
    execFileSync('chflags', ['uchg', cfgPath()]);
    try {
      expect(() => loadConfig(cfgPath())).toThrow(/refusing to continue/);
    } finally {
      execFileSync('chflags', ['nouchg', cfgPath()]);
    }
  });

  it('round-trips unknown keys through save, but never into the Public projection', () => {
    writeGoLegacyFile();
    const cfg = loadConfig(cfgPath());
    saveConfig(cfg, cfgPath());

    const raw = parse(readFileSync(cfgPath(), 'utf-8')) as Record<string, unknown>;
    expect(raw.display).toEqual({ show_duration: true });
    // 🔴 A SECTION THIS BUILD ALSO USES (2026-08-31). `[download]` was a
    // Go-era section and is now one of ours too — `retry_limit` joined it —
    // so the round-trip has to keep BOTH: the dead key nobody reads and the
    // live one. A `toEqual` on the dead key alone would have gone red the day
    // this section grew a field, which is what it just did.
    expect(raw.download).toEqual({ uploader_video_limit: 100, retry_limit: 1 });
    expect(raw.daemon).toEqual({ port: 47020 });
    expect((raw.log as Record<string, unknown>).max_age_days).toBe(30);

    const pub = redactConfig(cfg);
    expect(Object.keys(pub).sort()).toEqual([
      'desktop_lyrics',
      'download',
      'font',
      'llm',
      'log',
      'playback',
      'storage',
      'sync',
      'theme',
      'window',
    ]);
    expect(Object.keys(pub.log).sort()).toEqual(['level', 'max_backups', 'max_size_mb']);
  });

  it('converges type and value-domain errors back to defaults', () => {
    writeFileSync(
      cfgPath(),
      `
[llm]
url = "https://kept.example"
api_key = 123

[window]
width = "wide"
height = -5

[theme]
mode = "sepia"

[font]
global_font_size = 0
lyrics_font_size = inf

[log]
level = "verbose"
max_size_mb = nan
max_backups = 2.5

[storage]
cache_limit_mb = -1

[desktop_lyrics]
enabled = "yes"
lines = 3
font_size = 400
preset = "neon"
width = 10
height = 0

[sync]
interval_min = 0
`,
      'utf-8',
    );
    chmodSync(cfgPath(), 0o600);
    const cfg = loadConfig(cfgPath());
    expect(cfg.llm.url).toBe('https://kept.example'); // valid values survive
    expect(cfg.llm.api_key).toBe('');
    expect(cfg.window).toEqual(DEFAULT_CONFIG.window);
    expect(cfg.theme).toEqual(DEFAULT_CONFIG.theme); // 'sepia' converges to 'system'
    expect(cfg.font).toEqual(DEFAULT_CONFIG.font);
    expect(cfg.log).toEqual(DEFAULT_CONFIG.log);
    expect(cfg.storage).toEqual(DEFAULT_CONFIG.storage);
    // 0 would mean "sync every zero minutes" — there is no "off" value here,
    // logging out is how you stop syncing.
    expect(cfg.sync).toEqual(DEFAULT_CONFIG.sync);
    // ⑤ — every one of those is a window that cannot be found or read: a font
    // four hundred pixels tall, a 10px-wide strip, a colour scheme with no
    // colours behind it.
    expect(cfg.desktop_lyrics).toEqual(DEFAULT_CONFIG.desktop_lyrics);
  });

  // ⑤ — the values a person actually picks survive, including the ones the
  // window itself writes back as it is dragged.
  it('keeps a desktop-lyrics section it understands, negative positions and all', () => {
    writeFileSync(
      cfgPath(),
      `
[desktop_lyrics]
enabled = true
lines = 2
font_size = 44
preset = "night"
locked = true
x = -1720
y = 40
width = 1200
height = 160
`,
      'utf-8',
    );
    chmodSync(cfgPath(), 0o600);
    expect(loadConfig(cfgPath()).desktop_lyrics).toEqual({
      enabled: true,
      lines: 2,
      font_size: 44,
      preset: 'night',
      locked: true,
      // A display to the LEFT of the main one. Not a mistake, and not clamped.
      x: -1720,
      y: 40,
      width: 1200,
      height: 160,
    });
  });

  it('keeps a valid sync interval and defaults to five minutes', () => {
    expect(DEFAULT_CONFIG.sync.interval_min).toBe(5);

    writeFileSync(cfgPath(), '[sync]\ninterval_min = 15\n', 'utf-8');
    chmodSync(cfgPath(), 0o600);
    expect(loadConfig(cfgPath()).sync.interval_min).toBe(15);
  });

  it('keeps a valid theme mode and defaults to following the OS (M5-2)', () => {
    expect(DEFAULT_CONFIG.theme.mode).toBe('system');

    writeFileSync(cfgPath(), '[theme]\nmode = "dark"\n', 'utf-8');
    chmodSync(cfgPath(), 0o600);
    expect(loadConfig(cfgPath()).theme.mode).toBe('dark');
  });

  it('keeps defaults when a whole section is a scalar', () => {
    writeFileSync(cfgPath(), 'llm = "oops"\n', 'utf-8');
    chmodSync(cfgPath(), 0o600);
    const cfg = loadConfig(cfgPath());
    expect(cfg.llm).toEqual(DEFAULT_CONFIG.llm);
  });
});

describe('saveConfig', () => {
  it('writes atomically at 0600 with no temp residue', () => {
    saveConfig(structuredClone(DEFAULT_CONFIG), cfgPath());
    expect(statSync(cfgPath()).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['lark_config.toml']);
  });

  it('replaces an existing file and its mode', () => {
    writeGoLegacyFile(0o644);
    saveConfig(structuredClone(DEFAULT_CONFIG), cfgPath());
    expect(statSync(cfgPath()).mode & 0o777).toBe(0o600);
    expect(loadConfig(cfgPath())).toEqual(DEFAULT_CONFIG);
  });
});

describe('resolveLlmConfig (aviary fallback, empty-string = unset)', () => {
  function writeAviary(toml: string): void {
    vi.stubEnv('LARK_NEST_DIR', dir);
    mkdirSync(join(dir, 'aviary'), { recursive: true });
    writeFileSync(join(dir, 'aviary', 'aviary_config.toml'), toml, 'utf-8');
  }

  const AVIARY_TOML = `
[llm]
url = "https://aviary.example/v1"
model = "aviary-model"
api_key = "sk-aviary"
api_format = "anthropic"
`;

  function localCfg(llm: Partial<(typeof DEFAULT_CONFIG)['llm']>) {
    const cfg = structuredClone(DEFAULT_CONFIG);
    Object.assign(cfg.llm, llm);
    return cfg;
  }

  it('all four fields set locally: aviary is not consulted', () => {
    writeAviary(AVIARY_TOML);
    const resolved = resolveLlmConfig(
      localCfg({ url: 'u', model: 'm', api_key: 'k', api_format: 'openai' }),
    );
    expect(resolved).toEqual({ url: 'u', model: 'm', api_key: 'k', api_format: 'openai' });
  });

  it("api_key '' falls back per-field; set fields stay local", () => {
    writeAviary(AVIARY_TOML);
    const resolved = resolveLlmConfig(localCfg({ url: 'u', model: 'm', api_key: '' }));
    expect(resolved).toEqual({
      url: 'u',
      model: 'm',
      api_key: 'sk-aviary',
      api_format: 'anthropic',
    });
  });

  it('Go-era shape: three fields set, only api_format adopted from aviary', () => {
    writeAviary(AVIARY_TOML);
    const resolved = resolveLlmConfig(localCfg({ url: 'u', model: 'm', api_key: 'k' }));
    expect(resolved).toEqual({ url: 'u', model: 'm', api_key: 'k', api_format: 'anthropic' });
  });

  it("aviary missing: empty fields stay '', api_format backstops to 'openai'", () => {
    vi.stubEnv('LARK_NEST_DIR', dir); // no aviary file inside
    const resolved = resolveLlmConfig(localCfg({ url: 'u', model: 'm', api_key: '' }));
    expect(resolved).toEqual({ url: 'u', model: 'm', api_key: '', api_format: 'openai' });
  });

  it('aviary corrupt: silently resolves lark-side values', () => {
    writeAviary('not = valid = toml [');
    const resolved = resolveLlmConfig(localCfg({ url: 'u', model: 'm', api_key: '' }));
    expect(resolved).toEqual({ url: 'u', model: 'm', api_key: '', api_format: 'openai' });
  });

  it('aviary with non-string values: treated as unset', () => {
    writeAviary('[llm]\napi_key = 123\napi_format = 7\n');
    const resolved = resolveLlmConfig(localCfg({ url: 'u', model: 'm', api_key: '' }));
    expect(resolved).toEqual({ url: 'u', model: 'm', api_key: '', api_format: 'openai' });
  });
});

describe('redactConfig', () => {
  it('projects api_key to has_api_key', () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    expect(redactConfig(cfg).llm).toEqual({
      url: '',
      model: '',
      api_format: '',
      has_api_key: false,
    });
    cfg.llm.api_key = 'sk-secret';
    const pub = redactConfig(cfg);
    expect(pub.llm.has_api_key).toBe(true);
    expect(JSON.stringify(pub)).not.toContain('sk-secret');
  });
});

describe('loadConfigReadonly (M6-23)', () => {
  it('returns the defaults for a missing file and creates nothing', () => {
    const cfg = loadConfigReadonly(cfgPath());

    expect(cfg).toEqual(DEFAULT_CONFIG);
    // `loadConfig` would have written a default file here. A read command
    // holds no writer lock, so it must not.
    expect(readdirSync(dir)).toEqual([]);
  });

  it('parses and sanitises an existing 0600 file', () => {
    writeFileSync(cfgPath(), '[log]\nlevel = "nonsense"\nmax_backups = 3\n', { mode: 0o600 });
    chmodSync(cfgPath(), 0o600);

    const cfg = loadConfigReadonly(cfgPath());

    expect(cfg.log.level).toBe(DEFAULT_CONFIG.log.level); // out-of-domain → default
    expect(cfg.log.max_backups).toBe(3);
  });

  it('refuses an unsafe file instead of tightening it', () => {
    writeFileSync(cfgPath(), '[llm]\napi_key = "sk-secret"\n');
    chmodSync(cfgPath(), 0o644);

    expect(() => loadConfigReadonly(cfgPath())).toThrow(ConfigUnsafePermissionsError);
    // Untouched: repairing it is a write, and a read path does not write.
    expect(statSync(cfgPath()).mode & 0o777).toBe(0o644);
  });

  it('accepts 0700 — the rule is group/other access, not the exact mode', () => {
    writeFileSync(cfgPath(), '[window]\nwidth = 900\n');
    chmodSync(cfgPath(), 0o700);

    expect(loadConfigReadonly(cfgPath()).window.width).toBe(900);
  });

  it('never reads the file into existence between the two calls', () => {
    // Same permission rule as loadConfig, so a file loadConfig would accept is
    // one loadConfigReadonly accepts, and vice versa.
    writeFileSync(cfgPath(), '[window]\nwidth = 900\n');
    chmodSync(cfgPath(), 0o600);

    expect(loadConfigReadonly(cfgPath())).toEqual(loadConfig(cfgPath()));
  });
});
