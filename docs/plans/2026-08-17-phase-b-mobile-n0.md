# Phase B 子计划：Android 移动版 — N0 详案 + 全期框架

> 2026-08-17 **v4**（三轮评审定稿：修订对照见 §10）。主计划 `docs/plans/2026-08-13-m4a-and-mobile-master-plan.md` 的 **D1–D17 方向不变，但 §4.3 有两处显式语义修订**（评审收敛产物）：N0a 行的 harness 覆盖面按实测使用面收窄（决策 c2）、N0b/N1 行的平台 spike / R 系列复验重排与 D5 分段冻结。修订分两段：
> **Stage-1（本计划获批后、N0a 开工前，单独 docs 提交）**：落上述两处语义修订 + PROCESS.md 开 Phase B 段。**Stage-2（N0b-5）**：写入 D4/D16/D17 实测结论。两段之间不允许双事实源——Stage-1 不做完，N0a 不开工。
>
> 调查方法：四路并行盘点 + 外部核查。file:line 落到 **HEAD `3451347`**（= 0.3.0 tag `9cf9d97` 后仅文档提交，代码同一状态）。

---

## §0 范围、边界原则、版本口径与前置条件

- **范围**：Phase A（0.3.0）已于 2026-08-17 发版收官。Phase B = Android 移动版（`@lark/mobile`），批次 N0a → N0b → N1 → N2 → N3 → N4 → N5 → N6。本文把 **N0a 与 N0b 写到可开工粒度**；N1 起每批另出子计划，§5 给框架。
- **N0b/N1 的边界原则**：core 业务模块（bilibili client、link、歌词、backfill、apply、file-ops）要到 N1 端口化后才能在 RN 上 import——`wbi.ts:21` 直接 `node:crypto`、`backfill.ts:29` 直接 `node:fs/promises`、apply 依赖图经 `changes.ts:12`/`conflicts.ts:16`/`file-ops.ts:20-23` 进 `node:crypto` 与 fs，Metro 解析直接失败。所以：
  1. **N0b 是平台 spike**：workspace 内部包只 import `@lark/core/portable`、`@lark/shared`、`@orpheus-aviary/skybridge-client`（+`skybridge-proto`）；其余判定全部用**显式标注的探针**与**桌面产出的夹具**完成。
  2. **N1 出口新增「真机业务图复验」判据组 R1–R5**（§3.5）；D4/D5 冻结分两段（§3.4）。
  3. spike 内**禁止复制 core 实现来假装验证 core**——探针只发裸请求、只断言平台行为；**凡探针需要 core 才能算出的输入（WBI 签名、带签流 URL、header 集），一律由桌面用真 core 产出成 fixture**（判据 19/23 的形态），写进 spike README 与代码注释。
- **版本口径（决策 a）**：APK 独立版本线 0.1.0 / versionCode=1（D14）。桌面 Phase B 期间不必发版；N1 重构落 main、随下个桌面版本自然发出；中途发桌面 0.3.x 先复跑 accept 全系列。
- **前置条件**：
  1. **一台 Android 真机**（用户提供；target 36，minSdk 按 Expo 57 默认并在 N0b 记录）。**它同时是 §3.2a 测量协议的冻结设备**。
  2. 本机 Android 构建链（JDK + Android SDK + adb；`npx expo run:android` 本地构建，不依赖 EAS 云）。
  3. **TLS（D15）与 N0 无耦合**：spike 允许 LAN 明文 HTTP（决策 f），产品线 https-only 不动，TLS 死线仍是 N4。
- 🚨 N0b 起 Expo 进桌面 workspace——**每次 `pnpm install` 变动后必须复跑桌面 `just check` + `just test`**（判据 13，常驻义务）。

---

## §1 调查结论（2026-08-17，含三轮评审复核补充）

### 1.1 外部事实

| # | 事实 | 对计划的影响 |
|---|---|---|
| E1 | **drizzle-orm #4519（expo-sqlite driver `prepareSync` 后不 finalize）open、零维护者响应、无关联 PR** | D4 出口 ①「升级到已修复版」不存在；②③ 之间定案 |
| E2 | drizzle #5240：expo driver 的 async API 非真异步、总在 JS 线程 | 佐证 D4 同步 API + 单连接；卡顿只能靠分批 → 判据 18/R5 |
| E3 | Expo SDK 57 = RN 0.86 + React 19.2；`expo@57.0.9`（08-13）起修 Hermes V1 内存回归 | spike 用**单一精确版本**：开工当天取 57.0.x 最新（须 ≥57.0.9），写死并记 §9 |
| E4 | expo-audio「release 后原生 player 继续播」（#47569）已修（PR #47828） | 钉含修复版本 + pause-before-release 习惯 + N3 行为判据 |
| E5 | **expo-sqlite 公开 `SQLiteOpenOptions` 无 readonly；expo FileSystem 无 `noBackupFilesDir`**（官方文档） | D16 两能力都没有现成载体——判据 26 是 gate |
| E6 | **better-sqlite3 原生支持嵌套 `.transaction()`（savepoint 实现）；drizzle Expo driver 也实现 savepoint（`expo-sqlite/session.js:44`）** | 「嵌套即抛」撤销——嵌套/savepoint 不进保证面（决策 c2） |
| E7 | **drizzle 的 expo-sqlite 入口同时发 ESM/CJS/两套声明**（`drizzle-orm/package.json:724` 起） | patch 覆盖双载体 + 三路径验证（判据 17） |
| E8 | **Expo 的 `executeSync()` 返回仍需消费的 result/cursor：`getAllSync`/`getFirstSync` 必须在 finalize 之前完成**（官方文档）；drizzle 的 all/get/values 都在 `executeSync()` 后继续读行（`session.js:79`）（三轮评审实证） | 「保持原 stmt 字段、执行后立刻 finalize」的包装式 patch 会**写路径绿、查询路径坏**——patch 实现冻结为「client+SQL、方法内 prepare、完整消费后 finally finalize」（§1.3-C v4） |

### 1.2 三块硬骨头比立项时软（file:line 已核）

- **A. portable 提取对象本来就纯**：`db/schema.ts`（唯一 import `drizzle-orm/sqlite-core`）、三个 migration + registry（零 import 纯字符串）、`db/migrate.ts` / `db/schema-signature.ts`（better-sqlite3 仅 type import）。**两文件的运行时 errors 依赖**（`migrate.ts:9`、`schema-signature.ts:18`；三类均直接 `extends Error`，`errors.ts:150/175/192`）→ `portable/errors.ts`（§2.1，决策 i）。core 零 Node import 的非测试文件 40 个；better-sqlite3 值导入仅 7 文件。
- **B. skybridge client 0.1.4 实质 RN-ready**：零 Node builtin、纯 ESM、全入口 `fetchImpl` 缝（`http.ts:33,113,141`、`client.ts:201`）；SSE 是 streaming fetch（`sse.ts:43-47` 要求 `res.body`）。`engines: node>=22` 只在发布清单，Metro 不看。SDK 可直接进 N0b spike。
- **C. `SyncRuntime` 近宿主无关**（`runtime.ts:50`，唯一耦合默认注入的 `realSkybridgeApi`）；daemon 特有收敛在 `triggers.ts`（NodeJS.Timeout、outbox SQL `:279-281`、SSE `:318`）与 `login.ts:25` 的 `node:os hostname`。core 引擎传输本来就注入（`engine.ts:73-76` `SkybridgeClientLike`）。

