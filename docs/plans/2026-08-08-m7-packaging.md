# M7 打包发布 v0.1.0 子计划

> 2026-08-08 起草；评审六轮——一轮定 LICENSE/CLI 体积/app 查找，二轮推翻 ffmpeg 分发建模（E1–E17），三轮冻结保底，四轮升格 `bundled|system` 一等模式（F1–F9），五轮补模式控制面/`media_tools` 线协议/NOTICE 生成链/发布物绑定（G1–G7），六轮修 just 语法/媒体工具单一真相/DMG-only 验收/NOTICE 全依赖/能力级 ready/fixture 隔离（H1–H6）——**定稿，开工执行**。
> 主计划：`docs/plans/2026-07-16-ts-rewrite-master-plan.md`（§6 M7 行、R17/R28、§8 GPL 风险行；R17 修订注记见 §3.0「事实源同步」）。
> 上游定案（用户 2026-08-08）：签名与分发照 owl（ad-hoc + dmg + 不公证 + asar:false）；CLI 发布照 owl（tsup bundle + gen-publishable-manifest，发 `@orpheus-aviary/lark-cli`）。

## 0. 目标与非目标

**目标**：

1. **ffmpeg 可再分发化（T0）**：现二进制 `--enable-nonfree` 不可再分发（实证 2026-08-08）。交付冻结 **`bundled | system` 两个一等构建模式**（M7-16），唯一控制面 = **just 位置参数**（`just package [bundled|system]`，默认 bundled，非法值 fail-fast——★六轮 H1：`mode=` 写法在 just 1.46.0 下无效，会被当第二个 recipe）。
2. **媒体工具单一真相（★六轮 H2，M7-18 扩）**：进程级 **MediaToolsRegistry** 进 AppContext——boot 创建（missing/incompatible **不是** boot failure）、capabilities/下载引擎/导入/一切 ffprobe 调用共享、single-flight 重探、执行失败使 ready 缓存失效；`MEDIA_TOOLS_UNAVAILABLE` 覆盖**导入与下载**；`LOCAL_API_VERSION` 3→4。
3. **GUI 打包**：electron-builder 出 mac arm64 dmg，ad-hoc 签名，GitHub Releases。
4. **打包后进程定位**：`launch.ts` 两 SEAM + `gui.ts` exited 判据 + `ensure-daemon` 预检分流。
5. **CLI 发布**：tsup bundle 保 M6-21 边界；补 direct 链 ABI 错误映射。
6. **许可交付**：LICENSE = MIT；★六轮 H4：NOTICE 覆盖**全部生产依赖**（React/Radix/dnd-kit 等打进 renderer 的 JS 依赖两模式都要），FFmpeg/LAME 是 bundled 附加段而非全部；GUI 经有类型 IPC 展示 bundle 内最终那份。
7. **验收**：★六轮 H3：accept-pack 的判据 2–5、10 **只对只读挂载的传入 DMG 内那一个 Lark.app** 执行，禁读 release 目录，验收前后复核 DMG SHA 未变；★六轮 H5：bundled 分发物做**真实转码闭环**（M4A → MP3 → ffprobe JSON）。
8. **发版**：发布物与已验收 HEAD/固定 artifact 严格绑定（M7-19）；公开 tag 与已发 npm 版本不可变。

**非目标**：

| 不做 | 理由 |
|---|---|
| 公证 / 开发者证书 | R28：ad-hoc |
| 自动更新 | owl 同口径 |
| Intel / Windows / Linux | 仅 macOS arm64（npm 加 `os`/`cpu`，M7-13） |
| CI / 自动发布流水线 | owl 零 CI，本地门禁 + 手动上传 |
| asar 恢复 | better-sqlite3 + ffmpeg 要求 `asar:false`（R17） |
| 纯 CLI / headless | 一轮定案：lark 基本必须 GUI |
| skill 自动安装进 agent | M6 定案 |
| 对 system/env 来源的 ffmpeg 做许可门禁 | ★六轮 H5：用户自装的二进制不是本项目分发物——nonfree 校验只管 vendor 获取与 bundled 分发物，system/env 只做**功能兼容**检查 |

## 1. 移交清单核对（输入）

| 来源 | 条目 | 归入 |
|---|---|---|
| 二轮 E1 | ffmpeg 不可再分发，重建供应链 | **T0** |
| 四轮 F1 / 五轮 G1 / 六轮 H1·H6 | `bundled\|system` 一等模式 + 位置参数控制面 + fixture 隔离 | T0（M7-16） |
| 五轮 G2 / 六轮 H2·H5 | MediaToolsRegistry + `media_tools` 协议 + 能力级 ready + 版本升级 | T0（M7-18） |
| 六轮 H4 | NOTICE 覆盖全部生产依赖 | T4（M7-9 扩） |
| 六轮 H3 | DMG-only 验收 | T5（M7-19 扩） |
| M6 §1 推迟表 | 全局 `lark` bin / npm 发布名；daemon/gui 打包后定位；skill agent 验收 | T3 / T2 / T5 |
| M6 §8.10 | ABI 失配 exit 3；GUI 冷启动出声 | T3+T5 / T5（用户） |
| 主计划 §6/§8、M0-4 | 打包冒烟 / 许可交付 / 自建预案 / electron-builder 版本 | T0/T1/T4/T5 |

