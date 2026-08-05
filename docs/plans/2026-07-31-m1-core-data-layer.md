# lark M1 计划：core 数据层

> 2026-07-31 首版；2026-08-03 一轮评审修订 9 项：迁移残留恢复必须先过迁移锁（活锁报忙、陈旧锁取得恢复所有权后才准动文件）+「迁移 × createDatabase 并发」子进程测试；source_* 不变量修正为「仅 provider/key 同空同有，source_url 独立可空」（首版「三元组同空同有」与主计划冲突，会拒掉手填非 B 站链接）；swap 协议补 handle 先关闭 / sidecar 清理 / checkpoint busy 断言 + 注入式**第二段** rename 失败测试（非空目录只能挡第一段）；core 内凡拼文件路径一律先过 UUID 强校验；config 0600 原子写 + 运行时值域校验 + Public 白名单投影 + 深层 redact；runner 同事务 stamp + `==LATEST` 亦做 schema 签名快检 + destructive marker + ensureDeviceUuid 校验存量值；listSongs 锁定「过滤 → JS 全量排序 → song_id tie-break → 分页」管道；reorderSong 锚点契约定案、归一化波及行一并 bump LWW；撤回 sync 三表补 0011 列的提议，回归主计划形态。
> 2026-08-03 二轮评审修订 13 项：createDatabase 判定前**零写入**（`journal_mode=WAL` 后移到确认兼容之后，拒绝路径断言文件不变）；崩溃恢复补全 `{main, migrating, old-swap}` 全组合状态机（main+old-swap 验主库后清理、migrating-only fail-closed 绝不删唯一数据）+ 迁移锁 pid+nonce 竞态安全回收协议；抽**唯一** `assertSchemaV1`（7 表 + 索引 + 必需列，createDatabase `==LATEST` / 迁移幂等短路 / swap 前验收三路径共用）；ABI 改**双运行时真值探测**（Electron 侧 `ELECTRON_RUN_AS_NODE` 实例化 + rebuild 后复验）+ 锁定 `@electron/rebuild`；LLM 回退改**空串即未配置**判定（`??` 对字符串 schema 无效）+ `api_format` 参与回退 + 运行时校验覆盖类型错误；listSongs tie-break 字段修正为 `id` 恒升序 + LIKE 补转义符自身与 `ESCAPE`；source 空串归一 NULL + provider 白名单 `'bilibili'`；Go 可空列显式映射（artist/lyrics_offset/duration 补默认、name NULL 报 id 中止）；CRUD 写函数拆内部 `…InTx` 事务体为 M5 组合写预留；`InvalidIdError`/`InvalidReorderError` 入错误类清单；`setFileOrigin` 标内部能力；scope 字典冲突上抛待定；modules 值回填（Node 137 / Electron 148）。
> 2026-08-03 三轮评审修订 9 项：迁移锁**弃自研 O_EXCL + pid + nonce**（compare-and-delete 无法原子化，A/B 双确认后 B 的 unlink 会删掉 A 刚建的新锁，TOCTOU 靠 nonce 关不死）改 **SQLite `BEGIN EXCLUSIVE` OS advisory lock**（内核 fcntl 锁、崩溃自动释放，陈旧锁问题整体消失；偏离主计划 step 1 的机制、互斥语义不变）+ barrier 固定交错的确定性并发测试；`loadConfig` 对**已有 0644 配置文件强制收紧 0600**（真实存量文件即 0644，chmod 失败明确抛错）；main+old-swap 恢复升级为只读全套验证（user_version + 签名含定义指纹 + integrity + FK）、old-swap 验证通过后**归档不删**、写明**不承诺掉电一致性**；api_format 回退顺序锁定（默认空串、防 deepMerge 填 `'openai'` 掩盖磁盘缺失）；electron-rebuild 命令契约固定（根目录 + `--module-dir .` + `--which-module better-sqlite3` + `--version` + `--build-from-source`）；`deleteSong` **不提供可组合 `…InTx`**（文件补偿不得脱离 wrapper）；bilibili source_key 语法校验 `BV…:<cid>`（R30 身份契约的 core 边界）；redact 补顶层精确路径 `api_key`；三处文案冲突修正（迁移锁不进 paths / daemon 范围措辞 / setFileOrigin 与 T5 关系）。
> 上游：`2026-07-16-ts-rewrite-master-plan.md` §6 M1 行 + §3.1（schema v1）+ §3.2（sync 预留）+ §3.3（Go 迁移协议）+ R18/R20/R22/R23/R30/R32；PROCESS.md M0 遗留两条（daemon console logger 置换、ABI recipes 随 better-sqlite3 落地）。
> 完成标准（主计划）：`just check` 全绿 + 对应测试绿 + 用户验收关键路径。**sync 三表建表即止，不写事件（R2）。**

## 0. 目标

1. **基础设施三件套**：config（smol-toml 深合并默认值 + aviary LLM 回退 + 原子保存）、logger（pino + pino-roll + redact 双工厂）、paths 补全（trash / aviary config；迁移旁路文件从 dbPath 派生、不进 paths）。daemon 的 console logger 换成 core logger（M0 遗留，接口已按 pino 形状预留，drop-in）。
2. **DB 基座**：schema v1（主计划 §3.1 全量 DDL：CHECK / partial unique index / sync 三表 / local_metadata）+ migration runner（`PRAGMA user_version`）+ device_uuid 初始化 + songs/playlists CRUD——core 单一写入路径、本地字段独立更新路径（R18）、稀疏 rank（R7）。
3. **Go 版 songs.db 一次性迁移**：§3.3 协议全实现（DB 级排他 + backup API + 原子交换 + 幂等重试）+ 真实形态 fixture 测试 + `just migrate-go` 用户入口。**M1 只交付能力并在副本上验收，不迁真实库**——迁移后 Go 版无法再打开库；正式迁移时机由用户另定。（**后记：真实库已于 2026-08-05 迁移**，20/2/4，备份留在 nest；见 `PROCESS.md` M1 条目。）

## 1. 范围

**M1 做**：上述三项 + ABI 切换 recipes（M0 占位兑现）+ 对应 vitest 测试。

**M1 明确不做**：

| 推迟项 | 去处 | 理由 |
|---|---|---|
| daemon 侧一切新行为（路由 / PID 锁 / token / SSE / CORS 扩展…） | M2 | M1 对 daemon 的唯一改动 = logger 置换（T6），其余全部推迟 |
| URL 规范化、provider key 生成（p→cid 解析） | M3 | M1 的 `source_*` 字段只存取校验（同空同有 + 唯一冲突），不生成——生成需要联网解析 |
| ffprobe duration 探测、本地 mp3 导入的文件操作 | M3 | 需要 ffmpeg 封装；迁移路径的 duration 直接搬 Go 库存量值 |
| 缓存清理 / LRU / 探活 | M5 | M1 只落 `last_accessed_at` / `pinned` / `file_origin` 的存取路径 |
| CLI `--direct` backend | M6 | core CRUD 返回 shared 线类型，接口形状 M1 就绪 |
| sync 事件写入 / emitSyncChange | v0.2 | 建表即止；写路径收敛单一函数，v0.2 补 emit 是机械改动（R2） |
| **真实旧库的正式迁移** | ~~用户后定~~ **已于 2026-08-05 完成** | 见 §0.3；M1 验收全部在副本上做 |

