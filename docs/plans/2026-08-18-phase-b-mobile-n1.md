# Phase B 子计划：N1 —— core 端口化 + 应用服务层 + SyncCoordinator 提取

> 2026-08-18 **v4（三轮评审定稿）**。修订对照见 §10；决策 a–q 全部关闭（§9）。上承主计划 `docs/plans/2026-08-13-m4a-and-mobile-master-plan.md` §4.3 N1 行（含 Stage-1 修订③：R1–R5）与 N0 子计划 `docs/plans/2026-08-17-phase-b-mobile-n0.md` §5 N1 段 + §3.5。
>
> 调查方法：core / daemon sync 层 / CLI direct 后端三路盘点 + 三轮评审逐条代码复核（一轮：依赖环 / commit 协议 / `sqliteOf` / unbind 凭证 / 全局 Node API；二轮：实际时长回传 / engine 文件生命周期 / 端口批次前置 / 整文件 digest / UTF-8 解码 / drizzle run 结果消费；三轮：本地歌词直写 / 服务层域类型 / FileContext 贯穿 / AudioLanding 合同闭合）。file:line 落到 **HEAD `25f1c86`**。桌面测试基线 **2481**（shared 79 / core 1047 / cli 417 / daemon 495 / gui 443）。

---

## §0 范围、口径与前置

- **范围**：N1 = ① core 业务图端口化并入 `@lark/core/portable`（sync 全图、download client 层与编排、library、错误类）；② SyncCoordinator 提取；③ 应用服务层 + CLI direct 薄壳化 + 共享 contract suite（N1 接 daemon/direct 两方，mobile hook N2 接入）；④ 三守卫接线；⑤ R1–R5 真机复验。**桌面行为零变化**是贯穿性 gate。
- **gate（主计划冻结）**：桌面全测试 + 三守卫绿 + 桌面行为零变化 + **R1–R5 全绿 → D5 按 §8 分段口径冻结**（「D5 全部冻结」在 N1 出口仍不宣称）。
- **版本口径（N0 决策 a）**：N1 落 main，随下个桌面版本自然发出；中途发 0.3.x 先复跑 accept 全系列。
- **N1 不做**：移动 app 本体（N2）、file-ops 执行器移动实现（N2/N5）、AudioLanding 的 RN 实现（N4）、GUI stores 改造、triggers 移动触发模型（N5）。
- **前置**：
  1. R 系列由 `spikes/mobile-foundation/` 承载（守卫允许 `@lark/core/portable`）。数值判据（R5）依 §3.2a：release 构建、冻结设备 vivo V2408A、probe-host 回传。
  2. R1/R3 要真实网络；R1 双网络各一遍（先 `dumpsys connectivity` 验默认网络，VPN 关）。R4/R5 纯本地负载。
  3. TLS（D15）与 N1 并行（负责人 = 用户），不阻塞任何批次；死线仍是 N4。
- 🚨 **常驻义务照旧**（N0 判据 13）：每次 `pnpm install` 变动后复跑桌面 `just check` + `just test`。

---

## §1 调查结论（file:line 落到 HEAD `25f1c86`）

### 1.1 端口触点全清单（D5 原表 + N0 §1.4 增补，按端口分组）

**Crypto（N0b-3 判据 20 已定案）**

| 触点 | file:line |
|---|---|
| md5（WBI，同步短串） | `download/wbi.ts:21` |
| sha256（file-op inline，同步、`discard()` 在事务内） | `sync/file-ops.ts:20`（:337-343、:481-497） |
| sha256（**导入整文件**，上限 20MB——`daemon/routes/playlists.ts:63`；走异步 provider，决策 a） | `library/transfer.ts:26`（:193） |
| randomUUID（9 文件） | `sync/changes.ts:12` · `sync/conflicts.ts:16` · `sync/file-ops.ts:20` · `library/songs.ts:13` · `library/playlists.ts:6` · `library/lyrics.ts:14` · `download/engine.ts:26` · `download/import.ts:22` · `download/resolve.ts:33` |
| getRandomValues | `download/wbi.ts:149`（RN 全局不存在，N0b-3） |

**Base64（宽松语义）**：`download/lyrics/shared.ts:93`。

**TextEncoding**：字节长五处（`sync/changes.ts:87`、`sync/engine.ts:362`、`sync/backfill.ts:281`、`sync/file-ops.ts:341`、`library/lyrics.ts:137`）；UTF-8 解码一处：`library/transfer.ts:197`——统一 `decodeUtf8`（TextDecoder 非 fatal，替换字符语义与 `Buffer.toString('utf8')` 等价并测，决策 o）。

**FileSystem / 歌词写路径的真相（三轮评审修正）**：`sync/backfill.ts:29,96-105`（`preReadLyrics`——**coordinator 的 login 会走到它**，`daemon/sync/login.ts:149`）· `library/songs.ts:14`（statSync，:463）· `library/lyrics.ts:15-16`（:58/:99）· `library/cache.ts:27`（同步删除临界区，:130）。**本地歌词写是直写不是 journal**：下载管线 `pipeline.ts:487` → `writeLyrics`（`lyrics.ts:116`，先写文件后 emit）；`deleteLyrics`（:143）同为直接文件操作；**journal 只覆盖 apply 路径的 `…File` 变体**（`lyrics.ts:108-114` 注释明言）。所以 `writeTextAtomic` 的原子合同**对所有宿主成立**，没有「journal 兜底」可言（§2.4）。

**Paths-root**：`paths.ts:17` + :16-21。端口给**语义路径**（`songDir`/`songAudio`/`songLyrics`/…）；**`join` 不进 portable 业务面**（只在宿主适配器内部使用）——业务层不拼路径、不理解 URI。

**Clock**：`sync/hlc.ts:72` 已注入形；coordinator 侧 `runner.ts:74,153`、`login.ts:152`、`refresh.ts:29`、`triggers.ts:95`。

**Logger**：`logger/index.ts:26-31` `StructuredLogger` 类型迁 portable。

