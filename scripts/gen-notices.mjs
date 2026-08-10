#!/usr/bin/env node
// THIRD-PARTY-NOTICES.md for a packaged build (M7-9).
//
//   node scripts/gen-notices.mjs <bundled|system|fixture>
//
// WHY THIS EXISTS AT ALL. The renderer bundle keeps no `@license` comments,
// and the packaging `files` glob drops `*.md`, which takes tailwind-merge's
// and sonner's LICENSE.md with it. So without this file the app ships every
// one of those licences' terms unfulfilled — an aggregated NOTICE is the only
// delivery surface there is.
//
// Two sections:
//
//   COMMON — every production dependency reachable from the GUI, walked from
//     package.json rather than guessed. Present in BOTH modes: a `system`
//     build still ships React.
//   FFMPEG — bundled only, one entry per statically linked library, with the
//     exact source URL, version, sha256 and the full configure line. LGPL 2.1
//     asks that the user be able to rebuild and relink; naming the sources and
//     the build script is how they can.
//
// Written to `packages/gui/release/staging/<mode>/`, which electron-builder
// copies into `Resources/`. Staging rather than a tracked file so the two
// modes cannot pick up each other's copy.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NODE_MODULES = join(ROOT, 'node_modules');

const mode = process.argv[2];
if (!['bundled', 'system', 'fixture'].includes(mode)) {
  process.stderr.write('usage: gen-notices.mjs <bundled|system|fixture> [--check <file>]\n');
  process.exit(2);
}

/**
 * `--check <file>`: verify an EXISTING notice instead of writing one.
 *
 * This is the drift guard (M7-9). Adding a dependency is a one-line diff that
 * changes what we are obliged to deliver, and nothing about that diff looks
 * like a licensing decision — so the release gate re-walks the dependency tree
 * and refuses a notice that is missing anyone.
 */
const checkIndex = process.argv.indexOf('--check');
const checkPath = checkIndex === -1 ? null : process.argv[checkIndex + 1];

const OUT_DIR = join(ROOT, 'packages/gui/release/staging', mode);
const LICENSE_FILES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'License', 'license.md'];

/** Workspace packages: bundled into the app, covered by lark's own LICENSE. */
const WORKSPACE = new Set(['@lark/gui', '@lark/core', '@lark/daemon', '@lark/shared']);

const manifestOf = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));

function packageDir(name) {
  const direct = join(NODE_MODULES, name);
  if (existsSync(join(direct, 'package.json'))) return direct;
  return null;
}

function workspaceDir(name) {
  for (const dir of ['packages/gui', 'packages/core', 'packages/daemon', 'packages/shared']) {
    const candidate = join(ROOT, dir);
    if (existsSync(join(candidate, 'package.json')) && manifestOf(candidate).name === name) {
      return candidate;
    }
  }
  return null;
}

/**
 * Every production package the GUI can reach, transitively.
 *
 * Walked from the manifests rather than read off the built bundle: a licence
 * obligation follows from shipping the code, and a tree-shaken export is still
 * shipped code as far as the terms are concerned.
 */
function collect() {
  const found = new Map();
  const queue = ['@lark/gui'];
  const seen = new Set(queue);

  while (queue.length > 0) {
    const name = queue.shift();
    const dir = WORKSPACE.has(name) ? workspaceDir(name) : packageDir(name);
    if (dir === null) {
      process.stderr.write(`[notices] WARNING: ${name} is declared but not installed\n`);
      continue;
    }
    const manifest = manifestOf(dir);
    if (!WORKSPACE.has(name)) found.set(name, { manifest, dir });

    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      queue.push(dep);
    }
  }
  return found;
}

function licenseText(dir) {
  const entry = readdirSync(dir).find((f) => LICENSE_FILES.includes(f));
  if (entry === undefined) return null;
  return readFileSync(join(dir, entry), 'utf8').trim();
}

