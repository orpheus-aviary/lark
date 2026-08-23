# lark 开发规范

## 项目概述

lark 是百灵音乐播放器的 TypeScript 重写版。从零设计，可参考 `../lark-go/` 的既有实现作为功能映射基线，但不复制架构。技术栈与 owl 对齐。

## 状态

🚀 **桌面 v0.3.0 已发布**（2026-08-17，tag `9cf9d97`）—— [Release](https://github.com/orpheus-aviary/lark/releases/tag/v0.3.0)（`Lark-0.3.0-arm64.dmg`）+ [`@orpheus-aviary/lark-cli@0.3.0`](https://www.npmjs.com/package/@orpheus-aviary/lark-cli)。发版时测试 **2419**，e2e 19 + accept 系列全绿。

- canonical 音频 = `songs/<id>/song.m4a`，`/audio` 回 `audio/mp4`；**schema v3**；协议 `LOCAL_API_VERSION = 6`（**以 `packages/shared/src/api-paths.ts` 为准**）。
- **schema v3 与 mp3→m4a 都是单向的**：0.3 开过的库，0.2.x 不再打开，音频也回不去。
- 历史里程碑（M0–M7 = v0.1.0 / T0–T6 = v0.2.0 / T0a–T6 = v0.3.0）的批次、判据与决策见 `PROCESS.md` 与 `docs/plans/`。

🛠 **Phase B（Android，`apps/mobile`）开发中**——主计划 `docs/plans/2026-08-13-m4a-and-mobile-master-plan.md` §4 + 各批子计划。批次 N0a → N0b → N1 → N2 → … → N6。

- **N0b = GO**（2026-08-18）：D4 / D14 / D16 / D17 全部落定，冻结文本在主计划 §4.3 的 Stage-2 修订段。
- **N1 已全部完成**（2026-08-19，子计划 `docs/plans/2026-08-18-phase-b-mobile-n1.md`，九批 N1a–N1i）：core 的**整个业务图**进了 `@lark/core/portable`——sync 全图、library 全图、SyncCoordinator、LibraryService（+ 跨前端 LibraryContract）、download client 层与编排。Metro 图 **97 个 portable 模块**，bundle smoke 已进 `just check`。**R1–R5 真机全绿 → D5 分段冻结，冻结文本见 N1 子计划 §8.1（单一事实源）**。桌面测试 **2578**。
  - **唯一未做的是判据 22**：对新构建的 dmg/tgz 复跑 accept 全系列——按用户决定并入下个桌面版本的发版流程。
- **N2 已全部完成**（2026-08-20，七批 N2a–N2g，判据 1–21 全过；**判据 14 的「拖柄重排」已按用户决定不做**，见子计划 §8.3；**判据 16b = D2D 手机搬家已搁置**，见子计划 §8.2；**§8.4 记了判据 20 的 ②③ 落地成同一个守卫**）——子计划 `docs/plans/2026-08-19-phase-b-mobile-n2.md`（**v3，两轮评审收敛**，七批 N2a–N2g / 判据 22 条 / **决策 a–o 已于 2026-08-19 全部关闭，§5 是定案**，§8 有修订对照）。四条要点：**决策 a = 原子替换**（expo-file-system 57 在 Android 上两条路都堵着）· **`ensureDeviceUuid` 要下沉进 portable**（今天是桌面专有的，缺它移动端一切业务写入抛错）· **删除的文件半推不掉**（`deleteSong` 无条件 drain）→ file-op 执行器提前进 N2 且控制面从桌面提取 · **§2.2 冻结了启动序列**：零写预检（含兼容性）→ 写 SecureStore intent → 读写打开 → 收敛 → `ensureDeviceUuid` → 提交 intent → boot drain → 服务。
- **N3 已完成**（2026-08-20，子计划 `docs/plans/2026-08-20-phase-b-mobile-n3.md`，六批 N3a–N3f / 判据 25 条 / 决策 a–p 全关，§8.1 有 17 条实施修订）：**判据 1–19 + 21–25 全过**（**18 与 21 只记录不判定**、**20 已按用户决定搁置**）。手机上已经是一个完整的播放器——minibar + 全屏歌词页（含 offset ±）+ 队列面板 + 四种播放模式 + 蓝牙歌词 + 拔耳机暂停 + 进度记忆。桌面测试 **2729**。**下一步 N4 下载**。三条要点：**锁屏/车机的「上一首/下一首」在 expo-audio 57.0.3 上不存在**（`AudioMediaSessionCallback` 显式 remove 掉四个曲目导航命令，两个 session 注册点同一个 callback，换 `AudioPlaylist` 也救不了）→ **v1 收窄成播放/暂停/seek**，逃生口定价在 §1.9 · **队列是起播那一刻的快照**（决策 o，与桌面「队列 = 当前视图」分叉，如实记着）· **耐久留给打包后的真实使用**（决策 k，N3 只到 ≥5 分钟后台）。
- **蓝牙歌词进 v1，只做 Android**（2026-08-19 用户决定）：复用 AVRCP 的 TITLE 字段；**判定函数与 config 字段已随 N2g 落地**——`nowPlayingTitle`（`@lark/shared/now-playing.ts`，纯函数，四种输入回歌名 + 64 code point 上限）与 `local_metadata.now_playing_mode`（`@lark/core/portable/now-playing-mode.ts`，缺行或非法值一律读 `'title'` 且**读路径不写库**）；**接线、开关与节流已随 N3d 落地**（`apps/mobile/src/player/now-playing.ts`：去重看返回值 + 节流 500ms + `mode` 每首重读一次；关开关**绕过节流**强发一次，因为暂停的播放器没有 tick），**桌面整个不做**。见主计划 §4.5 的修订段。**判据 18 的 queue 陷阱前提条件实测成立**（`queueTitle=null, size=1` + `MediaItem.fromUri` 不带 title → queue item 的 title 永远对不上我们写的歌词），**有没有真的延迟 2 秒没有接收端测不了**。
- **N4 下载：N4a–N4c + N4d-1/2 已完成**（判据 20·21·23·25 真机全绿；**24 无法在无模型的构建上验，推到 N4e**），**下一步 N4d-3 分享 intent**（子计划 `docs/plans/2026-08-20-phase-b-mobile-n4.md` v2，七批 N4a–N4g / 判据 40 条）。用户 2026-08-20 拍板四条范围：**TLS 移出 N4**（不阻塞 N4 任何子批，**硬阻塞 N5**——主计划 §4.3 有 Stage-3 修订）· **LLM 设置页进 N4** · **收藏夹/合集批量进 N4** · **加 dataSync 前台服务**。
  - **N4a ✅**（纯桌面）：preflight 提取进 portable（短链 400 口径先补 characterization 再迁就）· AudioLanding 签名冻结 + `describeAudioRequest` · **AudioLandingContract 八条** · 缓存运行时提取（注入 `defer`）。
  - **N4b ✅ 判据 5–14 全关**（2026-08-21 真机 session）：移动 AudioLanding（**七步**，③b 是实测加的）· 启动清扫 ⑪b · 引擎装配 + 进程级 hub + 共享 claim registry · 契约移动 hook。🟢 **判据 5 的答案：两张网都是 https**（5G `…mcdn.bilivideo.cn:8082` / Wi-Fi `cn-bj-cc-03-03.bilivideo.com`）——**§1.3 的三条出路一条都不用走，不碰 `usesCleartextTraffic`**。🟢 **MMR 与 ffprobe 逐毫秒一致**（Δ0.000 / Δ0.001s），决策 b 的 A 成立。
  - **N4c ✅ 判据 15–19 + 41–43 全关**（三批，子计划 `docs/plans/2026-08-21-phase-b-mobile-n4c.md`，**§8 八条实施修订 + §9 真机对照表**）：`modules/lark-transfer`（dataSync 服务 + 通知渠道 + `onTimeout`）· `downloads/foreground.ts` 状态机（27 条单测 + 11 条反测）· 真机验收六个入口。**控制面是 `arm()` + `settle()` 两个调用**——「预检后零入队」没有 hub 事件，只有调用方知道。**判据 18 只有单测，6 小时配额没有真机证据。**
    - 🔴 **后台的 `startForegroundService()` 在这台机器上既不抛也不起——被延后到应用回前台**（N4c-3 实测）。所以 ① `arm()` 必须在手势那一刻（入队时刻起服务 = 整个下载期间毫无保护）；② **`start()` resolve 只等于「系统收下了请求」**，状态机在 start 后 2 秒回头确认一次（`START_CONFIRM_MS`），确认不了落 `degraded` / `ERR_LARK_FGS_NEVER_STARTED`。
    - 🔴 **想在后台那一刻做事，只能用 `AppState` 回调，不能用 JS 定时器**（后台定时器冻结，反测第一版因此得到一个看起来成立的反面结论）。另有三条采样陷阱进了 LESSONS：**前台服务通知约 10 秒延后** · `pm revoke` 杀进程 / `pm clear` 清外部夹具目录 · **已在库里的曲目会把「长下载」判据变成 4 秒**。
  - **四条开工时记住的，两条已被实测改写**：① ~~明文流是头号未知~~ → **已答，是 https**；② **崩溃孤儿进 `trash/recovery-*` 不是 `recovered-songs/`** 且清扫要 `skipSongIds: pendingFileOpSongIds(...)`（已落地，判据 12/13 守着）；③ ~~preflight 提取会把短链 400 改成 502~~ → **已按顺序修好**；④ **hub 与引擎同批出生**（`EngineCallbacks` 只在构造时给，已落地）。
  - 🔴 **N4b 学到的三条，改移动端代码前必读**（详见 `docs/LESSONS.md`）：**自建 Expo 模块少 `android/build.gradle` → autolink 静默跳过 → 启动即闪退**（守卫 `check-mobile-native-modules.sh` 已进 `just check`）· **MMR 读得出时长 ≠ 文件完整**（fMP4 的 `moov` 在头部，前 64KB 就有完整时长 → 落盘加了 ③b 完整性检查）· **Expo `AsyncFunction` 的最后一个表达式就是返回值**，转不了的类型会在副作用发生之后才 reject。
- 数值判据一律 **release 构建** + 冻结设备 vivo V2408A。逐批状态见 `PROCESS.md` 的 Phase B 段。

**mobile / spike 的四条常驻规矩**：① **bundle** 只许 import `@lark/core/portable` / `@lark/shared` / skybridge SDK（守卫 `check-mobile-imports.sh` + Metro bundle smoke，两者的作用域自 N2a 起是 spike + `apps/mobile` 两处），**禁止复制 core 实现来假装验证 core**——需要 core 算的输入一律由桌面产 fixture；**唯一豁免是 `spikes/mobile-foundation/scripts/*.mjs`**（主机脚本，不在 Metro 图里，产 fixture 时必须用真 core）。② **Expo 已进桌面 workspace，每次 `pnpm install` 变动后必须复跑 `just check` + `just test`**。**短命夹具不进 bundle**：bilibili 流 URL 两小时过期、skybridge 账号每次新建，由 `probe-host.mjs` 的 `/fixtures/network` 现供。③ **真机测试默认由用户跑**（2026-08-19 定）：我只负责 `just mobile-android-release`（adb 直接装到机器上），然后把「看什么」讲清楚——用户手测比脚本驱动快得多。**我自己驱动手机只在两种情况**：需要抓内容（logcat / dumpsys / 截屏比对），或者判据要求一段精确的流程（崩溃点、force-stop 时机、成组的顺序断言）。真要长跑，**开跑前说一声、跑完说一声**——用户以为跑完了就去动手机，症状会长得像应用 bug（`not in front` / 找不到屏幕上明明有的标签）。④ **改 Expo 模块的原生代码，光 `pnpm patch` 没用**：SDK 57 的模块在 `expo-module.config.json` 里带 `publication`，Android 侧消费的是包内**预编译 AAR**，源码不参与构建——补丁装上了、`.kt` 真的变了、BUILD SUCCESSFUL（8 秒）、设备上零变化。要在 `apps/mobile/package.json` 加 `expo.autolinking.buildFromSource`（目前只有 `expo-audio`，见 `patches/expo-audio@57.0.3.patch`）。**驱动脚本也有两条新边界**：`drive.mjs` 现在读 `content-desc`（图标按钮才点得动），但**播放中 `uiautomator dump` 会失败**（走着的秒数让窗口永不 idle），要先暂停或改用坐标。

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
│   │               #   operation-queue 的串行/generation）
│   ├── core/       # @lark/core — 业务逻辑。N1 之后**桌面专有的只剩**：db/ 的打开与锁、
│   │               #   ffmpeg 与落盘协议（download/{audio-landing,ffmpeg,resolve,import}）、
│   │               #   file-op 执行器、config、logger、paths 根解析、media-tools、migration
│   │   └── src/portable/  # @lark/core/portable — 一台手机能解析的**整个业务图**（N1 出口）：
│   │                      #   schema / migrations / migrate / schema-signature / pending /
│   │                      #   db-identity（ensureDeviceUuid，N2b 下沉）/
│   │                      #   now-playing-mode（蓝牙歌词开关，N2g）/ play-mode（N3b）/
│   │                      #   last-playback（进度记忆，N3f）/
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
│                    #   ui/ 四 tab + minibar/全屏页/队列面板 · acceptance/（仅验收 bundle 可达）
│                    #   modules/lark-fs 自建原生模块（原子替换 + 外部夹具目录）
│                    #   modules/lark-audio 自建原生模块（ACTION_AUDIO_BECOMING_NOISY，N3e）
│                    #   modules/lark-media 自建原生模块（MediaMetadataRetriever 时长，N4b）
│                    #   modules/lark-transfer 自建原生模块（dataSync 前台服务，N4c）
│                    #   downloads/（engine 装配 · hub 进程级 store · foreground 状态机）
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
  - Phase B：`2026-08-17-phase-b-mobile-n0.md`（N0 详案 + 全期框架 + §3.2a 测量协议 + §9 设备档案）· `2026-08-18-phase-b-mobile-n1.md`（**§8.1 D5 冻结 = 单一事实源**）· `2026-08-19-phase-b-mobile-n2.md`（**N2，v3 + §5 决策全关**）· `2026-08-20-phase-b-mobile-n3.md` · `2026-08-20-phase-b-mobile-n4.md`（**N4 全期**）· `2026-08-21-phase-b-mobile-n4c.md`（**N4c 已完成**，§8 实施修订 + §9 真机对照表；判据 15 已按实测改写，新增三条编号 41–43）· `2026-08-21-phase-b-mobile-n4d.md`（**N4d，决策 a–j 已于 2026-08-23 全关，§5 是定案**；§1.6 的 `singleTask` 风险已在主机上排除）
  - v0.3：`2026-08-13-m4a-unification.md`（判据 1–61 / 决策 a–n / **§9 附表 A 错误分型映射表**）
  - v0.2：`2026-08-11-v0.2-skybridge-sync.md`（§3 协议冻结 / §5 不变量 ㉑–㉚ / §8 决策 D1–D8）· soak 清单 `2026-08-12-v0.2-soak-checklist.md`
  - v0.1：`2026-07-31-m0-…` / `2026-07-31-m1-…` / `2026-08-04-m2-…` / `2026-08-04-m3-…` / `2026-08-05-m4-…` / `2026-08-06-m5-…`（+ followup）/ `2026-08-07-m6-cli.md` / `2026-08-08-m7-packaging.md`
- **常用命令**：`justfile` —— `just check` / `just test` / `just dev-daemon` / `just cli <args>`（= 对外的 `lark`）/ `just accept-gui`（15 条）/ `just accept-m5`（22 条，跑真实 bilibili）/ `just accept-cli`（27 条，驱动真实二进制）/ `just test-sync-e2e`（两套 e2e）/ `just accept-sync`（34 条，真 server + 两台 daemon + 真 GUI）/ `just fetch-ffmpeg`（自建 vendor ffmpeg + 门禁）/ `just package [bundled|system]` / `just pack-cli` / `just accept-pack <mode> <dmg> <tgz>`（28 条）/ `just backup-nest <目录>` / `just mobile-*`（`mobile-typecheck` / `mobile-bundle-smoke` / `mobile-prebuild` / `mobile-android[-release]` / `mobile-acceptance-release` / `mobile-acceptance-smoke` / `mobile-drive` / `mobile-backup-audit` / `mobile-push-fixture <nest>` / **`mobile-push-audio-fixtures`**（N4b：两条探针曲目 + 主机 ffprobe 真值）/ `mobile-accept-library <nest>`（26 条，驱动生产 UI，排序与主机对照）/ `mobile-fs-instrumentation`）/ `just spike-media-*` / `just spike-mobile-*`
- **Go 版（功能参照）**：`../lark-go/`
- **跨仓**：`../aviary/docs/DESIGN.md`、`../aviary/docs/ROADMAP.md`、`../aviary/docs/SKYBRIDGE_ARCH.md`
