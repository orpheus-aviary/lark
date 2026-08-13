# m4a 统一 + 移动版主计划（阶段总纲）

> 2026-08-13 v8（清稿）。经七轮逐条评审收敛；修订历史见 git，本文只保留当前有效内容。
>
> 两个 Phase：**A = 桌面 m4a 统一 + 一次性迁移 + 三项 PC 改进，发 0.3.0**；**B = Android 移动版（apps/mobile）**。每个里程碑开工前出子计划过目；标注**（锁定）**的章节子计划只能补细节、不得改语义；D4/D5 为**方向锁定**，实现细节经 N0 判定后冻结。

---

## §0 背景与目标

- lark 0.2.0 已发；0.2.1 号已用于本地 alpha（图标 tile、删除文案两小修），不公开发——随 Phase A 进 0.3.0。
- 目标一：**lark 家族音频统一 m4a**。现状「bilibili AAC → 转码 192k MP3」是有损套有损；改 remux 无损更快更小；导入扩多格式并归一 m4a。
- 目标二：**Android 移动版**——完整本地功能 app（不走 server/浏览器模式），之后可扩 iOS。

## §1 决策记录

| # | 决策 | 内容 |
|---|---|---|
| D1 | 仓库 | lark 仓内 `apps/mobile`（`@lark/mobile`）。 |
| D2 | 技术栈 | Expo SDK 57（RN 0.86 + React 19.2）+ CNG + dev client。nodejs-mobile / Capacitor 出局（§7.2）。 |
| D3 | 移动端无 daemon | core 经宿主无关应用服务层进程内调用。 |
| D4 | SQLite（方向锁定） | expo-sqlite 同步 API + 单一连接（drizzle 官方 Expo driver 与 raw shim 包装同一 client，禁第二连接）；raw shim 只适配现用面；迁移单一真相源 = 现有手写 registry，不引入 drizzle-kit。**statement 生命周期是 N0b 判定项**：锁定版 drizzle 0.38.4 的 Expo driver `prepareSync()` 后不 finalize（Expo 官方要求及时 finalize）——N0b 三选一出口：升级到已修复版本 / 维护小补丁或 fork / 移动端弃用 drizzle 查询层只走 raw shim。N0b 另设 **JS 线程卡顿 gate**（大库迁移 + 批量同步 apply 的同步重活在真机测卡顿，阈值子计划定）。 |
| D5 | 复用架构（方向锁定） | N1 提取应用服务层（library / download 编排 / SyncCoordinator）+ 端口：Database / FileSystem / **Crypto（UUID/MD5/SHA-256）/ Base64+TextEncoding** / CredentialStore / Clock / Logger（wbi 用 node crypto、歌词用 Buffer base64——都要过端口）。CLI direct Backend 是 facade，方法面仅作功能清单参照。GUI stores 复用形状与逻辑、注入数据源端口。**portable 落点：workspace 阶段用 `@lark/core/portable` 子路径**——subpath 属于 `@lark/core` 包、不隔离安装依赖（core 直接依赖 better-sqlite3/pino），workspace 内靠 Metro 按需打包 + N1 双守卫拦误引；将来需要独立发包时拆成新包，原 subpath 以 re-export 兼容过渡。 |
| D6 | 音频格式 | 单一格式态：0.3.0 一次性迁移（§3.2 锁定，**按 `file_origin × source_key` 分流，imported 用户资产永不删除**）；新下载 remux 落 m4a；导入归一 m4a。canonical `songs/<uuid>/song.m4a`；served 库恒单格式（迁移期间不服务音频）。音频不参与同步。 |
| D7 | 版本 | Phase A 发 **0.3.0**。 |
| D8 | 协议版本 | `LOCAL_API_VERSION` → **6**。capabilities 新增 `audio_format`、`import_formats`、`llm_available`（经 aviary 回退后的有效状态）。CLI 随发 0.3.0。 |
| D9 | 移动导航 | 四 tab：歌曲｜歌单｜添加｜设置；顶栏搜索 + 同步徽章。 |
| D10 | minibar / 播放页 | minibar 两行（歌名 + 当前歌词行）+ 播放/暂停 + 下一曲；上拉队列；点击进全屏大字歌词页（滚动同步 + 点行 seek）。 |
| D11 | 行交互 | ⋮ → bottom sheet 菜单；长按 → 多选。 |
| D12 | 移动端导入 | v1 不做本地文件导入（服务层留能力位、「添加」页留入口）。私有目录卸载即删——开放本地导入前必须先有导出/备份故事。 |
| D13 | 分享 intent | bilibili app 分享 → lark「添加」页。 |
| D14 | 分发与身份 | 侧载 APK，target 36。N0b 定死：applicationId `com.orpheusaviary.lark`；APK 版本线 0.1.0、versionCode=1；keystore 主副本入加密凭证库 + 独立加密备份（alias / 证书 SHA-256 / 密码 + 恢复演练），不进仓库与 CI artifact。developer verification：**N6 设正式 go/no-go**。 |
| D15 | 传输安全 | 移动端 v1 只支持 https。TLS：负责人 = 用户，AI 协助实施；与 N1 并行、最迟 N4 结束前完成、N5 前置验证。验收：域名 + DNS · 证书 + 自动续期（告警 + 演练）· 反代 · 两端 `server_url` 迁移 · 真机连通。 |
| D16 | Android 备份/迁移 | `allowBackup=false` + `dataExtractionRules`（12+）与 `fullBackupContent`（11-）显式排除 database/files/sharedprefs/音频/SecureStore 存储（处理 expo-secure-store 插件自动配置冲突）。恢复检测：启动服务/migration/凭证之前，**只读隔离最小打开** DB 读 `install_id` 与 no-backup/Keystore 侧比较后立即关闭；DB 不存在 → 全新库生成双侧；两侧相等 → 正常；任一缺失或不等 → fail closed（不启 sync、不碰凭证，清 binding 重新绑定，曲库数据保留）。N2 gate 含 D2D restore 测试。 |
| D17 | 音频 canonical 与 bilibili codec | canonical = AAC in ISO-BMFF、ExoPlayer 可播可 seek。codec 选择在候选列表阶段：解析 `codecs`（`mp4a.40.*`），AAC 候选内按目标带宽取流；无 AAC：桌面转码、移动端拒绝并报错；codecs 缺失视为非 AAC。raw fMP4 直存达标与否 N0b 实测；JS remux 是须过大文件内存测试的候选。 |