### 1.3 N0b/R 系列的判定输入

- **A. Web 标准全局面清单（判据 21）**：
  - `new URL` + `searchParams`：`download/link.ts:179,226,258`、`sync/server-url.ts:44`、skybridge `http.ts:40-45`。
  - `URLSearchParams`：歌词三 client（`netease.ts:25`、`qq.ts:26,47`、`kugou.ts:29,52,68`）。
  - `AbortSignal.any` / `AbortSignal.timeout`：`download/timeouts.ts:62`、`download/engine.ts:793`。
  - `TextDecoder`：skybridge `sse.ts:93`。
  - `structuredClone`：`config/index.ts:71,80,104,113`。
  - **`Buffer.byteLength`（UTF-8 字节长）**：`sync/changes.ts:87`、`sync/engine.ts:362`、`sync/backfill.ts:281`、`sync/file-ops.ts:341`、`library/lyrics.ts:137`——走 **TextEncoding 端口**（多字节/代理对样本）。
  - **`Buffer.from(x,'base64')`**：`download/lyrics/shared.ts:93`——走 **Base64 端口**（padding/非法输入行为逐字节一致）。
  - fetch 细节：`redirect:'manual'` + 读 `location`（`bilibili.ts:318,326`）、204（skybridge `http.ts:77`）、streaming `res.body`。
  - 产出 = polyfill/端口三栏清单（原生 / polyfill / 端口），写回 §9，作 N1 冻结输入。
- **B. crypto 端口形态**：`expo-crypto` digest 是 async，而 `wbi.ts:67-69`（MD5）与 `file-ops.ts:342`（sha256）是同步调用点。**Crypto 端口的完整面（v4 补 RandomBytes，评审 R3-P2-2）= md5 / sha256 / randomUUID / getRandomValues**——`randomBuvid3()`（`wbi.ts:147-153`）要 `crypto.getRandomValues`，expo-crypto 提供同步 `getRandomValues`/`getRandomBytes`。首选纯 JS 同步 digest + expo-crypto 的 randomUUID 与 getRandomValues（决策 d2）；超阈转向分支见判据 20。
- **C. drizzle 出口 ② 的 patch 实现（v4 冻结，E7+E8）**：`pnpm patch` 定向改 `drizzle-orm/expo-sqlite` 的 session——桌面走 `drizzle-orm/better-sqlite3`，加载不到被 patch 文件。**实现冻结为**：
  1. `ExpoSQLitePreparedQuery` 保存 **client + SQL（+params/fields 映射）**，不保存原生 statement；
  2. `run/get/all/values` 各自在方法内部 `prepareSync`；
  3. **完整消费**（`changes`/first/all/raw rows 全部读毕）**之后**才 `finally finalizeSync`——E8：executeSync 的 result 必须先消费，过早 finalize 是「写绿查坏」的形状；
  4. **`.d.ts` / `.d.cts` 同步修改**——「不改声明」不是目标（v3 的措辞作废）；
  5. patch 覆盖 `session.js` + `session.cjs` 双载体；ESM import / CJS require / Metro bundle **三路径各验一次**拿到 patched 版；
  6. prepare/finalize **计数测试入 spike 常跑**（pnpm 版本键控 + 计数测试双兜底）。
- **D. 卡顿夹具的两处修正**：① `runFullBackfillInTx` 对已有 `create` 的行跳过（`backfill.ts:130-134`）——夹具必须 raw 直插、不产生 outbox 行，R4 断言满工作量。② 生产 pull 批次 **500**（`SYNC_PULL_LIMIT`，`limits.ts:85`；`engine.ts:215`），1000 只作显式标注的 stress。
- **E. 音频流的真实 header 集（v4，评审 R3-P1-3）**：`openAudio()` 实际带 **User-Agent + Referer + buvid Cookie**（`bilibili.ts:145`、`:335`）——判据 19 的流探针必须先按桌面夹具输出的**全量 header 集**复现，再逐项删除定位最低要求；只写 Referer 的探针在失败时分不清「RN 能力缺失」与「探针输入不一致」。

### 1.4 N1 要处理的结构性事实（摘要）

paths 无参函数 + `process.env` 解析（FileSystem 端口连根一起端口化）；`countQuarantined()` 直连 fs（`file-ops.ts:298-302`）注入化；`login.ts:25` hostname → DeviceName 端口；runner 后果层 → EventsBus 端口；CredentialStore = `config/skybridge.ts` 五 API 面；file-ops A/B 分界干净；移动端触发模型不搬 `triggers.ts`。

### 1.5 DB API 面盘点（契约依据）

（全文见调查记录：prepare 三种绑定 / `.get()` 未命中 `undefined` / `.run()` 的 `changes`+`lastInsertRowid`（消费处均 `Number()` 包裹）/ 多语句 `.exec()` 与手动 BEGIN/COMMIT/ROLLBACK / pragma 双形态 / `.transaction()` 全 `.immediate()` 唯一例外 `file-ops.ts:481` 裸调用 / JSON1 + CAST 陷阱 / upsert·GLOB·LIKE-ESCAPE·EXISTS·group_concat·部分索引·FK 级联·AUTOINCREMENT·`||`·CASE-in-SET·`IS NOT ?`·LIMIT ?·DISTINCT / 数值恒 number 无 safeIntegers / drizzle 面 16 处 import + `sqliteOf` 共享连接。）

**要点**：
- **statement 生命周期是契约的一部分**：core 有跨行复用的 prepared handle（`scanner.ts:64-78`、`apply.ts:581-585`、`engine.ts:322-325`、`backfill.ts:130-134`）但没有显式 dispose——契约规定「实现方在无显式释放的用法下不泄漏」（§2.2）。
- **嵌套 transaction / savepoint：core 零使用，不进保证面**（决策 c2，E6）：契约不测试、不禁止；实现原生能力原样保留。未来要用先扩契约。
- 移动端 fresh 库会继承 `audio_migration_pending='1'`（`0003-audio-m4a.ts:72-73`；桌面由 `db/index.ts:89-100` 的 brandNew 分支清）——移动 bootstrap 必须有对应动作（判据 15 + N2 判据；`migration/pending.ts` 随 N0a 入 portable，决策 j）。

---

## §2 N0a 详案：最小可移植边界（桌面仓内，零行为变化）

### 2.1 物理布局（决策 c1 + i + j）

纯文件**搬进** `packages/core/src/portable/`、`db/`/`migration/` 反向 import（守卫可 rg 是硬理由；不留旧路径垫片）。`git mv` 保历史：

