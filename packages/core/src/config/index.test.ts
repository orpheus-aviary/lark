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
import { DEFAULT_CONFIG, loadConfig, redactConfig, resolveLlmConfig, saveConfig } from './index.js';

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
    expect(raw.download).toEqual({ uploader_video_limit: 100 });
    expect(raw.daemon).toEqual({ port: 47020 });
    expect((raw.log as Record<string, unknown>).max_age_days).toBe(30);

    const pub = redactConfig(cfg);
    expect(Object.keys(pub).sort()).toEqual(['font', 'llm', 'log', 'storage', 'window']);
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

[font]
global_font_size = 0
lyrics_font_size = inf

[log]
level = "verbose"
max_size_mb = nan
max_backups = 2.5

[storage]
cache_limit_mb = -1
`,
      'utf-8',
    );
    chmodSync(cfgPath(), 0o600);
    const cfg = loadConfig(cfgPath());
    expect(cfg.llm.url).toBe('https://kept.example'); // valid values survive
    expect(cfg.llm.api_key).toBe('');
    expect(cfg.window).toEqual(DEFAULT_CONFIG.window);
    expect(cfg.font).toEqual(DEFAULT_CONFIG.font);
    expect(cfg.log).toEqual(DEFAULT_CONFIG.log);
    expect(cfg.storage).toEqual(DEFAULT_CONFIG.storage);
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
