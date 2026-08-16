import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SKILL_TEMP_PREFIX } from '@lark/core/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureStreams } from '../lib/output.js';
import { renderSkillTemplate } from './skill-template.js';
import { installPrompt, resolveSkillTarget, runSkillExport } from './skill.js';

const rendered = renderSkillTemplate({ version: '9.9.9-test' });

// ─── The document's contract ───────────────────────────

describe('the skill document', () => {
  it('starts with YAML frontmatter naming the skill', () => {
    expect(rendered.startsWith('---\n')).toBe(true);
    const end = rendered.indexOf('\n---\n', 4);
    expect(end).toBeGreaterThan(0);

    const frontmatter = rendered.slice(4, end);
    expect(frontmatter.split('\n').find((line) => line.startsWith('name:'))).toBe('name: lark');
  });

  it('has a description substantive enough to match on', () => {
    // A skill is selected by its description; a terse one never triggers.
    const description = /^description: (.+)$/m.exec(rendered)?.[1] ?? '';
    expect(description.length).toBeGreaterThan(80);
    expect(description).toMatch(/lark/);
    expect(description).toMatch(/下载|播放/);
  });

  it('carries the version it was rendered with', () => {
    expect(rendered).toContain('9.9.9-test');
  });

  it('documents the envelope contract, both halves', () => {
    // The one thing an agent must not have to guess: what stdout holds on
    // success, and where the error goes (M6-6).
    expect(rendered).toContain('"success": true');
    expect(rendered).toContain('"success": false');
    expect(rendered).toContain('error_code');
    expect(rendered).toMatch(/exit 0/);
  });

  it('covers all seven exit codes in a table', () => {
    for (const code of [0, 1, 2, 3, 4, 5, 130]) {
      expect(rendered).toMatch(new RegExp(`\\|\\s*${code}\\s*\\|`));
    }
  });

  it('mentions every command word the registry registers', () => {
    // Coupled to `index.ts` ON PURPOSE: a command added to the CLI without a
    // line in the skill turns this red. It compares WORDS, not full paths —
    // subcommands are registered on their parent, so `songs edit` shows up
    // here as `edit` — which over-approximates for words that already appear.
    // It still catches the case that matters: a genuinely new verb.
    const registry = readFileSync(new URL('../index.ts', import.meta.url), 'utf-8');
    const words = new Set(
      [...registry.matchAll(/\.command\('([a-z-]+)/g)].map((match) => match[1] as string),
    );
    expect(words.size).toBeGreaterThan(15);

    for (const word of words) {
      expect(rendered, `the skill never mentions \`${word}\``).toContain(word);
    }

    // The transport controls are registered from a loop, so a scan for string
    // literals cannot see them. They are a closed set, so they are named here.
    for (const control of ['pause', 'resume', 'next', 'prev']) {
      expect(rendered, `the skill never mentions \`${control}\``).toContain(control);
    }
  });

  it('names the installed bin first, and the repo form as the alternative', () => {
    expect(rendered).toContain('@orpheus-aviary/lark-cli');
    expect(rendered).toContain('just cli');
    // The agent reaches for `lark` and only falls back to the repo form.
    expect(rendered.indexOf('lark <command>')).toBeLessThan(rendered.indexOf('just cli'));
  });

  it('states the confirmation rule, which is where an agent gets stuck', () => {
    expect(rendered).toContain('--yes');
    expect(rendered).toMatch(/AMBIGUOUS_SONG/);
  });
});

// ─── Writing it out ────────────────────────────────────

describe('lark skill export', () => {
  let nest: string;

  beforeEach(() => {
    nest = mkdtempSync(join(tmpdir(), 'lark-skill-'));
    mkdirSync(join(nest, 'lark'), { recursive: true });
    vi.stubEnv('LARK_NEST_DIR', nest);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(nest, { recursive: true, force: true });
  });

  it('defaults to the nest, and leaves no temp file behind', async () => {
    const streams = captureStreams();
    await runSkillExport({}, { streams, json: false });

    const target = join(nest, 'lark', 'lark-skill.md');
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf-8')).toContain('name: lark');
    // The rename is the commit point: nothing with the temp prefix survives it.
    expect(readdirSync(join(nest, 'lark')).filter((n) => n.startsWith(SKILL_TEMP_PREFIX))).toEqual(
      [],
    );
  });

  it('writes exactly where --output points', async () => {
    const target = join(nest, 'somewhere.md');
    await runSkillExport({ output: target }, { streams: captureStreams(), json: false });
    expect(existsSync(target)).toBe(true);
  });

  it('appends the default name when --output is a directory', () => {
    const dir = join(nest, 'lark');
    expect(resolveSkillTarget(dir)).toBe(join(dir, 'lark-skill.md'));
  });

  it('creates the parent directories it needs', async () => {
    const target = join(nest, 'a/b/c/skill.md');
    await runSkillExport({ output: target }, { streams: captureStreams(), json: false });
    expect(existsSync(target)).toBe(true);
  });

  it('takes a trailing slash as a directory, and creates it', async () => {
    // T6 实测: this used to fail with ENOENT on the rename, reported as a bare
    // UNKNOWN — `-o <dir>/` is unambiguous and now says so.
    await runSkillExport(
      { output: `${join(nest, 'fresh')}/` },
      {
        streams: captureStreams(),
        json: false,
      },
    );
    expect(existsSync(join(nest, 'fresh/lark-skill.md'))).toBe(true);
  });

  it('prints the install prompt in human mode', async () => {
    const streams = captureStreams();
    await runSkillExport({}, { streams, json: false });

    const output = streams.stdout.join('\n');
    expect(output).toContain('✓');
    expect(output).toContain(join(nest, 'lark', 'lark-skill.md'));
    // The prompt is the deliverable: the CLI does not install anything itself.
    expect(output).toContain('skill');
    expect(streams.stderr).toEqual([]);
  });

  it('--json prints one envelope carrying {path, prompt}', async () => {
    const streams = captureStreams();
    await runSkillExport({}, { streams, json: true });

    expect(streams.stdout).toHaveLength(1);
    const envelope = JSON.parse(streams.stdout[0] as string) as {
      success: boolean;
      data: { path: string; prompt: string };
    };
    expect(envelope.success).toBe(true);
    expect(envelope.data.path).toBe(join(nest, 'lark', 'lark-skill.md'));
    expect(envelope.data.prompt).toBe(installPrompt(envelope.data.path));
  });

  // §7 F14: `playlist export -o` has always asked, and this did not — one
  // flag on two commands meaning two different things. The document is
  // generated, but the file it lands on may not be the one lark wrote.
  it('asks before overwriting a previous export', async () => {
    const streams = captureStreams();
    await runSkillExport({}, { streams, json: false, yes: true });

    // No TTY and no --yes: the confirmation refuses rather than assuming.
    await expect(runSkillExport({}, { streams, json: false })).rejects.toMatchObject({
      code: 'USAGE_ERROR',
    });

    const target = join(nest, 'lark', 'lark-skill.md');
    expect(readFileSync(target, 'utf-8')).toContain('name: lark');
    expect(readdirSync(join(nest, 'lark'))).toEqual(['lark-skill.md']);
  });

  it('overwrites without asking once told to', async () => {
    const streams = captureStreams();
    await runSkillExport({}, { streams, json: false, yes: true });
    await runSkillExport({}, { streams, json: false, yes: true });

    expect(readdirSync(join(nest, 'lark'))).toEqual(['lark-skill.md']);
  });
});
