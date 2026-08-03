# lark TS 重写整体计划

> 2026-07-16 首版；同日一轮评审修订（R1–R17：缓存误删/同步预留/迁移安全/媒体鉴权/识别接口）；二轮修订（R18–R28：身份域拆分/DB 级排他迁移/token 模型/全写路径原子化/schema 不变量）；三轮修订（R29–R32：token 归 daemon/source_key=bvid:cid/取消 --force/v0.2 必审补项）。
> 本文是 v0.1 的主计划；skybridge 接入（v0.2）与移动版（v0.3+）在各自开工前单独拉 design doc。

## 0. 目标

把 Go/Wails 版 lark 重写为 TypeScript 版（Electron + Fastify daemon），架构对齐 owl，**保持旧版全部功能**，并新增：

1. **歌曲链接体系**：每首歌记录下载来源链接（`source_url` + 规范化 provider key），右键可复制 / 打开 / 编辑（编辑对话框含取消、自动识别、保存），文件丢失时链接优先复用下载，链接缺失或失效才回落 LLM 自动识别并回写
2. **统一缓存模型**：可选缓存上限 + LRU 自动清理**可确定性重下**的歌曲文件，单曲可「固定」防清理；本地导入文件是用户资产永不自动清理；为存储受限用户和移动端铺路
3. **歌单导入导出**：UI 导出任意歌单（含 all）为 JSON 文件，导入时可选目标（all / 指定歌单 / 新建歌单）
4. **ffmpeg 随包分发**：不再依赖系统 PATH
5. **CLI 保留并强化**：供调试 daemon 和 jay/agent 调用（下载、曲库管理、歌单管理、播放控制，必要时拉起 GUI）
6. **v0.1 起预留 skybridge**：sync 三表建表 + 设备/时间字段就位；**正式事件写入与协议冻结留 v0.2**（激活时全量回填）

不做：联网 web UI（owl 的 `@owl/web`/`@owl/server` 不复刻）；歌曲文件同步。

## 1. 决策记录

### 2026-07-16 用户确认

| 决策点 | 结论 |
|---|---|
| 缓存形态 | **统一缓存模型**：可选「缓存上限」（默认不限 = 旧版行为），超限按最久未访问清理；单曲可固定；被清理的歌播放时凭链接自动重下 |
| 音频格式 | **mp3 + 打包 ffmpeg**：沿用 `songs/<uuid>/song.mp3`，ffmpeg/ffprobe 打包进安装包 |
| 导入策略 | **按需下载**：导入只建条目 + 链接，播放或手动重下时才取文件 |
| 打包平台 | **仅 macOS arm64**：对齐 owl 发布链路（dmg + ad-hoc 签名） |
| 端口 | **47100**。端口段约定：`470xx` 留给 owl（daemon 47010、owl-server 47020），`471xx` 留给 lark |

### 计划内定（有异议随时推翻）

- **不抽 `@orpheus-aviary/daemon-kit`**：v0.1 直接复制 owl 模式，出现明显重复再重构。
- **SSE 替代 WebSocket**；**导出格式 JSON**；**兼容迁移 Go 版 songs.db**（协议见 §3.3）。
- **修复不复刻的 Go 版 bug**：reorder 字段名不匹配（顺带补拖拽 UI）、`fmt.Errorf` 格式串注入、uploader 残留死配置。

### 2026-07-16 评审修订新增

| # | 决策 |
|---|---|
| R1 | 歌曲文件加 **`file_origin`**（downloaded/imported），LRU 只清理「下载且可确定性重下」的文件；导入文件永不自动清理（见 §5.2 不变量） |
| R2 | **v0.1 不写 sync 事件**（只建表 + 设备/时间字段就位），v0.2 冻结 sync v1 协议后做**全量 create-op 回填**（owl `0008_backfill_create_ops` 模式）；LWW 采用 owl 三元组 `(updated_at, lww_counter, device_id)` |
| R3 | **「全部歌曲」虚拟化**：all 不再是 DB 实体（无行、无成员关系），API 层保留 `all` 字面量 id；消除跨设备多 all 冲突 |
| R4 | Go 库迁移采用 **owl 式安全协议**：旧进程探活拒写 → 时间戳备份 → 临时库 → 验收 → 原子交换 → 幂等重试（§3.3） |
| R5 | 媒体鉴权**决策提前至 M0**：renderer 用 `lark-media://` 自定义协议，Electron main 代理到 daemon 并附 Bearer（透传 Range）；不引入 query token |
| R6 | `recognize-url` 为**纯预览**接口不写库；`source_url` 写入点只有显式保存和下载成功回写 |
| R7 | 歌单排序用**稀疏 rank（REAL，间隙插入）**，拖一次只改一行 |
| R8 | 链接身份规范化：存 `source_provider` + `source_key`（bilibili = **`bvid:cid`**，R30 修订：p 是位置非身份，规范化时解析 p→cid，下载前校验 cid 仍在）；去重、重下以 key 为准，`source_url` 仅作展示/打开（保留 `?p=N`） |
| R9 | 下载落盘走**临时文件 + 原子 rename**；失败保留旧文件；队列按曲去重合并；清理与下载/播放互斥 |
| R10 | 一切外部输入 id（导入/未来同步）**强校验 UUID** 后才允许参与文件路径；`openExternal` 仅放行 http/https |
| R11 | GUI 在线状态**绑定其 SSE 连接**（断开即下线），player 命令带 `request_id` + GUI ack + 3s 超时 |
| R12 | 导入去重**只认 `(source_provider, source_key)`**；歌名+歌手相同仅标「疑似重复」由用户决定（默认导入为新条目） |
| R13 | v0.2 定为**单账户单资料库**，不做 owl 式 per-profile（lark 无多账号场景；DB 路径与 songs 目录固定） |
| R14 | 配置接口用 **PATCH /config**（白名单 + 校验，GET 响应脱敏 api_key），不用 PUT 全量覆盖 |
| R15 | 统一 JSON 信封的**明确例外**：`GET /audio/:id`（二进制 + Range）、`GET /lyrics/:id`（text/plain）、`GET /events`（SSE） |
| R16 | **无 LLM 的确定性路径必须可用**：直链 URL 下载、凭 source_key 重下不依赖 LLM；仅自然语言搜索/识别/多 P 无 p 选集/歌名推断/歌词精选需要 LLM（歌词降级为相似度启发式） |
| R17 | 打包**对齐 owl `asar: false`**；ffmpeg-static/ffprobe-static 锁定具体包与版本，加打包后冒烟测试（可执行、签名、Range 播放）；随发行版交付 FFmpeg 许可声明与源码获取方式 |

