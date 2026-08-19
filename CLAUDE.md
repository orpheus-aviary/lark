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
- **N2 开发中**（N2a–N2f 已完成，只剩 **N2g 蓝牙歌词判定函数 + config 字段**；**判据 14 的「拖柄重排」已按用户决定不做**，见子计划 §8.3；**判据 16b = D2D 手机搬家已搁置**，见子计划 §8.2）——子计划 `docs/plans/2026-08-19-phase-b-mobile-n2.md`（**v3，两轮评审收敛**，七批 N2a–N2g / 判据 22 条 / **决策 a–o 已于 2026-08-19 全部关闭，§5 是定案**，§8 有修订对照）。四条要点：**决策 a = 原子替换**（expo-file-system 57 在 Android 上两条路都堵着）· **`ensureDeviceUuid` 要下沉进 portable**（今天是桌面专有的，缺它移动端一切业务写入抛错）· **删除的文件半推不掉**（`deleteSong` 无条件 drain）→ file-op 执行器提前进 N2 且控制面从桌面提取 · **§2.2 冻结了启动序列**：零写预检（含兼容性）→ 写 SecureStore intent → 读写打开 → 收敛 → `ensureDeviceUuid` → 提交 intent → boot drain → 服务。
- **蓝牙歌词进 v1，只做 Android**（2026-08-19 用户决定）：复用 AVRCP 的 TITLE 字段；判定函数（`@lark/shared` 纯函数）+ config 字段归 N2，接线与开关归 N3；**桌面整个不做**。见主计划 §4.5 的修订段。
- 数值判据一律 **release 构建** + 冻结设备 vivo V2408A。逐批状态见 `PROCESS.md` 的 Phase B 段。

**mobile / spike 的两条常驻规矩**：① **bundle** 只许 import `@lark/core/portable` / `@lark/shared` / skybridge SDK（守卫 `check-mobile-imports.sh` + Metro bundle smoke，两者的作用域自 N2a 起是 spike + `apps/mobile` 两处），**禁止复制 core 实现来假装验证 core**——需要 core 算的输入一律由桌面产 fixture；**唯一豁免是 `spikes/mobile-foundation/scripts/*.mjs`**（主机脚本，不在 Metro 图里，产 fixture 时必须用真 core）。② **Expo 已进桌面 workspace，每次 `pnpm install` 变动后必须复跑 `just check` + `just test`**。**短命夹具不进 bundle**：bilibili 流 URL 两小时过期、skybridge 账号每次新建，由 `probe-host.mjs` 的 `/fixtures/network` 现供。

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
- **移动**：Expo SDK 57 + CNG（Android only，N2 起）
- **CLI**：commander
- **包管理**：pnpm ／ **Lint**：Biome ／ **测试**：vitest

## 仓库结构

```
lark/
├── packages/
│   ├── shared/     # @lark/shared — Node-free 线协议（类型、HTTP client、SSE、api-paths、lrc）
│   ├── core/       # @lark/core — 业务逻辑。N1 之后**桌面专有的只剩**：db/ 的打开与锁、
│   │               #   ffmpeg 与落盘协议（download/{audio-landing,ffmpeg,resolve,import}）、
│   │               #   file-op 执行器、config、logger、paths 根解析、media-tools、migration
│   │   └── src/portable/  # @lark/core/portable — 一台手机能解析的**整个业务图**（N1 出口）：
│   │                      #   schema / migrations / migrate / schema-signature / pending /
│   │                      #   db-identity（ensureDeviceUuid，N2b 下沉）/ open-library（移动端
│   │                      #     打开分派 classifyLibrary+prepareLibrary）/
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
│   └── mobile/     # @lark/mobile — Android（N2 起）
├── spikes/
│   ├── media-protocol/    # lark-media:// 验证工程，长期保留作 M4 移植参照
│   └── mobile-foundation/ # Phase B 平台 spike + 真机驱动设施（drive.mjs / probe-host.mjs）
├── scripts/        # 依赖方向守卫（rg 源码，不查 package.json）
└── docs/
```

依赖方向：`shared ← core ← daemon ← gui`；`cli → shared` + `core`（静态只碰零原生子路径 `paths` / `config` / `daemon-control` / `native-probe`，barrel 只在 `--direct` 分支 dynamic import）。**`core/portable` 是 core 内部的一层**：桌面专有的那半（`db/` · `download/{audio-landing,ffmpeg,resolve,import}` · `sync/file-ops-runtime` · `config/` · `logger/` · `paths.ts` · `media-tools/` · `migration/`）反向 import 它，它不许 import 任何 core（移动端只链这一块——`@lark/core/portable`，**CLI 不需要它，守卫的放行清单里也不加**）。

