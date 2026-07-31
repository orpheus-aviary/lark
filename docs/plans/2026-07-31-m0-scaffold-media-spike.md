# lark M0 计划：脚手架 + 媒体 spike

> 2026-07-31 首版；同日一轮评审修订 14 项（重试语义/CORS/Electron 版本/spike 编排与 token 生命周期/矩阵防假通过/脚本外置/T1 边界/锁版/守卫补全/CLI 命名/验收命令/URL 校验/fallback 收紧/spike 防腐）；同日二轮评审修订 13 项：spike 校验 harness 统一生命周期并拆两层（fast 层进 `just check`）、`/healthz` readiness 状态机（消除 token 发布前假 ready）、CSP 改 Vite 插件单一来源（session.webRequest 加头只会交集收紧，不能放宽 meta，此路废弃）+ 生产 CSP 字符串定稿、泄漏观测改应用层流计数（弃 TCP socket 数）、CORS「拒绝」语义定义为无 ACAO + 补 `Origin: null` 用例、T1 占位按包分型、重试收窄到仅 GET（HEAD 无 body 与信封 transport 不兼容）、`.node-version`/`@types/node` 精确对齐 Node 24 + ABI 记录 host/Electron 两侧、electron-builder 推迟 M7 选型、URL 校验补拒 username/password/port、缓存 token 负向验证改环境开关、Electron 升级重跑完整矩阵。
> 同日三轮评审修订 9 项：/audio 无 Range 200 响应补 `Content-Length`/`Accept-Ranges` + 主进程透传补 `Content-Length`/`Cache-Control` + smoke 校验正文字节数与完整响应头、`--publish-delay-ms` 测试发布屏障（healthz 503 观测竞态）、判据 6 允许 HTMLMediaElement 恢复语义（`load()`）并入归因阶梯第 ⑤ 类、流计数一次性 guard（防负数）、transport 限定只重试网络层异常 + 401 单次请求断言、fast harness 补 0600/竞争实例/轮换断言、meta CSP 移除 `frame-ancestors`（meta 交付不生效）+ 注入位置前置、`.runtime` 按 `import.meta.url` 锚定 + harness try/finally 超时兜底 + 完整层显式依赖 fixture、build 态 CSP 验收改用 `electron-vite preview`。
> 上游：`2026-07-16-ts-rewrite-master-plan.md` §6 M0 行 + §2.4（R5/R21/R29）。
> 完成标准（主计划）：`just check` 全绿 + 对应测试绿 + 用户验收关键路径；spike 六项判据全过则 §2.4 定稿维持，确认平台级限制不可规避才启用签名 URL fallback 并回改主计划。

## 0. 目标

1. **工程基座**：pnpm workspace、tsconfig.base（strict/NodeNext）、Biome、justfile、依赖方向守卫，照抄 owl 已验证形态（本计划标注的刻意差异除外，见 §4）。
2. **五包骨架 + 一条垂直切片**：`shared ← core ← daemon ← gui`、`cli → shared`（M0）依赖方向落地，用 `GET /status` 打通全链路——daemon 起服务、CLI `status` 查询、GUI 窗口展示——证明骨架真实可用而非空目录。
3. **`lark-media://` 媒体 spike（R21，本里程碑核心风险项）**：最小 Electron 工程验证自定义协议六项判据（协议注册 / Range 透传 / 206 / 连续 seek / CSP / token 轮换），产出结论回写文档。owl 调研确认：**owl 全仓无 `protocol.handle` / renderer CSP 先例**，此处无现成代码可抄，必须先行验证。

## 1. 范围

**M0 做**：上述三项 + 最小测试（vitest 跑通）+ 本文档「spike 结论」章节回填。

**M0 明确不做**（防止范围蔓延）：

| 推迟项 | 去处 | 理由 |
|---|---|---|
| better-sqlite3 / drizzle / schema / migration | M1 | M0 无 DB |
| ABI 切换 recipe（ensure-node-abi / ensure-electron-abi） | M1（随 better-sqlite3 一起进） | M0 没有原生模块冲突可切；justfile 留注释占位。M1 落地时**同时记录 host Node 与 Electron 两侧的 `process.versions.modules`**（不抄 owl 的 137/132，也不能只记 Electron 一侧） |
| PID 锁、Bearer 鉴权、SSE、除 status 外全部路由 | M2 | 主计划 M2 范围；M0 daemon 只有免鉴权 `/status`（+ CORS，见 T2——GUI 垂直链路的硬前提，不能推迟） |
| 正式 local-token.ts / pino-roll 文件日志 / config toml 加载 | M2 / M1 | spike 内自带最小 token 实现（语义对齐，见 T4），结论可迁移 |
| GUI daemon spawn/确权、单实例、Tailwind/shadcn、正式 lark-media 代理 | M4 | M0 GUI 只是 electron-vite 骨架 + status 展示；spike 学到的协议代码在 M4 移植进 gui main |
| electron-builder / 打包 | M7 | M0 不产打包物，**electron-builder 版本也推迟到 M7 按当时受支持版本选**（M0-4） |
| 全局 `lark` bin link / npm 发布名处理 | M6 / M7 | M0 经 `just cli` 调用（见 T2） |

**工具前置**（开工先确认）：`node >= 22.12`（electron-vite 5 要求，比 owl 的 `>=22` 更严）、`pnpm >= 10`、`just`、`rg`（守卫脚本依赖）、系统 `ffmpeg`——**仅完整 spike 校验层（`just spike-media-check`）需要**；日常 `just check` 的 fast 层不依赖 ffmpeg 和图形环境（见 T4 防腐）。

## 2. M0 内定决策（有异议随时推翻）

