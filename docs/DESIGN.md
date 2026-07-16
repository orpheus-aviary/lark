# lark 本仓设计

> 2026-05-07 首版 · 占位级；2026-07-16 需求盘点定稿，实施计划见 `docs/plans/2026-07-16-ts-rewrite-master-plan.md`。

## 1. 定位

**桌面音乐工具**：隶属 orpheus-aviary，使用 TypeScript + Electron + Fastify daemon，接入 skybridge 做多设备元数据同步。

与 owl 共享技术栈与架构模式；与 owl 相互独立（不复用同一 daemon / DB / 账号）。

## 2. lark-go 既有功能（作为需求基线参考）

> 来源：`../lark-go/` 当前实现，2026-07-16 全量盘点（详见 master plan）。TS 版全部保留。

- **播放**：renderer HTML5 Audio、4 种播放模式（顺序/列表循环/单曲循环/随机）、进度 seek、快捷键（空格/←→/↑↓）
- **下载**：音频**只来自 bilibili**（LLM 驱动：输入分析 → 搜索选 bvid → 多 P 选集 → 推断歌名歌手 → DASH 最高码率 → ffmpeg 转 mp3）；批量下载支持收藏夹/合集链接
- **歌词**：网易云/QQ/酷狗三平台并行抓取 + LLM 交叉验证；lrc 3 行同步显示 + 每首歌 offset 微调；可重下/删除
- **搜索/排序**：跨全库按歌名/歌手搜索；默认/名称/歌手/时间排序（中文 locale）
- **歌单**：建/改/删（系统歌单 all 保护）、加歌/移除
- **列表 UI**：可选列（时长/大小/创建时间）、列宽拖拽、双击内联编辑、右键菜单
- **daemon 模式**：HTTP API 暴露曲库与播放控制，供 AI / CLI 调用
- **存储**：`songs.db`（SQLite）+ `~/orpheus-aviary-nest/lark/songs/<uuid>/` 下的 mp3 / lrc

**新版新增**（2026-07-16 定稿，同日评审修订）：
- **歌曲链接体系**：`source_url` + 规范化 `source_provider`/`source_key`（bilibili = `bvid:cid`，p 只是展示位置）记录下载来源；右键复制/打开/编辑链接（编辑对话框：取消/自动识别[纯预览]/保存）；文件丢失时链接优先确定性重下，链接缺失或失效才回落 LLM 识别并回写
- **统一缓存模型**：可选缓存上限（默认不限 = 旧版行为）+ LRU 清理最久未访问文件（只删 mp3，歌词保留）+ 单曲固定防清理；**只清理「下载且可确定性重下」的文件，本地导入文件（含 Go 迁移曲库）是用户资产永不自动清理**；播放被清理的歌自动按需重下
- **歌单导入导出**：JSON 格式，导出任意歌单含 all；导入时选目标（all / 指定歌单 / 新建歌单自定义名），按 provider key 去重（歌名+歌手相同仅提示疑似重复），按需下载
- **设置页 GUI**：LLM 配置、缓存上限、显示列、字号（Go 版只能手改 toml）
- **歌单拖拽排序**：修复 Go 版 reorder 断链并补上 UI（稀疏 rank，拖一次只改一行）
- **ffmpeg/ffprobe 随包分发**：不再依赖系统 PATH
- **CLI 强化**：双后端（HTTP / --direct 同一 core）、播放控制命令可自动拉起 GUI、`skill export` 供 jay/agent
- **Go 版 songs.db 一次性迁移**：保留现有曲库

**废弃 / 简化**：
- Wails → Electron；WebSocket（断线整页刷新）→ SSE + 自动重连
- uploader 下载残留死配置不再移植
- daemon 默认端口 47020 → 47100（端口段约定：`470xx` 归 owl，`471xx` 归 lark）
- 系统歌单 all **虚拟化**：不再是 DB 实体（无行、无成员关系），API 层保留 `all` 字面量，消除跨设备多 all 冲突

