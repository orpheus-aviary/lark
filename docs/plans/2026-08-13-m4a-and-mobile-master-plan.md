# m4a 统一 + 移动版主计划（阶段总纲）

> 2026-08-13 v11（九轮评审定稿）。v9 增 §3.6-4 修复批；v10 并入第八轮（fresh/upgrade 闭环、三层 boot、reconcile 自动清障、孤儿规则、探测契约、安全参数、Go 停支持）；v11 并入第九轮（pending 与 0003 同事务 fail-closed、批次防断链 T0a/T1b、协议 v6 定稿批、blocked_environment 恢复入口、ledger 主键 object_key、D16 收敛）。修订历史见 git。
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
| D5 | 复用架构（方向锁定） | N1 提取应用服务层（library / download 编排 / SyncCoordinator）+ 端口：Database / FileSystem / **Crypto（UUID/MD5/SHA-256）/ Base64+TextEncoding** / **AudioLanding（音频落盘策略：桌面 = ffmpeg remux/转码落 canonical，移动 = raw fMP4 直存或 JS remux——单靠 FileSystem 表达不了这项宿主差异）** / CredentialStore / Clock / Logger。**N1 起 CLI direct 后端也改为消费服务层（薄壳），daemon / direct / mobile 三方共享 contract tests**——否则形成第三套语义（F13 的校验漂移已证明这种漂移真实存在）。GUI stores 复用形状与逻辑、注入数据源端口。**portable 落点：workspace 阶段用 `@lark/core/portable` 子路径**——subpath 属于 `@lark/core` 包、不隔离安装依赖（core 直接依赖 better-sqlite3/pino），workspace 内靠 Metro 按需打包 + N1 双守卫拦误引；将来需要独立发包时拆成新包，原 subpath 以 re-export 兼容过渡。 |
| D6 | 音频格式 | 单一格式态：0.3.0 一次性迁移（§3.2 锁定，**按 `file_origin × source_key` 分流，imported 用户资产永不删除**）；新下载 remux 落 m4a；导入归一 m4a。canonical `songs/<uuid>/song.m4a`；served 库恒单格式（迁移期间不服务音频）。音频不参与同步。 |
| D7 | 版本 | Phase A 发 **0.3.0**。 |
| D8 | 协议版本 | `LOCAL_API_VERSION` → **6**。capabilities 新增 `audio_format`、`import_formats`、`llm_available`、**`llm_effective_format`**（后两者 = 经 aviary 回退后的有效状态——public config 只回本地保存值，F5 的「跟随 aviary（当前：X）」的 X 由此而来）。CLI 随发 0.3.0。**升 6 的时点 = T5 末的「协议定稿批」**：v6 的字段与路由分散在 T1–T5 落地，期间 `LOCAL_API_VERSION` 保持 5（同仓开发两端永远同代码无混用面；要避免的是中间版本自称 v6 却缺字段/路由）；定稿批一次性升 6 + accept 字面量同批改，T6 只复核。 |
| D9 | 移动导航 | 四 tab：歌曲｜歌单｜添加｜设置；顶栏搜索 + 同步徽章。 |
| D10 | minibar / 播放页 | minibar 两行（歌名 + 当前歌词行）+ 播放/暂停 + 下一曲；上拉队列；点击进全屏大字歌词页（滚动同步 + 点行 seek）。 |
| D11 | 行交互 | ⋮ → bottom sheet 菜单；长按 → 多选。 |
| D12 | 移动端导入 | v1 不做本地**音频**文件导入（服务层留能力位、「添加」页留入口）。私有目录卸载即删，且 D16 主动把它排除在系统备份之外——`imported` 是用户资产（R1/R26），开放音频导入前必须先有导出/备份故事。**2026-08-17 修订（用户决定）**：这条只约束音频。**歌单 json 不受它约束**——导入产出的是带 `source_key` 的行 + 按需下载的 `downloaded` 文件，全部可重建，卸载重装 + 同步即可复原，没有「只此一份」的东西被创造出来。歌单导出/导入的落位见 §4.5 与 N0 子计划 §5。 |
| D13 | 分享 intent | bilibili app 分享 → lark「添加」页。 |
| D14 | 分发与身份 | 侧载 APK，target 36。N0b 定死：applicationId `com.orpheusaviary.lark`；APK 版本线 0.1.0、versionCode=1；keystore 主副本入加密凭证库 + 独立加密备份（alias / 证书 SHA-256 / 密码 + 恢复演练），不进仓库与 CI artifact。developer verification：截至 2026-08，9 月底的要求只覆盖特定参与商店与地区，**直接侧载暂不受影响**，全球扩大在 2027——**N6 设正式 go/no-go** 复查当时政策。 **2026-08-18（N0b-5b）落定**：keystore 已生成（RSA 4096 / alias `lark` / 有效期至 2054-01-03），主副本与密码同放 `orpheus-aviary/android-keystore/`（用户拍板，见子计划 §9），恢复演练已过；政策快照复核结果同段——**adb 安装明确豁免**，2026-09-30 只覆盖巴西/印尼/新加坡/泰国的参与商店，测量设备在中国不在其列，真正相关的是 2027 全球扩大；若届时需要注册，**limited distribution account**（免费、无需政府 ID、上限 20 台）是匹配形态，注册对象是**包名 + 证书 SHA-256**。 |
| D15 | 传输安全 | **2026-08-25 Stage-4 改写（见下）**：~~移动端 v1 只支持 https~~ → **移动端同时支持 https 与明文 http，由设置页的一个开关决定是否接受明文**。TLS 从「N5 前置」降为**后续**，不阻塞任何批次；负责人仍 = 用户，AI 协助。做的时候验收不变：域名 + DNS · 证书 + 自动续期（告警 + 演练）· 反代 · 两端 `server_url` 迁移 · 真机连通。 |
| D16 | Android 备份/迁移 | `allowBackup=false` + `dataExtractionRules`（12+）与 `fullBackupContent`（11-）显式排除 database/files/sharedprefs/音频/SecureStore 存储（处理 expo-secure-store 插件自动配置冲突）。恢复检测：启动服务/migration/凭证之前，**只读隔离最小打开** DB 读 `install_id` 与 no-backup/Keystore 侧比较后立即关闭；DB 不存在 → 全新库生成双侧；两侧相等 → 正常；任一缺失或不等 → fail closed（不启 sync，清 binding 走重新绑定，曲库数据保留）。**凭证生命周期**：fail closed 时同步清除 SecureStore 旧凭证条目（与 binding 一起）。**收敛（防死循环）**：清理完成后**生成新 install ID 写入两侧**（先写 no-backup 侧意图记录 → 写 DB → 确认；可重入，写一半崩溃重启续写）——否则「检测不一致 → 清理 → 下次 ID 仍不一致 → 再 fail closed」永不收敛；ID 收敛后本地曲库正常可用，sync 保持未绑定等待重新登录。N2 gate 含 D2D restore 测试。 **2026-08-18（N0b-5a）机制落定**：零写打开 = copy-then-open（50MB 库 max 75ms / 带 4MB 热 WAL max 150ms，原件零写）；no-backup 侧 = SecureStore（`requireAuthentication: false`，卸载重装读不出）；排除规则由我方 CNG plugin 全量持有——**`allowBackup=false` 只关云备份，D2D 要 `<device-transfer>`**。详见 §4.3 Stage-2 段。 |
| D17 | 音频 canonical 与 bilibili codec | canonical = AAC in ISO-BMFF、ExoPlayer 可播可 seek。codec 选择在候选列表阶段：解析 `codecs`（`mp4a.40.*`），AAC 候选内按目标带宽取流；无 AAC：桌面转码、移动端拒绝并报错；codecs 缺失视为非 AAC。raw fMP4 直存达标与否 N0b 实测；JS remux 是须过大文件内存测试的候选。 **2026-08-18（N0b-4b）实测：达标，移动端不做 remux**，三级兜底一级未进；详见 §4.3 Stage-2 段。 |

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