| # | 决策 | 说明 |
|---|---|---|
| M0-1 | spike 放 `spikes/media-protocol/`：**进 pnpm workspace（自带 package.json + 显式 electron 依赖，不靠 hoist 碰巧解析）、Biome 覆盖（不 ignore）、不进 tsc -b solution、依赖方向守卫不适用**；防腐校验拆两层：fast 层进 `just check`，完整层 `just spike-media-check`（见 T4） | spike 长期保留作 M4 移植参照，不能是完全无检查的死代码 |
| M0-2 | spike 自带最小 token 服务（~30 行），**发布时机对齐 owl：listen 成功后才生成并原子发布**（0600 `'wx'` → rename），失败进程永远走不到 publish、不会覆盖运行中实例的 token；readiness 门控状态机见 T4（token 落盘前 `/healthz` 返回 503） | 与 owl `local-token.ts` / boot.ts 语义一致，结论对 M2 正式实现有效 |
| M0-3 | 测试统一 **vitest**（所有包），不沿用 owl core/daemon 的 `node --test` | lark CLAUDE.md 已定 vitest；避免 owl 双 runner 的历史包袱 |
| M0-4 | **版本策略：全部精确锁版（无 `^`）+ 提交 `pnpm-lock.yaml` + 根 `packageManager: "pnpm@10.34.0"`**。非 Electron 系依赖从 owl 的 pnpm-lock **实际解析值**起步（fastify 5.8.4、react 19.2.4、typescript 5.9.3 等，开工时逐一从 owl lock 抄）；**例外三处**：① **electron + electron-vite** 不继承 owl——owl 锁的 Electron 34.5.8 已 EOL（官方只支持最近三个稳定大版本），开工首日查官方 timelines 选定**实际发布目标的受支持大版本**并精确锁定，spike 与 gui 用同一版本（electron-builder M0 不用，M7 再按当时版本选）；② `.node-version` 写**精确值**（Node 24 当前 patch，如 `24.13.0`，不写「24.x」）；③ `@types/node` 与实际 Node 24 runtime 对齐（精确 24.x 版本，**不抄 owl 的 25.5.2**） | 「抄 owl 起步」只对仍受支持且与本机 runtime 一致的依赖成立；在 EOL 版本上过 spike，M7 升级后媒体验证全部作废 |
| M0-5 | renderer **从 M0 起就带严格 CSP**（owl 无此先例），**CSP 单一来源 = renderer 的 Vite 插件 `transformIndexHtml`**：dev 注入含 HMR WebSocket 的策略、build 注入严格策略；`index.html` **不手写 CSP meta**。（一轮修订里的 `session.webRequest` 放宽方案**废弃**：多个 CSP 策略是交集收紧，追加宽松响应头不能解除已有 meta 的限制。）**生产 CSP 定稿**：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src lark-media:; connect-src http://127.0.0.1:47100; object-src 'none'; base-uri 'none'`——**不含 `frame-ancestors`**：该指令经 meta 交付被浏览器忽略，写上只有虚假安全感；嵌套防护属 Electron 层（M4 的 `will-navigate` / `setWindowOpenHandler`）。meta **必须注入在所有 script 标签之前**（`transformIndexHtml` head-prepend）。dev 策略 = 生产基础上 `connect-src` 追加 `ws://localhost:* ws://127.0.0.1:*`。两态验证：dev 直接看 console；build 态用 `just gui-preview`（→ `electron-vite preview` 真正启动 build 产物——单跑 build 没有 console 可观察），各自确认无 violation | spike 判据 5 验证其中 `media-src lark-media:` 部分 |
| M0-6 | 不做 `apps/web` / `@lark/server` 对应物 | 主计划 §0 已排除联网 web UI；owl 的 typecheck-web 分岔不需要 |
| M0-7 | **transport 重试语义不照抄 owl**：owl `request()` 对任意 method 默认重试 2 次，POST/PUT/DELETE 在「服务端已提交但响应断线」时会重复建歌单/导入/下载。lark 定死：**仅 GET 默认重试（2 次 + 退避），且只重试 fetch 网络层异常（fetch reject/超时）——一旦收到 HTTP 响应，401/5xx/JSON 解析失败一律不重试；其余 method（含 HEAD）默认 0 重试**——HEAD 响应无 body，与照抄的 `res.json()` 信封解析不兼容，未来若需要 HEAD 先给 transport 加无 body 响应路径再放开。写方法要重试必须显式传参且该端点具备幂等键（机制届时定义）。owl 同款隐患记一条跨仓待办 | 防重复写入是线协议层责任，M0 定死后面全部端点受益 |
| M0-8 | **CLI 命名统一**：包名用内部名 `@lark/cli`（对齐主计划 §2.1 / AGENTS / CLAUDE），bin 名 `lark`；发布名 `@orpheus-aviary/lark-cli` 的改名/publishConfig 机制推迟 M7 发布时定。**依赖方向统一表述**：`cli → shared`（HTTP backend，M0 仅此）`+ core`（`--direct` backend，M6 起用）。分工：`packages/daemon` 的 `./cli` 入口只管 daemon 自身生命周期（M0：`daemon` 前台启动；M2 加 stop）；`apps/cli` 是面向用户/agent 的全功能 CLI，后续代理 daemon 生命周期命令（M6） | 消除本计划首版与主计划/AGENTS 间的名称、方向矛盾 |

## 3. 任务分解

### T1 仓库基座（含全部包的最小占位）

照抄 owl 对应文件并替换命名（owl→lark、47100 端口、`~/orpheus-aviary-nest/lark/`）：

