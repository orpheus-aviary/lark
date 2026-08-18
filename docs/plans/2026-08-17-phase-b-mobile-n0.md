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
   - 夹具：桌面脚本用 core bilibili client 取选定 AAC 流**原始字节**落文件、adb push——短曲 ~1min + **长曲 ≥35min**（长曲留着不是为了后台时长——那条已缩到 5min，见下——而是 seek 偏差与 duration 误差要在一个长文件上才有意义，且 §3.2a 的 remux 内存峰值口径按 30 分钟曲目全程算；不足就循环播放并注明）。
   - 流探针（v4 修 header 集，E-1.3）：桌面夹具同时输出 `openAudio()` 的**实际全量 header 集**（User-Agent + Referer + buvid Cookie，`bilibili.ts:145,335`）与带签 URL；真机 `expo/fetch` **先完全复现该 header 集**拉流成功，**再逐项删除**定位最低要求（矩阵记 §9）——失败时才分得清 RN 能力缺失与探针输入不一致。
   - **通过条件**：duration 误差 ≤1s；seek 0%/25%/50%/95% 各偏差 ≤1s；暂停恢复不漂；后台 + 锁屏连续 **≥5min** 不断（行为判据，跑 1 次）且锁屏元数据/控制可用（人工清单）；音频焦点瞬时抢占自动恢复、永久抢占停住（人工清单）；**蓝牙耳机断连**暂停（人工清单）；**单 player 与 playlist 两种驱动形态各测一遍**。
   - **两处口径修订（2026-08-17，用户决定）与它们的代价**：
     - 后台时长 **30min → 5min**。5 分钟到不了 vivo OriginOS 收后台的时间尺度（§9 设备档案里那条风险原样成立），所以这条从此**只证明「不是一开始就断」**，不构成耐久证据；真正的耐久证据是 **N3 的整晚 soak**，它因此从「顺带做」升为必须做。
     - 耳机拔出 → **蓝牙断连**。测量设备没有耳机孔。两者在 Android 上不是同一条路径（有线走 `ACTION_AUDIO_BECOMING_NOISY`，蓝牙 A2DP 断开也发同一个广播，但还叠加设备路由变更），所以这条**只覆盖蓝牙**；有线拔出未验，N3 若要声称覆盖需另找设备。
   - 不达标 → JS remux 候选（§3.2a 的 PSS 峰值口径）→ **原生 remux 兜底的绿条件（v4）**：真机原型跑通并**重跑本判据同一套播放通过条件**全绿——「调研」不构成出口 → 仍不行 **NO-GO**。

**移植地基**
20. crypto 端口定案（决策 d2）：按 §3.2a 跑分——WBI 短串 md5 p95 ≤5ms、**真实歌词尺寸（≤8KB）sha256 p95 ≤10ms**、`expo-crypto.randomUUID` 与 **`getRandomValues`**（`randomBuvid3` 要用，`wbi.ts:147-153`）可用。
   - **阈值口径修订（2026-08-17，用户拍板，出口 C）**：原文是「256KB sha256 p95 ≤50ms」，实测 **83.66ms**——纯 JS 同步 digest 在这个尺寸上过不去。改绑**真实尺寸**的理由是调用图：`inlineDigest`（`file-ops.ts:337-343`）唯一的大输入来自内联歌词，真实 LRC 是 5.7KB（**1.83ms**），256KB 是 `SYNC_FILE_OP_INLINE_MAX` 这个**上限**而不是常态。**256KB 仍然测、仍然记录，但作为标注的最坏值而非阈值**——它的代价是明确的：用户真把一首 256KB 歌词卡在待办里、又去开 file-ops 列表时，每行 83ms（`listFileOps` 每行算一次）。同步端口因此保持全同步，core 不改。**超阈转向分支的绿条件（v4）**：digest 改走 expo-crypto async 时，必须给出 **WBI 与 file-ops 两条真实调用图的 async 化方案**并原型过测——特别是 `discard()` 在**同步事务内**算 digest 的那处（digest 前移到事务外的方案要成立）；两个出口都拿不到绿 = 第三候选（自建 native 同步 digest module）进入讨论。
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
- **N4 下载**：AAC 选流 + AudioLanding RN 实现（判据 19 形态）+ 添加页 + 分享 intent（R2 解析接上）+ ensure-file + 缓存管理（探活 fail-closed 不变量原样）+ **歌单导出 → 系统分享面板**（2026-08-17 主计划 §4.5 修订：cache 目录 + `expo-sharing`，不碰 SAF；与分享 intent 的接收侧同一片原生区域）。**TLS 死线**（D15）。
- **N5 同步**：SyncCoordinator 接线 + 徽章/冲突页/file-ops UI；前置 TLS 验收全过；与桌面双端真机 soak（登录前验库身份的教训照搬）。
- **N6 收尾**：多选批量 + 设置 + **歌单导入（桌面导出的去 id 文件）** + 签名 APK + developer verification go/no-go。
  - 导入这条 2026-08-17 才进 v1（主计划 §4.5 修订），**必须排在 N4 之后**：没有下载链路，导入进来的是一库点不响的行。子计划要单列一节，因为成本在预览/提交 UI（suspects 逐条合并、整文件 SHA-256 咬合、提交重跑匹配），不在文件 IO；同时评估 §9 N0b-3 留下的「出口 B」——2MB 的上限文件按实测 ~3MB/s 要一来一回约 1.3s。

---

## §6 风险（主计划 §4.4 增补/更新）

| 风险 | 状态变化 / 缓解 |
|---|---|
| drizzle finalize | ① 出口已死（E1）；② patch 实现按 E8 冻结（client+SQL、完整消费后 finalize、d.ts 同步、双载体三路径、计数常驻）；③ 绿条件 = 16 处映射表 + 两处最难原型 |
| **D16 载体缺失** | N0b gate（判据 26，E5）：copy-then-open 协议 + SecureStore 无认证条目 + backup 三层客观判据；N2 四组含强制 fail-closed 夹具 |
| **N0b/N1 循环依赖** | 已解：平台 spike / R 系列两段式；WBI 探针改桌面三件套 fixture（R3-P1-2） |
| **测量不可复现** | 已解：§3.2a（release 构建 / 固定设备 / nearest-rank p95、冷启动判 max / PSS 主口径 / 协议只管性能项） |
| Hermes/RN 标准库缺口 | 判据 21 专项清查（含 Buffer 面与 base64 端口） |
| expo-audio 回归先例 | **E4 作废（N0b-1 查 CHANGELOG、N0b-4b 真机确证）**：#47828 未进任何已发布的 SDK 57 版本，57.0.3 上 `release()` 不先 `pause()` 仍会留下停不掉的音轨。pause-before-release 从习惯升为**硬要求**，N3 的每条销毁路径都要走它 |
| **蓝牙断连不暂停**（N0b-4b 新增） | media3 的 `handleAudioBecomingNoisy` 默认关、expo-audio 未暴露、RN 侧无该事件 → N3 要打补丁或自建小原生模块；不修的表现是「摘下耳机，歌从外放响出来」 |
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