**Database**：sync 图 11 文件 `type BetterSqlite3`；`LarkDatabase`（`db/index.ts:27`）。运行时耦合：`sqliteOf(db) = db.$client`（:172）在 `songs.ts:156,219`、`playlists.ts:51,86,123,223,296`、`rank.ts:45,100`、`lyrics.ts:118,147`。类型层：`songs.ts:401,411,429` 消费 `.run()` 返回值——两 driver 公共面只有 `{ changes: number }`（better-sqlite3 `lastInsertRowid` vs expo `lastInsertRowId`）。处置 §2.2；**双侧可赋值已验证**（三轮评审人以当前 drizzle 0.38.4 实测 better-sqlite3 与 Expo 两侧都能赋给 `BaseSQLiteDatabase<'sync', {changes:number}, typeof schema>`）。

**CredentialStore（五 API 面 + stash/restore）**：`config/skybridge.ts` read :104 / write :131 / delete :166 / stash :195 / public :228。消费者两处：coordinator 与 `sync/unbind.ts`（:109 stash → :151 restore → :158 delete，补偿序是业务语义）。

**DeviceName**：`daemon/src/sync/login.ts:25`（消费点 :286）。

**EventsBus**：`daemon/src/sync/runner.ts:119-144`。

**SkybridgeApi**：`daemon/src/sync/client.ts:38-51`；翻译层 :63-121 要 SDK instanceof。

**AudioLanding（v4 合同闭合，§2.3）**：提交协议三件（`resolve.ts:117-130` 的 taskId/mode/同事务 `commit()`，:169-183）；`hadOld` 现算（:157）；实际时长从 landing 回传（`StagedAudio.duration`，`pipeline.ts:317-321` → `engine.ts:899-914` 写行）；engine 三处文件生命周期（:763 rmSync / :816、:874 existsSync）进端口面；**:755-761 的「行不存在才删」判定留在 portable engine**（重新查 DB 的责任在 engine，端口只删目录）。

**countQuarantined 注入化**：`sync/file-ops.ts:298-303`；消费点 `daemon/sync/status.ts:66`。

**错误类**：`errors.ts` 45 类整迁、原址 re-export。

### 1.2 sync 图（18 个非测试文件）

- **只差型锚 + 端口**：`apply` `binding` `changes` `conflicts` `device` `duplicates` `engine` `hlc` `lww` `rebase` `retention` `tombstones` `unbind` `retry` `server-url` `payloads/`。传输已注入（`engine.ts:73-76`）；pull 批量已有注入缝（`engine.ts:215`——R5 钉生产接线）。
- **`backfill.ts`**：唯一 fs 是 :29（`preReadLyrics`）→ FileContext。
- **`file-ops.ts` A/B**：A 半 = :44-357 + :744；B 半 = :358-743。锚点修正：`songs.ts:32` / `unbind.ts` / `engine.ts` 改锚 A 半 `FileEffectLike` 接口；:631 的 `NodeJS.ErrnoException` 随 B 留守。

### 1.3 SyncCoordinator 提取对象（`daemon/src/sync/`，非测试 1548 行）

| 文件 | 行数 | 宿主耦合（全部） | 处置 |
|---|---|---|---|
| `runtime.ts` | 201 | :21/:75 `realSkybridgeApi` 默认注入 | 近原样搬；api 必填注入 |
| `session.ts` | 155 | CredentialStore、`AppContext` 型 | 搬；ctx 换 CoordinatorContext |
| `login.ts` | 369 | :25 hostname · :152 Date.now · CredentialStore（:202-203、:304）· **:149 `preReadLyrics`（文件读）** | 搬；补偿顺序（:339-369）/「旧 session 先拆」（:158-159）/ 复用优先（:264-291）原样 |
| `logout.ts` | 89 | CredentialStore（:79、:88） | 搬；本地先于远端 |
| `refresh.ts` | 103 | CredentialStore（:76、:99）· :29 Date.now | 搬；「重读磁盘 + 三字段判定」（:64-88）原样 |
| `runner.ts` | 164 | eventsBus（:120、:130-144）· :74/:153 Date.now | 搬；EventsBus 端口；「401 只 dropSession」（:97-100）原样 |
| `status.ts` | 82 | `countQuarantined()` :66 | 搬；吃注入 |
| `client.ts` | 121 | SDK 静态 import | 搬（决策 c） |
| `triggers.ts` | 364 | Timeout（:70-72、:138-145）· SSE（:301-348） | 拆：coalescer（:154-183）/ debounce（:278-299）/ backoff（:244-263）/ 状态门（:265-272）下沉；定时器与 SSE 留 daemon 壳 |

### 1.4 download 图的分界

- **client 层（portable，R1–R3 对象）**：`bilibili.ts`（`openAudio` :335-342 封装鉴权与超时）· `wbi.ts` · `link.ts` · `llm.ts` · `prompts.ts` · `lyrics/` · `timeouts.ts` · `claims.ts`（`sync/file-ops.ts:30` 的依赖，先于 sync 图进 portable）· `task-data.ts`（前提：`DownloadTarget` 先下沉）。
- **先断的两条边**：① `task-data.ts:23` 与 `batches.ts:17` 从 pipeline import `DownloadTarget`（:74-83）→ 下沉 `download/target.ts`；② `library/transfer.ts:40` 依赖 `pipeline.ts:432` 的 `findSongByKey` → 重归属 `library/source.ts`。
- **`batches.ts` 非纯 client**（:13-17）→ 随编排批。
- **编排层（portable，AudioLanding 切面后）**：`engine.ts`（Node 触点 = :26-27 + :763/:816/:874 走端口面）+ `batches.ts` + pipeline 可移植半（`resolveTarget` :103 / `probeSourceKey` :270 / `reidentifySource` :301 / `runLyrics` :458——**歌词写经 FileContext**）。
- **桌面专有**：`ffmpeg.ts` · `resolve.ts` · `import.ts` · `fetchAudio`（:330）。

### 1.5 library 图