- `pnpm-workspace.yaml`：`packages/*`、`apps/*`、`spikes/*`；`onlyBuiltDependencies: ["@biomejs/biome", "electron", "esbuild"]`（better-sqlite3 M1 再加）。
- `.npmrc`：`node-linker=hoisted`（与 M1 的 ABI recipe fallback 绑定，必须同抄）；`.node-version`：精确值（M0-4，如 `24.13.0`）。
- 根 `package.json`：`private: true`、`type: module`、`engines: { node: ">=22.12", pnpm: ">=10" }`、`packageManager: "pnpm@10.34.0"`；scripts：`lint` / `lint:fix` / `typecheck: tsc -b` / `build: pnpm -r run build` / `dev: pnpm --filter @lark/gui dev` / `test: pnpm -r run test`。根 devDependencies 只放 biome / typescript / @types/node（其余版本落各包，owl 模式；版本按 M0-4 精确锁定）。
- `tsconfig.base.json`：照抄 owl（ES2022 / NodeNext / strict / isolatedModules / declaration+map / noUnusedLocals+Parameters / noFallthroughCasesInSwitch；`composite` 不进 base，各包自开）。
- 根 `tsconfig.json`（solution，`files: []`）references：`packages/shared`、`packages/core`、`packages/daemon`、`packages/gui/tsconfig.node.json`、`packages/gui/tsconfig.web.json`、`apps/cli`。
- **T1 占位按包分型**（保证 solution references 不悬空，`tsc -b` 验收留在 T1，内容填充在 T2/T4）：
  - shared / core / daemon / cli：package.json + tsconfig + 空 `src/index.ts`；
  - gui：package.json + `tsconfig.json`（`files: []` + references 到 node/web）+ `tsconfig.node.json` / `tsconfig.web.json` 两个子配置（占位期各自 include 指向尚为空的目录或 `files: []`，T2 填真实文件后改回真实匹配）——GUI 不适用「一个 src/index.ts」占位；
  - spike：**仅 package.json**（纯 MJS 工程、不进 tsc，源文件 T4 加入）。
- `biome.json`：照抄 owl（schema 1.9、space/2/100、single quote、`noExplicitAny` 收紧为 **error**——lark 规范禁 any）；**不 ignore `spikes/`**（M0-1）。
- `.gitignore` 补：`dist/`、`out/`、`release/`、`*.tsbuildinfo`、`spikes/**/fixtures/`、`spikes/**/.runtime/`。
- 首次 `pnpm install` 后**提交 `pnpm-lock.yaml`**。

**验收**：`pnpm install` 成功；`tsc -b` 全绿（占位包）；`pnpm lint` 通过。

### T2 五包骨架（内容填充）

| 包 | name | 要点 |
|---|---|---|
| `packages/shared` | `@lark/shared` | Node-free：tsconfig `lib: ["ES2022","DOM"]`、`types: []`（owl shared 同款，mobile-safe）；exports `.` + `./api-paths` 双入口。M0 源文件：`types.ts`（ApiResponse 信封类型 + StatusData）、`transport.ts`（结构照抄 owl `configureTransport`/`request`/`ApiError`，**重试策略按 M0-7 改写：`retries` 默认值由 method 决定，GET=2、其余含 HEAD=0**）、`api-paths.ts`、`index.ts` barrel。sse.ts M2 再抄 |
| `packages/core` | `@lark/core` | M0 仅 `paths.ts`：`nestDir()`（支持 `LARK_NEST_DIR` 覆盖、每次重读 env）、`larkDir()`、`localTokenPath()`、`pidPath()`、`logsDir()`、`songsDir()`——路径先定全，实现按需；references shared |
| `packages/daemon` | `@lark/daemon` | `context.ts`（M0 版 AppContext：`config: { port }`、`logger`）、`response.ts`（照抄 owl 36 行信封 helper：`ok`/`created`/`fail`）、`server.ts`（`buildServer(ctx)` 返回 FastifyInstance 不 listen；`setErrorHandler`/`setNotFoundHandler` 走信封；**注册 `@fastify/cors` + origin delegate**：放行无 Origin（curl/CLI）、`null`（build 后 GUI `loadFile` 的真实 Origin）、loopback HTTP Origin（`http://127.0.0.1:*` / `http://localhost:*` / `http://[::1]:*`）；**「拒绝」的语义 = delegate 返回 false → 响应不带 ACAO 头、路由照常执行**（@fastify/cors 不产生 403，拦截发生在浏览器侧；M0 保持 owl 同语义，不加 403 hook）——owl 为同样的 renderer 跨源问题实现过 loopback allowlist，裸 Fastify 会让 GUI 链路直接失败）、`routes/system.ts`（`registerSystemRoutes`：`GET /status` → `{ status:'ok', pid, uptime, version }`，永久免鉴权）、`cli.ts`（commander `daemon` 子命令，**显式 `listen({ host: '127.0.0.1', port: 47100 })`**；末尾 `program.parse(process.argv, { from: 'node' })`——owl 注释：不加这个，Electron 下 commander 会把脚本路径当子命令）；exports `.` + `./cli` |
| `packages/gui` | `@lark/gui` | electron-vite 三段（main/preload/renderer，照抄 owl `electron.vite.config.ts` 结构与 tsconfig node/web 拆分）；main 开窗加载 renderer（不 spawn daemon）；renderer 极简 React 页面经 shared `configureTransport` 调 `/status` 展示 daemon 在线状态；CSP 按 M0-5（Vite `transformIndexHtml` 插件单一来源，dev/build 两态验证） |
| `apps/cli` | `@lark/cli`（bin: `lark`，M0-8） | commander + `status` 命令（HTTP backend 经 shared transport；`--json` 输出原始信封）；backend 接口留形状，`--direct` M6 再做 |

依赖方向：`shared ← core ← daemon ← gui`；`cli → shared`（M0-8）。