## §2 调查结论摘要

1. shared 全量可复用；sync 引擎只依赖「better-sqlite3 形状 + 注入接口」；bilibili/歌词 client fetch 可注入。复用前提是 N0a/N1 边界提取（core barrel 是 Node-only）。
2. ffmpeg-kit 退役下架 → 移动端 m4a 直存；expo-audio SDK 57 支持后台 + 锁屏（需显式启用）。
3. UI 惯例：⋮/长按 bottom sheet 标准；mini player = 播放器 sheet 收起态。
4. skybridge SDK 的 RN 可用性是候选：engines `node >=22`、依赖 streaming fetch；`expo/fetch` 支持流式，N0b 实测判定。

## §3 Phase A：桌面 m4a 统一 + 一次性迁移 + PC 改进（发 0.3.0）

子计划第一交付物 = rg 全仓 mp3/命名假设 callsite 清单，逐项标「必改 / legacy fixture」。

### 3.1 路径：单一 canonical

`songs/<uuid>/song.m4a` 是唯一音频路径，写路径全部确定性、无探测（唯一例外：§3.2-12 的 pending 窗口只读 has_file）。落盘协议六步整体保留只换名。`/audio` 的 `Content-Type: audio/mp4` 常量成立。

### 3.2 迁移状态机（锁定）

总口径：迁移弱化但闭环；**「可弃置」只适用于可重建的文件**——`imported`（含 Go 迁移）是用户资产（R1/R26），任何路径都不删除；mp3→AAC 是再次有损，能靠重下拿到新鲜 AAC 的歌，提供重下通道。

**1. 分流总则（class 表）**：迁移首启扫描时按静态条件给每首持有 mp3 的歌定 class，写入 ledger：

| class | 定义（静态初判） | 转换动作 | 内容失败 | 成功后的原件 |
|---|---|---|---|---|
| **R（可重建）** | `downloaded` 且 `source_key_present`（key 非空 **且 provider 受支持**） | 转码 aac 192k | **弃置前紧邻实时探活**：可重下 → `discarding` → unlink → `lost`；探活失败/无网 → 改走 A 类路径（移 backup → `kept_unconverted`，不阻塞完成） | unlink（转码产物已保住内容，无需探活） |
| **A（资产）** | `imported` 或不满足 R 条件 | 转码 aac 192k | 移入 backup → `kept_unconverted`（绝不 lost） | **移入 `migration-backup/<song_id>.mp3`，终态写入前验证 backup 实际存在** |

