# lark 开发规范

## 项目概述

lark 是百灵音乐播放器的 TypeScript 重写版。从零设计，可参考 `../lark-go/` 的既有实现作为功能映射基线，但不复制架构。技术栈与 owl 对齐。

## 状态

⏳ **待启动**。本仓仅有文档骨架，无代码。需求清单与实施计划在 `docs/DESIGN.md`，启动时机见 `../aviary/docs/ROADMAP.md`。

## 技术栈（预定）

- **语言**：TypeScript (ESM)
- **桌面**：Electron + electron-vite
- **后端 daemon**：Fastify + better-sqlite3 + drizzle-orm
- **前端**：React + shadcn/ui + Tailwind v4 + zustand
- **CLI**：commander
- **包管理**：pnpm
- **Lint**：Biome
- **测试**：vitest

## 仓库结构（规划）

启动时搭。预期形态对齐 owl：

```
lark/
├── packages/
│   ├── core/       # @lark/core — 业务逻辑（播放、下载、歌词）
│   ├── daemon/     # @lark/daemon — Fastify server + CLI
│   └── gui/        # @lark/gui — Electron + React
├── apps/
│   └── cli/        # @lark/cli
└── docs/
```

**开放议题**：owl 的 `@owl/core` / `@owl/daemon` 是否抽出通用部分（例如 `@orpheus-aviary/daemon-kit`）供 lark 复用？**启动时再评估**，避免过早抽象。lark 第一版如果有明显重复再重构。

## 注意事项

- **daemon 统一入口**：CLI 和 GUI 都通过 daemon HTTP API；CLI `--direct` 仍走同一 core（以便 skybridge 的 change log 不被绕过）
- **数据目录**：`~/orpheus-aviary-nest/lark/`
- **统一响应格式**：`{"success": bool, "data": {}, "message": "..."}`
- **skybridge 对接**：从 v0.1 起就规划好 `sync_changes` 表，不要等到后期重构
- **媒体文件**：歌曲本体（mp3 / lrc）不进 skybridge change log，通过 skybridge attachment 通道或不同步，详细策略在 DESIGN.md 里定

## Commit 规范

遵循上级 `orpheus-aviary/.claude/CLAUDE.md` 的 Conventional Commits。

Scope：启动时定义；预期初始集合 `core` / `daemon` / `gui` / `cli` / `player` / `download` / `lyrics` / `search` / `library` / `settings` / `skybridge` / `db` / `config`

## 关键参考

- 本仓设计：`docs/DESIGN.md`
- Go 版（功能参照）：`../lark-go/`
- 跨仓架构：`../aviary/docs/DESIGN.md`、`../aviary/docs/ROADMAP.md`
- skybridge 架构：`../aviary/docs/SKYBRIDGE_ARCH.md`
