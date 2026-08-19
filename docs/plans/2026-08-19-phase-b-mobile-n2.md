# Phase B 子计划：N2 —— `apps/mobile` 本体 + 身份门 + 数据层 + 服务层接线 + 四 tab 骨架

> 2026-08-19 **v3（二轮评审收敛）**，同日 **决策 a–o 全部关闭**（用户拍板「照建议关」，正文在 §5；建议里留白的三处由本次一并定死：决策 c 的 key/默认值/非法值/版本、决策 a 的 minSdk、决策 o 的判据 14 身份路径）。修订对照见 §8。上承主计划 `docs/plans/2026-08-13-m4a-and-mobile-master-plan.md` §4.3 N2 行 + N0 子计划 `docs/plans/2026-08-17-phase-b-mobile-n0.md` §5 N2 段 + N1 子计划 `docs/plans/2026-08-18-phase-b-mobile-n1.md` §8.1（D5 分段冻结，单一事实源）。
>
> 调查方法：portable 出口面盘点（N1 产物）+ spike 现有实现盘点 + **expo-file-system 57.0.4 的 Android Kotlin 源码逐段读** + 一轮评审的反例逐条代码复核。file:line 落到 **HEAD `370ba2e`**。桌面测试基线 **2578**（逐包数以开工当天 `just test` 为准）。
>
> **两轮评审的性质都是「按它实施会红」，不是「写漏了」**。v1 → v2：缺 `device_uuid` 则一切业务写入抛错 · 「只入队不执行」与现有服务和契约直接冲突 · D16 排在打开原库之后等于它自己的不变量不成立 · 打开协议只覆盖了 fresh 库。v2 → v3：**fresh 首启从来不生成 install_id**（第二次启动会把自己刚建的库当恢复库清掉）· **「收敛」排在读写打开之前而收敛本身要写原库** · **兼容性判定排在收敛之后**（v1/v2/损坏库会先被写过再被拒绝，违反零写入）· **冻结序列漏了 boot drain**。v3 把启动序列拆成「零写预检 → 意图 → 读写 → 提交」四段（§2.2）。

---

## §0 范围、口径与前置

- **范围**：N2 = ① `apps/mobile` 本体立项（Expo SDK 57 + CNG，从 `spikes/mobile-foundation/` 毕业）；② **D16 身份门**（copy-then-open + 状态机 + 收敛，**位置在打开原库之前**）；③ 数据层（expo-sqlite shim 定版接线 + `PortableDb` + **完整打开分派** + bootstrap + `ensureDeviceUuid` 下沉）；④ 宿主端口实现（FileSystem / Paths / Random / Digest / Text / Base64 / Logger）+ **file-op 执行器与 boot drain**；⑤ 服务层接线 + **LibraryContract 第三个 hook**；⑥ 曲库/歌单读写 + 四 tab 骨架；⑦ 移动端 config 宿主定案；⑧ **蓝牙歌词的判定函数**（`@lark/shared` 纯函数，接线在 N3）。
- **gate**：真库副本可读写 · **LibraryContract 18 例在 mobile hook 上全绿** · **D16 五组全过**（v3 把云备份与 D2D 拆开） · 桌面 `just check` + `just test` 零回归 · 守卫绿。
- **v2 新增进 N2 的两件**（v1 把它们排在外面，实测证明排不出去）：
  - **`ensureDeviceUuid` 下沉**（§1.7）——不做则判据 13/15 全红。
  - **file-op 执行器 + boot drain**（§1.8）——不做则 `deleteSong` 走不完。主计划 §4.1 把执行器写在 N4，N1 §0 写的是「N2/N5」；**v2 取 N2**，理由是删除是曲库读写的一部分，而删除的文件半必须有人执行。
- **N2 不做**：播放与锁屏（N3）· 下载链路与添加页与 AudioLanding（N4）· SyncCoordinator 接线与徽章/冲突页（N5）· 多选批量与歌单导入（N6）。**一条硬边界**：N2 结束时曲库里的行**点不响**——没有下载链路，也没有播放器。所有 UI 判据按这个前提写，别用「能不能放出声」当验收。
- **版本口径**（N0 决策 a 不变）：N2 落 main；APK 独立版本线 0.1.0 / versionCode 1（D14）。桌面不因 N2 发版。
- **前置**：
  1. 冻结测量设备 vivo V2408A（换设备 = 数值判据全部重测）；数值判据一律 **release 构建**（N0 §3.2a 测量协议原样适用）。
  2. 🚨 **常驻义务照旧**（N0 判据 13）：每次 `pnpm install` 变动后复跑桌面 `just check` + `just test`。
  3. 开发期**只碰曲库副本**（`just backup-nest`）。
  4. TLS（D15）与 N2 无耦合，死线仍是 N4。

---

## §1 调查结论（file:line 落到 HEAD `370ba2e`）

### 1.1 服务层的入口面（N1g 产物，N2 直接消费）

- `createLibraryService(deps)` —— `packages/core/src/portable/services/library.ts:200`；服务面 **22 个方法**（`library.ts:123-157`，v1 写「24」是错的）。
- `LibraryServiceDeps`（`library.ts:106-121`）**只有四件**：
  | 字段 | 类型 | N2 要提供什么 |
  |---|---|---|
  | `db` | `PortableDb` | expo-sqlite handle → `{ drizzle, sqlite }`（§1.4） |
  | `files` | `FileContext` | `{ fs: FileSystemPort, paths: PathsPort }`（§1.5，**本批最难的一件**） |
  | `fileOps` | `FileEffectLike` | **必须是真执行器**，不是只入队的桩（§1.8） |
  | `audioMode` | `AudioMode` | 移动端恒 `canonical`（决策 i） |
- N2 用得上的是 **songs 6 个**（`listSongs` / `getSong` / `updateSong` / `deleteSong` / `pinSong` / `enrich`）+ **playlists 9 个**；`buildExport`/`parseImportFile`/`previewImport`/`importPlaylist` 的**功能**归 N4/N6，`cacheStatus`/`runEviction` 的**功能**归 N4——**但契约要求 hook 把 `exportPlaylist` 与 `cacheUsedBytes` 接上**（§1.3），这两个方法本身在 N2 就要能调通。

### 1.2 打开协议：桌面有六类分派，v1 只写了其中一类

`packages/core/src/db/index.ts:51-58` 的注释就是分派表本身：

| `PRAGMA user_version` | 桌面行为 |
|---|---|
| `> LATEST_KNOWN_VERSION` | `IncompatibleDbError`（拒绝） |
| `0` 且 schema 空（brand new） | 正向迁移 `0 → LATEST` |
| `0` 且 Go 旧库指纹 | `GoMigrationRequiredError` |
| `0` 且其它非空 | `IncompatibleDbError`（拒绝） |
| `0 < v < LATEST` | 正向迁移 |
| `== LATEST` | `assertCurrentSchema` 后打开 |

v1 只写了 brand-new 那一行，却又要求「打开真实 v3」「验证未知 v0 拒绝」——**判据与协议对不上**。v2 §2.4 给完整矩阵，并明确三条：只有**真正 fresh** 的库才自动清 `audio_migration_pending`（0003 给每个到 v3 的库都置它，`pending.ts:15`）· `== LATEST` 必须验 schema 签名 · **所有拒绝路径在设 WAL 之前完成并关掉 handle**（M1 的「判定前零写入」）。Go 旧库那一类在移动端不可达（`isGoLegacyDb` 仍在 `migrate.ts:93`，判定保留、分支报「不支持」）。

### 1.3 LibraryContract 的第三个 hook

- `LibraryContractHooks = { open(): Promise<LibrarySubject>; close(subject) }` —— `portable/services/contract/types.ts:110-115`；`index.ts:6` 的注释写着「N2's mobile client will add a third hook without touching a case」。
- **18 例，六组**（`contract/cases.ts`：query 3 · input 6 · virtual-all 3 · write 4 · **cache 1** · **transfer 1**）。**cache 与 transfer 那两例是 gate 的一部分**，所以 `LibrarySubject.exportPlaylist` / `cacheUsedBytes` 必须接线——即使这两块的**产品功能**在 N4/N6。
- `LibrarySubject`（`types.ts:69-95`）= 13 个表面方法 + 两个**越过表面**的夹具方法（`seedSong` / `songFilesExist`）。后两个是 N2 额外实现的部分，且**不许留在生产 APK 里**（决策 o）。
- 失败经 `ContractRefusal(failure, nativeCode)` 抛（`types.ts:98-108`）。`ContractFailure` 五个取值（`types.ts:20-29`）：`invalid-input` / `invalid-id` / `virtual-playlist` / **`not-found`** / `other`。所以映射表是**四个错误类**，v1 漏了 `NotFoundError`（`portable/errors.ts:237`）：

  | core 错误 | ContractFailure |
  |---|---|
  | `LibraryInputError` | `invalid-input` |
  | `InvalidIdError` | `invalid-id` |
  | `VirtualPlaylistError` | `virtual-playlist` |
  | `NotFoundError` | `not-found` |
  | 其它 | 不映射 → 原样抛（`other` 一律算 case 失败，不是 pass） |