**七条守卫**进 `just check`（整条 ~9s）：core 禁 daemon/gui/electron、**core/portable 禁一切宿主**（Node builtin 裸名与 `node:` 前缀 · better-sqlite3 含 type import · `drizzle-orm/better-sqlite3`（`sqlite-core` 放行）· pino/smol-toml/electron · `@lark/core` 自引含子路径 · **按深度计数**的 `../` 越界）、daemon 禁 gui/electron、shared 禁一切 Node builtin、cli 禁 daemon/gui/electron **且禁静态 import core barrel**、**spike/mobile 只许 import portable/shared/skybridge SDK**（`check-mobile-imports.sh`，只约束 `@lark/*` 与 `@orpheus-aviary/*`）、**Metro bundle smoke**（`scripts/check-portable-bundles.mjs`——读 Metro 真建出来的模块图，答 rg 守卫答不了的三件事；**探针必须放在 barrel 够得到的文件里**，孤立文件不在图里、塞什么都是绿的）。**后两条自 N2a 起各管两处**（`spikes/mobile-foundation` + `apps/mobile`）：smoke 建**两个 bundle**，因为 `disableHierarchicalLookup` 下一边声明的依赖另一边解不开，一边绿证明不了另一边；判据 7 的「`core/migration/` 不许进图」排在通用 escapee 规则**之前**，否则它是不可达的死代码。另加 `just mobile-typecheck`（`apps/mobile` 不在根 `tsc -b` 里，不进 check 就等于没类型检查）。

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
  - Phase B：`2026-08-17-phase-b-mobile-n0.md`（N0 详案 + 全期框架 + §3.2a 测量协议 + §9 设备档案）· `2026-08-18-phase-b-mobile-n1.md`（**§8.1 D5 冻结 = 单一事实源**）· `2026-08-19-phase-b-mobile-n2.md`（**N2，v3 + §5 决策全关**）
  - v0.3：`2026-08-13-m4a-unification.md`（判据 1–61 / 决策 a–n / **§9 附表 A 错误分型映射表**）
  - v0.2：`2026-08-11-v0.2-skybridge-sync.md`（§3 协议冻结 / §5 不变量 ㉑–㉚ / §8 决策 D1–D8）· soak 清单 `2026-08-12-v0.2-soak-checklist.md`
  - v0.1：`2026-07-31-m0-…` / `2026-07-31-m1-…` / `2026-08-04-m2-…` / `2026-08-04-m3-…` / `2026-08-05-m4-…` / `2026-08-06-m5-…`（+ followup）/ `2026-08-07-m6-cli.md` / `2026-08-08-m7-packaging.md`
- **常用命令**：`justfile` —— `just check` / `just test` / `just dev-daemon` / `just cli <args>`（= 对外的 `lark`）/ `just accept-gui`（15 条）/ `just accept-m5`（22 条，跑真实 bilibili）/ `just accept-cli`（27 条，驱动真实二进制）/ `just test-sync-e2e`（两套 e2e）/ `just accept-sync`（34 条，真 server + 两台 daemon + 真 GUI）/ `just fetch-ffmpeg`（自建 vendor ffmpeg + 门禁）/ `just package [bundled|system]` / `just pack-cli` / `just accept-pack <mode> <dmg> <tgz>`（28 条）/ `just backup-nest <目录>` / `just mobile-*`（`mobile-typecheck` / `mobile-bundle-smoke` / `mobile-prebuild` / `mobile-android[-release]` / `mobile-acceptance-release` / `mobile-acceptance-smoke` / `mobile-drive` / `mobile-backup-audit` / `mobile-push-fixture <nest>` / `mobile-accept-library <nest>`（26 条，驱动生产 UI，排序与主机对照）/ `mobile-fs-instrumentation`）/ `just spike-media-*` / `just spike-mobile-*`
- **Go 版（功能参照）**：`../lark-go/`
- **跨仓**：`../aviary/docs/DESIGN.md`、`../aviary/docs/ROADMAP.md`、`../aviary/docs/SKYBRIDGE_ARCH.md`