**2. pending 门与白名单**。migration `0003`：升 `user_version=3`（单向）、建 ledger 表；不标 `requires_confirmation`。**pending 与 `user_version=3` 在 0003 同一事务内原子置（fail-closed）**——若 pending 在事务外另写，存在「commit 后进程退出 → 下次按正常 v3 启动、mp3 漏迁」的窗口。fresh 库（v0 全新建库一路跑到 v3）由 `createDatabase` 在迁移成功后**随即清 pending**：崩在「0003 commit 后、fresh clear 前」只是 fresh 库下次多走一次空迁移（扫描无 mp3 → 秒清），**方向永远是多迁不漏迁**（补该 kill 窗口测试）。fresh daemon、**fresh `--direct` 首次写**因此即刻可用。所有 v2 升级库，无论初始是否见到 mp3，都必须先 drain journal → 完整 legacy recovery（旧 manifest / `.replace` backup 可能恢复出 mp3）→ 再扫描 → 决定是否清 pending。**schema 契约**：`assertSchemaV2` 升级为 current-schema 契约（v3），覆盖 create / readonly / recovery 三个调用点。**Go 迁移自 0.3.0 停止支持且直接删除不可达实现**（用户拍板，不留高复杂度死模块）：migrate-go/probe-go/fixture-go-db 代码与测试、justfile recipe，连同 `errors.ts` 与 daemon boot 里引导「运行 just migrate-go」的文案一并处理——Go 旧库的拒绝路径保留，文案改指「用 0.2.x 完成迁移后再升级」。测试三组：fresh daemon / fresh direct / v2 upgrade（fixture 含「初始无 mp3 但旧 manifest 恢复出 mp3」）。白名单：`GET /status`、`GET /api/instance`、`GET /api/capabilities`、`GET /api/audio-migration`（认证，新增）、`/events`，**外加 `GET /sync/file-ops` + `POST /sync/file-ops/retry` + `POST /sync/file-ops/discard`（见 10）**；其余路由回 `AUDIO_MIGRATION_PENDING`。GUI 进入独立 migration boot state：只轮询白名单接口渲染进度屏。

**3. 三层 boot 上下文与状态机（架构锁定）**。上下文拆三层：**BaseContext**（DB、config、logger、**mediaTools**、token/auth、事件总线、**guiChannel 与 version/host/port/requestFatal/shutdown 信号**——`/api/capabilities` 要 `mediaTools.refresh()`、`/events` handler 要 guiChannel：**白名单 handler 所需字段必须全部入 Base**，pending 期存在）+ **PendingRuntime**（ledger、migration runner、迁移专用 FileEffectRuntime——供 file-op 列表/retry/discard，见 10）+ **NormalRuntime**（下载/缓存/同步等，late-bound 引用）。**全部路由在 listen 之前一次性注册**（Fastify 5 listen 后加路由抛 `FST_ERR_INSTANCE_ALREADY_LISTENING`）。时序锁定：**listen + 发布 token 之后才后台启动 runner**（否则 GUI 无法观察迁移）。gate 读**内存状态机 `pending → activating → normal | fatal`**，不逐请求读持久标记；`activating` 期间业务仍拒——**NormalRuntime 完整构建成功并原子 swap 之后才置 `normal` 开放业务 handler**，消灭「pending 已清、runtime 仍为空」的窗口。file-op 处理与 runner 共享 mutex，处理完触发 ledger 重扫。激活单次所有权（幂等 guard）；构建失败 = `fatal`（复用 requestFatal 模式）；teardown 覆盖全部状态——pending 阶段停机顺序 = 停 runner（中止/等待 ffmpeg）→ 关 DB。

**4. 进度双通道**。免认证 `/status` 只带 `audio_migration` **计数与非敏感状态分类**（state/done/total/lost/kept/blocked/blocked_file_op 计数）；认证 `GET /api/audio-migration` 给逐条明细（song id、相对文件名、class、原因、建议；不返回绝对路径），**且在 pending 清除后继续可访问**（历史报告；ledger 永久保留）。