`songs.ts`（statSync + `sqliteOf`×2 + B 半类 import :32 + run 结果消费 :401,411,429）· `playlists.ts`（`sqliteOf`×5；`getPlaylist` :154——daemon 在用，`routes/playlists.ts:186`）· `rank.ts`（`sqliteOf`×2）· `source.ts`（`findSongByKey` 落点）· `lyrics.ts`（fs + `sqliteOf`×2；常量 :33-45；**writeLyrics/deleteLyrics 是直写**）· `transfer.ts`（公开形参 `Buffer` :192 + `toString('utf8')` :197 + 整文件 sha256 :193 + `findSongByKey` 边 :40；`previewImport` 探磁盘 :262；域类型 `ExportSource` :66 / `ImportInput` :336）· `cache.ts`（`CacheOptions` :42 / `CacheStatus` :51 / `EvictionRun` :90；探活/claims 已注入——`direct.ts:381-401` 实证；fs 仅 :27）。

### 1.6 CLI direct 与 daemon 路由的重复面（F13 病灶）

`direct.ts`：:31-34 caps 字面复制；:201-219 名字语义；:185-199 id 门；:267-283 虚拟 all；**:150-164 enrich（`audioMode` 打开时读一次**——「mode 只会放宽」是安全理由原文）。daemon 侧：`validation.ts`（300 行）+ `routes/songs.ts`（358）/ `routes/playlists.ts`（319）。**`SongListQuery` 是 CLI wire 型（`backend/types.ts:40`）；域类型是 `ListSongsOptions`（`songs.ts:53`）**——服务层只说域类型，wire 映射归 adapter。

### 1.7 依赖环调查（一轮评审核心反例，实核属实）

- sync → library：`conflicts.ts:25` · `apply.ts:35` · `backfill.ts:34` · `file-ops.ts:39`。
- library → sync：`rank.ts:15` · `lyrics.ts:21` · `playlists.ts:19-23` · `songs.ts:30-35`。
- sync → download：`file-ops.ts:30`。library → download：`transfer.ts:40`。

**结论**：sync 与 library 是强连通分量；边全是真业务边，不造人工 seam。**处置（决策 m/n）**：claims 前置、两条环外边先断、语义与端口接线全部前移原位批，然后 sync + library 一个**纯机械**批整体进 portable。

### 1.8 守卫看不见的全局 Node API

`transfer.ts:192`（形参 Buffer）· `NodeJS.ErrnoException`：`backfill.ts:104`、`songs.ts:463`、`cache.ts:130`、`lyrics.ts:58,99`。处置：§2.4 端口语义 + §6 守卫全局 token + 决策 o。

---

## §2 目标结构

### 2.1 portable 子树布局（git mv 保历史；原址/barrel re-export）

```
packages/core/src/portable/
├── （现有：index / sqlite / errors / schema / migrate / schema-signature / pending / migrations/ / contract/）
├── errors.ts / logger.ts / db.ts        # 45 类并入 · StructuredLogger 型 · PortableDb（§2.2）
├── runtime/                             # random（provider）/ digest（同步 noble + 异步 provider）/ text（含 decodeUtf8）/ base64
├── ports/                               # fs / paths / credentials / events / device / audio-landing（FileContext 在 fs.ts）
├── sync/  coordinator/  download/  library/  services/
```

桌面留守：`db/`（打开/WAL/锁/recovery/readonly/backup + PortableDb 构造）、`download/{ffmpeg,resolve,import}.ts` 与 `fetchAudio`、`sync/file-ops-runtime.ts`、`config/`（skybridge.ts = CredentialStore 桌面 impl）、`logger/`、`paths.ts`（Node 根解析 + Paths 桌面 impl）、`media-tools/`、`migration/`、`daemon-control/`、`backup-nest`、`testing/`。

### 2.2 环境注入的三档 + PortableDb

1. **静态可移植**：同步 digest（noble：md5 + 短输入 sha256）、utf8ByteLength、decodeUtf8（TextDecoder 非 fatal，等价四夹具）、base64Lenient。
2. **provider 注入（install，fail-loud）**：
   - **Random**（uuid/randomBytes）：缺省 `globalThis.crypto`（Node ≥19 原生），RN 缺失未 install 即抛；install 幂等——同实现重装 no-op，不同实现 fail-loud。
   - **异步整文件 digest** `sha256BytesAsync(data: Uint8Array): Promise<string>`（决策 a v4）：**无静默缺省——未安装即抛**（async 签名不等于非阻塞，Promise 包同步 noble 照样卡 JS 线程，生产不许静默回退）。桌面经 barrel 安装 `node:crypto` 实现（daemon 路由与 CLI 都经 barrel，测试同样覆盖）；**移动端在 transfer 功能开放（N6）前必须安装 expo/WebCrypto 实现，这是 N6 的开门条件**。noble 参考实现只进测试对照，不做运行时回退。`parseAndValidate` 随之转 async。
3. **显式端口**：FileSystem、Paths、CredentialStore、DeviceName、EventsBus、SkybridgeApi、AudioLanding、Clock、Logger（纯类型）。**FileContext = `{ fs: FileSystemPort; paths: PathsPort }`**（三轮评审修订）：文件能力**不走模块全局**，作为一个整体显式进入 CoordinatorContext（`preReadLyrics`，`backfill.ts:96` ← `login.ts:149`）、LibraryServiceDeps、portable download engine/pipeline deps（`runLyrics` 的歌词写）。

**PortableDb（决策 d，已验证可赋值）**：

```ts
type PortableRunResult = { changes: number };   // 两 driver 公共面（rowid 字段名都不同）
type PortableDrizzle = BaseSQLiteDatabase<'sync', PortableRunResult, typeof schema>;
interface PortableDb { drizzle: PortableDrizzle; sqlite: SqliteLike }
```

- 唯一构造点（桌面 `db/index.ts` + mobile bootstrap），`sqliteOf` 退役；「同一连接」不变量由构造点保证。
- 叶子保持窄依赖：纯 SQL 的 sync 叶子函数继续收 `SqliteLike`；PortableDb 只出现在真正同时要 drizzle + raw 同事务的边界。
- 双侧编译证据：桌面 `satisfies` + spike typecheck 真实构造 `{ drizzle: drizzle(expoClient, { schema }), sqlite: new ExpoSqliteShim(expoClient) } satisfies PortableDb`（`just spike-mobile-typecheck`）。**评审已用 drizzle 0.38.4 预验证两侧可赋值**——判据 9 是把它钉进 CI 形态。