**工具前置**：Xcode Command Line Tools + python3（node-gyp 从源码编译 better-sqlite3，M1-13 的 `build-release` 路线不吃 prebuilt）；`sqlite3` CLI（验收抽查，macOS 自带）。

## 2. 调查实测（2026-07-31，fixture 与协议细节的依据）

### 2.1 真实旧库与 Go 版语义（`~/orpheus-aviary-nest/lark/`，只读核对过）

- schema 与主计划 §3.3 预期一致：`songs(id, name, artist DEFAULT '', created_at TEXT, lyrics_offset REAL, duration REAL)`、`playlists(id, list_name, is_system)`、`playlist_songs(playlist_id, song_id, position INTEGER, PK(playlist_id,song_id))`；无任何显式索引；`user_version=0`（Go 版根本不用它）；DELETE journal，无 WAL 旁文件。
- **`duration` 是 ALTER 追加列**（Go 版 `db.go` 忽略错误地补列），极老库可能没有；真实库有。
- 数据形态：20 首歌 / 3 歌单（含 all）/ 24 成员关系。**position 从 1 起、删歌不重排、有空洞**（all 歌单 20 行的 position 是 4..26），单歌单内无重复 position、无孤儿行。`(n+1)*1024` 的 rank 换算对空洞序列仍严格递增，主计划公式直接可用。
- **all 歌单靠 `is_system=1` 定位**（id 是随机 UUID、`list_name` 是字面 `'all'`，不能按名字判）；其 20 条成员关系已物化落表，迁移时连同歌单行一起丢弃。
- `created_at` 是**带 `+08:00` 本地偏移的 RFC3339、无小数秒**（`2026-02-23T03:53:29+08:00`），解析时不能当 UTC Z。songs 无 `updated_at`，playlists 无任何时间戳。
- id 全部是小写连字符 UUID v4（`google/uuid`）。`lyrics_offset` 实库有负值（-26.5），合法。
- 磁盘布局与 TS 版完全一致（`songs/<uuid>/{song.mp3, lyrics.lrc}`），**迁移只动 DB、文件原地不动**；`songs/` 下有 `.DS_Store`（迁移不扫盘，无影响）。
- nest 目录已有 Go 版 `daemon.pid`（旧 daemon 端口 47020）和 `lark_config.toml`（实际写了 `[llm]`/`[window]`/`[font]`/`[log]` 四节，含真实 api_key；Go 代码还支持 `display`/`download`/`daemon` 节但文件里没有）——TS config loader 第一天就要面对这个存量文件。

### 2.2 owl 基线要点（照抄源，含三处「owl 与主计划不一致」）

照抄对象：`owl/packages/core/src/db/{index,migrate,backup,probe}.ts`、`config/index.ts`、`logger/index.ts`、justfile ABI recipes。必须带走的实测结论：

- `createDatabase` 的 **user_version 五路分发**（`>LATEST` 拒绝 → `==0` 空库建表 → `==0` 非空另判 → `<LATEST` 前滚 → `==LATEST` 打开），且 `>LATEST` 检查必须排在 `==0` 之前；**任何抛出路径都要先 `sqlite.close()` 再 rethrow**（防 fd/WAL 锁泄漏）。PRAGMA：WAL + foreign_keys + busy_timeout 5000。
- **全新库也走完整 forward 链**（先 exec 0001 stamp 1、再推到 LATEST）——新装老升同一条码路，这是 owl 修过 bug 的设计。
- runner 契约：每个迁移一个独立事务、user_version 由 runner stamp（迁移体里不写）、迁移文件一旦 ship 不可改（INVARIANT 头注释）。
- `locking_mode=EXCLUSIVE` 是**惰性的**，必须做一次真实读（如 `SELECT count(*) FROM sqlite_master`）才真正取得排他锁；`busy_timeout` 要先归 0。ATTACH 不得在 EXCLUSIVE/IMMEDIATE 事务内（M1 用 JS 搬行，不涉及，见 M1-8）。
- `backupDatabase` = better-sqlite3 online backup API 一行封装，产物自包含单文件无 WAL 旁件。
- `probeDaemonPid` 按约定重实现而不 import daemon 包（core←daemon 会成环）；pid 进程已死则**顺手清理陈旧 pid 文件**。
- 事务统一 `sqlite.transaction(fn).immediate()`；CRUD 签名统一 `(db, sqlite, ...)` 双句柄。
- **本地字段独立更新有现成先例**：owl `setNotePinned` 只写 pinned、不调 stamp、不碰 `updated_at`/`lww_counter`（注释原文："pin is UI metadata, not content state"）。
- **owl 与 lark 主计划不一致的三处，以主计划为准**：owl 没有 `integrity_check`（只有两道 `foreign_key_check`）——R20 明确要求，lark 补上；owl 的 `.migrate.lock` 撞车只报错让用户手删——主计划 §3.3 step 1/7 要求写 pid + 活性回收，lark 实现之；owl 迁移测试不用真实旧库文件——lark 除程序化 fixture 外还要在真实副本上做验收演示（主计划 M1 行「真实旧库 fixture 测试」）。
- owl 的 `.sql` 文件 + `copy-sql.mjs` 构建坑、`deepMerge` 浅拷贝共享引用、`saveConfig` 非原子写、`max_age_days` 死字段、uuid 包与 `randomUUID()` 双轨——lark 均不继承（M1-1/M1-6/M1-3）。
- 版本参考（owl lock 实际解析值）：better-sqlite3 11.10.0、drizzle-orm 0.38.4、pino 9.14.0、pino-roll 2.2.0、smol-toml 1.6.1；drizzle-kit 是死依赖（迁移是手写 SQL + user_version runner），lark 不装。

## 3. M1 内定决策（有异议随时推翻）