- **`source_key_present` 是静态存在性判断，不代表已验证可重下**——任何真正丢失内容的删除（弃置）之前必须紧邻做实时探活（与缓存清理 R26 同一不变量）；R 类成功路径的 unlink 不需要探活（m4a 产物已保留内容）。
- `migration-backup/` 在 nest 的 lark 目录下、`songs/` 树之外：不参与缓存清理/同步/recovery，`backup-nest` 包含它；占用字节数、打开目录、显式一键清空入口进设置页——**不允许不可见的永久磁盘占用**。
- **R 类默认策略已定（原 §5-1 关闭）**：转码为默认；迁移报告提供一键批量重下入口，**走 forced redownload 而非 ensure-file**（ensure-file 对已有文件会短路）。

**2. pending 门与白名单**。migration `0003`：升 `user_version=3`（单向）、建 ledger 表、置 pending 标记；不标 `requires_confirmation`。**秒过仅限 0003 时全新创建的库**；所有从 v2 升级的库，无论初始是否见到 mp3，都必须先 drain journal → 完整 legacy recovery（旧 manifest / `.replace` backup 可能恢复出 mp3）→ 再扫描 → 决定是否清 pending（fixture：初始无 mp3 但旧 manifest 恢复出 mp3）。白名单：`GET /status`、`GET /api/instance`、`GET /api/capabilities`、`GET /api/audio-migration`（认证，新增）、`/events`，**外加 `GET /sync/file-ops` + `POST /sync/file-ops/retry` + `POST /sync/file-ops/discard`（见 10）**；其余路由回 `AUDIO_MIGRATION_PENDING`。GUI 进入独立 migration boot state：只轮询白名单接口渲染进度屏。

**3. 两阶段 boot（架构锁定）**。**全部路由在 listen 之前一次性注册**（Fastify 5 listen 后加路由抛 `FST_ERR_INSTANCE_ALREADY_LISTENING`，现实现也是 build 时全量注册）；pending 与否由**全局 migration gate**（onRequest 层）按白名单判定；业务 handler 经 **late-bound `normalRuntime` 引用**取服务——激活前该引用为空，但 gate 已把请求挡在 handler 之外。**minimal pending context** = DB + ledger + migration runner + **迁移专用 FileEffectRuntime**（供 file-op 列表/retry/discard，见 10）+ `/events`；不构建下载/缓存/同步运行时，不 restore/mount sync session。file-op 处理与 migration runner **共享 mutex**，处理完触发 ledger 重扫。迁移完成 → **`activateNormalMode()`**：关闭 pending runtime → **原子安装 normal runtime（swap 引用）**，不动路由表；单次所有权（幂等 guard）；激活失败 = fatal（复用 requestFatal 模式）；teardown 覆盖两阶段——pending 阶段停机顺序 = 停 runner（中止/等待 ffmpeg）→ 关 DB。

**4. 进度双通道**。免认证 `/status` 只带 `audio_migration` **计数与非敏感状态分类**（state/done/total/lost/kept/blocked/blocked_file_op 计数）；认证 `GET /api/audio-migration` 给逐条明细（song id、相对文件名、class、原因、建议；不返回绝对路径），**且在 pending 清除后继续可访问**（历史报告；ledger 永久保留）。

**5. 预检（第一首之前）**：ffmpeg 能力清单 · 目标目录可写 · 最低磁盘空间（阈值子计划定）。任一不过 → pass 不启动，`blocked_environment`，零文件触碰。

**6. 错误分类（冻结；分不清一律按环境类，默认不动文件）**：

| 类别 | 例 | 处理 |
|---|---|---|
| 中止 | teardown/AbortError | 非终态：行回 pending、保留 mp3、清 tmp，续跑 |
| 环境（pass 级） | 工具缺失/不兼容、ENOSPC、目录不可写、暂时 I/O | 全局 `blocked_environment`：停 pass、零删除；修复后续跑 |
| 内容（单文件级） | ffmpeg 解码/格式错误、验证不过 | 按 class：R → 弃置；A → 移入 backup，`kept_unconverted` |
| 文件操作失败 | unlink/move EACCES 等 | 该歌 `blocked`（记 `blocked_action`），人工处理后续跑 |

错误码 → 类别映射表进子计划；「输出验证失败」不自动等于「输入损坏」——验证失败先查环境类征兆（tmp 写入量、磁盘），仍不明则按环境停 pass。