**验收**（调用方式全部落地为可执行命令，不假设全局 `lark` 存在）：
1. `tsc -b` 全绿。
2. `just dev-daemon`（→ `node packages/daemon/dist/cli.js daemon`）起服务后：`curl http://127.0.0.1:47100/status` 返回统一信封；外部网卡地址访问不通（绑定 127.0.0.1 生效）。
3. `just cli status` / `just cli status --json`（recipe → `node apps/cli/dist/index.js`）正确输出。
4. `pnpm dev` 打开 GUI 窗口显示 daemon 在线状态（daemon 手动预先启动）；devtools console 无 CORS 报错、无 CSP violation；build 态用 `just gui-preview`（→ `electron-vite preview` 启动 build 产物）验证 CSP（M0-5 两态）。

### T3 justfile + 依赖方向守卫

- justfile 分组照抄 owl 骨架，M0 落地 recipe：`lint` / `lint-fix` / `typecheck` / `test` / `build`（+ 各包 build-x）/ `dev`（M0 版：build-shared/core/daemon 后 `pnpm run dev`）/ `dev-daemon` / `gui-preview`（electron-vite preview，M0-5 build 态 CSP 验收用）/ `cli *args` / spike 五件套（见 T4）/ `check`。ABI recipe 位置留注释占位（M1 填，含 owl 的两条血泪注释：`build-release` 而非 `pnpm run install`、hoisted 布局 fallback；记录 host Node 与 Electron 两侧 `process.versions.modules`）。
- 守卫脚本（`scripts/`，形态照抄 owl 的三种 import 形式匹配：static `from` / `require(` / 动态 `import(`，排除 `*.test.ts`）。**hoisted 布局下未声明的依赖也能被解析，所以守卫必须 rg 源码，不能依赖 package.json 声明检查**：
  - `check-core-no-daemon-electron.sh`：`packages/core/src` 禁 `@lark/daemon` / `@lark/gui` / `electron`。
  - `check-daemon-no-gui-electron.sh`：`packages/daemon/src` 禁 `@lark/gui` / `electron`（daemon 可独立于 Electron 运行是架构硬约束）。
  - `check-shared-node-free.sh`：`packages/shared/src` 禁 `electron` / `@lark/core` / `@lark/daemon` / `require(`，以及 **Node builtin 的两种形态**——`node:` 前缀与裸名（`fs`、`path`、`os`、`crypto`、`http`、`https`、`net`、`stream`、`url`、`util`、`events`、`buffer`、`child_process`、`worker_threads`、`zlib` 等白名单枚举进 rg alternation；只匹配 `node:*` 会漏掉裸 import）。
- `check: lint typecheck core-no-daemon-electron daemon-no-gui-electron shared-node-free spike-media-test`（fast 层进 check，见 T4），后续里程碑往里追加。

**验收**：`just check` 全绿；在 core 加 `import 'electron'`、在 shared 加 `import fs from 'fs'`（裸形式）各能红一次。

### T4 媒体 spike 工程（`spikes/media-protocol/`）

自包含 workspace 包，**进程编排、readiness、token 生命周期全部显式定义**：

```
spikes/media-protocol/
├── package.json      # @lark/spike-media-protocol，private，devDeps: electron <M0-4 精确版>（显式声明，不吃 hoist）
├── server.mjs        # 模拟 daemon（前台运行；--fixture <path> 指定文件、--no-throttle 关限速）
├── harness.mjs       # 校验 harness：统一拥有 server 生命周期（spawn → 等 ready → 断言 → 停止）
├── main.mjs          # Electron 主进程（含 --smoke 模式）
├── renderer.mjs      # 播放/连点 seek 脚本 —— 外部文件；inline script 会被 script-src 'self' 拦截
├── index.html        # <audio> + 按钮 + 严格 CSP meta（spike 内 meta 即单一来源，无 vite）
└── .runtime/         # gitignore：daemon-token、generation
```

**运行时契约**：
- 端口固定 **47190**（471xx 段内，避开 47100），server 绑定 127.0.0.1；token 路径 `.runtime/daemon-token`；generation 计数持久在 `.runtime/generation`；**`.runtime/` 与 `fixtures/` 路径一律按 `import.meta.url` 锚定到 spike 目录**（不依赖 cwd，从任何目录跑 recipe 结果一致）。
- **readiness / token 生命周期状态机**（消除「已 listen 但 token 未落盘」的假 ready 窗口）：
  1. listen 成功（此刻起才算占有端口；**只有占有端口的实例允许递增 generation**，竞争失败的实例不得触碰它）；
  2. generation +1 → 生成 token → 0600 原子发布（M0-2）；
  3. 全部成功 → `ready = true`；**此前 `/healthz` 一律返回 503**，之后返回 200；
  4. 任一步失败 → 立即 close server、清理临时文件、**非零退出**。
- **`--publish-delay-ms <n>`（测试专用发布屏障）**：在状态机步骤 1 与 2 之间插入延时。正常路径 listen 后同步紧接发布，503 窗口极短，自动测试直接观测必然竞态——fast harness 以该参数确定性断言「token 落盘前 503 → ready 后 200」；默认 0，不改变手动/生产语义。
- **进程编排（手动探索用）**：`just spike-media-fixture`（幂等生成真实 fixture）→ `just spike-media-server` 与 `just spike-media-app` **两个独立 recipe、两个终端**——重启 server 验证 token 轮换时 Electron 不受牵连。app 启动后轮询 `/healthz` 直至 200 再开窗（ready handshake）。
- **退出清理**：server 捕获 SIGINT → 删除 token 文件 → 退出码 0。

