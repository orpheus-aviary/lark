# lark 开发规范

## 项目概述

lark 是百灵音乐播放器的 TypeScript 重写版。从零设计，可参考 `../lark-go/` 的既有实现作为功能映射基线，但不复制架构。技术栈与 owl 对齐。

## 状态

🚀 **开发中**（2026-07-16 启动）。**M0 已完成**（2026-07-31：五包骨架 + `GET /status` 垂直链路 + `lark-media://` spike 六项判据全过）；**M1 已完成**（2026-08-03：config/logger/paths + schema v1 迁移基座 + songs/playlists CRUD/稀疏 rank + Go 迁移协议全实现，副本验收对账 20/2/4；**真实库未迁**，时机由用户后定；子计划：`docs/plans/2026-07-31-m1-core-data-layer.md`，决策 M1-1–M1-15 + §7 实施记录）；**下一步 M2（daemon 基础路由）**。主计划：`docs/plans/2026-07-16-ts-rewrite-master-plan.md`（含决策记录 R1–R32，三轮评审定稿）；进度跟踪：`PROCESS.md`。

**每个里程碑先出子计划**（`docs/plans/<日期>-<里程碑>.md`）经用户过目再动手，实现按任务分批、每批提交前给用户看 commit 信息。

## 技术栈

- **语言**：TypeScript (ESM)
- **桌面**：Electron + electron-vite
- **后端 daemon**：Fastify + better-sqlite3 + drizzle-orm
- **前端**：React + shadcn/ui + Tailwind v4 + zustand
- **CLI**：commander
- **包管理**：pnpm
- **Lint**：Biome
- **测试**：vitest

## 仓库结构

```
lark/
├── packages/
│   ├── shared/     # @lark/shared — Node-free 线协议（类型、HTTP client、SSE、api-paths）
│   ├── core/       # @lark/core — 业务逻辑（db、songs/playlists、下载、歌词、缓存、config、logger）
│   ├── daemon/     # @lark/daemon — Fastify server + `lark daemon` 入口
│   └── gui/        # @lark/gui — Electron main/preload/renderer
├── apps/
│   └── cli/        # @lark/cli — 对外 CLI（bin `lark`；发布名 @orpheus-aviary/lark-cli 待 M7 定）
├── spikes/
│   └── media-protocol/  # lark-media:// 验证工程，长期保留作 M4 移植参照
├── scripts/        # 依赖方向守卫（rg 源码，不查 package.json）
└── docs/
```

依赖方向：`shared ← core ← daemon ← gui`；`cli → shared`（HTTP backend，当前唯一）+ `core`（`--direct`，M6 起）。三条守卫进 `just check`：core 禁 daemon/gui/electron、daemon 禁 gui/electron、shared 禁一切 Node builtin（`node:` 前缀与裸名都拦）。

**已决定**（主计划 §1）：不抽 `@orpheus-aviary/daemon-kit`，v0.1 直接复制 owl 模式，出现明显重复再重构。

## 注意事项

- **daemon 统一入口**：CLI 和 GUI 都通过 daemon HTTP API（默认端口 **47100**，端口段 `471xx` 归 lark）；daemon 存活时 CLI **一律禁止 `--direct` 写**（无 `--force`，R31）
- **数据目录**：`~/orpheus-aviary-nest/lark/`
- **统一响应格式**：`{"success": bool, "data": {}, "message": "..."}`；例外：`/audio`（二进制 + Range）、`/lyrics`（text/plain）、`/events`（SSE）
- **token**：由 daemon 生成并原子发布 0600 文件；GUI 侧每次读取，不进 URL/DOM/日志/媒体 src（R21/R29）
- **skybridge 预留**：v0.1 建 sync 三表**不写事件**；实体 `device_id` 仅存 skybridge 注册 ID（本地身份在 `local_metadata.device_uuid`，两域不混用）；v0.2 冻结协议后全量回填（R2/R18）
- **媒体文件**：歌曲本体不同步、不走 attachment——各设备凭 `source_key`（bilibili = `bvid:cid`）按需下载；歌词文件永不参与缓存清理
- **缓存清理不变量**：只清理 `file_origin='downloaded'` 且清理前探活确认可重下的文件；imported（含 Go 迁移曲库）是用户资产，永不自动清理（R1/R26）

### M0 实测锁定（改动前先读 `docs/plans/2026-07-31-m0-scaffold-media-spike.md` §6）