### 冻结测量设备与宿主工具链（2026-08-17，N0b 前置）

**设备**（§3.2a 的冻结设备，换机 = 数值判据 14/17/18/20/26 全部重测）：

| 项 | 值 |
|---|---|
| 型号 | vivo **V2408A**（`ro.product.name` = PD2408） |
| 系统 | Android **15**，API level **35**，`PD2408_A_15.0.22.7.W10.V000L1`，安全补丁 2025-02-01 |
| SoC / ABI | **SM8750**（Snapdragon 8 Elite）· **arm64-v8a 单 ABI** |
| RAM | 15,479,660 kB ≈ **14.8 GiB** |
| 存储 | `/data` 933G，可用 681G |
| 屏幕 | 1080×2376，density 480（override 528） |
| backup transports | `localtransport/.LocalTransport` · gms `D2dTransport` · gms `BackupTransportService`（当前生效） |

**三条随档案确定的事**：

1. **API 35 ≥ 12 → 走 `dataExtractionRules`**（判据 26）。`fullBackupContent`（≤11 的老路）在这台机器上**跑不到**，只能做 manifest 静态检查——判据 26 的三层客观判据里，②（两份 XML 内容断言）与①（manifest 属性）覆盖它，③（`bmgr` 实跑）只证明新路。这个缺口要在 §9 如实记，不能宣称两套规则都验过。
2. **`LocalTransport` 与 `D2dTransport` 都在**：判据 26 的 `bmgr backupnow` + restore 可以走 local transport（不需要 Google 账号），而 **D2D 那条 N2 要用的 transport 这台机器也有**——D16 的完整 D2D restore 验收不必再找第二台设备。
3. **它是旗舰**（8 Elite / 15 GB）。§3.2a 的阈值（前台单段 p95 ≤100ms、冷启动 2k 五轮 max <3s）在这台机器上**过了不等于中低端过**——三轮评审已经删掉「与设备档位无关」那句过强表述，这里再钉一次：判据 18/R5 的数值**只绑定这台设备**，是下限证据不是普适结论。

**编译目标与设备的差**：compileSdk/target **36**（Android 16），设备是 **35**。targetSdk 36 的包在 35 上正常运行，但**任何按设备 API level 分支的 Android 16 行为在这台机器上到不了**——N0 不依赖这类行为；将来若有，要单独说明。

**⚠️ vivo 的后台策略是判据 19 的具体风险**：OriginOS 会杀后台进程。判据 19 的后台时长已按用户决定缩到 **≥5min**（§3.2 有修订记录），而 5 分钟**到不了** OriginOS 动手的尺度——所以这条风险没有被这次测试消掉，只是被推到了 N3 的整晚 soak。开工前仍要把 spike app 加进电池白名单，并且**这不是测试环境的将就**：真实 vivo 用户会撞上同一件事。

**⚠️ 这台机器没有耳机孔**：判据 19 的「耳机拔出暂停」因此改为**蓝牙耳机断连**（同上，§3.2 有记录）。有线路径在本设备上不可测。

**宿主工具链**（2026-08-17 装定）：`adb` 37.0.1（platform-tools 37.0.1）· `platforms;android-36` · `build-tools;36.0.0` · JDK **Temurin 17.0.20**（`/Library/Java/JavaVirtualMachines/temurin-17.jdk`，**不设全局 `JAVA_HOME`**——本机默认仍是 OpenJDK 25，17 只在 spike 的 just recipe 里生效）· `ANDROID_HOME=/opt/homebrew/share/android-commandlinetools`。首次构建时 Gradle 自动补装：**Gradle 9.3.1 · NDK 27.1.12297006**（RN 0.86 钉版；另拉了 27.0.12077973）· **CMake 3.22.1** · build-tools 35.0.0 · Kotlin 2.1.20 / KSP 2.1.20-2.0.1。LAN skybridge server 走兄弟仓 `../skybridge/packages/server/dist/src/index.js`（已在）。

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

### N0a-2（2026-08-17）判据 5–6

落点：`portable/contract/{index,types,assert}.ts` + `contract/cases/{support,api,transactions,sql,migrations,lifecycle,shared-connection,index}.ts`；桌面包壳 `packages/core/src/db/contract.test.ts`（better-sqlite3 文件库 + drizzle hook + 两个计数 adapter）。**52 个用例、6 组**，core 测试 985 → **1046**（+61），全仓 **2480**。

- **判据 5**：better-sqlite3 文件库 hook 上全绿。drizzle hook 的共享连接组两条顺序序列都跑（不是 skip）；counters 组 4 条在桌面 **skipped 并带原因**（`prepare/finalize`），包壳里有断言逼它「skip 必须说明理由」且「skip 的只能是 lifecycle」。
- **判据 6 假绿反测四组**，每组都实跑：
  1. **counters 组（fake adapter）**：同一个 per-call-transient 假实现，诚实版（`finally` 里释放）4/4 绿；漏版（只在成功路径释放）**恰好红在两条错误路径**（bind error / constraint error），成功路径两条仍绿——这正是「会发出去的那种 bug」的形状。真 shim 的红/绿归 N0b-2。
  2. **CAST**：把用例自己 SQL 里的 `CAST(? AS INTEGER)` 去掉 → 红在 `CAST keeps it an integer`。
  3. **migration fail-closed**：**第一种破法没红，记下来**——把 `PRAGMA user_version` 挪到 `COMMIT` 之后仍然 61/61 绿，因为迁移 SQL 抛错时根本走不到 COMMIT，「提交顺序」不崩溃就观测不到。换两种真能证伪的：去掉事务（不回滚）→ 多条红，含「the half-applied table is gone」；把版本戳提到 DDL 之前且在事务外 → 红在「stopped at the last good version」。**用例真正钉住的是「失败要回滚」与「版本戳不许跑在 DDL 前面」**，措辞已按这个改。
  4. **共享连接（P0-1 的实证）**：把 drizzle 换到**第二条连接**上 → 两条序列都红（序列 1 是 `database is locked`，序列 2 是断言）。再把两处「未提交窗口断言」删掉重跑 → **序列 2 当场变绿**。三轮评审说的假绿是真的存在的：序列 2 的保护**全部**来自那一条未提交窗口断言，而序列 1 是被锁本身挡下的。