**server.mjs 行为**：
- `GET /audio/:id`：Bearer 校验（错 → 401）；Range 合法 → **206** + `Content-Range`/`Accept-Ranges: bytes`/`Content-Length`；**非法或越界 Range → 416 + `Content-Range: bytes */<size>`**；无 Range → 200，**同样必须带 `Content-Length` 与 `Accept-Ranges: bytes`**——判据 1 的总时长与可 seek 判定依赖它们，200 路径不能漏。全部响应带 `Content-Type: audio/mpeg`、`Cache-Control: no-store`。
- **限速流式发送（约 256KB/s，默认开，`--no-throttle` 供 fast 校验层）**——localhost 会把整个文件秒级缓冲完，此后 seek 不再发新请求、token 轮换根本打不到新 server，矩阵全是假通过；限速保证进度条远端恒有未缓冲区。
- **应用层流计数（判据 4 观测点）**：维护 `activeAudioResponses` 与 `activeFileStreams` 两个计数器，在 `finish` / `close` / `error` / `abort` 统一递减并销毁对应文件流，变化时打印；**同一响应/流上这些事件可能连续触发多个，递减与销毁必须有每流一次性 guard（cleanup 幂等化）**，否则计数变负、判据 4 失真。**不用 TCP socket 数**——Chromium 连接池会保留多个 keep-alive socket、`/healthz` 轮询也占连接，「socket ≤1」不可靠；更不用 `lsof`。
- **结构化日志**（判据 2/3/6 观测点）：`[gen N] #<seq> Range=<...> → <status> auth=<ok|fail>`，**绝不打印 token 本体**。

**fixture 两种**：
- 完整层：320kbps CBR、30 分钟（约 70MB），`ffmpeg -f lavfi -i "sine=frequency=440:duration=1800" -b:a 320k -ac 2 fixtures/fixture.mp3`，recipe 幂等（已存在跳过），不进 git；
- fast 层：harness 运行时生成**小型二进制文件**（如 2MB 随机字节）——Range/416/鉴权语义与文件内容无关，**不需要 ffmpeg**。

**main.mjs**：
- ready 前 `protocol.registerSchemesAsPrivileged([{ scheme: 'lark-media', privileges: { standard: true, stream: true, supportFetchAPI: true } }])`。
- `protocol.handle('lark-media', ...)` **严格校验 URL 结构**：`lark-media://song/<id>` 中 host 段是字面量 `song`（standard scheme 的 host 规范化只影响它，无害）、UUID 在 pathname——要求 `url.hostname === 'song'`、`pathname` **恰为一段小写 v4 UUID**、**且 `username`/`password`/`port`/query/hash 全部为空、无多段 path**，任一不符即拒绝（R10）。
- **每次请求重读 `.runtime/daemon-token`**（R29 核心，不缓存）；`net.fetch` 转发到 `http://127.0.0.1:47190/audio/<id>`，透传请求 `Range` 头 + 附 `Authorization`，原样返回状态码 / `Content-Range` / `Accept-Ranges` / **`Content-Length`** / `Content-Type` / **`Cache-Control`** / body 流。
- **`LARK_SPIKE_CACHE_TOKEN=1` 环境开关**：启用「启动时读一次并缓存 token」的错误行为，专供判据 6 反向验证（轮换后应得 401）——不为负向测试手改代码、不留脏改动。
- `--smoke` 模式：不开窗，主进程自己 `net.fetch('lark-media://song/<fixture-id>', { headers: { Range: 'bytes=0-1023' } })`，断言 **206 + 正文恰为 1024 字节 + `Content-Range`/`Accept-Ranges: bytes`/`Content-Length: 1024`/`Content-Type: audio/mpeg` 齐备**后 `app.exit(0)`。

**防腐两层（M0-1）**——`harness.mjs` 统一拥有 server 生命周期（一轮版本「测试后停 server 再跑 smoke」的顺序断裂已修正）。harness 实现要求：**全程 try/finally、每阶段设超时、异常路径兜底 kill 子进程**（不留孤儿 server）：

| recipe | 内容 | 依赖 | 何时跑 |
|---|---|---|---|
| `just spike-media-test`（**进 `just check`**） | `node --check` 全部 mjs + `node harness.mjs`：spawn server（小 fixture + `--no-throttle` + `--publish-delay-ms`）→ **确定性断言 503（token 未落盘）→ 200（ready）** → HTTP 断言（200/206/416/401/头部完整性——含 200 路径的 `Content-Length`/`Accept-Ranges`、`Content-Type`/`no-store`/`Content-Range`）→ **断言 token 文件权限恰为 0600** → **竞争实例断言**（并发起第二个 server：listen 失败非零退出，token/generation 未被改动）→ **轮换断言**（SIGINT 后重启：generation +1、token 内容变化）→ SIGINT → 等退出、断言 token 文件已清理 | 无 ffmpeg、无图形环境 | 每次 `just check` |
| `just spike-media-check`（完整层，**recipe 显式依赖 `spike-media-fixture`**，不假设 fixture 已存在） | `node harness.mjs --full`：spawn server（真实 30 分钟 fixture + 默认限速）→ 等 ready → 同上 HTTP 断言 → **server 仍存活时**跑 `electron main.mjs --smoke` → SIGINT → 等退出并断言清理 | ffmpeg（fixture 幂等生成）+ 可开窗环境 | T7 验收、协议代码改动、Electron 升级 |

### T5 spike 执行与判定（验证矩阵）

手动探索用 `spike-media-server` + `spike-media-app` 双终端跑：