function commonSection(packages) {
  const lines = [
    '## 打包进本应用的第三方软件',
    '',
    `共 ${packages.size} 个 npm 包。以下按名称排序，逐个列出版本、许可证与许可证原文。`,
    '',
  ];

  for (const [name, { manifest, dir }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    const license = manifest.license ?? '（未在 package.json 中声明）';
    const home = manifest.homepage ?? manifest.repository?.url ?? manifest.repository ?? '';
    lines.push(`### ${name} ${manifest.version}`, '', `许可证：${license}`);
    if (typeof home === 'string' && home !== '') lines.push(`项目地址：${home}`);
    lines.push('');

    const text = licenseText(dir);
    if (text === null) {
      // Said out loud rather than skipped: a package whose terms we could not
      // find is a gap someone has to close by hand.
      lines.push(
        `> 该包未随发行物附带许可证文件，请参见上面的项目地址（声明的许可证为 ${license}）。`,
        '',
      );
    } else {
      lines.push('```', text, '```', '');
    }
  }
  return lines.join('\n');
}

function ffmpegSection() {
  const lock = JSON.parse(readFileSync(join(ROOT, 'vendor/ffmpeg.lock.json'), 'utf8'));
  const lines = [
    '## FFmpeg',
    '',
    '本安装包内含一份自建的 FFmpeg（`Contents/Resources/ffmpeg/`），仅用于把下载到的音频',
    '转成 mp3、以及读取音频信息。它以独立进程运行，不与本应用链接。',
    '',
    `构建配置（profile \`${lock.profile}\`，许可证 **${lock.license}**）：`,
    '',
    '```',
    lock.configure,
    '```',
    '',
    '按 LGPL 2.1 第 6 条，你有权修改其中任一库并重新链接。为此所需的全部材料如下：',
    '',
  ];

  for (const source of lock.sources) {
    lines.push(
      `### ${source.name} ${source.version}`,
      '',
      `- 许可证：${source.license}`,
      `- 源码：${source.urls.join(' 或 ')}`,
      `- sha256：\`${source.sha256}\``,
      `- 补丁：${source.patches.length === 0 ? '无' : source.patches.join('、')}`,
      '',
    );
  }

  lines.push(
    `构建脚本随源码仓库发布：\`${lock.build_script}\`（版本 ${lock.build_script_version}），`,
    '配合上面的 configure 行即可复现同一份二进制。',
    '',
  );
  return lines.join('\n');
}

const packages = collect();
const header = [
  '# 第三方软件声明',
  '',
  'lark 本身以 MIT 许可证发布（见随附的 LICENSE）。本文件列出随本安装包一并分发的第三方软件。',
  '',
].join('\n');
const sections = [commonSection(packages), mode === 'system' ? null : ffmpegSection()];
const document = header + sections.filter((section) => section !== null).join('\n');

if (checkPath !== null) {
  if (!existsSync(checkPath)) {
    process.stderr.write(`[notices] ${checkPath} does not exist\n`);
    process.exit(1);
  }
  const shipped = readFileSync(checkPath, 'utf8');
  // Heading match, not substring: `### react 19.2.4` must be present as an
  // ENTRY. A bare name search would be satisfied by any mention anywhere,
  // including inside somebody else's licence text.
  const missing = [...packages]
    .filter(([name, { manifest }]) => !shipped.includes(`### ${name} ${manifest.version}`))
    .map(([name, { manifest }]) => `${name}@${manifest.version}`);

  const needsFfmpeg = mode !== 'system';
  const hasFfmpeg = shipped.includes('## FFmpeg');
  const problems = [
    ...(missing.length === 0 ? [] : [`未列出的生产依赖：${missing.join('、')}`]),
    ...(needsFfmpeg && !hasFfmpeg ? ['缺少 FFmpeg 段'] : []),
    // A system build must not claim to ship an ffmpeg it does not have.
    ...(!needsFfmpeg && hasFfmpeg ? ['system 构建不该有 FFmpeg 段'] : []),
  ];
  if (problems.length > 0) {
    process.stderr.write(`[notices] ERROR: ${problems.join('；')}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `[notices] ${mode}: ${packages.size} packages all present in ${checkPath}\n`,
  );
  process.exit(0);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'THIRD-PARTY-NOTICES.md'), `${document}\n`);
process.stdout.write(`[notices] ${mode}: ${packages.size} packages -> ${OUT_DIR}\n`);