### 2.3 AudioLanding 端口（v4 —— 合同闭合）

```ts
interface AudioStreamExpectation {
  /** 选中流的 DASH codecs（BiliAudioStream.codecs，bilibili.ts:63-75；缺失按非 AAC）。 */
  codecs: string;
  isAac: boolean;
  /** 上游预期时长：选中分 P 的 BiliPage.duration（秒）。只作验证参照——写行用实测值。 */
  expectedDurationSeconds: number;
}
interface LandedAudio {
  /** 宿主验证后的实际落地时长（秒）。桌面 = 输出侧 ffprobe（StagedAudio.duration）；
   *  移动端取得方式 N4 定，但不许从接口消失（commit 写行用的就是它，engine.ts:899-914）。 */
  duration: number;
}
interface AudioLandingPort {
  /** ensure-file 短路（engine.ts:816）与 needsFile 判定（:874）。 */
  hasAudio(songId: string): boolean;
  /** 删除未提交的歌曲目录（engine.ts:763 的 rmSync 语义）。
   *  「行不存在才可调」的判定（:755-761 的 DB 重查）留在 portable engine——
   *  端口只执行目录移除；redownload 失败绝不删既有目录由合同测试锁死。 */
  discardUncommitted(songId: string): void;
  land(input: {
    taskId: string;
    songId: string;
    mode: 'new' | 'replace';
    /** 打开已鉴权的音频流；header/cookie/超时封装留在 client（openAudio）。 */
    openStream(signal: AbortSignal): Promise<Response>;
    expect: AudioStreamExpectation;
    reportStage(stage: DownloadStage): void;   // downloading → converting → saving 事件序不变
    onProgress(received: number, totalBytes: number | null): void;
    /** 行写入。实现必须在自身落盘协议的提交点、同一数据库事务内**恰好调用一次**
     *  （桌面 = resolve.ts:169-183）。commit 抛出 ⇒ 整个 landing 回滚；提交后不可 un-succeed。 */
    commit(result: LandedAudio): void;
    signal: AbortSignal;
  }): Promise<{ warnings: string[] }>;   // 实际结果只经 commit 单源传递，land 不再复述
}
```

- `hadOld` 不是参数（实现现算，`resolve.ts:157`）。三个生命周期操作不塞通用 FileSystem（音频目录协议与恢复语义）。
- 桌面 impl = `fetchAudio` → `processAudio` → `landSongFile` 原样组合，六步协议逐字节不动；移动 impl（N4）= 流直存 + 简化落盘 + 启动清扫，「commit 恰好一次 / 抛出回滚 / 提交后不可撤销」对所有宿主成立。
- **冻结口径**：N1h 冻结切面位置与桌面不变量；跨宿主字段签名到 N4 冻结（加法扩展）。§8 同款。

### 2.4 FileSystem / Paths 端口的语义口径（v4 —— 原子合同全宿主成立）

- **Paths**：语义路径函数（`songDir`/`songAudio`/`songLyrics`/`recoveredSongsDir`/`migrationBackupDir`/…）。**`join` 只在宿主适配器内部使用，不进 portable 业务面**——业务层只能调语义函数。桌面 impl = 现 `paths.ts` 委托；mobile impl N2。
- **FileSystem 面 = 实际使用面**：同步 `statSync → {size}|null`、`unlinkSync`（cache 零 await 临界区）；异步 read/mkdir/readdir/unlink；高层 `writeTextAtomic(path, text)`。
- **`writeTextAtomic` 的合同对所有宿主一致：同目录临时文件 + 原子替换**（三轮评审修正——v3 的「journal 兜底」依据不成立：本地歌词写是直写，`pipeline.ts:487` → `lyrics.ts:116`，journal 只覆盖 apply 路径的 `…File` 变体）。**若 N2 实测 Expo 做不到原子替换，那是一个单独的语义变更决策 + 批次**（例如把本地歌词写 journal 化），提交用户拍板——**不许在适配器里静默弱化**。
- 「不存在」走返回值不走异常；适配器不许伪造 Node errno；权限与其它错误原样抛宿主错误。

### 2.5 SyncCoordinator 上下文

```ts
interface CoordinatorContext {
  db: PortableDb;
  files: FileContext;              // preReadLyrics（backfill.ts:96 ← login.ts:149）
  logger: StructuredLogger;
  credentials: CredentialStore;    // 五 API + stash/restore（unbind 同款消费）
  events: EventsBus;
  clock?: () => number;
  deviceName: () => string;
  api: SkybridgeApi;               // 必填
  fileOps: FileEffectLike;
  countQuarantined: () => number;
  intervalMin: () => number;
  pullLimit: number;               // 桌面 SYNC_PULL_LIMIT(500)；移动 SYNC_PULL_LIMIT_MOBILE(200)，接 engine.ts:215 既有缝（R5 钉死）
  version: string;
}
```

daemon 从 `AppContext` 组装；`daemon/src/sync/` 缩成组装 + 定时器/SSE 壳 + 路由不动；coordinator 单测跟代码走 core（决策 h）。

### 2.6 LibraryService 方法面（v4 —— 全部用现存域类型，可照着实现）

