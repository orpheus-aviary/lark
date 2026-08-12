# lark 本仓设计

> 2026-05-07 首版 · 占位级；2026-07-16 需求盘点定稿，实施计划见 `docs/plans/2026-07-16-ts-rewrite-master-plan.md`；**2026-08-10 v0.1.0 已发布**——本文描述的 v0.1 范围全部落地，逐里程碑的实际做法与实测结论见 `PROCESS.md` 与 `docs/plans/`（本文保留为需求与设计的原始记录，不再逐条追平实现细节）。

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
- **设置页 GUI**：LLM 配置、主题、字号、缓存上限（含缓存状态与立即清理）、窗口尺寸、日志（Go 版只能手改 toml）。**显示列不在设置页**——视图态（列显隐/列宽/排序/播放模式）留在 TopBar + localStorage，不进 config（M4-12 冻结线）
- **歌单拖拽排序**：修复 Go 版 reorder 断链并补上 UI（稀疏 rank，拖一次只改一行）
- **多选与批量操作**：复选框列 + Cmd/Shift 点选 + 表头三态全选（范围限当前视图）；批量固定/取消固定/添加到歌单/移出列表/删除，部分失败如实汇报
- **排序补两个字段**：时长与创建时间（Go 版只有默认/名称/歌手/时间）；字段从下拉选、方向由按钮切，不再是点击循环
- **行状态四通道**：琥珀色 = 正在播放 · 左侧竖条 = 选中 · 蓝色图钉按钮 = 已固定 · `[需要下载]` = 无文件；行内按钮（固定/播放/加入歌单/移出/删除）常驻不悬浮
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

### 3.1 GUI 宿主（M4 落地，2026-08-05）

Electron main 是 daemon 的宿主，不是它的监工：

- **确权与复用**：main 先打 `GET /status`（1s）。没人应答才 spawn（`process.execPath` +
  `ELECTRON_RUN_AS_NODE`、detached、**绝不注入 token env**），并要求 `status.pid === child.pid`
  才算 owned；退出时只停自己拉起的那个，且发信号前重新确权 pid（防 pid 复用误杀）。
  有人应答则必须证明是**同一个 nest** 的 daemon：`GET /api/instance` 返回
  `{nest_dir, pid, version, local_api_version}`，`realpath` 相等且 `local_api_version` 相等
  才复用——**复用永不认领所有权**。任何不能证明身份的情况（nest 失配 / 401 / 404 / 非 200）
  都弹框中止，**绝不进 spawn**（端口已被占，spawn 必然竞态），也绝不去停陌生进程。
- **不做 respawn**：daemon 死了就是离线指示 + toast，恢复靠用户重启 GUI 或自己起 daemon。
- **`lark-media://`**：renderer 的 `<audio src="lark-media://song/<uuid>">` 由 main 代理到
  `GET /audio/:id`，入站 `Range` 原样转发、`Authorization` 由 main 每次现读 token 附加，
  回程保留上游状态码（200/206/404/416）与五个头。**token 因此不进 URL / DOM / 日志 / 媒体 src**
  （R21/R29）。URL 校验不符 → 400；token 不可读 → 503；上游不可达 → 502。
- **两个纪元，不许混用**：`connectionEpoch` 每收到一次 `hello` 递增，只触发全量刷新；
  `daemonGeneration` 只在观测到 token 内容或 `/status.pid` 变化时递增，**只有它**允许媒体
  元素 remount。remount 会毁掉播放位置与缓冲，所以换代后跑一次恢复状态机（保存的位置 +
  换代前的播放意图，metadata / error / 超时三路竞争、恰好结算一次，有失败终态）。
  一次普通的 SSE 断线重连不得打断播放。
- **会话通道**：renderer 是 daemon 的单一 GUI 消费者（`POST /gui/register` → `?role=gui&gui_id=`），
  收 409 `GUI_REGISTRATION_REQUIRED` 就重新注册；播放器命令按 SSE 到达顺序串行执行后 ack，
  超过 2.5s 才轮到的命令直接丢弃（daemon 已在 3s 回过 504）。

### 3.2 CLI 与跨进程互斥（M6 落地，2026-08-08）

CLI 是 daemon 的第二个前端，也是**唯一可以在没有 daemon 时读写库的入口**——所以互斥不能再靠
「进程内一个写者」这个假设：

- **跨进程 writer lock**：daemon / `--direct` 写 / `migrate-go` / `backup-nest` 四方共守
  `songs.db.writer.lock`（常驻 SQLite 锁库，`BEGIN EXCLUSIVE`，内核 fcntl，kill -9 自动释放，
  **锁文件永不删除**）。锁序冻结 **writer → migrate → 真库 EXCLUSIVE**；`--direct` 写的顺序是
  **mkdir → 取锁 → 开库**，所以一个空 nest 也能被 CLI 初始化出来。
- **读路径零写入**：只读开库不取任何锁、不建库、不改 journal 模式，因此在 daemon 运行时、
  备份复制期、迁移进行中都安全。R31 只挡写：**daemon 存活时 `--direct` 写一律拒绝，无逃生门**。