## 2. 现状盘点（★ = 评审修正过的认知）

### 2.1 owl 打包链（基线，多处不可照抄）

- `electron-builder.yml`：`asar:false`、`identity:null`+afterPack、dmg arm64、`writeUpdateInfo:false`。★ lark 按模式条件化 → **`electron-builder.config.mjs`**。
- workspace 依赖「路径 A」（externalizeDepsPlugin + gui dependencies → 真实目录进 `Resources/app/node_modules/`，0.6.2 实证）。
- codesign-adhoc.mjs 理由过时（26.15.7 起 `identity: '-'` 一等公民；`null` = 跳过）。
- 图标链 sips+iconutil；`resources/.gitignore` 忽略生成物。
- GUI 定位 daemon 无 isPackaged 分支（`require.resolve` + Electron-as-Node）。
- ★ owl CLI 无 lazy-native 边界；server「多文件即 fail」守卫反着用；gen-manifest `lockedVersion()` dead code；★ `unpackage` 抓错 ABI prebuilt——用 lark 的 `build-release` 路径。
- 发版 = 本地门禁 + 手动上传；notes 附 SHA-256、「右键 → 打开」。

### 2.2 lark 现状

- electron-builder 不存在；`.gitignore` 已忽略 `build/`、`release/`；`.npmrc` 已 hoisted。
- GUI spawn daemon：`require.resolve('@lark/daemon/cli')` + `ELECTRON_RUN_AS_NODE:'1'`（daemon-manager.ts:291-295，env 契约测试）。★ bundled 打包后 spawner 注入 `LARK_MEDIA_TOOLS_DIR`，测试跟改。
- `launch.ts` 两处 M7 SEAM；★ `LaunchedChild.state` 无 exitCode/signal。
- ★ `ensure-daemon` 的 `probeAbi()` 打包态探错副本。
- ★ direct 链无 ABI 错误映射；★ `native-probe.ts:38` 文案内嵌 just 命令——改结构化原因。
- ★ ffmpeg「双真相」现状（六轮 H2 实读）：`boot.ts:334` 在 fatal try 内解析一次；`ffmpeg.ts:109` `ensureMp3()` 与 `:143` `probeAudio()` **每次重新解析**，不用 boot 结果；`import.ts:88` 独立调 ffprobe 且把错误降成普通导入失败；`BootOptions` 只经 `testing/boot-child.ts:43` 可达，正式 daemon CLI 调无参 `boot()`。→ T0 必须收敛为 registry 单一真相。
- ★ resolver 现状 env 无条件采用（ffmpeg.ts:76）；★ Finder/LS 启动不继承 shell PATH（`launchctl getenv PATH` 实证空）；★ 本机 `/opt/homebrew/bin/ffmpeg` 真实存在——system 缺失态验收必须注入，不动用户文件。
- ★ GUI renderer 产物**不保留第三方 @license/版权文本**（六轮 H4 实查 out/renderer），且 files 的 `!**/*.md` 会排掉 tailwind-merge/sonner 等的 LICENSE.md——第三方许可交付两模式都缺，NOTICE 必须聚合全部生产依赖。
- migrations 无 .sql；★ CLI 入口已有 shebang（banner = 双 shebang）；★ direct 读不建库（fresh nest 读 = `DB_NOT_INITIALIZED` exit 3）；★ `status` 无 daemon exit 4（实证）。
- 图标源 `lark-logo.png`（1024×1024 已核验）。版本全 `0.1.0`；`LOCAL_API_VERSION = 3`（T0 升 4）；★ 根 engines `>=22.12` → `>=24`。
- 许可：仓库无 LICENSE/NOTICE；owl 是 MIT；aviary 无。★ preload 无许可读取入口——About 需新增 IPC。
- git remote：`github.com/orpheus-aviary/lark`。

### 2.3 ffmpeg 可再分发候选（T0 spike 定案）

- evermeet（仅 Intel 且 nonfree）、OSXExperts（现来源）——排除。
- **Martin Riedl**：macOS arm64 静态构建，GPLv3、脚本公开、每 artifact 有 configure info 页。待核：release 构建无 nonfree？能力清单覆盖？checksum？外部库全清单？
- **自建最小 LGPL profile**（主计划预授权；倾向）：能力清单见 §3.0，体积预计 <15MB。

## 3. 设计

### 3.0 ffmpeg 供应链重建（T0）

