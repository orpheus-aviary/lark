# lark

百灵音乐播放器的 TypeScript 重写版。原 Wails + Go 版归档为 `../lark-go/`。

## 定位

音乐桌面工具，隶属 orpheus-aviary。核心能力参考 lark-go 现有实现（播放 / 下载 / 歌词 / 搜索 / daemon 模式），新增歌曲链接体系、统一缓存模型、歌单导入导出等。技术栈对齐 owl，v0.2 起接入 skybridge 做多设备同步（歌单、歌曲元数据含来源链接；不同步歌曲文件与播放记录）。

## 状态

🚀 **开发中**（2026-07-16 启动）。整体计划见 `docs/plans/2026-07-16-ts-rewrite-master-plan.md`，进度见 `PROCESS.md`。

详见 `docs/DESIGN.md` 与 `../aviary/docs/ROADMAP.md`。

## 技术栈（预定）

- **桌面**：Electron + electron-vite
- **后端**：Fastify + better-sqlite3 + drizzle-orm（daemon 模式，独立于 GUI 生命周期）
- **前端**：React + TypeScript + shadcn/ui + Tailwind CSS v4 + zustand
- **CLI**：commander
- **包管理**：pnpm / Lint：Biome / 测试：vitest
- **同步**：skybridge client 库（见 `../skybridge/`）

## 文档

- 本仓设计：`docs/DESIGN.md`
- 历史参考：`../lark-go/README.md`（Go 版功能清单）
- 跨仓路线：`../aviary/docs/ROADMAP.md`
- skybridge 架构：`../aviary/docs/SKYBRIDGE_ARCH.md`

## License

TBD（与 aviary 保持一致）。