| # | 决策 | 说明 |
|---|---|---|
| M1-1 | **迁移文件形态：TS 模块内嵌 SQL + 显式注册表**（`db/migrations/0001-init.ts` 导出 `{ version, sql }`，`migrations/index.ts` 手工数组注册），不用 owl 的 `.sql` 文件 + `copy-sql.mjs` + `readdirSync` 扫描 | lark 用 vitest 跑 TS 源码（M0-3），`.sql` 会造成 src/dist 双路径解析 + 构建期 copy 步两个坑；显式注册表消除 readdir 歧义。INVARIANT 头注释约定原样保留（一旦 ship 不可改，改动走 NNNN+1） |
| M1-2 | **drizzle 列属性名直接 snake_case**（`source_url: text('source_url')`）；时间戳列一律 `integer(..., { mode: 'number' })`（unix-ms 数值），`pinned` 用 `{ mode: 'boolean' }` | 全仓线协议就是 snake_case + ms 整数（顶层 CLAUDE.md），owl 的 camelCase 属性 + `timestamp_ms`(Date) 需要一层映射，lark 免掉：查询结果基本即线类型 |
| M1-3 | **不引 `uuid` 包**：id 生成用 `node:crypto` 的 `randomUUID()`；shared 加 `isUuidV4()`（小写 v4 正则）供 R10 强校验复用（daemon/GUI/CLI 后续同用） | owl 新代码已全面转 `randomUUID()`，uuid 包是历史遗留 |
| M1-4 | **v0.1 LWW stamp：行内单调 `nextLwwStamp(prev)`**——`now > prev.updated_at` → `(now, 0)`，否则 `(prev.updated_at, prev.lww_counter + 1)`；单一 helper，业务写入事务内调用 | R32 已把 server-normalized HLC 定为 v0.2 议题，v0.1 = 本地时间戳；行内单调保证同行连续写入的三元组仍全序。v0.2 换芯只动这一个函数 |
| M1-5 | **本地字段路径**（`setPinned` / `touchLastAccessed` / `setFileOrigin`）不碰 `updated_at`/`lww_counter`/`device_id`（R18，owl `setNotePinned` 先例）。**reorder 与 owl 相反：要碰 LWW 字段**——rank 是 `playlist_songs` 的同步字段（R19），不是 UI 元数据；中点路径只 bump 被移动行，**归一化路径对所有实际被改 rank 的行一并 bump**（它们的 rank 真的变了）。归一化的 change storm 是 v0.2 议题（R32），v0.1 不写事件无实害。成员增删**不 bump 所属 playlist 行**的 LWW（跨实体不耦合） | |
| M1-6 | **config schema v1 五节**：`[llm]{url,model,api_key,api_format}` / `[window]{width,height}` / `[font]{global_font_size,lyrics_font_size}` / `[log]{level,max_size_mb,max_backups}` / `[storage]{cache_limit_mb=0}`。存量未知键（`display`/`download`/`daemon`/`max_age_days`）经 deepMerge **原样保留、不生效**；**port 不进 config**（47100 常量，renderer CSP 已烧死该值）；`saveConfig` **原子写且 0600**（随机临时名 + `'wx'` + mode 0600 → rename，rename 后断言终态权限——文件存真实 api_key）；**`loadConfig` 对已有文件先强制收紧 0600 再解析**（真实存量 `lark_config.toml` 当前是 0644，只加载不保存的路径也必须收紧；chmod 失败明确抛错，不得带已知不安全权限继续运行）；`loadConfig` 附**运行时类型与值域校验**（磁盘输入 TS 类型管不到：类型错如 `api_key = 123`、`window.width = "wide"`，与 level 非枚举、数值非有限/越界，一律收敛回默认，取值容错不抛错）；`redactConfig` 是**已知字段白名单投影**（未知键只做磁盘 round-trip，绝不进 Public 投影 / 未来 `GET /config`）；deepMerge 以 `structuredClone(defaults)` 起底（修 owl 浅拷贝共享引用问题）；aviary 回退按**空串即未配置**判定——lark LLM 字段全是字符串，`''` 视为缺失、显式空串判定后回退（首版「布尔/数值用 `??`」的说法对纯字符串 schema 无效，`??` 对 `''` 根本不回退；owl 那条教训留待未来真引入布尔字段时适用）；`api_format` 回退顺序锁定：`DEFAULT_CONFIG.llm.api_format = ''`（空串=未配置，与其余三字段同规则——若默认直接填 `'openai'`，deepMerge 会掩盖「磁盘上缺失」，aviary 值永远采不到）→ 逐字段 aviary 回退 → `resolveLlmConfig` 输出时最后兜底 `'openai'`；「本地齐全跳过读 aviary」的短路条件 = **四字段皆非空**；类型放 shared（Node-free，`config-types.ts`），含 `PublicLlmConfig`（api_key → has_api_key）脱敏投影供 M2 `GET /config` | owl 的 `max_age_days` 是从未使用的死字段，lark 类型里不收；文件里有则按未知键保留 |
| M1-7 | **迁移触发与入口**：`createDatabase` 检测 Go 旧库（`user_version=0` 且 schema 非空且 `playlists.is_system` 列存在）→ 抛 `GoMigrationRequiredError`（不自动迁移）；执行入口 = `just migrate-go` → `packages/core/scripts/migrate-go.mjs`（交互 y/N 确认，owl `just migrate` 模式），尊重 `LARK_NEST_DIR` | 自动迁移会在 M2 daemon 首次起动时不打招呼地动用户曲库；显式入口 + 确认对齐 owl，也让 M1 有独立于 daemon 的用户验收路径 |
| M1-8 | **§3.3 落地取舍**：保留 `integrity_check`（源库预检 + 临时库验收各一次，R20）——偏离 owl、遵主计划；迁移锁机制统一见 M1-10（三轮评审改为 SQLite `BEGIN EXCLUSIVE` 的 OS advisory lock，偏离主计划 step 1 的 O_EXCL + pid 方案，互斥语义不变且崩溃自动释放）。行搬运用 **JS 逐行 transform**（不用 owl 的 ATTACH+SQL）：需要时间戳解析失败兜底、rank 换算、UUID 强校验，JS 清晰且行量仅 20 级别。文件命名按主计划：`songs.db.migrating` / `songs.db.old-swap` / `songs.db.bak-go-<ISO时间戳>`（ISO 到毫秒并做存在性检查，不覆盖既有备份）。旧 daemon 探活 = `daemon.pid` 活性（陈旧则清理）+ best-effort `GET 127.0.0.1:47020/status`（短超时，仅友好提示用；真正的护栏是 EXCLUSIVE 锁） | |
| M1-9 | **旧库形态容错**：`duration` 列缺失容忍（ALTER 追加列，owl 容忍 `auto_delete_at` 同款先例）按 0 搬；其余表/列缺失一律 `SchemaMismatchError` 中止；`created_at` 解析失败 → 迁移时刻 + 记日志（主计划既定）；同歌单**重复 position**（理论可能）→ 验收「rank 严格递增」不满足即中止（fail-closed，真实库无此情况） | |
| M1-10 | **崩溃恢复状态机 + 迁移锁**（`createDatabase` 开头、先于打开连接——open 本身会在缺失路径上创建空库文件）。**锁 = OS advisory lock（三轮评审定案）**：`${dbPath}.migrate.lock` 是一个专用 SQLite 库，取锁 = 打开它并 `BEGIN EXCLUSIVE`（一次真实写触发）——内核级 fcntl 锁，进程死亡（含 `kill -9`）由内核自动释放，**「陈旧锁」概念整体消失**：无 pid、无 nonce、无回收仲裁；竞争者收到 `SQLITE_BUSY` → `MigrationBusyError`；锁文件本体**常驻不删**（删除锁文件会重新引入竞态窗口，其存在与否不携带语义）。前两轮的 O_EXCL + pid + nonce 自研方案**废弃**：「重读核对 → unlink → 重建 → 回读」的 compare-and-delete 不是原子操作——A、B 双双确认旧锁陈旧后，B 的 unlink 可以删掉 A 刚建的新锁，双方都自认持锁、败方还可能清掉胜方的 `.migrating`。此机制偏离主计划 §3.3 step 1 的「O_EXCL + 写 pid + 活性回收」——互斥与防死锁语义不变且更强，随本计划修订记录。**一切残留处置 / 迁移 / 临时库清理都在持锁下进行**，锁释放前完成全部文件操作。**`{main, migrating, old-swap}` 全组合状态表**：仅 main → 正常；main+migrating → 删 migrating（源库未动）；**main+old-swap**（第二段 rename 成功、删 old-swap 前崩溃）→ 在**只读连接**上验 main：`user_version==1` + `assertSchemaV1`（含定义指纹，T3）+ `integrity_check` + `foreign_key_check`，全过 → old-swap **改名归档为恢复备份**（`songs.db.old-swap.bak-<ISO>`，不立即删除），任一不过 → **fail-closed 拒绝启动、两份现场俱保留**（不猜哪份是真身）；仅 old-swap 或 old-swap+migrating（两段 rename 之间崩溃）→ 恢复 old-swap → main、删 migrating；**仅 migrating**（main 与 old-swap 皆缺）→ **fail-closed**：它是现场唯一可能完整的数据文件，绝不删除后建空库，报错指引从备份 / `.migrating` 人工恢复；三者并存 → 非正常流程可达，fail-closed；全缺 → 新库正常创建。**协议边界**：覆盖进程崩溃，**不承诺掉电一致性**（rename 未跟目录 fsync，断电可能回退到 rename 前的合法旧状态——由备份 + 幂等重试兜底） | owl 只有同次运行内回滚，无跨次环节。并发测试全部**确定性编排**（barrier 固定交错，不做概率测试）：子进程持锁以 stdout 信号同步 → 主进程确定得 `SQLITE_BUSY`；子进程持锁后 `kill -9` → 主进程立即取锁成功（内核释放） |
| M1-11 | **sync 三表按主计划既定形态建**（owl 0004+0005+0007 最终形态）；**撤回首版「补 0011 四列」的提议**——v0.2 冲突协议尚未设计，为省一次迁移提前冻结 conflict schema 反而绑死 v0.2（评审意见）；三表**不进 drizzle schema**（v0.1 无读写，raw SQL 建表即止，owl 同款） | |
| M1-12 | **版本策略**：better-sqlite3 **开工首日核实对 Node 24.13 + Electron 43.2 的支持**（owl 的 11.10.0 早于 Electron 43，预计需要 12.x）并精确锁定；drizzle-orm 从 0.38.4 起步，若 better-sqlite3 升 12 需要则随动升级并锁定；pino 9.14.0 / pino-roll 2.2.0 / smol-toml 1.6.1 从 owl 实际解析值起步；不装 drizzle-kit；定案回填 §7 | M0-4 版本策略的延续：「抄 owl 起步」只对仍受支持且与本机 runtime 兼容的依赖成立 |
| M1-13 | **ABI recipes 照抄 owl 机制，但探测升级为双运行时真值**（评审修订：owl 的「Node 加载失败即假定 Electron ABI」会把损坏/缺失/签名无效的 `.node` 误判为 Electron 可用）：`ensure-node-abi` 用 `node -e` 实例化真 `Database(':memory:')`（光 `require` 不加载 `.node`，宽松探测永远假通过）；`ensure-electron-abi` 用 `ELECTRON_RUN_AS_NODE=1 electron -e` 实例化同一数据库；**rebuild 之后必须再用目标运行时复验**，失败即报错不静默。Node 侧 rebuild = 源码目录 `pnpm run build-release`（**绝不用 `pnpm run install`**——prebuilt 是给 npm 自带 Node 的，会静默弄坏 Node 24 ABI 且每次 install 复发）；Electron 侧 rebuild = **`@electron/rebuild`（精确锁版进根 devDependencies，版本记 §7）**，命令契约固定：仓库根执行 `pnpm exec electron-rebuild --module-dir . --which-module better-sqlite3 --version 43.2.0 --build-from-source`——GUI 不依赖 core、better-sqlite3 在 hoisted 顶层 `node_modules`，不固定 `--module-dir`/`--which-module` 会扫不到目标模块；`--build-from-source` 对齐「不吃 prebuilt」原则、`--version` 显式钉 Electron 版本不做探测（M1 不引 electron-builder，M7 打包时才选——去掉「哪个可行用哪个」的不可复现分支）；hoisted 布局 fallback（无 `.pnpm/better-sqlite3@*` 目录时用顶层 `node_modules/better-sqlite3`）+ 产物 `cp -p` 镜像回 hoisted 顶层副本；macOS ≥15 对 `.node` 与 Electron.app ad-hoc codesign；**无标记文件，探测磁盘真值**。接线：`ensure-node-abi` 挂 `test` / `test-core` / `test-daemon` / `dev-daemon` / `migrate-go`；`ensure-electron-abi` 落地但 **M4 才接线**（M1–M3 无任何 Electron 内加载 better-sqlite3 的入口）。`process.versions.modules` 评审已给：**Node 24.13.0 = 137、Electron 43.2.0 = 148**，T1 落地时以探测输出复核并写进 justfile 注释与 §7 | |
| M1-14 | **core 的 vitest 用 `pool: 'forks'`** | better-sqlite3 原生模块在 worker_threads 池下有崩溃前科（业界通例），fork 池一行配置规避；shared/cli 不动 |
| M1-15 | **daemon logger 置换方式**：`packages/daemon/src/cli.ts` 的 daemon 子命令改用 `createLogger({ filePath: larkLogPath(), config: loadConfig().log, name: 'daemon' })`；`createContext` 收注入 logger；listen 成功仍向 stdout 打一行（pino 走文件后终端不能变哑巴）；daemon 单测继续用注入的静默 console logger。redact 路径在 owl 的 authorization/token 系之上**加顶层精确路径 `api_key`、`*.api_key` 与深层路径 `llm.api_key`、`*.llm.api_key`**（pino 的 `*` 只匹配单层：`*.api_key` 既罩不住顶层 `{ api_key }` 也罩不住 `{ config: { llm: { api_key } } }`；清单与 T2 完全一致）；**约定 config 对象一律不得整体入日志**——要打只打 `redactConfig` 的 Public 投影；配套 grep 守卫留 M2 与 token 守卫一起进 | 日志文件 = `logs/lark.log`（nest 布局单文件，与 owl 双文件不同） |