**模式控制面（★六轮 H1 修正语法）**：
- **`just package [mode]`**——位置参数，recipe 形如 `package mode="bundled":`，默认 `bundled`；recipe 内校验，非 `bundled|system` 立即 fail（`mode=` 键值写法在 just 1.46.0 下会被当第二个 recipe，实测报 "does not contain recipe"）。经 env `LARK_FFMPEG_MODE` 传入 pnpm package，`electron-builder.config.mjs` 读取并再校验。
- 同理 **`just accept-pack <mode> <dmg> <tgz>`**（三个必填位置参数）。
- mode 决定：`directories.output = release/<mode>`（构建前清理本模式目录）、extraResources 增删、staging NOTICE 选择、release notes / README 安装段变体（system 版**下载前**写明 `brew install ffmpeg`）。
- **门禁按模式解耦**：system 发布只要求 system 真实门禁；bundled 机制在保底世界用 fixture 验证（见下）。dev/test 链 ffmpeg = vendor 优先、否则系统安装（测试不是分发）。

**fixture 隔离（★六轮 H6）**：
- stub vendor 固定放 `packages/gui/test/fixtures/ffmpeg-stub/`；**独立 recipe `just package-fixture`** 封装（内部即 bundled 机制 + stub 目录覆盖），输出 **`release/fixture/`**——只用于机制验收（extraResources 复制 / env 注入 / resolver bundle 级 / NOTICE staging 选择），**不是 release gate，发版永不从它取**。
- 正式 `just package bundled` **每次运行**都前置 `fetch-ffmpeg` 的锁校验（vendor 内容 SHA 与 `ffmpeg.lock.json` 一致才继续）——stub 过不了锁校验，机制上排除混入 `release/bundled/`。

**resolver 规格（core `ffmpeg.ts`，四级）**：
1. 用户 env `LARK_FFMPEG_PATH`/`LARK_FFPROBE_PATH`：显式 override，设了但不存在 → 立即报错；
2. `LARK_MEDIA_TOOLS_DIR`（spawner 注入的 bundle 目录）：目录存在即注入；resolver 做**完整性判定**——两工具都是可执行普通文件才用（`source='bundle'`），不齐 = `incompatible` **不降级**；
3. Homebrew 惯例位 `/opt/homebrew/bin` → `/usr/local/bin`（LS 启动不继承 shell PATH）；
4. PATH 裸名。`source` ∈ `'env'|'bundle'|'homebrew'|'path'`。探测目录可注入（测试）。删 static 包 level；两包从 core 依赖移除，`onlyBuiltDependencies` 清理。

**MediaToolsRegistry（★六轮 H2，单一真相，M7-18）**：
- **boot 创建、放入 AppContext（`ctx.mediaTools`）**，与 `ctx.bilibili` 同款生命周期；`missing`/`incompatible` **不是 boot failure**（boot 照常完成，capabilities 可查——现状 boot.ts:334 在 fatal try 内解析的形态废除）。
- **所有消费方共享**：capabilities 路由、下载引擎转码（`ensureMp3`）、`probeAudio`、导入的 ffprobe（import.ts:88）——core 的执行函数改为**显式接收 resolved binaries**（由 registry 提供），不再各自重新解析（消灭「capabilities 报 missing、下载却自己找到 Homebrew 成功」的双真相）。
- **重探 single-flight**；`missing`/`incompatible` 下按 ≥5s 节流（brew 装完刷新设置页即恢复）；`ready` 缓存，但**实际执行失败（ENOENT/spawn 错）使 ready 缓存失效**，下次 acquire 重探。
- **`MEDIA_TOOLS_UNAVAILABLE` 覆盖导入与下载**：registry `acquire()` 失败抛类型化错误 → daemon 错误处理映射 503；导入不得再把工具缺失降成普通导入失败。
- **ready 判定 = 完整能力清单（★六轮 H5，不止 libmp3lame）**：`-version` 成功 + 逐项核对 `-formats`/`-demuxers`/`-decoders`/`-encoders`/`-muxers` 覆盖冻结清单（file protocol；demuxer mov/mp4/m4a + mp3；decoder AAC + MP3；encoder libmp3lame；muxer mp3）+ ffprobe JSON（`-print_format json` 可用）。单工具探测硬超时 2s，超时归 `incompatible`。★ **不做许可校验**——nonfree 门禁只属于 vendor 获取（fetch-ffmpeg）与 bundled 分发物（accept-pack 判据 3）；用户自装的 system/env 二进制哪怕 nonfree 也只看功能。
- 探测注入走 `BootOptions`（M2 惯例：正式 CLI 无参 `boot()`，注入只经 `testing/boot-child.ts`）。

**`media_tools` 线协议（capabilities 必填，`LOCAL_API_VERSION` 3→4）**：

```ts
media_tools: {
  state: 'ready' | 'missing' | 'incompatible',
  ffmpeg:  { path: string, source: 'env'|'bundle'|'homebrew'|'path' } | null,
  ffprobe: { path: string, source: … } | null,
  detail: string | null   // 安全诊断（不含内部暂存路径）
}
```

GUI 设置页与下载栏按 state 提示（「未找到 ffmpeg——`brew install ffmpeg`」）；CLI 透传错误码与指引。

**来源定案（T0 首日 spike）**：甲 = Riedl release 构建核验采用（无 nonfree、能力覆盖、checksum、外部库全清单）+ 镜像到自有 Release；乙 = 自建最小 LGPL profile（倾向）。判定：许可干净度 > 义务面 > 维护成本；两案都不顺 → system 模式发布（直接执行；主计划 R17 标注修订）。结论记 §8。