### 2026-07-16 二轮评审修订新增

| # | 决策 |
|---|---|
| R18 | **身份域拆分**（owl `0006_device_id_split` 同款教训）：`local_metadata.device_uuid` = 安装实例本地身份；实体 `device_id` 改为 **nullable，仅存 skybridge 注册 ID**（注册前一律 NULL；v0.2 注册后先回填本机既有实体、再生成 create-op）。**本地字段（pinned / last_accessed_at / file_origin）更新走独立路径，不得触碰 updated_at / device_id / lww_counter** |
| R19 | `playlist_songs` 补 `lww_counter`（它是未来 LWW 同步实体）；`created_at` 明确为**同步的不可变字段**（虚拟 all 跨设备顺序一致的前提） |
| R20 | 迁移升级为 **DB 级排他**：独立 `.migrate.lock`（O_EXCL；**锁机制后经 M1-10 修订为 SQLite `BEGIN EXCLUSIVE` advisory lock**，见 m1 子计划）+ 源库 `locking_mode=EXCLUSIVE` + WAL checkpoint 与 `-wal`/`-shm` 处理 + **SQLite backup API** 备份 + swap 失败原位恢复 + `integrity_check` 与预期 schema 比对（对齐 owl `migrate.ts`） |
| R21 | **token 模型对齐 owl**：preload `getDaemonToken()` → renderer 持 token 走 HTTP/SSE（接受可信 renderer 持本地 token）；约束改为 token **不进 URL、DOM、日志、媒体 src**。**M0 加 Electron spike**：验证 `lark-media://` 的 Range 透传/206/连续 seek/CSP/token 轮换，不通过则启用签名 URL fallback 并回改计划 |
| R22 | 原子文件操作扩展到**全部写路径**：本地导入（临时文件→校验→rename→DB 提交）、删除歌曲（目录 rename 进 trash → DB 提交 → 异步删除，DB 失败恢复）、歌词写入（临时文件 + rename） |
| R23 | schema 级不变量：`CHECK(file_origin IN …)`、`CHECK(pinned IN (0,1))`、provider/key **同空同有** CHECK、`(source_provider, source_key)` **partial unique index**（key 即身份，并发防重）；列表读取一律 `ORDER BY rank, song_id` |
| R24 | 虚拟 all 的写类路由（改名/删除/增删成员/reorder）统一 `400 VIRTUAL_PLAYLIST`；用户歌单默认顺序 = **manual rank**（拖拽仅此模式可用），名称/歌手/时间排序是临时视图不写库 |
| R25 | CLI `<name|id>` 名称重复时报 `AMBIGUOUS_PLAYLIST` 并列出候选 id（不强制歌单名唯一）；direct 写限制见 R31 修订：daemon 存活时**一律禁止 direct 写，无 `--force`** |
| R26 | 清理资格中的「source_key 有效」= 清理前**逐候选联网探活**（view API 确认视频与分 P 仍在），失效或网络失败一律 **fail closed** 跳过；不可回收文件已超上限时返回 `limit_satisfied=false` + `unreclaimable_bytes`，不做无效清理循环 |
| R27 | 导入：JSON schema 校验 + 大小/曲数上限、未知 version 报 `UNSUPPORTED_FORMAT_VERSION`、**单事务全量成败**、导入现有歌单按文件顺序追加末尾；导出显式包含 `source_provider`/`source_key`（round-trip 去重不受未来 URL 规范化变化影响） |
| R28 | 发布维持 **ad-hoc 签名**（个人/内部发行，不做公证），对齐 owl |

### 2026-07-16 三轮评审修订新增

| # | 决策 |
|---|---|
| R29 | **token 所有者更正**：token 由 **daemon** 内存生成、成功监听后**原子发布** 0600 文件（owl `local-token.ts` 模式，daemon 独立运行时没有 Electron main）；main 只传文件路径；preload 与 main 的媒体代理**每次调用重新读文件**以适应轮换（§2.4 已按此改写） |
| R30 | **source_key 改为 `bvid:cid`**：p 是从 1 起的分 P 位置序号而非内容身份（分 P 增删后 p 漂移会让去重/同步/重下指向另一段音频）；规范化时联网解析 p→cid（Go 版下载流程本就先解析 cid 再取流）；`source_url` 保留 `?p=N` 作展示/打开入口（R8 已按此修订） |
| R31 | **取消 `--force`**：daemon 存活时**一律禁止 direct 写**——进程内的播放/下载/清理互斥无法跨进程共享，删歌/导入等文件操作会与其竞争（R25 已按此修订，推翻二轮的限权方案） |
| R32 | v0.2 design doc 必审清单补三项：①**同 provider key 跨设备合并策略**（两设备以不同 UUID 建同 key 歌曲时，unique index 冲突走 merge 而非同步 apply 直接失败）②**server-normalized HLC + v0.1 本地时间戳首次注册 rebase**（owl `hlc.ts` 修过「快时钟永久赢冲突」）③**稀疏 rank 归一化与并发插入的同步语义**（一次归一化不得制造整单 change storm） |