```ts
interface LibraryServiceDeps {
  db: PortableDb;
  files: FileContext;
  fileOps: FileEffectLike;           // 只有 deleteSong 走 journal；deleteLyrics 是直接文件操作（经 files）
  clock?: () => number;
}
// audioMode 在构造时读一次（沿 direct.ts:150-164：「mode 只会放宽」，中途完成迁移不会使答案变错）
interface LibraryService {
  // songs —— 域类型 ListSongsOptions（songs.ts:53）；SongListQuery 是 CLI wire 型，由 adapter 映射
  listSongs(options: ListSongsOptions): { songs: SongData[]; total: number };
  getSong(id: string): SongData;
  updateSong(id: string, patch: UpdateSongPatch): SongData;
  deleteSong(id: string): Promise<void>;             // → file-op journal（contract 有 case）
  pinSong(id: string, pinned: boolean): SongData;
  // playlists（虚拟 all 首位、只读；getPlaylist 补上——daemon 在用，routes/playlists.ts:186）
  listPlaylists(): PlaylistData[];
  getPlaylist(id: string): PlaylistData;
  createPlaylist(name: string): PlaylistData;
  renamePlaylist(id: string, name: string): PlaylistData;
  deletePlaylist(id: string): void;
  listPlaylistSongs(id: string): SongData[];
  addPlaylistSongs(id: string, songIds: readonly string[]): number;
  removePlaylistSong(id: string, songId: string): void;
  reorderPlaylist(id: string, move: ReorderMove): void;
  // lyrics（本地文件，直写语义不变）
  deleteLyrics(id: string): Promise<boolean>;
  // transfer —— 域类型 ExportSource（transfer.ts:66）/ ImportInput（:336）；parseImportFile 转 async（决策 a）
  buildExport(source: ExportSource): PlaylistExportFile;
  parseImportFile(bytes: Uint8Array): Promise<ParsedImportFile>;
  previewImport(file: ParsedImportFile): ImportPreview;
  importPlaylist(input: ImportInput): ImportResult;
  // cache —— 域类型 CacheOptions/CacheStatus/EvictionRun（cache.ts:42/51/90）；
  //          limit_mb 等 wire 补充字段归 adapter；探活 probe / claims / 排除集照旧由调用方注入
  cacheStatus(options: CacheOptions): CacheStatus;
  runEviction(options: EvictionOptions): Promise<EvictionRun>;
}
```

- **不在面里**：download 队列、player、sync 七命令（daemon-only 归属不变）；`status` 不走服务层。
- caps/trim/id 语义单源在 service；wire 校验（objectBody/字段形状/路径参数）与 wire DTO（`ApiResponse` 信封、`limit_mb`、`SongListQuery`）全归 daemon/CLI adapter。
- contract cases 至少覆盖：查询 + enrich · 名字/id 校验 · create/update/delete · membership/reorder · 删除引起的 file-op · cache/transfer 两族 · M6 两病例（uuid 门禁、虚拟 all 拼装）· F13 `' 稻香 '` 同一性。
- 接口以现存域类型为准拼装；若实现批发现某个域类型还需收窄/新增（如 `UpdateSongPatch` 的精确形），在该批列明，不改方法面结构。

---

## §3 搬迁表（diff 纪律：断边/拆分/接线（原位）→ git mv → import 改写，类别分开可核）

| # | 对象 | 从 → 到 | 触点处理 |
|---|---|---|---|
| 1 | `errors.ts`（45 类） | → `portable/errors.ts` | 原址 re-export；`instanceof`/`err.name` 复验 |
| 2 | `StructuredLogger` | → `portable/logger.ts` | 原址 re-export |
| 3 | runtime 四件 | 新增 `portable/runtime/` | digest：wbi/file-ops 同步 noble；transfer 走 `sha256BytesAsync`（fail-loud provider，桌面 barrel 装 node:crypto）+ `parseAndValidate` 转 async（daemon 路由 / CLI 同批 await）；byteLength 五处；decodeUtf8 一处；base64 一处；uuid 九处 |
| 4 | 端口接口 + 桌面 adapter + adapter 单测 | 新增 `portable/ports/`（含 FileContext）；桌面 adapter：fs/paths（Node）、credentials（包 skybridge.ts） | **N1a 落地**，此后各批只消费 |
| 5 | 断边三件（原位） | `DownloadTarget` → `download/target.ts`；`findSongByKey` → `library/source.ts`；claims 定为 client 批成员 | 环外边全断 |
| 6 | file-ops A/B 拆分（原位） | B 半 → `src/sync/file-ops-runtime.ts` | 三个消费者改锚 `FileEffectLike`；`countQuarantined` 注入化 |
| 7 | **PortableDb 收敛 + FileContext/CredentialStore 原位接线**（v4 扩） | `sqliteOf` 退役；backfill/songs/lyrics/cache/transfer 的 fs 触点接 FileContext；unbind 接 CredentialStore | 唯一构造点；双侧编译证据；叶子窄依赖；**N1e 从此只剩 mv + import 改写** |
| 8 | download client 层 | `{bilibili,wbi,link,llm,prompts,timeouts,claims,task-data,target}.ts` + `lyrics/` → `portable/download/` | wbi 走 runtime；lyrics/shared 走 base64 |
| 9 | sync + library 强连通体（**纯机械批**） | `src/sync/` + `src/library/` → portable | 只有 git mv + import 改写（语义已在 #3/#5-7 完成） |
| 10 | coordinator 九文件 | `daemon/src/sync/` 宿主无关件 → `portable/coordinator/` | §1.3 逐行；daemon 留壳；单测跟走 |
| 11 | LibraryService + contract | 新增 `portable/services/` | §2.6 |
| 12 | CLI direct 薄壳化 + daemon 路由消费 service | `direct.ts` 重复面；`routes/{songs,playlists}.ts` 语义半 | `daemonOnly` 面、writer-lock/R31 门、ABI probe、动态 import 不动 |
| 13 | download 编排 + AudioLanding | `engine.ts` + `batches.ts` + pipeline 可移植半 → portable；桌面 impl 组合 fetchAudio/ffmpeg/resolve | §2.3 v4 合同 |

pipeline 等「一劈两半」允许提取到新文件而非强求 git mv（决策 g，提交信息注明来源区间）。core barrel 同名 re-export 保桌面消费路径不变。

---

## §4 批次划分（每批：用户确认 commit message 后提交；`just check` + `just test` 全绿是底线；**Metro smoke 自 N1a 建立后每批都跑**）