**5. 预检（第一首之前）**：ffmpeg 能力清单 · 目标目录可写 · 最低磁盘空间 **`free ≥ max(500MB, 最大单曲 mp3 × 3)`（已冻结）**。任一不过 → pass 不启动，`blocked_environment`，零文件触碰。**ENOSPC 语义澄清（已冻结）**：「停 pass 零删除」指**错误发生时刻起**当前歌与之后零删除；**已达终态（done/lost）的歌不回滚**——write-ahead ledger 保证已完成项一致。不做「为整批预留空间」（预估不可靠）。**恢复入口（锁定）**：认证 `POST /api/audio-migration/retry` = 重新预检并继续，GUI 配「重新检测并继续」按钮——否则用户释放磁盘/装好 ffmpeg 后，当前 daemon 会永久停在 `blocked_environment`。

**6. 错误分类（冻结；分不清一律按环境类，默认不动文件）**：

| 类别 | 例 | 处理 |
|---|---|---|
| 中止 | teardown/AbortError | 非终态：行回 pending、保留 mp3、清 tmp，续跑 |
| 环境（pass 级） | 工具缺失/不兼容、ENOSPC、目录不可写、暂时 I/O | 全局 `blocked_environment`：停 pass、零删除；修复后续跑 |
| 内容（单文件级） | ffmpeg 解码/格式错误、验证不过 | 按 class：R → 弃置；A → 移入 backup，`kept_unconverted` |
| 文件操作失败 | unlink/move EACCES 等 | 该歌 `blocked`（记 `blocked_action`），人工处理后续跑 |

**分型机制（已冻结）**：现有 ffmpeg 层把一切包成 `FfmpegError`，仅靠 message 分类不安全——converter 层按**四路信号**分型：AbortSignal 状态（→ 中止）· spawn/fs 的 errno（ENOENT/EACCES/ENOSPC → 环境）· ffmpeg 退出码 + stderr 模式（解码/格式类 pattern → 内容）· **无法归类默认环境**。具体 pattern 清单在 T2 实现时冻结成映射表（子计划附表），原则本条锁定。

**7. 单曲顺序（终态只在源文件达到终态后写入；`backing_up` 必带 intent ∈ {done, kept}，落 `resume_state`）**：
- R 成功：`converting` → 转码 tmp → ffprobe 验证 → rename canonical → unlink mp3 → `done`。
- R 内容失败：**实时探活 source**——可重下 → `discarding` → unlink → `lost`；探活失败/无网 → 转 A 类路径 `backing_up(kept)` → move → `kept_unconverted`。
- A 成功：`converting` → …rename → `backing_up(done)` → move 原件入 backup → **验证 backup 实际存在** → `done`。
- A 内容失败：`backing_up(kept)` → move 入 backup → 验证存在 → `kept_unconverted`。
- 任何 unlink/move 失败 → `blocked`（记录 action）。