## 2. 架构总览

### 2.1 Monorepo（五个 workspace，对齐 owl）

```
lark/
├── packages/
│   ├── shared/     # @lark/shared — Node-free 线协议：类型、HTTP client/transport、SSE client、api-paths
│   ├── core/       # @lark/core — 业务逻辑：db(drizzle)、config(toml)、songs/playlists、下载引擎、歌词、缓存、logger
│   ├── daemon/     # @lark/daemon — Fastify server + routes + 下载队列 wiring + ./cli 入口（lark daemon）
│   └── gui/        # @lark/gui — Electron main/preload/renderer (React + shadcn/ui + Tailwind v4 + zustand)
├── apps/
│   └── cli/        # @lark/cli — 对外 CLI（发布名 @orpheus-aviary/lark-cli）
└── docs/
```

依赖方向：`shared ← core ← daemon ← gui`；`cli → core`（+ 自带 HTTP backend）。core 禁止 import daemon/Electron（沿用 owl 的 check 脚本思路）。

### 2.2 运行时数据流

```
GUI renderer ──HTTP──▶ daemon(Fastify) ──▶ core ──▶ songs.db + songs/<uuid>/
     ▲                    │
     └────SSE /events─────┘        （下载进度、player:command、cache:evicted…）

CLI（默认）──HTTP──▶ daemon
CLI --direct ─────▶ core（同一写入路径；仅限曲库/歌单操作）

音频播放：renderer <audio src="lark-media://song/<id>">
          └─ Electron main protocol.handle 代理 ──▶ daemon GET /audio/:id（附 Bearer，透传 Range/206）
播放状态：renderer 定期 POST /player/report ──▶ daemon 持有状态供 /player/status 查询
远程控制：POST /player/* ──▶ daemon（生成 request_id）──SSE──▶ renderer 执行 ──▶ POST /player/ack
```

与 owl 的关键差异：**播放器在 renderer**（daemon 只存状态、转发命令），所以播放类 CLI 命令依赖 GUI 存活 —— GUI 的 SSE 连接（带 `role=gui`）即在线凭证，CLI 发现无 GUI 在线时自动拉起 GUI 再下发命令。

### 2.3 复用 owl 的既定模式（不再重新设计）

- Fastify `buildServer(ctx: AppContext)` + `registerXRoutes(app, ctx)` + `ok/created/fail` 信封 helper
- PID 锁（`openSync 'wx'` + 活性检测）、`GET /status` 探活、0600 本地 token（Bearer）鉴权
- GUI 用 `ELECTRON_RUN_AS_NODE` spawn daemon（detached + unref），pid 匹配确权
- better-sqlite3 + drizzle + 手写编号 SQL migration（`PRAGMA user_version` runner，事务内执行）
- 时间字段一律 INTEGER Unix-ms
- smol-toml 配置深合并默认值；LLM 字段缺省回退 `~/orpheus-aviary-nest/aviary/aviary_config.toml`
- pino + pino-roll 日志、token redact
- renderer↔daemon 走 HTTP（`configureTransport` 注入 baseUrl/auth），fetch-based SSE（可带 header）；IPC 只留 OS 事务（文件对话框、openExternal、退出确认、拉起）
- CLI 双后端（http/direct 两实现一个接口）、写操作 daemon 存活时一律禁 direct（R31，无 `--force`）
- justfile + better-sqlite3 Node/Electron ABI 切换 recipe + electron-builder mac arm64 dmg + ad-hoc codesign

### 2.4 媒体访问与鉴权（R5/R21，M0 定稿 + spike 验证）

- daemon 全接口统一 Bearer 鉴权（`GET /status` 除外），`/audio` 不做放行特例、不签发 query token。
- **token 模型对齐 owl（R21/R29）**：token 由 **daemon** 内存生成、成功监听后**原子发布** 0600 文件（owl `local-token.ts` 模式——daemon 可独立于 GUI 运行，token 归 daemon 所有）；Electron main 只把文件路径传给 preload；preload 的 `getDaemonToken()` 与 main 的媒体代理**每次调用都重新读文件**，天然适应 token 轮换（daemon 重启换 token）。renderer 经 `configureTransport` 把 token 注入 Authorization header，HTTP 与 fetch-based SSE 都走这条路。接受可信 renderer 持有本地 daemon token；硬约束是 token **不进 URL、不进 DOM、不进日志（pino redact）、不进媒体 src**。
- renderer 的 `<audio>` 指向 `lark-media://song/<uuid>`（媒体 src 无法带 header，也不许带 token）；Electron main 用 `protocol.handle` 将其代理为对 daemon `GET /audio/:id` 的请求：main 自行读 token 文件附 `Authorization`、透传 `Range` 请求头与 `206/Content-Range` 响应，流式转发。
- daemon 侧 `GET /audio/:id` 支持 Range（seek 必需），响应流式读文件，并更新 `last_accessed_at`。
- **M0 spike（R21）：已验证 2026-07-31（Electron 43.2.0），六项判据全过，本节维持，fallback 未启用。** 实测记录、定稿参数与 M4 移植清单见 `2026-07-31-m0-scaffold-media-spike.md` §6。定稿要点：privileges = `{ standard, stream, supportFetchAPI }`；`net.fetch` 回程必须透传 `Content-Length` 与 `Accept-Ranges`（漏则总时长/可 seek 判定错）；判据 4 的标准修订为「并发流有上界且不随 seek 次数增长」（Chromium multibuffer 会保留约 6 条 range 连接），因此 `/audio` 必须尊重 backpressure、按多流预算 fd、在 `close`/`error` 上一次性清理。
- fallback（未启用，留档）：带作用域、短时、可刷新的签名媒体 URL + pino 脱敏。
- CLI/agent 不拉音频流（播放发生在 GUI）。