- **N1g 的教训直接适用**：两个 hook 不一样敏感，绿不是证据。mobile hook 接上之后要**破一次**（删掉 `services/library.ts` 里 `requiredName` 的 `.trim()`）确认它会红。

### 1.4 数据层（N0b 已定案，N2 做「从 spike 毕业」）

- `portableDbOf(handle)` —— `spikes/mobile-foundation/src/sqlite/portable-db.ts:20`，注释已写明「This is also the shape N2's bootstrap will use: open once, pair once, hand the pair to core」。
- `ExpoSqliteShim` 261 行（`spikes/.../sqlite/shim.ts`）+ hooks 115 行；drizzle 走 `patches/drizzle-orm@0.38.4.patch`（**未打补丁时 10k 查询漏 10000 条语句**，D4）。
- bootstrap 序列在 `spikes/.../panels/bootstrap.ts:29-96` 演练过；`LATEST_KNOWN_VERSION = 3`（`migrate.ts:12`）。
- **WAL 顺序是判据的一部分**（N0b-3 实测）：照 `db/index.ts` 的顺序——先 `busy_timeout`/`foreign_keys`，读完 `user_version` 再 WAL。
- **`installPortableRuntime()` 必须在任何 core 调用之前**（`spikes/.../src/portable-runtime.ts`）：RN 没有 `crypto.getRandomValues`/`randomUUID`，Random 端口选的是**未装即抛**。

### 1.5 🔴 原子替换：expo-file-system 57 在 Android 上**做不到**

`FileSystemPort.writeTextAtomic` 的合同（`portable/ports/fs.ts:41-61`）要求「同目录临时文件 + 原子 rename 覆盖」，并明写**做不到就带回来做决策，不许适配层悄悄弱化**。N1 §8 也把这条列为「单独决策，不是适配自由度」。读 `expo-file-system@57.0.4` 的 Android 源码，两条路都堵着：

- **`moveSync(dst,{overwrite:true})` 先删目标**：`fsops/CopyMoveStrategy.kt:88-91`（`LocalFile.prepareAsDestination`）——
  ```kotlin
  target.takeIf { it.exists() }?.let {
    if (!spec.overwrite) throw DestinationAlreadyExistsException()
    it.deleteRecursively()          // ← 目标先没了
  }
  ```
  之后 `tryNativeMove` 才做 `file.renameTo(resolved.target)`（`CopyMoveStrategy.kt:95-99`，注释自称 "Fast path: atomic rename"）。**rename 本身是原子的，但它前面那一下删除把窗口造出来了**：窗口里读到的是「文件不存在」，而 `readText` 把不存在返回成 `null`——即**「歌词没了」而不是「歌词是旧的」**。
- **`rename(newName)` 拒绝已存在的目标**：`FileSystemPath.kt:201-203` 走 `javaFile.toPath().moveTo(newFile.toPath())`，Kotlin 的 `Path.moveTo` 默认 `overwrite = false` → 目标存在即抛。

**API level 缺口**（v2 新增）：`FileSystemModule.kt:32` 给整个 `definition()` 标了 `@RequiresApi(Build.VERSION_CODES.O)` = **API 26**，NIO 的 `Files.move` 同样是 26+；而 N0b prebuild 实测 **minSdk = 24**（N0 §9）。要么升 minSdk 到 26，要么给 24/25 备一条路并**至少在一台模拟器上测**（决策 a）。

顺带确认（`internal/NativeFileSystem.types.d.ts:105-215`）：`info()` / `delete()` / `write()` / `textSync()` / `moveSync()` 都有**同步**变体——`FileSystemPort` 要求 `statSync`/`unlinkSync` 同步（`fs.ts:33,36`，因为清理的删除临界区里不许有 await，M5），这一条满足。**唯一缺的就是原子替换。**

**桌面那条判据搬不过来（v2 新增，评审反例）**：`node-fs.test.ts:60` 的「读 400 次，每次必须整旧或整新」之所以能观测到，是因为桌面的 `writeTextAtomic` 是**异步**的，给事件循环留了窗口。如果移动实现是**同步 native 调用**，同一条 JS 线程上的轮询只能在它返回之后才跑——**把实现换成 `moveSync(overwrite)` 也会全绿**，那就是一条恒为真的断言（N0b-5a 记过它的孪生兄弟：恒为假的断言和恒为真的一样没用）。判据 9 因此改口径，见 §4。

### 1.6 D16：机制已冻结，但**顺序、状态与清理面**要 N2 定（v3 已定，正文在 §2.2）

- N0b-5a 冻结的是**机制**：零写打开 = copy-then-open（只复制 main + `-wal`，不复制 `-shm`；复制前后校验 size+mtime，变了重试一次、仍变 fail closed；副本用毕删除；50MB 库 max 75ms、带 4MB 热 WAL max 150ms）· no-backup 侧 = SecureStore（`requireAuthentication: false`）· backup 排除 = 我方 CNG plugin 全量持有两份规则文件与两个 manifest 属性（`allowBackup=false` 只关云备份，D2D 要 `<device-transfer>`；expo-secure-store 必须 `configureAndroidBackup: false` 让位）。
- **spike 自己就把这件事挂给了 N2**：`spikes/.../panels/backup-identity.ts:22` —— 「The `install_id` key name here is the spike's, not a decision: **N2 owns where**」（spike 用的是 `lark.install_id` / `install_id`）。
- **v1 的顺序是错的**：D16 的全部意义是「在服务、迁移、凭证之前认出这个库是不是本机的」，而 v1 把 D16 排在 N2f、把正常打开与迁移排在 N2b——**等于让身份门跑在它要保护的东西后面**。v2 冻结启动序列（§2.2）并调整批次顺序（§3）。
- **v1 缺的定义已在 v3 补齐**（正文在 §2.2.1 / §2.2.2，决策 l 只剩拍板）：SecureStore 两个 key 与状态转移表 · 收敛清哪些、**不清 `sync_file_ops`** · **不复用 `unbindLibrary`**（`unbind.ts:51-67` 要完整 `CredentialStore` 且带 pending 检查，是「用户主动解绑」的语义）· CredentialStore 的移动实现进 N2（只做 SecureStore 读写，不接 skybridge）· **收敛后 `device_uuid` 必须重建**（它的定义是「this install's local identity」，`changes.ts:99`——留旧值等于两台安装共享本机身份）。

### 1.7 🔴 `ensureDeviceUuid` 是桌面专有的，而所有业务写入都要它（v2 新增，P0）

- 桌面每次打开库的最后一步：`db/index.ts:123` 的 `ensureDeviceUuid(sqlite, logger)`；定义在 `db/index.ts:145`，签名吃的是 **`BetterSqlite3.Database`**——所以它**留在了桌面那半**，N1 没有把它端口化。
- 而 `readLocalDeviceUuid(sqlite)`（`portable/sync/changes.ts:100`）在缺 `device_uuid` 行时**直接抛**，注释写着「createDatabase guarantees this row; a database without it was not opened by us」。每一次会 emit `sync_changes` 的业务写入（建歌、改名、建歌单、加歌、删除……）都经过它。
- **后果**：按 v1 的六步 bootstrap，判据 11 的 LibraryContract 与判据 13 的**全部写路径**会在第一次写入时抛错。
- **v2 的做法**：把它下沉成 portable 的 `ensureDeviceUuid(sqlite: SqliteLike, logger?)`，uuid 取自已经装好的 Random 端口（`portable/runtime/random.ts`）；桌面 `db/index.ts` 改成调用下沉版并保留自己的 re-export（`instanceof`/`err.name` 两种消费不受影响，N1a 的「re-export 不是重新定义」）。桌面现有的 4 条 `ensureDeviceUuid` 测试（`db/index.test.ts:364-391`）原样绿是零行为变化的判据。

### 1.8 🔴「删除只入队不执行」与现有服务和契约直接冲突（v2 新增，P0）

三条无法同时成立：

1. v1 §1.1 写「N2 只入队不执行」；
2. v1 判据 11 要 LibraryContract 18 例全绿；
3. v1 判据 13 写「删歌后 `songs/<id>/` 还在」。

而代码是：`portable/library/songs.ts:382` 的 `deleteSong` 在事务之后**无条件** `await options.fileOps.drain()`；契约 `contract/cases.ts:255-262` 那一例的名字就叫「deleting a song takes its files with it, not just its row」，断言 `!(await s.songFilesExist(id))`。