```
packages/core/src/portable/
├── index.ts                 # barrel（新增）
├── sqlite.ts                # SqliteLike 系列接口（新增，见 2.2）
├── errors.ts                # ← errors.ts 三类整体移入：SchemaMismatchError /
│                            #   ForwardMigrationError / DestructiveForwardMigrationError；
│                            #   原 src/errors.ts re-export——daemon/CLI 的 err.name 与
│                            #   instanceof 两种消费都不受影响（同一个类对象）
├── schema.ts                # ← db/schema.ts
├── migrate.ts               # ← db/migrate.ts（类型锚点换 SqliteLike；errors 改 ./errors.js）
├── schema-signature.ts      # ← db/schema-signature.ts（同上）
├── pending.ts               # ← migration/pending.ts（纯；移动 bootstrap 的 fresh 清除调真实现）
├── migrations/              # ← db/migrations/（0001/0002/0003 + index，IMMUTABLE 头不动）
└── contract/
    ├── index.ts             # runDatabaseContract（新增，见 2.3）
    └── cases/…              # 契约用例，按 §1.5 分组
```

- core 内消费者改 import 路径；exports 增 `"./portable"`（单次 `tsc` 顺带 emit）。
- registry 仍手写数组不扫目录（Metro 没有 readdir，这条理由在移动端更硬）。

### 2.2 `SqliteLike` 接口与 statement 生命周期模型

- 接口按 §1.5 实际使用面：`prepare(sql)` → `{ get/all/run }`、`exec(sql)` 多语句、`pragma(sql, opts?)` 双形态、`transaction(fn)` → `{ immediate(...) }` + 可直接调用、`close()`。`lastInsertRowid: number | bigint`。
- **生命周期契约（冻结进接口 doc 注释）**：`prepare()` 返回的 handle 不承诺持有原生 statement；调用方没有 dispose 义务。因此：
  - better-sqlite3 侧：原生行为即满足。
  - **expo-sqlite shim 侧 = per-call transient**：handle 只持 SQL 文本，每次 `get/all/run` 走 `prepareSync → bind → execute → 完整消费 → finally finalizeSync`；异常路径在 `finally` 释放。跨行复用的 handle 语义不变、每次重 prepare，性能由判据 18/R5 计量。长期持有原生 statement 的模型被排除。
  - **shim 自带测试计数钩子**：构造时可注入 `counters`（prepare/finalize 各一），契约生命周期组的硬判据建在它上面——「内存归零」不可判定，**确定性计数才是**。
- **嵌套/savepoint 不进保证面**（决策 c2）：接口注释写明「core 零使用；契约不测不禁；实现可自带能力；要用先扩契约」。
- `migrate.ts`/`schema-signature.ts` 类型锚点换 `SqliteLike`；`db/index.ts` 旁放 `satisfies` 断言。

### 2.3 DatabaseContract harness（决策 h）

- **签名**——行为回调式，runner 里没有 `unknown` 强转，能表达「重开同一物理库」：
  ```ts
  interface ContractDatabase {
    sqlite: SqliteLike;
    reopen(): SqliteLike;   // 关闭当前连接后，重开同一物理库（锁/残留 statement 测试的前提）
    cleanup(): void;        // 删除物理文件
    counters?: { prepared(): number; finalized(): number };  // shim 提供；缺省时计数组显式 skipped
  }
  interface DrizzleContractDatabase extends ContractDatabase {
    insertSongViaDrizzle(row: ContractSongRow): void;                      // 经 drizzle 写入
    inDrizzleTransaction(assertWithRaw: (sqlite: SqliteLike) => void): void; // drizzle 事务内跑 raw 断言
  }
  interface ContractHooks {
    open(): ContractDatabase;               // 每用例一个 fresh **文件库**；:memory: 禁用——
                                            // reopen 出来的内存库是另一个新库，锁与残留测试必然假绿
    drizzle?: () => DrizzleContractDatabase;
  }
  runDatabaseContract(hooks: ContractHooks, report: ContractReport): void
  ```
  纯函数、零 vitest、零 Node（文件路径由 hook 封装——桌面包壳用 mkdtemp 临时文件库，spike 用 app 目录文件库）。缺 hook / 缺 counters 的组在 report 里显式 skipped，不静默。
- 用例分组 = §1.5 全清单，点名：
  - **生命周期组（硬判据 = 计数）**：成功 / 绑定错误 / 约束错误三路径各 1k 次后 `prepared === finalized`；一条写 statement 抛错后同连接立即能开新 `BEGIN IMMEDIATE`（锁释放）；同一 handle 连续执行两次、与其它 statement 交错；10k 混合调用后 `close()` 成功且 `reopen()` 后库可写。RSS 趋势为第二证据（§3.2a），不单独判红绿。
  - **共享连接组（v4 冻结操作顺序，评审 R3-P0-1——「提交后可见」只证明同一个文件，证明同一条连接必须在未提交窗口内断言）**：
    1. raw `BEGIN IMMEDIATE` → `insertSongViaDrizzle` → **raw 在同事务内看见未提交行** → raw `ROLLBACK` → raw 查无此行；
    2. `inDrizzleTransaction`：drizzle 事务内 insert → 回调里 **raw 看见未提交行** → 回调抛错令 drizzle 回滚 → 事务外 raw 查无此行。
  - migration 全链（0001→0003 + fail-closed 回滚 + `assertCurrentSchema` + REQUIRED_COLUMNS 完整性）、CAST 双断言（照 `rebase.test.ts:186-192`）、单层事务抛错回滚。
- 契约不含桌面专有面（WAL / writer·migrate 锁 / `backup` / readonly 打开 / recovery 三文件机）与嵌套/savepoint（保证面外），注释写明。

### 2.4 守卫

`scripts/check-core-portable.sh`，作用域 `packages/core/src/portable`，FORBIDDEN：
1. 全部 Node builtin（裸名 + `node:`，复用 shared 守卫 alternation）；
2. `better-sqlite3`（连 type import 一起禁）；
3. `pino|pino-roll|smol-toml|electron|@lark/daemon|@lark/gui`；
4. `drizzle-orm/better-sqlite3`（`drizzle-orm/sqlite-core` 放行）；
5. **`@lark/core` 全部自引，含子路径**：pattern `@lark/core(/[^']*)?`；
6. **越界相对 import，深度无关**：`from '(\.\./)+(db|library|download|sync|config|logger|media-tools|migration|daemon-control|testing)/` 与 `from '(\.\./)+(paths|errors|backup-nest|native-probe|index)\.js'`。新增 core 顶层目录时枚举要跟，义务写在脚本头。

justfile 加 `core-portable` recipe 进 `check:` 依赖列表。

### 2.5 N0a 判据（1–10）