## 3. 数据模型（schema v1）

### 3.1 表结构

```sql
songs (
  id               TEXT PRIMARY KEY,            -- uuid v4；一切外部来源 id 先过格式强校验再参与文件路径（R10）
  name             TEXT NOT NULL,
  artist           TEXT NOT NULL DEFAULT '',
  source_url       TEXT,                        -- 规范化来源页链接，展示/复制/打开用
  source_provider  TEXT,                        -- 'bilibili' | NULL（手填的非 b 站链接只能复制/打开，不能驱动下载）
  source_key       TEXT,                        -- provider 内规范身份：bilibili = 'bvid:cid'（p 只是位置，R30）；去重与重下依据（R8）
  file_origin      TEXT NOT NULL DEFAULT 'downloaded'
                     CHECK (file_origin IN ('downloaded','imported')),  -- 当前磁盘文件的来源（R1/R23）
  lyrics_offset    REAL NOT NULL DEFAULT 0,
  duration         REAL NOT NULL DEFAULT 0,     -- 秒
  pinned           INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)), -- 固定不清理（本地偏好，不进 sync）
  last_accessed_at INTEGER,                     -- LRU 依据（本地行为数据，不进 sync）
  created_at       INTEGER NOT NULL,            -- 同步的不可变字段（R19）
  updated_at       INTEGER NOT NULL,
  device_id        TEXT,                        -- 仅存 skybridge 注册 ID，注册前 NULL（R18）；本地身份见 local_metadata.device_uuid
  lww_counter      INTEGER NOT NULL DEFAULT 0,
  CHECK ((source_provider IS NULL) = (source_key IS NULL))             -- 同空同有（R23）
)
CREATE UNIQUE INDEX idx_songs_source_key ON songs(source_provider, source_key)
  WHERE source_provider IS NOT NULL;            -- provider key 即身份，并发防重（R12/R23）

playlists (                                     -- all 虚拟化，无 is_system（R3）
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,                 -- 同步不可变（R19）
  updated_at  INTEGER NOT NULL,
  device_id   TEXT,                             -- 同 songs.device_id（R18）
  lww_counter INTEGER NOT NULL DEFAULT 0
)

playlist_songs (
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  song_id     TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  rank        REAL NOT NULL,                    -- 稀疏 rank：插入取间隙中点，间隙耗尽整表归一化（R7）；读取一律 ORDER BY rank, song_id（R23）
  added_at    INTEGER NOT NULL,                 -- 同步不可变（R19）
  updated_at  INTEGER NOT NULL,
  device_id   TEXT,                             -- 同 songs.device_id（R18）
  lww_counter INTEGER NOT NULL DEFAULT 0,       -- 未来 LWW 同步实体（R19）
  PRIMARY KEY (playlist_id, song_id)
)

-- skybridge 三表：照 owl 0004+0005+0007 最终形态建表；v0.1 不写入（R2）
sync_changes (local_seq PK AUTOINCREMENT, device_id, entity_type, entity_id, op,
              payload, created_at, client_change_id UNIQUE, server_seq, synced_at,
              partial index on synced_at IS NULL)
sync_cursor (endpoint PK, pulled_seq, pushed_seq, updated_at)
conflict_record (占位，含 losing_side/payload 列)

local_metadata (key PK, value)                  -- device_uuid = 安装实例本地身份（首次启动生成，与 skybridge device_id 分域，R18）等
```

- `has_file` / `file_size` 不进 DB，由磁盘探测派生（与缓存清理天然一致）。
- 磁盘布局不变：`~/orpheus-aviary-nest/lark/songs/<uuid>/{song.mp3, lyrics.lrc}`。清理只删 `song.mp3`，**歌词文件永不清理**。
- `file_origin` 语义 = **当前磁盘文件**的来源：下载管线每次成功写文件置 `downloaded`；本地导入写文件置 `imported`。imported 歌曲手动「重新下载」成功后文件被下载管线重写，自然翻转为 `downloaded`（此后可清理，符合「可确定性重下」语义）。
- **「全部歌曲」为虚拟视图**：API/GUI 中 id 字面量 `all`，内容 = 全部 songs，顺序 = created_at；不可改名/删除/自定义排序。
- **sync 范围划线**（v0.2 生效）：`name/artist/source_url/source_provider/source_key/lyrics_offset/duration` + `created_at`（不可变）进 change log；`pinned/last_accessed_at/file_origin` 是设备本地数据，不同步。
- **本地字段与同步字段隔离（R18）**：pinned / last_accessed_at / file_origin 的更新走独立函数，不触碰 `updated_at` / `device_id` / `lww_counter`，避免本地行为污染 LWW 比较。
- 所有写入收敛到 core 单一路径（GUI/CLI/--direct 同函数），v0.2 在这些函数内补 `emitSyncChange` 是机械改动。

### 3.2 sync 预留策略（R2/R18）

v0.1：建表 + `updated_at`/`lww_counter`/`created_at` 随业务写入维护（这些事后无法回补）；实体 `device_id` 仅存 **skybridge 注册 ID**，注册前一律 NULL——本地安装身份放 `local_metadata.device_uuid`，两个身份域不混用（owl 曾因混用补 `0006_device_id_split` 迁移）；**不写 `sync_changes` 事件**，不冻结 payload。
v0.2 开工 design doc 必须冻结：payload schema + 协议版本、删除墓碑语义、LWW 三元组 `(updated_at, lww_counter, device_id)` 比较、注册后**先回填本机既有实体的 device_id、再全量 create-op 回填**（owl `0008` 模式）、单账户单资料库（R13，已定）。