**7. 单曲顺序（终态只在源文件达到终态后写入；`backing_up` 必带 intent ∈ {done, kept}，落 `resume_state`）**：
- R 成功：`converting` → 转码 tmp → ffprobe 验证 → rename canonical → unlink mp3 → `done`。
- R 内容失败：**实时探活 source**——可重下 → `discarding` → unlink → `lost`；探活失败/无网 → 转 A 类路径 `backing_up(kept)` → move → `kept_unconverted`。
- A 成功：`converting` → …rename → `backing_up(done)` → move 原件入 backup → **验证 backup 实际存在** → `done`。
- A 内容失败：`backing_up(kept)` → move 入 backup → 验证存在 → `kept_unconverted`。
- 任何 unlink/move 失败 → `blocked`（记录 action）。

**8. ledger 字段（0003 建表）**：`song_id / class(R|A) / file_origin / source_key_present / status(pending|converting|discarding|backing_up|done|lost|kept_unconverted|asset_missing|blocked|blocked_file_op) / blocked_action + resume_state（含 backing_up 的 intent） / error_class + last_error / backup_path / at`；total 首启冻结；**不参与扫描的对象也入表并记原因**。`done/lost/kept_unconverted/asset_missing` 是真终态——终态后再发现 mp3（如用户手工放回）进 reconcile 报告，不自动删；`asset_missing`（A 类源文件与 backup 双缺）与 reconcile 记录不阻塞完成，但永久保留在报告中。

**9. 重启协调表**（维度 = ledger × mp3 × m4a × **backup**；tmp 残留任何状态按 `TEMP_PREFIXES` 清扫；「验证 m4a」= ffprobe 全套判据；**backup 一律禁止覆盖**——目标已存在时比较 size/hash，一致视为 move 已完成，不一致 → reconcile 报告）：

| ledger | 磁盘现场 | R 类动作 | A 类动作 |
|---|---|---|---|
| pending / converting | mp3 在、m4a 无 | 清 tmp 重转 | 同左 |
| pending / converting | mp3 在、m4a 在 | 验证：有效 → unlink → done；无效 → 删 m4a 重转 | 验证：有效 → backing_up(done) → move → done；无效 → 删 m4a 重转 |
| pending / converting | mp3 无、m4a 在 | 验证：有效 → done；无效 → 删 m4a → lost | **backup 在**：验证 m4a 有效 → done，无效 → 删 m4a → kept_unconverted；**backup 无**：`asset_missing`，**绝不 done** |
| pending / converting | mp3 无、m4a 无 | lost | backup 在 → kept_unconverted；backup 无 → asset_missing |
| discarding（仅 R，探活已在进入前完成） | mp3 在 | unlink → lost；失败 → blocked | — |
| backing_up(intent) | mp3 在、backup 无 | — | 执行 move → 验证 → 按 intent 收尾（done/kept） |
| backing_up(intent) | mp3 无、backup 在 | — | 验证 backup 存在（intent=done 时另验 m4a）→ 按 intent 收尾 |
| backing_up(intent) | mp3 在、backup 在 | — | 比较 size/hash：一致 → unlink 源 → 按 intent；不一致 → reconcile 报告（不覆盖、不删） |
| backing_up(intent) | mp3 无、backup 无 | — | `asset_missing` |
| done / lost / kept | mp3 在 | reconcile 报告，不删 | 同左 |
| blocked | 任意 | 重试一次 `blocked_action`，成功按 `resume_state` 推进，失败保持 | 同左 |

**10. 旧 file-op 死锁解法**。永久失败/退避中的旧 journal op 会占住歌曲目录（recovery 与转换 pass 都必须跳过这些目录）。对应歌曲 ledger 状态 = `blocked_file_op`；pending 白名单开放 file-ops 只读列表 + 受控 retry/discard（见 2），GUI 迁移页列出并可处理；处理完 runner 对这些行重扫。**没有这三个口子，用户将无法自救。**

**11. legacy 消化（转换 pass 之前完成；覆盖完整 recovery 决策表，不止两类对象）**：
- file-op journal：`FileOpArg` 增版本化音频文件字段；无字段的旧 op 由显式 v2 legacy 分支按 song.mp3 世界执行。
- landing manifest：增版本/目标文件名字段，恢复器按版本分派；旧 manifest 按 song.mp3 世界恢复。
- **无 manifest 的 orphan 判定、`.replace` backup、不可读 manifest、dangling commit log**——这些同样依赖 `AUDIO_FILE` 常量，legacy 恢复必须按「song.mp3 + song.m4a 双名」识别，fixture 覆盖 recovery 决策表全表。