**8. ledger 字段（0003 建表）**：**主键 = `object_key`（相对目录名——孤儿目录可能不是 UUID，song_id 做主键会把它们误当合法歌曲）**；`song_id`（nullable）/ class(R|A|orphan) / file_origin / source_key_present / status(pending|converting|discarding|backing_up|done|lost|kept_unconverted|asset_missing|blocked|blocked_file_op) / blocked_action + resume_state（含 backing_up 的 intent） / error_class + last_error / backup_path（**相对 lark nest 根，绝不存绝对路径**——nest 可经 backup-nest + `LARK_NEST_DIR` 整体搬移，沿 file-op 相对目录先例） / reconcile_action（nullable：被移入碰撞安全 backup 的文件与原因） / at`；**`song_id` 不强制对应现存 songs 行**（file-op 快照可指向已删的歌）；total 首启冻结；不参与扫描的对象也入表并记原因。`done/lost/kept_unconverted/asset_missing` 是真终态；终态后意外出现的 mp3 按协调表**自动移入碰撞安全 backup**（保文件、清 `songs/`、不阻塞完成），`reconcile_action` 与 `asset_missing` 永久保留在报告中。

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
| backing_up(intent) | mp3 在、backup 在 | — | 比较 size/hash：一致 → unlink 源 → 按 intent；不一致 → **源移入碰撞后缀名 `<song_id>.reconcile-N.mp3`（禁覆盖，自动递增后缀）→ 记 `reconcile_action` → 按 intent 收尾** |
| backing_up(intent) | mp3 无、backup 无 | — | `asset_missing` |
| done / lost / kept | mp3 在 | **移入碰撞安全 backup（`<song_id>.reconcile-N.mp3`）、记 `reconcile_action`，不删不覆盖**——文件保住、`songs/` 清空、完成不被阻塞 | 同左 |
| blocked | 任意 | 重试一次 `blocked_action`，成功按 `resume_state` 推进，失败保持 | 同左 |

**10. 旧 file-op 死锁与孤儿目录**。永久失败/退避中的旧 journal op 会占住歌曲目录（recovery 与转换 pass 都必须跳过）。对应对象 ledger 状态 = `blocked_file_op`；pending 白名单开放 file-ops 只读列表 + 受控 retry/discard（见 2），GUI 迁移页列出并可处理；处理完 runner 对这些行重扫。**没有这三个口子，用户将无法自救。** 补充规则：**scanner 以 `songs/` 目录树为扫描对象，不只 DB 行**——旧 op 可能指向已删除的歌（快照写在 journal 里，行早没了）：① journal-owned 目录按 op 快照分类，retry 成功由 op 快照自带的处置收尾；② **discard 后的残留目录整体移入 `migration-backup/orphans/`（保守，不删）**，记 `reconcile_action`；③ 非 journal-owned 的孤儿目录先交 legacy recovery 既有规则处理，仍残留者同 ②。

**11. legacy 消化（转换 pass 之前完成；覆盖完整 recovery 决策表，不止两类对象）**：
- file-op journal：`FileOpArg` 增版本化音频文件字段；无字段的旧 op 由显式 v2 legacy 分支按 song.mp3 世界执行。
- landing manifest：增版本/目标文件名字段，恢复器按版本分派；旧 manifest 按 song.mp3 世界恢复。
- **无 manifest 的 orphan 判定、`.replace` backup、不可读 manifest、dangling commit log**——这些同样依赖 `AUDIO_FILE` 常量，legacy 恢复必须按「song.mp3 + song.m4a 双名」识别，fixture 覆盖 recovery 决策表全表。

**12. CLI 口径**。direct 写在 pending 拒绝；direct 读仅对已升 v3 的库可用（v2 库只读打开抛 `MIGRATION_PENDING`）。**pending 窗口内 `has_file` 探测 legacy-aware（m4a || mp3）**——否则未迁移的歌被谎报成「需要下载」；迁移完成后回到单名探测。管理命令不受影响。

**13. 完成条件**。ledger 无 pending/converting/discarding/backing_up 且无 blocked/blocked_file_op（`asset_missing` 与 `reconcile_action` 记录不阻塞——reconcile 场景已由协调表**自动把冲突源移入碰撞安全 backup**，故与「`songs/` 树内无 mp3」不再矛盾）、**`songs/` 目录树内无 mp3**（`migration-backup/` 不计）→ 清 pending → 状态机进 `activating` → NormalRuntime 构建 + swap → `normal`。终态不变量：served 库（`songs/` 树）永远单格式 m4a。

**14. 验收判据族**：预检三项各自拦截 · 中止不落 lost 且续跑 · ENOSPC 停 pass 零删除 · **弃置前探活（可重下 → lost；无网/探活失败 → 入 backup，不删）** · R 类坏 mp3 → lost、A 类坏 mp3 → backup + kept（**imported 永不消失**）· A 类成功后原件在 backup 且终态前验证存在 · **backing_up 双崩溃窗口（move 前 / move 后未写终态）恢复正确** · **backup 已存在不覆盖（hash 一致/不一致两分支）** · **asset_missing 绝不落 done** · unlink/move 失败 → blocked 且 `blocked_action` 恢复正确 · 协调表逐行夹具 · 终态后手工放回 mp3 → reconcile 不删 · blocked_file_op 经 retry/discard 解锁后续跑 · kill -9 · 进度跨重启守恒 · **仅全新库秒过；v2 升级库先 legacy recovery 再扫描（含「初始无 mp3 但 manifest 恢复出 mp3」夹具）** · CLI direct 写拒绝 / v2 库 direct 读报 MIGRATION_PENDING / pending 窗口 has_file 不谎报 · GUI 进度屏（含复用 CLI 先起的 daemon）· legacy 全表夹具（journal/manifest/orphan/replace-backup/不可读 manifest/dangling log）· 迁移后旧版拒开。

### 3.3 供应链

- 现 lock 已含 demuxer `mov,mp3,aac,flac,wav,ogg,matroska`、decoder `alac/vorbis/opus/aac/mp3` + PCM 仅 `pcm_s16le/s16be/f32le`、`aac_adtstoasc` bsf。增量：`--enable-encoder=aac` + `--enable-muxer=ipod`。
- WAV 支持面 = 实际 decoder 集：子计划二选一——小幅扩（`pcm_u8/pcm_s24le/pcm_s32le`，各配真实样本 gate）或明示仅支持现集。倾向前者。
- 移除 LAME 全套（保留 mp3 demuxer/decoder/parser 供迁移解码）；gate = 全仓无 mp3 产出调用。
- configure 锁值、nonfree 门禁、能力清单（`encoder aac · muxer ipod`）、真实闭环判据更新。

### 3.4 导入矩阵（多格式 → 一律 m4a）

- `probeAudio` 扩 `-show_streams`（音频 codec + 全部 stream 类型 + disposition）。
- **流选择规则（锁定）**：探测选定音频轨后按**全局 stream.index** 映射（`-map 0:<index>`，显式 -map 后其余流天然排除；不许用 `-map 0:a:<n>` 序数语义——封面/视频流排在音频前会选错）；**`attached_pic`（封面图流，mp3/m4a 普遍携带）不算视频流**——「含视频流拒绝」只针对非 attached_pic 的真视频轨，否则会误拒大量正常音频文件。
- 决策表（子计划逐格补全 + 测试）：MP4 族+AAC → remux copy；MP4 族+ALAC → 转码；裸 `.aac` → remux + `aac_adtstoasc`；mp3/flac/wav(支持的 PCM 子集)/ogg → 转码 aac 192k（有损化 UI 明示）；含真视频轨 → 拒绝；无音频流/未知 codec → 拒绝；多音轨 → 取第一条音频轨（按全局 index 定位）并在结果 warnings 注明。
- GUI `pickMp3` → `pickAudio` 全链。**CLI 不新增音频导入命令（已决：记录为 backlog，后续有需要再完善）**，只更新门禁与文案。

### 3.5 协议与下载链路

- `LOCAL_API_VERSION` → 6（**时点 = T5 协议定稿批，见 D8**）；`/audio` `Content-Type: audio/mp4`；`lark-media://` MIME 同步；capabilities 四字段（D8）。
- bilibili：候选阶段解析 `codecs` 按 D17 选流；remux 前断言 AAC。
- 字节进度 wire contract：snapshot 与 `download:status` 事件同增 `received_bytes: number`、`total_bytes: number | null`；仅 `downloading` 阶段有意义；**同一次 downloading 阶段内单调**，任务/阶段切换归零；`revision` 随进度更新递增；事件节流（时间 + 变化双阈值，数值子计划定）且阶段结束强制发终值。CLI：TTY 同行覆盖刷新；非 TTY 按百分比阈值打点，**`total_bytes=null` 时退化为字节量/时间阈值**。
- transfer 导出只含元数据。

### 3.6 PC 改进（0.3.0 随发：三项功能 + 一批「已实现未实装」修复）

**1. 命名清洗（批量修复 + 单链接弹框 + 规则冻结）**