- **身份五态**：`GET /status` 公开 `nest_fingerprint`（`SHA-256(realpath(lark 目录))`）+
  `local_api_version`，探测端据此分 current / absent / other-nest / same-nest-incompatible /
  occupied-unverifiable。指纹只泄露「路径是否相同」，绑 127.0.0.1 + Host 白名单下接受。
  非 current 一律 fail-closed；证明不了身份就既不用它也不停它。
- **输出契约**：`--json` 下 **exit 0 ⇔ stdout 恰好一条成功信封且 stderr 为空**，非零 ⇔ stdout
  为空、stderr 一条错误信封。七档退出码（0/1/2/3/4/5/130）把「命令写错了」「环境说不」
  「没人监听」「有人在且拒绝」分开，因为这四种的修法不同。
- **拉起链只属于 `play` 和 `gui`**：只有 absent 能 spawn，spawn 后必须用 `/status.pid` 咬合
  确权，竞态败方回收自己的 child（SIGTERM → SIGKILL 双段硬截止）再完整复验胜者。
  detached + `stdio:'ignore'`，父进程 spawn 完即退。

## 4. skybridge 接入

### 同步范围（2026-07-16 更新）
| 对象 | 是否进 skybridge | 备注 |
|---|---|---|
| 歌单（playlist）+ 成员关系 | 是 | 走 `sync_changes`（all 已虚拟化，不产生同步实体） |
| 歌曲元数据（name / artist / **source_url/provider/key** / lyrics_offset / duration） | 是 | 走 `sync_changes`；链接同步后其它设备可凭 key 自取文件 |
| 歌词文本 | 是 | **v0.2 定案（D3）**：走 change log 的 ⚡ 元数据 op（`set_lyrics` / `clear_lyrics`），单条 change 240KB 护栏，超限本地保留 + dead-letter |
| `pinned` / `last_accessed_at` / `file_origin` | 否 | 设备本地偏好与行为数据（各设备存储条件不同） |
| `lark_config.toml` 本地偏好 | 否 | 本地设备相关 |
| 歌曲本体 mp3 | **否** | 不进 change log 也不走 attachment；靠 source_key + 按需下载在各设备自行取流 |
| 播放记录（play history） | 否（无此模型） | v0.1/v0.2 无播放历史功能，仅本地 last_accessed_at |

**预留策略（v0.1）**：只建 sync 三表并维护 `updated_at`/`lww_counter`/`created_at`（事后无法回补的字段）；实体 `device_id` 仅存 skybridge **注册 ID**（注册前 NULL，本地安装身份在 `local_metadata.device_uuid`，两域不混用——owl `0006` 教训）；不写事件、不冻结 payload。账户模型已定：**单账户单资料库**，不做 owl 式 per-profile。

mp3 / 大文件策略已定（2026-07-16）：不同步、不走 attachment，各设备凭 `source_key` 按需下载。

**协议已冻结（v0.2）**：payload schema / 墓碑 / LWW 三元组 / rank 通道 / 冲突与 file-effect journal 全部写在 `docs/plans/2026-08-11-v0.2-skybridge-sync.md`（§3 协议、§5 不变量 ㉑–㉚、§8 决策 D1–D8），实现进度见 `PROCESS.md`。三条与本节相关的定案：**歌词进 change log**（上表）、**同 `(provider,key)` 允许共存不自动合并**（D8）、**rank 全部走 `server_seq` 定序的 ⚡ 通道**（D7）。

### 时序
- lark v0.1 就建好 `sync_changes` 等三表（不写事件），业务写入收敛 core 单一路径，v0.2 补 emit 是机械改动
- 首次真正联动 skybridge 的版本：lark v0.2 起（owl Phase 3+4 已跑通，前置条件满足）——v0.2 的 core / daemon / GUI / CLI 与两套 e2e 已落地，见 `PROCESS.md`

## 5. 非目标

- 不做流媒体服务（Spotify / Apple Music 接入），主要面向本地音频库 + 手动下载内容
- ~~不做移动端~~ → **2026-07-16 修正**（对齐 aviary 2026-07-04 决议）：移动版后置设计（v0.3+ 单独 design doc，方向 RN + skybridge 元数据 + source_url 端上取流）；桌面优先
- 不做实时协同播放
- 不做联网 web UI（owl 的 `@owl/web` / `@owl/server` 不复刻；lark 必须有本地 GUI）

## 6. 开放议题

已收敛（2026-07-16，详见 master plan §1）：需求清单 ✅ · monorepo 不抽 daemon-kit ✅ · mp3 不同步（靠链接按需下载）✅ · 缓存模型 / 音频格式 / 导入策略 / 打包平台 ✅

仍开放：
- v0.2 歌词文本同步策略（change log vs attachment）
- 与 jay 的工具调用协议（`lark skill export` 已落地：YAML frontmatter + 输出契约 + 退出码表 + 命令参考，**安装方式是打印一段提示词让 agent 按自己的规范装**；jay TS 化时定消费方式，可用性验收挂 M7）
- 与 owl 的跨工具联动（例如 owl 笔记里嵌播放列表链接）— 长期议题，v0.1 不做