**12. CLI 口径**。direct 写在 pending 拒绝；direct 读仅对已升 v3 的库可用（v2 库只读打开抛 `MIGRATION_PENDING`）。**pending 窗口内 `has_file` 探测 legacy-aware（m4a || mp3）**——否则未迁移的歌被谎报成「需要下载」；迁移完成后回到单名探测。管理命令不受影响。

**13. 完成条件**。ledger 无 pending/converting/discarding/backing_up 且无 blocked/blocked_file_op（`asset_missing` 与 reconcile 记录不阻塞）、**`songs/` 目录树内无 mp3**（`migration-backup/` 不计）→ 清 pending → `activateNormalMode()`。终态不变量：served 库（`songs/` 树）永远单格式 m4a。

**14. 验收判据族**：预检三项各自拦截 · 中止不落 lost 且续跑 · ENOSPC 停 pass 零删除 · **弃置前探活（可重下 → lost；无网/探活失败 → 入 backup，不删）** · R 类坏 mp3 → lost、A 类坏 mp3 → backup + kept（**imported 永不消失**）· A 类成功后原件在 backup 且终态前验证存在 · **backing_up 双崩溃窗口（move 前 / move 后未写终态）恢复正确** · **backup 已存在不覆盖（hash 一致/不一致两分支）** · **asset_missing 绝不落 done** · unlink/move 失败 → blocked 且 `blocked_action` 恢复正确 · 协调表逐行夹具 · 终态后手工放回 mp3 → reconcile 不删 · blocked_file_op 经 retry/discard 解锁后续跑 · kill -9 · 进度跨重启守恒 · **仅全新库秒过；v2 升级库先 legacy recovery 再扫描（含「初始无 mp3 但 manifest 恢复出 mp3」夹具）** · CLI direct 写拒绝 / v2 库 direct 读报 MIGRATION_PENDING / pending 窗口 has_file 不谎报 · GUI 进度屏（含复用 CLI 先起的 daemon）· legacy 全表夹具（journal/manifest/orphan/replace-backup/不可读 manifest/dangling log）· 迁移后旧版拒开。

### 3.3 供应链

- 现 lock 已含 demuxer `mov,mp3,aac,flac,wav,ogg,matroska`、decoder `alac/vorbis/opus/aac/mp3` + PCM 仅 `pcm_s16le/s16be/f32le`、`aac_adtstoasc` bsf。增量：`--enable-encoder=aac` + `--enable-muxer=ipod`。
- WAV 支持面 = 实际 decoder 集：子计划二选一——小幅扩（`pcm_u8/pcm_s24le/pcm_s32le`，各配真实样本 gate）或明示仅支持现集。倾向前者。
- 移除 LAME 全套（保留 mp3 demuxer/decoder/parser 供迁移解码）；gate = 全仓无 mp3 产出调用。
- configure 锁值、nonfree 门禁、能力清单（`encoder aac · muxer ipod`）、真实闭环判据更新。

### 3.4 导入矩阵（多格式 → 一律 m4a）

- `probeAudio` 扩 `-show_streams`（音频 codec + 全部 stream 类型 + disposition）。
- **流选择规则（锁定）**：取第一条音频轨（`-map 0:a:0`），其余流丢弃（`-vn -sn -dn` 语义）；**`attached_pic`（封面图流，mp3/m4a 普遍携带）不算视频流**——「含视频流拒绝」只针对非 attached_pic 的真视频轨，否则会误拒大量正常音频文件。
- 决策表（子计划逐格补全 + 测试）：MP4 族+AAC → remux copy；MP4 族+ALAC → 转码；裸 `.aac` → remux + `aac_adtstoasc`；mp3/flac/wav(支持的 PCM 子集)/ogg → 转码 aac 192k（有损化 UI 明示）；含真视频轨 → 拒绝；无音频流/未知 codec → 拒绝；多音轨 → 取 `0:a:0` 并在结果里注明。
- GUI `pickMp3` → `pickAudio` 全链。**CLI 不新增音频导入命令（已决：记录为 backlog，后续有需要再完善）**，只更新门禁与文案。

### 3.5 协议与下载链路

- `LOCAL_API_VERSION` → 6；`/audio` `Content-Type: audio/mp4`；`lark-media://` MIME 同步；capabilities 三字段（D8）。
- bilibili：候选阶段解析 `codecs` 按 D17 选流；remux 前断言 AAC。
- 字节进度 wire contract：snapshot 与 `download:status` 事件同增 `received_bytes: number`、`total_bytes: number | null`；仅 `downloading` 阶段有意义；**同一次 downloading 阶段内单调**，任务/阶段切换归零；`revision` 随进度更新递增；事件节流（时间 + 变化双阈值，数值子计划定）且阶段结束强制发终值。CLI：TTY 同行覆盖刷新；非 TTY 按百分比阈值打点，**`total_bytes=null` 时退化为字节量/时间阈值**。
- transfer 导出只含元数据。