**v2 取「把执行器提前到 N2」**：实现 `FileEffectLike` 的移动执行器 + boot drain（`portable/sync/file-ops.ts:356` 的 `drain()` 与 `file-ops.ts:7` 的「Boot drains the journal before anything else looks at the song directories」）。判据 15 相应改成**「journal 已消费且目录已删除」**。另一条路（推迟删除 UI + 砍掉完整契约 gate）与主计划的 N2 gate 冲突，不取。

**v3 补：执行器的面比「删本地歌」大得多**（二轮评审）。`file-ops.ts:38-44` 有**四种 op**——`delete_song_files` · `quarantine_song_files` · `write_lyrics` · `delete_lyrics`，且 `DeleteRemoteArg`（`file-ops.ts:70-89`）还带 `audio_origin: 'downloaded' | 'imported' | null` 与 `lyrics_disposition: 'delete' | 'quarantine'` 的分支。**一个只实现了本地删除的执行器能通过 v2 的判据 12**，而一份真实 v3 库里这四种都可能躺着。

**控制面要从桌面提取，不要重写**：桌面的 `FileEffectRuntime`（`core/src/sync/file-ops-runtime.ts`，424 行）里，调度那一半——`drain` / `retry` / `discard` / `#drainOnce` / `#tryClaim`（`ClaimRegistry`）/ `#recordFailure`（退避与 `SYNC_FILE_OP_MAX_ATTEMPTS`）/ dead-letter——是**与宿主无关**的；宿主的只有 `node:fs` 的那几个动作和 `paths.ts` 的解析。两边各写一套 scheduler，到 N5 双端同步真跑起来时必然漂移，而这类漂移的表现是「同一条 op 在两台设备上退避次数不同」。→ 决策 k 扩写：**提取控制面进 portable，只把文件动作留给宿主**。

### 1.9 真机夹具与驱动：按 v1 的写法跑不起来（v2 新增，P1）

- **`Paths.document` 是应用私有目录**，release（非 debuggable）包不能 `adb push` 进去，`run-as` 也只对 debuggable 包有效。判据 12 要推一份真实 v3 副本进去、判据 15 要注入一个旧 DB、判据 17 要在指定崩溃点杀进程——**v1 没有给任何可执行的注入通道**。
- **现有驱动脚本硬编码 spike 包名**：`spikes/.../scripts/drive.mjs:32` 与 `backup-audit.mjs:28` 都是 `const PACKAGE = 'com.orpheusaviary.lark.spike'`。复用前必须把 package/app root 参数化。
- **真实桌面 v3 副本天然没有移动端 install_id**，所以它推进去之后**会主动走 D16 的 fail-closed**。判据 12 必须说清楚这是「预期的收敛路径」还是「测试前把 SecureStore 一并配好」（决策 o）。
- `seedSong` / 任意 DB 注入 / 崩溃钩子**都不许留在生产 APK**（决策 o）。

### 1.10 蓝牙歌词的判定输入（2026-08-19 调查，用户已拍板范围）

- 机制：AVRCP 没有歌词字段，实现一律是**把当前歌词行写进 TITLE**（关掉时 TITLE = 歌名）。应用侧不碰蓝牙 API，只写系统 Now Playing。
- **已有的两件不用动**：`parseLrc` / `currentLrcIndex` 在 `packages/shared/src/lrc.ts:46,69`。
- **写入口已经在钉版的依赖里**：`expo-audio@57.0.3` 的 `updateLockScreenMetadata` —— TS 面 `AudioModule.types.d.ts:180`，原生注册 `android/.../AudioModule.kt:516`，是 **`Function` 而不是 `AsyncFunction`（同步调用）**；底层 `service/MetadataInjectingPlayer.kt` 是 `ForwardingPlayer`，**自带去重**。**不需要写原生模块。**
- **用户已定的范围**：桌面（macOS）**整个不做**；只做 Android；**没有带屏蓝牙接收端，不做实测，先按成熟方案开发**。
- **N2 只做判定函数**；接线与开关归 N3（那里才有播放器和 `currentTime`）。
- **v1 的五条回落里有两条不可区分**（v2 修正，P1）：`parseLrc` 只收有时间戳的行（`lrc.ts:41-50` 的注释与实现），所以「没有歌词」和「纯文本无时间戳」**都返回 `[]`**——函数只吃 `LrcLine[]` 时它们是同一条分支，没法各做一次删除反测。v2 合并成一条 `lyrics.length === 0`（§2.5）。
- **一个未实测的风险**：AOSP `MediaPlayerWrapper.isMetadataSynced()` 在 queue 非空且 `activeQueueID != -1` 时比对 queue item 与 session metadata 的 (title, artist)，不一致就等 `CALLBACK_TIMEOUT_MS = 2000` 才推——歌词写进 title 正中这个分支。逃生口：queue 为 null 或 `activeQueueID == -1`。**N3 用 `dumpsys media_session` 验，N2 不承诺任何延迟数字。**

### 1.11 排序：「四种排序、复用桌面」没有落点（v2 新增，P1）

- 共享的业务排序只有三个字段：`SONG_SORT_FIELDS = ['name','artist','created_at']`（`packages/shared/src/types.ts:57`，daemon 按它校验 `?sort=`）。
- 桌面的 `default` 与 `duration` 是 **renderer 本地逻辑**（`packages/gui/src/renderer/src/lib/song-sort.ts:24`），而守卫禁止 mobile import GUI。
- **可共享的边界很清楚**（v3 按二轮评审收窄）：`lib/song-sort.ts` **整个是纯的**——`SortField` / `SortState` / `DEFAULT_SORT` / `SORT_FIELDS` / `isNumericField` / `toggleOrder` / `withField` / `isValidSort` / `sortSongs`，没有任何宿主依赖；而 `stores/view-prefs.ts` 依赖 **zustand + localStorage**（`view-prefs.ts:5` 的 `create`、以及它自己的持久化），**那一层不共享**。
- 所以决策 n 的正确形态不是「把视图偏好抽进 shared」，而是：**共享 `SortState` / 常量 / 校验 / 比较器**，桌面的 localStorage 与移动端的持久化**各留各的适配器**。

---

## §2 目标结构

### 2.1 `apps/mobile` 布局

```
apps/mobile (@lark/mobile, Expo SDK 57 + CNG，Android only)
├── app.config.ts        # 一切影响原生工程的东西写在这里（android/ 是 CNG 产物，不进仓）
├── plugins/             # CNG config plugin（改 manifest / gradle）：D16 的 backup 排除
├── modules/             # 我方 Expo native module（决策 a = ①）：Kotlin 源码 + expo-module.config.json
│   └── lark-fs/         #   autolinking 由 expo-modules-autolinking 按此目录发现
├── src/
│   ├── boot/            # §2.2 的启动序列，一条线，不散在各处
│   ├── identity/        # D16：SecureStore + copy-then-open + 状态机 + 收敛
│   ├── db/              # ExpoSqliteShim + portableDbOf + 打开分派（§2.4）
│   ├── ports/           # FileSystemPort / PathsPort / logger / file-op 执行器
│   ├── services/        # LibraryService 组装
│   ├── stores/          # zustand
│   └── ui/              # 四 tab + 列表 + bottom sheet
└── acceptance/          # 仅验收构建可达：contract hook、seedSong、DB 注入、崩溃钩子（决策 o）
```

- **CNG config plugin ≠ Expo native module**（v2 修正）：前者改生成出来的原生工程，后者是我们自己的原生代码 + autolinking。决策 a 取①，产物落 `modules/lark-fs/`，不是 `plugins/`。
- **applicationId 用 D14 的 `com.orpheusaviary.lark`**，不是 spike 的 `…lark.spike`——两者必须不同，否则第一次装真包会继承 spike 的 data 目录（N0b-1 实测）。
- **spike 不退役**（决策 d）：它继续持有平台探针与 `drive.mjs` / `probe-host.mjs`，但那两个脚本要**参数化 package 与 app root**（§1.9）。

### 2.2 🔒 启动序列（冻结，v3 重写）

v2 的序列有**三处实施不了**（二轮评审，全部属实）：fresh 首启从来不生成 install_id，于是第二次启动会把自己刚建的库当恢复库清掉；「收敛」排在读写打开之前，而收敛本身要写原库；兼容性判定排在收敛之后，于是 v1/v2/损坏库会先被写过再被拒绝，违反「拒绝路径零写入」；序列还漏了 boot drain。v3 拆成**零写预检 → 意图 → 读写 → 提交**四段：