## 4. 任务分解

### T1 依赖与 ABI 基座（M0 占位兑现）

- core 加依赖（全精确锁版，M1-12 定案后填）：better-sqlite3、drizzle-orm、pino、pino-roll、smol-toml；dev 加 @types/better-sqlite3；根 devDependencies 加 **`@electron/rebuild`**（M1-13 Electron 侧 rebuild 用，命令契约与参数见 M1-13，精确锁版）。`pnpm-workspace.yaml` 的 `onlyBuiltDependencies` 补 `better-sqlite3`。提交 lockfile。
- justfile：`ensure-node-abi` / `ensure-electron-abi`（`[private]`，M1-13 全套）+ 接线 + 注释记录两侧 modules 值；`migrate-go` recipe（依赖 `ensure-node-abi build-core`）。
- core `vitest.config.ts` 设 `pool: 'forks'`（M1-14）。

**验收**：`pnpm install` 后一个 `:memory:` 冒烟测试能加载 better-sqlite3；`just ensure-electron-abi`（`@electron/rebuild`）切到 Electron ABI 并通过 **Electron 运行时真值复验**，随后 `just test-core` 触发 `ensure-node-abi` 自动切回并通过 Node 侧复验——双向各验一次；两侧探测输出的 `process.versions.modules`（预期 137 / 148）核对后回填 §7 与 justfile 注释。

### T2 config + logger + paths（M0 遗留①）