**获取与锁定**：`vendor/ffmpeg.lock.json`（入库）——二进制 URL/版本/完整 configure/下载时原始 SHA-256；FFmpeg 与每个静态外部库（至少 LAME）的源码 tarball URL + SHA-256 + 补丁 + 构建脚本版本；甲案加第三方外部库全清单。`just fetch-ffmpeg`：下载 → 原始 SHA 校验 → configure 比对（见 nonfree 立即 fail）→ `vendor/ffmpeg/`（git-ignore）。

**SHA 语义**：签名改写 Mach-O——原始 SHA 只验到入包前；打包后验 codesign + configure + 能力 + 真实转码闭环（§3.5 判据 3），不比原始哈希；发布哈希另生成「签名后 SHA」。

**CLI npm 包彻底不带 ffmpeg**。

**事实源同步（T0 开工前第一个 commit）**：PROCESS.md M7 条目改写；主计划 §6 M7 行与 R17/「mp3 + 打包 ffmpeg」加修订注记（bundled 目标、system 一等保底）。

### 3.1 GUI 打包（T1）

`packages/gui/electron-builder.config.mjs`（读 `LARK_FFMPEG_MODE`，非法值 throw）：

```yaml
appId: com.orpheusaviary.lark
productName: Lark
directories: { output: release/<mode>, buildResources: resources }
files: [out/**, package.json, '!**/*.{ts,map,md,flow}', '!**/node_modules/*/{test,...}/**']
asar: false
mac: { target: [{target: dmg, arch: [arm64]}], category: public.app-category.music,
       icon: resources/icon.icns, hardenedRuntime: false, gatekeeperAssess: false, identity: '-' }
dmg: { artifactName: 'Lark-${version}-${arch}.${ext}', writeUpdateInfo: false }
extraResources:   # NOTICE 从 staging 取（§3.4），不指 tracked 文件
  - { from: release/staging/<mode>/THIRD-PARTY-NOTICES.md, to: . }
  - { from: ../../LICENSE, to: . }
  # bundled 追加：{ from: ../../vendor/ffmpeg, to: ffmpeg }（package-fixture 时替换为 stub 目录）
```

- 签名（M7-1）：首选 `identity: '-'`；判据 2 断言；不达标回退 owl afterPack，记 §8。
- 图标：源图入库 `resources/lark-logo-original.png`；build-icons 照 owl；`resources/.gitignore` 忽略生成物。
- package 链五段（build:deps → icons → gen-notices → electron-vite build → install-app-deps → electron-builder）；electron-builder 26.x 精确锁版。
- justfile：`package mode="bundled"`（位置参数；前置 `ensure-electron-abi`；bundled 前置 `fetch-ffmpeg` 锁校验；开头清理 `release/<mode>`）、`package-fixture`、`unpackage`（build-release 路径）、`clean` 补删 `packages/gui/release`。

### 3.2 打包后进程定位（T2）

- `workspaceRoot()` 失败 → 打包态。单一 resolver：`resolveAppBundle()` = `LARK_APP_PATH`（fail-fast）→ `/Applications/Lark.app` → `~/Applications/Lark.app`；验真 = bundle 内 daemon cli.js 存在；全败统一报错；`lark gui` 不退 `open -a`/`-b`。
- `daemonLaunchCommand()` 打包分支：app 内 Electron + `ELECTRON_RUN_AS_NODE=1`；`Resources/ffmpeg` 目录存在即注入 `LARK_MEDIA_TOOLS_DIR`。`LaunchCommand` 加可选 `env`。
- `guiLaunchCommand()` 打包分支：`/usr/bin/open <resolveAppBundle() 路径>` + `expectsImmediateExit`。
- `LaunchedChild.state` 扩 `{exited, exitCode, signal, error}`；`gui.ts` 条件化；`ensure-daemon` 预检分流（dev 探自身，打包态跳过、spawn 后观测兜底）。
- GUI 侧 daemon-manager 同款目录信号注入；env 契约测试跟改。
- 测试：resolver 各态、exitCode/signal、gui.ts 两态、预检分流、注入两态。

### 3.3 CLI 发布物（T3）

```ts
// apps/cli/tsup.config.ts —— 无 banner（双 shebang 实测）
entry: ['src/index.ts'], format: ['esm'], target: 'node24',
bundle: true, splitting: true,
noExternal: ['@lark/core', '@lark/shared'],
external: ['better-sqlite3', 'drizzle-orm', 'pino', 'pino-roll', 'smol-toml', 'commander'],
outDir: 'dist-publish', clean: true, sourcemap: true,
onSuccess: 'node scripts/gen-publishable-manifest.mjs',
```