### 3.3 Go 版 songs.db 一次性迁移协议（R4/R20）

已实测旧库：`user_version=0`，20 首歌 / 3 歌单 / 24 成员关系，无孤儿/重复/非法时间戳，DELETE journal 模式，数据可迁移。协议对齐 owl `migrate.ts` 的锁 + checkpoint + backup + swap-rollback 流程：

1. **迁移锁**：独立 `.migrate.lock`（`O_EXCL` 创建、写入 pid、陈旧锁按进程活性回收），与 daemon PID 锁分离；两个迁移命令并发时后者直接失败。**（M1 三轮评审修订：机制改为常驻 SQLite 锁库上 `BEGIN EXCLUSIVE` 的内核 advisory lock——O_EXCL + pid 的陈旧锁回收存在 compare-and-delete 竞态；互斥语义不变、崩溃由内核自动释放，锁文件永不删除。见 m1 子计划 M1-10）**
2. **预检与 DB 级排他**：旧 Go daemon 探活（旧 `daemon.pid` + 47020 `/status`）作为友好提示先行拒绝；随后以 **`locking_mode=EXCLUSIVE` 打开旧库**取得数据库级独占——覆盖「旧 daemon 已开库但尚未写 pid/监听端口」的窗口，也挡外部 SQLite 工具；若旧库为 WAL 先 `wal_checkpoint(TRUNCATE)` 并确认 `-wal`/`-shm` 清空（实测为 DELETE journal，此步幂等）；`PRAGMA integrity_check` + 预期表/列结构比对（songs/playlists/playlist_songs），不符即中止。
3. **备份**：用 **SQLite backup API**（一致性快照，非普通文件复制）→ `songs.db.bak-go-<ISO时间戳>`（不覆盖既有备份）。
4. **临时库**：新建 `songs.db.migrating` 按 v1 schema 建表（建表时 stamp user_version），从旧库只读搬数据：
   - songs：RFC3339 TEXT → unix-ms（解析失败 → 迁移时刻 + 记日志）；`source_*` = NULL；**`file_origin = 'imported'`**（保守：迁移曲库不参与自动清理，显式重下后自然翻转）；`last_accessed_at = created_at`；**`device_id = NULL`**（R18，注册 ID 域）。
   - playlists：`list_name` → `name`；Go 版无时间戳 → created_at/updated_at = 迁移时刻；**丢弃 all 行**。
   - playlist_songs：`position` n → `rank = (n+1) * 1024.0`；丢弃 all 的成员行；时间字段 = 迁移时刻。
5. **验收**：行数对账（songs、非 all 歌单、非 all 成员关系）、`PRAGMA foreign_key_check`、临时库 `integrity_check`、UUID 格式校验、每歌单 rank 严格递增。任一失败 → 删除临时库、报错退出（源库未动）。
6. **原子交换（可回滚）**：`songs.db` → `songs.db.old-swap` → `songs.db.migrating` rename 就位；第二步失败则把 `.old-swap` 原位恢复；成功后删除 `.old-swap`。
7. **幂等重试**：启动发现 `.migrating` 残留 → 删除重来（源库从未被写）；发现 `.old-swap` 且主库缺失 → 先恢复 `.old-swap` 再重来；陈旧 `.migrate.lock` → 活性判定后回收。

## 4. daemon HTTP API（v1）

统一信封 `{success, data, message, error_code, total}`、URL kebab-case、JSON snake_case。除 `GET /status` 外全部 Bearer 鉴权。**信封例外（R15）**：`GET /audio/:id`（二进制 + Range/206）、`GET /lyrics/:id`（text/plain LRC）、`GET /events`（SSE）。

| 组 | 端点 |
|---|---|
| 系统 | `GET /status` · `GET /api/capabilities`（自描述，供 agent 发现） |
| 歌曲 | `GET /songs`（搜索/分页/排序，enrich has_file/file_size）· `GET|PUT|DELETE /songs/:id` · `POST /songs/import`（本地 mp3，file_origin=imported）· `PUT /songs/:id/pin` |
| 链接 | `PUT /songs/:id`（含 source_url 编辑，服务端规范化出 provider/key）· `POST /songs/:id/recognize-url`（**纯预览**：LLM 识别返回候选，不写库，R6）· `POST /songs/:id/redownload`（凭 source_key 确定性重下） |
| 文件 | `GET /audio/:id`（Range 流式 + 更新 last_accessed_at）· `GET|DELETE /lyrics/:id` · `POST /download/lyrics/:id`（重下歌词） |
| 歌单 | `GET|POST /playlists`（列表含虚拟 all + 曲数）· `GET|PUT|DELETE /playlists/:id` · `GET /playlists/:id/songs` · `POST /playlists/:id/songs` · `DELETE /playlists/:id/songs/:songId` · `POST /playlists/:id/reorder`（稀疏 rank，单行更新）。**虚拟 all 只读**：改名/删除/增删成员/reorder 一律 `400 VIRTUAL_PLAYLIST`（R24） |
| 导入导出 | `GET /playlists/:id/export`（`all` 可用）· `POST /playlists/import`（target: all＝仅入库 / 指定歌单 / 新建歌单；schema 校验 + 大小/曲数上限，**单事务全量成败**，R27） |
| 播放器 | `GET /player/status` · `POST /player/{play, play-playlist, switch-playlist, pause, resume, next, prev, seek, mode, report}`（命令类返回前等待 GUI ack，3s 超时 `GUI_TIMEOUT`）· `POST /player/ack` · `POST /gui/register`（辅助信息；在线判定以 SSE 连接为准，R11） |
| 下载 | `POST /download/song` · `POST /download/parse`（批量文本解析）· `POST /download/batch` · `POST /download/fetch-list`（收藏夹/合集展开）· `POST /download/cancel`（按任务 id） |
| 缓存 | `GET /cache/status`（已用字节/曲数/上限/可清理字节/`unreclaimable_bytes`/`limit_satisfied`，R26）· `POST /cache/evict`（立即清理，响应含同上字段） |
| 配置 | `GET /config`（api_key 脱敏）· `PATCH /config`（白名单字段 + 校验，R14） |
| 事件 | `GET /events`（SSE，`?role=gui` 标识 GUI 连接）：`download:status|complete|error`、`player:command`（含 request_id）、`cache:evicted`、`songs:changed`、`playlists:changed` |