| 批 | 内容（搬迁表 #） | 性质 | 本批 gate |
|---|---|---|---|
| **N1a 地基** | #1-4 + 守卫扩面（§6）+ Metro smoke recipe 建立 | 机械 + 两处语义（digest 换 noble；transfer 转 async） | 全测试；判据 3-7；smoke 首跑绿 |
| **N1b 断边与拆分** | #5-6 | 原位语义批，零搬迁 | 全测试；判据 8 |
| **N1c PortableDb + 端口接线** | #7 | 原位签名批，零搬迁 | 全测试 + smoke；判据 9（含 spike typecheck Expo 侧构造） |
| **N1d download client 层** | #8 | 机械搬迁 | 全测试 + 守卫 + smoke；R1–R3 对象就位 |
| **N1e sync + library 强连通体** | #9 | **纯机械搬迁** | 全测试 + 守卫 + smoke + `just test-sync-e2e`（19） |
| **N1f SyncCoordinator** | #10 | 提取 + daemon 薄壳 | 全测试 + e2e + smoke + **`just accept-sync`（34）** |
| **N1g 服务层 + CLI 薄壳 + contract** | #11-12 | 语义收敛（daemon 语义为准） | 全测试 + smoke + **`just accept-cli`（27）** + contract 两 hook 绿 |
| **N1h download 编排 + AudioLanding** | #13 | 切面提取 | 全测试 + smoke + **`just accept-m5`（22）**；切面与桌面不变量在此冻结 |
| **N1i 守卫收编 + R 系列 + 冻结** | smoke 正式进 `just check` + prebuild recipe + **R1–R5** + 分段冻结文本 + 文档 | 验收 | **三守卫 + R1–R5 全绿**；accept 全系列按判据 22 用新构建产物复跑 |

依赖：N1a 先于一切；N1b/N1c 先于 N1e；N1d 先于 N1e（claims）与 N1h；N1e 先于 N1f/N1g。建议 N1d 后即在 spike 预跑 R1–R3 面板（正式判据以 N1i 的 release 构建为准）。

---

## §5 判据（1–22 + R1–R5；**gate 项加粗**）

**diff 纪律与零变化**

1. 每批 diff 类别可分（断边/拆分/接线原位 · git mv · import 改写）；语义变更点逐条列在提交信息里，不混入搬迁提交。
2. **桌面全测试总量 ≥ 2481** + 迁移账本（跨包转移的用例数逐批记录、逐条对得上）；删除任何用例必须在提交信息单列理由。
3. **digest**：wbi `w_rid` 固定夹具、file-ops inline digest——noble 与 `node:crypto` 逐字节相同（N0b-3 五样本入常跑测试）；transfer async 化后与旧实现逐字节相同；**`sha256BytesAsync` 未安装即抛（fail-loud 反测）**、桌面 barrel 安装后走 node:crypto（两实现同值测试）；**N6 开门条件写进本判据：移动 transfer 开放前必须安装非阻塞 provider**。
4. Random provider：Node 零安装即用；删 `globalThis.crypto` 模拟环境未 install 即抛；同实现重装幂等、不同实现 fail-loud。
5. **decodeUtf8 等价四夹具**（中文/emoji/截断多字节/非法 UTF-8，替换字符语义对齐 `Buffer.toString('utf8')`）；base64Lenient 7 样本；utf8ByteLength 6 样本含孤代理；**`writeTextAtomic` 合同测试**：崩溃窗口内旧内容完整可读（tmp + rename 原子替换，桌面 adapter 实测；contract case 留给 N2 的 mobile adapter 同跑）。
6. `errors.ts` 整迁后：daemon 错误映射穷尽测试 + CLI `err.name` 测试原样绿；`core.X === portable.X` 抽三类实证。
7. 守卫反测（扩面后）：塞 `node:crypto` import、塞无 import 的 `Buffer.byteLength`、塞 `NodeJS.ErrnoException`、塞 `drizzle-orm/better-sqlite3`、塞越界相对路径——各红一次（验完撤）。
8. 断边与拆分批：file-ops A 半零 fs import；三个消费者只锚 `FileEffectLike`；`DownloadTarget`/`findSongByKey` 新归属后全绿；journal arg 快照语义零变。
9. PortableDb + 接线批：`sqliteOf` 全仓 rg=0；构造点唯一；双侧编译证据（桌面 `satisfies` + spike typecheck 真实构造——评审已预验证可赋值，此处钉进 CI）；叶子窄依赖抽查；「outbox 与业务写同事务」既有测试全绿；**backfill/songs/lyrics/cache/transfer 接 FileContext 后各自既有测试原样绿**。

**sync 图与 coordinator**

10. **coordinator 冻结不变量清单逐条绿测试**：login 补偿顺序 · 旧 session 先拆 · 401 只 dropSession · epoch 先 bump · refresh 重读磁盘三字段判定 · logout 本地先于远端 · coalescer 后到者拿 follow-up · 墓碑 `''` 归一化 · 回声两条 · unbind 的 stash → restore → delete 补偿序。
11. **`just test-sync-e2e` 19（N1e 起每批）+ `just accept-sync` 34（N1f gate）**。
12. daemon `/sync/*` 路由测试原样；`GET /sync/status` 注入后逐字段相等。

**服务层与两方 contract**

13. **contract suite 两 hook 全绿，mobile hook 显式 skipped 带理由**；cases 按 §2.6 覆盖清单。
14. **`just accept-cli` 27 全绿**；`daemonOnly` 面与 R31 门零变化。
15. daemon routes 消费 service 后既有测试原样绿（wire 校验与错误码不变；`getPlaylist` 在面里）。

**download 编排**

16. AudioLanding 桌面 impl：六步落盘/manifest/恢复决策表既有测试原样绿（`resolve.ts`/`ffmpeg.ts` 逐字节不动）；commit 同事务断言保留；**commit 恰好一次（合同测试）**；`commit(result)` 的 duration 与旧路径 `staged.duration` 等价（写进行的就是 ffprobe 值）；`hasAudio`/`discardUncommitted` 与 :763/:816/:874 逐点等价、**「行不存在才删」判定留在 engine 且有「redownload 失败绝不删既有目录」合同测试**；`download:status` 事件序零变。
17. **`just accept-m5` 22 全绿**（N1h gate）。

**守卫三件**