- 发布目录冻结 `dist-publish/`。
- **首日 spike（gate）**：① entry chunk 无 better-sqlite3/barrel 静态引用；② 正向（Node ABI，fresh nest）先写后读（`playlist create smoke --direct` → `songs list --direct`）；③ 反向（Electron ABI）`--help` exit 0 + `status` 无 daemon exit 4 且 `error_code === 'DAEMON_UNAVAILABLE'`。后备：不可分析 specifier → 双 entry。
- **ABI 错误映射（M7-14）**：direct 动态 import 前调 `probeNativeAbi()` → `ABI_MISMATCH`；判据断言 `error_code`；probe 返回结构化原因，文案按 dev/发布态由调用侧生成。
- **gen-publishable-manifest.mjs**：`@orpheus-aviary/lark-cli`、`bin: {lark, lark-cli}`、`engines.node ">=24"`（同批修根 engines）、`os/cpu` darwin/arm64；deps = tsup external 非 workspace 包（精确版本）；`files` = entry + chunks + README + LICENSE。
- 契约测试：external ⟷ deps 一致、无 `workspace:*`、`dist-publish/` 无杂物。
- justfile：`build-cli-dist`；`cli-smoke`（断言 harness：`--help` exit 0；`status` 断言 exit 4 + `DAEMON_UNAVAILABLE`）；`pack-cli`（产固定 `.tgz`）。

### 3.4 许可与文档（T4）

- **LICENSE**：MIT（tracked 根文件），extraResources 进 dmg。
- **NOTICE 生成链（★六轮 H4 扩为三段式）**：tracked = `scripts/gen-notices.mjs` + 模板 + `vendor/ffmpeg.lock.json`；生成到 staging（`packages/gui/release/staging/<mode>/`），builder 按 mode 取。内容：
  1. **共有段（两模式都有）= 全部生产依赖许可聚合**——GUI renderer 打进去的 npm 包（React/Radix/dnd-kit/zustand/Lucide/tailwind-merge/sonner…）+ main/preload 与 workspace 传递生产依赖 + native（better-sqlite3 等），从依赖树与各包 LICENSE 文件聚合（renderer 产物不保留 @license 注释、files 又排 `*.md`，聚合进 NOTICE 是唯一交付面）；
  2. bundled 附加 FFmpeg/LAME 段（逐库：版本/configure/原始 SHA/许可文本/精确源码与脚本地址）；
  3. system = 共有段原样，仅无 ffmpeg 段——**不能整份没有第三方信息**。
  验收做**覆盖检查**：实际生产依赖清单 vs NOTICE 条目，新增依赖漏更新即 fail。
- **GUI「关于/许可」入口**：main 读 `process.resourcesPath` 下 LICENSE + NOTICES（dev fallback），preload 增有类型只读 IPC，设置页展示 bundle 内最终那份 + 版本。
- **README**：下载安装段、CLI 段、License 段替换 TBD、删「全局 bin 要等 M7」注记；按最终模式生成安装说明。
- **skill 模板**：删「仓库内用 `just cli`」注记。

### 3.5 验收与发版（T5）

**`just accept-pack <mode> <dmg> <tgz>`**——消费给定固定 artifact。★六轮 H3 **DMG-only 铁律**：判据 2–5、10 全部只对**只读挂载（`hdiutil attach -readonly`）的传入 DMG** 内的 app 执行——挂载后断言其中**恰好一个 Lark.app**；**禁止读取 `release/<mode>/mac-arm64/Lark.app`**；验收前后各算一次传入 DMG 的 SHA-256 并断言未变。

**阶段①（Node ABI）**：bundled 核 vendor 原始 SHA/configure → `backup-nest` 副本 → 判据 6a/6b（跑 tgz 解包产物）。
**阶段②（Electron ABI）**：判据 1–5、6c、7、8、9、10。

| # | 判据 | 方式 |
|---|---|---|
| 1 | 传入 dmg 存在、命名 `Lark-0.1.0-arm64.dmg`；只读挂载后恰好一个 Lark.app；SHA-256 前后一致 | 脚本 |
| 2 | 对挂载内 app：codesign verify + `flags=0x2(adhoc)` + `Identifier=com.orpheusaviary.lark` | 脚本 |
| 3 | 对挂载内 app：workspace dist 真实目录、`better_sqlite3.node`、`Resources/{LICENSE, THIRD-PARTY-NOTICES.md}`；**NOTICE 覆盖检查**（生产依赖清单 vs 条目）；**bundled**：`Resources/ffmpeg` 齐全可执行 + configure 与锁值一致且无 nonfree + ★ **用 DMG 内取出的二进制跑真实闭环「小 M4A → MP3 → ffprobe JSON」**（stub 伪造不了）+ NOTICE 含 FFmpeg/LAME 段；**system**：断言无 `Resources/ffmpeg` + NOTICE 无 ffmpeg 段但共有段完整 | 脚本 |
| 4 | 挂载内 app × nest 副本冷启动：daemon 从 bundle spawn、`/status` 应答、capabilities 含 `media_tools`；**ready 子态**：正式打包 app 冷启动（bundled：`source=bundle`；system：真实 brew）；★ **missing/incompatible 子态**：由包内 `dist/testing/boot-child.js` 注入探测目录**预启动 daemon**，GUI 走 reuse 路径断言提示与 `MEDIA_TOOLS_UNAVAILABLE`（导入与下载都断言）——不给正式 CLI/daemon 加测试 env，不动用户真实 Homebrew 文件 | 脚本 |
| 5 | 对挂载内 app 复跑 accept-gui 核心判据（Range/206、CSP、token 不进 DOM、换 token 续播） | 脚本（CDP；M7-17 换驱动不换对象） |
| 6c | Electron ABI 下 `--help` exit 0；`status` 无 daemon → exit 4 + `DAEMON_UNAVAILABLE`；对在线 daemon → exit 0 | 脚本 |
| 7 | Electron ABI 下 `songs list --direct --json` → exit 3 且 `error_code === 'ABI_MISMATCH'` | 脚本 |
| 8 | 对**将要发布的同一 `.tgz`**：干净临时目录 `npm i -g` → `--version`/`--help`/双 bin 在 PATH | 脚本 |
| 9 | 版本一致性：6 manifest + 3 常量 == 发布版本；根 engines `>=24`；`LOCAL_API_VERSION == 4` | 脚本 |
| 10 | 打包态定位（不得跳过）：`LARK_APP_PATH=<挂载内 app 路径>` 下 `lark daemon`/`lark gui` 真实拉起；无效 `LARK_APP_PATH` 立即报错 | 脚本 |