- shared：`config-types.ts`（`LarkConfig` 五节 + `PublicLlmConfig`/`PublicLarkConfig`，M1-6）、`uuid.ts`（`isUuidV4`，M1-3）；barrel 更新。
- core `config/index.ts`：`DEFAULT_CONFIG`、`loadConfig(path?)`（缺文件写默认并返回，owl 语义）、`saveConfig`（原子写）、`resolveLlmConfig`（aviary 回退：三字段齐全不读 aviary；缺则逐字段回退，`api_format` 兜底 `'openai'`；aviary 文件坏则静默用 lark 侧）、`redactConfig`；私有 `deepMerge`（structuredClone 起底）。
- core `logger/index.ts`：`createLogger`（pino-roll：`size = <max_size_mb>m`、`frequency: 'daily'`、`limit.count = max_backups`、`mkdir: true`）、`createConsoleLogger`、导出 `DEFAULT_LOG_REDACT_PATHS`（**与 M1-15 完全一致**：authorization 系 + token 系 + 顶层 `api_key` + `*.api_key` + `llm.api_key` + `*.llm.api_key`）。
- core `paths.ts` 补：`trashDir()`、`aviaryConfigPath()`（迁移旁路文件**不进 paths.ts**——一律从 dbPath 派生，见 T5 路径派生纪律）。
- 测试：Go 存量四节文件解析、缺文件写默认、未知键 round-trip 保留但**不进 Public 投影**、类型与值域校验回落（`api_key = 123`、`window.width = "wide"`、level 乱值、负数、非有限数）、aviary 回退（**空串即未配置**判定用例：`api_key=''` 回退、aviary 也缺则保持 `''`；`api_format` 三级顺序——本地空 → aviary → 兜底 `'openai'`，含「**Go 存量文件三字段齐全但缺 api_format** → 仅 api_format 取 aviary/兜底、其余不回退」用例）、原子写与 **0600 权限断言**（临时文件与 rename 后终态；**已有 0644 文件仅 loadConfig 不 saveConfig 也被收紧为 0600**、chmod 失败抛错）、redact 逐条断言 + **顶层形态**（`{ api_key }`——`*.api_key` 不匹配顶层）+ **深层形态**（`{ config: { llm: { api_key } } }`）+「不过度脱敏」反向用例（owl 测试模式）。

**验收**：`just test-core` 绿。

### T3 db 基座（schema v1 + runner + device_uuid）

- `db/schema.ts`：songs / playlists / playlist_songs / local_metadata 四表 drizzle 定义（M1-2 风格；只描述最终态）。
- `db/migrations/0001-init.ts` + `migrations/index.ts` 注册表（M1-1）：主计划 §3.1 DDL 逐字落地（CHECK、`idx_songs_source_key` partial unique），**补充**：`CREATE INDEX idx_playlist_songs_song ON playlist_songs(song_id)`（songs 级联删除路径；schema 冻结后补索引要走新迁移，一次建齐）；sync 三表按主计划形态（M1-11；索引：`idx_sync_changes_created`、`idx_sync_changes_cid` UNIQUE、`idx_sync_changes_pending` partial、`idx_conflict_unresolved` partial）；`local_metadata`。
- `db/migrate.ts` runner：`LATEST_KNOWN_VERSION = 1`；统一走 `applyForwardMigrations(from, to)`——**每个版本一个事务，迁移 SQL 的执行与 `PRAGMA user_version = N` 的 stamp 在同一事务内提交**（磁盘满 / DDL 中途失败不得留下 `user_version=0` 的半套 schema）；全新库即 `applyForwardMigrations(0, LATEST)`，不设 initial 特例（新装老升同一条码路，owl 修过 bug 的设计）；保留 owl 的 **destructive marker** 约定（迁移头 `-- requires_confirmation: true` → `DestructiveForwardMigrationError`，防未来 daemon 自动应用破坏性升级）；五路分发所需谓词与错误类。
- `db/index.ts` `createDatabase({ dbPath })`：文件库**先做带锁恢复步**（M1-10 状态机，先于打开连接）→ 打开连接 → **只设连接级 PRAGMA**（busy_timeout 5000 → foreign_keys，二者不落盘）→ **读 user_version / schema 判定**——`>LATEST`（`IncompatibleDbError`）、Go 旧库（`GoMigrationRequiredError`）、未知 v0 非空库（`IncompatibleDbError`）**一律 close 拒绝且全程零写入**：`journal_mode=WAL` 是文件级属性，判定前执行会把仍在日常使用的 Go 库从 DELETE 改成 WAL、对未来版本库也是先污染再拒绝（评审阻断项）→ **确认是空库 / 可前滚库 / 当前 v1 后才切 WAL** → 迁移（`==LATEST` 路径走 `assertSchemaV1`，不能只信版本数字）→ `ensureDeviceUuid(sqlite)`（`randomUUID()` + `ON CONFLICT DO NOTHING` + 回读；**存量值必须过 `isUuidV4`**——空/非法视为损坏，重新生成 + warn 日志：v0.1 该值尚无下游依赖，v0.2 注册进 sync 域后改 fail-closed；不在 SQL 里播种，单一代码路径产出连字符 v4）→ 返回 `{ db, sqlite }`；全程 try/catch close 保护。
- `db/schema-signature.ts`：**唯一的 `assertSchemaV1(sqlite)`**——断言全部 **7 张表**（songs / playlists / playlist_songs / local_metadata / sync_changes / sync_cursor / conflict_record）+ 关键索引**存在且定义相符**（基于 `sqlite_master.sql` 规范化比对：`idx_songs_source_key` 的 UNIQUE 与 partial `WHERE`、`idx_sync_changes_cid` 的 UNIQUE、两个 partial 索引的 `WHERE` 子句——同名普通索引不得蒙混）+ `REQUIRED_COLUMNS` 必需列常量（owl 模式）+ **关键 CHECK 指纹**（songs 的 `sqlite_master.sql` 含 file_origin / pinned / provider-key 同空同有三个 CHECK 片段），不符抛 `SchemaMismatchError`。**三个调用点共用**：`createDatabase` 的 `==LATEST` 路径、Go 迁移的 already-migrated 短路、迁移临时库 swap 前验收（M1-10 的 main+old-swap 判定同用）——不允许三处各自维护不同的「v1 定义」（评审：只查四表会把缺 sync 表的库当合法 v1，拖到 v0.2 才爆炸）。
- `errors.ts`：`GoMigrationRequiredError` / `IncompatibleDbError` / `MigrationBusyError(reason)` / `SchemaMismatchError` / `SourceDbCorruptionError` / `ForwardMigrationError` / `InvalidIdError` / `InvalidReorderError` / `NotFoundError` / `SourceKeyConflictError` 等，全部从 core barrel 导出（daemon/CLI 按类型渲染，不解析 message）。
- 测试：新库建成 `user_version=1` + device_uuid 是合法 v4；CHECK 逐条生效（file_origin 非法、pinned=2、provider/key 半空）；partial unique 冲突；**三条拒绝路径（`>LATEST` / Go 旧库 / 未知 v0 非空库）零写入断言**——journal_mode、文件 mtime、无 `-wal`/`-shm` sidecar 均不变；**runner 半途失败不留半套 schema**（注册一个坏 SQL 的假迁移，断言 user_version 停在上一版本、新对象已回滚）；**`assertSchemaV1`**（drop 索引 / drop sync 表后打开均报 SchemaMismatch）；**恢复状态机全组合**（main+old-swap 只读全套验证（user_version / 签名定义指纹 / integrity / FK）通过后 **old-swap 归档而非删除**、验证失败 fail-closed 且两份现场俱在、migrating-only fail-closed 不建空库、old-swap±migrating 恢复）；**ensureDeviceUuid 存量值**（合法保持不变 / 空与非法重生成）；`:memory:`（跳过文件恢复步）。

**验收**：`just test-core` 绿。

### T4 songs/playlists CRUD + 稀疏 rank