## 3. 技术方向（与 owl 对齐）

- 语言：TypeScript (ESM)
- 桌面：Electron + electron-vite
- daemon：Fastify + better-sqlite3 + drizzle-orm
- 前端：React + shadcn/ui + Tailwind v4 + zustand
- CLI：commander
- 包管理：pnpm / Lint：Biome / 测试：vitest

Monorepo 规划与"是否抽共享 daemon-kit"的议题见 `CLAUDE.md`。

## 4. skybridge 接入

### 同步范围（2026-07-16 更新）
| 对象 | 是否进 skybridge | 备注 |
|---|---|---|
| 歌单（playlist）+ 成员关系 | 是 | 走 `sync_changes`（all 已虚拟化，不产生同步实体） |
| 歌曲元数据（name / artist / **source_url/provider/key** / lyrics_offset / duration） | 是 | 走 `sync_changes`；链接同步后其它设备可凭 key 自取文件 |
| 歌词文本 | 待定 | 文件小，倾向 change log，v0.2 design doc 定 |
| `pinned` / `last_accessed_at` / `file_origin` | 否 | 设备本地偏好与行为数据（各设备存储条件不同） |
| `lark_config.toml` 本地偏好 | 否 | 本地设备相关 |
| 歌曲本体 mp3 | **否** | 不进 change log 也不走 attachment；靠 source_key + 按需下载在各设备自行取流 |
| 播放记录（play history） | 否（无此模型） | v0.1/v0.2 无播放历史功能，仅本地 last_accessed_at |

**预留策略**：v0.1 只建 sync 三表并维护 `updated_at`/`lww_counter`/`created_at`（事后无法回补的字段）；实体 `device_id` 仅存 skybridge **注册 ID**（注册前 NULL，本地安装身份在 `local_metadata.device_uuid`，两域不混用——owl `0006` 教训）；**不写事件、不冻结 payload**。v0.2 开工 design doc 冻结协议（payload schema / 墓碑 / LWW 三元组）后，注册回填 device_id 并对全量既有实体做 create-op 回填（owl `0008` 模式）。账户模型已定：**单账户单资料库**，不做 owl 式 per-profile。

mp3 / 大文件策略已定（2026-07-16）：不同步、不走 attachment，各设备凭 `source_key` 按需下载；歌词文本等剩余细节在 v0.2 design doc 定。

### 时序
- lark v0.1 就建好 `sync_changes` 等三表（不写事件），业务写入收敛 core 单一路径，v0.2 补 emit 是机械改动
- 首次真正联动 skybridge 的版本：lark v0.2 起（owl Phase 3+4 已跑通，前置条件满足）

## 5. 非目标

- 不做流媒体服务（Spotify / Apple Music 接入），主要面向本地音频库 + 手动下载内容
- ~~不做移动端~~ → **2026-07-16 修正**（对齐 aviary 2026-07-04 决议）：移动版后置设计（v0.3+ 单独 design doc，方向 RN + skybridge 元数据 + source_url 端上取流）；桌面优先
- 不做实时协同播放
- 不做联网 web UI（owl 的 `@owl/web` / `@owl/server` 不复刻；lark 必须有本地 GUI）

## 6. 开放议题

已收敛（2026-07-16，详见 master plan §1）：需求清单 ✅ · monorepo 不抽 daemon-kit ✅ · mp3 不同步（靠链接按需下载）✅ · 缓存模型 / 音频格式 / 导入策略 / 打包平台 ✅

仍开放：
- v0.2 歌词文本同步策略（change log vs attachment）
- 与 jay 的工具调用协议（`lark skill export` 格式对齐 owl，jay TS 化时定消费方式）
- 与 owl 的跨工具联动（例如 owl 笔记里嵌播放列表链接）— 长期议题，v0.1 不做
