# v0.3.0 子计划：m4a 统一 + 一次性迁移 + PC 改进三项

> 2026-08-13 **v3（九轮评审定稿）**；2026-08-14 T2 开工时补 **§9 附表 A（错误分型映射表，冻结）**——§2.2 承诺的那张表，先于 converter 落地。上级契约 = 主计划 `2026-08-13-m4a-and-mobile-master-plan.md`（**v11**）§3——其中 §3.2 状态机为锁定项，本子计划只补实现细节，任何语义出入以主计划为准。**Go 迁移自 0.3.0 停止支持且直接删除实现**（用户拍板，见 §2.3）。
>
> 实施按 T0–T6 分批，每批提交前给用户看 commit 信息；`PROCESS.md` 记录逐批实测。

---

## §1 callsite 清单（2026-08-13 rg 实测，主计划要求的第一交付物）

### 1.1 生产代码（非测试）——全部「必改」

| 位置 | 内容 | 归属批次 |
|---|---|---|
| `core/src/library/lyrics.ts:29-31` | `songAudioPath()` = `songs/<id>/song.mp3`（唯一路径真相源） | T1 |
| `core/src/library/songs.ts:436` | `songFileInfo()` 自拼 `song.mp3`（绕过真相源） | T1——签名改 **`songFileInfo(id, { audioMode: 'canonical' \| 'migration-pending' })`**，mode 由 daemon/direct 各自从 SQLite pending 标记派生后显式传入（路径函数不隐式读全局 DB） |
| `core/src/download/resolve.ts:55,66,84,86,97,104,267,330,357` | `AUDIO_FILE`、转码 tmp 名 `.song.<id>.mp3.tmp`、had_old 注释、**orphan 判定 :330**、恢复读 :357 | T1（常量/命名）+ T2（恢复版本化） |
| `core/src/sync/file-ops.ts:634` | 隔离 `moveInto(..., 'song.mp3')` 字面量 | T1（新 op 走 canonical）+ T2（旧 op legacy 分支） |
| `core/src/download/ffmpeg.ts:46-73,124-128` | `ensureMp3()`（`-f mp3` + libmp3lame）、`isMp3Format()` | T1（→ `processAudio` remux/转码 + `isAacMp4Format`） |
| `core/src/download/pipeline.ts:35,285` | `ensureMp3` 调用与 tmp 注释 | T1 |
| `core/src/download/import.ts:37,77,107` | 扩展名闸门「只支持 .mp3」+ `isMp3Format` 校验 | T4（导入矩阵重做） |
| `core/src/media-tools/capabilities.ts:35-38` | 能力清单 `demuxers/decoders/muxers` 含 mp3、缺 aac encoder/ipod | T0a/T1b |
| `daemon/src/routes/media.ts:135` | `Content-Type: audio/mpeg` 硬编码 | T1 |
| `daemon/src/routes/songs.ts:239` · `system.ts:154` | 注释/能力描述「mp3」 | T4 |
| `shared/src/types.ts:82,224` | doc 注释（import body、cache 统计） | T1/T4 |
| `gui` preload/ipc/lark-api/dialog-ipc/platform/Controls（6 文件） | `pickMp3` 全链 + 文件过滤器 `['mp3']` | T4（→ `pickAudio`） |
| `apps/cli/src` | **零命中**（生产代码无 mp3 假设） | — |

### 1.2 测试与脚本

| 位置 | 命中 | 处理 |
|---|---|---|
| core 测试 68 处 / daemon 20 / gui 13 | 夹具与断言用 `.mp3` | T1/T2 随批改；**迁移/Go 库/0002 相关保留为 legacy fixture** |
| `scripts/vendor-ffmpeg.mjs:145,238-275` | libmp3lame 检测 + 闭环产 mp3 | T0a 加能力/闭环，T1b 移除 LAME |
| `scripts/accept-pack.mjs:207-222` | 闭环判据产 mp3；另有 `LOCAL_API_VERSION` 字面量（发版滞后教训） | **T5 协议定稿批**同批改，T6 复核 |
| `scripts/accept-m5.mjs:132` | `songFile = songs/<id>/song.mp3` | T5 定稿批改，T6 复核 |
| `scripts/accept-gui.mjs:35` | spike fixture `fixture.mp3` | T6（见 §4-j：spike 换 m4a 验 `audio/mp4`） |
| `scripts/accept-sync.mjs:790` | `song.mp3` 判据（v1 清单漏收） | T5 定稿批改，T6 复核 |
| `packages/daemon/src/sync/*.e2e.ts` 夹具 | `song.mp3` 断言（v1 清单漏收） | T2/T6 随批 |
| `scripts/gen-notices.mjs:147` | 法务文案「转成 mp3」 | T1b |

## §2 实现落点

### 2.1 供应链（T0）

- `vendor-ffmpeg.mjs` 分两步（**防断链：T0 若直接删 LAME，生产代码的 `ensureMp3` 到 T1 才切换，中间真实下载是坏的**）：**T0a** 加 `--enable-encoder=aac`、`--enable-muxer=ipod` + 生成 tracked mp3 fixture，**LAME 暂留**、新旧闭环并存；**T1b**（应用链切完 m4a 后）删 `--enable-libmp3lame`、encoder/muxer 与 LAME 构建段（`:145` 检测同步删），gate = **全仓无 mp3 产出调用 + 真实 bilibili 下载 m4a 闭环**。保留 mp3 demuxer/decoder/parser（迁移解码用）。
- 闭环判据重做：① `toneWav()` → aac → ipod → ffprobe 验证（新下载/导入链）；② 真 mp3 fixture → aac → ipod（迁移链）。锁值重生成，nonfree 门禁不变。
- `capabilities.ts` 清单：`muxers: ['ipod']`、`encoders: ['aac']`、decoders 增 `alac/vorbis/opus/pcm_*`（按 §4-a 定案后的实际集）。
- gen-notices 文案同步。