全部 `(db, sqlite, ...)` 签名；**写函数拆两层**：内部 `…InTx` 事务体（假定已在事务内，不自开事务）+ 对外同名 wrapper 开 `.immediate()`——M5 导入等「多歌曲 + 歌单 + 成员一个总事务全成败」的组合写在一个外层事务里复用内部体，否则 M5 只能复制 CRUD SQL，破坏「core 单一写路径」与 v0.2 机械补 sync emit（评审预留）。**两层模型只适用于纯 DB 写**（create/update/playlist 系/本地字段）；`deleteSong` 这类文件耦合操作**不提供可组合的 `…InTx`**——trash 移目录与失败恢复的补偿责任必须由它自己的 wrapper 全权拥有，被任意外层事务回滚会让目录恢复脱管（M5 批量删除届时逐首调用 wrapper，或另引入 compensation 上下文，不在 M1 预设计）；业务写入经 `nextLwwStamp`（M1-4）、`device_id` 恒 NULL（R18）、查询返回 shared 线类型（sync 内部字段不外泄）：

- `songs.ts`：`createSong`（source 不变量校验（见下）+ 唯一冲突 → `SourceKeyConflictError` 携冲突歌 id）、`getSong`、`listSongs({ search?, sort?, order?, limit?, offset? })`（**管道锁定：SQL 过滤全量取回 → JS 端排序——name/artist 用 `Intl.Collator('zh-CN')`、created_at 数值比较，一律以 `id` **恒升序**作稳定 tie-break（songs 字段是 `id`，首版误写 `song_id`；无论主键排序方向，tie-break 恒升序）→ 最后 slice 分页**；禁止 SQL 层 limit/offset，先分页再排序每页必错；search 对 name/artist 子串，LIKE **先转义转义符 `\` 自身、再 `%`/`_`**，查询带 `ESCAPE '\'`；曲库量级小，全量排序可承受）、`updateSong`（name/artist/lyrics_offset/duration/source 字段，不变量与 key 冲突同上）、`deleteSong`（R22 trash 协议：`songs/<id>/` rename 进 `trash/<id>-<ts>/` → DB 删除提交 → best-effort 异步删除；DB 失败则目录原位恢复；目录本就不存在则跳过 rename）、本地字段路径 `setPinned` / `touchLastAccessed` / `setFileOrigin`（M1-5；**`setFileOrigin` 标注内部能力**——仅 M3 下载/导入的文件写入路径在成功原子落盘后调用，不暴露给路由/CLI 面，防调用者把 imported 用户资产误标 downloaded 而进入可清理集合；T5 迁移的 `file_origin='imported'` 是建行时的初始化映射、不经此函数）、`songFileInfo(id)`（磁盘探测 has_file/file_size）。
- **source 不变量**（对齐主计划 §3.1，评审修正首版「三元组同空同有」的错误）：只约束 `source_provider` 与 `source_key` **同空同有**；`source_url` **独立可空**——仅存 URL（provider/key 双 NULL）是合法状态（手填非 B 站链接，只能复制/打开，不能驱动下载，R8）；key 对存在而 url 缺失同样合法（url 仅展示/打开入口，身份在 key）。四象限（全空 / 仅 url / 仅 key 对 / 全有）各配用例；半个 key 对被 CHECK 与 core 校验双层拒绝。**NULL/空串归一**：缺失一律存 NULL；非 NULL 的 provider/key trim 后必须非空——`('','')` 能过「同空同有」CHECK 还占用 unique key，core 层拒绝；`source_url=''` 归一化为 NULL；v0.1 provider 白名单仅 `'bilibili'`（主计划 §3.1 注释即此语义，手填非 B 站链接落 url-only 象限）。**key 基本语法校验**（R30 身份契约的 core 边界）：provider='bilibili' 时 `source_key` 必须匹配 `BV[0-9A-Za-z]+:<数字>`（bvid:cid 形态），`bilibili` + `nonsense` 拒绝——语义有效性（cid 是否真属于该 bvid）留给 M3 联网规范化，core 只把住语法。
- **core 内文件路径 UUID 边界（R10）**：凡拼接 `songs/<id>` / `trash/<id>` 的函数（`deleteSong`、`songFileInfo`，含 T5 迁移与后续 M3 下载落盘）一律先过 `isUuidV4`，非法抛 `InvalidIdError`——core 是未来 `--direct` 的入口，不能依赖 daemon/GUI 层校验；配路径穿越用例（`../x` 等）。
- `rank.ts`：`RANK_STEP = 1024`、追加取 `max + 1024`、插入取邻居中点、中点撞值（浮点间隙耗尽）→ 同事务整表归一化 `(i+1)*1024`。
- `playlists.ts`：`createPlaylist` / `renamePlaylist` / `deletePlaylist`（FK 级联清成员）、`listPlaylists`（含曲数）、`getPlaylistSongs`（`ORDER BY rank, song_id`，R23）、`addSongsToPlaylist`（末尾追加、重复成员静默跳过——对齐 Go 语义与 R27 导入追加）、`removeSongFromPlaylist`、`reorderSong(playlistId, songId, { before_song_id?, after_song_id? })`——契约定案：定位锚点前先从序列中**排除被移动行**；两锚点都给 → 必须同歌单、存在、且排除后**相邻**（`after` 紧邻 `before` 之前），取中点；只给 `before` → 插其前（`before` 为首行则 `rank − 1024`）；只给 `after` → 插其后（尾行则 `+1024`）；都不给 → `InvalidReorderError`（无语义）；锚点缺失 / 跨歌单 / 不相邻 → 结构化错误（`NotFoundError` / `InvalidReorderError`），不猜意图。中点撞值 → 同事务归一化（LWW 波及语义见 M1-5）。
- 注：core 不认识 `'all'`——虚拟 all 是 API 层字面量（R3），M2 在路由层把 `all` 映射为 `listSongs`（order=created_at）并对写操作报 `VIRTUAL_PLAYLIST`。
- shared：`SongData` / `PlaylistData` 线类型（snake_case；`has_file`/`file_size` 为可选 enrich 字段；rank 不上线协议——reorder 以邻居 song_id 表达）。
- 测试：CRUD 全路径；`nextLwwStamp` 同 ms 连续写 counter 递增；**本地字段路径回归断言 `updated_at`/`lww_counter` 不变**；source 四象限、空串归一（`('','')` 拒绝 / `url=''`→NULL / 非白名单 provider 拒绝 / key 语法 `bilibili`+`nonsense` 拒绝）与 key 冲突；`isUuidV4` 边界与路径穿越；组合写复用 `…InTx`（外层事务中批量建歌加歌单，中途失败全回滚）；listSongs 排序×分页组合（跨页边界断言全局序）；reorder 契约各分支（相邻校验、首尾、锚点错误）；rank 同位反复插入**循环至实际触发归一化**（1024–2048 间二分约 53 次才撞浮点中点，断言在有限上界内发生、归一化后顺序不变、波及行 LWW 均被 bump，不写死次数）；delete trash 协议——DB 失败分支用 `PRAGMA query_only=1` 注入写失败，断言目录原位恢复。文件相关用例统一在临时 `LARK_NEST_DIR` 下跑（mkdtemp + env），绝不触真实 nest。

**验收**：`just test-core` 绿。

### T5 Go 迁移协议（§3.3 全实现）