- **实测：FK 默认值是宿主差异，不能进契约**。用例原本断言 `foreign_keys` 默认 0，实跑 better-sqlite3 报 1——它开连接时自己就打开了，而 SQLite 与 expo-sqlite 的默认是关。改成只断言「显式 `foreign_keys = ON` 之后强制与级联都对」，并在注释里写明默认值属于宿主便利、core 依赖的是 `db/index.ts` 里那句**按连接**设置。
- **实测：契约用例不许假设空表**。GLOB 用例原本数整张 `local_metadata`，而迁移链自己会往里写（0003 的 `audio_migration_pending`）——夹具只能数自己写的那几行。
- **守卫的越界规则改成「按深度计数」**（**与 §2.4 的偏离，理由如下**）：原方案 `(\.\./)+(db|library|…)/` 在 portable 长出子目录后就分不清了——从 `contract/cases/` 看，合法的 `../../errors.js`（portable 自己的）与越界的 `../../../errors.js`（core 的）是同一个 pattern。改成「`../` 的个数 > 文件在 portable 下的深度 = 越界」，精确、且**捕获到任何位置的逃逸**，顺带删掉了「core 新增顶层目录要来改这个脚本」那条维护义务。反测：`migrations/probe.ts` 里的 `../../db/index.js` 红、`cases/probe.ts` 里的 `../../errors.js` 绿、`../../../errors.js` 红。

### N0b-1（2026-08-17）判据 11–13

落点 `spikes/mobile-foundation/`（10 个 tracked 文件；`android/` 是 CNG 产物，不进仓）+ 守卫 `scripts/check-spike-mobile-imports.sh`（进 `just check`）+ 四条 just recipe。

**版本冻结**（E3：开工当天取 57.0.x 最新且 ≥57.0.9）：

| | |
|---|---|
| expo | **57.0.13**（57.0.x 最新） |
| react-native | **0.86.2** —— 取自 `expo@57.0.13` 的 `bundledNativeModules.json`，**不是** npm 上的 latest（0.87.0） |
| react / react-dom / @types/react | **19.2.4 / 19.2.4 / 19.2.18**——**故意与 gui 逐字节相同**，hoisted 之后全仓只有一份副本 |
| expo-sqlite / expo-audio / expo-crypto / expo-secure-store | 57.0.1 / **57.0.3** / 57.0.1 / 57.0.1 |
| expo-dev-client / expo-build-properties / expo-constants / expo-status-bar | 57.0.12 / 57.0.11 / 57.0.11 / 57.0.1 |
| op-sqlite（仅对照，devDep） | 18.0.0 |

**prebuild 实测值**：minSdk **24**（Expo 57 默认，`ExpoRootProjectPlugin.kt:53` 的 fallback，构建日志也打印了）· compileSdk/targetSdk **36** · buildTools 36.0.0 · newArch + Hermes 开 · applicationId **`com.orpheusaviary.lark.spike`**（**没有**占用 D14 的 `com.orpheusaviary.lark`——spike 若戴着产品 id，第一次装真包就会继承它的 data 目录，连同 D16 实验留下的半成品 SecureStore 条目）。

- **判据 11 绿**：lockfile 只多一个 importer（`spikes/mobile-foundation`），新增 341 个包。逐包核过：**既有解析零删除、零替换**——30 处看似 drift 的全部是「新增一个并存版本，原版本仍在」（`debug` / `commander` / `glob` 一类的传递依赖）。`overrides: vite 7.3.6` 原样。react / react-dom / @types/react / typescript / @types/node **各只有一份 hoisted 副本**，版本与 gui 逐一相同。
- **判据 12 绿（gate）**：`BUILD SUCCESSFUL in 23m 51s`（首次，含自动补装 NDK/CMake）→ 装 `app-debug.apk` → **`Android Bundled 2300ms spikes/mobile-foundation/index.ts (868 modules)`** → 真机渲染三行探针，值与桌面逐一相同：`@lark/core/portable` **schema v3 · migrations 1→2→3 · 12 tables** · `@lark/shared` **local api v6 · isUuidV4 true** · `@orpheus-aviary/skybridge-client` **client 0.1.4**。logcat 无 RN 错误。截图留在 `.runtime/n0b1-boot.png`（gitignored）。
  - 判据要的是「Metro 解析了这三个包」，所以探针**用**它们算出值再显示——解析不到就是 bundling 失败，比屏幕上一个错数字响亮得多。
- **判据 13 绿（常驻）**：装 Expo 前后 `just check` + `just test` 各跑一遍，**2480** 逐包相等；`android/` 生成之后再跑一次，仍绿。
- **守卫反测三连**：`@lark/core`（barrel）/ `@lark/daemon` / `@orpheus-aviary/skybridge-server` 各拦一次，撤掉回绿。守卫**只约束 `@lark/*` 与 `@orpheus-aviary/*`**，Expo/RN 生态不在其范围（设计如此）。
- **操作规则（踩过一次）**：dev menu 用**一次** BACK 关闭，**两次会退出 app**——第二次截屏因此拍到了手机上正在前台的别的应用。凡 `screencap` 之前先确认 spike 在前台（`adb shell pidof` 不够，它在后台也有 pid）。

**⚠️ 与 E4 冲突的实测**：E4 记「expo-audio 的 release-后仍在播（#47569）已由 PR #47828 修复」。实查 **expo-audio 57.0.3（2026-07-22）是 SDK 57 线最新的稳定版，其 CHANGELOG 里既无 #47828 也无 #47569，且不存在 57.0.4+**。也就是说该修复**未进入任何已发布的 SDK 57 版本**。后果：判据 19 里「pause-before-release」从习惯提为**硬要求**，并显式增加一条「`release()` 之后必须真的没有声音」的行为断言；§6 风险表那一行随 N0b-4 一并改写。

### N0b-2（2026-08-17，进行中）判据 14、15、17a

落点：`src/sqlite/{shim,hooks}.ts`（expo-sqlite 的 `SqliteLike`，per-call transient）+ `src/panels/{contract,bootstrap,drizzle-lifecycle}.ts` + 面板按钮。真机 vivo V2408A / Android 15，debug 构建（数值判据仍待 release 构建，§3.2a）。

- **判据 14 绿**：契约 **56 passed / 0 failed / 0 skipped / 3276ms**（桌面 skip 的 4 条 counters 用例在真机上全跑）。**fake-leaky 反测同机复跑**：漏版 shim（错误路径上跳过释放）**恰好红在两条错误路径**（54/2），与桌面 criterion 6 的形状一致。
- **判据 15 绿（6/6）**：`user_version 0` → 链 0001→0003 → `user_version 3` → `assertCurrentSchema` 过 → 0003 留下 `audio_migration_pending='1'` → **`clearAudioMigrationPending` 真实现**清成 `'0'`（行保留不删）→ reopen 后仍是 v3 且 not pending。
- **判据 17a 实证（D4 的输入）**：counting Proxy 夹在 drizzle 与真库之间，10,000 次 `db.select().from(songs).all()` → **prepared 10000 / finalized 0 / leaked 10000 / 4563ms**。#4519 属实，出口①不存在。