- 现状（bug，代码级确诊）：video 类命名是 `target.title ?? view.title`，批量勾「原标题」= 列表标题、不勾 = 视频自身标题，收藏夹场景两者恒同，勾选框实际无效；「fall back to LLM」只存在于 GUI 注释，管线里 LLM 仅服务 keyword 路径。
- 语义：批量导入不勾 = 清洗、勾 = 原标题；单/多链接粘贴提交时弹一次询问框「原标题 / 清洗命名」，本次提交全部链接项统一生效。
- **wire 落点（锁定，覆盖两条通道）**：batch 通道——命名模式字段放 **video item 级**（`'original' | 'clean'`，必填）；keyword item 无此字段。**单曲通道——`DownloadSongRequest` 增条件必填 `naming_mode`**：路由解析 input 为 video 时必填，为 keyword 时**拒绝（400）**——GUI 弹框与 CLI `--clean-name` 均经此通道（GUI 的多选单项也走 `/download/song` 循环）。弹框/group 勾选把同一值刷到所辖 item。
- 清洗规则（冻结）：LLM 从标题提取歌名 + 歌手；歌手提取不到 → UP 主名；歌名提取不到 → 原标题。复用 `inferSongInfo`。
- LLM 分工：创建时 `capabilities.llm_available=false` → 清洗选项禁用（GUI 灰显、CLI `--clean-name` 报错）；运行时失败 → 回退原题 + UP 主名不失败；**取消/停机异常必须重抛**（现实现捕获所有异常，要区分 abort）。
- **与去重的交互（锁定）**：dedupe key 保持 `bvid+page`；同一 source/page 在途任务策略唯一；策略不同的提交返回冲突错误。**预检时点（锁定）：对「在途任务 + 请求内部重复项」的全量 naming-mode 预检必须在容量检查与歌单事务之前完成**——现实现先提交歌单事务再逐项 merge，冲突若在 merge 层才发现会破坏「所有 group 成功或都不写」的批量原子性。title 快照不参与冲突判定（同策略合并到先到者）。
- CLI：默认 original，新增 `--clean-name`。
- 验收以固定 fixture（录制响应）为主；测试收藏夹（fid=3975154248）作人工 smoke。

**2. 下载阶段细化**：新增 `naming` 阶段（清洗路径上报，位于 resolving 与 downloading 之间）；`downloading` 挂字节进度。标签：解析输入 → 搜索视频 → 定位资源 → 清洗命名 → 下载音频（含百分比）→ **处理音频**（`converting` 有 copy 与转码两种真实操作）→ 落盘 → 匹配歌词。wire 变更随 v6 协议一并出。

**3. 下载进度面板**：当前任务阶段 + 字节进度、排队列表、终态记录。操作术语（锁定）：**取消任务**（queued/running）· **清除记录**（terminal 移出面板）· 删除歌曲不进面板。全部取消 = snapshot 活跃 ID → best-effort 逐项 → 返回逐项结果（saving 阶段如实报「已完成」）。信息结构与移动端「添加」页对齐。

**4. 「已实现未实装」一致性修复批（2026-08-13 全仓双向审计产出，清单与判据见子计划 §7）**

「原标题」暴露的坑型做了一次全仓双向清查（GUI 控件 → wire → core 正向 41 个控件；config/CLI/wire 字段反向全量），全部发现随 0.3.0 一次性修复。最重者：**`sync.interval_min` 只在 daemon 启动时读一次**——设置页改了、落盘了、回读也对，timer 纹丝不动且零提示（修法 = PATCH 后重建 scheduler + 测试断言周期）；其余含冲突差异表漏 `source_provider/source_key`（可渲染出零差异空表）、null payload 时「保留本机」是真 no-op 还推空更新、「去登录」落错 tab、LLM `api_format` 的 `''`（继承 aviary）被伪装成 openai 且单向不可逆、缓存上限调小不触发清理、`--allow-partial` 在 `--batch`/单输入形态完全不读、`--json` 成功路径三处 stderr 泄漏、`--direct` 与 HTTP 的四处校验差（空歌名/空歌单名/不 trim）等。结构性好消息：daemon 的 `objectBody` 未知字段一律 400，字面 dead wire 不可能静默存在——问题全部集中在 semantic no-op、boot-only 与呈现错配三类。

- 不做：格式可配置、mp3 产出路径、回滚、CLI 音频导入命令（backlog 记录）。
- 验收：fetch-ffmpeg 门禁 → 真实下载 m4a → 迁移判据族（§3.2-14）→ 导入矩阵逐格（含 attached_pic 不误拒）→ 命名判据（两分支可区分 · 弹框生效 · 歌手回退 UP 主 · 策略冲突在事务前报错）→ 阶段细化 → 下载面板 → v6 门禁拒旧 daemon → 全量测试 + accept 系列更新 → 九步发版 0.3.0。

## §4 Phase B：Android 移动版（apps/mobile）

### 4.1 架构