```
① installPortableRuntime()                     ← Random 未装，后面一切 mint uuid 都抛
② 零写读三源                                    ← 库文件在不在 · SecureStore 的 committed/intent
                                                 · 若库在：copy-then-open 读 user_version + schema 签名 + install_id
③ 兼容性判定（在副本上）                          ← §2.4 矩阵；不兼容 = 零写拒绝，且**不碰 SecureStore**
④ 身份判定 → fresh | normal | converge | 重入     ← §2.2.1 状态表
⑤ 写 SecureStore intent                         ← fresh 与 converge 都写；normal 跳过
⑥ 打开原库（读写）                                ← 到这里才第一次以读写方式碰它
⑦ 版本分派 / 迁移 / assertCurrentSchema           ← fresh 在这里建链并 clearAudioMigrationPending
⑧ converge：一个 DB 事务里收敛                     ← 决策 l 的清理清单；**不清 sync_file_ops**
⑨ ensureDeviceUuid                              ← §1.7；桌面在同一位置（db/index.ts:123）
⑩ 提交 intent                                   ← SecureStore 写 committed、清 intent
⑪ boot drain（file-op journal）                  ← file-ops.ts:7：任何东西看歌曲目录之前
⑫ 组装 LibraryService → 服务 / UI
```

**三条不许动的顺序**：③ 在任何写之前（零写拒绝）· ⑤ 在 ⑥ 之前（崩溃可重入）· ⑪ 在 ⑫ 之前（journal 不变量）。

#### 2.2.1 身份状态表（决策 l 的正文）

SecureStore 两个 key（沿用 spike 的前缀，由 N2 正式定义）：`lark.install_id` = **committed**，`lark.install_intent` = **在途意图** `{ id, purpose: 'fresh' | 'converge' }`。

| 库文件 | committed | intent | DB 侧 `install_id` | 判定 |
|---|---|---|---|---|
| 无 | — | 无 | — | **fresh** |
| 有 | 有 | 无 | 相同 | **normal**（跳过 ⑤⑧⑩） |
| 有 | 有 | 无 | 不同或缺 | **converge** |
| 有 | 无 | 无 | 任意 | **converge**（典型的恢复库：DB 被恢复、SecureStore 被排除掉了） |
| 任意 | 任意 | **有** | 任意 | **重入**：上次崩在中途，按 `intent.purpose` 原样重做（幂等） |

**写序是 SecureStore 先、DB 后**（spike 的 `backup-identity.ts:243-246` 已经是这个顺序，面板文案写着 "SecureStore first, then the database"）。理由是崩溃留下的两种谎哪种更便宜：
- 先 SecureStore 崩 → 下次看到「无库 + 有 intent」= fresh 重入，覆盖一次，**代价为零**；
- 先 DB 崩 → 下次看到「有库 + 无任何身份」= 判成 converge，**把自己刚建的空库清一遍**——正是 v2 那个 bug。

**fresh 不是「两侧都空」**（v2 的隐患）：判别式是**库文件在不在**，不是身份在不在。恢复库的特征恰恰就是「有库、没身份」，它必须走 converge，与判据 17 一致。

### 2.2.2 收敛做什么、不做什么（决策 l）

- **做**：清 binding / sync 状态（outbox / tombstones / cursors / dead-letters）· **删旧 `device_uuid`**（收敛后由第 ⑨ 步重新生成，决策 j）· 写 DB 侧新 `install_id` · 清 SecureStore 里的 skybridge 凭证。全部在**一个 DB 事务**里。
- **不做**：**不清 `sync_file_ops`**（二轮评审指出）。那些行是**已提交但文件半未完成的后果**——曲库表已经这么说了，删掉它们等于留下永远解释不了的孤儿目录。它们归第 ⑪ 步的 drain。
- **不复用 `unbindLibrary`**：它为「用户主动解绑」而写，带 pending 变更检查、凭证换位与完整 `CredentialStore`（`unbind.ts:51-67`），而这里是「这个库不是本机的」——没有用户在场，也没有什么可保住的。收敛用一条显式清单，与 unbind 各自演进。

### 2.3 端口实现映射（`expo-file-system@57.0.4`）

| `FileSystemPort` | RN 实现 | 备注 |
|---|---|---|
| `statSync(path)` | `new File(uri).info()` → `{ size }`；不存在回 `null` | `info()` 同步。**「不存在」是返回值不是异常**（`fs.ts:10-13`） |
| `unlinkSync(path)` | `exists` 判 + `delete()` | `delete()` 同步且「不存在即抛」，所以先问 `exists` |
| `readText(path)` | `text()`，不存在回 `null` | 其余错误**原样抛宿主的**（`fs.ts:15-17`），不翻译 |
| `writeTextAtomic(path, text)` | **`modules/lark-fs` 的 `Files.move(…, REPLACE_EXISTING, ATOMIC_MOVE)`**（决策 a = ①，后台 `AsyncFunction`） | 同目录 `.<basename>.<uuid>.tmp` 的命名要保住（`fs.ts:56-59`，扫残留按前缀）；**父目录自动创建**（`fs.ts:45`） |
| `unlink(path)` | 同 `unlinkSync` 的 async 包装 | |

`PathsPort` 的根 = 移动 nest 根（决策 b）。`CANONICAL_AUDIO_FILE` / `LEGACY_AUDIO_FILE` 已在 `portable/ports/paths.ts:33,41`。

### 2.4 打开分派矩阵（移动端）

| `user_version` | 移动端行为 |
|---|---|
| `> 3` | 拒绝（`IncompatibleDbError`），**不升级、不写任何东西** |
| `0` 且 schema 空 | 正向迁移 `0 → 3`，**然后 `clearAudioMigrationPending`**（只有这一格清） |
| `0` 且 Go 旧库指纹 | 拒绝并报「不支持」（`isGoLegacyDb` 判定保留，`migrate.ts:93`） |
| `0` 且其它非空 | 拒绝（`IncompatibleDbError`） |
| `1` / `2` | **拒绝**（决策 m 已关闭），报一句人话：这个库来自更早的桌面版本，移动端不迁移 |
| `3` | `assertCurrentSchema` 后打开；**不碰 pending 标志** |

**所有拒绝路径在设 WAL 之前完成并关掉 handle**（M1「判定前零写入」，桌面有字节级不变断言）。

### 2.5 蓝牙歌词的判定函数（落 `@lark/shared`）

```ts
// packages/shared/src/now-playing.ts
export type NowPlayingMode = 'title' | 'lyrics';
export function nowPlayingTitle(input: {
  songName: string;
  lyrics: readonly LrcLine[];
  timeSeconds: number;
  offsetSeconds: number;   // 与 song.lyrics_offset / currentLrcIndex 同单位（秒）
  mode: NowPlayingMode;
}): string;
```

- **放 `shared` 不放 `portable`**：不碰数据库，`LrcLine` 本来就在 shared，两端都已依赖它。
- **回落四条**（v2 由五条合并而来，§1.10），全部回**歌名**而不是空串：① `mode === 'title'`；② **`lyrics.length === 0`**（涵盖「没有歌词」与「纯文本无时间戳」——`parseLrc` 对两者都给 `[]`，函数分不开也不该假装分得开）；③ `currentLrcIndex` 回 `-1`（还在第一行之前）；④ 命中的那一行是空串（间奏）。
- **长度上限**（决策 h 已关闭）：**64 个 Unicode code point**，按 code point 截断（`[...s]` 而不是 `slice`，否则 emoji 与代理对会被切成半个），**歌名回落同样受限**。64 这个数字没有实测支撑，判据只断言「有上限且不切半个字符」。
- **不造 port 抽象**：N3 的 adapter 是 mobile 播放层直接调 `updateLockScreenMetadata`。节流口径先记在这里：按 `currentLrcIndex` 的**返回值变了**触发而不是按时间，再压 ≥500ms 下限——AVRCP 与 A2DP 共用同一条 ACL 链路；**去重必须在我们这侧成立**，不依赖 expo-audio 自带那层。
- **N2g 不是零耦合**（v2 修正）：config 字段按决策 c 落 `local_metadata`（key `now_playing_mode`，值域 `'title' | 'lyrics'`，缺行或非法值一律读成 `'title'`），它因此依赖 N2b 的库打开；纯函数那半才是零耦合。

---

## §3 批次划分

每批：`just check` + `just test` 全绿是底线；桌面零回归；提交前给用户看 commit message。**Metro bundle smoke 每批都跑**。