**四条实测锁定**（每条都是先红后修）：

1. **命名参数的方言不同，shim 必须翻译**：core 写 better-sqlite3 的形（SQL 里 `@object_key`，对象里**裸键**），expo-sqlite 要求键**自带 sigil**（`{ $value: … }`）。不翻译的话 `migration/scanner.ts` 那种全命名参数的写入在 Android 上全废。sigil 从 SQL 里读而不是猜（`@`/`:`/`$` 都合法）。
2. **翻译前必须剥掉单引号字面量**：`json_extract(payload, '$.updated_at_ms')` 会被扫成一个叫 `updated_at_ms` 的参数——而 `sync/rebase.ts` 通篇都是这个形状。
3. 🔴 **`finalizeSync()` 在执行失败后会抛，抛的是那条语句自己的错**：实测 `Call to function 'NativeStatement.finalizeSync' has been rejected. → Caused by: Error code : UNIQUE constraint failed: songs.id`。这是 `sqlite3_finalize()` 的文档行为——返回最近一次求值的错误码，**但无论如何都销毁语句**。所以它不是泄漏，是把正在传播的错又报了一遍；让它从 `finally` 逃出去，调用方看到的就会是关于 finalizeSync 的话而不是约束冲突。shim 因此**只在 execute 已经失败时**吞掉 finalize 的异常并照常计数；execute 成功后 finalize 还抛，属于没人解释过的情况，原样抛出。**判据 17b 的 patch 有完全相同的陷阱。**
4. 🔴 **`json_set` 绑定数字的存储类型是宿主差异**：同样的 SQL、同样的 JS number，better-sqlite3 存成 `real`，**expo-sqlite 存成 `integer`**。契约第一版断言 `'real'`，在 Android 上当场红——这跟 FK 默认值是同一种病（把一家的行为当契约）。已改成断言 core 真正依赖的东西：CAST 形**永远**是 integer，未 CAST 形只要求仍是数值，而 `rebase.ts` 的 `IN ('integer','real')` 门**两行都找得到且值不变**。**那道门原本是防御性的，现在它在第二个宿主上是必需的。**

**两条操作教训**：① spike 经 **dist** 消费 `@lark/core/portable`，改了 core 源码不 `pnpm --filter @lark/core build` 就重载，真机跑的还是旧用例（与 M2 的「`just test-*` 一律前置 build」同一条）；② `finally` 里不许写 `return`——它会吞掉正在传播的异常，那样漏版 shim 的反测量到的是「不抛了」而不是「不释放了」。

### N0b-2 续（2026-08-17）判据 16、17b/c 与 **D4 出口冻结**

- **判据 17b 绿**：`patches/drizzle-orm@0.38.4.patch` 按 §1.3-C 冻结的实现落地——`ExpoSQLitePreparedQuery` 存 **client + SQL**（不存 statement）· `run/get/all/values` 各自方法内 `prepareSync` · **完整消费后 `finally` 释放** · `session.js` + `session.cjs` 双载体 · `session.d.ts` + `session.d.cts` 同步（`private stmt` → `private client`，构造签名换 `SQLiteDatabase`，不再 import `SQLiteStatement`）。
  - **解析路径**：ESM `import.meta.resolve` 与 CJS `require.resolve` 落到的 `index.js` / `index.cjs` 旁的 session 文件都是 patched；全仓只有一份副本（hoisted），无未打补丁的残留。Metro 那条由真机结果证明。
  - **四方法 × 三形态矩阵 9/9**（真机）：`run` 报 changes+rowid · **同一 prepared query 连续执行两次** · `all` 映射字段（走 `values()` 路径）· `all` 空结果 · `get` 映射 · `get` 空结果为 `undefined` · `values` 原始行 · **错误路径保住原始错误**（断言消息里有 `UNIQUE`，不是一句关于 finalizeSync 的话）· 失败之后库仍可用。**prepared 11 / finalized 11 / leaked 0**。
  - **10k 复探**：patch 前 `prepared 10000 / finalized 0 / leaked 10000`（4563ms）→ patch 后 **`10000 / 10000 / leaked 0`**（4002ms）。
  - **桌面不受扰**：`just check` 绿 + `just test` **2480**（桌面走 `drizzle-orm/better-sqlite3`，加载不到被 patch 的文件）。
- **判据 16（软，对照）**：同一 harness 在 op-sqlite 18.0.0 上 **50 passed / 0 failed / 6 skipped / 552ms**。skip 的 6 条是它**表达不了**的：4 条计数用例（公开同步 API 里既无 prepare 也无 finalize）+ 2 条共享连接用例（drizzle 没有 op-sqlite driver）。**时间不可比**——expo 那 3191ms 里有 13k 条语句的计数用例，op 直接跳过了。
  - **三处结构性差异**（都是 expo 不需要的 shim 工作）：① `Scalar` 无对象形态 → 只支持位置参数，命名绑定要自己把 `@name` 重写成 `?`；② `PreparedStatement.execute()` **只有异步**，同步路径只能一次性 `executeSync`，因而**无法计量生命周期**；③ **同步 API 没有多语句 exec**，迁移链要靠自建分割器——**第一版按 `;` 切，0002 的一行注释里正好有分号（「…entity tables; comparison reads NULL as ''.」），迁移全组当场红**。补上「跳过字面量与注释」的分割器之后才全绿。这正是「多一层 shim 逻辑就多一处会错」的现场演示。
  - **裁决（规则事先写定）**：expo-sqlite 56/56 全绿，**不存在「expo 红而 op 绿」的项** → 维持 expo-sqlite，不触发换选讨论。
- **判据 17c（fallback ③）未执行**，理由记在这里而不是省略：③ 的绿条件（16 处调用点映射表 + 两处最难原型）是**选择 ③ 时**才需要满足的，而 ② 已经绿。将来若 drizzle 升级导致 patch 失效，重新走 ③ 的绿条件。

#### D4 出口（冻结）

| 子项 | 结论 | 证据 |
|---|---|---|
| SQLite 选型 | **expo-sqlite 57.0.1** | 判据 14（56/56）+ 判据 16 裁决规则 |
| statement 生命周期 | **per-call transient shim**：`prepareSync → executeSync → 完整消费 → finally finalizeSync`；执行失败时 finalize 会抛（它抛的是那条语句自己的错），**只在这种情况下吞掉并照常计数** | 判据 14 + fake-leaky 反测 |
| drizzle | **出口 ②：`pnpm patch` drizzle-orm@0.38.4**，实现按 §1.3-C；①（升级到已修版）不存在，③ 不执行 | 判据 17a/17b |
| patch 的兜底 | 双重：pnpm 把补丁**键控到 `drizzle-orm@0.38.4`**（升版则补丁不适用、安装报错，不会静默失效）+ 面板里的计数断言每批复跑 | §1.3-C 第 6 条 |