| # | R21 判据 | 验证方法 | 通过标准（含防假通过条款） |
|---|---|---|---|
| 1 | 协议注册 | 起 server + app，点播放 | 出声、进度条前进、总时长正确（依赖 `Content-Length`/`Accept-Ranges` 正确透传）；响应 `Content-Type: audio/mpeg` |
| 2 | Range 透传 | 拖动进度条到**未缓冲远端**（限速保证恒存在），对照 server 日志 | 每次 seek 产生**新 `#seq`** 且 `Range: bytes=N-` 与位置成比例——必须观测到新请求序号，排除「已缓冲区内 seek 不发请求」的假通过 |
| 3 | 206 / 416 | seek 观测响应码；416 已由 harness 自动断言 | seek 全部 206 + `Content-Range` 正确、播放位置准确 |
| 4 | 连续 seek | 「乱序连点」按钮（renderer.mjs 脚本）10+ 次快速 seek | 无卡死、无白屏，最终停在最后位置正常播放；**server 端 `activeAudioResponses`/`activeFileStreams` 回落至 1（仅剩当前播放流），被中断的旧流在 close/abort 时全部销毁**——不看 TCP socket 数（连接池/healthz 污染），不用 lsof |
| 5 | CSP | 严格 CSP（`default-src 'self'; media-src lark-media:; connect-src http://127.0.0.1:47190; script-src 'self'; object-src 'none'`）+ 外置 renderer.mjs，重复 1–4 | 全部仍通过、console 无 violation；Elements/Network 面板确认 **token 未出现在 URL/DOM/媒体 src**（R21 硬约束） |
| 6 | token 轮换 | 播放中 Ctrl-C 重启 server（gen N→N+1、新 token 发布）→ **不刷新 renderer**，等 `/healthz` 恢复 200 后先直接 seek 到未缓冲位置；若无请求发出，用 renderer.mjs 的「恢复」按钮对**同一无 token 的 src** 执行 `audio.load()` 再 seek——重启会中断进行中的媒体请求，HTMLMediaElement 可能进入 error 态，此后 seek 不保证再发请求；这是媒体元素语义，签名 URL 方案同样存在，**不构成 fallback 理由** | server 日志显示 **gen N+1 以 `auth=ok` 接受了新的 Range 请求**（允许经 `load()` 恢复后达成；观测必须落在新 generation 的请求上，「旧缓冲还在播」不算过）；反向验证：`LARK_SPIKE_CACHE_TOKEN=1` 重启 app 后轮换应复现 401 |

附加观测（不作为门槛，记入 §6）：不存在的 id → handler 透传 404、audio 元素 error 事件不崩 renderer；长时间暂停后恢复是否重新发 Range。

### T6 判定回写（先归因，后 fallback）

- **全过** → §6 记录实测结果 + 定稿要点（privileges 组合、net.fetch 透传细节、CSP 定稿字符串、URL 校验规则），主计划 §2.4 标注「spike 已验证 2026-XX-XX」；CSP/协议定稿写入 gui 骨架与 M4 移植清单。
- **有判据不过** → **不立即触发 fallback**。先走归因阶梯并复测：① fixture/限速/缓冲导致的观测假象 ② CSP 写法问题 ③ spike 自身实现 bug ④ 观测方法错误 ⑤ HTMLMediaElement 错误态/恢复语义（中断后需 `load()`/重设 src 才恢复——签名 URL 方案同样存在此问题，不属协议层限制）。只有排除以上四类、确认**目标 Electron 大版本存在不可规避的平台限制**（如 `protocol.handle` 流式/Range 语义缺陷，需官方文档或 issue 佐证）才启用签名 URL fallback（daemon 签发带作用域、短时、可刷新的 `?sig=&exp=`，服务端校验，pino 脱敏 sig），并**回改主计划 §2.4 + CLAUDE.md「注意事项」+ 本仓 DESIGN.md**，fallback 方案补一轮小型评审再进 M4。归因过程无论结论如何都记入 §6。

### T7 收尾

- M0 单测落齐（vitest）：
  - shared `transport`：**GET 网络失败 → 重试后成功；POST 网络失败 → 不重试、直接抛**（M0-7 核心用例）；重试耗尽抛错；**只重试网络层异常——401/5xx/JSON 解析失败等「已收到响应」的错误不重试，401 场景断言 fetch 仅被调用一次**并抛 ApiError。
  - daemon（`app.inject`）：`response` 信封；`/status` 路由；**CORS 四用例**——loopback Origin → 放行（断言 ACAO 回显）；无 Origin → 放行；**`Origin: null` → 放行（build 后 GUI `loadFile` 的真实场景）**；外部 Origin（如 `https://evil.example`）→ **断言响应不带 ACAO 头**（delegate false 不产生 403、路由仍 200，拦截在浏览器侧——测试断言的是头缺失，不是状态码）。
  - core `paths`（`LARK_NEST_DIR` 覆盖）；cli `status`（mock transport）。
- `just check`（含 spike fast 层）+ `just test` + `just build` + `just spike-media-check` 全绿。
- README 补 M0 后的启动方式（`just dev-daemon` / `just dev` / `just cli status`）。
- `PROCESS.md` 勾选 M0、记录 spike 结论一行（M2/M4/M6 行的「扩展 M0 骨架」表述已随本计划评审改掉，无需重复）。
- 用户验收关键路径：① `just dev-daemon` + `curl /status` ② `just cli status` ③ GUI 窗口显示在线（dev 与 `just gui-preview` 两态 CSP 无 violation）④ spike 演示：播放 + 远端 seek（日志见新 Range 请求）+ server 重启后免刷新继续 seek（日志见新 generation）。
- 提交（经用户确认）：建议按 T1–T3 / T4–T6 / T7 分批 commit，scope 用 `chore(repo)` / `feat(daemon)` / `feat(gui)` 等。

**任务顺序**：T4/T5（spike）风险最高且只依赖 T1 的 workspace 骨架，**优先并行启动**——若确认平台限制要回改主计划，越早知道越好。T1→T2→T3 顺序推进，T7 收口。