1. diff 主体 = `git mv` + import 改写；`portable/` 之外无语义变更。
2. 桌面全测试绿（2419 基线）+ 六守卫绿；`just check` 含 `core-portable`。
3. errors 三类移入后：daemon 错误映射穷尽测试与 CLI 按类名匹配测试原样绿（`instanceof` 与 `err.name` 两种消费都验）。
4. `pending.ts` 移入后 `migration/` 反向 import，语义零变（既有 pending 测试绿）。
5. contract harness 在 better-sqlite3 **文件库** hook 上全绿（进 core 常跑；含 drizzle hook 的共享连接组两条顺序序列；counters 组在桌面 skipped 并如实报告）。
6. 假绿检查：migration fail-closed / CAST / 共享连接（两条序列各去掉「未提交窗口断言」确认红）各一次；**计数组的假绿反测在 N0a 用「故意漏 finalize 的 fake adapter」证 runner 会红**（真 shim 的红/绿归 N0b-2，那里复跑同一反测）——better-sqlite3 hook 没有 counters，不能用它装样子（评审 R3-P0-1）。
7. `SqliteLike` 的 `satisfies` 断言在。
8. 守卫反向测试三连：塞 `node:fs` / 塞 `../../../db/index.js`（深层越界）/ 塞 `from '@lark/core/config'`（子路径自引），`just check` 各红一次（验完撤）。
9. `./portable` 可从包外 import；CLI 守卫放行文案不加它。
10. CLAUDE.md 仓库结构段 + 依赖方向段更新。

---

## §3 N0b 详案：平台 spike（GO/NO-GO gate）

### 3.1 落点、脚手架与验证方式分类

- `spikes/mobile-foundation/`（media-protocol 先例：长期保留作 N2 参照）。Expo SDK 57 **单一精确版本**（开工当天取 57.0.x 最新、≥57.0.9，写死并记 §9）+ CNG + dev client，Android only；`expo-sqlite`/`expo-audio`/`expo-crypto`/`expo-secure-store` 配套精确版（expo-audio 复核含 #47828）；op-sqlite 仅 devDep 对照。
- **workspace 内部包白名单守卫**：只约束 `@lark/*` 与 `@orpheus-aviary/*` 的 import——允许 `@lark/core/portable`、`@lark/shared`、`@orpheus-aviary/skybridge-client`、`@orpheus-aviary/skybridge-proto`，禁其余（`@lark/core` 任何其它子路径与 barrel、`@lark/daemon`、`@lark/gui`、`skybridge-server`）；外部生态依赖（expo/react-native/drizzle 等）不在此守卫范围。spike 内一条 rg 守卫钉住。
- 不进根 tsconfig references；自带 `tsc --noEmit` recipe；Biome 照常覆盖。
- **验证方式三分类（v4，评审 R3-P2-3——「不靠人眼」只适用于第一类）**：
  - **自动断言**（判据面板 app 内）：contract harness、migrations、计数、卡顿计时、crypto 跑分、fetch 能力探测、SDK 调用。
  - **宿主脚本**（桌面 adb 驱动 + 断言）：`dumpsys meminfo` 采样、`bmgr backupnow`/restore 流程、copy-then-open 计时的外部复核、manifest/XML 检查。
  - **人工行为检查**（逐条列进 §9 的清单，人工打勾 + 拍照/录屏留证）：锁屏元数据与控制、耳机拔出、音频焦点两形态、keystore 恢复演练、分享 intent 的实际手感。

### 3.2a 测量协议（冻结；数值判据共用，评审 R2-P0-3 + R3-P2-1）

- **适用范围**：本协议只约束**性能/数值判据**（14 计数、17 泄漏、18 卡顿、20 crypto、26 copy 开销）。**行为/耐久判据**（后台 30 分钟、焦点、bmgr、恢复演练）各跑 1 次，失败才复跑定位——不要求十遍。
- **设备**：前置条件那台真机（型号 / Android 版本 / RAM 记入 §9）；数值判据绑定它，换设备 = 全部重测。
- **构建**：release variant（`expo run:android --variant release`，Hermes bytecode）。dev 构建数值只作开发参考，不算判据。
- **采样**：每项预热 3 轮丢弃 → 正式 ≥10 轮 → 报 p50/p95，判阈值用 **nearest-rank p95**；冷启动类（迁移链、copy-then-open）5 轮**直接判 max**。
- **泄漏口径**：确定性计数是硬判据（`prepared === finalized`）；RSS 趋势是第二证据——10k 调用分 10 段，宿主脚本以 `dumpsys meminfo` 的 **TOTAL PSS** 采样，首末段差 <10MB 为软口径（超了记录并分析，不单独否决）。
- **内存峰值口径（remux 兜底用）**：主口径 = 宿主脚本 1s 轮询 `dumpsys meminfo` 的 TOTAL PSS **峰值增量 ≤64MB**（JS heap 数值可得时作辅助——native/ArrayBuffer 不计入 JS heap，不能只看它）。30 分钟曲目全程；remux 实现必须流式。

### 3.2 判据（11–26；**gate 项加粗**）

**workspace 共存**
11. `pnpm install` 后 lockfile diff 审阅（新增依赖全在 spike；`pnpm.overrides` 的 vite 7.3.6 不受扰）。
12. **Metro bundle + dev client 真机起动；`@lark/core/portable` / `@lark/shared` / skybridge SDK 经 workspace 链接被 Metro 解析**。
13. **桌面回归**：`just check` + `just test` 全绿（每次依赖变动后重跑，常驻义务）。