驱动是实现细节、对象不可降级（M7-17）：`open` 不行 → 直接 spawn `<挂载内 app>/Contents/MacOS/Lark --remote-debugging-port` → AX/AppleScript → 守护端断言；禁退裸 Electron 跑 app 目录。

**归用户手动**：GUI 冷启动出声；Finder 拖装 + 右键打开；skill agent 可用性。

**发版（M7-19；每步用户确认）**：
1. 全绿门禁：`just check` → `just test` → `accept-gui` → `accept-m5` → `accept-cli`；
2. 代码完成 → 用户确认 commit → push；断言 clean tree，记录 HEAD；
3. 从该 HEAD 产固定 artifact：`just package <最终模式>` → `release/<mode>/Lark-0.1.0-arm64.dmg`；`just pack-cli` → 固定 `.tgz`；记录 dmg「签名后 SHA-256」与 tgz SHA-256；
4. `just accept-pack <mode> <dmg> <tgz>` 对固定文件全绿（DMG-only）；
5. npm scope 权限预检（`npm whoami` + org 读写）+ `npm publish --dry-run ./<tgz>`；
6. `git tag v0.1.0 <记录的 HEAD>` → push tag（公开 tag 不可变）；
7. draft Release：notes 按 mode 生成（system 版下载前写明 `brew install ffmpeg`）+ 上传同一 dmg + 两个 SHA；
8. 用户单独确认 → `npm publish ./<同一 tgz> --access public`；
9. draft 转正式。
**失败恢复**：同一 artifact 重试该步；内容需变 → 升 0.1.1 重走全部门禁；公开 tag 与已发 npm 版本永不重写/复用；draft 唯一可撤。

## 4. 任务分批

| 批 | 内容 | 产物 / gate |
|---|---|---|
| **T0 ffmpeg 供应链** | 前置 commit：事实源同步 → 首日 spike 来源定案 → 镜像 Release + `ffmpeg.lock.json`（逐库）+ `fetch-ffmpeg` → core 删 static 包 + resolver 四级（探测可注入）→ **MediaToolsRegistry 单一真相**（AppContext + 全消费方接线：engine/`ensureMp3`/`probeAudio`/import + single-flight + 执行失败失效 + 能力级 ready + `MEDIA_TOOLS_UNAVAILABLE` 两注册表覆盖导入与下载 + `LOCAL_API_VERSION` 4 + GUI 提示）→ **模式控制面**（`package [mode]` 位置参数 + `release/<mode>` 清理 + `package-fixture` 隔离 + 锁校验拒 stub）→ daemon-manager 注入 + 测试跟改 → dev/test 链 vendor-else-system | dev 链全绿（`just test` + accept-m5）；nonfree 门禁生效；registry 双真相消灭（capabilities 与引擎/导入同源） |
| **T1 GUI 打包链** | electron-builder 26.x 锁版 + config.mjs + `identity:'-'` 实测 + build-icons + resources 入库/.gitignore + justfile `package`/`package-fixture`/`unpackage`/`clean` | 真实 vendor 出 bundled 包（或 fixture 验机制）+ system 出包；判据 1–3 雏形 |
| **T3 CLI 发布物** | spike 三连 → 无 banner tsup + `dist-publish/` + probe 结构化原因 + direct ABI 预检 + gen-manifest + 契约测试 + 根 engines 修正 + README + `cli-smoke` 断言化 + `pack-cli` | spike 过；tgz 冒烟过；`ABI_MISMATCH` 信封可复现 |
| **T2 打包后定位** | resolver + `LaunchedChild` 扩字段 + gui.ts 条件化 + `LARK_MEDIA_TOOLS_DIR` 注入（CLI+GUI）+ ensure-daemon 分流 + 单测 | 判据 10 本机全过 |
| **T4 许可与文档** | LICENSE + **gen-notices 三段式**（全生产依赖聚合 + FFmpeg 附加段 + 覆盖检查）+ GUI 关于/许可 IPC 与设置页区块 + README（按模式）+ skill 注记 | 文档齐；覆盖检查过；关于页可见 |
| **T5 验收与发版** | accept-pack（**DMG-only** + 真实转码闭环 + boot-child 预启动子态）+ 用户手动三条 + 发版九步 | 全绿；v0.1.0 上线 |