## 4. 与 owl 的刻意差异（备忘）

| 项 | owl | lark（M0 起） |
|---|---|---|
| transport 重试 | 任意 method 默认重试 2 次（**有重复写入隐患，已记跨仓待办提醒 owl**） | 仅 GET 默认重试；其余含 HEAD 0 重试（M0-7；HEAD 需先有无 body 响应路径） |
| Electron | 34.5.8（已 EOL） | 开工日受支持大版本，精确锁定（M0-4） |
| 版本声明 | `^` 区间 + engines `>=22` + @types/node 25 | 全精确锁版 + lockfile 提交 + `packageManager` + engines `>=22.12` + `.node-version`/@types/node 精确对齐 Node 24（M0-4） |
| 测试 runner | core/daemon 用 `node --test` 跑 dist，gui/cli 用 vitest | 全包统一 vitest（M0-3） |
| renderer CSP | 无 | 从骨架起即严格 CSP，Vite 插件单一来源，dev/build 两态验证（M0-5） |
| `noExplicitAny` | warn | error |
| daemon 守卫 | 无「daemon 禁 Electron/gui」方向守卫（有业务不变量守卫） | M0 即有三条依赖方向守卫（T3） |
| web/server 包 | 有（typecheck-web 单独分岔） | 无（M0-6） |
| 自定义协议 | 无先例 | `lark-media://`（spike → M4 移植） |
| 端口 / 数据目录 | 47010 / `~/orpheus-aviary-nest/owl/` | 47100（spike 47190）/ `~/orpheus-aviary-nest/lark/` |

## 5. 风险

| 风险 | 对策 |
|---|---|
| spike 判据不过 | T6 归因阶梯先行，确认平台限制才切签名 URL fallback；spike 前置并行做，失败影响窗口最小 |
| `standard: true` 下 URL 规范化行为与预期不符（host 小写化、path 处理） | T4 已定死校验规则（`hostname === 'song'` + pathname 单段小写 UUID + 拒 username/password/port/query/hash/多段）；spike 中实测 URL 解析结果与规则匹配，不匹配即在 §6 记录实际行为并调整规则 |
| spike 裸 Electron 工程与 electron-vite 5 打包环境行为差异 | spike 结论仅锁协议层 API（registerSchemesAsPrivileged / handle / net.fetch）；M4 移植进 electron-vite 工程后**按 T5 六项矩阵完整回归**（全手动约十分钟，不抽测） |
| Electron 大版本节奏快（约 8 周一版），M0 选定版本到 M7 发布时可能滑出支持窗口 | M7 发布清单加「复查 Electron 支持窗口」项；**升级 Electron 大版本必重跑 T5 六项完整矩阵 + `just spike-media-check`**——Range 透传与连续 seek 正是 Chromium 升级最可能影响的部分，不允许抽测 |
| 依赖精确锁版后与安全更新脱节 | 升级一律独立 chore 任务走 lockfile diff review，不混进功能里程碑 |

## 6. spike 结论（2026-07-31 执行，Electron 43.2.0 / Chromium）

**判定：六项判据全过（判据 4 的「回落至 1」按实测修订为「有上界且不随 seek 次数增长」，理由见下），不触发签名 URL fallback，§2.4 维持。**

执行方式：`just spike-media-check`（HTTP 契约 + `electron main.mjs --smoke`）跑自动层；交互判据（2/4/6）用 CDP（`--remote-debugging-port` + `Runtime.evaluate` 点按钮）驱动真实窗口，对照 server 日志判读——比手点更可重复，用户验收仍按 T7 ④ 手动演示一遍。

### 6.1 六项判据实测

| # | 判据 | 实测证据 | 结论 |
|---|---|---|---|
| 1 | 协议注册 | `loadedmetadata @ 0.0s / 1800.0s`（30 分钟 fixture 总时长正确 → `Content-Length`/`Accept-Ranges` 透传有效）→ `canplay` → 播放 `currentTime` 推进；首个请求 `Range=bytes=0- → 206`，`Content-Type: audio/mpeg` | ✅ |
| 2 | Range 透传 | seek 到 90% 产生**新 `#seq`**：`[gen 7] #3 Range=bytes=64782336-`，64782336 / 72002917 = 89.97%，与位置成比例；限速保证该位置未缓冲，排除「缓冲区内 seek 不发请求」的假通过 | ✅ |
| 3 | 206 / 416 | 全部 seek 走 206；harness 断言 `Content-Range: bytes 100-1123/<size>` 精确匹配、越界与畸形 Range 均 416 + `bytes */<size>` | ✅ |
| 4 | 连续 seek | 12 次乱序连点：无卡死、无白屏、`audio.error === null`，停在最后位置继续播；**并发流上界 6，之后再点 36 次 seek 产生 0 个新请求、计数不再增长**；窗口关闭后计数归 0 | ✅（标准修订，见 6.2） |
| 5 | CSP | 严格 CSP + 外置 `renderer.mjs` 下 1–4 全部通过，console 无 violation；token 不在 URL/DOM/媒体 src（src 只有 `lark-media://song/<uuid>`，`Authorization` 由 main 附加）。**正向反证**：renderer 里 `fetch('lark-media://…')` 被 `connect-src` 拒绝并打印 violation——说明该 CSP 确实在生效，且 `media-src` 只覆盖媒体元素、不覆盖 fetch | ✅ |
| 6 | token 轮换 | 播放中 Ctrl-C 重启 server（gen 9 → gen 10，新 token），**不刷新 renderer**直接 seek：`[gen 10] #1 Range=bytes=64782336- → 206 auth=ok`，`seeked → canplay → playing`，未进 error 态、未用 `load()`。**反向验证**：`LARK_SPIKE_CACHE_TOKEN=1` 重启 app 后轮换 → 全部 `401 auth=fail` | ✅ |