## 5. 核心流程设计

### 5.1 下载管线（链接优先）

沿用 Go 版全链路（单 worker 队列 + 阶段性 SSE 进度 + 可取消），LLM prompt 直接移植（analyze / select / multi-P / inferSongInfo / lyricsSelect / batchAnalyze），bilibili 端点不变（search、pagelist、view、playurl fnval=16 取最高码率、fav/collection 分页）。歌词三平台并行（网易云/QQ/酷狗）。

**取文件统一入口** `resolveSongFile(song)`：

```
文件存在 ──────────────────────────────▶ 直接用
文件缺失:
  有 source_key → 校验（view/pagelist 查 bvid 存活 + cid 仍在）
      有效 → playurl → 下载 → ffmpeg 转 mp3 → 原子落盘，file_origin=downloaded
      失效 → 走识别分支（下）并覆盖回写 source_*
  无 source_key → LLM 识别（name+artist → 搜索 → 选 bvid → 多 P 选集）
      → 回写 source_url/provider/key → 下载
```

- **每次成功下载都回写 `source_url` + `source_provider` + `source_key`**（含批量与关键词下载）；URL 写入时规范化（`https://www.bilibili.com/video/BV…?p=N`，剥离跟踪参数）；`source_key` 写 **`bvid:cid`**——下载流程本就先解析 cid 再取流，cid 才是稳定内容身份（R30）。
- **原子文件操作（R9/R22，覆盖全部写路径）**：下载写 `songs/<uuid>/.song.mp3.tmp` → rename `song.mp3`；本地导入复制到临时文件 → 校验（音频可解析）→ rename → 再提交 DB，失败清理临时文件；删除歌曲先把目录 rename 进 `trash/` → 提交 DB → 异步删除（DB 失败则目录恢复原位）；歌词写入同样临时文件 + rename。失败一律保留旧文件。队列按 song/任务合并去重；取消按任务 id；清理与进行中的下载/播放互斥。
- 播放无文件歌曲自动触发 resolveSongFile，完成后自动开播（Go 版置灰不可播；行为变化已确认）。
- **LLM 降级（R16）**：直链 URL（单 P 或带 `?p`）与凭 source_key 重下**不依赖 LLM**；关键词搜索、自动识别、多 P 无 p 选集、歌名歌手推断、歌词精选需要 LLM（未配置时明确报错提示；歌词降级为字符串相似度启发式选首个有效候选）。
- ffmpeg/ffprobe 路径解析：优先打包内二进制（extraResources），回退系统 PATH（开发态）。

### 5.2 缓存模型（统一）

**清理资格不变量（R1/R26）**：可清理 ⇔ `file_origin='downloaded'` ∧ `source_provider='bilibili'` ∧ source_key 有效 ∧ `pinned=0` ∧ 非当前播放 ∧ 无进行中下载任务。**imported 文件（含 Go 迁移曲库）永不自动清理**——用户资产只能手动删除。

- **「source_key 有效」= 清理前逐候选联网探活**（view API 确认视频与分 P 仍在）；视频已失效或网络失败一律 **fail closed** 跳过该文件，只删确认可重下的（R26）。
- **不可回收超限**：当 imported/固定/播放中文件合计已超上限，`/cache/status` 与清理结果返回 `limit_satisfied=false` + `unreclaimable_bytes`，GUI 明示原因，不做无效清理循环（R26）。

- 配置 `[storage] cache_limit_mb = 0`（0 = 不限，默认，等同旧版）。
- 记账：实时扫描 `songs/*/song.mp3` 大小合计（曲库量级小，不做增量账本）。
- 触发：每次下载完成后、daemon 启动时、手动 `POST /cache/evict`。
- 顺序：符合资格者按 `last_accessed_at` 升序删 `song.mp3` 直至低于上限；**保留 lyrics.lrc 和 DB 记录**；逐条发 `cache:evicted`。
- `last_accessed_at` 更新点：`GET /audio/:id` 被拉取、下载完成、本地导入。
- GUI：设置页显示已用/可清理空间、上限下拉、立即清理；列表待下载状态标识；右键「固定/取消固定」。

### 5.3 歌单导入导出

导出文件格式（JSON，UTF-8，**不含歌曲 id**——导入一律新生成 UUID，R10）：

```json
{
  "format": "lark-playlist",
  "version": 1,
  "exported_at": 1789000000000,
  "playlist": { "name": "健身歌单" },
  "songs": [
    { "name": "...", "artist": "...", "source_url": "https://www.bilibili.com/video/BV...?p=2",
      "source_provider": "bilibili", "source_key": "BV...:279786001",
      "lyrics_offset": 0.5, "duration": 213.4 }
  ]
}
```