### 3.6 PC 改进三项（0.3.0 随发）

**1. 命名清洗（批量修复 + 单链接弹框 + 规则冻结）**

- 现状（bug，代码级确诊）：video 类命名是 `target.title ?? view.title`，批量勾「原标题」= 列表标题、不勾 = 视频自身标题，收藏夹场景两者恒同，勾选框实际无效；「fall back to LLM」只存在于 GUI 注释，管线里 LLM 仅服务 keyword 路径。
- 语义：批量导入不勾 = 清洗、勾 = 原标题；单/多链接粘贴提交时弹一次询问框「原标题 / 清洗命名」，本次提交全部链接项统一生效。
- **wire 落点（锁定，覆盖两条通道）**：batch 通道——命名模式字段放 **video item 级**（`'original' | 'clean'`，必填）；keyword item 无此字段。**单曲通道——`DownloadSongRequest` 增条件必填 `naming_mode`**：路由解析 input 为 video 时必填，为 keyword 时禁止/忽略（路由校验）——GUI 弹框与 CLI `--clean-name` 均经此通道（GUI 的多选单项也走 `/download/song` 循环）。弹框/group 勾选把同一值刷到所辖 item。
- 清洗规则（冻结）：LLM 从标题提取歌名 + 歌手；歌手提取不到 → UP 主名；歌名提取不到 → 原标题。复用 `inferSongInfo`。
- LLM 分工：创建时 `capabilities.llm_available=false` → 清洗选项禁用（GUI 灰显、CLI `--clean-name` 报错）；运行时失败 → 回退原题 + UP 主名不失败；**取消/停机异常必须重抛**（现实现捕获所有异常，要区分 abort）。
- **与去重的交互（锁定）**：dedupe key 保持 `bvid+page`；同一 source/page 在途任务策略唯一；策略不同的提交返回冲突错误。**预检时点（锁定）：对「在途任务 + 请求内部重复项」的全量 naming-mode 预检必须在容量检查与歌单事务之前完成**——现实现先提交歌单事务再逐项 merge，冲突若在 merge 层才发现会破坏「所有 group 成功或都不写」的批量原子性。title 快照不参与冲突判定（同策略合并到先到者）。
- CLI：默认 original，新增 `--clean-name`。
- 验收以固定 fixture（录制响应）为主；测试收藏夹（fid=3975154248）作人工 smoke。

**2. 下载阶段细化**：新增 `naming` 阶段（清洗路径上报，位于 resolving 与 downloading 之间）；`downloading` 挂字节进度。标签：解析输入 → 搜索视频 → 定位资源 → 清洗命名 → 下载音频（含百分比）→ **处理音频**（`converting` 有 copy 与转码两种真实操作）→ 落盘 → 匹配歌词。wire 变更随 v6 协议一并出。

**3. 下载进度面板**：当前任务阶段 + 字节进度、排队列表、终态记录。操作术语（锁定）：**取消任务**（queued/running）· **清除记录**（terminal 移出面板）· 删除歌曲不进面板。全部取消 = snapshot 活跃 ID → best-effort 逐项 → 返回逐项结果（saving 阶段如实报「已完成」）。信息结构与移动端「添加」页对齐。

### 3.7 明确不做 / 验收要点

- 不做：格式可配置、mp3 产出路径、回滚、CLI 音频导入命令（backlog 记录）。
- 验收：fetch-ffmpeg 门禁 → 真实下载 m4a → 迁移判据族（§3.2-14）→ 导入矩阵逐格（含 attached_pic 不误拒）→ 命名判据（两分支可区分 · 弹框生效 · 歌手回退 UP 主 · 策略冲突在事务前报错）→ 阶段细化 → 下载面板 → v6 门禁拒旧 daemon → 全量测试 + accept 系列更新 → 九步发版 0.3.0。

## §4 Phase B：Android 移动版（apps/mobile）

### 4.1 架构