18. **portable rg 守卫扩面全绿**：全局 token（`Buffer` 词边界放行 `ArrayBuffer` / `process.` / `NodeJS.` / `__dirname` / `require(`）+ `sqliteOf` rg=0；越界按深度计数照旧。
19. **Metro bundle smoke：N1a 建 recipe，此后每批（N1b–N1h）都跑，N1i 正式进 `just check`**；反测——塞 `node:fs` 进图 bundle 红。进 check 后若过重需降级为独立 recipe——对主计划的偏离，出现即报告。
20. **`expo prebuild` smoke 独立 recipe**（不进默认 check）。

**收尾**

21. CLAUDE.md / PROCESS.md / 主计划 N1 行与 D5 冻结指针同批更新；N0 子计划 §3.4 加 superseded 指针到本计划 §8（单事实源）。
22. **accept 全系列对新构建产物复跑**：`just fetch-ffmpeg` → `just package bundled` → `just pack-cli` → `just accept-pack bundled <本轮 dmg> <本轮 tgz>` + `accept-gui`/`accept-m5`/`accept-cli`/`accept-sync`——不许对 0.3.0 旧产物跑。

**R1–R5（N0 §3.5 原文 + 绿条件具体化；R5 数值 → release + 冻结设备 + §3.2a）**

- **R1** bilibili client 全链真机：真实 WBI 签名 URL `code 0` 且 `w_rid` 与桌面同参照相同 · buvid 经 Random provider · `view`/`pagelist`/`playurl` · b23 `redirect:'manual'` 展开（N0b-4c 真实文本）· **实际调用 `openAudio()` 拉有界分段**（设备侧当下签发的 playurl；断言 2xx/206 + 流式 body 真读到字节 + abort 生效）——双网络各一遍。
- **R2** `link.ts` 真机 parse：真实分享文本 → bvid；fid / `?p=` 各形态与桌面逐字段一致。
- **R3** 歌词三平台 client 真机一遍（fetchImpl + base64Lenient）：真实歌曲候选 + LRC 非空且与桌面同参数一致。
- **R4** `runFullBackfillInTx` 满工作量：raw 造数 2,000 首（无 create 行），断言 `result.songs === 2000`。
- **R5** `applyChangesInTx` 三条：① `SYNC_PULL_LIMIT_MOBILE = 200` 常量断言；② 生产接线证据——捕获型注入 client 断言 `pullChanges(…, 200)` 经 `engine.ts:215` 缝真被传下去；③ 200/批 p95 ≤100ms（release），500/批复测记录。桌面 500 不动。

---

## §6 守卫扩面明细（判据 7/18 实现口径）

`check-core-portable.sh` 增：① 全局 token：`(^|[^a-zA-Z])Buffer\b`（放行 `ArrayBuffer`）、`\bprocess\.`、`NodeJS\.`、`__dirname`、`\brequire\(`——命中即红，注释同罪；② `sqliteOf` 全仓 rg=0。Metro smoke 是动态补层，自 N1a 起每批跑（判据 19）。

---

## §7 风险

| 风险 | 缓解 |
|---|---|
| 强连通体批（N1e）体量大 | 语义与接线全部前移 N1a-c；N1e 只剩 mv + import 改写 |
| digest 换实现行为差 / async 卡线程 | 判据 3 逐字节夹具 + fail-loud provider（无静默同步回退）+ N6 开门条件 |
| PortableDb 型不可赋值 | 评审已预验证；判据 9 钉进 CI（双侧编译证据前置 N1c） |
| coordinator 提取破坏 sync 语义 | 判据 10 清单 + 判据 11 |
| AudioLanding 切面画错 | v4 合同闭合（expectation 定义 / commit 单源恰好一次 / 行不存在判定留 engine / redownload 合同测试）；切面与桌面不变量 N1h 冻结、跨宿主字段 N4 冻结 |
| Expo 做不到原子替换 | §2.4：升级为单独的语义变更决策 + 批次（如本地歌词写 journal 化），不许适配器静默弱化 |
| 服务层收敛改变 wire 行为 | daemon 语义为准；判据 13/14/15 三面夹 |
| Metro smoke 各批拖慢 | recipe 从 N1a 就在、缓存热；收编放最后且降级路径显式 |
| R1 风控扰动 | N0b-4a 节点差异与 header 矩阵在手 |
| N1 期间桌面发版 | 决策 a 口径：先复跑 accept 全系列 |

---

## §8 D5 冻结的分段口径

R1–R5 全绿时**冻结**：端口切面清单与位置（全部）· fetch 注入充分性（R1/R3）· Crypto/Base64/TextEncoding/decodeUtf8 行为 · 卡顿阈值与移动分批（R5，`SYNC_PULL_LIMIT_MOBILE` 落章）· PortableDb 形态（双侧编译 + 契约）。

**明确不冻结**：AudioLanding——N1h 冻结切面位置与桌面不变量，跨宿主字段签名到 N4 冻结（加法扩展）· mobile service hook（N2）· FileSystem/Paths 的移动适配语义（N2 对 §2.4 合同落地；**原子替换做不到 = 单独决策，不是适配自由度**）。

此口径 N1i 写回主计划 §4.3 N1 行（Stage 式修订），并在 N0 子计划 §3.4 加 superseded 指针，避免双事实源。

---

## §9 决策记录（a–q 全部关闭，2026-08-18 三轮评审）

