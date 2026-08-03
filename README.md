# lark

百灵音乐播放器的 TypeScript 重写版。原 Wails + Go 版归档为 `../lark-go/`。

## 定位

音乐桌面工具，隶属 orpheus-aviary。核心能力参考 lark-go 现有实现（播放 / 下载 / 歌词 / 搜索 / daemon 模式），新增歌曲链接体系、统一缓存模型、歌单导入导出等。技术栈对齐 owl，v0.2 起接入 skybridge 做多设备同步（歌单、歌曲元数据含来源链接；不同步歌曲文件与播放记录）。

## 状态

🚀 **开发中**（2026-07-16 启动）。M0 脚手架 + 媒体 spike、M1 core 数据层（config/logger、schema v1 + 迁移基座、songs/playlists CRUD、Go 曲库迁移协议）已完成；下一步 M2 daemon 基础路由。整体计划见 `docs/plans/2026-07-16-ts-rewrite-master-plan.md`，进度见 `PROCESS.md`。

详见 `docs/DESIGN.md` 与 `../aviary/docs/ROADMAP.md`。

## 开发

前置：Node ≥ 22.12（本仓锁 `.node-version` = 24.13.0）、pnpm ≥ 10、`just`、`rg`；`ffmpeg` 仅完整 spike 校验层需要。

```bash
pnpm install

just dev-daemon      # 前台起 daemon（127.0.0.1:47100）
curl http://127.0.0.1:47100/status

just cli status      # 经 HTTP 查 daemon（--json 输出原始信封）
just dev             # 起 GUI（M0 不自动拉 daemon，需先开上面那个）
just gui-preview     # 用 build 产物起 GUI —— 验证生产 CSP 的唯一方式

just check           # lint + tsc -b + 依赖方向守卫 + spike fast 层
just test            # 全部 vitest

just migrate-go      # 一次性 Go songs.db 迁移（交互 y/N；先备份，迁移后 Go 版无法再打开库）
```

Go 版曲库迁移：`just migrate-go` 会尊重 `LARK_NEST_DIR`——M1 验收全部在**副本**上做
（复制真实 nest 到临时目录再跑）。真实库的正式迁移时机由用户在 GUI 可用后自行决定；
迁移前请先退出 Go 版 lark。

媒体协议 spike（M4 移植参照）：`just spike-media-server` / `just spike-media-app` 双终端手动跑，
`just spike-media-check` 跑完整校验层。结论见 `docs/plans/2026-07-31-m0-scaffold-media-spike.md` §6。

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