- **导出**：任意歌单含虚拟 all；GUI 走 Electron 保存对话框（IPC），CLI 写指定路径。**显式包含 `source_provider`/`source_key`**（round-trip 去重不受未来 URL 规范化逻辑变化影响，R27）。
- **导入校验（R27）**：JSON schema 校验 + 上限（≤ 10 000 首或 ≤ 20 MB，超出报错）；未知 `version` → `UNSUPPORTED_FORMAT_VERSION`；**单事务全量成败**，不做部分成功；导入到现有歌单时按文件顺序追加到末尾。
- **导入**：选文件 → 解析预览（曲数、去重结果、疑似重复列表）→ 目标选择：**导入到 all（＝仅入库）/ 指定歌单 / 新建歌单（默认名取文件内 playlist.name）**。
- **去重（R12）**：仅 `(source_provider, source_key)` 相同视为同一首歌，复用原条目只加歌单；歌名+歌手相同但 key 不同（或无 key）→ 预览中标「疑似重复」，用户勾选决定，**默认导入为新条目**（避免误合并 live/remix/不同版本）。
- **按需下载**：导入不触发下载，文件在播放/手动重下时按 §5.1 获取。

### 5.4 GUI（功能对齐 Go 版 + 新增）

对齐 Go 版：歌单下拉管理（建/改/删，all 保护）、歌曲列表（可选列、列宽拖拽、双击内联编辑、双击播放）、搜索（跨全库）、排序（默认/名称/歌手/时间，中文 locale）、播放控制（4 模式、进度条 seek、快捷键空格/←→/↑↓）、歌词 3 行同步 + offset 微调 ±0.5s、下载栏 + 批量下载/选择弹窗 + 实时进度 + 取消、本地 mp3 导入、Toast、自动深浅主题、字号配置。

新增/修正：

- **右键菜单**（shadcn ContextMenu）：播放 · 添加到歌单 ▸ · 从当前歌单移除 · **复制链接 · 打开链接 · 编辑链接…** · **固定/取消固定** · **重新下载** · 重新下载歌词 · 删除歌词 · 复制歌曲 ID · 删除歌曲。无链接时复制/打开置灰。
- **打开链接**：经 main IPC `shell.openExternal`，**仅放行 http/https**（R10）；同步/导入来源的 URL 同样过此闸。
- **编辑链接对话框**：URL 输入框 + [取消] [自动识别] [保存]。自动识别调预览接口（R6）填输入框不落库；取消不产生任何写入；保存时服务端规范化并校验（联网解析 p→cid 得 `source_key`，失败提示稍后重试）；若已有文件且 key 变更，追问「是否立即按新链接重新下载？」；若规范化后的 key 与库中另一首歌冲突（unique index，R23），提示「该链接已属于《x》」并可跳转，不覆盖。
- **排序语义（R24）**：用户歌单默认顺序 = manual rank（**拖拽仅此模式可用**）；名称/歌手/时间排序是临时视图不写库；虚拟 all 固定按创建时间（created_at 同步不可变，跨设备一致）。
- **歌单拖拽排序**（dnd-kit + 稀疏 rank，修复 Go 版 reorder 断链）。
- **设置页**：LLM 配置（api_key 只写不回显）、缓存上限、显示列、字号、端口只读展示。
- 技术：zustand 按域分 store + data-bus 通知刷新（owl 模式）、platform adapter 隔离 preload、`lark-media://` 音频代理（§2.4）。

### 5.5 CLI（@lark/cli，供调试与 jay/agent 调用）

双后端：默认 HTTP；`--direct` 走 core（仅曲库/歌单/导入导出等 DB 操作；下载和播放控制必须有 daemon）。**daemon 存活时一律禁止 direct 写，无 `--force` 逃生门**——进程内的播放/下载/清理互斥无法跨进程共享（R31）；读操作任何时候都放行。`<name|id>` 参数在歌单名重复时报 `AMBIGUOUS_PLAYLIST` 并列出候选 id（不强制歌单名唯一，R25）。全局 `--json` 供 agent 消费。

```
lark status | daemon | stop-daemon
lark download <关键词或URL> [--playlist <name|id>]        # 批量: --batch <file|stdin>
lark songs list|search|get|edit|delete [--json]
lark songs url get|set|recognize <song>                    # recognize 为预览，需 --save 显式写入
lark songs redownload <song>
lark playlist list|create|rename|delete|add|remove|reorder
lark playlist export <name|all> -o file.json
lark playlist import file.json [--to all|<name>|--new <name>]
lark play <song|--playlist <name>> | pause | resume | next | prev | seek <s> | mode <m>
lark now-playing
lark lyrics redownload|delete <song>
lark cache status|evict
lark gui                                                   # 拉起 GUI
lark skill export                                          # 生成 agent skills 文档（对齐 owl）
```

播放类命令若探测到无 GUI 在线（SSE 判定）→ 自动 `open -a Lark`（dev 态 spawn）→ 等上线 → 下发命令并等 ack。

## 6. 里程碑（v0.1 内部切片）

每个里程碑完成标准：`just check`（biome + tsc -b + 守卫脚本）+ 对应测试绿 + 用户验收关键路径。