| 批 | 内容 | 本批 gate |
|---|---|---|
| **N2a** | `apps/mobile` 立项：Expo 57 + CNG 脚手架、依赖与 spike 逐字节同版、`app.config.ts`（D14 的 applicationId、**minSdk 26**）、`just` recipes、**守卫扩面**（现有两条守卫的作用域从 spike 扩到 spike + mobile，**不新增编号**）、驱动脚本参数化 package/app root | 判据 1–4；桌面零回归 |
| **N2b** | 数据层原语：shim + `portableDbOf` 毕业、drizzle patch 接线、**完整打开分派（§2.4）**、bootstrap、**`ensureDeviceUuid` 下沉进 portable + 桌面改调下沉版** | 判据 5–8（**判据 8 是 gate**）；桌面 `db/index.test.ts` 原样绿 |
| **N2c** | **D16 身份门**：SecureStore 两个 key、§2.2.1 状态机、copy-then-open、fresh 身份声明、收敛（§2.2.2）、启动序列 §2.2 全条接线 + **验收注入通道**（决策 o） | 判据 16a、17、18、19（**四组全是 gate**；**16b 已搁置**，见判据 16b 与 §8.2） |
| **N2d** | 端口实现：FileSystem / Paths + logger + **file-op 执行器与 boot drain**；**决策 a 的产物**（原子替换）+ 它的反测 | 判据 9–12（**判据 10 是 gate**） |
| **N2e** | 服务层接线 + **LibraryContract mobile hook**（18 例真机跑）+ 破一次确认会红 | 判据 13（**gate**） |
| **N2f** | 四 tab 骨架 + 曲库/歌单读写 UI + 排序落点（决策 n）+ 真库副本 | 判据 14–15 |
| **N2g** | 蓝牙歌词判定函数（`@lark/shared` + 单测）+ config 字段（决策 c）+ 文档跟进 | 判据 20–21 |

**顺序理由**（v3 收紧）：N2c 的身份门必须在**任何真实库副本被以读写方式打开之前**就位。所以 **N2b 只产出可测试的 bootstrap / open factory**（在自己造的库上跑单测与真机面板），**不许把一个没带 D16 的持久化启动入口接进 app**——否则 N2b 到 N2c 之间的每一次真机运行都是一个会把恢复库当自己库打开的构建。判据 14 的真库副本排在 N2c 之后。

---

## §4 判据（1–21，其中 16 拆成 16a/16b，共 22 条；**gate 项加粗**）

**立项与守卫**
1. `apps/mobile` 在冻结设备上装起并显示首屏；applicationId = `com.orpheusaviary.lark`，与 spike 的 `…lark.spike` 不同包名共存。
2. `apps/mobile` 的 react / react-native / Expo 版本与 spike **逐字节相同**（RN 版本读 Expo 的 `bundledNativeModules.json`，不取 npm latest）。
3. **import 白名单守卫作用域扩到 mobile**（`@lark/core/portable` / `@lark/shared` / skybridge SDK）。反测：塞一个 `@lark/core` barrel import → 红。
4. **Metro bundle smoke 覆盖 mobile**：模块图里没有 Node builtin、没有 better-sqlite3、没有 `@lark/core` 非 portable 子路径。反测两条都要点着，且报出**具体是哪个文件**。

**数据层**
5. **打开分派六格各一条用例**（§2.4）：`>3` / fresh / Go 指纹 / 未知 v0 / v1·v2（**拒绝**，决策 m）/ v3。拒绝路径断言**库文件字节未变且无 `-wal`/`-shm`**（判定前零写入）。
6. fresh 库跑完 `0 → 3`，`user_version = 3` 且 `audio_migration_pending = '0'`（**行还在、值是 `'0'`**）；v3 现有库打开**不碰**该标志。
7. **桌面 mp3 迁移语义在移动端不可达**：模块图里没有 `migration/` 任何模块。
8. **【gate】`ensureDeviceUuid` 下沉**：fresh 库 / 已有 v3 库 / D16 收敛后的库三条都拿到合法 uuid v4，重开幂等；**桌面 `db/index.test.ts` 的四条原样绿**（零行为变化）。反测：跳过第 ⑦ 步 → 第一次 `deleteSong`/`createPlaylist` 抛 `readLocalDeviceUuid` 那个错。

**端口**
9. 五个 `FileSystemPort` 调用各一条真机用例；「不存在」一律是返回值（`statSync`→`null`、`unlink*`→`false`、`readText`→`null`），**权限错原样抛宿主的**。
10. **【gate】原子替换**——五条：
    - ① **替换窗口观测走 Android instrumentation / 原生两线程测试**，不走 JS 轮询。v2 曾写「或把 move 做成后台 `AsyncFunction`」——**那条不成立**（二轮评审）：生产实现是异步的，并不能让**被替换成同步 `moveSync` 的 mutant** 被同一条 JS 线程观测到，反测照样绿。`AsyncFunction` 是「别卡 JS 线程」的理由，不是验证机制。**反测与生产实现必须跑在同一线程模型下**：mutant 也在后台线程执行，用 barrier 把「删除之后、rename 之前」那一刻停住，读者线程必须在那里**读到文件不存在**。**判据是反测报出它看见了那个窗口**，不是「没红」。
    - ② 临时文件是**同目录兄弟**、命名可被前缀扫描识别。
    - ③ **父目录自动创建**；**写失败时旧文件原样保留**；**失败后不留 tmp 残渣**。
    - ④ **`ATOMIC_MOVE` 不被支持时必须失败，不许静默降级**成 copy+delete。
    - ⑤ **minSdk = 26**（决策 a）：断言**构建出来的 APK 的合并 manifest** 里 `minSdkVersion` 是 26，不是读 `app.config.ts`。API 24/25 那条备路随决策 a 一并取消。
11. `installPortableRuntime()` 未调用时，第一次 mint uuid **抛**（`no RandomSource`），不是静默产坏 uuid。
12. **file-op 执行器与 boot drain**——按 op 面而不是按一条路径（v3 扩，二轮评审：v2 只测本地删歌，一个只实现了本地删除的执行器能通过）：
    - ① **四种 op 各一条**：`delete_song_files`（本地）· `delete_song_files`（远端，`audio_origin` 的 `downloaded` / `imported` / `null` **三分支** × `lyrics_disposition` 的 `delete` / `quarantine`）· `quarantine_song_files` · `write_lyrics` · `delete_lyrics`。
    - ② **同一首歌严格按序、不同歌可越过**（claim 语义）。
    - ③ **崩溃重入**：drain 中途杀进程，重启后从同一行继续、不重复副作用。
    - ④ **退避与永久失败**：attempts 到顶的 op 不阻塞启动、如实上报、不被反复重试。
    - ⑤ **损坏的 arg** 走 dead-letter，不是让 drain 卡死。
    - ⑥ boot 时有残留 op → 起来先消费（`file-ops.ts:7` 的顺序），且在**服务组装之前**（§2.2 第 ⑪ 步）。

**服务层**
13. **【gate】LibraryContract 18 例在 mobile hook 上真机全绿**（含 cache 与 transfer 那两例），`daemon` / `cli-direct` 两个 hook 不受影响。四个错误类的映射各命中一次。**破法验证**：删掉 `requiredName` 的 `.trim()` → mobile hook 必须红。

**曲库与骨架**
14. 一份**真实 v3 曲库副本**经决策 o 的注入通道进入设备后（导入通道同时把 DB 侧 `install_id` 写成本机 committed 值 → 启动判成 **normal**，不触发收敛）：四 tab 可切、按决策 n 定下的每个排序字段各出一次、搜索命中、歌单详情可拖柄重排；重排后杀进程重开顺序仍在。
15. 写路径各一条：改歌名 / 改歌手 / 固定 / **删歌（journal 已消费且 `songs/<id>/` 已删除）** / 建歌单 / 改名 / 删歌单 / 加歌 / 移除。

**D16（v3 把 v2 的判据 16 拆成 16a/16b；16b 于 2026-08-19 搁置，其余四组全是 gate）**
16a. **【gate】合规 cloud backup restore**：`bmgr backupnow` + restore 官方流程，四类数据（DB / files / sharedprefs / SecureStore keychain）**均未恢复**。
16b. ~~**【gate】D2D device-transfer restore**~~ —— **搁置（2026-08-19 用户决定：不是第一版要保证的）**。原文见 §8.2。
    - **仍然做的**：`plugins/with-backup-rules.js` 照旧写 `<device-transfer>` 的九个 domain（它和 `<cloud-backup>` 是同一份文件里的两段，删掉反而是额外动作），判据 16a 仍验这份文件的内容。
    - **不做的**：走一遍系统「手机搬家」再断言四类数据没过来。于是 **`<device-transfer>` 这一半是「声明了但没验过」**，如实记着。
    - **为什么代价可控**：D16 的兜底不在排除规则上，在**收敛**上。判据 17 注入的正是「OEM 无视排除、DB 真的被恢复了」那个夹具，而它**没有搁置**——库过来了也会被判成 converge 并清掉 binding / 凭证 / `device_uuid`。排除规则是第二道，收敛是第一道，搁置的是第二道。