```
apps/mobile (@lark/mobile, Expo SDK 57 + CNG)
├── db:       单一 expo-sqlite client（drizzle Expo driver + raw shim 共用；statement
│             生命周期策略 = N0b 三选一，D4）
├── services: N1 产物（library / download 编排 / SyncCoordinator）+ 全套端口（D5，
│             含 Crypto/Base64/TextEncoding/AudioLanding），经 @lark/core/portable 消费
├── 下载:     core bilibili/歌词 client（fetchImpl 注入）+ AudioLanding 的 RN 实现
│             （AAC 流直存，D17）
├── 播放:     PlayerDriver（expo-audio：状态订阅/ended/error/音频焦点与中断的行为处理/
│             锁屏元数据/teardown；耳机断开=行为验收不锁 API）→ 复用队列/恢复逻辑
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

> **2026-08-17 Stage-1 修订**（子计划 `docs/plans/2026-08-17-phase-b-mobile-n0.md` v4 的评审收敛产物，D1–D17 方向不变）：下表有**两处**显式语义修订——**修订①** 落在 N0a 行（harness 覆盖面按实测使用面收窄，决策 c2），**修订②③** 是同一处（N0b 收窄为平台 spike ↔ N1 新增 R1–R5 复验 + D5 分段冻结），跨 N0b / N1 两行。N0 的可开工粒度以子计划为准，本表只保留方向与 gate；D4/D16/D17 的实测结论由 **Stage-2（N0b-5）** 写入，此前不在本表预判。

> **2026-08-18 Stage-2 修订**（N0b 收官，实测证据全在子计划 §9）：**N0b = GO**，判据 11–26 全部完成、gate 项全绿。三个出口按 Stage-1 的约定在此写入，此后以本段为准：
>
> - **D4**：SQLite = **expo-sqlite 57.0.1**；statement 生命周期 = **per-call transient shim**（`prepareSync → executeSync → 完整消费 → finally finalizeSync`；执行已失败时 finalize 会抛它自己的错，只在这种情况下吞掉并照常计数）；drizzle 走**出口②** `pnpm patch`（`patches/drizzle-orm@0.38.4.patch`，未打补丁时 10k 查询漏 10000 条语句；补丁按 `drizzle-orm@0.38.4` 键控，升版即安装失败而不是静默失效）。卡顿 gate 过：冷启动余量两个数量级、backfill 500 首/段、**apply 暂定 200/批**（生产的 500 过不去，R5 用真 `applyChangesInTx` 定稿）。
> - **D16**：机制落定。零写打开 = **copy-then-open**（只复制 main + `-wal`，不复制 `-shm`；复制前后校验 size+mtime，变了重试一次、仍变 fail closed；副本用毕删除）——50MB 库 max **75ms**、带 4MB 热 WAL max **150ms**（预算 500ms），原件 size+mtime 零变，恢复落在副本上。no-backup 侧 = **SecureStore**（`requireAuthentication: false`），卸载重装读不出。backup 排除 = 我方 CNG plugin 全量持有两份规则文件与两个 manifest 属性（**`allowBackup=false` 只关云备份，D2D 要 `<device-transfer>`**；expo-secure-store 的自动配置已关），三层客观判据 10/10。**完整 D2D restore 与 fail-closed 分支仍是 N2 gate 的四组。**
> - **D17**：**raw fMP4 直存达标 → 移动端不需要 remux**（三级兜底一级未进）。时长与 ffprobe 逐毫秒相同、seek 四点偏差 ≤0.001s、37 分钟长曲 95% 处 0.256s、后台+锁屏 330.6s 零暂停。两条 expo-audio 会话缺口归 N3：**`release()` 必须先 `pause()`**（#47569 在 57.0.3 上仍在）、**蓝牙断连不暂停而是转外放**（media3 的 `handleAudioBecomingNoisy` 默认关且 expo-audio 未暴露）。
>
> 另：**D14 落定**（applicationId `com.orpheusaviary.lark`、APK 0.1.0 / versionCode 1、keystore 已生成并做过恢复演练，位置与指纹见子计划 §9）；**分享 intent（D13）平台侧成立**，但分享文本只有 b23.tv 短链、没有 bvid，且**收藏夹分享不到系统面板**——N4 的添加页据此设计。

> **2026-08-20 Stage-3 修订**（用户决定，N4 开工前）——⚠️ **其中「硬阻塞 N5」一句已被下面的 Stage-4 修订推翻，本段留作历史**：**TLS（D15）移出 N4**。下表 N4 行原本写着「TLS 完成死线」——作废。准确口径是：**TLS 不阻塞 N4 的任何子批**（下载链路完全不碰 skybridge），但**硬阻塞 N5**——server 今天仍是 `http://<公网IP>:8443`，而移动端 v1 是 https-only（D15）。N5 开工前必须二选一：补完 TLS（域名 + 证书 + 自动续期 + 反代 + 两端 `server_url` 迁移 + 真机连通），或者单独决定「移动端要不要一个明文开关」。这条同时进 `PROCESS.md` 的待办，**不算被 N4 消掉**。
>
> 同段落另记 N4 的三处范围扩张（同一次用户决定）：**LLM 设置页进 N4**（关键词搜索 / clean 命名 / 多 P 自动选集 / 重新识别四条能力，配置落 `local_metadata` + SecureStore）· **收藏夹 / 合集批量下载进 N4**（不再等 N6 的多选批量）· **加 dataSync 前台服务**（下载在应用不可见时继续）。详见子计划 `docs/plans/2026-08-20-phase-b-mobile-n4.md`。

> **2026-08-25 Stage-4 修订**（用户决定，N5 开工时）：**D15 的「移动端 v1 只支持 https」作废，TLS 不再阻塞 N5。**
>
> 新口径：**移动端同时支持 https 与明文 http**，由**设置页的一个开关**（`local_metadata.sync_allow_insecure`）决定是否接受明文；lark 自己那道门（`portable/sync/server-url.ts` 的 `allow_insecure_http`）原样留着，Android 平台那道门（`usesCleartextTraffic`）拆掉。理由是产品形状而不是省事：**其他用户会自建 server**，让他们先能用明文 IP 跑起来，比先要求每人搞定域名 + 证书更重要；而「只给某个 IP 开洞」和「支持任意自建 server」互斥——`networkSecurityConfig` 的 host 白名单是编译期 XML，运行时没有加例外的 API。
>
> **同一次决定的第二条**：**接受音频走明文**。拆掉平台那道门之后，bilibili 音频流 / 歌词平台 / 用户自填的 LLM 端点都不再被强制 https。代价明确记在 N5 子计划 §1.7 与 `apps/mobile/src/acceptance/downloads.ts` 的注释里——**判据 5 的第二半从此不证明任何东西**，注释改写而不是假装它还被守着。
>
> **TLS 转为后续**（负责人仍 = 用户）：`PROCESS.md` 的待办保留，措辞从「N5 开工前二选一」改成「已选明文开关，TLS 转后续」。真做的时候有一条大陆特有的坑链——阿里云未备案域名的 80/443 被拦 ⇒ 只能用非标端口 ⇒ HTTP-01 与 TLS-ALPN-01 都走不通 ⇒ 必须 DNS-01（Caddy 要带 `caddy-dns/alidns` 重新构建）；另有 Let's Encrypt 的 IP 证书（6 天 shortlived）可完全绕开域名，链路未验。详见 N5 子计划 §0.1。