| # | 内容 | 要点 |
|---|---|---|
| **M0 脚手架 + 媒体 spike** | pnpm workspace、tsconfig.base（strict/NodeNext）、Biome、justfile、**五包骨架**、信封 helper、`GET /status` 端到端跑通、**`lark-media://` Electron spike（R21：协议注册/Range 透传/206/连续 seek/CSP/token 轮换）** | spike 不通过 → 启用签名 URL fallback 并回改 §2.4 |
| **M1 core 数据层** | config/paths/logger、schema v1（CHECK/unique index 齐备）+ migration runner、device_uuid 初始化、songs/playlists CRUD（core 单一写入路径，本地字段独立更新路径）、**Go 迁移协议 §3.3 实现**（DB 级排他 + backup API + 原子交换，真实旧库 fixture 测试） | sync 三表建表即止 |
| **M2 daemon 基础路由** | buildServer + PID 锁 + Bearer 鉴权 + SSE EventsBus（含 role=gui 在线判定、player 命令 ack 链路）+ routes：status/capabilities/songs/playlists/audio（Range）/lyrics/player/config(PATCH)/events | 链接/缓存/导入导出路由不在此（见 M3/M5） |
| **M3 下载管线 + 链接路由** | LLM client（aviary 回退、`<think>` 剥离）、bilibili 搜索/选集/playurl、URL 规范化（provider/key）、ffmpeg 封装、歌词三平台 + LLM 精选（含无 LLM 降级）、队列/进度/取消/原子落盘、**resolveSongFile + source_* 回写**、routes：recognize-url（预览）/redownload/download/*、网络层 mock 测试 | Go 版 prompt 直接移植 |
| **M4 GUI 基座** | electron-vite 三段、daemon spawn/确权、单实例、窗口管理、platform adapter、**lark-media:// 协议代理**、播放器 + 列表 + 歌单 + 搜索排序 + 歌词面板 + 快捷键 + 下载栏/批量弹窗 —— 功能对齐 Go 版 | |
| **M5 新特性 + 对应路由** | 链接右键三件套 + 编辑链接对话框、缓存上限 + LRU + 固定 + `/cache/*` 路由 + 设置页、导入导出（`/playlists/import|export` + 目标选择/疑似重复 UI）、拖拽 reorder、播放触发按需下载 | 本计划核心增量 |
| **M6 CLI** | commander + 双后端 + §5.5 全部命令 + GUI 拉起 + skill export + 测试 | |
| **M7 打包发布 v0.1.0** | electron-builder（mac arm64 dmg、**asar:false**、**ad-hoc 签名——个人/内部发行，不做公证，R28**）、**ffmpeg-static/ffprobe-static 锁版本 + extraResources + 打包后冒烟测试（可执行/签名/Range 播放）**、FFmpeg 许可声明与源码获取方式随包交付、ABI 切换 recipe、手动验收清单、发版 | |

## 7. 后续版本

- **v0.2 skybridge 接入**：开工前 design doc **冻结 sync v1 协议**——payload schema + 协议版本、删除墓碑、LWW 三元组 `(updated_at, lww_counter, device_id)` 比较、**全量 create-op 回填**（owl `0008` 模式，覆盖迁移与 v0.1 期间产生的全部实体）、歌词文本策略（倾向 change log）、conflict UI，以及 R32 三项必审：**同 provider key 跨设备合并策略**（unique index 冲突走 merge 而非 apply 失败）、**server-normalized HLC + v0.1 本地时间戳注册 rebase**（owl `hlc.ts` 快时钟教训）、**稀疏 rank 归一化的同步语义**（防整单 change storm）。已定：单账户单资料库（R13）。同步实体：song 元数据（含 source_*）、playlist、playlist_songs。技术复用 owl P5 模式（session/sse-bridge/scheduler/withRetry/conflicts），`@orpheus-aviary/skybridge-{proto,client}` 直接 npm 装。
- **v0.3+ 移动版设计**：单独 design doc。方向：RN app，元数据走 skybridge，音频凭 source_key 在端上直接向 bilibili 取流 + 本地小缓存（与桌面共用清理语义）。aviary 已于 2026-07-04 推翻「不做移动端」。

## 8. 风险与注意

| 风险 | 对策 |
|---|---|
| bilibili 接口风控变化（搜索接口可能要求 WBI 签名） | 移植时实测；WBI 参考取 lark-go **历史提交**（当前分支已无该实现）或社区文档 |
| LLM 未配置 | 确定性路径不受影响（R16）；依赖 LLM 的功能明确报错并指引设置页 |
| ffmpeg GPL 许可 | **分发即触发义务（与是否收费无关）**：锁定构建来源与版本，随包附 FFmpeg 许可声明 + 对应源码获取方式；如组件配置有疑义再评估自建 LGPL 构建 |
| `<audio>`/EventSource 无法带鉴权头 | token 对齐 owl（preload→renderer，禁 URL/DOM/日志/媒体 src）+ `lark-media://` 主进程代理；**M0 spike 先行验证**，不通过则签名 URL fallback（R21） |
| better-sqlite3 Node/Electron ABI 冲突 | 照抄 owl justfile ensure-abi recipes |
| Go DB 迁移 | §3.3 协议：互斥 + 时间戳备份 + 临时库 + 验收 + 原子交换 + 幂等重试；真实旧库 fixture 单测 |
| 端口 47020 → 47100 | 未发现 jay 现有硬编码集成，风险低；发版说明标注即可 |

## 9. 开放议题与跨仓待办

- v0.2 歌词文本走 change log 还是 attachment（文件小，倾向 change log，design doc 定）
- 移动版取流的 Referer/UA 限制实测（RN 侧可控请求头，理论可行）
- jay 工具调用协议：`lark skill export` 输出格式与 owl 对齐后，jay 侧消费方式（jay TS 化时定）
- **跨仓待办**：`aviary/docs/ROADMAP.md` 主线图把 lark 排在 owl 1.0.0 之后，与「owl skybridge 对接稳定（Phase 3+）即可启动」的文字条件不一致——本次启动以文字条件为准（用户 2026-07-16 拍板），ROADMAP 图示与 lark 状态行待同步更新
- 播放记录（play history）**不在 v0.1/v0.2 范围**：仅有本地 `last_accessed_at`；README 原「同步播放记录」表述已修正