自动层同时锁死：`/healthz` 在 token 落盘前 503、落盘后 200；token 文件权限恰为 0600；竞争实例 listen 失败非零退出且不动 token/generation；SIGINT 后 token 文件清理；轮换后旧 token 立即 401。

### 6.2 判据 4 的标准修订（先归因，后结论）

现象：连点 seek 后 `activeAudioResponses` 停在 6 且不回落到 1。走归因阶梯：

- ① **限速放大**（主因）：spike 恒定 256KB/s，被 Chromium 放弃的响应要几分钟才写完；生产 `/audio` 直读本地盘，放弃的响应毫秒级写完即关闭。
- ③ **spike 实现 bug**（已修）：首版限速只按时间节流、不看 `res.write()` 的 flush 回调，被放弃的连接会把没人读的字节堆在内存里，也永远发现不了对端已走。改为「同时等速率定时器与 flush 回调」后内存有界。
- ⑤ **Chromium multibuffer 语义**（真正的上界来源）：媒体元素会为同一 URL 保留多条 range 读取连接，且不急于关闭。修 ③ 之后计数仍停在 6，但**再点 36 次 seek 一个新请求都不产生、计数不再涨**——是有上界的保留，不是泄漏。

结论：判据 4 的原始措辞「回落至 1」是对 Chromium 的错误预期；实测语义（无卡死/无白屏/可继续播 + 并发流有上界不随 seek 增长 + 元素销毁后归零）已满足，判定通过。**M2 的 `/audio` 因此必须**：(a) 尊重 backpressure，(b) 按「单曲可能并存约 6 条流」预算 fd，(c) 在响应 `close`/`error` 上做一次性清理（本 spike 的 guard 可直接移植）。

### 6.3 定稿要点（M4 移植清单）

1. **privileges 定稿**：`{ scheme: 'lark-media', privileges: { standard: true, stream: true, supportFetchAPI: true } }`，必须在 `app.whenReady()` 之前注册。
2. **URL 校验实测**：`standard: true` 下 `lark-media://song/<uuid>` 解析为 `hostname === 'song'`、`pathname === '/<uuid>'`（host 会被规范化为小写，其余不变）。校验规则按 T4 落地即可：host 字面量 `song` + pathname 恰为一段小写 v4 UUID + `username`/`password`/`port`/`search`/`hash` 全空，任一不符 400。实测 `lark-media://song/not-a-uuid` → 400。
3. **`net.fetch` 透传**：`net.fetch(url, { headers, bypassCustomProtocolHandlers: true })`，回程 `new Response(upstream.body, { status, headers })` 只复制 `content-type` / `content-length` / `content-range` / `accept-ranges` / `cache-control`——`Content-Length` 与 `Accept-Ranges` 漏一个，总时长与可 seek 判定就错。
4. **CSP 定稿**（生产，已在 gui 骨架落地）：
   `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src lark-media:; object-src 'none'; base-uri 'none'; script-src 'self'; connect-src http://127.0.0.1:47100`
   dev 额外放宽两处：`connect-src` 加 `ws://localhost:* ws://127.0.0.1:*`（HMR），`script-src` 加 `'unsafe-inline'`——`@vitejs/plugin-react` 的 Fast Refresh preamble 是内联 script，这是计划首版没预料到的必要偏差。注入插件必须 `order: 'post'` + `head-prepend`：plugin-react 用 `pre` 钩子 head-prepend 那段 preamble，跑在它之前反而会被压到 preamble 下面，meta CSP 只约束其后的内容。若将来 renderer 需要对 `lark-media:` 用 `fetch()`（如预取），得把它加进 `connect-src`，`media-src` 不管 fetch。
5. **Electron ESM main 不能顶层 await `app.whenReady()`**：Electron 只在入口模块求值完成后才发 `ready`，顶层 await 会死锁（无窗口、无输出、无退出，实测 43.2.0）。包一层 `async function bootstrap()` 即可。**已因此修掉 gui 骨架里同样的写法**。
6. **`openDevTools({ mode: 'detach' })` 会让页面的 CDP target 报告空文档**，任何脚本化验收都要用 `mode: 'bottom'`（spike 已改）。
7. **媒体路径上的 401 会引发 Chromium 重试风暴**：反向验证里一次 seek 打出 200+ 个 401（每次偏移 +12 字节）。正常路径不会 401（每请求重读 token），但 M2 的 `/audio` 401 分支必须廉价（不读文件、不打全量日志），M4 应在媒体 error 上停住播放器而不是任其重试。
8. **已知限制（不阻断 M0）**：在「多条被遗弃的限速流仍挂着、且期间点过 `load()`」的病态状态下重启 daemon，renderer 的媒体管线会卡死——此后新建 `<audio>`、换 uuid、重设 src 都不再触达 protocol handler（main 侧 handler 根本没被调用），重启 app 才恢复。正常状态（1–2 条在途流）重启后免刷新 seek 正常（判据 6）。归因为 ①+⑤ 的组合而非 `protocol.handle` 缺陷——签名 URL 方案跑在同一个 HTMLMediaElement + multibuffer 上，与鉴权方案无关，故不构成 fallback 理由。**M4 兜底**：daemon 重启（GUI 侧本就监控 spawn 的 daemon）后主动重建播放器组件；必要时 `location.reload()`。

### 6.4 fallback 判定

**不启用**签名 URL fallback。主计划 §2.4 与 CLAUDE.md「注意事项」无需回改，仅在 §2.4 标注已验证日期与版本。