| # | 决策 | 状态 |
|---|---|---|
| a | digest 三分：md5 + inline sha256 = 同步 noble；transfer 整文件 = `sha256BytesAsync` **fail-loud provider**（桌面 barrel 装 node:crypto；**移动 N6 开放 transfer 前必须装非阻塞实现，无静默同步回退**）；`parseAndValidate` 转 async | ✅ 三轮修订后关闭 |
| b | Random provider：`globalThis.crypto` 缺省 + fail-loud + install 幂等（不同实现重装 fail-loud） | ✅ |
| c | skybridge SDK 静态进 `portable/coordinator/client.ts` | ✅ |
| d | PortableDb：`BaseSQLiteDatabase<'sync', {changes:number}, typeof schema>` + 双侧编译证据 + 叶子窄依赖（**评审已实测双侧可赋值**） | ✅ |
| e | LibraryService 方法面 = §2.6（现存域类型 + `getPlaylist` + audioMode 构造时读一次 + wire DTO 归 adapter） | ✅ 三轮修订后关闭 |
| f | AudioLanding v4 合同（expectation 三字段定义 + commit 恰好一次单源 + 行不存在判定留 engine + redownload 合同测试） | ✅ 三轮修订后关闭 |
| g | git mv 为主；「一劈两半」允许提取到新文件（注明来源区间） | ✅ |
| h | coordinator/服务层单测跟代码走 core | ✅ |
| i | Metro smoke：N1a 建立、**每批（N1b–N1h）跑**、N1i 收编 | ✅ 三轮修订后关闭 |
| j | triggers 拆分边界 | ✅ |
| k | contract hooks 形态照 DatabaseContract | ✅ |
| l | file-ops B 半落点 `src/sync/file-ops-runtime.ts` | ✅ |
| m | sync + library 一个机械批；**前提 = 端口接线前移 N1c**（已落搬迁表 #7） | ✅ 条件满足后关闭 |
| n | 叶子下沉三件 | ✅ |
| o | Buffer → Uint8Array + decodeUtf8（TextDecoder 非 fatal）+ 等价四夹具 | ✅ |
| p | mobile contract 消费 N2 接入，N1 只留占位 | ✅ |
| q | D5 分段冻结写回主计划 + N0 §3.4 superseded 指针 | ✅ |

---

## §10 评审修订对照

### 一轮（v1 → v2）

| 评审项 | 落点 |
|---|---|
| P0-1 sync↔library 强连通分量与批序冲突 | §1.7 实证；决策 m；语义前移原位批 |
| P0-2 batches/task-data 误判纯 client；transfer 反向边 | §1.4 断边；决策 n |
| P0-3 AudioLanding 丢提交协议（commit-in-tx / taskId / mode；hadOld 外传 TOCTOU） | §2.3 v2 签名 |
| P0-4 `sqliteOf` 运行时耦合，类型替换不够 | 决策 d：PortableDb 包装 + 唯一构造点 |
| P0-5 unbind 的 CredentialStore 依赖被漏 | 端口含 stash/restore；判据 10 补偿序 |
| P1 六项（openStream 封装 / FileSystem unlinkSync 与错误语义 / 守卫全局 token / D5 冻结矛盾 / 三方实为两方 / R5 生产配置） | §2.3-2.4 / §6 / §8 / R5 三条化 |
| P2 四项（测试基线 / accept-pack 旧产物 / 批次标注 / 草案态） | 判据 2/22；批次重排 |

### 二轮（v2 → v3）

| 评审项 | 落点 |
|---|---|
| P0-1 commit() 无参丢实际时长 | `commit(result: LandedAudio)` + 判据 16 duration 等价 |
| P0-2 engine 三处文件生命周期不经端口（:763/:816/:874） | 面扩成 hasAudio/discardUncommitted/land |
| P0-3 N1e 消费的端口接口排在其后 | 接口 + 桌面 adapter 前移 N1a |
| P1 六项（20MB 同步 sha256 / decodeUtf8 / PortableDrizzle 精确型与叶子窄依赖 / Paths-FileSystem POSIX 化 / LibraryService 面宽泛 / smoke 太晚） | 决策 a 三分 / 决策 o / §2.2 / §2.4 / §2.6 / 决策 i |
| P2（决策裁定、文内冲突、R1 流读取） | §9 / 统一 N1h 与冻结措辞 / R1 增 openAudio 有界读取 + abort |

### 三轮（v3 → v4）

| 评审项 | 落点 |
|---|---|
| P1-1 「歌词写全部经 journal」依据不成立（`pipeline.ts:487` → `lyrics.ts:116` 直写；journal 只管 apply 路径）——移动直写有损坏风险 | §2.4 v4：`writeTextAtomic` 原子合同**全宿主一致**；Expo 做不到 = 单独语义决策 + 批次，不许适配器静默弱化；判据 5 增合同测试 |
| P1-2 LibraryService 接口不可照实现（`SongListQuery` 是 CLI 型 / `ImportRequest` 等不存在 / 缺 `getPlaylist` / audioMode 无归属 / deleteLyrics 误标 journal / wire DTO 混入） | §2.6 v4：全部换现存域类型（`ListSongsOptions` :53、`ExportSource` :66、`ImportInput` :336、`CacheOptions`/`CacheStatus`/`EvictionRun` :42/51/90）+ `getPlaylist`（:154，daemon :186 在用）+ audioMode 构造时读一次（direct.ts:150 语义）+ deleteLyrics 直写归 files + wire DTO 归 adapter |
| P1-3 fs/paths 未贯穿（coordinator 的 `preReadLyrics`、pipeline 的歌词写） | FileContext `{fs, paths}` 显式进 CoordinatorContext / LibraryServiceDeps / engine-pipeline deps；不走模块全局 |
| P1-4 AudioLanding 合同未闭合（expectation 未定义 / discardUncommitted 责任 / commit 与返回值双源） | §2.3 v4：`AudioStreamExpectation` 三字段（codecs/isAac 自 `BiliAudioStream` :63-75、时长自 `BiliPage.duration`）；commit 恰好一次、land 只回 warnings；行不存在判定（:755-761）留 engine + redownload 合同测试 |
| P2-1 N1e 仍含接线 | 搬迁表 #7 扩（FileContext/CredentialStore 接线全进 N1c）；#9 纯机械 |
| P2-2 smoke 漏 N1c/N1g | 判据 19：每批（N1b–N1h）都跑 |
| P2-3 async ≠ 非阻塞 | 决策 a v4：provider fail-loud 无静默缺省；桌面强制 node:crypto；N6 开门条件 |
| P2-4 PathsPort join 歧义 | `join` 只在适配器内部，不进 portable 业务面 |
| 决策裁定（b/c/d/g/h/j/k/l/n/o/p/q 拍板；a/e/f/i/m 条件修订后拍板；d 已由评审实测可赋值） | §9 全部关闭 |