17. **【gate】强制半恢复夹具**：只注入旧 DB（模拟 OEM 无视排除）、SecureStore 缺失 → **converge（fail-closed）**，不是「当成 fresh 继续用」。
18. **【gate】install_id 不一致**：DB 里的与 SecureStore 里的不同 → converge。
19. **【gate】fresh 首启的身份声明 + 收敛的崩溃重入**（v3 扩，二轮评审：v2 根本没有 fresh 声明这一步）：
    - ① **第一次启动**：无库 → 建库 → **SecureStore 与 DB 两侧都有 install_id**；
    - ② **第二次启动**：判成 `normal`，**不触发任何清理**（断言 binding/sync 状态与 `device_uuid` 逐字段未变）；
    - ③ **fresh 的两个崩溃点**（写 intent 后 / 建库后未提交 intent）：重启都收敛到「一个可用的空库 + 一致的双侧身份」，且**没有把它当成恢复库清过**；
    - ④ **converge 的三个崩溃点**（写 intent 后 / DB 事务后 / 提交 intent 前各杀一次）：重启均收敛，binding/credentials **只清一次**；
    - ⑤ **收敛后 `device_uuid` 与收敛前不同**（决策 j）；
    - ⑥ **收敛不动 `sync_file_ops`**：收敛前塞一条 pending op，收敛后它**还在**，并由第 ⑪ 步的 drain 执行掉。

**蓝牙歌词**
20. `nowPlayingTitle` 单测覆盖 §2.5 的**四条**回落 + 长度上限（按决策 h 定下的单位，含一条 emoji/代理对不被切半）+ 正常命中。**每条都要有反测**：把该分支删掉 → 那条必须红。
21. config 字段 `now_playing_mode` 落 `local_metadata` 并可读回（决策 c）：缺行 → `'title'`；写 `'lyrics'` → 读回 `'lyrics'`；**塞一个非法串（含空串）→ 读回 `'title'` 且库里那一行未被改写**（读路径不修库）。**N2 不断言任何蓝牙行为**（没有播放器、没有设备）。

---

## §5 决策（a–o，**2026-08-19 全部关闭**）

用户拍板「a、l、o 照建议关，其余也照建议关」。下表的**结论**列即定案；建议里三处留白由本次一并定死，各自标了「**本次定死**」。

| # | 决策 | 结论（已关闭） |
|---|---|---|
| **a** | **原子替换**（§1.5）：① 自建 Expo native module（`Files.move(..., REPLACE_EXISTING, ATOMIC_MOVE)`，落 `modules/lark-fs/`）；② `pnpm patch` expo-file-system 去掉目标预删；③ 放弃原子性改「写 `.new` + 启动清扫」。**外加两个子问题**：minSdk 升 26 还是给 24/25 备路；判据 10① 用 instrumentation 还是把 move 做成后台 `AsyncFunction` | **取 ①，minSdk 升 26**。①的边际成本低且跨 SDK 升级不会静默失效；②打在别人的 Kotlin 上更脆；③直接弱化冻结不变量（歌词是库里唯一不可重下的文档，`fs.ts:49`）。minSdk 26 顺带消掉 `FileSystemModule.kt:32` 的 `@RequiresApi(O)` 缺口，**判据 10⑤ 因此改成「断言合并后的 manifest 里 minSdkVersion = 26」**，不再需要 API 24/25 模拟器。**本次定死**：`modules/lark-fs` 的 move 是后台 `AsyncFunction`（理由只是「别卡 JS 线程」），**判据 10① 一律走 Android instrumentation 两线程 + barrier**，不拿 `AsyncFunction` 当验证机制 |
| b | 移动 nest 根与库路径 | `FileSystem.Paths.document` 下 `lark/`，内部布局与桌面同构（`songs.db` + `songs/<id>/`）。注意它**不可 adb push**（§1.9），夹具注入走决策 o |
| c | config 宿主：① AsyncStorage；② 库里的 `local_metadata`；③ 独立 JSON 文件。**外加**：key 名、默认值、非法值回落、版本策略 | **取 ②**（`local_metadata`），不引第四种存储且随「只碰一个库文件」的备份故事走。**本次定死四件**：<br>· **key** = `now_playing_mode`（`local_metadata.key`，与 `device_uuid` 同表同域——per-install 本地偏好，**不进 `sync_changes`**）；<br>· **值域与默认值** = `'title' \| 'lyrics'`，缺行即 `'title'`（**默认关**：蓝牙歌词在本机无法实测，见 §1.10）；<br>· **非法值回落** = 任何不在值域内的字符串（含空串）读成 `'title'` 并 warn 一次，**不抛也不写回**（读路径不修库）；<br>· **版本策略** = 不设版本字段。`local_metadata` 是 KV，未知 key 一律忽略、缺 key 即默认值；语义变了就换 key 名，不做原地重解释 |
| d | spike 与 `apps/mobile` 的关系 | **复制 + spike 保留**（驱动设施还要用）。两份 shim 会漂移，所以**契约是唯一真相**：两边都跑 DatabaseContract |
| e | 「添加」tab 在 N2 做什么（没有下载链路） | 显式空态 + 一句「N4 开放」，**不做半个粘贴框** |
| f | LibraryContract mobile hook 跑在哪 | **真机**（release 构建 + 决策 o 的验收构建），不是桌面 jsdom |
| g | `nowPlayingTitle` 落 `@lark/shared` 还是 `portable` | **shared**（§2.5 已给理由） |
| h | 蓝牙歌词长度上限的**单位与截断方式**，以及歌名回落受不受限 | **64 个 Unicode code point**、按 code point 截断（不切代理对）、**歌名回落同样受限**；数值没有实测支撑，判据只断言「有上限且不切半个字符」，**不把 64 当契约** |
| i | 移动端 `audioMode` | 恒 `canonical`（移动端没有 0.2.x 遗留库） |
| **j** | **`device_uuid`**（§1.7）：下沉函数的签名与位置；以及 **D16 收敛后旧库里的 `device_uuid` 要不要重建** | 下沉为 `portable/db-identity.ts` 的 `ensureDeviceUuid(sqlite: SqliteLike, logger?)`，uuid 取 Random 端口；桌面 re-export。**收敛后必须重建**——它的定义是「this install's local identity」（`changes.ts:99`），留旧值等于两台安装共享身份，而同步的墓碑与回声判定全靠它 |
| **k** | **file-op 执行器提前到 N2**（§1.8）：接受，还是改判据 13/15 的口径。**外加**：控制面提取进 portable，还是移动端另写一套 scheduler | **接受提前 + 提取控制面**。`FileEffectRuntime`（424 行）里调度那一半与宿主无关（`drain`/`retry`/`discard`/`#drainOnce`/`#tryClaim`/`#recordFailure`/dead-letter），只有 `node:fs` 动作与路径解析是宿主的。两套 scheduler 到 N5 双端同步时必然漂移，且漂移表现成「同一条 op 在两台设备上退避次数不同」——这种病没人会往调度器上想 |
| **l** | **D16 的状态与清理面**——正文在 §2.2.1 / §2.2.2 | **按 §2.2.1/§2.2.2 全条通过**，含：两个 SecureStore key（`lark.install_id` = committed / `lark.install_intent` = 在途意图）· 状态转移表以**库文件在不在**为判别式 · **写序 SecureStore 先、DB 后**（先 SecureStore 崩只值一次覆盖，先 DB 崩会把刚建的空库当恢复库清一遍）· 收敛清单 · **不清 `sync_file_ops`** · 不复用 `unbindLibrary` · CredentialStore 进 N2 但只做 SecureStore 读写 |
| **m** | v1/v2 库在首个移动版本里：拒绝 / 迁移 / 特殊恢复 | **拒绝并给一句人话**。移动端不存在自然产生的 v1/v2 库（只可能来自异常恢复），而迁移路径没有桌面那套备份与探活；拒绝是唯一不会悄悄毁数据的选项 |
| **n** | 排序落点（§1.11） | **只提取 `lib/song-sort.ts` 那一层**（`SortState` / 常量 / `isValidSort` / `toggleOrder` / `withField` / `sortSongs` 比较器）进 `@lark/shared`——它整个是纯的。**`stores/view-prefs.ts` 不动**：它依赖 zustand 与 localStorage，持久化各端各留一个适配器。v2 写「视图偏好整体抽进 shared」是错的（二轮评审） |
| **o** | **验收注入通道**（§1.9）：真机怎么塞夹具库、怎么打崩溃点，且**不进生产 APK** | **七条全取**（v3 按二轮评审落地——`acceptance/` 目录本身不构成构建变体）：<br>① **entrypoint 分叉**：`app.config.ts` 读 `LARK_ACCEPTANCE=1`，该值决定入口模块（生产入口不 import `acceptance/`）；<br>② **两个 artifact**：**「release 模式的 acceptance artifact」**（跑判据 13/14/17/18/19 与 file-op 各条）与**「生产 release artifact」**（跑判据 1/16a；16b 已搁置）——不是「release + acceptance」两个 flag 叠加；<br>③ **applicationId 相同**、同一 keystore 签名，否则 D16 的 backup 判据测的是另一个包（代价：两者不能同时装，验收脚本要显式换装）；<br>④ **夹具经 `adb push` 到外部目录 + acceptance 入口的一次导入**（`Paths.document` 推不进去，§1.9）——**N2c 实施时收窄**：D16 自己的判据（17/18/19）**一条也不需要推文件**，它们需要的是「一个本机没有身份的库」，而忠实的造法是用真路径造一个真库再把身份拿掉（那正是恢复干的事）；推文件反而会把导入通道一起测进去。④ 因此只服务**判据 14 的真实桌面 v3 副本**，随 N2f 落地；<br>⑤ **崩溃点是 acceptance 入口里的显式钩子**，不是 `am force-stop` 猜时机——判据 19 的五个点要能精确打中；<br>⑥ **守卫**：生产 release bundle 的 Metro 图里**不许出现 `acceptance/`**（与判据 4 同一把尺子）；<br>⑦ 驱动脚本参数化 package/app root（`drive.mjs:32` / `backup-audit.mjs:28` 现在写死 `…lark.spike`）。<br>**本次定死**：判据 14 的真实 v3 副本走 **normal**——acceptance 入口的导入通道在落库的同时把 DB 侧 `install_id` 写成本机 committed 值（**导入通道本身是身份感知的**，不是「先推文件再祈祷」）。理由：判据 14 是曲库/UI 判据，而 converge 会清 binding/sync 状态并重建 `device_uuid`——那正是 14 不关心、却足以把它的失败和 D16 的失败搅在一起的东西；converge 路径由判据 17/18 专测，它们注入的是**故意不配身份**的库 |