### 2.2 canonical 与下载链路（T1）

- `songAudioPath()` → `song.m4a`；`songFileInfo` 收敛回真相源，**pending 标记存在时 legacy-aware（m4a || mp3）**；`AUDIO_FILE = 'song.m4a'`、tmp → `.song.<taskId>.m4a.tmp`（`.song.` 前缀已在 `TEMP_PREFIXES`）。
- `ensureMp3` → **`processAudio(input, output, probe)`**——第三参是完整 `AudioProbe`，不是裸 codec（裸 codec 区分不了 AAC-in-MP4 与 ADTS，也执行不了已锁定的采样率/声道/第一音轨规则）。**`AudioProbe` 契约（冻结）**：`container(format_name) / selected_stream_global_index（**ffprobe 的全局 stream.index**）/ codec / sample_rate / channels + channel_layout / disposition（含 attached_pic）/ has_real_video（非 attached_pic 视频轨判定）/ duration`。执行规则：AAC-in-MP4 → `-c copy -f ipod`；ADTS AAC → copy + `-bsf:a aac_adtstoasc`；其余 → `-c:a aac -b:a 192k`（采样率 >48k 降 48k、声道 >2 降 2，§4-g）；一律 **`-map 0:<selected_stream_global_index>`**——显式 -map 后其余流天然排除；**不许用 `-map 0:a:<n>`**（那是「第 n 条音频流」的序数语义，与全局 index 混用会在封面/视频流排在音频之前时选错流）。
- **错误分型（converter 层，主计划 §3.2-6 原则）**：AbortSignal → 中止；spawn/fs errno（ENOENT/EACCES/ENOSPC）→ 环境；ffmpeg 退出码 + stderr pattern（解码/格式类）→ 内容；**默认环境**。**T2 的第一个提交 = 映射表附表 + 对应 fixture，之后才写 converter**（涉及 R 类删除，表先于实现）。初稿：`Invalid data found when processing input` / `could not find codec parameters` / `Header missing` / `Error while decoding` → 内容；`No space left`（+ errno ENOSPC）/ `Permission denied`（+ EACCES）→ 环境；其余 → 环境。
- bilibili：`BiliAudioStream` 增 `codecs` 字段（DASH `codecs` 属性），候选排序 = AAC（`mp4a.40.*`）内按带宽；无 AAC → 桌面转码路径；`fetchAudio` remux 前断言。
- `media.ts` Content-Type → `audio/mp4`；gui main 的 `lark-media://` handler MIME 同步。

### 2.3 迁移（T2 core + T3 daemon/GUI/CLI）

**core（T2）**，新目录 `core/src/migration/`：
- `0003-audio-m4a.ts`：ledger DDL（主计划 §3.2-8 字段；**主键 = `object_key` 相对目录名、`song_id` nullable**；`backup_path` 存相对 nest 根路径）；**pending 与 `user_version=3` 同一事务原子置（fail-closed）**；fresh 库由 `createDatabase` 在迁移成功后随即清 pending——崩在「commit 后、clear 前」只是 fresh 库多走一次空迁移，方向永远多迁不漏迁（判据 58）；不标 destructive。
- **schema 契约**：`assertSchemaV2` → `assertCurrentSchema`（v3），覆盖 create / readonly / recovery 三个调用点。**Go 支持直接删除**（用户拍板不留死模块）：migrate-go / probe-go / fixture-go-db 代码与测试、justfile recipe，连同 `errors.ts:13` 与 daemon `boot.ts:149` 引导「运行 just migrate-go」的文案——Go 旧库拒绝路径保留，文案改指「用 0.2.x 完成迁移后再升级」。测试三组：fresh daemon / fresh direct / v2 upgrade。
- `scanner.ts`：冻结 total、class 判定（`downloaded && source_key_present && provider 受支持` → R）、被旧 file-op 占用的目录记 `blocked_file_op`。
- `converter.ts`：单曲状态机（主计划 §3.2-7 顺序 + §3.2-6 错误分类 + 弃置前实时探活——探活复用 cache 清理的探活函数，R26 同源）；backup move 禁覆盖（size+SHA-256 比较）。
- `recovery 版本化`：`FileOpArg` 增 `audio_file` 字段 + v2 legacy 分支；landing manifest 增 `version`/`audio_file`，恢复器按版本分派；orphan 判定（`resolve.ts:330`）改双名感知；`.replace` backup / 不可读 manifest / dangling log 全表 legacy 化。
- `migration-backup/` 路径入 `paths.ts`；backup-nest 包含、缓存/同步/recovery 排除。