**仍待 N0b-3 起**：判据 18 的卡顿数值必须跑 **release 构建**（本批全部是 debug，§3.2a 只认 release）。

### N0b-3（2026-08-17）判据 18、20–21

落点：`src/measure.ts`（§3.2a 的协议：预热/nearest-rank p95/冷启动判 max）+ `src/panels/{workload,crypto,globals}.ts` + `src/desktop-fixtures.ts`（生成物）+ 三个宿主脚本 `scripts/{probe-host,drive,make-desktop-fixtures}.mjs` + 依赖 `@noble/hashes@2.3.0` + 三条 just recipe。**全部数值取自 release 构建**，设备 vivo V2408A（§9 冻结设备）。

**先说两件让数字算数的事**：

1. 🔴 **release APK 会跑 debug bundle**。spike 的依赖里有 `expo-dev-client`，所以 `expo run:android --variant release` 装完之后**打开的是 dev-client 的 URL**（日志里那句 `Opening exp+…://expo-development-client/?url=http://…:8081`）——Metro 只要还开着，release 外壳就照常加载 Metro 的 JS，而 APK 是 release 的这件事一点也没错。分辨它只能靠 `__DEV__`（打包时烙进 bundle）：面板顶上现在印 `release bundle · Hermes · performance.now()`，`measure.ts` 的 `judge()` 在 dev bundle 上一律返回 `null`——**debug 跑出来的东西连 PASS 都渲染不出来**。本批的 release 数与同一份代码的 debug 数差 2–5 倍（apply 500：debug p50 651ms → release 164ms；sha256 256KB：169ms → 82.8ms），§3.2a 那条「debug 测的是调试器」不是修辞。
2. **卡顿夹具必须开 WAL**。第一版没设 `journal_mode`，量到的是 DELETE 模式：500 首那一段 p95 是自己 p50 的 4 倍（226 → 927ms）。核心对每个曲库都设 WAL（`db/index.ts:75-93`），照它的**顺序**补上之后（`busy_timeout`/`foreign_keys` → 读 `user_version` → WAL，M1 的「判定前零写入」），同一段变成 p50 220.88 / p95 227.13。量一个产品不会用的模式，得到的分批尺寸没人该信。

#### 判据 18（gate）：release 实测

| 场景 | 测量单位 | p50 | p95 | max | 判 |
|---|---|---|---|---|---|
| 冷启动 | 全新装：open + 0001→0003 + `assertCurrentSchema` + 清 pending | 6.24 | 19.02 | **19.02** | ✅ max < 3s |
| 冷启动 | 2,000 首库：open + 版本校验 + 首屏（读全表 + 歌单 + 成员计数） | 29.24 | 29.93 | **29.93** | ✅ max < 3s |
| 冷启动 | 同一屏改按名字排序（`Intl.Collator('zh-CN')`，2,000 行） | 40.59 | 46.16 | 46.16 | 证据 |
| 登录 backfill | 整库 2,000 首一个事务（生产形态） | 249.09 | 576.60 | 576.60 | 证据 |
| 登录 backfill | 分段 50 / 100 / 200 / **500** | 5.92 / 11.95 / 24.01 / **59.84** | 6.97 / 13.46 / 30.37 / **64.36** | — | ✅ 四档全 ≤100ms |
| 前台同步一轮 | 批 50 / 100 / **200** | 15.85 / 31.75 / **64.55** | 19.63 / 35.56 / **72.98** | — | ✅ |
| 前台同步一轮 | 批 **500**（`SYNC_PULL_LIMIT`，生产值） | 164.03 | 790.72 | 790.72 | ❌ |
| 前台同步一轮 | 批 1,000（stress，生产不可达） | 329.10 | 704.81 | 704.81 | 证据 |

**判据 18 的出口不是「过/不过」而是分批尺寸**（§3.2 原话「超则得出分批尺寸」），所以：

- **冷启动全过**，且余量是两个数量级——3s 的预算里最坏用掉 30ms。
- **backfill：一段 500 首（59.84/64.36ms）稳过**，整库 2,000 一次 249ms 也没到冻屏的程度，但它是 p95 577ms 的那一档，分段没有代价，所以移动端按 500 分段。
- **apply：生产的 500/批过不去**（p50 就 164ms），**暂定 200/批**（64.55/72.98ms）。R5 用真 `applyChangesInTx` 定稿。
- **500 与 1000 两档的 p95 是 p50 的 4–5 倍，200 及以下没有这个尾巴**。最像的解释是某次 COMMIT 撞上 WAL 自动 checkpoint（默认 1000 页），**但没有验证**——写在这里是因为它影响的是「尾巴归谁」，不影响本批的结论（200 在两种解释下都够）。

#### 判据 20：crypto 端口

| 项 | 结果 | 阈值 | 判 |
|---|---|---|---|
| md5(WBI query, 166B) | p50/p95/max **0.02ms** | p95 ≤5ms | ✅（余量 250×） |
| sha256(**5,680B** 真实歌词，多字节) | p50 1.88 / p95 **1.94** / max 1.94ms | p95 ≤10ms（**改后**） | ✅ |
| sha256(**262,145B** = `SYNC_FILE_OP_INLINE_MAX`) | p50 86.19 / p95 **86.81ms** | 不设阈值（最坏值） | 证据 |
| 正确性（md5/sha256 × WBI 串 / 多字节歌词 / 256KB） | 5/5 与桌面 `node:crypto` 逐字节相同 | — | ✅ |
| `expo-crypto.digestStringAsync` 参照 | WBI 串 **0.42ms/await**；256KB **1.86ms/await** | — | 证据 |
| `expo-crypto.randomUUID` | 1000/1000 互异、全过 `isUuidV4` | — | ✅ |
| `expo-crypto.getRandomValues` | 两次抽样互异、形状对 | — | ✅ |
| **core 现写的裸 `crypto.getRandomValues`（`wbi.ts:147-153`）** | 全局上**不存在** | — | ❌（原样搬过去就抛） |

**定案（判据 20 关闭）**：

