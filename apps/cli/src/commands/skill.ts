// `lark skill export` (M6-14).
//
// Writes the agent skill document and prints the prompt that installs it. The
// CLI deliberately does NOT install it itself: every agent has its own idea of
// where skills live and what frontmatter they need (Claude Code's YAML, a
// Cursor `.mdc` with globs, …), and guessing wrong writes into somebody's
// config directory. So lark produces the file and one paste-able instruction,
// and the agent — which knows its own conventions — does the rest.
//
// The write is atomic in the only sense that matters here: a temp file in the
// SAME directory, then rename. The default target sits inside the nest, and a
// half-written document there would be picked up by a backup as if it were
// data. (It is not: `backupNest` skips both the artefact and the temp prefix
// at every depth — which is why both names live in `@lark/core/paths`.)

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { SKILL_FILE_NAME, SKILL_TEMP_PREFIX, skillPath } from '@lark/core/paths';
import { confirm } from '../lib/confirm.js';
import { type Streams, emitEnvelope, successEnvelope } from '../lib/output.js';
import { resolveTargetPath } from '../lib/target-path.js';
import { CLI_VERSION } from '../version.js';
import { renderSkillTemplate } from './skill-template.js';

export interface SkillExportOptions {
  output?: string;
}

export interface SkillExportDeps {
  streams: Streams;
  json: boolean;
  /** `--yes`: skip the overwrite question (and required outside a TTY). */
  yes?: boolean;
  version?: string;
}

export interface SkillExportData {
  path: string;
  prompt: string;
}

/** Where the document goes; `--output` is read by the shared rule. */
export function resolveSkillTarget(output: string | undefined): string {
  if (output === undefined || output === '') return skillPath();
  return resolveTargetPath(output, SKILL_FILE_NAME);
}

/** The one instruction the user pastes to whichever agent they are using. */
export function installPrompt(filePath: string): string {
  return `请读取 ${filePath}，把它作为一个 skill 安装到我正在用的 AI agent 里（不确定全局路径就装到当前项目级目录）。按该 agent 的 skill 规范调整前置元数据（例如 Claude Code 的 YAML frontmatter、Cursor 的 .mdc globs），然后告诉我最终装到了哪里、以及怎么验证它会被触发。`;
}

export async function runSkillExport(
  opts: SkillExportOptions,
  deps: SkillExportDeps,
): Promise<void> {
  const target = resolveSkillTarget(opts.output);
  // §7 F14: `playlist export -o` asks before overwriting and this did not,
  // which made "the same flag on two commands" mean two different things. The
  // file it lands on is usually a skill someone edited.
  if (existsSync(target)) {
    await confirm(`${target} 已存在，覆盖？`, { yes: deps.yes === true, json: deps.json === true });
  }
  await mkdir(dirname(target), { recursive: true });

  const document = renderSkillTemplate({ version: deps.version ?? CLI_VERSION });
  await writeAtomically(target, document);

  const prompt = installPrompt(target);
  if (deps.json) {
    return emitEnvelope(
      deps.streams,
      successEnvelope({ path: target, prompt } satisfies SkillExportData, {
        message: 'skill exported',
      }),
    );
  }

  const divider = '─'.repeat(60);
  deps.streams.out(`✓ lark skill 已导出到 ${target}`);
  deps.streams.out('');
  deps.streams.out('把下面这段完整粘贴给你正在用的 AI 助手，让它装到 skill 目录：');
  deps.streams.out(divider);
  deps.streams.out(prompt);
  deps.streams.out(divider);
}

/** Same-directory temp + rename, with the prefix the backup knows to skip. */
async function writeAtomically(target: string, contents: string): Promise<void> {
  const temp = join(dirname(target), `${SKILL_TEMP_PREFIX}${randomUUID()}`);
  await writeFile(temp, contents, { mode: 0o600 });
  await rename(temp, target);
}