- `db/backup.ts`：backup API 一行封装（owl 逐字）。
- `db/probe-go.ts`：`daemon.pid` 活性探测（陈旧清理）+ best-effort 47020 `/status`（M1-8）。
- `db/migrate-go.ts` `migrateFromGoDb(dbPath, opts?)`，按 §3.3 顺序：幂等短路（peek user_version，`==LATEST` **且过 `assertSchemaV1`** 才返回 already-migrated——版本号对但签名不符抛 `SchemaMismatchError`，不能只信数字）→ 取迁移锁（`${dbPath}.migrate.lock` 专用 SQLite 库 `BEGIN EXCLUSIVE`，M1-10）→ 旧 daemon 探活 → 旧库 `busy_timeout=0` + `locking_mode=EXCLUSIVE` + 真实读触发锁 → 列结构比对（duration 缺失容忍，M1-9）→ 源库 `integrity_check` + `foreign_key_check` → `wal_checkpoint(TRUNCATE)` 并**断言 `busy==0`**（否则 `MigrationBusyError('checkpoint_busy')`；DELETE journal 下幂等）→ backup API 备份（存在性检查不覆盖）→ `songs.db.migrating` 建 v1 schema（走 `applyForwardMigrations(0, LATEST)`）→ **JS 逐行 transform**（M1-8）：songs（RFC3339 带偏移 → unix-ms，解析失败迁移时刻 + 日志；**旧库可空列显式映射**——Go DDL 的 artist/lyrics_offset/duration 均无 NOT NULL：`artist NULL→''`、`lyrics_offset NULL→0`、`duration NULL→0`（与 Go DEFAULT 同语义，逐条记日志），`name NULL` → 中止并报出 song id，不让它变成无上下文的 SQLite constraint error；`source_*=NULL`；`file_origin='imported'`；`last_accessed_at=created_at`；`device_id=NULL`；id 过 `isUuidV4` 不合法即中止）、playlists（`list_name`→`name`，时间 = 迁移时刻，**按 `is_system=1` 丢弃 all 行**）、playlist_songs（`rank=(position+1)*1024`，丢弃 all 成员，时间 = 迁移时刻）→ 验收（行数对账、临时库 **`assertSchemaV1`** + `integrity_check` + `foreign_key_check`、每歌单 rank 严格递增 fail-closed）→ **swap 前置：源库与临时库的全部 DB 句柄先 close**（EXCLUSIVE 锁随源连接关闭释放；rename 绝不在持句柄时做）→ 原子交换三步：`songs.db` rename 至 `old-swap` → 清理原库 `-wal`/`-shm` sidecar（ENOENT 忽略、其余 rethrow）→ `.migrating` rename 就位；**第二段失败 → `old-swap` 原位恢复后 rethrow** → 成功删 `old-swap`、返回 `{ backup_path, songs, playlists, memberships, elapsed_ms }`；外层 finally 释放锁 + 清临时文件。文件操作经**可注入 fsOps**（默认 `node:fs`，测试注入定点故障）。
- **路径派生纪律**：`migrateFromGoDb(dbPath)` 的一切旁路文件——`.migrate.lock`、`daemon.pid` 探测、`.migrating`、`.old-swap`、备份、sidecar——一律从 `dbPath` / 其目录派生（owl `probeDaemonPid` 手法），**不引用全局 `paths.ts`**；fixture 在临时目录时绝不指向真实 nest。CRUD 侧文件测试同理统一走临时 `LARK_NEST_DIR`（见 T4）。
- `scripts/migrate-go.mjs` + `just migrate-go`（M1-7：打印源库概况 → y/N → 执行 → 打印对账与备份路径与回滚指引）。
- fixture：`test/fixture-go-db.ts` 程序化 `seedGoLegacyDb(dbPath, data?)`——DDL 逐字取自 lark-go `db.go`（**duration 用 ALTER 追加**复现物理列序），默认数据复刻真实形态（§2.1：position 空洞且起点非 1、`is_system=1` all 行 + 物化成员、`+08:00` 无毫秒时间戳、空 artist、负 lyrics_offset）。
- 测试（owl 编号风格 T1..Tn，用例与 §3.3/M1-8/9/10 一一对应）：happy 对账（20/2/4、all 丢弃、字段映射逐项断言、`user_version=1`、备份可开且行数与源一致）；幂等重跑短路；重复执行迁移命令撞锁（`SQLITE_BUSY` → 报忙）；**持锁子进程 `kill -9` 后立即重试成功**（内核自动释放，无陈旧锁残留）；daemon_alive（写自己 pid）；EXCLUSIVE 被外部写事务挡（`BEGIN IMMEDIATE` + 真实写）；缺 duration 容忍；缺 name 列中止；坏时间戳兜底 + 日志；非法 UUID 中止；重复 position 中止；swap 第一段失败（非空目录挡首个 rename，owl T6 手法——源库未动）；**swap 第二段失败**（注入 fsOps 令 `.migrating → songs.db` 的 rename 抛错，断言 `old-swap` 被原位恢复、库内容完好——非空目录只能打到第一段，测不到真正的回滚分支）；`.migrating` 残留清理与 `.old-swap` 跨次恢复（经 `createDatabase` 路径，含**活锁在场时拒绝动残留**）；**「迁移进行中 × createDatabase 并发」子进程用例**（子进程 `BEGIN EXCLUSIVE` 持锁并写 `.migrating`，stdout 信号做 barrier 固定交错；主进程 `createDatabase` 确定性报 `MigrationBusyError` 且未动任何残留文件）；NULL 列映射与 `name NULL` 中止用例。

**验收**：`just test-core` 绿 + 副本演示（见 §「用户验收」②）。

### T6 daemon logger 接线 + 收尾

- M1-15 置换；daemon 单测不落盘。
- README 补 `just migrate-go` 用法与「正式迁移时机自定」说明；PROCESS.md 勾选 M1 + 一行结论；CLAUDE.md「注意事项」如有新实测锁定（版本、modules 值）同步；§7 回填。
- `just check` + `just test` + `just build` 全绿（check 无新增守卫，M1 无新依赖方向）。

**任务顺序**：T1 → T2 → T3 → T4 与 T5 可并行（都只依赖 T3）→ T6 收口。
**提交批次（建议，每批 commit 信息先给用户过目）**：批 1 = T1+T2（`chore(core)`（依赖/ABI）+ `feat(config)` + `feat(core)`（logger/paths））；批 2 = T3+T4（`feat(db)` + `feat(library)`）；批 3 = T5+T6（`feat(db)` + `refactor(daemon)` + docs 收尾）。**scope 字典冲突（评审指出）**：M0 历史已在用 `repo` scope（`chore(repo)` / `docs(repo)`），但它不在 AGENTS.md 的 scope 字典里——建议把 `repo` 正式补进字典覆盖仓库级杂项（justfile / lockfile / README / PROCESS），**待用户确认**；未确认前仓库级提交不带 scope（Conventional Commits 允许省略）。

**用户验收关键路径**：
① `just check` + `just test` 全绿；ABI 自愈演示——先人为切到 Electron ABI，再 `just test-core` 观察 `ensure-node-abi` 自动切回。
② 副本迁移演示：复制真实 nest 到临时目录 → `LARK_NEST_DIR=<临时目录> just migrate-go` → 对账输出（20 首 / 2 歌单 / 4 成员、all 丢弃、备份文件名、`user_version=1`）→ 幂等重跑显示 already-migrated → `sqlite3` 抽查（每歌单 rank 严格递增、`+08:00` 时间戳换算正确、`file_origin='imported'`、`device_id IS NULL`）。**真实库本体不迁**（M1-7）。
③ config 演示：副本 nest 上 `loadConfig` 解析 Go 存量四节文件（**0644 被收紧为 0600**；url/model/api_key 齐全不回退，缺失的 api_format 走 aviary/兜底）；删掉 api_key 后回退读 aviary 值；Public 投影无 api_key、无未知节。
④ logger 演示：`just dev-daemon` 起动 → `logs/lark.log` 出现结构化 pino 行、终端仍有 listen 提示；日志无 token/api_key 明文。