---

## §6 风险

| 风险 | 缓解 |
|---|---|
| **原子替换无解** | 决策 a；判据 10 的反测是唯一能证明它真做到了的东西。**若三条路都不通，这是要停下来的事，不是降级实现的事** |
| **判据 10 假绿** | §1.5 已写明同线程轮询恒为真；判据 10① 明确要求反测**报出它看见了窗口** |
| D16 顺序被实现悄悄改回去 | §2.2 冻结启动序列；判据 16a/17/18/19 是对**序列**的验收，不是对函数的 |
| 两份 shim 漂移（决策 d 的代价） | DatabaseContract 两边都跑；shim 有任何改动，两边同改是提交前的检查项 |
| Gradle 看不见 `packages/core/dist` 的变化 | N0b-5b 实测：release recipe 先 `rm -rf` 生成的 bundle 再构建 |
| 验收钩子漏进生产 APK | 决策 o 的构建变体 + 一条守卫：release 变体的 Metro 图里不许出现 `acceptance/` |
| 真库副本上手把真库改坏 | 只用 `just backup-nest` 的副本；push 前对副本查 `user_version` 与 schema signature |
| D16 各组测不出真东西 | N0b-5a 的教训：**证据要取在能观测到的那一刻**。判据 16a / 17 / 18 / 19 每条都要先想清楚「它什么时候会红」；判据 19② 的「不触发任何清理」尤其要按字段断言，不是看应用没崩 |
| 蓝牙歌词被 2 秒 queue 陷阱吃掉 | §1.10；N3 用 `dumpsys media_session` 验。**N2 不承诺任何延迟数字** |
| 无带屏蓝牙设备 | 用户已决定：不实测、先开发、后续再修。真出问题时可能要给 expo-audio 打补丁或加 config plugin，**这会超出「小功能」的预算** |
| `pnpm install` 扰动桌面 | 常驻判据：每次变动复跑桌面 `just check` + `just test` |

---

## §7 参考

- 主计划 §4：`docs/plans/2026-08-13-m4a-and-mobile-master-plan.md`
- N0 子计划：`docs/plans/2026-08-17-phase-b-mobile-n0.md`（§3.2a 测量协议、§5 N2 段、§9 实施记录与设备档案）
- N1 子计划：`docs/plans/2026-08-18-phase-b-mobile-n1.md`（**§8.1 D5 分段冻结 = 单一事实源**、§2.4 FileSystem/Paths 语义口径）
- 打开协议与 `ensureDeviceUuid`：`packages/core/src/db/index.ts:51-58,123,145`
- 服务层与契约：`packages/core/src/portable/services/library.ts`、`portable/services/contract/{types,cases,index}.ts`
- 删除与 journal：`portable/library/songs.ts:382`、`portable/sync/file-ops.ts`、`portable/sync/unbind.ts:51-105`
- 端口合同：`packages/core/src/portable/ports/{fs,paths}.ts`；桌面参照实现与测试：`packages/core/src/node-fs.ts` / `node-fs.test.ts:60`
- D16 spike：`spikes/mobile-foundation/src/panels/backup-identity.ts`；驱动：`spikes/mobile-foundation/scripts/{drive,backup-audit,probe-host}.mjs`
- LRC 与排序：`packages/shared/src/lrc.ts`、`packages/shared/src/types.ts:57`、`packages/gui/src/renderer/src/lib/song-sort.ts`
- 实施记录：`PROCESS.md` 的 Phase B 段

---

## §8 评审修订对照（v1 → v2）

| # | 评审反例 | 复核结果 | v2 的处理 |
|---|---|---|---|
| P0-1 | 移动 bootstrap 缺 `device_uuid`，所有写操作会失败 | **属实**。`ensureDeviceUuid` 在 `db/index.ts:145`，签名吃 `BetterSqlite3.Database` = 桌面专有；`changes.ts:100` 缺行即抛 | 新增 §1.7 + 决策 j + 判据 8（gate）+ 进 N2b |
| P0-2 | 「只入队不执行」与 `deleteSong`、契约冲突 | **属实**。`songs.ts:382` 无条件 `await fileOps.drain()`；`cases.ts:255-262` 断言目录已删 | 新增 §1.8 + 决策 k；**file-op 执行器与 boot drain 提前进 N2**（N2d）；判据 12 新增、判据 15 改口径 |
| P0-3 | D16 排在打开原库之后，违反自身不变量；且状态/清理面未定义 | **属实**。v1 把 D16 放 N2f 而 N2b 已经开库；`unbind.ts:51-67` 确实要完整 `CredentialStore` | 新增 §2.2 冻结启动序列 + §1.6 缺口清单 + 决策 l；D16 提前到 **N2c**，且 N2b 明令不推真实副本 |
| P1-1 | 打开协议只写了 fresh 库 | **属实**。`db/index.ts:51-58` 有六类 | 新增 §1.2 + §2.4 矩阵 + 决策 m + 判据 5/6 |
| P1-2 | 原子替换验收可能假绿；minSdk 缺口；CNG plugin ≠ native module | **全部属实**。`node-fs.test.ts:60` 靠异步留窗口；`FileSystemModule.kt:32` 是 `@RequiresApi(O)`=26 而 prebuild 实测 minSdk 24 | §1.5 补两段；判据 10 拆成五条（含反测要「看见窗口」、父目录/失败保留/tmp 清理/ATOMIC_MOVE 不许降级、API 24/25 路径）；§2.1 拆开 `plugins/` 与 `modules/` |
| P1-3 | 真机夹具不能按文档复用；驱动硬编码 spike 包名 | **属实**。`drive.mjs:32` / `backup-audit.mjs:28` 都是 `…lark.spike`；`Paths.document` 不可 push | 新增 §1.9 + 决策 o（验收构建变体）+ 判据 14 明确 D16 预期路径 + 风险行「验收钩子漏进生产 APK」 |
| P1-4 | 蓝牙歌词的②③不可区分 | **属实**。`parseLrc`（`lrc.ts:41-50`）只收带时间戳的行，两种输入都给 `[]` | §1.10 + §2.5 合并成四条回落；决策 h 补单位与截断语义 |
| P1-5 | 「四种排序、复用桌面」没有落点 | **属实**。`shared/types.ts:57` 只有三个字段，`default`/`duration` 在 GUI renderer | 新增 §1.11 + 决策 n + 判据 14 改成「按决策 n 定下的每个字段」 |
| 小-1 | 映射漏 `NotFoundError` | 属实（`errors.ts:237`，`ContractFailure` 有 `not-found`） | §1.3 补四行映射表 |
| 小-2 | 契约含 export/cache，mobile hook 仍须接线 | 属实（`cases.ts` 六组 18 例含 cache 1 + transfer 1） | §1.1/§1.3 写明「功能归 N4/N6，但方法在 N2 就要能调通」 |
| 小-3 | `LibraryService` 方法数 | **两边都不对**：实测 **22**（评审说 21，v1 说 24） | §1.1 改为 22 |
| 小-4 | config 缺 key/默认值/非法值/版本 | 属实 | 决策 c 扩四件 + 判据 21 补非法值回落 |
| 小-5 | N2g 不是零耦合 | 属实 | §2.5 末尾写明：纯函数那半零耦合，config 那半依赖 N2b |
| 小-6 | 「第八条守卫」编号混乱 | 属实——实际是把现有两条的作用域扩到 mobile | §3 N2a 与判据 3/4 改成「作用域扩到 mobile，**不新增编号**」 |