**SQLite（D4 定案组）**
14. **expo-sqlite shim 过 contract harness 全绿**（真机文件库，per-call transient；生命周期组以 shim counters 为硬判据；**复跑判据 6 的 fake-leaky 反测证明红得出来**）。
15. **MIGRATIONS 0001→0003 真机 fresh 库跑通 + `assertCurrentSchema` 过 + fail-closed 回滚 +「fresh 清 pending」走 `portable/pending.ts` 真实现**——链后断言 `user_version=3` 且 `audio_migration_pending='0'`。
16. op-sqlite 对照：同一 harness 逐项记录。裁决：expo-sqlite 全绿则默认 expo-sqlite；expo-sqlite 红而 op-sqlite 绿的项才触发换选讨论。
17. **drizzle 三选一定案**（D4）：a) 未 patch 态泄漏实证——计数 Proxy 包装 expo-sqlite db 对象再交给 Expo driver，10k 查询后报 `prepared - finalized`；b) 按 §1.3-C **冻结实现**落 patch（client+SQL / 方法内 prepare / **完整消费后 finally finalize** / d.ts+d.cts 同步 / js+cjs 双载体 / 三路径解析验证），复验：计数归零 + **drizzle 的 `run`/`get`/`all`/`values` 四方法矩阵 × { mapped select（fields 映射路径）、空结果、异常路径 } 全绿** + 同一 prepared query 连续执行两次正确 + 桌面 `just test` 不受扰 + 计数测试入 spike 常跑；c) **fallback ③（raw-only）的绿条件（v4，评审 R3-P1-1）**：16 处 drizzle 调用点 → raw 等价写法的映射表**完整**，且最难两处（`resolve.ts:183-186` 的 upsert、`songs.ts:298-306` 的 LIKE-ESCAPE `sql``）有过测试的原型。**出口写死 §9，D4 冻结。**

**卡顿（proxy；真实代码复测归 R4/R5）**
18. **JS 卡顿 proxy gate**（按 §3.2a）：真机 shim 重放语句形状负载（显式标注 proxy）：① raw 直插 2,000 songs / 5 playlists / 10,000 sync_changes（不产生 outbox create）；② backfill 形负载 2,000 ×「读行 + INSERT sync_changes」；③ apply 形负载 **500/批**（=`SYNC_PULL_LIMIT`），另 1,000 批仅 stress。三个 UX 场景分别计量：冷启动迁移 / 登录 backfill / 前台同步一轮。**阈值（决策 e）**：前台单段 p95 ≤100ms（超则得出分批尺寸）、冷启动 2k 曲库 5 轮 max <3s；proxy 数值为暂定，R5 真实代码定稿。

**播放（D17 判定组）**
19. **raw fMP4 直存达标判定**。夹具与探针（不 import core 业务模块）：
   - 夹具：桌面脚本用 core bilibili client 取选定 AAC 流**原始字节**落文件、adb push——短曲 ~1min + **长曲 ≥35min**（后台判据要 ≥30min，夹具必须有余量；不足就循环播放并注明）。
   - 流探针（v4 修 header 集，E-1.3）：桌面夹具同时输出 `openAudio()` 的**实际全量 header 集**（User-Agent + Referer + buvid Cookie，`bilibili.ts:145,335`）与带签 URL；真机 `expo/fetch` **先完全复现该 header 集**拉流成功，**再逐项删除**定位最低要求（矩阵记 §9）——失败时才分得清 RN 能力缺失与探针输入不一致。
   - **通过条件**：duration 误差 ≤1s；seek 0%/25%/50%/95% 各偏差 ≤1s；暂停恢复不漂；后台 + 锁屏连续 ≥30min 不断（行为判据，跑 1 次）且锁屏元数据/控制可用（人工清单）；音频焦点瞬时抢占自动恢复、永久抢占停住（人工清单）；耳机拔出暂停（人工清单）；**单 player 与 playlist 两种驱动形态各测一遍**。
   - 不达标 → JS remux 候选（§3.2a 的 PSS 峰值口径）→ **原生 remux 兜底的绿条件（v4）**：真机原型跑通并**重跑本判据同一套播放通过条件**全绿——「调研」不构成出口 → 仍不行 **NO-GO**。

**移植地基**
20. crypto 端口定案（决策 d2）：按 §3.2a 跑分——WBI 短串 md5 p95 ≤5ms、256KB sha256 p95 ≤50ms、`expo-crypto.randomUUID` 与 **`getRandomValues`**（`randomBuvid3` 要用，`wbi.ts:147-153`）可用。**超阈转向分支的绿条件（v4）**：digest 改走 expo-crypto async 时，必须给出 **WBI 与 file-ops 两条真实调用图的 async 化方案**并原型过测——特别是 `discard()` 在**同步事务内**算 digest 的那处（digest 前移到事务外的方案要成立）；两个出口都拿不到绿 = 第三候选（自建 native 同步 digest module）进入讨论。
21. **Web 标准全局面清查**（§1.3-A 全清单）：真机逐项验原生有/无，产出三栏清单写回 §9（产出型：清单没产出 = 未完成）。
22. **skybridge SDK RN 判定**：Metro 解析 + **`login/refresh/pullChanges/pushChanges` 对 LAN server 走通（四项硬 gate）**；`subscribeEvents` SSE 流式读 / abort / 断网重连是软判据（触发模型轮询为主，失败记录并降级）。
23. bilibili 平台/网络探针（v4 重做，评审 R3-P1-2——spike 内做 WBI 签名必然复制 mixin/排序/过滤逻辑，违反边界原则）：
   - 免签端点（`view`/`pagelist`/`playurl`）真机裸请求；
   - **WBI 部分改「桌面三件套 fixture」**：桌面用真 core 生成 ① canonical 待哈希字符串 ② 期望 digest ③ 完整已签 URL；真机只验证 **MD5 端口对 ① 产出 ②** + **③ 的网络请求可用**——真实 WBI 算法（排序/过滤/mixin）归 **R1** 验证。
   - 移动网络与 Wi-Fi 各一遍。**两种网络都硬阻断 → NO-GO/重议**。
24. 分享 intent（平台判据）：bilibili app 分享 → spike 收到 intent、显示原始文本（人工清单 + 自动记录 intent payload）。bvid 解析用 core `link.ts` 的验证归 R2。

**发行与 D16（两个落定都是 gate）**
25. **D14 落定**：applicationId `com.orpheusaviary.lark`；keystore 生成 → 主副本入加密凭证库 + 独立加密备份（alias / 证书 SHA-256 / 密码）+ 恢复演练一次（人工清单）；versionCode 线记录；developer verification 政策 snapshot。凭证库选择归用户（决策 g）。
26. **D16 机制落定（gate，E5）**：
   - **「零写打开读 install_id」三候选按序验证定案**（决策 k）。候选 ① copy-then-open 的一致性协议：时点 = bootstrap 最前、任何 DB 连接/后台任务之前；**只复制 main DB + `-wal`，不复制 `-shm`**（SQLite 官方：shm 非内容、非恢复所需）；复制前后校验 main/WAL 的 size + mtime，变化 → 重试一次 → 仍变 fail closed；副本用毕 `finally` 删除；**开销上限：50MB 库 copy+open+读 install_id 5 轮 max ≤500ms**——超了转候选 ②/③。候选 ② 直接打开 + `PRAGMA query_only=ON`——须把 D16 契约显式改写为「打开可触发无害 journal 恢复」并交用户拍板；候选 ③ 自建 expo native module 提供 readonly 打开。
   - **no-backup 侧载体定案**（决策 l）：首选 SecureStore（Keystore 加密）承载 install_id 设备侧——**条目冻结 `requireAuthentication: false`**（认证条目在生物信息变化后失效 → 误判 D2D → 误清 binding）；卸载重装/换机读不出 = fail-closed 信号；兜底 = 自建 module 暴露 `noBackupFilesDir`。真机验证「卸载重装后读不出」。
   - **backup 排除的三层客观判据**（宿主脚本）：① merged manifest 检查（apkanalyzer/aapt：`allowBackup=false` + 两个规则属性指向我们的 XML）；② 两份 backup XML 内容断言（database/files/sharedprefs/SecureStore keychain 全在排除清单）；③ `bmgr backupnow` + restore 官方流程验证四类数据未被恢复（`adb backup` 不作主要证据）。自定义规则由我们的 CNG plugin 全量持有，关闭 expo-secure-store 插件的自动 backup 配置。完整 D2D restore 与 fail-closed 分支测试归 N2 gate（§5 N2 的四组）。

### 3.3 GO/NO-GO

- **GO = 全部判据（11–26）完成，且 gate 项全绿**。gate 项：**12、13（常驻）、14、15、17、18、19、22（基本 API 四项）、25、26**。
- **NO-GO/重议线**：19 三级兜底后仍不达标；23 双网络硬阻断；26 三候选全不可行。
- 软判据（红了记录、降级、不拦 GO）：16（对照）、22 的 SSE 半边、24（失败则降级 D13 入口形态并记录）。
- 定案/产出型（无红绿，未完成 = 不能 GO）：20（带阈值与转向分支的绿条件）、21（三栏清单）。

### 3.4 冻结输出（分两段）

- **N0b 冻结（有真机证据的子项）**：SQLite 选型 + statement 生命周期出口 + 分批暂定值 → N2；crypto 形态（或其转向分支）+ polyfill/端口三栏清单 → N1；raw 直存判定 → N4；D14 三件套 → N6；D16 机制 → N2。
- **N1 出口补冻结（业务图子项，凭 R1–R5）**：fetch 注入在真链路的充分性、端口切面完整性、卡顿阈值定稿。R 系列过完之前，D5 不做「全部冻结」的宣称。

### 3.5 N1 出口「真机业务图复验」判据组 R1–R5

N1 端口化完成后、N1 收批前，真机上用**真实 core 代码**复跑：
- **R1** bilibili client 全链（`fetchImpl = expo/fetch` + Crypto 端口）：**WBI 真实算法**（判据 23 只验了 MD5 端口与已签 URL）、buvid、`view/pagelist/playurl`、b23 `redirect:'manual'` 展开——双网络各一遍。
- **R2** `link.ts` 真机 parse：判据 24 收到的分享文本 → bvid / fid / `?p=` 各形态。
- **R3** 歌词三平台 client（fetchImpl + Base64 端口）真机一遍。
- **R4** `runFullBackfillInTx` 真机满工作量：raw 造数 2,000 首（无 create 行），断言 `result.songs === 2000`。
- **R5** `applyChangesInTx` 真实 500/批 + 卡顿阈值定稿（对判据 18 校准，分批尺寸写死，D4 卡顿子项落章）。

R 系列全绿 = D5 剩余子项冻结。**本条重排属 Stage-1 主计划修订**（§0）。

---

## §4 N0 批次划分与提交

**前置（Stage-1）**：本计划获批后、N0a-1 之前——主计划 §4.3 的两处语义修订（N0a 行 c2 收窄、N0b/N1 行 R 系列重排 + D5 分段冻结）单独 docs 提交；同一提交把 PROCESS.md 的「后续」条目转为正式 Phase B 段（批次表 + 状态，此后**每批完成随批更新 PROCESS.md**，不只写本文件 §9）。

| 批 | 内容 | 本批 gate |
|---|---|---|
| N0a-1 | portable 搬迁(含 errors/pending) + `SqliteLike` + exports + 守卫（判据 1–4、7–10） | `just check` + `just test` 绿 |
| N0a-2 | contract harness + better-sqlite3 文件库包壳 + fake-leaky 反测（判据 5–6） | core 测试绿，假绿检查记录在案 |
| N0b-1 | spike 脚手架 + 内部包白名单守卫 + workspace 共存（判据 11–13） | **12、13 绿** |
| N0b-2 | shim + harness 真机（含 fake-leaky 复跑）+ migrations/pending + op-sqlite + drizzle 定案（判据 14–17） | **14、15、17 绿**，D4 出口写定 |
| N0b-3 | 卡顿 proxy + crypto 定案 + 全局面清查（判据 18、20–21） | **18 绿** + 20 定案 + 21 清单产出 |
| N0b-4 | 播放判定 + skybridge/bilibili 探针/intent（判据 19、22–24） | **19 绿、22 基本 API 绿**，D17 判定写定 |
| N0b-5 | D14 + D16 落定 + GO/NO-GO 汇总（判据 25–26） | **25、26 绿**；§9 实施记录 + 分段冻结文本 + **Stage-2 主计划修订** |

每批**用户明确确认 commit message 后才提交**；spike 批次记录（面板截图/数值/人工清单）进 §9，批次状态同步 PROCESS.md。

---

## §5 N1–N6 框架（每批开工前出各自子计划；只钉本次新增输入）

- **N1 提取**（最大一批，子计划必含 file:line 搬迁表）：SyncCoordinator（`runtime.ts` 近原样 + `runner.ts` 后果层 EventsBus 端口化 + `triggers.ts` 拆纯逻辑/宿主件 + login·logout·refresh·session 吃 CredentialStore/DeviceName/SkybridgeApi 端口）；端口清单 = D5 原表 + Paths-root + DeviceName + EventsBus + countQuarantined 注入化 + **Crypto 含 RandomBytes**（§1.3-B）；CLI direct 薄壳化 + daemon/direct/mobile 三方 contract tests；三守卫（portable rg 扩面 + Metro bundle smoke 进 `just check` + `expo prebuild` smoke 独立 recipe）。**gate = 桌面全测试 + 三守卫绿 + 桌面行为零变化 + R1–R5 全绿**。
- **N2 数据层 + 骨架**：shim 定版接线、移动 bootstrap（fresh 建库 → 迁移链 → 清 pending——判据：`user_version=3` 且 `audio_migration_pending='0'` 且无任何桌面 mp3 迁移语义可达）、D16 全落地——**验收四组（v4，评审 R3-P1-4：合规恢复测不到 fail-closed 分支，必须造异常夹具）**：
  1. 合规 cloud/D2D restore：四类数据均未恢复；
  2. **强制半恢复 fixture**：只注入旧 DB（adb push 模拟 OEM 无视排除），SecureStore 缺失 → fail-closed；
  3. DB install_id 与 SecureStore install_id **不同** → fail-closed；
  4. **收敛过程各崩溃点**（写意图后 / 写 DB 后 / 确认前 kill）：重启均收敛、binding/credentials **只清一次**。
  另：移动端 config 宿主定案、曲库/歌单读写、四 tab 骨架。
- **N3 播放**：PlayerDriver + minibar + 全屏歌词 + 队列 + 后台/锁屏/焦点；整晚 soak；行为判据不锁 API。
- **N4 下载**：AAC 选流 + AudioLanding RN 实现（判据 19 形态）+ 添加页 + 分享 intent（R2 解析接上）+ ensure-file + 缓存管理（探活 fail-closed 不变量原样）。**TLS 死线**（D15）。
- **N5 同步**：SyncCoordinator 接线 + 徽章/冲突页/file-ops UI；前置 TLS 验收全过；与桌面双端真机 soak（登录前验库身份的教训照搬）。
- **N6 收尾**：多选批量 + 设置 + 签名 APK + developer verification go/no-go。

---

## §6 风险（主计划 §4.4 增补/更新）

| 风险 | 状态变化 / 缓解 |
|---|---|
| drizzle finalize | ① 出口已死（E1）；② patch 实现按 E8 冻结（client+SQL、完整消费后 finalize、d.ts 同步、双载体三路径、计数常驻）；③ 绿条件 = 16 处映射表 + 两处最难原型 |
| **D16 载体缺失** | N0b gate（判据 26，E5）：copy-then-open 协议 + SecureStore 无认证条目 + backup 三层客观判据；N2 四组含强制 fail-closed 夹具 |
| **N0b/N1 循环依赖** | 已解：平台 spike / R 系列两段式；WBI 探针改桌面三件套 fixture（R3-P1-2） |
| **测量不可复现** | 已解：§3.2a（release 构建 / 固定设备 / nearest-rank p95、冷启动判 max / PSS 主口径 / 协议只管性能项） |
| Hermes/RN 标准库缺口 | 判据 21 专项清查（含 Buffer 面与 base64 端口） |
| expo-audio 回归先例 | #47569 已修（E4）；钉版本 + pause-before-release + 判据 19 通过条件显式化（含 ≥35min 夹具余量） |
| crypto 同步/异步错配 | 判据 20 阈值 + 转向分支绿条件（WBI/file-ops 调用图 + discard 事务内 digest 前移） |
| 卡顿夹具假测 | 已解：raw 造数无 create 行 + 生产批 500 / stress 1000 + R4 满工作量断言 |
| bilibili 风控（移动网络） | 判据 23 平台探针（三件套 fixture）；双网络硬阻断 = NO-GO 线 |
| metro 与 pnpm | 降级：workspace 已 `node-linker=hoisted` |
| skybridge SDK 兼容 | 降级：基本 API 硬 gate（判据 22），SSE 软 |
| raw fMP4 直存 | 判据 19 三级兜底（每级都有客观绿条件），NO-GO 线 |
| Expo 进 workspace 扰动桌面 | 判据 13 常驻回归 + lockfile diff + spike 不进根 tsc references |
| 主计划/子计划双事实源 | 已解：Stage-1 修订前置于 N0a |

---

## §7 待拍板决策（a–l）

| # | 决策 | 建议 |
|---|---|---|
| a | 版本口径：桌面 Phase B 期间不发版；APK 独立 0.1.0 线 | 按建议 |
| b | spike 落点 `spikes/mobile-foundation/` | 按建议 |
| c1 | portable = 纯文件搬入、db/·migration/ 反向 import、不留垫片 | 按建议 |
| c2 | 嵌套 transaction/savepoint **不进契约保证面**——不测试、不禁止、不人为禁用；实现可自带能力；要用先扩契约。Stage-1 修主计划 §4.3 N0a 行 | 按建议 + Stage-1 修订义务 |
| d1 | drizzle 出口首选 = ② `pnpm patch`，**实现按 §1.3-C 冻结**（client+SQL / 方法内 prepare / 完整消费后 finally finalize / d.ts+d.cts 同步 / 双载体三路径 / 计数常驻）；③ 的绿条件 = 映射表 + 两处原型 | 按建议 |
| d2 | Crypto 端口（**含 RandomBytes**）：纯 JS 同步 md5/sha256 + expo-crypto randomUUID/getRandomValues；阈值 p95：md5 短串 ≤5ms、256KB sha256 ≤50ms；超阈转 async digest 分支（绿条件 = WBI/file-ops 调用图方案 + discard digest 前移原型） | 按建议，判据 20 背书 |
| e | 卡顿阈值：前台单段 p95 ≤100ms、冷启动 2k 5 轮 max <3s——proxy 暂定（判据 18），R5 真实代码定稿 | 按建议 |
| f | spike 允许 LAN 明文 HTTP（仅 spike） | 按建议 |
| g | keystore 加密凭证库选择 | **归用户**，N0b-5 前定 |
| h | harness 形态：纯函数 runner + `ContractHooks`（`ContractDatabase` 带 reopen/cleanup/counters；drizzle 行为回调；共享连接两条顺序序列；文件库强制、:memory: 禁用；缺省显式 skipped） | 按建议 |
| i | errors 落点：三类移入 `portable/errors.ts`，原 `errors.ts` re-export | 按建议 |
| j | `migration/pending.ts` 随 N0a 入 portable | 按建议 |
| k | D16「零写打开」候选优先序：copy-then-open（一致性协议 + 500ms max 上限）→ query_only（须改写契约再拍板）→ 自建 module | 按建议 |
| l | D16 no-backup 载体：SecureStore/Keystore 侧为主（`requireAuthentication: false` 冻结），自建 module 兜底 | 按建议 |

---

## §8 参考

- 主计划：`docs/plans/2026-08-13-m4a-and-mobile-master-plan.md`；**Stage-1 待修订处**：§4.3 N0a 行、N0b/N1 行
- 代码锚点：`packages/core/src/db/{index,migrate,schema,schema-signature}.ts`、`db/migrations/0003-audio-m4a.ts:72-73`、`packages/core/src/errors.ts:150,175,192`、`packages/core/src/migration/pending.ts`、`packages/core/src/sync/{engine,changes,backfill,file-ops,rebase}.ts`、`packages/core/src/download/{wbi,bilibili}.ts`（WBI 与 openAudio header 集 `bilibili.ts:145,335`）、`packages/shared/src/limits.ts:75,85`、`packages/daemon/src/sync/{runtime,triggers,login,client}.ts`、`packages/core/src/config/skybridge.ts`、`packages/core/src/paths.ts`、`node_modules/drizzle-orm/expo-sqlite/session.js:19,44,79` 与 `package.json:724`（E6/E7/E8）、`scripts/check-*.sh`、`justfile`
- skybridge SDK：`../skybridge/packages/client/src/{client,http,sse}.ts`（0.1.4）
- 外部：drizzle-orm #4519（open）、#5240；Expo SDK 57 changelog；expo/expo #47569（已修）；Expo SQLite `SQLiteOpenOptions` 与 prepared statement 生命周期（executeSync 的 result 须先消费）/ Expo FileSystem 路径 / Expo Crypto（同步 getRandomValues/getRandomBytes）/ SecureStore（认证条目随生物信息变化失效；backup 配置）文档；SQLite WAL 格式（shm 非内容文件）；Android backup 测试指南（bmgr 流程）
- 先例：`docs/plans/2026-07-31-m0-scaffold-media-spike.md`、`docs/plans/2026-08-13-m4a-unification.md`

## §9 实施记录（随批次追加）

（判据结果、测量设备档案、D4/D16/D17 定案文本、三栏 polyfill 清单、header 删减矩阵、人工行为清单、GO/NO-GO 记录与两段主计划修订提交号都落在这里——**全文只有这一处实施记录段**；批次状态另按仓库规范同步 PROCESS.md。）

### Stage-1（2026-08-17）

主计划 §4.3 两处语义修订已落（N0a 行决策 c2 收窄 · N0b/N1 行平台 spike ↔ R1–R5 与 D5 分段冻结），PROCESS.md 开 Phase B 段（批次表 + 前置条件 + 常驻义务）。此后 N0a 才开工。

### N0a-1（2026-08-17）判据 1–4、7–10

- **判据 1**：`portable/` 之外的 diff 只有三类——import 路径改写、`errors.ts` 的 re-export、`db/index.ts` 那一行 `satisfies`。逐行核过（`git diff --diff-filter=M`），零语义变更。
- **判据 2**：`just check` 全绿（六守卫，`core-portable` 已进 `check:` 依赖）；`just test` **2419**（shared 79 / core 985 / cli 417 / daemon 495 / gui 443），与 0.3.0 基线逐包相等。
- **判据 3**：三个类整体移入 `portable/errors.ts`，`errors.ts` re-export。**两种消费都验了**：daemon 的 `instanceof`（`boot.ts:168-171`）与 CLI 的 `err.name`（`direct-errors.ts`）测试原样绿，另在 Node 里实证 `core.SchemaMismatchError === portable.SchemaMismatchError`（re-export 不是重新定义，三个类都 `true`）。
- **判据 4**：`pending.ts` 移入 portable，语义零变。**`migration/` 里没有一个文件 import 过它**——消费者是 `db/index.ts`（相对路径）与 daemon/CLI（走 barrel），所以「反向 import」这一句在实现上是空的；既有 pending 测试（0003 迁移 + daemon runner 七处断言 + CLI direct）全绿。
- **判据 7**：`satisfies` 落在 `db/index.ts` 唯一创建真实 handle 的那一行（`new BetterSqlite3(dbPath) satisfies SqliteLike`）——不narrow，桌面专有面照常可用。
  - **实测：`SqliteStatement` 的绑定参数只能是 `unknown[]`**。better-sqlite3 的 `prepare` 是条件泛型（`BindParameters extends unknown[] | {}`），按约束实例化会得到 `Statement<[{}], …> | Statement<unknown[], …>` 的联合；把参数收窄成 `null|number|bigint|string|Uint8Array` 时，`{}` 与 `null` 双向都不可赋值，**`satisfies` 当场红**。窄类型在这里不是更严格而是更假：better-sqlite3 自己的签名就是 `unknown[]`，两端的坏值都是运行时错误。绑定的三种形态改写进 doc 注释。
- **判据 8**：守卫反向测试三连各红一次（`node:fs` / `../../../db/index.js` 深层越界 / `@lark/core/config` 子路径自引），撤掉后回绿。
- **判据 9**：`@lark/core/portable` 从包外 import 成功（在 `packages/daemon` 下实跑），15 个导出齐全、`MIGRATIONS = 1,2,3`。**CLI 守卫的放行文案没加它**——CLI 不需要 portable。
- **判据 10**：CLAUDE.md 仓库结构段加 `src/portable/`，依赖方向段改「五条守卫」并写明 portable 是 core 内部的一层（core 反向 import 它，它不许 import 任何 core）。
- **测试文件跟着主体走，并被守卫排除**（与 shared 守卫同一形态，理由写进脚本头）：它们跑在桌面运行时，合法地用 `node:fs` / better-sqlite3 / `createDatabase` 造夹具，而发到手机上的是从 `portable/index.ts` 可达的模块图，没有任何测试在里面。**契约 cases 不是测试**（N0a-2 的纯函数），照常受守卫约束。

## §10 评审修订对照

### 一轮（v1 → v2）

| 评审项 | 落点 |
|---|---|
| P0-1 portable 过不了自己的守卫（errors 依赖） | `portable/errors.ts` + 决策 i + 判据 3 |
| P0-2 N0b/N1 循环 | §0 边界原则 + 平台 spike 重排 + §3.5 R1–R5 + §3.4 分段冻结 |
| P0-3 raw shim 生命周期未定义 / patch 破坏可复用 prepare | §2.2 per-call transient + patch per-execution 语义 + 判据 14/17 生命周期组 |
| P0-4 D16 两能力未证明、判据非 gate | E5 + 判据 26 升 gate + 决策 k/l |
| P1-1 GO 条件被错误收窄 | §3.3 重定 + D5 分段冻结 |
| P1-2 backfill 假测 + 批次尺寸 | §1.3-D + 判据 18 夹具重做 + R4/R5 |
| P1-3 偷改主计划语义两处 | c2 修订义务；判据 19 恢复单 player vs playlist |
| P1-4 全局面漏 Buffer/base64 | §1.3-A 补三项 + 判据 21 |
| P1-5 fresh 库继承 pending=1 | 决策 j + 判据 15 + N2 判据 |
| P2 守卫洞/签名/段号/HEAD | `(\.\./)+`、ContractHooks、§9 统一、HEAD `3451347` |

### 二轮（v2 → v3）

| 评审项 | 落点 |
|---|---|
| P0-1 「嵌套即抛」与实现/主计划冲突（E6） | 最小方案：嵌套/savepoint 不进保证面（c2 v3、Stage-1 修主计划） |
| P0-2 ContractHooks 表达力不足 | `ContractDatabase`（reopen/cleanup/counters）+ 行为回调 + 文件库强制 |
| P0-3 硬 gate 无测量协议 | §3.2a（固定设备/release/预热+p95/确定性计数） |
| P1-1 主计划修订时点矛盾 | Stage-1/Stage-2 两段 |
| P1-2 patch 范围不完整（E7） | 双载体 + 三路径验证 + 计数常驻 |
| P1-3 copy-then-open 缺协议 | 判据 26 一致性协议 + 500ms 上限 |
| P1-4 GO 与批次 gate 不对齐 | 判据 12 升 gate、20 带转向、批次表逐批列硬 gate |
| P1-5 backup 验收主观 | 三层客观判据（manifest/XML/bmgr） |
| P2 守卫子路径洞 / spike 白名单误伤 / SecureStore 认证 / 文字级 | `@lark/core(/.*)?` 全禁；「workspace 内部包白名单」；`requireAuthentication:false`；单一精确版本/提交措辞/PROCESS.md 义务 |

### 三轮（v3 → v4）

| 评审项 | 落点 |
|---|---|
| P0-1 共享连接可能假绿（提交后可见只证同文件）；判据 6 counters 反测时点错位 | §2.3 冻结两条顺序序列（raw BEGIN→drizzle 写→未提交窗口断言→ROLLBACK；drizzle 事务→raw 断言→抛错回滚）；N0a 用 fake-leaky adapter 证 runner 会红，真 shim 红/绿归 N0b-2（判据 6/14） |
| P0-2 「不改类型面」的 patch 会写绿查坏（E8：executeSync result 须先消费；session.js:79） | §1.3-C 实现冻结：client+SQL、方法内 prepare、**完整消费后 finally finalize**、d.ts/d.cts 同步改；判据 17 增 run/get/all/values × mapped select/空结果/异常路径矩阵 |
| P1-1 三个 fallback 无绿条件 | 判据 17c（16 处映射表 + 两处最难原型）、判据 19（原生 remux 原型必须重跑同套播放判据）、判据 20（async 化调用图 + discard 事务内 digest 前移原型） |
| P1-2 WBI 探针违反「不复制 core」 | 判据 23 改桌面三件套 fixture（canonical 串/期望 digest/已签 URL），移动只验 MD5 端口 + 网络；WBI 算法归 R1 |
| P1-3 流探针 header 集与 core 不一致 | E-1.3 + 判据 19：桌面输出 UA+Referer+buvid Cookie 全量集，先复现再逐项删除成矩阵 |
| P1-4 D16 的 N2 验收测不到 fail-closed 分支 | §5 N2 四组：合规恢复 / 强制半恢复夹具 / ID 失配 / 收敛崩溃点矩阵（只清一次） |
| P2-1 测量协议歧义 | §3.2a：nearest-rank p95、冷启动判 max、PSS 主口径（dumpsys meminfo）+ JS heap 辅助、删「与设备档位无关」过强表述、协议只约束性能项 |
| P2-2 Crypto 端口漏随机字节 | §1.3-B/决策 d2/判据 20/N1 端口清单：RandomBytes（getRandomValues）入端口 |
| P2-3 文字级三处 | 头部改「方向不变 + 两处显式语义修订」；§3.1 验证方式三分类（自动/宿主脚本/人工清单）；长曲夹具 ≥35min |