```
apps/mobile (@lark/mobile, Expo SDK 57 + CNG)
├── db:       单一 expo-sqlite client（drizzle Expo driver + raw shim 共用；statement
│             生命周期策略 = N0b 三选一，D4）
├── services: N1 产物（library / download 编排 / SyncCoordinator）+ 全套端口（D5，
│             含 Crypto/Base64/TextEncoding），经 @lark/core/portable 边界消费
├── 下载:     core bilibili/歌词 client（fetchImpl 注入）+ RN 落盘（AAC 流直存，D17）
├── 播放:     PlayerDriver（expo-audio：状态订阅/ended/error/音频焦点/becoming-noisy/
│             锁屏元数据/teardown）→ 复用队列/恢复逻辑
└── UI:       RN 重写（四 tab + minibar + bottom sheets）；stores 复用形状、注入端口
```

同步触发：前台 + 变更后轮询 + 手动；后台定时同步 v1 不做。凭证：expo-secure-store + D16。

### 4.2 UI 结构

```
┌────────────────────────────┐
│ lark          🔍  [⇅2]     │  顶栏：搜索 + 同步徽章（活动中心）
├────────────────────────────┤
│ ♪ 歌名 · 歌手 ⭑↓      [⋮] │  琥珀播放中/蓝pin/需下载/重复
│ ♪ …                        │  ⋮→bottom sheet；长按→多选
├────────────────────────────┤
│ 歌名一行                ⏯ ⏭│  minibar；上拉→队列；点击→全屏歌词页
│ 当前歌词行（稍小）          │
├────────────────────────────┤
│ [♫歌曲] [≡歌单] [＋添加] [⚙设置] │
└────────────────────────────┘
```

歌曲（排序/filter/顶栏搜索）· 歌单（详情拖柄排序，rank 成对 emit）· 添加（粘贴框 parse 预览 + 任务/批次列表 + 分享 intent 落点 + 导入预留）· 设置（通用/同步/关于）。徽章口径照桌面。

### 4.3 里程碑（每个开工前出子计划）

| 批 | 内容 | gate |
|---|---|---|
| **N0a** | 最小可移植边界（桌面仓内）：migration SQL registry + schema 切面进 `@lark/core/portable` + DatabaseContract harness（prepare/get/all/run · `transaction().immediate()` · rollback/savepoint 嵌套 · FK · `PRAGMA user_version` · JSON1 含 CAST · 返回值字段差异） | 桌面全测试 + 守卫绿 |
| **N0b** | 真机 spike：Expo 57 进 workspace；expo-sqlite shim 跑 harness + migrations（op-sqlite 对照）；**drizzle statement 生命周期三选一定案 + JS 卡顿 gate（D4）**；expo-audio 播真实 bilibili AAC 流（raw fMP4 判定，D17）+ 后台/锁屏/音频焦点（单 player vs playlist）；分享 intent；skybridge SDK RN 判定（`expo/fetch` 下 bundle/import · login/pull/push · SSE 流读 · abort/重连 · 离线恢复）；落定 D14 | 全判据过 → GO/NO-GO，**D4/D5 细节冻结** |
| N1 | core 端口化 + 应用服务层 + SyncCoordinator 提取（冻结不变量原样保留；daemon 改消费提取物 + 桌面 contract tests；桌面行为零变化）。gate 另加三守卫：portable 面 Node builtin/原生依赖 rg 守卫 + Expo/Metro bundle smoke + **pnpm install + `expo prebuild`/原生构建 smoke**（Metro bundle 通过不证明原生依赖在安装/构建阶段安全），进 `just check` 或独立 recipe | 桌面全测试 + 三守卫绿 |
| N2 | 移动数据层 + 服务层接线 + 曲库/歌单读写 + 四 tab 骨架 + D16 落定（backup 排除 + install_id 检测 + D2D restore 测试） | 真库副本可读写 |
| N3 | 播放：PlayerDriver + minibar + 全屏歌词页 + 队列 + 后台/锁屏/焦点 | 真机整晚播放不掉 |
| N4 | 下载：AAC 选流 + RN 落盘 + 添加页 + 分享 intent + ensure-file + 缓存管理。TLS 完成死线 | 真实 bilibili 闭环 |
| N5 | 同步：移动接线（端口注入 SyncCoordinator）+ 徽章/冲突页/file-ops UI。前置：TLS 验收全过 | 与桌面双端真机 soak |
| N6 | 多选批量 + 设置收尾 + 打磨 + 签名 APK 发布 + developer verification go/no-go | 验收 harness |

### 4.4 风险清单