| 批 | 内容 | gate |
|---|---|---|
| **N0a** | 最小可移植边界（桌面仓内）：migration SQL registry + schema 切面（+ errors 三类 + `migration/pending.ts`）进 `@lark/core/portable` + DatabaseContract harness（prepare/get/all/run · `transaction().immediate()` · **单层事务 rollback** · FK · `PRAGMA user_version` · JSON1 含 CAST · 返回值字段差异 · **statement 生命周期计数组** · **drizzle/raw 共享连接组**）。**修订①（决策 c2）：harness 覆盖面按实测使用面收窄——嵌套 transaction / savepoint 不进契约保证面**（core 零使用；better-sqlite3 与 drizzle Expo driver 双方原生都支持，「嵌套即抛」的旧表述作废）：契约不测试、不禁止、不人为禁用，实现自带能力原样保留，将来要用先扩契约 | 桌面全测试 + 守卫绿 |
| **N0b** | **修订②：N0b 是平台 spike，不是业务图验证**——workspace 内部包只 import `@lark/core/portable` / `@lark/shared` / skybridge SDK（core 业务模块要到 N1 端口化后才能被 Metro 解析），其余判定用显式标注的探针 + 桌面用真 core 产出的夹具（WBI 三件套、音频流 header 集）。内容：Expo 57 进 workspace；expo-sqlite shim 跑 harness + migrations（op-sqlite 对照）；**drizzle statement 生命周期三选一定案 + JS 卡顿 gate（D4，proxy 负载）**；expo-audio 播真实 bilibili AAC 流（raw fMP4 判定，D17）+ 后台/锁屏/音频焦点（单 player vs playlist）；分享 intent；skybridge SDK RN 判定（`expo/fetch` 下 bundle/import · login/pull/push · SSE 流读 · abort/重连 · 离线恢复）；落定 D14 + **D16 机制（gate）** | 全判据过 → GO/NO-GO；**冻结分段（下同）：N0b 只冻结有真机证据的子项**（SQLite 选型与 statement 生命周期出口、crypto 形态、polyfill/端口三栏清单、raw 直存判定、D14/D16 机制、分批暂定值）。**2026-08-18：N0b = GO，冻结文本见本节 Stage-2 修订段** |
| N1 | core 端口化 + 应用服务层 + SyncCoordinator 提取（冻结不变量原样保留；daemon 改消费提取物、**CLI direct 改薄壳消费服务层，daemon/direct/mobile 三方 contract tests**；桌面行为零变化）。gate 另加三守卫：portable 面 Node builtin/原生依赖 rg 守卫 + Expo/Metro bundle smoke（进 `just check`）+ **pnpm install + `expo prebuild`/原生构建 smoke（独立必跑 recipe，不进默认 `just check`——太重）**。**修订③：新增出口判据组 R1–R5「真机业务图复验」**——端口化后用**真实 core 代码**在真机复跑 bilibili 全链（含真实 WBI 算法）/ `link.ts` 解析 / 歌词三平台 / `runFullBackfillInTx` 满工作量 / `applyChangesInTx` 生产批次与卡顿阈值定稿 | 桌面全测试 + 三守卫绿 + **R1–R5 全绿 → D5 剩余子项冻结**（R 系列过完之前不做「D5 全部冻结」的宣称）。**2026-08-19 完成：R1–R5 全绿，冻结文本见 N1 子计划 §8.1（单一事实源）** |
| N2 | **D16 身份门（顺序在打开原库之前）** + 移动数据层（完整打开分派 + `ensureDeviceUuid` 下沉）+ 端口实现与 **file-op 执行器** + 服务层接线 + 曲库/歌单读写 + 四 tab 骨架 + **蓝牙歌词的判定函数**（`@lark/shared` 纯函数 + config 字段，接线在 N3）。**子计划 `docs/plans/2026-08-19-phase-b-mobile-n2.md`（v3，两轮评审收敛，决策 a–o 待关闭）**；头号决策 a = **原子替换**（expo-file-system 57 在 Android 上两条路都堵着，见子计划 §1.5）。**相对主计划本行的三处范围修订**：① **file-op 执行器与 boot drain 从 N4 提前到 N2，且控制面从桌面 `FileEffectRuntime` 提取进 portable**（`deleteSong` 无条件 drain、契约断言目录已删，三者无法同时成立；两套 scheduler 到 N5 必然漂移——子计划 §1.8）；② **`ensureDeviceUuid` 下沉进 portable**（它今天是桌面专有的，缺它则一切业务写入抛错——子计划 §1.7）；③ **D16 的完整 D2D restore 拆成独立 gate**（`bmgr` 证明不了 device-transfer 那条路，子计划判据 16b） | 真库副本可读写 + LibraryContract 18 例三 hook 全绿 + D16 四组 |
| N3 | 播放：PlayerDriver + minibar + 全屏歌词页 + 队列 + 后台/锁屏/焦点 + **蓝牙歌词接线**（订阅行号变化 → `updateLockScreenMetadata`，节流按行不按时间；开关 UI）。**耳机断开自动暂停等写成行为验收判据，不锁定回调接口**（expo-audio 由库层自动停止，官方无 becoming-noisy 事件 API） | 真机整晚播放不掉 + 行为判据 |
| N4 | 下载：AAC 选流 + RN 落盘 + 添加页 + 分享 intent + ensure-file + 缓存管理。**~~TLS 完成死线~~（2026-08-20 Stage-3 修订：移出，见上）**；**同次修订加进本批**：LLM 设置页与四条能力 · 收藏夹/合集批量 · dataSync 前台服务。子计划 `docs/plans/2026-08-20-phase-b-mobile-n4.md`（**v2，一轮反例评审收敛**，七批 N4a–N4g / 判据 40 条 / 决策 a–p）。**桌面侧三处提取**（preflight / EvictionScheduler+SongLeaseRegistry+canRedownload / AudioLanding 契约）一律零行为变化 | 真实 bilibili 闭环 |
| N5 | 同步：移动接线（端口注入 SyncCoordinator）+ 徽章/冲突页/file-ops UI + **明文开关**。**~~开工前置：TLS 关口~~（2026-08-25 Stage-4 修订：用户选了明文开关，TLS 不再阻塞）**。子计划 `docs/plans/2026-08-25-phase-b-mobile-n5.md`（六批 N5a–N5f / 判据 65–84 / 决策 a–j 全关） | 与桌面双端真机往返 |
| N6 | ~~多选批量~~（2026-08-24 移到 N4i）+ 歌单导入 + 设置收尾 + 打磨 + 签名 APK 发布 + developer verification go/no-go | 验收 harness |