- **版本**：Electron **43.2.0**、Node 24.13.0（`.node-version`）、全依赖精确锁版；**vite 用根 `pnpm.overrides` 钉 7.3.6**——只锁直接依赖挡不住传递范围把它抬到 8，而 electron-vite 5 的 peer 只到 7，失效方式是静默的（build 照样成功，但 electron 被打进 main bundle）
- **Electron ESM main 不得顶层 `await app.whenReady()`**：ready 只在入口模块求值完成后才发，顶层 await 直接死锁（不开窗、无输出、无退出）。包一层 `async function bootstrap()`
- **renderer CSP 单一来源 = gui 的 Vite 插件**（`order: 'post'` + `head-prepend`）；`index.html` 不手写 meta。dev 比生产多两处放宽：`connect-src` 加 HMR socket、`script-src` 加 `'unsafe-inline'`（React Fast Refresh preamble 是内联 script）
- **M2 的 `/audio` 三条义务**（spike 实测）：尊重 backpressure（写回调 + 速率，不能只按时间节流）、按「单曲可能并存约 6 条 range 流」预算 fd、在响应 `close`/`error` 上做一次性清理（幂等 guard）。**不要用「按块封顶 206」缓解慢速来源**——实测会把媒体元素打进 `MEDIA_ERR_NETWORK`
- **transport 重试**：仅 GET 默认重试（2 次），且只重试 fetch 网络层异常；收到响应后 401/5xx/非 JSON 一律不重试（M0-7）

### M1 实测锁定（详见 `docs/plans/2026-07-31-m1-core-data-layer.md` §7）

- **版本定案**：better-sqlite3 **12.11.1**（engines 显式列 Node 24.x；13.0.x 发布两周不追新首发）、drizzle-orm 0.38.4、pino 9.14.0、pino-roll 2.2.0、smol-toml 1.6.1、@electron/rebuild 4.2.0；`process.versions.modules`：**Node 24.13.0 = 137、Electron 43.2.0 = 148**（双运行时真值探测复核）
- **ABI recipes 已接线**：`ensure-node-abi` 挂 test / test-core / test-daemon / dev-daemon / migrate-go；`ensure-electron-abi` 已落地但 **M4 才接线**（M1–M3 无 Electron 内加载 better-sqlite3 的入口）；core 的 vitest 用 **fork 池**（worker 池下原生模块有崩溃前科，M1-14）
- **迁移锁**：`songs.db.migrate.lock` 是**常驻** SQLite 锁库（持锁 = 连接上 `BEGIN EXCLUSIVE`，内核 fcntl 锁，kill -9 自动释放）——**锁文件永不删除**，其存在与否不携带语义
- **createDatabase 判定前零写入**：`journal_mode=WAL` 必须在三条拒绝路径（>LATEST / Go 旧库 / 未知 v0 非空库）判定之后才设——提前设会把仍在日常使用的 Go 库从 DELETE 静默改成 WAL（测试有字节级不变断言）
- **loadConfig 强制收紧 0600**：存量 0644 的 `lark_config.toml` 即使只加载不保存也会被 chmod 0600，chmod 失败即抛错不带病运行
- **migrate-go 的 EXCLUSIVE 触发**：owl 的「真实读」之上还需一次同值写升级（`BEGIN IMMEDIATE` + `PRAGMA user_version=0`）——纯读探不到外部未提交写事务（RESERVED），也拿不到真正的排他锁

## Commit 规范

遵循上级 `orpheus-aviary/.claude/CLAUDE.md` 的 Conventional Commits。

Scope：`shared` / `core` / `daemon` / `gui` / `cli` / `player` / `download` / `lyrics` / `search` / `library` / `settings` / `cache` / `link` / `skybridge` / `db` / `config` / `repo`（仓库级杂项：justfile / lockfile / README / PROCESS 等）/ `plan`（`docs/plans/` 计划文档）

## 关键参考

- 主计划：`docs/plans/2026-07-16-ts-rewrite-master-plan.md`
- M0 子计划 + spike 实测结论：`docs/plans/2026-07-31-m0-scaffold-media-spike.md`（§6 是 M4 移植清单）
- 本仓设计：`docs/DESIGN.md`
- 进度：`PROCESS.md`
- 常用命令：`justfile`（`just check` / `just test` / `just dev-daemon` / `just cli <args>` / `just spike-media-*`）
- Go 版（功能参照）：`../lark-go/`
- 跨仓架构：`../aviary/docs/DESIGN.md`、`../aviary/docs/ROADMAP.md`
- skybridge 架构：`../aviary/docs/SKYBRIDGE_ARCH.md`