1. **同步 digest 端口 = `@noble/hashes`**（md5 走 `legacy.js`、sha256 走 `sha2.js`），**全同步，core 的两个调用图不动**。md5 那一侧是压倒性的：0.02ms vs async 的 0.42ms，而 WBI 每个请求都签一次。
2. **随机数走 expo-crypto**（`randomUUID` / `getRandomValues`）。`wbi.ts:147-153` 的裸 `crypto.getRandomValues` 必须改走端口——评审 P2-2 把 RandomBytes 放进端口面是对的，这里是实证。
3. **sha256 的阈值改绑真实尺寸（出口 C，用户 2026-08-17 拍板）**：原文「256KB p95 ≤50ms」实测 86.81ms 过不去，但那是 `SYNC_FILE_OP_INLINE_MAX` 这个**上限**；`inlineDigest`（`file-ops.ts:337-343`）唯一的大输入是内联歌词，真实 LRC 5.7KB → 1.94ms。判据改成「真实尺寸 p95 ≤10ms」，**256KB 继续测、继续记，作为标注的最坏值**——代价是明确的：一首 256KB 歌词卡在待办里、用户又去开 file-ops 列表时，每行 86ms（`listFileOps` 每行算一次；`discard()` 同一函数但在同步事务内，`file-ops.ts:481-497`）。
   - **同一轮里，这条修订是先改代码再重测的**：阈值常量与「最坏值不判红绿」都落在 `crypto.ts` 里，然后重打 release、重跑一次，上表是改后代码产出的结果。拿旧数字重新解释一遍会得到同样的结论和一份没人跑过的判据。
   - 未走的出口 B（sha256 转 async：`inlineDigest`/`listFileOps` 变 async、`discard()` 把 digest 提到事务外——`row` 本来就在事务前读好，语义上成立）留在这里，供 N5 真遇到大歌词时回头取用。

#### 判据 21：Web 标准全局面三栏清单（产出型，release 实测）

| API | core 里的依赖点 | 结论 | 实测 |
|---|---|---|---|
| `TextEncoder` | `Buffer.byteLength` 的替身（`changes.ts:87` 等五处） | **原生** | 6/6 样本字节数与 `Buffer.byteLength` 相同，含孤代理 |
| `Intl.Collator('zh-CN')`（§1.3-A 之外补的） | `library/songs.ts:75,314` | **原生** | 安静 < 不了情 < 西游记 |
| `performance.now` | 测量协议自己 | **原生** | 分辨率 ~0.001ms |
| `new URL` + `searchParams` | `link.ts:179,226,258`、`server-url.ts:44` | **polyfill** | 建串正确、b23 路径正确、**非 URL 照常抛**（`link.ts` 靠这个抛分辨关键词） |
| `URLSearchParams` | 歌词三 client | **polyfill** | 顺序与百分号编码与桌面一致 |
| `TextDecoder` | skybridge `sse.ts:93` | **polyfill** | 从中间劈开的多字节 chunk 流式解码后完好 |
| `structuredClone` | `config/index.ts:71,80,104,113` | **polyfill** | 真深拷贝 |
| `AbortSignal.timeout` / `.any` | `timeouts.ts:62`、`engine.ts:793` | **polyfill** | 会触发；成员一个 abort 整体 abort |
| `fetch` | 所有 `fetchImpl` 注入点 | **polyfill，且 `globalThis.fetch` 就是 `expo/fetch` 同一个函数** | `redirect:'manual'` 拿得到 302 + Location · 204 空体 · **`res.body` 分 5 个 chunk 流式到达** |
| `Buffer`（全局） | — | **不存在**（如期） | 上下两行就是它的替代 |
| `atob` | `lyrics/shared.ts:93` 的 `Buffer.from(x,'base64')` | **需要端口** | 原生存在，但 **7 个样本里 2 个发散**：非法字符与 url-safe 字母表上 `atob` 抛，而 `Buffer.from` 照常解出字节 |
| `crypto.getRandomValues`（全局） | `wbi.ts:147-153` | **需要端口** | 不存在 |
| digest（md5/sha256） | `wbi.ts:67`、`file-ops.ts:342` | **需要端口** | 见判据 20 |

**两条清单本身给出的结论**：① **N1 不必为 fetch 做注入选型**——SDK 57 的全局 fetch 就是 `expo/fetch`，三条行为（manual redirect / 204 / 流式 body）全过，skybridge SSE 的 `res.body` 要求在平台上成立；② **base64 端口的规格要按 `Buffer.from` 的宽松语义写**，不能直接包 `atob`——`decodeBase64` 的 try/catch 会把「抛」变成 `null`，于是一条本来能解出歌词的响应会静默变成「没有歌词」。

#### 本批实测锁定

- **release APK ≠ release bundle**（上文 1）：判据要自带「我是哪个 bundle」的证据，否则两份数字长得一模一样。
- **夹具的 journal 模式是判据的一部分**（上文 2）：不是调优，是「量的是不是同一个东西」。
- **`sync_cursor` 在 v2 被 DROP 重建**（0002）：proxy 第一版按 v1 的 `(endpoint, server_seq)` 写，真机报 `table sync_cursor has no column named endpoint`。**写语句形状 proxy 就得照当前 schema 抄**，v1 的记忆会骗人。
- 🔴 **release 构建的 `console.log` 到不了 logcat**（实测：六个前缀零命中，连 `ReactNativeJS` 标签都没有）：RN 把 console 接到原生日志是**开发工具链的一部分**，于是「每个数值判据必须用的那个构建」恰好是唯一打印不出来的那个。结果回传（POST 给桌面 probe host）因此不是方便，是**唯一**的机读通道；debug 构建照常有 logcat，N0b-2 就是那么读的。
- **面板的报错在滚动到底之前看不见**：那次失败的 apply 面板什么也没输出，`crashed` 文案在十几屏之下——`drive.mjs` 的「按标签找」因此不只是方便，它是唯一能可靠翻到底的办法。
- **`ANDROID_HOME` 只活在用户的交互 shell 里**：release 构建从别的进程跑就在 Gradle 之后死于 `spawn adb ENOENT`。已按 `JAVA_HOME` 的同一形态钉进 recipe（`_android_home`）。
- **`git push | tail` 那条坑换了个身**：`just … | tail -30` 让后台任务报了 exit 0，而 recipe 其实失败了。管道吞退出码不分场合。
- **`spikes/**/fixtures/` 在仓库 .gitignore 里**（M0 spike 的二进制夹具）：桌面产的期望值文件必须提交，所以它是 `src/desktop-fixtures.ts` 而不是 `src/fixtures/desktop.ts`。

### N0b-4a（2026-08-18）判据 22、23 与判据 19 的**流探针一半**

落点：桌面 `scripts/{make-network-fixtures,sync-host}.mjs` + `probe-host.mjs` 增两个端点（`GET /fixtures/network` 服务夹具、`POST /skybridge/nudge` 制造对端事件）+ 设备侧 `src/fixtures.ts` 与 `src/panels/{bilibili,skybridge}.ts` + 守卫的一条豁免 + 两条 just recipe。真机 vivo V2408A / Android 15，**debug 构建**——本批没有一个百分位数，§3.2a 只约束性能/数值判据（14/17/18/20/26），行为判据不绑 release。