> **2026-08-24 顺序修订**（用户决定）：N4 尾部插两批，执行顺序 **N4h（多行粘贴，已完成）→ N4g（ensure-file + 缓存管理 + 歌单导出 + 重新下载）→ N4i（歌曲页多选批量 + 行菜单补齐：复制链接 / 用 app 打开 / 更改链接含重新识别）**。字母是登记顺序不是执行顺序。多选批量因此从 N6 提前——它与行菜单是同一屏的同一套手势，分两批做等于把一个交互决定拆开两次。范围见 `docs/plans/2026-08-24-phase-b-mobile-n4h.md` 头部。

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
| **蓝牙歌词被 AOSP 的 queue 陷阱吃掉**（2026-08-19 新增） | `MediaPlayerWrapper.isMetadataSynced()` 在 queue 非空且 `activeQueueID != -1` 时比对 queue item 与 session metadata 的 (title, artist)，不一致就等 `CALLBACK_TIMEOUT_MS = 2000` 超时才推——**歌词写进 title 而 queue item 还是歌名正中这个分支**，表现是每行延迟 2 秒并被合并。逃生口 = queue 为 null 或 `activeQueueID == -1`（media3 会从 timeline 生成 queue）。N3 用 `dumpsys media_session` 验；真踩上要给 expo-audio 打补丁或加 config plugin。**用户已决定无带屏设备不实测、先开发** |

### 4.5 明确不做（v1）

本地**音频**文件导入 · 跨端遥控 · 后台定时同步 · Android Auto / widget / 逐词歌词 · iOS（v2 议题）。

**2026-08-19 修订（用户决定）——「蓝牙歌词」进 v1，只做 Android**：

- **机制**：AVRCP 没有歌词字段，实现一律是**复用 TITLE**——关掉开关时 TITLE = 歌名，打开时 TITLE = 当前歌词行，随播放改写。应用侧不碰蓝牙 API，只写系统 Now Playing（Android = MediaSession），蓝牙栈自己去取。**与「逐词歌词」无关**，那条继续不做。
- **桌面（macOS）整个不做**：`MPNowPlayingInfoCenter → AVRCP` 这一跳查不到 Apple 的任何承诺（只有零散用户报告），而 `electron-builder.yml` 只有 mac 一个 target、Mac 连车机的场景极少。**若将来要做，先验这一跳再说，别先写代码。**
- **落点**：判定函数（纯函数，`@lark/shared`，唯一有逻辑的地方）+ config 字段 → **N2**；订阅、节流、开关 UI → **N3**（`expo-audio@57.0.3` 的 `updateLockScreenMetadata` 已经是同步 API，**不需要写原生模块**）。
- **前提写明**：用户**没有带屏幕的蓝牙接收端**，S1/S2 两个实测都不做，按成熟方案先开发、后续有问题再修。§4.4 新增的那条风险是这个决定的已知代价。

**2026-08-17 修订（用户决定）——「歌单导入导出」移出本清单，进 v1**：

- **导出 → 系统分享面板**（N4）：写进 cache 目录 → `expo-sharing` 交给系统分享（FileProvider URI），收方负责耐久性。**不碰 SAF、不需要持久化存储故事**，所以 D12 的前置条件从未被触发。N4 本来就要做分享 intent 的接收侧（D13/R2），发送侧是同一片原生区域。
- **导入 ← 桌面导出的去 id 歌单文件**（N6，排在 N4 之后）：`expo-document-picker` 读一次 → 预览 → 提交。**贵的是预览/提交那套 UI**（suspects 逐条选合并、预览与提交靠整文件 SHA-256 咬合、提交时重跑匹配），不是文件 IO；且没有 N4 的下载链路，导入进来的全是点不响的行。
- 两个已知依赖点：`previewImport` 探磁盘（`transfer.ts:262` 的 `songFileInfo(...).has_file`）压在 N1 的 FileSystem/Paths 端口上（本来就要做）；整文件 sha256 会给 Crypto 端口一个比 `inlineDigest` 大得多的输入——10,000 首上限约 2MB，按 N0b-3 实测的 ~3MB/s 是单次约 660ms、预览+提交一来一回约 1.3s，**这是 N0b-3 留下的「出口 B（sha256 转 async）」第一次真有理由被取用的场景**，做这批时连它一起评估。
- 不变的部分：同一账号同一 workspace 的两台设备**仍然靠同步**收敛，导出文件服务的是同步结构上做不到的三件——跨账号、给别人、离线备份。

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
- Android：mediaPlayback FGS 无时长上限；developer verification 2026-09 底只覆盖特定参与商店/地区、**直接侧载暂不受影响**、2027 全球扩大（D14，N6 go/no-go）；私有目录零权限但卸载即删；Auto Backup 含 DB、Keystore 不跨卸载、部分 OEM D2D 无视 allowBackup。

### 7.3 UI 惯例（11 项目调研）

行操作全走 bottom sheet（无 accordion）；长按进多选；mini player = 播放器 sheet 收起态；队列 = 二层 sheet。InnerTune 停更、OuterTune 停止、RiMusic 归档——抄交互不抄工程。