### §8.1 v2 → v3（二轮评审）

| # | 评审反例 | 复核结果 | v3 的处理 |
|---|---|---|---|
| 必修-1 | **fresh 首启没有生成 install_id**，第二次启动会把自己刚建的库当恢复库清掉；而照 spike 把「两侧都空」判 fresh 又会放过真正的恢复库 | **属实**。v2 的 §2.2 第 ② 步「不在 = fresh 安装，跳到 ⑤」之后再没有任何一步写身份 | §2.2 新增 ⑤ 写 intent / ⑩ 提交；§2.2.1 状态表把**判别式定为「库文件在不在」而不是「身份在不在」**——恢复库的特征恰恰是「有库、没身份」，它必须走 converge；写序冻结成 **SecureStore 先、DB 后**（哪种谎更便宜）；判据 19 新增 ①②③ |
| 必修-2 | **「收敛」排在首次读写打开之前，实际执行不了**；且兼容性判定在收敛之后，v1/v2/损坏库会先被写过再被拒绝 | **属实**，两条都是。收敛要清 binding、写新 install id、删旧 device uuid，全都要写原库 | §2.2 重写为四段：**零写预检（含兼容性）→ 写 intent → 读写打开 → DB 事务收敛 → 提交 intent**。③ 在任何写之前是三条不许动的顺序之一 |
| 必修-3 | **冻结序列漏了 boot drain**；且 D16 收敛不能顺手删 `sync_file_ops` | **属实**。v2 自己引了 `file-ops.ts:7` 的不变量、判据 12 也要 boot drain，序列里却没有 | §2.2 新增第 ⑪ 步（在组装服务之前）；§2.2.2 明写**收敛不清 `sync_file_ops`**——那些是已提交但文件半未完成的后果，删掉等于留下解释不了的孤儿目录；判据 19⑥ 验它 |
| P1-1 | 判据 12 只测本地删歌，一个只实现本地删除的执行器能过 gate；控制面最好从桌面提取 | **属实**。`file-ops.ts:38-44` 有四种 op，`DeleteRemoteArg` 还带 `audio_origin` 三分支 × `lyrics_disposition` 两分支；桌面 `FileEffectRuntime` 424 行里调度那一半与宿主无关 | §1.8 补一段；判据 12 拆成六条（四种 op + 远端删除的分支矩阵 · 同歌顺序/异歌越过 · 崩溃重入 · 退避与永久失败 · 损坏 arg → dead-letter · boot 顺序）；决策 k 扩成「提取控制面进 portable」 |
| P1-2 | 原子替换反测仍有逻辑矛盾：生产做成 `AsyncFunction` 并不能让**同步的 mutant** 被同一条 JS 线程观测到 | **属实**。v2 把「异步化」误当成了验证机制 | 判据 10① 改成 **instrumentation / 原生两线程为准**，且**反测与生产必须同线程模型**：mutant 也在后台线程跑，用 barrier 停在「删除后、rename 前」，读者线程必须在那里读到文件不存在。`AsyncFunction` 降回「别卡 JS 线程」的理由 |
| P1-3 | `bmgr` 证明不了 Android 12+ 的 device-transfer 路径 | **属实**。N0b-5a 也只做了 `bmgr` 那半，并把完整 D2D 挂给 N2 | 判据 16 拆成 **16a（cloud backup，`bmgr`）+ 16b（D2D device-transfer）**，16b 要写明供体/接收、包与签名、迁移步骤；载体已确认在手（N0 §9 记过这台设备 `D2dTransport` 也在） |
| P1-4 | 验收构建不落地：`acceptance/` 目录本身不构成构建变体 | **属实** | 决策 o 改成七条具体的：`LARK_ACCEPTANCE` 决定 entrypoint · **两个 artifact**（「release 模式的 acceptance artifact」与「生产 release artifact」，不是两个 flag 叠加）· applicationId 相同同 keystore（否则 D16 判据测的是另一个包）· 夹具经外部目录导入 · 崩溃点是显式钩子不是猜时机 · 守卫查生产 bundle 的 Metro 图 · 驱动脚本参数化 |
| P1-5 | 决策 n 不该把「视图偏好」整体抽进 shared | **属实**。`lib/song-sort.ts` 整个是纯的，而 `stores/view-prefs.ts` 依赖 zustand + localStorage | §1.11 与决策 n 收窄成：只共享 `SortState` / 常量 / 校验 / 比较器，持久化各端各留适配器 |
| 小-1 | §1.1 的「songs 9、playlists 8」不符 | **属实**，实际 **songs 6 / playlists 9** | 已改并列出六个方法名 |
| 小-2 | 判据 19 的 device uuid 应引决策 j 不是 l | 属实 | 已改（判据 19⑤） |
| 小-3 | 风险表两处仍写「判据 15–18」 | 属实 | 已改成 16a–19 |
| 小-4 | `timeSec` 与 `offset` 单位不对称 | 属实 | 改成 `timeSeconds` / `offsetSeconds`，并注明与 `lyrics_offset` / `currentLrcIndex` 同为秒 |
| 小-5 | N2b 若在 N2c 前，须限定它只产出可测试的 factory | 属实 | §3「顺序理由」改写：N2b **不许把没带 D16 的持久化启动入口接进 app** |

### §8.2 范围修订：判据 16b 搁置（2026-08-19，用户决定）

**决定**：D2D device-transfer restore 的验收**不做**，理由是「这不是第一版软件需要保证的」。

**判据 16b 的原文**（保留在此以便日后接回）：

> **【gate】D2D device-transfer restore**：**`bmgr` 证明不了这条**（二轮评审属实）——Android 12+ 的设备迁移走 `dataExtractionRules` 的 `<device-transfer>`，是另一条通路。判据要写明供体/接收、包与签名、迁移步骤。**载体已确认在手**：N0b-5a 记过这台设备 `LocalTransport` 与 **`D2dTransport` 都在**，「D16 的完整 D2D restore 验收不必再找第二台设备」（N0 §9）。

**边界要说准**——搁置的是**验收**，不是**实现**：

| | 状态 |
|---|---|
| `<device-transfer>` 的九个 domain 排除 | **照写**（与 `<cloud-backup>` 同一份 xml 的两段，删掉反而是额外动作）；判据 16a 仍逐 domain 验这份文件的内容 |
| `allowBackup=false` + 云备份排除 | **不变**，判据 16a 是 gate |
| 走一遍系统「手机搬家」并断言四类数据没过来 | **不做** |
| 结论 | `<device-transfer>` 这一半 = **声明了但没验过**。如实记着，别当成验过的 |

**为什么这个代价可控**：D16 的兜底从来不在排除规则上，在**收敛**上。判据 17 注入的正是「OEM 无视排除、DB 真的被恢复了」那个夹具——排除规则失效恰恰是它的前提，而它**没有搁置**。库过来了也会被判成 converge，binding / 凭证 / `device_uuid` 一并清掉。排除规则是第二道防线，收敛是第一道；搁置的是第二道，且第二道失效时第一道恰好是为它写的。

**接回时要做的**：把上面那段原文改回判据、按它写明供体/接收与迁移步骤、在冻结设备上跑一遍（`D2dTransport` 在手，不必找第二台机器）。

### §8.3 范围修订：判据 14 的「拖柄重排」不做（2026-08-19，用户决定）

**决定**：移动端**第一版不做歌单拖拽重排**。理由（用户原话要点）：**长按容易误触**，而且**主流手机音乐软件也不支持**手机端拖拽重排；后续需要时再加。

**判据 14 的原文**（保留，改动的只有加粗那半）：

> 一份**真实 v3 曲库副本**经决策 o 的注入通道进入设备后（…启动判成 **normal**，不触发收敛）：四 tab 可切、按决策 n 定下的每个排序字段各出一次、搜索命中、~~歌单详情可拖柄重排；重排后杀进程重开顺序仍在~~。

| | 状态 |
|---|---|
| 四 tab 可切 · 每个排序字段各出一次 · 搜索命中 · 歌单详情可看 | **照做**，判据 14 剩下这四件 |
| `reorderPlaylist` 的**业务逻辑** | **不受影响**：LibraryContract 的 `write · membership and reorder move a song without touching the others` 一例已在 mobile hook 上真机绿（判据 13），服务层这条路是通的 |
| 拖柄这个**交互** | **不做** |
| 「重排后杀进程重开顺序仍在」 | **不做**。于是 **rank 的持久化在移动端没有端到端验过**——桌面验过、契约在一个会话内验过，如实记着 |

**顺带省掉的**：`react-native-gesture-handler` / `react-native-reanimated` / 拖拽列表库这一套（N2f 因此零新依赖）。**N3 若为播放器或 bottom sheet 引入手势栈，拖拽重排的成本会降到 20 行左右**，那是重新考虑它的自然时机。