**夹具不进 bundle，改由 probe host 现供**：bilibili 的流 URL 带 `deadline`（实测 **120 分钟**），skybridge 账号每次 `sync-host.mjs` 新建——编进 APK 就等于「签名过期一次、重打一次包」。`src/desktop-fixtures.ts`（摘要/字节长度那批，永恒值）照旧编译进去，两者的区别写在 `fixtures.ts` 头部。

**音频夹具（判据 19 的输入，已产并 push）**：`songs` 全程零 remux，ffprobe 读的是原样字节。

| | 来源 | 时长（ffprobe） | 大小 | 流 |
|---|---|---|---|---|
| short | 用户收藏夹 3975154248「测试收藏夹」的**最短一条**（BV176M3zPEZu，2:17） | 136.835s | 3.5MB | aac 44.1kHz 2ch，`mp4a.40.2` 215675bps |
| long | **不在收藏夹里**——12 条最长 4:53，够不到 §3.2 的 ≥35min，故搜来一条（BV1LtgV6ZE2U p1） | 2226.646s（37:07） | 51.8MB | aac 48kHz 2ch，`mp4a.40.2` 194978bps |

- **判据 22 绿（四条硬 gate 全过）**：`login`（37ms，带 refresh + server_id）· `pushChanges`（20ms，accepted 1）· `pullChanges`（20ms，**payload 原样回来**，不只是形状对）· `refresh`（24ms，**拿轮换后的 token 真发了一次 `listDevices`**——旧 token 还有效，所以不这么做就分不清「轮换了」与「轮换的能用」）。registerDevice / ensureWorkspace 顺带绿。
  - **SSE 软判据也全绿**：`subscribeEvents` 312ms 开流；**桌面推的那条**（probe host 的 nudge，另一台设备身份）经 `onChange(latestSeq 3)` 到达；`unsubscribe` 之后 3 秒零帧。事件必须来自对端才算数——自己推自己收只证明了服务器的回声策略。
- **判据 23 绿（Wi-Fi 与移动网络各一遍，双网络都无硬阻断）**：`md5` 端口对桌面 canonical 串产出**同一个 `w_rid`** · 桌面签的 search URL 在手机上 `code 0` · 免签三端点 `view`/`pagelist`/`playurl` 全 `code 0`。**两种网络下 API 侧完全一致。**
- **判据 19 的流探针（E-1.3 的 header 矩阵）**：全量 header 集先复现成功，再逐项删除。

| 网络 | URL 来源 | 节点 | 全量集 | 去 UA | 去 Referer | 去 Cookie | 全去 |
|---|---|---|---|---|---|---|---|
| Wi-Fi | 桌面签 | `cn-bj-cc-03-02.bilivideo.com` | 206 `video/mp4` | 206 | **403** | 206 | **403** |
| Wi-Fi | 设备自取 | 同上（同一出口） | 206 `video/mp4` | 206 | **403** | 206 | **403** |
| 移动（电信 5G） | 桌面签 | 同上 | **连不上**（20s 取消） | — | — | — | — |
| 移动（电信 5G） | 设备自取 | `xy220x202x9x161xy.mcdn.bilivideo.cn:8082` | 206 `application/octet-stream` | 206 | 206 | 206 | **206** |

**本批实测锁定**