## 5. 与 owl 的刻意差异（M1 增补）

| 项 | owl | lark M1 |
|---|---|---|
| 迁移文件 | `.sql` + copy-sql.mjs + readdir 扫描 | TS 内嵌 SQL + 显式注册表（M1-1） |
| drizzle 属性 / 时间戳 | camelCase + `timestamp_ms`(Date) | snake_case + `mode:'number'` ms（M1-2） |
| uuid | uuid 包 + randomUUID 双轨 | 仅 `randomUUID()`（M1-3） |
| LWW stamp | server-normalized HLC（hlc.ts） | v0.1 行内单调本地时间戳，v0.2 换芯（M1-4） |
| sync 事件 | 业务事务内 emitSyncChange | v0.1 不写（R2），写路径形状保持可机械补 emit |
| 一次性迁移完整性检查 | 仅 foreign_key_check ×2 | + integrity_check ×2（R20） |
| 迁移锁 | O_EXCL 文件锁，陈旧时报错让用户手删 | SQLite `BEGIN EXCLUSIVE` OS advisory lock，崩溃由内核自动释放（M1-10） |
| 迁移数据搬运 | ATTACH + `INSERT INTO dest SELECT` | JS 逐行 transform（M1-8） |
| swap 残留恢复 | 仅同次运行内回滚 | + `createDatabase` 开头**带迁移锁**的跨次恢复（M1-10） |
| saveConfig | 直接 writeFileSync | 随机临时名 `'wx'` + 0600 + rename 原子写（M1-6） |
| config 运行时校验 | 无（TOML 解析后即信任） | 值域收敛、越界回落默认（M1-6） |
| deepMerge | 一层浅拷贝（嵌套共享引用） | structuredClone 起底（M1-6） |
| log 配置 | 含死字段 max_age_days | 类型不收，文件存量键容忍（M1-6） |
| 测试 runner | node --test 跑 dist | vitest 跑 TS 源，core 用 fork 池（M0-3/M1-14） |
| Electron ABI 探测 | Node 加载失败即假定 Electron 可用 | `ELECTRON_RUN_AS_NODE` 真值探测 + rebuild 后目标运行时复验（M1-13） |
| device_uuid 播种 | ensureDeviceId + SQL randomblob 兜底 + 运行时兜底（三处，格式不一致） | 仅 `ensureDeviceUuid` 一处，恒连字符 v4（T3） |

## 6. 风险

| 风险 | 对策 |
|---|---|
| better-sqlite3 对 Node 24 / Electron 43 的支持版本未定（owl 的 11.10.0 早于 Electron 43） | 开工首日定版（预计 12.x），drizzle 随动；T1 首日即做 `:memory:` 冒烟；定案回填 §7（M1-12） |
| node-gyp 源码编译环境（CLT 缺失、macOS ≥15 codesign 拒载） | 前置检查 CLT；codesign 步已内置 recipe（M1-13）；首日冒烟暴露 |
| 真实旧库与 fixture 漂移（用户仍在用 Go 版加歌） | fixture 复刻的是**形态**（空洞/时区/系统行）而非快照；正式迁移日先在当日副本上重跑演示；协议本身备份 + 原子交换双保险 |
| RFC3339 `+08:00` 无毫秒解析、夏令时等时区边角 | 固定样本单测锁死（含真实库抽样值）；解析失败兜底迁移时刻 + 日志（M1-9） |
| vitest worker 池 × 原生模块崩溃 | fork 池预防（M1-14）；若仍有异常按包隔离排查 |
| better-sqlite3 12.x 若与 drizzle-orm 0.38 不兼容 | 升 drizzle 至兼容版并精确锁定，记录 §7；drizzle 用法收敛在 schema/查询层，升级面小 |

## 7. 实施记录（落地时回填）

- [x] 版本定案（2026-08-03 T1）：better-sqlite3 = **12.11.1**（engines 显式列 `20.x||22.x||…||24.x||25.x||26.x`；13.0.x 于 2026-07-21 才发布、两周内连出两个 patch，不追新首发）、drizzle-orm = **0.38.4**（peer `better-sqlite3 >=7` 满足，无需随动升级）、pino = **9.14.0**、pino-roll = **2.2.0**、smol-toml = **1.6.1**（owl 实际解析值起步，纯 JS 与 Node 24 无兼容问题）、@types/better-sqlite3 = **9.6.0**（DT 最新）、@electron/rebuild = **4.2.0**（npm latest）
- [x] `process.versions.modules`：host Node 24.13.0 = **137**、Electron 43.2.0 = **148**（2026-08-03 T1 以双侧真值探测复核通过：`ensure-electron-abi` rebuild 后 Electron 探测输出 148，`ensure-node-abi` 切回后 Node 探测输出 137；已写进 justfile 注释）
- [x] 副本迁移演示结果（2026-08-03，真实 nest 副本于 /tmp 临时目录，真库未动）：对账 **20 songs / 2 playlists / 4 memberships**（源 20/3/24，all 行与其成员丢弃）；备份 `songs.db.bak-go-2026-08-03T06-19-16-001Z`（可开、行数与源一致、user_version=0）；幂等重跑输出 `already migrated — songs=20 playlists=2 memberships=4`；sqlite3 抽查：`user_version=1`、每歌单 rank 严格递增（violations=0）、`file_origin` 全 `imported`、`device_id` 全 NULL、`sync_changes` 空、实库样本 `2026-02-23T13:17:52+08:00` → `1771823872000`（= UTC 05:17:52，偏移换算正确）；副本里的陈旧 `daemon.pid` 走活性判定被清理后继续。config 演示（同副本）：0644 → 0600 收紧、Go 存量三字段齐全 + `api_format` 缺失 → 解析出 `'openai'` 兜底且三字段保持本地值、Public 投影五节无 api_key / 无未知节。daemon logger 演示：临时 nest 起 daemon → `logs/lark.log` 出现结构化 pino 行、终端保留一行 listen 提示
- [x] 实施中推翻/修订的决策：无推翻。三处计划未尽述的落地补充——① 错误类在清单之外新增 `InvalidSourceError`（source 不变量违例专用）与 `MigrationResidueError`（M1-10 fail-closed 残留状态专用），属清单「等」的范围；② migrate-go 取源库排他在 owl 的「真实读触发」之上追加一次**同值写升级**（`BEGIN IMMEDIATE` + `PRAGMA user_version=0` + `COMMIT`）——纯读在外部 `BEGIN IMMEDIATE` 写事务（RESERVED）在场时照样通过、也不会真正取得 EXCLUSIVE 锁，同值头页写既拿到内核级排他又不改变库语义（配套测试 T5.6）；③ `migrateFromGoDb` 增加 `httpProbe` 选项（默认开启）——47020 探测是机器全局的，测试跑在临时目录时若真 Go daemon 在线会被误拒，测试一律关闭该探测、pid 文件探测保持（从 dbPath 派生，天然隔离）
