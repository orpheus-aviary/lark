# lark 开发规范

## 项目概述

lark 是百灵音乐播放器的 TypeScript 重写版。从零设计，可参考 `../lark-go/` 的既有实现作为功能映射基线，但不复制架构。技术栈与 owl 对齐。

## 状态

🚀 **开发中**（2026-07-16 启动）。主计划：`docs/plans/2026-07-16-ts-rewrite-master-plan.md`（含决策记录 R1–R32，三轮评审定稿）；进度跟踪：`PROCESS.md`。

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
│   └── cli/        # @lark/cli — 对外 CLI（发布名 @orpheus-aviary/lark-cli）
└── docs/
```

依赖方向：`shared ← core ← daemon ← gui`；`cli → core`。core 禁止 import daemon/Electron。

**已决定**（主计划 §1）：不抽 `@orpheus-aviary/daemon-kit`，v0.1 直接复制 owl 模式，出现明显重复再重构。

## 注意事项

- **daemon 统一入口**：CLI 和 GUI 都通过 daemon HTTP API（默认端口 **47100**，端口段 `471xx` 归 lark）；daemon 存活时 CLI **一律禁止 `--direct` 写**（无 `--force`，R31）
- **数据目录**：`~/orpheus-aviary-nest/lark/`
- **统一响应格式**：`{"success": bool, "data": {}, "message": "..."}`；例外：`/audio`（二进制 + Range）、`/lyrics`（text/plain）、`/events`（SSE）
- **token**：由 daemon 生成并原子发布 0600 文件；GUI 侧每次读取，不进 URL/DOM/日志/媒体 src（R21/R29）
- **skybridge 预留**：v0.1 建 sync 三表**不写事件**；实体 `device_id` 仅存 skybridge 注册 ID（本地身份在 `local_metadata.device_uuid`，两域不混用）；v0.2 冻结协议后全量回填（R2/R18）
- **媒体文件**：歌曲本体不同步、不走 attachment——各设备凭 `source_key`（bilibili = `bvid:cid`）按需下载；歌词文件永不参与缓存清理
- **缓存清理不变量**：只清理 `file_origin='downloaded'` 且清理前探活确认可重下的文件；imported（含 Go 迁移曲库）是用户资产，永不自动清理（R1/R26）

## Commit 规范

遵循上级 `orpheus-aviary/.Codex/AGENTS.md` 的 Conventional Commits。

Scope：`shared` / `core` / `daemon` / `gui` / `cli` / `player` / `download` / `lyrics` / `search` / `library` / `settings` / `cache` / `link` / `skybridge` / `db` / `config`

## 关键参考

- 主计划：`docs/plans/2026-07-16-ts-rewrite-master-plan.md`
- 本仓设计：`docs/DESIGN.md`
- 进度：`PROCESS.md`
- Go 版（功能参照）：`../lark-go/`
- 跨仓架构：`../aviary/docs/DESIGN.md`、`../aviary/docs/ROADMAP.md`
- skybridge 架构：`../aviary/docs/SKYBRIDGE_ARCH.md`