依赖：T0 阻塞 T1/T4；T3 可与 T0 并行；T2 依赖 T1。顺序 **T0 → T3(spike) → T1 → T2 → T4 → T5**。

## 5. 决策表

| # | 决策 | 依据 |
|---|---|---|
| M7-1 | electron-builder 26.x 锁版；首选 `identity: '-'`；判据 2 断言；不达标回退 afterPack | E14 |
| M7-2 | workspace 依赖「路径 A」，`.npmrc` 不动 | 实证 |
| M7-3 | ffmpeg 走 T0 可再分发构建：vendor + 双校验 + extraResources + 目录级注入；core 删 static 包 | E1 + F1 |
| M7-4 | 图标源 `lark-logo.png` 入库；生成物 .gitignore | 素材 + E17 |
| M7-5 | tsup splitting 保边界；无 banner；`dist-publish/`；三连 gate；cli-smoke 断言化 | E2/E3/E7 + F9 |
| M7-6 | manifest deps = external 非 workspace 包；files 只带 LICENSE | E8 + F7 |
| M7-7 | 定位方案乙 + fail-fast；daemon 用 app 内 Electron；gui 用 `open <同一路径>` | 一轮 + E16 |
| M7-8 | LICENSE = MIT；进 dmg | 一轮 + E6 |
| M7-9 | ★ NOTICE 三段式：共有段 = **全部生产依赖许可聚合**（两模式必含）+ bundled 附加 FFmpeg/LAME 逐库段 + 覆盖检查防漂移；原始 SHA 只验到入包前；合规双落点（Release 页 + GUI 关于入口） | E1 + F2/F3 + **H4** |
| M7-10 | ABI 权威不变；`unpackage` 用 build-release | E12 |
| M7-11 | 发版可恢复状态机：tag/npm 版本不可变；同 artifact 重试；内容变升版；draft 唯一可撤 | E13 + F8 |
| M7-12 | 版本对齐 + 根/CLI engines `>=24` | E15 |
| M7-13 | CLI 加 `os/cpu` darwin/arm64 | 防误装 |
| M7-14 | direct 预检 → `ABI_MISMATCH`（断言 error_code）；probe 结构化原因 + 双态文案 | E4 + F6 |
| M7-15 | ensure-daemon 预检分流 | E5 |
| M7-16 | `bundled\|system` 一等模式：★ 控制面 = **just 位置参数**（`package [mode]` 默认 bundled、recipe 内校验 fail-fast——`mode=` 键值语法在 just 1.46.0 无效，实测）+ `release/<mode>` 分目录清理 + 门禁按模式解耦 + ★ fixture 隔离（`package-fixture` 独立 recipe → `release/fixture/`，正式 bundled 每次跑锁校验拒 stub）+ dev/test 链 vendor-else-system + resolver 四级与测试注入 | F1 + G1/G5/G6 + **H1/H6** |
| M7-17 | 实际打包产物自动化 = release gate：换驱动不换对象 | F4 |
| M7-18 | ★ **MediaToolsRegistry 单一真相**：boot 创建进 AppContext、missing/incompatible 非 boot failure、capabilities/引擎/导入/一切 ffprobe 共享、single-flight 重探（≥5s 节流）、执行失败使 ready 失效、`MEDIA_TOOLS_UNAVAILABLE` 覆盖导入与下载；ready = **完整能力清单**（demuxer/decoder/encoder/muxer/ffprobe JSON，非仅 libmp3lame）；★ 许可校验不适用于 system/env 来源（非本项目分发物）；`media_tools` 必填进 capabilities，`LOCAL_API_VERSION` 3→4；注入走 BootOptions/boot-child（M2 惯例） | G2 + **H2/H5** |
| M7-19 | 发布物绑定：clean tree 记录 HEAD → 固定 dmg+tgz → 验收固定文件 → tag 同一 HEAD → 上传同一 dmg → `npm publish ./同一tgz`；scope 预检前移；★ **DMG-only 验收**：判据 2–5/10 只对只读挂载的传入 DMG 内唯一 Lark.app 执行，禁读 release 目录，前后 SHA 复核 | G4 + **H3** |

## 6. 开放问题

1–3 已定案（MIT / CLI 不带 ffmpeg / app 查找乙 + fail-fast）。
4. npm scope 权限：发版第 5 步预检。
5. ffmpeg 来源甲/乙：T0 spike 内定；两案不顺 → system 模式发布（直接执行）。

## 7. 风险