| 风险 | 缓解 |
|---|---|
| raw fMP4 直存不达标 | N0b 判定；JS remux 候选须过大文件内存测试；再兜底调研原生 remux |
| expo-sqlite shim 保真度 / drizzle finalize 缺失 | N0a harness + N0b 三选一定案 |
| 同步重活卡 JS 线程 | N0b JS 卡顿 gate（大库迁移 + 批量 apply 真机实测） |
| skybridge SDK 与 RN/expo-fetch 不兼容 | N0b 专项判据；不兼容则 fork 注入 fetchImpl / 降级轮询 |
| expo-audio 细节坑 | N0b/N3 真机判据；RNTP v4 兜底 |
| RN 落盘无原子 rename | 简化落盘 + 启动清扫；文件可弃（ensure-file 闭环） |
| portable 边界被侵蚀 | N1 起双守卫常驻 |
| metro 与 pnpm isolated | SDK 56+ 改善；兜底 hoisted |
| duration 无 ffprobe | bilibili `page.duration`；同步歌自带元数据 |
| D2D 半身恢复 | D16（排除 + install_id 检测 + restore 测试） |
| TLS 拖尾 | D15 负责人/时间窗/验收，N4 死线 |

### 4.5 明确不做（v1）

本地文件导入 · 歌单导入导出 · 跨端遥控 · 后台定时同步 · Android Auto / widget / 逐词歌词 · iOS（v2 议题）。

## §5 待确认项

主计划层面已无待确认项（R 类默认策略已按评审建议采纳「转码 + 一键批量重下（forced redownload）」）。弹框记忆默认、节流阈值、错误码命名、backup 目录命名等实现细节由子计划提出并随子计划评审确认。

## §6 参考

- 主计划：`docs/plans/2026-07-16-ts-rewrite-master-plan.md`；v0.2 子计划：`docs/plans/2026-08-11-v0.2-skybridge-sync.md`
- 落盘协议与恢复（orphan/replace/manifest 全表在此）：`packages/core/src/download/resolve.ts`
- file-ops（journal/退避/目录占用）：`packages/core/src/sync/file-ops.ts`
- boot 顺序与 AppContext：`packages/daemon/src/{boot,context}.ts`；免认证边界：`packages/daemon/src/auth.ts`
- daemon sync 层（N1 提取对象）：`packages/daemon/src/sync/{login,refresh,runtime,runner}.ts`
- 命名/去重/批量事务：`packages/core/src/download/{pipeline,task-data,engine}.ts`
- 导入安全边界：`packages/core/src/download/import.ts`；缓存不变量：`packages/core/src/library/cache.ts`
- CLI Backend 方法面：`apps/cli/src/backend/types.ts`；owl 先例：`../owl/docs/plans/2026-07-04-road-to-1.0.0.md` §1.5

## §7 附录：立项调查要点存档

### 7.1 可移植性三档

- **直接复用（经 N0a/N1 暴露后）**：shared 全量；bilibili client；三平台歌词 client + 选优；`sync/{retry,server-url,payloads}` 纯函数；schema + migrations SQL；renderer 队列/恢复/排序/选区纯逻辑。
- **适配层**：db driver 绑定 2 处；裸 `.prepare()` 走 shim；sync 引擎（接口注入）；wbi/歌词的 crypto 与 Buffer 触点过端口（D5）；config/paths/logger 换宿主。
- **必须重写/提取**：UI 全部；Electron main/preload；`download/{ffmpeg,resolve,import}`；`sync/file-ops` 执行器段；fastify 层；daemon/src/sync 协调层（N1）。
- skybridge SDK：候选而非已证明，N0b 判定。

### 7.2 技术栈关键事实（2026-08）

- Expo SDK 57 = RN 0.86 + React 19.2；SDK 55 起仅 New Arch；pnpm isolated SDK 54 起官方支持；`expo/fetch` 支持流式。
- ffmpeg-kit：2025-01 退役、2025-04 下架、2026-07 归档。
- @rntp/player v5 商业授权；expo-audio SDK 57 后台 + 锁屏（需显式启用）。
- drizzle driver（本仓 node_modules 核实）：expo-sqlite 同步但 `prepareSync` 后不 finalize（0.38.4）；op-sqlite 异步；better-sqlite3 driver 顶层 import 原生模块。
- Android：mediaPlayback FGS 无时长上限；侧载 developer verification 2026-09 起分阶段、2027 扩大（N6 go/no-go）；私有目录零权限但卸载即删；Auto Backup 含 DB、Keystore 不跨卸载、部分 OEM D2D 无视 allowBackup。

### 7.3 UI 惯例（11 项目调研）

行操作全走 bottom sheet（无 accordion）；长按进多选；mini player = 播放器 sheet 收起态；队列 = 二层 sheet。InnerTune 停更、OuterTune 停止、RiMusic 归档——抄交互不抄工程。