- 🔴 **流 URL 只在签发它的那张网上有效**：playurl 按**调用方 IP** 派 CDN 节点。桌面在家宽拿到的 `cn-bj-cc-03-02`（124.205.198.67）在电信 5G 上 DNS 解得出、连不上——app 20s 取消，`adb shell curl --max-time 25` 也是 `status=000` 且 `remote_ip` 为空，而同一根天线上 `api.bilibili.com` 一切正常。**探针因此跑两遍矩阵**：桌面签的那条仍有价值（它是 core 真会拉的字节），但只有设备自取的那条能回答「这张网能不能拉音频」。设备自取时**不复制 core 的选流规则**（codec 优先再带宽是业务规则，归 R1），取第一条 audio 只为拿到一个本网可用的 URL。
- 🔴 **最低 header 要求是「按节点」而不是「按平台」**：cc 节点少了 `Referer` 直接 403，而移动网络派来的 **mcdn（P2P CDN）节点 `:8082` 什么 header 都不要**，content-type 是 `application/octet-stream` 而不是 `video/mp4`。N4 不能按「Referer 是必需的」或「content-type 是 audio/*」写死任何判断——core 现在全量发三个 header，那是对的。
- **UA 与 buvid Cookie 在两个节点上都不是必需的**，但同样不构成「可以不发」：风控看的是整体身份，少发一个是省不下什么的赌。
- **VPN 会静默换掉这条判据的被测网络**：第一轮 Wi-Fi 是在 Clash Meta 的 tun0 下跑的（bilibili 不在其 bypass 清单），风控看到的不是用户真实出口 IP。用户手动关掉后重跑，结果逐行相同——但**判据 23 说的是真实网络，所以带 VPN 那轮只能算第三组证据**。跑网络判据前必须先 `dumpsys connectivity` 看默认网络是谁。
- **切网之后 Fast Refresh 是死的**：关 Wi-Fi 会断开 dev client 与 Metro 的连接，回来之后编辑不会自动生效——面板还在跑旧代码，而结果看起来完全正常（旧分组名是唯一线索）。改完代码要 `am force-stop` + 重启拉新 bundle。
- **`drive.mjs` 原来只会向下滚**：上一轮结束时页面停在下方，再点上面的按钮就报「never found」——读起来像按钮没了。已改成每次 tap 前先滚到顶。
- **skybridge server 走 `adb reverse`（USB loopback）而不是 LAN IP**：这样关掉 Wi-Fi 跑移动网络那一遍时，判据 22 的通道照常在，两条判据可以在同一次会话里跑完。
- **`_test` 是 server 允许的 tool**（`ALLOWED_TOOLS = {owl, lark, _test}`），spike 用 `_test/mobile-spike`，不去碰产品 workspace。

### N0b-4b（2026-08-18）判据 19 的**播放一半** + D17 判定

落点：`src/panels/playback.ts`（单 player / playlist / 后台 soak / 释放危险探针）+ `app.config.ts` 加 `expo-audio` 插件（后台播放 → `FOREGROUND_SERVICE_MEDIA_PLAYBACK` + media3 `MediaSessionService`；`recordAudioAndroid: false`）+ `android.permissions` 加 `POST_NOTIFICATIONS` + `drive.mjs audio`（主机侧读 `dumpsys audio` 的活跃播放器与 `dumpsys media_session`——**JS 听不见喇叭**）。真机 vivo V2408A / Android 15；核心结论跑在 **release 构建**上（面板自报 `release bundle · Hermes`），首轮 5.5 分钟 soak 跑在 debug 上——§3.2a 只约束数值判据，19 是行为判据。

**夹具**：`make-network-fixtures.mjs --audio` 下载的两条 bilibili 原始 AAC-in-MP4，零 remux；判据的「真值」是桌面 ffprobe 读同一个文件的结果。

| 组 | 判据 | 结果 |
|---|---|---|
| 单 player | 原始 fMP4 加载 | ✅ `isLoaded` 119ms |
| 单 player | 时长误差 ≤1s | ✅ 播放器 136.835s vs ffprobe 136.835s，**差 0s** |
| 单 player | seek 0/25/50/95% 各 ≤1s | ✅ 偏差 0 / 0.001 / 0.001 / 0s |
| 单 player | 播放中 seek 50% | ✅ 偏差 0.036s |
| 单 player | 暂停 2s 不漂 · 从暂停点续播 | ✅ 移动 0s；68.466 → 69.949s |
| playlist | 两条一起加载 · 播 track 0 · 时长 | ✅ trackCount 2；136.835s 对上 |
| playlist | `next()` 到 37 分钟那条 | ✅ 111ms，时长 2226.645s vs ffprobe 2226.646s |
| playlist | 长曲 95% seek · `skipTo(0)` | ✅ 偏差 0.256s；1ms 回到 index 0 |
| 后台 | ≥5min 后台 + 锁屏不断 | ✅ **330.587s 里播放推进 329.909s**，零暂停样本，落后钟差 0 段 |
| 锁屏 | 元数据与控件 | ✅ 通知显示分P 名 / `lark spike · N0b-4b` / BV 号；`KEYCODE_MEDIA_PAUSE` → 活跃播放器 0，`MEDIA_PLAY` → 1 |
| 焦点 | 瞬时抢占自动恢复 | ✅ bilibili（`GAIN_TRANSIENT`）播放期间我们停，它一停我们 6s 内自行恢复 |
| 焦点 | 永久抢占停住 | ✅ 网易云（完整 GAIN）播放期间我们停，**它停之后我们保持暂停**、焦点栈空 |
| 蓝牙 | 断连暂停 | ❌ **不暂停，改从扬声器继续放** |
| 释放 | `release()` 不先 `pause()` | ❌ **声音不停**（#47569 在 57.0.3 上仍在） |

#### D17 出口（冻结）

**raw fMP4 直存达标 → GO，不需要 remux。** 两条 bilibili 原始字节（AAC 44.1kHz / 48kHz，`mov,mp4,m4a` 容器）在 ExoPlayer 上加载 119ms、时长与 ffprobe **逐毫秒相同**、四个 seek 点偏差 ≤0.001s、37 分钟长曲 95% 处 seek 偏差 0.256s，单 player 与 playlist 两种驱动形态各一遍。§3.2 的三级兜底（JS remux → 原生 remux → NO-GO）**一级都不需要进入**，`spikes` 里也就没有 remux 内存峰值要量。

两条红的都**不是存储格式问题**，是 expo-audio 的会话行为，归 N3：

1. 🔴 **蓝牙断连不暂停，音乐从外放继续**（实测：旧 AudioTrack `deviceId:0` 转 `paused`，同时新起 `deviceId:3`=speaker 的 `started`，音乐路由变 `speaker(2)`）。这是 media3 的 `setHandleAudioBecomingNoisy(true)` 默认关闭，而 expo-audio 的 JS 面**没有暴露它**——RN 侧也没有 becoming-noisy 事件可听。N3 的代价是明确的：要么给 expo-audio 提 PR / 打补丁，要么自建一个监听 `ACTION_AUDIO_BECOMING_NOISY` 的小原生模块。**这是用户会立刻撞上的那类 bug**（耳机一摘，歌从外放响给整间屋子听）。
2. 🔴 **`release()` 不先 `pause()` 会留下一条谁也停不掉的音轨**：实测 release 之后 7 秒，`state:started` 的 AudioTrack 还在（48kHz = 长曲），JS 侧已无句柄，只有 `am force-stop` 能收。N0b-1 查 CHANGELOG 得出的「#47828 未进任何已发布的 SDK 57 版本」由此被真机确证。**pause-before-release 是硬要求**，且 N3 的每条销毁路径（切歌、退出、组件卸载、错误分支）都要走它。

#### 本批实测锁定

- **manifest 里声明权限不等于拿到权限**：第一轮 soak 的锁屏什么都没有，因为 `POST_NOTIFICATIONS: granted=false`——Android 13+ 要运行时申请，而**锁屏控件就是那条通知**。补 `requestNotificationPermissionsAsync()` 之后元数据与控件都在。播放本身全程不受影响，所以这个缺口只在「看得见的东西」上暴露。
- **`shouldPlayInBackground` 单独不够**：expo-audio 自己的文档写明 Android 上不调 `setActiveForLockScreen` 大约 3 分钟就会停——而判据要 ≥5 分钟，正好在那道坎的另一侧。soak 因此把它当**必需的 setup**，不是锦上添花。
- **熄屏后 JS 定时器被冻结，而播放时钟没有**：5.5 分钟 soak 里采样最大间隔 **85 秒**（5 秒一采的循环），可播放推进与墙钟逐段吻合。所以「后台还在不在播」不能靠 JS 定时器判断，只有播放器自己的 `currentTime` 与主机侧 `dumpsys audio` 算数。
- **`player.playing` 不反映焦点导致的暂停**：焦点被抢期间 `dumpsys audio` 里我们是 `state:paused`，而 JS 侧 `playing` 仍是 true。判「是不是真的在响」只能问系统。
- **expo-audio 请求的是 `GAIN_TRANSIENT` 而不是 `GAIN`，且 `usage=USAGE_UNKNOWN`**（焦点栈实测；AudioTrack 自己的属性倒是 `USAGE_MEDIA`）。一个音乐播放器按理该持 `GAIN` + `USAGE_MEDIA`——这决定别人是躲我们还是压我们，N3 要复核。
- **切网/开关 VPN 之后 dev client 回不到 Metro**：Wi-Fi 一关，dev client 与 Metro 的连接断掉，之后编辑不再热更，而**面板看起来完全正常**（只有旧的分组名露馅）；`am start` 发 deep link 指定 `localhost:8081`（USB `adb reverse`）也叫不回来，它只会静默用缓存 bundle。这台 vivo 上 `adb logcat` 还是空的，看不到 dev client 在想什么。**可靠路径是 release 构建**（bundle 烙进 APK），本批的判定因此都跑在 release 上——顺带满足了 §3.2a 更严的口径。
- **`drive.mjs dump` 只列当前屏可见节点**：用它判断「新按钮不存在」错了一次（`tap` 会滚动查找，`dump` 不会）。要确认一个按钮在不在，用 `tap`。
- **判据 19 的证据链末端一定在主机侧**：JS 说「我 release 了」「我 pause 了」都可能与喇叭不符，`drive.mjs audio` 的活跃播放器计数才是那句能写进文档的话。

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