| 风险 | 缓解 |
|---|---|
| T0 两案都不顺 | system 模式发布——控制面/门禁/notes/NOTICE 全链一等化，无 bundled 残留依赖 |
| tsup splitting 不保边界 | T3 spike gate + 两级后备 + 常驻判据 |
| `identity: '-'` 不达标 | 判据 2 断言；回退 afterPack |
| files glob 误伤 | 判据 3 逐项核对（DMG 内） |
| 打包 app CDP 驱动不通 | M7-17 换驱动不换对象 |
| npm publish 后缺文件 | 判据 8 同一 tgz + dry-run；出事升 0.1.1 |
| `LOCAL_API_VERSION` 4 兼容面 | 既有版本门禁覆盖；CLI 对 3 版 daemon 报 incompatible 属预期 |
| registry 改造牵连 M3 引擎/导入测试 | T0 一体跟改 + vendor-else-system 解耦，全量复跑 |
| NOTICE 覆盖检查误报（依赖树噪声） | 以生产依赖清单为准（devDeps 排除）；白名单机制留给实施，例外必须写理由 |
| fixture 混入正式产物 | `release/fixture/` 独立目录 + 正式 bundled 锁校验拒 stub + 真实转码闭环兜底 |

## 8. 实施记录

（逐批填写；T0/T3/T5 首日 spike 结论必须落此。）

## 9. 评审记录

**一轮（2026-08-08）**：LICENSE=MIT、CLI 体积方案 A（后被 E1 取代）、app 查找乙、图标源；`open` 用具体路径保同副本。

**二轮（2026-08-08，E1–E17）**：E1 ffmpeg 不可再分发（双实证）→ T0；E2 双 shebang；E3 gate 只读命令/status exit 4；E4 ABI 判据无实现；E5 预检探错副本；E6 extraResources 相对路径 + dmg 补 LICENSE；E7 `dist-publish/`；E8 manifest 排除 workspace；E9 exitCode/signal；E10 判据 10 不跳过；E11 ABI 阶段顺序；E12 unpackage；E13 发版可追溯；E14 `identity:'-'`；E15 engines/os/cpu；E16 `LARK_APP_PATH` fail-fast；E17 resources/.gitignore。

**三轮（2026-08-10）**：用户接受保底（后升格一等模式）。

**四轮（2026-08-10，F1–F9）**：F1 保底不可执行 → 一等模式 + homebrew 探测（LS PATH 实证空）+ 错误面；F2 签名后 SHA；F3 LGPL 逐库 + GUI 关于入口；F4 验收不得降级；F5 profile 能力清单；F6 probe 文案；F7 npm NOTICE 拆分；F8 tag 不可变 + 事实源同步前移；F9 cli-smoke 断言化。

**五轮（2026-08-10，G1–G7）**：G1 模式控制面 + 分目录 + 门禁解耦；G2 `media_tools` 线协议 + 错误码 + 版本升级；G3 NOTICE staging + About IPC；G4 发布物绑定 HEAD/固定 artifact；G5 system 子态测试注入；G6 目录级注入信号 + 完整性判定；G7 notes 按模式。

**六轮（2026-08-10，H1–H6，定稿轮）**：
- H1 [P1] `just package mode=system` 语法无效（just 1.46.0 实测把 `mode=system` 当第二个 recipe；变量赋值必须在 recipe 名之前）→ 全部改**位置参数**：`just package [bundled|system]`、`just accept-pack <mode> <dmg> <tgz>`
- H2 [P1] media_tools 探测与执行「双真相」（boot.ts:334 在 fatal try 内一次性解析；ensureMp3/probeAudio 每次重解析；import.ts:88 独立调 ffprobe 且降级错误；BootOptions 只经 boot-child 可达）→ M7-18 重构为 **MediaToolsRegistry** 进程级单一真相：boot 创建进 AppContext、missing 非 boot failure、全消费方共享、single-flight、执行失败失效 ready、`MEDIA_TOOLS_UNAVAILABLE` 覆盖导入；判据 4 的 missing/incompatible 子态用包内 boot-child 预启动 + GUI reuse 路径
- H3 [P1] 判据 10 允许「或 release 目录 app」形成后门 → **DMG-only 铁律**：只读挂载传入 DMG、断言唯一 Lark.app、判据 2–5/10 全用它、禁读 release 目录、前后 SHA 复核
- H4 [P1] NOTICE 只覆盖 FFmpeg，漏 renderer 打进去的 JS 依赖（实查 out/renderer 无 @license 文本；`!**/*.md` 排掉 tailwind-merge/sonner 的 LICENSE.md）→ gen-notices 三段式：共有段 = 全生产依赖聚合（两模式必含）+ bundled 附加段 + 覆盖检查防新增依赖漏更新
- H5 [P1] ready 判据弱于冻结能力清单（stub 伪造几行输出即可全绿）→ runtime probe 核对完整能力清单；accept-pack 用 DMG 内二进制跑真实「M4A → MP3 → ffprobe JSON」闭环；★ nonfree 校验只管 vendor 获取与 bundled 分发物，system/env 来源只做功能兼容（不无端拒绝用户自装构建）
- H6 [P2] fixture 与正式 bundled 无隔离 → `package-fixture` 独立 recipe → `release/fixture/`；正式 bundled 每次跑 `fetch-ffmpeg` 锁校验（stub 过不了）；发版永不从 fixture 目录取