**daemon/GUI/CLI（T3）**：
- 三层 boot：`context.ts` 拆 **BaseContext**（DB/config/logger/**mediaTools**/token/事件总线/**guiChannel + version/host/port/requestFatal/shutdown 信号**——白名单 handler 所需字段全入 Base，`/events` 要 guiChannel）+ **PendingRuntime**（ledger + runner + 迁移专用 FileEffectRuntime）+ **NormalRuntime**（late-bound）；`server.ts` 路由 listen 前全量注册 + gate 读内存状态机 `pending → activating → normal | fatal`；时序 = listen + 发布 token 后才后台起 runner；NormalRuntime 构建成功并原子 swap 后才置 normal；teardown 覆盖全部状态（先停 ffmpeg 再关 DB）。
- **孤儿与已删歌**（主计划 §3.2-10）：scanner 扫 `songs/` 目录树；journal-owned 目录按 op 快照分类（`blocked_file_op`）；discard 后残留目录整体移 `migration-backup/orphans/`；非 journal-owned 孤儿先走 legacy recovery 既有规则。
- 路由：`/status` 增 `audio_migration` 计数；新增认证 `GET /api/audio-migration`（pending 清除后仍可访问）+ **`POST /api/audio-migration/retry`（blocked_environment 恢复入口：重新预检并继续，GUI「重新检测并继续」按钮）**；白名单放行 file-ops 三端点（与 runner 共享 mutex，处理完 ledger 重扫）。**探活注入**：daemon 组装时把缓存清理同源的 `canRedownload(sourceKey, signal)` 注入 core converter（core 不反向依赖 daemon）。
- GUI：migration boot state（只轮询白名单接口）+ 进度屏（done/total/lost/kept/blocked 明细 + blocked_file_op 处理入口）；设置页「迁移备份」区块——占用字节 + **打开目录（Electron IPC，main 侧 `shell.openPath`）** + **一键清空（认证路由 `POST /api/audio-migration/backup/clear`）：影响预览（列出将删除的 `kept_unconverted` 资产条数与字节——这些是唯一用户资产）+ 强确认 + `pending` 期间禁用 + runner 互斥 + 路径 confinement 只删 backup 目录内；清空后相关 ledger 行记 `backup_cleared`、`backup_path` 置空**（否则 ledger 会谎称 backup 仍在）。
- CLI：pending 时 direct 写拒绝（`AUDIO_MIGRATION_PENDING`）；v2 库 direct 读的 `MIGRATION_PENDING` 提示文案更新。
- **一键批量重下（R 类）**：迁移报告入口 → 逐首 **forced redownload**（复用 `/songs/:id/redownload`，不是 ensure-file）。

### 2.4 导入矩阵（T4）

主计划 §3.4 决策表逐格实现：流选择一律按 §2.2 的**全局 stream.index 规则**（`-map 0:<index>`）、attached_pic 不算视频、含真视频轨拒绝、ALAC 转码、ADTS remux + bsf、mp3/flac/wav(PCM 子集)/ogg 转码、多音轨取第一条音频轨（按全局 index 定位）并在 warnings 注明。**`ImportResultData` 随 v6 协议扩展**（现结构只有 name/reason，装不下已锁定的语义）：`imported[]` 项增 `warnings: string[]`（如「多音轨已取第 1 条」），`failed[]` 项增 `error_code`（§4-c 新码）；GUI/CLI 呈现同步。`pickMp3` → `pickAudio`（过滤器 = 定案格式集）。

### 2.5 PC 三项（T5）

- **命名**：wire 双通道（batch video item 必填 `naming: 'original'|'clean'`；`DownloadSongRequest` 条件必填 `naming_mode`，keyword 禁止）；**naming-mode 全量预检在容量检查与歌单事务之前**（在途任务 + 请求内重复项）；`resolveTarget` 的 clean 分支复用 `inferSongInfo`（**abort 重抛**，其余失败回退原题 + UP 主名）；GUI 弹框（含链接项的提交弹一次，§4-e 记忆默认）+ 批量勾选修复；CLI `--clean-name`；capabilities `llm_available`。
- **阶段**：`DOWNLOAD_STAGES` 增 `naming`（resolving 与 downloading 之间）；snapshot/event 增 `received_bytes`/`total_bytes`（主计划 §3.5 契约：同一 downloading 阶段内单调、节流 + 终值必发）；GUI 进度行 + CLI（TTY 同行刷新 / 非 TTY 阈值打点，`wait.ts` 改造）标签 = 主计划 §3.6-2。
- **面板**：DownloadTasksPopover → 独立面板（当前阶段 + 字节进度 + 排队 + 终态）；操作 = 取消任务 / 清除记录；`POST /download/cancel-all`（§4-f）snapshot + best-effort 逐项结果。

### 2.6 协议（随 T1–T5 分散落地，T6 复核）

`LOCAL_API_VERSION` → 6（`api-paths.ts` 注释记明 v6 内容：audio_format/import_formats/llm_available + naming 字段 + 字节进度 + `naming` stage + `/api/audio-migration`）。

## §3 批次划分

> **进度（2026-08-15）**：T0a ✅ · T1 ✅ · T1b ✅ · **T2 ✅**（六个提交：附表 A + 分型 → 删 Go 迁移 → schema v3 + ledger → recovery 版本化 + `migration-backup/` → scanner → converter）· **T3 ✅**（四个提交：三层 context + 阶段机 + runner → 迁移三路由 + file-ops 白名单 → GUI 迁移屏 + 备份区块 → CLI 口径；判据 15–22、51、59、61 + 真机副本演练）· **T4 ✅**（两个提交：九个真容器夹具 + `toneWav` 扩 PCM → 矩阵本体；判据 31、53）· **T5 ✅**（四个提交 + 一个工具修复：命名清洗 → 阶段与字节进度 → 面板与 cancel-all → 协议升 6；判据 23–30、32）· **T5b ✅**（五个提交，按「谁在撒谎」分组：daemon 三个活设置 → 冲突恢复 → GUI 设置页与右键菜单 → CLI 空转 flag 与 stderr 承诺 → 唯一没解码的标题；F1–F17 全关闭，判据 35–47、54）。逐批实测见 `PROCESS.md`。下一批 **T6**。
>
> **T4 与本表的两处出入**：① `pickAudio` 的格式清单落在 `@lark/shared`（core 的闸门、GUI 主进程的对话框过滤器、将来 capabilities 的 `import_formats` 是同一份），不是各自写一遍；② **capabilities 的 `audio_format` / `import_formats` / `llm_available` 仍留在 T5**（D8：中间批次不自称 v6，且这三个字段今天没有消费者——GUI 静态 import 那份清单）。
>
> **T5 与本表的两处出入**：① `naming` 阶段随 T5.1 一起进 `DOWNLOAD_STAGES`（本表把它归在「阶段」那一项，但它是命名路径自己的阶段，同一次改 `resolveTarget` 顺手落下比分两批碰同一个函数干净）；② capabilities 的 **`llm_available` 提前到 T5.1**——GUI 的命名弹框要靠它灰显，等到定稿批就得先发一个明知会被拒的选项；`audio_format` / `import_formats` 仍在 T5.4，`llm_effective_format` 按计划留给 T5b 的 F5。
>
> **本表 T3 的 gate 写错了一处**：判据 **54**（冲突 local + 不可解析 payload 在 core 层被拒）是 §7 的 F3，属 **T5b**，与 T3 的实现面无关。T3 实际覆盖 15–22、51、59、61。

| 批 | 内容 | gate |
|---|---|---|
| **T0a** | 供应链前半：生成 tracked 真 mp3 fixture（`scripts/fixtures/tone-1s.mp3`，配方与 hash 记录——LAME 移除后失去可复现生成来源，顺序不可倒）→ 加 aac encoder + ipod muxer，**LAME 暂留、新旧闭环并存**（生产 `ensureMp3` 此时仍在用 LAME，先删即断链） | `just fetch-ffmpeg` 门禁全绿 + 现有下载不回归 |
| T1 | canonical + processAudio/AudioProbe + bilibili codecs + Content-Type + 测试面随改（协议版本号**不动**，见 T5） | `just test` 全绿（此批测试改动最大） |
| **T1b** | 供应链后半：删 LAME（configure/构建段/能力清单/notices 收尾） | **全仓无 mp3 产出调用 + 真实 bilibili 下载 m4a 闭环** |
| T2 | 迁移 core：0003（fail-closed pending + fresh clear）+ scanner（object_key 主键、含孤儿）+ converter（**首提交 = 分型映射表附表 + fixture**，再实现：分型 + 探活注入 + reconcile 自动清障）+ recovery 版本化 + schema 契约三调用点 + **Go 实现删除** + 协调表逐行夹具 | core 测试含判据 1–14、48–50、52、56–57 |
| T3 | 迁移 daemon/GUI/CLI：三层 boot + 状态机 gate + 双通道 + file-ops 口 + 进度屏 + backup 清空 + 批量重下 | daemon/gui 测试 + 判据 15–22、51、54 |
| T4 | 导入矩阵 + AudioProbe 全格 + pickAudio + ImportResult 扩展 | 矩阵逐格测试 + 判据 31、53 |
| T5 | PC 三项（命名 / 阶段+字节 / 面板）+ **协议定稿收尾：`LOCAL_API_VERSION` 一次性升 6 + accept 字面量同批改（D8——中间批次不自称 v6）** | 判据 23–30 |
| **T5b** | **「已实现未实装」修复批（§7 清单 F1–F17，Q1–Q3 已定案）** | 判据 35–47 |
| T6 | 验收脚本**复核**（accept-m5/pack/gui/sync——字面量已在各批随改）+ 真实库迁移闭环 + 收藏夹人工 smoke + 九步发版 0.3.0 | `just check` + 全量测试 + accept 系列 + 发版 |

## §4 子计划级决策（**已定**——2026-08-13 用户拍板全部按建议值采纳）

| # | 决策 | 建议 |
|---|---|---|
| a | WAV PCM decoder 集 | 扩 `pcm_u8/pcm_s24le/pcm_s32le`，各配真实样本 gate；其余（f64 等）明确报错 |
| b | backup 目录名 | `~/orpheus-aviary-nest/lark/migration-backup/` |
| c | 新错误码 | `AUDIO_MIGRATION_PENDING` · `NAMING_MODE_CONFLICT` · `IMPORT_UNSUPPORTED_FORMAT` · `IMPORT_HAS_VIDEO` · `IMPORT_NO_AUDIO` · **`CONFLICT_PAYLOAD_UNAVAILABLE`（F3 的 core 层拒绝）** |
| d | 进度节流阈值 | 事件：≥500ms 且（≥1% 或 ≥256KiB）；CLI 非 TTY：每 10%（total 未知：每 5MiB 或 2s） |
| e | 弹框记忆 | 记忆上次选择作默认高亮，仍每次询问 |
| f | 批量取消 | 新端点 `POST /download/cancel-all`，返回逐项结果 |
| g | 迁移/导入转码参数 | 同一函数：aac 192k，源采样率 ≤48k 保持、>48k 降 48k，声道保持（>2 降 2） |
| h | 探活实现 | 与缓存清理同一实现（R26 同源不复制），**由 daemon 组装时注入 `canRedownload(sourceKey, signal)` 给 core converter**（core 不反向依赖 daemon） |
| i | ledger 表名 | `audio_migration`（与接口同名） |
| j | accept-gui 的 fixture.mp3 | **spike fixture 换 m4a，harness 改验 `audio/mp4`**——spike 是 media protocol 的验证工程与 M4 移植参照，必须跟 canonical 走，保留 mp3 会让它验证一个不存在的协议（第八轮评审修订原「保留 mp3」方案） |
| k | 迁移预检磁盘阈值 | `free ≥ max(500MB, 最大单曲 mp3 × 3)`（主计划 §3.2-5 已冻结） |
| l | Go 迁移 | 0.3.0 **直接删除实现**（代码/测试/justfile recipe/引导文案，见 §2.3）；Go 旧库拒绝路径保留、文案指向 0.2.x |
| m | backup 清空 | 认证 `POST /api/audio-migration/backup/clear` + 确认 + runner 互斥 + 路径 confinement |
| n | reconcile 碰撞命名 | `<song_id>.reconcile-N.mp3`（N 自增，禁覆盖）；孤儿目录整体入 `migration-backup/orphans/` |

## §5 验收判据（映射主计划 §3.2-14 与 §3.7，编号供 T 批引用）

1 预检三项各自拦截 · 2 中止不落 lost 且续跑 · 3 ENOSPC 停 pass 零删除 · 4 弃置前探活（无网 → 入 backup 不删）· 5 R 坏 mp3 → lost · 6 A 坏 mp3 → backup+kept · 7 A 成功原件在 backup 且终态前验证存在 · 8 backing_up 双崩溃窗口恢复 · 9 backup 已存在不覆盖（hash 两分支）· 10 asset_missing 绝不 done · 11 unlink/move 失败 → blocked 且恢复正确 · 12 协调表逐行夹具 · 13 终态后放回 mp3 → reconcile 不删 · 14 kill -9 + 进度守恒 + tmp 清扫 · 15 仅全新库秒过；v2 升级库先 legacy recovery（含「无 mp3 但 manifest 恢复出 mp3」）· 16 blocked_file_op 经 retry/discard 解锁续跑 · 17 CLI direct 写拒绝 / v2 读 MIGRATION_PENDING / pending has_file 不谎报 · 18 GUI 进度屏 + 复用 CLI 先起的 daemon · 19 legacy 全表夹具 · 20 迁移后旧版拒开 · 21 /api/audio-migration pending 后可访问、无绝对路径 · 22 backup 占用可见 + 一键清空 · 23 批量勾选两分支产出可区分 · 24 单链接弹框两选择生效（两条 wire 通道）· 25 歌手缺失回退 UP 主名 · 26 策略冲突在歌单事务前报错 · 27 abort 重抛（取消后不继续下载）· 28 llm_available 灰显/报错 · 29 阶段与字节进度契约（含 total 未知分支）· 30 面板三术语 + cancel-all 逐项结果 · 31 导入矩阵逐格（含 attached_pic 不误拒 / ADTS / ALAC / 多音轨）· 32 v6 门禁拒旧 daemon · 33 真实副本库迁移闭环（`backup-nest` + `LARK_NEST_DIR`）· 34 收藏夹人工 smoke（fid=3975154248）· 35 `sync.interval_min` PATCH 后 timer 重建（测试断言周期变化）· 36 冲突差异表含 provider/key 且零差异有兜底文案 · 37 null payload「保留本机」禁用 · 38 「去登录」落同步 tab、「同步设置」同 · 39 `api_format`「跟随 aviary」项 + 域校验 oneOf · 40 清除 key 后占位符注明回退 · 41 缓存上限调小即触发清理 · 42 歌词偏移 badge 归零即消失 · 43 同步 toast 字段与标签一致 · 44 `--allow-partial` 在不适用形态报 usage error · 45 `--json` 成功路径 stderr 为空（三处回归测试）· 46 `--direct` 对空名/空白/搜索词与 HTTP 同拒同 trim · 47 多选「重新下载 / 重新下载歌词 / 删除歌词」批量分支生效（菜单带「N 首」、N 首全部入队/删除）· 48 三组库形态（fresh daemon / fresh direct / v2 upgrade）——fresh direct 首次写不落 pending、v2 direct 写拒绝 · 49 孤儿/journal-owned 目录处理（op 指向已删歌、discard 后残留入 orphans 区）· 50 reconcile 自动移碰撞安全 backup 且完成不被阻塞（含 done+mp3、backup hash 不一致两分支）· 51 backup 清空：确认 + runner 互斥 + confinement（路径逃逸被拒）· 52 ENOSPC 语义：已终态歌不回滚、错误时刻起零删除 · 53 ImportResult 的 warnings/error_code 呈现（多音轨注明、拒绝码正确）· 54 冲突 local + 不可解析 payload 在 core 层被拒（非仅 GUI 禁用）· 55 spike harness 验 `audio/mp4` · 56 `migrate-go` 入口拒绝且文案指向 0.2.x · 57 backup_path 为相对路径（nest 搬移后 ledger 仍可解析）· 58 「0003 commit 后、fresh clear 前」kill → 下次空迁移不漏迁 · 59 `blocked_environment` 经 retry 端点恢复续跑（释放磁盘/装好 ffmpeg 后不用重启 daemon）· 60 `-map` 用全局 stream.index（封面/视频流排在音频前不选错）· 61 backup 清空：预览 + pending 禁用 + confinement + ledger 记 `backup_cleared`。

## §6 风险

- T1 测试面最大（core 68 处命中）——按文件分小批提交，避免一次性大 diff。
- 迁移探活依赖网络——判据 4 用 stub 双分支覆盖；真实库闭环（判据 33）在有网环境跑。
- accept 系列的协议版本/格式字面量随 T1 协议批同批改、T6 只复核（0.2.0 发版滞后教训 + 避免中间批次 gate 被旧脚本误报）。
- 本机真实曲库是 schema v2 且 21 首多为 Go 迁移 imported——正是 A 类主场，判据 33 必须验证 backup 完整性后再考虑对真库操作；开发期一律副本。

## §7 「已实现未实装」修复批（T5b；2026-08-13 全仓双向审计产出，关键项已逐条人工复核 file:line）

背景：「原标题」暴露的坑型（前端实现、下游无效/无差别）做了一次全仓双向审计——正向（41 个 GUI 控件 → wire → daemon → core 四连问）+ 反向（config 字段 / CLI flags / wire 请求字段全量）。结构性结论：daemon `objectBody` 对未知字段一律 400，**字面 dead wire 不可能静默存在**；命中全部属于 semantic no-op / boot-only 未提示 / 呈现错配三类。

### 7.1 必修清单 F1–F17（**2026-08-16 全部完成**）

> 五个提交：`fa5b6b0`（F1/F5 域/F7）· `2c490f6`（F2/F3+判据 54/F9）· `444fe7c`（F4/F5 UI/F6/F8/F17 + 歌词字号 hint）· `ba187f1`（F11–F15）· `916d750`（F10/F16）。逐条实测见 `PROCESS.md`。
>
> **与本表的两处出入**：① F5 拆成两半——域校验与 `llm_effective_format` 随 daemon 那个提交走，Select 的呈现随 GUI 那个走（同一个字段的两端本来就在两个包里）；② F16 的 `createConsoleLogger` 早已不在仓里（T2 删 Go 迁移时一并没了），实际改的是那条说文件轮转服务「daemon/GUI」的头注释。


| # | 问题（file:line 证据） | 修法 |
|---|---|---|
| F1 | **`sync.interval_min` 只在 boot 读一次**（`daemon/sync/triggers.ts:104`，`start()` 唯一调用点 `triggers.ts:331`；`PATCH /config` 只 `ctx.config = next`；SyncTab hint 与 `routes/config.ts:178` 文案均未提重启；config.test 只断言了存取） | PATCH 后重建 scheduler timer（triggers 暴露 rearm）；补「周期真的变了」的测试；文案校正 |
| F2 | 冲突差异表漏 `source_provider/source_key`（`ConflictsDialog.tsx:41-47` vs `core/sync/apply.ts:381-382` 的 7 字段冲突判定）→ 可渲染出零差异空表 + 两个按钮 | `FIELDS` 补两字段 + `differing.length===0` 兜底文案 |
| F3 | payload 不可解析时「保留本机」是真 no-op 且 bump LWW 推空更新（`ConflictsDialog.tsx:96-112` 无 disabled；`core/sync/conflicts.ts:181` parse `'{}'` → 全 undefined → `updateSongInTx` 全回落） | **core/route 层拒绝**（`strategy==='local'` 且 payload 不可解析 → 新错误码，CLI/旧 GUI/任意客户端一并挡住）；GUI 禁用只是 UX 层 |
| F4 | 「去登录…」「同步设置…」落在常规 tab（`SyncBadge.tsx:211-220` → `settings-ui.ts:16` 无 tab 字段 → `SettingsDialog.tsx:151` 非受控 `defaultValue`） | settings-ui 加 `tab`，Tabs 受控，两个入口分别定位 |
| F5 | LLM `api_format` 的 `''`（继承 aviary）被显示成 openai 且选一次就写死无法回退（`GeneralTab.tsx:74-77`）；域无校验，任意串静默走 OpenAI 分支（`llm.ts:57`，`routes/config.ts:93` 只查长度） | Select 加「跟随 aviary（当前：X）」映射 `''`——**X 来自 capabilities 的 `llm_effective_format`（D8 新增；public config 只回本地保存值，拿不到 aviary 回退结果）**；PATCH 校验 `oneOf('', 'openai', 'anthropic')`（存量非法值 sanitize 告警回落 `''`） |
| F6 | API Key「清除」后占位符「未设置」，但 aviary 回退让 LLM 照常带共享 key 工作（`config/index.ts:174`） | 占位符改「未设置（将回退 aviary 共享配置）」 |
| F7 | 缓存上限调小后无任何清理触发（三个触发点 `boot.ts:561/450`、`routes/cache.ts:21`，无 config 变更） | PATCH 后上限变小即 `scheduleEvictionInBackground('config-changed')` |
| F8 | 歌词偏移 badge 归零卡住（`LyricsPanel.tsx:43-48` 早退不清 `showOffset`） | `offset===0` 时 `setShowOffset(false)` |
| F9 | 同步 toast「拉取 N」用的是 `applied`（`SyncBadge.tsx:62`；fixture 恰好 pulled=applied 掩盖） | 改「应用 X 项，推送 Y 项」 |
| F10 | `view.title` 无 `decodeEntities` 而列表标题有（`bilibili.ts:216` vs `:388`）——「不勾原标题」反而更可能存下 `&amp;` 类未解码文本 | view 路径补解码（同为 T5a 命名清洗的输入卫生） |
| F11 | `--allow-partial` 只在收藏夹/合集分支读（`download.ts:220` 全文件唯一读取），`--batch`/单输入静默无效；skill 文档当通用 flag（`skill-template.ts:120`） | 不适用形态报 usage error；skill 文档限定措辞 |
| F12 | `--json` 成功路径三处 stderr 泄漏（`commands/sync.ts:255`、`:291`、`context.ts:85`；对照 `context.ts:99-101` 是正确写法） | 三处加 `!json` 门；补回归测试 |
| F13 | `--direct` 与 HTTP 四处校验差：空歌名可写入 / 空歌单名可建改 / 不 trim / 搜索词不 trim（`direct.ts:176-179` 只查长度；`core/library/playlists.ts:50` 零校验） | direct 层对齐 `validation.ts` 语义（trim + 非空）；**core 不动**（sync apply 的远端写路径不受本地边界校验约束） |
| F14 | `skill export -o` 直接覆盖不确认，与 `playlist export -o` 不一致（`skill.ts:59` vs `transfer.ts:55-57`） | 补确认（`--yes` 可跳过） |
| F15 | `songs list --duplicates` 放行 `--sort/--order` 但语义弱（组序=Map 插入序） | 对齐既有拒绝面，一并拒绝 |
| F16 | 死代码与错误注释：`createConsoleLogger` 零调用（`logger/index.ts:81`）；BatchSelectModal「fall back to LLM」注释、logger「daemon/GUI」注释、theme「body only」注释、`2026-08-05-m4-gui-base.md:112` 同款错误措辞 | 删除死代码；注释随对应批次改正 |
| F17 | 多选右键「重新下载 / 重新下载歌词 / 删除歌词」只作用于右键行且无提示（`SongRow.tsx:233-256`，其余动作均有 many 分支）——**Q1 定案：补批量分支** | 菜单文案带「N 首」；GUI 逐首调用对应端点（redownload / download-lyrics / delete-lyrics）；`saving` 阶段不可取消语义不变 |

另：歌词字号被 `min(…,1.75rem)` 封顶且只作用当前行（`LyricsPanel.tsx:84`，固定高度是有意设计）——**不改行为**，设置项加 hint 说明（并入 F 系列执行）。

### 7.2 Q1–Q3 定案（2026-08-13 用户拍板）

| # | 现状 | 定案 |
|---|---|---|
| Q1 | 多选右键「重新下载 / 重新下载歌词 / 删除歌词」只作用于右键那一行，无「N 首」提示（`SongRow.tsx:233-256`） | **补批量分支** → 执行为 **F17** |
| Q2 | shuffle 模式下「上一曲」走列表序（`player.ts:291-296` 无 playMode 判断） | **保持现状**，认定为设计（lark 无播放历史栈），仅记录 |
| Q3 | 手动「下一曲」在 sequential 与 repeat-all 下都回绕（`player.ts:288`；差异只在自动续播 `:350-357`） | **保持现状**（手动 next 回绕是行业惯例），仅记录 |

### 7.3 记录不修（backlog，随本子计划归档；Q2/Q3 的设计认定也归档于此）

- `GuiRegisterRequest.pid/version` 接收即存档零消费（`gui-channel.ts:83-90` 无读取点）——v6 顺车决定记日志或删字段，backlog。
- 响应侧零消费字段：`SyncFileOpSummary.next_retry_at/created_at/inline.sha256`、`ConflictData.remote_seq`、`SyncDeviceData.client_version`、`SyncBackfillSummary.lyrics_skipped`（CLI 独漏打印）、`SongData.file_origin`、`PlayerStatusResponse.reported_at`、`PlaylistExportData.exported_at`（只写不读）——展示增强 backlog。
- CLI 无 `download cancel` 入口（wire 与 GUI 都有）——backlog（与 CLI 音频导入同批）。
- `POST /cache/evict` 无参数面（能力缺失非 bug）。
- Go 遗留 config 段 `display/download/daemon`（deepMerge 带过、redact 不露）——by design，记录。
- `UpdateSongRequest.duration` 只影响显示与导出——by design。
- `PlayerStatusData.playlist_id` 镜像无人读——留给 agent 场景，记录。

## §8 参考

主计划 **v11** §3（契约）；`PROCESS.md`（逐批记录落此）；M7 供应链记录 `2026-08-08-m7-packaging.md` §3.0/§8；M3 管线记录 `2026-08-04-m3-download-pipeline.md`。

---

## §9 附表 A：错误分型映射表（T2 冻结，2026-08-14）

§2.2 允诺的那张表。它决定「什么时候可以删掉用户的 mp3」，所以先于 converter 落地：实现 = `core/src/migration/error-class.ts`，逐行判据 = `error-class.test.ts`，其中**内容类每一行都由真实 vendored ffmpeg 跑真实损坏 mp3 产出**（`@lark/core/testing` 的 `damageMp3()` 从 tracked 的 `scripts/fixtures/tone-1s.mp3` 派生五种损坏形态），不是手写的 `new Error('Invalid data found')` 自证。

### A.1 四路输入信号

| 信号 | 来源 | 为什么不能少 |
|---|---|---|
| **调用方 AbortSignal** | converter 自己持有的那个 | 唯一能把「取消」和「超时」分开的东西——两者从 `withTimeout` 出来长得**一模一样**（都是 AbortError，wrapper 文案都是 `cancelled or timed out`） |
| **errno**（cause 链上的 `code` 字符串） | spawn 失败 / fs 调用 | 机器的问题与文件的问题的分界线 |
| **失败步骤** | 调用点传入 | `convert`（探测/转码/验证）vs `file_action`（unlink/rename/move）。同一个 EACCES 在前者是「装个能用的 ffmpeg」，在后者是「这一首的目录不可写」，后者绝不该停整个 pass |
| **ffmpeg 退出码 + stderr** | execFile 的 `code`（数字）与 `stderr` | 只有真的跑起来并非零退出的进程，它说的话才作数 |

### A.2 判定顺序（严格 → 宽松，命中即止）

| # | 条件 | 分型 | 处理 |
|---|---|---|---|
| 1 | 调用方 signal 已 abort | **abort** | 非终态回 pending、保留 mp3、清 tmp，续跑 |
| 2 | `MediaToolsUnavailableError` | **environment** | 工具在碰任何文件之前就不可用 |
| 3 | errno ∈ `ENOSPC EDQUOT EROFS EIO ENOMEM EMFILE ENFILE EFBIG`（**两个步骤都算**） | **environment** | 磁盘满不因为「碰巧在 rename 时冒出来」就降格成单曲问题 |
| 4 | 步骤 = `file_action`（其余一切，含 EACCES/EPERM/EBUSY/ENOTEMPTY/EXDEV/ENOENT 与无 errno 的失败） | **file_action** | 该行 `blocked` + 记 `blocked_action`，人工处理后续跑 |
| 5 | 步骤 = `convert` 且有 errno（spawn 从没变成进程：ENOENT/EACCES/…） | **environment** | 二进制不在或不可执行 |
| 6 | stderr 命中**环境 pattern** | **environment** | 见 A.3，**必须先于内容 pattern 查** |
| 7 | 有数字退出码 **且** stderr 命中**内容 pattern** | **content** | 按 class 分流：R → 弃置前探活；A → 移 backup |
| 8 | 其余（含超时、`ffprobe output was not JSON` 这类没有退出码的自家失败） | **environment** | 分不清就停下、不动文件 |

不变量：**误判成 environment 的代价是一次重试，误判成 content 的代价是一首歌**。所以默认值只能是 environment，且 4 在 5 之前、6 在 7 之前。

### A.3 pattern 清单（小写后子串匹配）

**环境**（先查）：`no space left on device` · `permission denied` · `read-only file system` · `input/output error` · `too many open files` · `cannot allocate memory` · `disk quota exceeded` · `unknown encoder` · `unknown decoder` · `unknown muxer` · `unknown demuxer` · `not found for input stream` · `encoder not found` · `unable to find a suitable output format` · `requested output format` · `bitstream filter`

> 后六条是**能力缺失**：profile 里没有它需要的解码器，那是坏掉的 lark，不是坏掉的歌。

**内容**（后查，且要求有数字退出码）：`invalid data found when processing input` · `failed to find two consecutive mpeg audio frames` · `could not find codec parameters` · `header missing` · `error while decoding` · `moov atom not found` · `failed to read frame size` · `does not contain any stream` · `end of file`

### A.4 两条实测（**都改变了设计**）

1. **ffmpeg 的退出码看不见截断**。拿 tone-1s.mp3 截到 12000/25748 字节喂进去：ffmpeg 打一行解码抱怨、**退出码 0**、写出一个完全合法的 m4a——里面是 **0.47 秒**（原 1.0 秒）。中段刷成 `0xff` 的那份同理：退出 0，**0.29 秒**。只信退出码的迁移会 unlink 掉 mp3 并留下三分之一首歌。⇒ 「验证 m4a」必须查**时长**，判据 5（R 类坏 mp3 → lost）也因此不能只靠 ffmpeg 报错触发。
2. **环境错误会连带打印解码噪声**。转码中途磁盘满，stderr 里既有 `No space left on device` 也有 `Header missing`——先查哪张表决定这首歌的 mp3 会不会被删。⇒ 环境 pattern 必须先查（规则 6 先于 7），且这条有专门的回归测试。

### A.4b T2 实现时的一处偏离（主计划 §3.2-9「blocked 行」）

原文：`blocked | 任意 | 重试一次 blocked_action，成功按 resume_state 推进`。**实现没有重放 `blocked_action`，而是把 `blocked` 行当 `pending` 一样重新按磁盘判定。**

理由与逐条推演：协调表的每一行本来就只看「mp3 / m4a / backup 三者在不在」，所以重新判定必然回到同一个动作——① R 转换后 unlink 失败 → 重判：mp3 在 + m4a 有效 → 仍是 unlink；② A backup move 失败 → 重判：mp3 在 + m4a 有效 → 仍是 move；③ `discarding` 时 unlink 失败 → 重判：mp3 在 + 无 m4a → 重新转换（可能再探活一次网络）——比重放**更保守**；④ `blocked` 期间用户自己删了 mp3 → 重判走「mp3 不在」的行，而重放会对着不存在的文件执行动作。**一条写在失败之前的记录可能已经过时，磁盘不会与自己不一致。** `blocked_action` 因此降级为报告字段（GUI 要显示「卡在哪一步」）。

### A.5 「验证 m4a」的定义（协调表全表引用它）

实现 = `core/src/migration/verify.ts` 的 `assessCanonicalAudio(probe, expected)`，五条全过才算有效：

1. 有音频流 · 2. codec = `aac` · 3. 容器属 mp4 族 · 4. **时长 > 0**（为 0 = moov 没写成，是中断run 的残骸）· 5. `时长 + 容差 ≥ expected`，容差 = `max(0.25 秒, expected × 1%)`

**只拦缩短，不拦变长**——AAC 编码器加 priming 采样，产物比源长一点点是正常的。`expected` 的来源按现场取：转换时是源 mp3 的探测时长；重启后「mp3 无、m4a 在」时是曲库行的 `duration`；两者都没有就传 `null` 跳过第 5 条（前四条仍查）。
