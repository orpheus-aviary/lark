# lark 本仓设计

> 2026-05-07 首版 · 占位级。正式需求盘点与实施计划在启动前单独开 design doc。

## 1. 定位

**桌面音乐工具**：隶属 orpheus-aviary，使用 TypeScript + Electron + Fastify daemon，接入 skybridge 做多设备元数据同步。

与 owl 共享技术栈与架构模式；与 owl 相互独立（不复用同一 daemon / DB / 账号）。

## 2. lark-go 既有功能（作为需求基线参考）

> 来源：`../lark-go/` 当前实现。TS 版需求在此基础上**待补充**（增删均可），动工前单独盘点。

- **播放**：本地音频播放（mp3 等）、进度控制、播放列表管理
- **下载**：bilibili 视频/合集下载 + 转音频（含 WBI 签名）
- **歌词**：lrc 同步显示（lyrics 面板）
- **搜索**：本地库搜索（含拼音首字母）
- **daemon 模式**：HTTP API 暴露播放控制，供 AI / CLI 调用
- **UI**：Wails v2 + React + shadcn/ui（TS 版换 Electron）
- **存储**：`songs.db`（SQLite）+ `~/orpheus-aviary-nest/lark/songs/<uuid>/` 下的 mp3 / lrc

**新版候选新增**（待确认）：
- 待补充

**新版可能废弃 / 简化**（待确认）：
- 待补充

## 3. 技术方向（与 owl 对齐）

- 语言：TypeScript (ESM)
- 桌面：Electron + electron-vite
- daemon：Fastify + better-sqlite3 + drizzle-orm
- 前端：React + shadcn/ui + Tailwind v4 + zustand
- CLI：commander
- 包管理：pnpm / Lint：Biome / 测试：vitest

Monorepo 规划与"是否抽共享 daemon-kit"的议题见 `CLAUDE.md`。

## 4. skybridge 接入

### 同步范围（初步）
| 对象 | 是否进 skybridge | 备注 |
|---|---|---|
| 歌单（playlist） | 是 | 走 `sync_changes` |
| 歌曲元数据（title / artist / album / tags） | 是 | 走 `sync_changes` |
| 歌词文本 | 待定 | 可能走 change log（小）或 attachment |
| 播放记录 / 喜欢 / 评分 | 是 | 走 `sync_changes` |
| `lark_config.toml` 本地偏好 | 否 | 本地设备相关 |
| 歌曲本体 mp3 | **否或独立通道** | 不进 change log，走 skybridge attachment 通道或完全不同步（由用户自己管本地文件） |

具体策略 —— 尤其 mp3 / 大文件的处理 —— 在启动前单独拉 design doc 定。

### 时序
- lark v0.1 就规划好 `sync_changes` 表，即便 skybridge server 尚未接入
- 首次真正联动 skybridge 的版本：lark v0.2 起（待 owl 跑通 Phase 3+4 之后）

## 5. 非目标

- 不做流媒体服务（Spotify / Apple Music 接入），主要面向本地音频库 + 手动下载内容
- 不做移动端
- 不做实时协同播放

## 6. 开放议题（启动前收敛）

- 完整功能需求清单（新增 / 废弃 / 简化）
- Monorepo 结构与是否抽 `@orpheus-aviary/daemon-kit`
- mp3 / lrc 大文件同步策略
- 与 jay 的工具调用协议（沿用 lark-go 现有，还是随 owl 更新一波）
- 与 owl 的跨工具联动（例如 owl 笔记里嵌播放列表链接）— 属长期议题，v0.1 不做
