# lark 开发规范

## 项目概述

lark 是百灵音乐播放器的 TypeScript 重写版。从零设计，可参考 `../lark-go/` 的既有实现作为功能映射基线，但不复制架构。技术栈与 owl 对齐。

## 状态

🚀 **桌面 v0.3.0 已发布**（2026-08-17，tag `9cf9d97`）—— [Release](https://github.com/orpheus-aviary/lark/releases/tag/v0.3.0)（`Lark-0.3.0-arm64.dmg`）+ [`@orpheus-aviary/lark-cli@0.3.0`](https://www.npmjs.com/package/@orpheus-aviary/lark-cli)。发版时测试 **2419**，e2e 19 + accept 系列全绿。

- canonical 音频 = `songs/<id>/song.m4a`，`/audio` 回 `audio/mp4`；**schema v3**；协议 `LOCAL_API_VERSION = 6`（**以 `packages/shared/src/api-paths.ts` 为准**）。
- **schema v3 与 mp3→m4a 都是单向的**：0.3 开过的库，0.2.x 不再打开，音频也回不去。
- 历史里程碑（M0–M7 = v0.1.0 / T0–T6 = v0.2.0 / T0a–T6 = v0.3.0）的批次、判据与决策见 `PROCESS.md` 与 `docs/plans/`。

🛠 **Phase B（Android，`apps/mobile`）开发中**——主计划 `docs/plans/2026-08-13-m4a-and-mobile-master-plan.md` §4 + 各批子计划。批次 N0a → N0b → N1 → N2 → … → N6。

- **N0b–N3 已完成**，逐批经过、判据与决策在 `PROCESS.md` 的 Phase B 段与各子计划（`docs/plans/` 下的 `…-n0.md` / `-n1.md` / `-n2.md` / `-n3.md`）。**仍然约束新代码的四条**：
  - **N1 的 D5 分段冻结**（core 的整个业务图进 `@lark/core/portable`，Metro 图 97 个模块，bundle smoke 在 `just check` 里）——**冻结文本在 N1 子计划 §8.1，那是单一事实源**。**N1 判据 22 仍欠着**：对新构建的 dmg/tgz 复跑 accept 全系列，按用户决定并入下个桌面版本的发版流程。
  - **N2 §2.2 冻结了启动序列**：零写预检（含兼容性）→ 写 SecureStore intent → 读写打开 → 收敛 → `ensureDeviceUuid` → 提交 intent → boot drain → 服务。**每进程只跑一次**（`bootOnce`——Activity 重建后再开同一个库会崩，见 LESSONS）。**文件写一律原子替换**（决策 a，expo-file-system 57 在 Android 上两条路都堵着）。
  - **N3 的两条产品形状**：**锁屏/车机的「上一首/下一首」在 expo-audio 57.0.3 上不存在**（`AudioMediaSessionCallback` 显式 remove 掉四个曲目导航命令，换 `AudioPlaylist` 也救不了）→ v1 收窄成播放/暂停/seek，逃生口定价在 N3 子计划 §1.9 · **队列是起播那一刻的快照**（决策 o，与桌面「队列 = 当前视图」分叉，如实记着）。
  - **三条已按用户决定不做/搁置，别当成待办**：N2 判据 14 的拖柄重排（不做）· N2 判据 16b 的 D2D 手机搬家（搁置）· N3 判据 20（搁置）。
- **蓝牙歌词只做 Android，桌面整个不做**（2026-08-19 用户决定，主计划 §4.5 有修订段）：复用 AVRCP 的 TITLE 字段。判定在 `@lark/shared/now-playing.ts`（纯函数，四种输入回歌名 + 64 code point 上限），开关在 `local_metadata.now_playing_mode`（缺行或非法值一律读 `'title'`、**读路径不写库**），接线在 `apps/mobile/src/player/now-playing.ts`（去重看返回值 + 节流 500ms + `mode` 每首重读一次；**关开关绕过节流强发一次**，暂停的播放器没有 tick）。**没有接收端，所以「会不会延迟 2 秒」测不了**——只知道那个 queue 陷阱的前提条件成立。
- **N4 下载：N4a–N4e 已完成，下一步 N4f 收藏夹/合集批量**（全期子计划 `docs/plans/2026-08-20-phase-b-mobile-n4.md` v2，七批 N4a–N4g / 判据 40 条）。用户 2026-08-20 拍板四条范围：**TLS 移出 N4**（不阻塞 N4 任何子批，**硬阻塞 N5**——主计划 §4.3 有 Stage-3 修订）· **LLM 设置页进 N4** · **收藏夹/合集批量进 N4** · **加 dataSync 前台服务**。
  - **N4a**（纯桌面）preflight / AudioLanding 契约 / 缓存运行时三处提取 · **N4b** 移动 AudioLanding 七步 + 引擎装配 + 进程级 hub（判据 5–14）· **N4c** dataSync 前台服务 + `arm()`/`settle()` 状态机（判据 15–19 + 41–43，子计划 `docs/plans/2026-08-21-phase-b-mobile-n4c.md`）· **N4d** 添加页 + 任务列表 + 分享 intent（判据 20–25 + 44–45，子计划 `docs/plans/2026-08-21-phase-b-mobile-n4d.md`）。逐批经过与证据在 `PROCESS.md`。
  - **两条已答的大问号**：🟢 **音频流两张网都是 https**（5G `…mcdn.bilivideo.cn:8082` / Wi-Fi `cn-bj-cc-03-03.bilivideo.com`）——不碰 `usesCleartextTraffic`；🟢 **MMR 与 ffprobe 逐毫秒一致**（Δ0.000 / Δ0.001s）。
  - 🔴 **改移动端代码前必读的五条**（详见 `docs/LESSONS.md`）：**自建 Expo 模块少 `android/build.gradle` → autolink 静默跳过 → 启动即闪退**（守卫已进 `just check`）· **MMR 读得出时长 ≠ 文件完整**（fMP4 的 `moov` 在头部，落盘因此加了 ③b 完整性检查）· **Expo `AsyncFunction` 的最后一个表达式就是返回值**，转不了的类型在副作用之后才 reject · **后台的 `startForegroundService()` 既不抛也不起、被延后到回前台**（所以 `arm()` 必须在手势那一刻，且 `start()` resolve ≠ 服务在，`START_CONFIRM_MS` 回头确认）· **想在后台那一刻做事只能用 `AppState` 回调，JS 定时器是冻的**。
  - 🔴 **N4d 的三条形状**：**分享/复制过来的是「标题 + 短链」一整行**（`EXTRA_TITLE` 为空，真机复现），整行读作自由文本 → 撞 keyword 门，所以 `downloads/preflight.ts` 有 `findSource` 从一行里挑出链接（只在整行读作 keyword 时启动，候选原样过 `parseSongInput`）· **分享的消费点必须在根层**（`App`，在 boot 状态之上；添加 tab 是条件挂载的，冷启动收不到），草稿是**内存单例、消费即清** · **`engine.snapshot()` 是插入序（最旧在前）**，任何「最近 N 条」都要自己按 `finished_at` 排（`downloads/rows.ts`）。
  - **N4e 的四条实测**（2026-08-23 真机，判据 24 · 26 · 27 · 28 · 29 · 30①③ 全绿；30② 按用户决定不跑）：🔴 **`AbortSignal.prototype.throwIfAborted` 在这个 RN 运行时不存在**，而 `any`/`timeout` 两个静态方法存在——它唯一的调用点在**清洗命名的降级处理器**里，于是任何模型失败都炸成 INTERNAL_ERROR（已修，`portable/download/timeouts.ts`）· 🔴 **两条静默降级**（`llmJson` 解析失败 / 请求失败）现在都写日志——「清洗降级了」与「你没切模式」在屏幕上一模一样 · 🔴 **手机上 engine 原本是 `NOOP_LOGGER`**，「详情见日志」指向不存在的日志且 release 到不了 logcat ⇒ 现在 `downloads/log.ts` 是那个日志、设置页读它（**带原始错误也就带泄漏面，脱敏仍未做**）· **关键词提交路径当时根本没接**（配了模型后 `preflightSingle` 返回 target 而不抛错，`recognise` 把「没抛错」当成拒绝）。
  - 🔑 **测试规模已简化（用户 2026-08-23 定，子计划 §8.5 是正文）**：**默认落单测**，只有设备能回答的才上机（原生模块 · Android 策略 · 真网络 · 真机数值）· **反测全部搬进单测**（设备上「改→建→验红→还原→再建」取消）· 一个里程碑最多上机一次 · 不做预测性桌面探针 · 判据标注归属而不是默认都要真机证据。代价：失去设备侧「破了会红」的证据。
  - 🔒 **N4e 的渠道冻结（用户 2026-08-23 决定）**：**移动端的 LLM 配置只有「设置页里手填、存这台设备」这一个来源**——没有 aviary 共享配置的回退（所以 `api_format` 的 `''` 不进手机的值域）· 不从桌面导入 · 不进同步 · 不内置默认端点或 key。
- 数值判据一律 **release 构建** + 冻结设备 vivo V2408A。逐批状态见 `PROCESS.md` 的 Phase B 段。

**mobile / spike 的四条常驻规矩**：① **bundle** 只许 import `@lark/core/portable` / `@lark/shared` / skybridge SDK（守卫 `check-mobile-imports.sh` + Metro bundle smoke，两者的作用域自 N2a 起是 spike + `apps/mobile` 两处），**禁止复制 core 实现来假装验证 core**——需要 core 算的输入一律由桌面产 fixture；**唯一豁免是 `spikes/mobile-foundation/scripts/*.mjs`**（主机脚本，不在 Metro 图里，产 fixture 时必须用真 core）。② **Expo 已进桌面 workspace，每次 `pnpm install` 变动后必须复跑 `just check` + `just test`**。**短命夹具不进 bundle**：bilibili 流 URL 两小时过期、skybridge 账号每次新建，由 `probe-host.mjs` 的 `/fixtures/network` 现供。③ **真机测试默认由用户跑**（2026-08-19 定）：我只负责 `just mobile-android-release`（adb 直接装到机器上），然后把「看什么」讲清楚——用户手测比脚本驱动快得多。**我自己驱动手机只在两种情况**：需要抓内容（logcat / dumpsys / 截屏比对），或者判据要求一段精确的流程（崩溃点、force-stop 时机、成组的顺序断言）。真要长跑，**开跑前说一声、跑完说一声**——用户以为跑完了就去动手机，症状会长得像应用 bug（`not in front` / 找不到屏幕上明明有的标签）。④ **改 Expo 模块的原生代码，光 `pnpm patch` 没用**：SDK 57 的模块在 `expo-module.config.json` 里带 `publication`，Android 侧消费的是包内**预编译 AAR**，源码不参与构建——补丁装上了、`.kt` 真的变了、BUILD SUCCESSFUL（8 秒）、设备上零变化。要在 `apps/mobile/package.json` 加 `expo.autolinking.buildFromSource`（目前只有 `expo-audio`，见 `patches/expo-audio@57.0.3.patch`）。**驱动脚本还有三条边界**：`drive.mjs` 读 `content-desc`（图标按钮才点得动）· **播放中 `uiautomator dump` 会失败**（走着的秒数让窗口永不 idle），先暂停或改用坐标 · 🔴 **键盘弹起时 `input tap` 打在输入法窗口上，而 `uiautomator dump` 只报应用自己的坐标**——底部 tab 栏的 bounds 看着一切正常却点不中，`keyevent 4` 也收不掉输入法（RN 的 `TextInput` 还握着焦点）。点之前先 `dumpsys input_method | grep mInputShown`；**`input text` 不受影响**，所以「让用户收键盘、我来打字」是最省的分工。

### 🚨 曲库安全（每次动库前读）

- **开发版碰到旧库就会单向升级（v2 → v3 时还会当场转换音频）**：任何 `createDatabase`——dev daemon、`--direct` 写、跑测试时指错 `LARK_NEST_DIR`——碰到旧库都会当场升级并置 `audio_migration_pending`；随后 dev daemon 一起来就把 mp3 转成 m4a。**旧版本从此拒绝打开它**（`user_version > LATEST`），音频也回不去。开发期一律 `just backup-nest <目录>` + `LARK_NEST_DIR` 用副本。
- **验副本的可靠做法**：先自己带 `LARK_NEST_DIR` 起 daemon、用 `/api/instance` 核对 `nest_dir`，再开 GUI——GUI 认领时会比对 nest，环境变量没生效就**弹框中止**（不 spawn、不碰真库），这比「开了之后再看」早一步。
- ✅ 本机真实曲库已经在 v3（2026-08-18 复验：7 个 `song.m4a`、`migration-backup/` 已建且为空、`/Applications/Lark.app` = 0.3.0）。**「只碰副本」这条不变**：dev 版的 schema 只会更靠前。
- ⚠️ **曲库内容 2026-08-13 变过**：现为 **7 首全 `downloaded` / 1 个歌单 / 0 首 imported**。**验收夹具一律自造**：`accept-m5` 与 `accept-sync` 都因为借用户的库而红过（见 `PROCESS.md` 的 T6a）。

**每个里程碑先出子计划**（`docs/plans/<日期>-<里程碑>.md`）经用户过目再动手，实现按任务分批、每批提交前给用户看 commit 信息。

## 技术栈

- **语言**：TypeScript (ESM)
- **桌面**：Electron + electron-vite
- **后端 daemon**：Fastify + better-sqlite3 + drizzle-orm
- **前端**：React + shadcn/ui + Tailwind v4 + zustand
- **移动**：Expo SDK 57 + CNG（Android only，N2 起）；UI 是 RN 原生控件 + `lucide-react-native`（图标与桌面同一套），**没有 zustand、没有 router、没有手势栈**
- **CLI**：commander
- **包管理**：pnpm ／ **Lint**：Biome ／ **测试**：vitest

## 仓库结构

```
lark/
├── packages/
│   ├── shared/     # @lark/shared — Node-free 线协议（类型、HTTP client、SSE、api-paths、lrc、
│   │               #   song-sort 比较器、now-playing 判定函数、play-queue 的 decideNext、
│   │               #   operation-queue 的串行/generation、download-labels 三张中文枚举表）
│   ├── core/       # @lark/core — 业务逻辑。N1 之后**桌面专有的只剩**：db/ 的打开与锁、
│   │               #   ffmpeg 与落盘协议（download/{audio-landing,ffmpeg,resolve,import}）、
│   │               #   file-op 执行器、config、logger、paths 根解析、media-tools、migration
│   │   └── src/portable/  # @lark/core/portable — 一台手机能解析的**整个业务图**（N1 出口）：
│   │                      #   schema / migrations / migrate / schema-signature / pending /
│   │                      #   db-identity（ensureDeviceUuid，N2b 下沉）/
│   │                      #   now-playing-mode（蓝牙歌词开关，N2g）/ play-mode（N3b）/
│   │                      #   last-playback（进度记忆，N3f）/ naming-mode（命名模式记忆，N4d）/
│   │                      #   open-library（移动端打开分派 classifyLibrary+prepareLibrary）/
│   │                      #   errors / logger 型 / SqliteLike / PortableDb /
│   │                      #   ports/（fs·paths·song-files·credentials·events·device·audio-landing）/
│   │                      #   runtime/（random·digest·text·base64）/ sync 全图 /
│   │                      #   library 全图 / coordinator/（SyncCoordinator）/
│   │                      #   services/（LibraryService + LibraryContract）/
│   │                      #   download/（client 层 + engine·batches·pipeline 编排）
│   ├── daemon/     # @lark/daemon — Fastify server + `lark daemon` 入口
│   └── gui/        # @lark/gui — Electron main/preload/renderer
├── apps/
│   ├── cli/        # @lark/cli — 对外 CLI（发布为 @orpheus-aviary/lark-cli，bin `lark` / `lark-cli`）
│   └── mobile/     # @lark/mobile — Android（N2 起）：boot/ 冻结启动序列 · identity/ D16 ·
│                    #   db/ · ports/ · services/ · player/（driver·store·queue·session·now-playing，N3a–f）·
│                    #   ui/ 四 tab（含 add-tab 添加页 + task-list 任务列表，N4d）+
│                    #     minibar/全屏页/队列面板 · acceptance/（仅验收 bundle 可达）
│                    #   modules/lark-fs 自建原生模块（原子替换 + 外部夹具目录）
│                    #   modules/lark-audio 自建原生模块（ACTION_AUDIO_BECOMING_NOISY，N3e）
│                    #   modules/lark-media 自建原生模块（MediaMetadataRetriever 时长，N4b）
│                    #   modules/lark-transfer 自建原生模块（dataSync 前台服务，N4c）
│                    #   downloads/（engine 装配 · hub 进程级 store + useDownloads hook ·
│                    #     foreground 状态机 · cancel 三种结果 · preflight 移动薄壳 · rows 排序）
│                    #   share/（intent 根层 hook + draft 内存单例，N4d-3）
│                    #   patches/expo-audio 打开 API 33+ 的通知 action（见 LESSONS）
├── spikes/
│   ├── media-protocol/    # lark-media:// 验证工程，长期保留作 M4 移植参照
│   └── mobile-foundation/ # Phase B 平台 spike + 真机驱动设施（drive.mjs / probe-host.mjs）
├── scripts/        # 依赖方向守卫（rg 源码，不查 package.json）
└── docs/
```

依赖方向：`shared ← core ← daemon ← gui`；`cli → shared` + `core`（静态只碰零原生子路径 `paths` / `config` / `daemon-control` / `native-probe`，barrel 只在 `--direct` 分支 dynamic import）。**`core/portable` 是 core 内部的一层**：桌面专有的那半（`db/` · `download/{audio-landing,ffmpeg,resolve,import}` · `sync/file-ops-runtime` · `config/` · `logger/` · `paths.ts` · `media-tools/` · `migration/`）反向 import 它，它不许 import 任何 core（移动端只链这一块——`@lark/core/portable`，**CLI 不需要它，守卫的放行清单里也不加**）。

**八条守卫**进 `just check`：core 禁 daemon/gui/electron、**core/portable 禁一切宿主**（Node builtin 裸名与 `node:` 前缀 · better-sqlite3 含 type import · `drizzle-orm/better-sqlite3`（`sqlite-core` 放行）· pino/smol-toml/electron · `@lark/core` 自引含子路径 · **按深度计数**的 `../` 越界）、daemon 禁 gui/electron、shared 禁一切 Node builtin、cli 禁 daemon/gui/electron **且禁静态 import core barrel**、**spike/mobile 只许 import portable/shared/skybridge SDK**（`check-mobile-imports.sh`，只约束 `@lark/*` 与 `@orpheus-aviary/*`）、**Metro bundle smoke**（`scripts/check-portable-bundles.mjs`——读 Metro 真建出来的模块图，答 rg 守卫答不了的三件事；**探针必须放在 barrel 够得到的文件里**，孤立文件不在图里、塞什么都是绿的）、**自建原生模块的接线**（`check-mobile-native-modules.sh`，N4b 加：config 声明的类要有 `.kt`、要有 `android/build.gradle`、要有 `index.ts`——**少 build.gradle 会让 autolink 静默跳过、启动即闪退，而 tsc/biome/bundle smoke 全照不到**）。**后两条自 N2a 起各管两处**（`spikes/mobile-foundation` + `apps/mobile`）：smoke 建**两个 bundle**，因为 `disableHierarchicalLookup` 下一边声明的依赖另一边解不开，一边绿证明不了另一边；判据 7 的「`core/migration/` 不许进图」排在通用 escapee 规则**之前**，否则它是不可达的死代码。另加 `just mobile-typecheck`（`apps/mobile` 不在根 `tsc -b` 里，不进 check 就等于没类型检查）。

**已决定**（主计划 §1）：不抽 `@orpheus-aviary/daemon-kit`，v0.1 直接复制 owl 模式，出现明显重复再重构。

## 注意事项

- **daemon 统一入口**：CLI 和 GUI 都通过 daemon HTTP API（默认端口 **47100**，端口段 `471xx` 归 lark）；daemon 存活时 CLI **一律禁止 `--direct` 写**（无 `--force`，R31）
- **跨进程写互斥**（M6 T0）：daemon / `--direct` 写 / backup-nest 三方共守 `songs.db.writer.lock`（常驻 SQLite 锁库，`BEGIN EXCLUSIVE`，kill -9 自动释放，**锁文件永不删**）；锁序冻结 **writer → migrate → 真库 EXCLUSIVE**；读路径不取任何锁（只读打开、零写入）
- **数据目录**：`~/orpheus-aviary-nest/lark/`
- **统一响应格式**：`{"success": bool, "data": {}, "message": "..."}`；例外：`/audio`（二进制 + Range）、`/lyrics`（text/plain）、`/events`（SSE）
- **token**：由 daemon 生成并原子发布 0600 文件；GUI 侧每次读取，不进 URL/DOM/日志/媒体 src（R21/R29）
- **skybridge 同步**（v0.2，schema v2 起）：实体 `device_id` 只存 skybridge 注册 ID（本地身份在 `local_metadata.device_uuid`，两域不混用）；凭证在**独立文件** `~/orpheus-aviary-nest/lark/skybridge.toml`（0600，不进 `/config` 通道，**backup 每一层都排除**）
- **媒体文件**：歌曲本体不同步、不走 attachment——各设备凭 `source_key`（bilibili = `bvid:cid`）按需下载；歌词文件永不参与缓存清理
- **缓存清理不变量**：只清理 `file_origin='downloaded'` 且清理前探活确认可重下的文件；imported（含 Go 迁移曲库）是用户资产，永不自动清理（R1/R26）

## Commit 规范

遵循上级 `orpheus-aviary/.claude/CLAUDE.md` 的 Conventional Commits。

Scope：`shared` / `core` / `daemon` / `gui` / `cli` / `mobile` / `player` / `download` / `lyrics` / `search` / `library` / `settings` / `cache` / `link` / `skybridge` / `db` / `config` / `repo`（仓库级杂项：justfile / lockfile / README / PROCESS 等）/ `plan`（`docs/plans/` 计划文档）

## 关键参考

- **🔧 实测锁定（改动对应模块前必读）**：`docs/LESSONS.md` —— M0–M7 / v0.2 / v0.2.1 / v0.3.0 / Phase B 全部踩坑记录，按时间分段
- **进度**：`PROCESS.md`（逐批实施记录、判断与决策记录）
- **本仓设计**：`docs/DESIGN.md`
- **计划文档**（`docs/plans/`）：
  - 主计划 `2026-07-16-ts-rewrite-master-plan.md`
  - Phase A/B 主计划 `2026-08-13-m4a-and-mobile-master-plan.md`（§3 迁移状态机 / §4 移动版 / §4.3 里程碑表与 Stage 修订 / §4.5 明确不做）
  - Phase B：`2026-08-17-phase-b-mobile-n0.md`（N0 详案 + 全期框架 + §3.2a 测量协议 + §9 设备档案）· `2026-08-18-phase-b-mobile-n1.md`（**§8.1 D5 冻结 = 单一事实源**）· `2026-08-19-phase-b-mobile-n2.md`（**N2，v3 + §5 决策全关**）· `2026-08-20-phase-b-mobile-n3.md` · `2026-08-20-phase-b-mobile-n4.md`（**N4 全期**）· `2026-08-21-phase-b-mobile-n4c.md`（**N4c 已完成**，§8 实施修订 + §9 真机对照表；判据 15 已按实测改写，新增三条编号 41–43）· `2026-08-21-phase-b-mobile-n4d.md`（**N4d 已完成**，§5 定案 + §8 三段实施修订）· `2026-08-23-phase-b-mobile-n4e.md`（**N4e 已完成**；**§0 渠道冻结：手机的 LLM 只能在设置页本地填** · **§8 实施修订，§8.5 是新的测试规模**）
  - v0.3：`2026-08-13-m4a-unification.md`（判据 1–61 / 决策 a–n / **§9 附表 A 错误分型映射表**）
  - v0.2：`2026-08-11-v0.2-skybridge-sync.md`（§3 协议冻结 / §5 不变量 ㉑–㉚ / §8 决策 D1–D8）· soak 清单 `2026-08-12-v0.2-soak-checklist.md`
  - v0.1：`2026-07-31-m0-…` / `2026-07-31-m1-…` / `2026-08-04-m2-…` / `2026-08-04-m3-…` / `2026-08-05-m4-…` / `2026-08-06-m5-…`（+ followup）/ `2026-08-07-m6-cli.md` / `2026-08-08-m7-packaging.md`
- **常用命令**：`justfile` —— `just check` / `just test` / `just dev-daemon` / `just cli <args>`（= 对外的 `lark`）/ `just accept-gui`（15 条）/ `just accept-m5`（22 条，跑真实 bilibili）/ `just accept-cli`（27 条，驱动真实二进制）/ `just test-sync-e2e`（两套 e2e）/ `just accept-sync`（34 条，真 server + 两台 daemon + 真 GUI）/ `just fetch-ffmpeg`（自建 vendor ffmpeg + 门禁）/ `just package [bundled|system]` / `just pack-cli` / `just accept-pack <mode> <dmg> <tgz>`（28 条）/ `just backup-nest <目录>` / `just mobile-*`（`mobile-typecheck` / `mobile-bundle-smoke` / `mobile-prebuild` / `mobile-android[-release]` / `mobile-acceptance-release` / `mobile-acceptance-smoke` / `mobile-drive` / `mobile-backup-audit` / `mobile-push-fixture <nest>` / **`mobile-push-audio-fixtures`**（N4b：两条探针曲目 + 主机 ffprobe 真值）/ `mobile-accept-library <nest>`（26 条，驱动生产 UI，排序与主机对照）/ `mobile-fs-instrumentation`）/ `just spike-media-*` / `just spike-mobile-*`
- **Go 版（功能参照）**：`../lark-go/`
- **跨仓**：`../aviary/docs/DESIGN.md`、`../aviary/docs/ROADMAP.md`、`../aviary/docs/SKYBRIDGE_ARCH.md`
