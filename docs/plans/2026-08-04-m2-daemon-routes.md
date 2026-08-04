# lark M2 计划：daemon 基础路由

> 2026-08-04 首版；同日一轮评审修订 14 项：① PID 内容严格校验 + 损坏/EPERM fail-closed + `stop-daemon`/`daemon-status` 经 `/status` 确权；② shutdown 逆序（PID 最后释放、owner-checked、单一幂等 promise）；③ boot 失败统一 teardown 状态机；④ player 命令单消费者协议；⑤ PATCH /config clone→save→swap；⑥ core 补 `getPlaylist` 与 `library/lyrics.ts`；⑦ transport 补 `authHeaders()` + SSE headers 单快照；⑧ 输入契约冻结（source 回 M1 四象限）；⑨ player 线协议逐命令冻结；⑩ 预期 4xx 不进 error 日志；⑪ capabilities 守卫过滤规则；⑫ 测试 hermetic 化；⑬ SSE 埋坑处置（背压断开、CORS 回显过 allowlist、`lyrics:changed`、last_accessed 去抖）；⑭ 日志卫生守卫收紧。
> 同日二轮评审修订 13 项：① gui 恢复协议（未注册 gui_id → 409 拒绝，不静默降级）+ 注册表过期；② 端口 seam 收编测试专用（正式 CLI 恒 47100）；③ PATCH /config 提交边界拆分（rename 前/后 + 重载对齐 + fatal）+ 域常量上移 shared；④ errorHandler 三分类（Fastify 4xx 保状态码）；⑤ exit 语义拆分 teardown/shutdown/abortBoot；⑥ signal handler 提前至取得 PID 后；⑦ stop-daemon 等待退出；⑧ 删 generation 残留措辞；⑨ token 测试保证拆分（不虚假覆盖）；⑩ 守卫正则 alternation 修正 + 挪 code block；⑪ 输入契约补（未知 body 字段/boolean/safe int/长度/trim 写入）；⑫ 不引入 `removeLocalTokenFile`；⑬ `lyrics:changed` 回写主计划 §4。
> 同日三轮评审修订 10 项：① **`fatal` 重定义为幂等非等待的 `requestFatal(err): void`**——原「路由内调 fatal = teardown + exit」会死锁：teardown 的 `server.close()` 等当前请求结束、当前请求在 await fatal；改为路由先回 500 再返回，下一轮事件循环启动 teardown，子进程测试确认最终 exit 1；② **boot 显式生命周期状态机** `booting → running → stopping → stopped`、终止原因 first-wins——信号落在 `listen()` 等待中时 shutdown 与 boot 续体存在 exit 0/1 双出口竞态；listen 后、发布 token 前必须检查状态，`abortBoot` 不得覆盖已开始的 shutdown；补「信号与 listen 并发」的确定性子进程用例；③ **守卫脚本退出语义修正**——裸 rg 命中退出 0/无命中退出 1，语义恰好相反，且 pipefail 下双重退出码问题；改为脚本捕获输出按「非空即违例」判定、末尾显式 exit；secret 正则改**只匹配字段位置**（`token:` / `{ token,`），不再把 `"token rotated"` 消息文本误判；④ **`guiChannel.close()` 进 teardown 序列**（server 关闭后、bus 之前）——注册过期 timer、active 引用、断线后新建的过期 timer 会在模块测试与 `app.close()` 后遗留 handle；timer 一律 `unref()`；⑤ daemon `context.ts` 的 `Logger` 接口补 `debug`、**删除 console-backed `createConsoleLogger`**（会被新守卫拦截且不在豁免清单，测试改注入 no-op/记录 stub，不为它开豁免口子）；⑥ **409 后旧 SSE 重试循环处置**——`onDisconnect` 支持返回 `'stop'` 终止重试循环，M4 流程冻结为「abort 旧订阅 → 重新 register → 新 controller 新 gui_id 建订阅」，T1 断言 409 → stop 后无第二次请求；⑦ **注册表容量满语义**（8 个全在关联态时第 9 次注册 → 409 `GUI_CAPACITY`）+ **`sendToActive` 返回发送结果**（active 在检查后瞬断/写抛错 → 立即清 pending 回 `GUI_OFFLINE`，不等 3s 超时）；⑧ 域常量共享范围收窄为**明确清单**（config 侧仅 `LOG_LEVELS`；另补 `PLAY_MODES`/`SONG_SORT_FIELDS`/`SORT_ORDERS` 运行时常量进 shared——daemon 校验与 core/GUI 同源），数值下限不共享、靠双侧交叉测试约束；⑨ DB 错误分型去掉数量词（漏了 `DestructiveForwardMigrationError`），改显式映射 + catch-all；⑩ **未知 query 字段同样 400**（`?srot=name` 拼写错误不得静默用默认值）。
> 上游：`2026-07-16-ts-rewrite-master-plan.md` §6 M2 行 + §2.2 + §2.4（R21/R29）+ §4（API 表）+ R3/R10/R11/R14/R15/R23/R24；`2026-07-31-m0-scaffold-media-spike.md` §6.2 + §6.3-7 + M0-2 + M0-8；`2026-07-31-m1-core-data-layer.md` M1-15 + T4（source 四象限）。
> 完成标准（主计划）：`just check` 全绿 + 对应测试绿 + 用户验收关键路径。**链接 / 下载 / 缓存 / 导入导出路由不在此（M3/M5）。**

## 0. 目标

1. **daemon 生命周期正式化**：boot 编排（PID 锁 → 装 signal → DB → ctx 生成 token → buildServer → listen → 原子发布 token）+ 显式生命周期状态机（booting/running/stopping/stopped，first-wins）、幂等 `teardown` + `shutdown`(0) / `abortBoot`(1) / `requestFatal`(1)、`stop-daemon` / `daemon-status`（经 `/status` 确权 + 等待退出，M0-8 兑现）、DB 接线（全错误类友好报错退出）。
2. **全接口 Bearer 鉴权**：`GET /status` 唯一豁免；preHandler gate + notFound 先鉴权 + timing-safe + Host 头检查；401 分支廉价（spike §6.3-7）。
3. **SSE**：daemon 侧 EventsBus + `GET /events`（gui 注册/active 单消费者 R11、未注册 gui_id 409、心跳、断线清理、`preClose` 关流、写侧背压断开、`guiChannel.close()` 全清理）；shared 侧 fetch-based SSE client（含 `'stop'` 重试控制）。
4. **业务路由**：songs / playlists（虚拟 all R3/R24）/ audio（Range，spike 三义务）/ lyrics（GET/DELETE，core 单一写路径）/ player（状态 + 命令 ack 链路 R11）/ config（GET 脱敏 + PATCH 白名单、提交边界明确 R14）/ `GET /api/capabilities`。
5. **测试与守卫基建**：`buildTestServer`、真实 listen 测试模式（测试专用 child entry + port 0）、capabilities 覆盖守卫、日志卫生 grep 守卫（M1-15 遗留兑现，退出语义正确版）。

## 1. 范围

**M2 做**：上述五项 + core/shared 小补（`getPlaylist`、`library/lyrics.ts`、`LOG_LEVELS`/`PLAY_MODES`/`SONG_SORT_FIELDS`/`SORT_ORDERS` 运行时常量入 shared）+ 对应 vitest 测试 + justfile `stop-daemon` recipe 与 test 前置 build。**daemon 无新增 npm 依赖**。

**M2 明确不做**：

| 推迟项 | 去处 | 理由 |
|---|---|---|
| `POST /songs/import`（本地 mp3） | M3 | 依赖 ffprobe 与文件落盘管线（M1 已推 M3） |
| `PUT /songs/:id` 的**联网规范化**（URL → p→cid） | M3 | M2 只接受显式 source 字段 + core 语法校验；`recognize-url` / `redownload` 同属 M3 |
| `/download/*`、`POST /download/lyrics/:id` | M3 | 下载管线 |
| `/cache/*` | M5 | 缓存模型 |
| `GET /playlists/:id/export`、`POST /playlists/import` | M5 | 导入导出 |
| GUI 消费（preload token、SSE 订阅、注册重连循环、lark-media 代理） | M4 | M2 冻结协议与 409 恢复语义，M4 实现调用方 |
| CLI 面向用户命令扩展 | M6 | daemon `./cli` 仅加自身生命周期命令（M0-8 分工） |
| sync 事件写入 | v0.2 | R2 |
| player 状态持久化 | 不做 | renderer 会话态，daemon 只做内存镜像（M2-11） |
| SSE 下载进度事件合并/限频 | M3 | M2 只落写侧背压断开兜底（M2-6） |

**工具前置**：无新增（`/audio` 验收用 M1 的副本迁移库中的真实 mp3）。

## 2. 调查实测（2026-08-04）

### 2.1 owl 基线（照抄源，代码级核对过）

照抄对象：`owl/packages/daemon/src/{pid,local-token,boot,server,auth,response,context}.ts`、`events/bus.ts`、`routes/{events,config,system}.ts`、`ai/sse.ts`、`testing/build-test-server.ts`、`shared/src/sse.ts`。要点：

- **PID 锁三段式**（`pid.ts`）：`openSync(p,'wx')` 排他创建 → EEXIST 时 `readPid()`（自带 GC）→ 重试一次；不是 check-then-write。**owl 三处缺陷 lark 不照抄（M2-3）**：只排 NaN（空文件→0、负数合法——SIGTERM 0/负数作用于进程组）；`kill(pid,0)` 抛错不分 ESRCH/EPERM 一律当陈旧 unlink；`stop-daemon` 直接信任 pid 文件发信号。
- **token 生命周期**：32 字节 CSPRNG → base64url；ctx 组装时生成（仅内存）；`listen()` 成功后同步原子发布（'wx' 0600 + rename）；发布失败致命；每次 boot 轮换；**shutdown 不删 token 文件**。owl 的 `removeLocalTokenFile` 仅服务 cloud——lark 不引入。
- **鉴权用 `preHandler`**（cors 在 onRequest 答复 preflight）；豁免仅 `GET /status`（剥 query）；`timingSafeEqualStr` 先比长度；notFoundHandler 先鉴权；fail-closed。**Host 头检查**独立于 CORS。
- **SSE 三个坑**：① hijack 跳过 onSend，CORS 头须手动回显——owl 无条件 echo，**lark 先过 `isOriginAllowed`**；② 无局部 `preClose` 则 `server.close()` 挂死；③ 不用 `forceCloseConnections`。心跳 15s 注释行；cleanup 幂等；连接即发 `hello`。
- **EventsBus 极简**：Set + 快照派发 + 吞异常。
- **shutdown / stop**：owl removePid 先于 server.close——lark 改 PID 最后（M2-4）；owl stop 发完 SIGTERM 即返回——lark 补等待（M2-3）。
- **errorHandler**：owl 一切 throw 记 error——lark 三分类（M2-8）。
- **config 路由**：GET redact（字段消失不用哨兵）；PATCH 白名单 + 校验 + deepAssign + save——lark 改 clone→save→swap + 失败重载对齐（M2-12）。
- **capabilities**：手写静态清单无同步测试——lark 补双向守卫（M2-13）。
- **测试基建**：`buildTestServer`（inject 自动带 bearer + injectRaw）；SSE 真 listen(port 0) + fetch + AbortController；shutdown 预算断言（<1000ms）；fs 测试 env 重定向临时 nest；陈旧 pid 999999；路由覆盖守卫 = bare Fastify + register 函数 + onRoute。
- owl 无先例、lark 自研：gui 单消费者/恢复协议、player ack 链路、`/audio` Range（以 spike `server.mjs` 为参照）。

### 2.2 lark 现状盘点

- **daemon（M0 骨架）**：`buildServer`（cors + 信封化 handler）、`response.ts`、`access-guard.ts`、免鉴权 `/status`、前台 `daemon` 子命令（M1-15 已接 core pino）。**M2 必改的冲突点**：notFoundHandler 无鉴权；无 Host 检查；errorHandler 一切 throw 记 error；**`context.ts` 的 `Logger` 接口无 `debug`（T6 的 per-request debug 日志需要）**；**`context.ts` 的 console-backed `createConsoleLogger` 用 `console.log`——会被 M2-15 守卫拦截且不属 cli/boot 豁免，直接删除**（测试注入 no-op/记录 stub，不为它开豁免）。
- **core（M1 交付）**：CRUD 全套（`…InTx` 两层）、`songFileInfo`、本地字段路径、结构化错误类、`redactConfig`/`saveConfig`、`createDatabase`。**boot 需接住 `createDatabase` 的全部错误类（显式映射 + catch-all，不写数量——清单见 M2-1，含 `DestructiveForwardMigrationError`）**。**缺口（本里程碑补）**：`getPlaylist` 未导出；歌词文件无 core 入口（补 `library/lyrics.ts`）；`LOG_LEVELS` 是 core 私有常量、shared 只有类型（上移 shared）。`sanitize` 是磁盘容错语义，PATCH 严格校验在 daemon 侧另写。**`saveConfig` 提交边界**：rename 之后还有终态权限断言可能抛错——「保存失败 = 磁盘未动」只对 rename 前成立（M2-12）。
- **shared**：transport 只导出 `baseUrl()`——补 `authHeaders()`；`API_PATHS` 只有 `/status`；`sse.ts` 未建；**PlayMode/sort/order 只有类型层概念，无运行时常量可供 daemon 校验共源**（T1 补）。
- **spike 可移植资产**（`spikes/media-protocol/server.mjs`）：`parseRange`（畸形/越界合并 invalid → 416 `bytes */<size>`）、200 路径必带 `Content-Length`+`Accept-Ranges`、一次性 release guard、背压义务（不封顶 206）。
- **Go 版 PlayMode 枚举**（`lark-go/frontend/src/hooks/usePlayer.ts:5`）：`'sequential' | 'repeat-one' | 'repeat-all' | 'shuffle'`。
- **真实 nest 现存 Go 版 `daemon.pid`**（M1 §2.1）：与 `paths.pidPath()` 同一路径——见 M2-3。
- **justfile / vitest 现状**：`test-daemon` 不前置 build；daemon vitest 默认线程池（M2 起加载 better-sqlite3，M1-14 同因切 fork）——T2/T9 修正。

## 3. M2 内定决策（有异议随时推翻）

| # | 决策 | 说明 |
|---|---|---|
| M2-1 | **boot 编排抽 `boot.ts` + 显式生命周期状态机**（三轮 ②）。状态 `booting → running → stopping → stopped`，**终止原因 first-wins**（`beginStop(reason)`：`signal` → 退出码 0、`boot-failure`/`fatal` → 1；后到原因不覆盖先到）。顺序：mkdir larkDir → `loadConfig` → `createLogger` → **`acquireDaemonLock`** → **立即安装 SIGINT/SIGTERM**（handler = `beginStop('signal')`，任一时点收信号都按状态机走）→ `createDatabase` → 组装 ctx（token 进内存）→ `buildServer` → `listen` → **状态检查：已 stopping 则跳过发布直接走 teardown**（信号落在 listen 等待中的竞态出口收敛）→ `publishLocalToken` → 置 `running` → 终端 listen 提示（含实际端口）。**出口函数**：`teardown(acquired)` = 幂等清理原语，逆序——reject pending 命令 → close server（若已 listen）→ **`guiChannel.close()`**（三轮 ④）→ bus.close → sqlite.close → owner-checked removePid，不 exit；`shutdown()` = `beginStop('signal')` 驱动 → teardown → exit 0；`abortBoot(err)` = `beginStop('boot-failure')` → 分型文案 → teardown → exit 1，**不得覆盖已开始的 shutdown**（first-wins 保证）；**`requestFatal(err): void`**（三轮 ①）= 幂等**非等待**：记录 error → `beginStop('fatal')` → `setImmediate` 启动 teardown → exit 1——**调用方（路由）先形成 HTTP 响应并返回，绝不 await**，否则 server.close 等当前请求、当前请求等 fatal 即死锁。`createDatabase` 错误显式映射（不写数量）：`GoMigrationRequiredError` → 指引 `just migrate-go`；`MigrationBusyError` → 「迁移进行中稍后再试」；`IncompatibleDbError` / `SchemaMismatchError` / `MigrationResidueError` / `ForwardMigrationError` / `DestructiveForwardMigrationError` → 「数据库无法打开」+ 错误名与 message；**其余未知错误 catch-all** 同文案。**端口**：正式 CLI 恒 47100 不读端口 env；`BootOptions { resolveConfig?, port? }` 的 `port` 是程序级测试 seam（safe integer 且 0 或 1..65535，非法即抛）；子进程测试走 M2-17 child entry | GUI M4 spawn 与 CLI 共用同一序列 |
| M2-2 | **不做 `/status` 503 readiness 门控**（偏离 spike）：`publishLocalToken` 是 listen 续体里的同步 fs 调用——请求回调（宏任务）插不进「listen resolve → 同步发布完成」的微任务续体，「/status 可达 ⇒ token 已落盘」由执行模型保证。**保证来源是论证 + boot.ts 注释（publish 决不改异步），不是测试**：子进程观测点在 stdout 端口行之后，只能证明「boot 轮换了 token」——测试如实命名为轮换断言，不冒充 readiness 竞态覆盖 | |
| M2-3 | **PID 协议（收紧 owl）**。`readPid()`：trim 后须 `/^\d+$/` 且 `Number.isSafeInteger` 且 `> 1`；**仅 ESRCH 算陈旧**（unlink + null）；EPERM 或其他 → 不删、按运行中处理。**内容非法 → fail-closed**：抛 `PidFileCorruptError` 报路径指引手查（非法内容可能是并发实例 'wx' 后写 pid 前的瞬时窗口，fail-closed 恰好正确）。`removePid()` owner-checked。**`stop-daemon` 确权 + 等待**：GET `/status`（短超时）→ 200 且 `status.pid === 文件 pid` → SIGTERM → 每 200ms 轮询（/status 不可达且 pid ESRCH，或 pid 文件消失），5s 上限——完全退出才报成功（0）；超时报「信号已发送但 daemon 尚未退出」（1）；`/status` 不可达且 ESRCH → 清陈旧报「未在运行」；无法确权（pid 活但无响应 / 两侧不一致 / EPERM）→ 拒绝并说明。**`daemon-status`** 以 `/status` 为准；仅 pid 文件 → 「pid 文件存在但 daemon 无响应」。**与 Go daemon 同路径共存**：Go 在跑 → 拒启，文案注明「可能是 Go 版」。pid 文件不作身份证明（M4 走 `/status.pid === child.pid`）。**token 文件 shutdown 不删** | |
| M2-4 | **shutdown 单一幂等 promise，PID 最后释放**。SIGINT/SIGTERM 汇入 `beginStop('signal')`（首因创建 promise，重复返回同一个）→ teardown 逆序（M2-1）→ exit 0。偏离 owl removePid-first：先删 pid 会让新 daemon 在旧 daemon 仍持 DB 时开同一库 | |
| M2-5 | **AppContext M2 形态**：`{ config: LarkConfig, host, port, configPath?, saveConfigImpl?, requestFatal, logger, db, sqlite, localToken, eventsBus, guiChannel, player, ackTimeoutMs, version }`——`saveConfigImpl?` 注入 post-rename 失败（M2-12）；`requestFatal` 由 boot 注入（幂等非等待，测试注入记录 stub）；`ackTimeoutMs` 默认 3000。**`Logger` 接口补 `debug`；删除 context.ts 的 console-backed `createConsoleLogger`**（三轮 ⑤：会被守卫拦且不在豁免清单，不为它开口子；测试注入 no-op/记录 stub）。可变 handle 挂 ctx | |
| M2-6 | **EventsBus + `/events` + gui 单消费者通道与恢复协议**。bus 照抄 owl（广播事件）；SSE 原语照抄（hijack + flushHeaders + `event:/data:` 单行 JSON），CORS 回显先过 `isOriginAllowed`；15s 注释心跳；幂等 cleanup；局部 `preClose`。**gui 协议**：`POST /gui/register` `{pid, version}` → 返回 `gui_instance_id`；GUI 以 `GET /events?role=gui&gui_id=<id>` 建 SSE；**未注册/已过期 `gui_id` → hijack 前 409 `GUI_REGISTRATION_REQUIRED`（信封）**——不静默降级（daemon 重启清空注册表后，降级会让 GUI 重连成功却永久失去 player 通道且无恢复信号；409 驱动 M4 重注册循环）；普通订阅 = 不带 `role=gui`。`guiChannel`：注册表 + 连接关联 + **active = 最新成功关联者**（新连接接管，旧连接降普通订阅）+ **`sendToActive(event): boolean`**（三轮 ⑦：active 缺失/写入抛错/连接已毁 → false，调用方立即失败不等超时）+ `onActiveClose` + `guiOnline()` + **`close()`**（三轮 ④：清全部过期 timer、注册表、连接引用、回调，幂等，进 teardown 序列；timer 创建即 `unref()`）。**注册表策略**：「注册后未关联」或「断线后」超 10 分钟过期（重关联取消计时）；容量 8——淘汰最旧**未关联**项，**8 个全在关联态时第 9 次注册 → 409 `GUI_CAPACITY`**（三轮 ⑦）。`player:command` 不走 bus，`sendToActive` 定向写。**SSE 写侧背压兜底**：写后查 socket `writableLength`，超 1MB 断开该连接（重连 + hello 全量刷新自愈）；`download:status` 高频合并随 M3 | |
| M2-7 | **事件类型 v0.1 全集**（shared `LarkEvent` 判别联合）：`hello`、`songs:changed`、`playlists:changed`、**`lyrics:changed {song_id}`**（主计划 §4 增补，T9 回写）、`player:command`（active 单播）；`download:status/complete/error`、`cache:evicted`（类型就位，M3/M5 才发）。payload 极简（data-bus 刷新信号，不做补发）。发射点在路由层写成功后 | |
| M2-8 | **errorHandler 三分类**：① core 业务错误（`NotFoundError`→404、`InvalidIdError`→400 `INVALID_ID`、`InvalidSourceError`→400 `INVALID_SOURCE`、`SourceKeyConflictError`→409（details 带冲突 id）、`InvalidReorderError`→400）→ 预期 4xx 信封，不打 error；② Fastify 自身错误且 `400 ≤ statusCode < 500`（malformed JSON 400、body 超限 413、Content-Type 415…）→ 保留原状态码，error_code 取 `err.code` 兜底 `BAD_REQUEST`，不打 error；③ 其余 → 500 `INTERNAL_ERROR` + error 级含堆栈 | 单点映射 |
| M2-9 | **songs 路由**：`GET /songs`（query → `listSongs`，enrich `has_file`/`file_size`，带 `total`）、`GET /songs/:id`、`PUT /songs/:id`（name/artist/lyrics_offset/duration + source 按 M1 四象限，组合语义交 core `normalizeSource`，不联网规范化）、`DELETE /songs/:id`（trash 协议）、`PUT /songs/:id/pin`（`setPinned`）。事件：PUT/DELETE/pin → `songs:changed`；DELETE 另发 `playlists:changed`。输入契约 M2-16 | |
| M2-10 | **playlists 路由 + 虚拟 all（R3/R24）**：`all` 只在路由层。`GET /playlists` → 首位合成 all（`{id:'all', name:'all', created_at:0, updated_at:0, song_count:<总数>}`）+ `listPlaylists`；`GET /playlists/:id` → all 合成 / UUID 走 core 新增 `getPlaylist`；`GET /playlists/:id/songs` → all = `listSongs`（created_at asc 全量）/ 普通 = `getPlaylistSongs`（全量不分页）；POST/PUT/DELETE/成员增删/reorder（M1 锚点契约）。写类命中 all → 400 `VIRTUAL_PLAYLIST`；id 非 `all` 非 UUID → 400。写成功 → `playlists:changed`。输入契约 M2-16 | |
| M2-11 | **player 通道（R11），线协议冻结**。内存 `{ last_report: PlayerStatusData \| null, reported_at: number \| null }`；shared `PlayMode`（Go 版四值）。**命令表**：`play {song_id:uuid}`（须存在→404）；`play-playlist {playlist_id: uuid\|'all', song_id?: uuid}`（成员归属不校验）；`switch-playlist {playlist_id}`；`pause`/`resume`/`next`/`prev`（无 payload）；`seek {position: 有限数 ≥0}`；`mode {mode: PlayMode}`。流程：无 active → 409 `GUI_OFFLINE`；有 → `request_id = randomUUID()` → pending map（关联 active 连接）→ `sendToActive(...)` **返回 false → 立即清 pending 回 409 `GUI_OFFLINE`**（三轮 ⑦，不等超时）→ 等 ack ≤ `ackTimeoutMs`；`ok=true` → 200；`ok=false` → 502 `GUI_ERROR`（转发 message）；超时 → 504 `GUI_TIMEOUT`；active 断线 → 在途 pending 立即 409；shutdown → 503 `SHUTTING_DOWN`。`POST /player/ack` `{request_id, ok, message?}`：迟到/未知 → 200 幂等忽略。`POST /player/report`：全量形状校验（非法 400 不入内存）；不做 active 确权。`GET /player/status` → `{gui_online, player, reported_at}` | player 状态不落库 |
| M2-12 | **config 路由（R14），提交边界明确**：`GET /config` → `redactConfig(ctx.config)`。`PATCH /config`：① `structuredClone(ctx.config)` → ② clone 上白名单过滤（未知 key → 400 `INVALID_CONFIG`）+ 值校验严格拒绝（400 指明字段；**域常量共享收窄为明确清单（三轮 ⑧）：config 侧仅 `LOG_LEVELS` 上移 shared 同源**——其余是数值下限，两侧语义不同（load 收敛 vs PATCH 拒绝）且值极简单，不抽共享、靠 T8 双侧同值交叉测试约束）+ deepAssign → ③ `saveConfig(clone)`（经 `ctx.saveConfigImpl`）→ ④ 成功才 `ctx.config = clone` → 返回 redacted。**失败路径**：catch 内一律 `loadConfig(ctx.configPath)` 重载磁盘真值并 `ctx.config = reloaded`（rename 前失败得旧值、rename 后失败得新值，都对齐磁盘）→ 500 `SAVE_FAILED`（message 注明「以 GET /config 为准」）；**重载也失败 → 回完 500 后调用 `ctx.requestFatal(err)`（不 await，三轮 ①）**。`api_key` 空串 = 清除。log.* 重启生效，message 注明 | |
| M2-13 | **capabilities**：`GET /api/capabilities` → `{ name:'lark', version, endpoints:[{method, path, description}] }` 手写清单，只列已实现端点。**双向覆盖守卫**：server.ts 导出单一来源 `registerAllRoutes(app, ctx)`；测试自建 bare Fastify、先挂 `onRoute` 再注册；比较集 = 显式 GET/POST/PUT/PATCH/DELETE（排除隐式 HEAD；守卫测试不注册 cors 即无 OPTIONS）；双向断言 | |
| M2-14 | **shared `sse.ts` + transport 补口**：transport 导出 `authHeaders()`。`sse.ts` 抄 owl `parseSseBlock` + `subscribeSse`（fetch-based；分帧 + 末尾 drain；退避 `[1s,2s,4s,8s,15s]` 连上重置；`AbortSignal` 终止；`onDisconnect` 每连接恰一次）。**每次连接取一份 headers 快照**（同一对象作请求头 + 算 `usedToken`）。**非 2xx 拒绝（如 409）时状态码与响应体交给 `onDisconnect`，且 `onDisconnect` 可返回 `'stop'` 终止重试循环**（三轮 ⑥——否则旧循环按原 gui_id 无限重试）；**M4 恢复流程冻结**：收 `GUI_REGISTRATION_REQUIRED` → 返回 `'stop'`（或 abort）→ 重新 `/gui/register` → 新 AbortController + 新 gui_id 建新订阅。owl 的 `streamSse` 不抄 | |
| M2-15 | **日志卫生守卫（M1-15 遗留）**：`scripts/check-log-hygiene.sh` 进 `just check`。**判定基于「捕获输出非空即违例」，与 rg 退出码解耦**（三轮 ③：rg 无命中退出 1 恰是通过态，裸 rg 进 recipe 语义正反颠倒）；末尾显式 exit。三条规则（排除 `*.test.ts`；命令定稿见 T9 code block）：① 禁 `console.log/error/warn`，行级豁免 `// log-hygiene: console-ok`（cli.ts/boot.ts 合法终端行逐行标注）；② secret 进 logger 内联对象——**只匹配字段位置**（`token:` / `{ token,` 等，含 shorthand），不误判 `"token rotated"` 消息文本；200 字符多行窗；③ config 整体注入（`config:` 字段 / `...config` 展开 / 直传 `ctx.config`）。**有界近似**：变量间接、超窗调用能绕过——红 = 必错，绿 ≠ 必对；与 redact 单测、Public 投影约定三层防线 | |
| M2-16 | **路由输入契约**（violation → 400 `INVALID_BODY` / `INVALID_QUERY` / `INVALID_ID`）。**通则**：body 须 JSON object；**未知 body 字段 → 400**；**未知 query 字段 → 400**（三轮 ⑩：`?srot=name` 不得静默用默认）；空 PUT/PATCH → 400。**query**：`search` trim ≤200；`sort` ∈ `SONG_SORT_FIELDS`、`order` ∈ `SORT_ORDERS`（shared 运行时常量，缺省从 core 默认）；`limit` safe integer 1..1000、`offset` safe integer ≥0。**字符串**：song/playlist `name` **trim 后写入**、非空 ≤500；`artist` trim 后写入、可空串 ≤500；`ack.message` ≤500；`source_url` ≤2048、`source_key` ≤256、`source_provider` ≤64（长度是 daemon 护栏，组合语义交 core）。**数值**：`lyrics_offset` 有限数；`duration`/`seek.position` 有限数 ≥0；`gui/register.pid` safe integer >1。**布尔**：`pinned`、`ack.ok` 必须 boolean。**id 类**：一切 id 过 `isUuidV4`；`song_ids` 非空 ≤1000 | 上限是防御性护栏非产品限制 |
| M2-17 | **测试 hermetic 化**：daemon vitest 切 `pool: 'forks'`；justfile `test-daemon`/`test` 前置 `build-shared build-core build-daemon`；子进程走专用 child entry `packages/daemon/src/testing/boot-child.ts`（编进 dist；读 `LARK_DAEMON_TEST_PORT`（缺省 0）调 `boot({port})`，**该 env 只被 testing entry 读取**；另设两个测试专用注入：`LARK_TEST_STALL_BEFORE_LISTEN_MS`（listen 前停顿——「信号与 listen 并发」用例的确定性交错点）、`LARK_TEST_FATAL_AFTER_MS`（boot 完成后触发 `requestFatal`——验证真实 exit 1））+ 临时 `LARK_NEST_DIR`，从 stdout listen 行解析实际端口——避免端口冲突（受限沙箱对 port 0 也可能 EPERM，属环境问题）。子进程用例控制在个位数 | |

## 4. 任务分解

### T1 shared 扩展（线协议 + SSE client + transport 补口）

- `transport.ts`：导出 `authHeaders()`。
- `config-types.ts`：增 **`LOG_LEVELS` 运行时常量**（`as const`，`LogLevel` 从其派生）；core `sanitize` 改为引用（行为不变）。
- `types.ts` 增：`PlayMode` + **`PLAY_MODES` 运行时常量**、**`SONG_SORT_FIELDS` / `SORT_ORDERS` 运行时常量**（daemon query/命令校验与 core/GUI 同源，三轮 ⑧）、`PlayerStatusData`、`PlayerStatusResponse`、`PlayerCommandName` 与逐命令 payload、`AckRequest`、`GuiRegisterData`、`CapabilitiesData`、`LarkEvent` 判别联合（含 `lyrics:changed`）。
- `api-paths.ts`：全量路径常量/函数。
- `sse.ts`（M2-14：parseSseBlock + subscribeSse + headers 快照 + `onDisconnect` 返回 `'stop'` 支持）+ barrel。
- 测试：`parseSseBlock`；`subscribeSse` mock fetch（首连交付、退避重连、abort 终止、`onDisconnect` 恰一次、非 2xx 状态码/响应体到达 onDisconnect、**409 → 返回 `'stop'` → 断言无第二次请求**（三轮 ⑥）、headers 快照与 usedToken 同源）。

**验收**：`just test-shared` + `just test-core`（LOG_LEVELS 迁移回归）绿；`shared-node-free` 守卫仍绿。

### T2 daemon 生命周期（pid / token / boot / stop）

- `pid.ts`（M2-3）：`readPid` / `acquireDaemonLock`（含 `PidFileCorruptError` fail-closed）/ `removePid`（owner-checked）/ `DaemonAlreadyRunningError`。
- `local-token.ts`：`generateLocalToken` / `publishLocalToken`（owl 逐字；不引入 `removeLocalTokenFile`）。
- `boot.ts`：M2-1 全量（生命周期状态机 + first-wins `beginStop` + signal 提前安装 + listen 后状态检查 + teardown/shutdown/abortBoot/requestFatal + 同步发布不变量注释 + `BootOptions` 校验）。
- `testing/boot-child.ts`（M2-17：`LARK_DAEMON_TEST_PORT` + `LARK_TEST_STALL_BEFORE_LISTEN_MS` + `LARK_TEST_FATAL_AFTER_MS`）。
- `cli.ts`：`daemon` 调 `boot()`（恒 47100）；`stop-daemon`（确权 → SIGTERM → 200ms×5s 等待 → 分报）；`daemon-status`（以 /status 为准）。
- justfile：`stop-daemon` recipe；`test-daemon`/`test` 前置 build；daemon `vitest.config.ts` 切 fork 池。
- 测试：pid 模块（'wx' 竞争、陈旧 999999、活 pid 拒绝、空文件/`0`/负数/非数字 fail-closed 不删、owner-checked removePid）；token 模块（0600、无 `.tmp` 残留、rename 覆盖、失败清理）；**子进程集成**（boot-child + 临时 nest）：① 正常 boot——预置旧 token → 首个 /status 200 时内容已更换且 0600（**token 轮换断言**，M2-2 措辞）；② 第二实例拒启（非 0 退出、token 文件不被改动）；③ SIGTERM——pid 消失、token 保留、exit 0、挂着的 SSE 被 preClose 收尾（1s 内退出）；④ Go 旧库 fixture → 非 0 + stderr 指引 + pid 已清理；⑤ **信号与 listen 并发**（`LARK_TEST_STALL_BEFORE_LISTEN_MS` 停顿期发 SIGTERM）→ exit 0、**token 未发布**、pid 清理（三轮 ②）；⑥ **`requestFatal` 真实退出**（`LARK_TEST_FATAL_AFTER_MS`）→ exit 1、pid 清理（三轮 ①）；⑦ stop-daemon 确权——pid 文件指向活着的非 daemon 进程 → 拒绝不发信号。

**验收**：`just test-daemon` 绿；手动 `just dev-daemon` + `just stop-daemon` 往返。

### T3 server 骨架升级（ctx / 鉴权 / Host / 错误映射 / 测试基建）

- `context.ts`：AppContext 升级（M2-5）；**`Logger` 接口补 `debug`；删除 console-backed `createConsoleLogger`**（测试注入 no-op/记录 stub）。
- `auth.ts`：`bearerToken` / `timingSafeEqualStr` / `isPublicPath` / `checkLocalToken`（401 零日志）。
- `access-guard.ts` 补 Host 检查；`server.ts`：Host → 鉴权 preHandler → notFound 先 gate → `setErrorHandler` 三分类（M2-8）→ fail-closed → `registerAllRoutes`（单一来源）。
- `testing/build-test-server.ts`。
- 测试：鉴权全套（含 `/status?x=1`、未注册路径 401/404）；Host 检查；错误三分类——core 各错误类映射（含**不产生 error 日志**断言）、malformed JSON 400 / 超 bodyLimit 413 / 错误 Content-Type 415（保留状态码 + 不打 error）、未知 throw → 500 + error 日志（记录 logger）；CORS 四用例回归。

**验收**：`just test-daemon` 绿。

### T4 EventsBus + /events + gui 通道

- `events/bus.ts`（owl 逐字）+ shared 事件类型接线。
- `events/gui-channel.ts`（M2-6）：注册表（过期 10 分钟 + 容量 8 + `GUI_CAPACITY`）、连接关联、active 接管、`sendToActive(): boolean`、`onActiveClose`、`guiOnline()`、**`close()`（幂等，清 timer/注册表/连接/回调；timer 创建即 unref）**。
- `routes/events.ts`：SSE 原语（CORS 回显过 allowlist）+ `GET /events`（hello、bus 转发、心跳、幂等 cleanup、未注册 gui_id → hijack 前 409、局部 preClose、写侧水位断开）。
- 测试：bus 单测；真 listen + fetch：hello、广播到达、gui 接管（仅后连者收单播、前者仍收广播、后者断线 → 前者提升）、未注册 gui_id 409、**恢复协议**（模拟重启：新 guiChannel 后旧 gui_id → 409 → 重注册 → active 恢复）、**注册表过期**（注入短过期：断线超时后原 gui_id 409）、**容量满**（8 个关联态 + 第 9 次注册 → 409 `GUI_CAPACITY`；有未关联项时淘汰最旧）、**`close()` 幂等且无残留 timer**（fake timers 断言全清）、abort 后订阅归零、shutdown 预算断言（<1000ms）。

**验收**：`just test-daemon` 绿。

### T5 songs + playlists 路由（含 core `getPlaylist`）

- core：`library/playlists.ts` 补导出 `getPlaylist(db, sqlite, id): PlaylistData`（含 `song_count`，NotFound 抛错）+ 单测。
- `routes/songs.ts` + `routes/playlists.ts` + M2-16 校验 + 事件发射。
- 测试（buildTestServer inject）：CRUD happy path；enrich；query 契约违例逐类 400（sort 乱值、**未知 query 字段**、limit 越界/非整数、search 超长）；PUT source 四象限（合法象限 / 半空拒 / key 冲突 409 携 id / 语法非法 / 超长）；输入契约（空 name、超长、trim 写入断言、未知 body 字段、`pinned` 非 boolean、空 PUT、song_ids 空/超限/非 UUID、锚点非 UUID）；pin 往返（updated_at 不变）；虚拟 all 全写类 400、读类合成正确；`GET /playlists/:id` 三态；reorder 契约经 HTTP 面；事件断言（DELETE song 双事件）。

**验收**：`just test-core` + `just test-daemon` 绿。

### T6 /audio + /lyrics（含 core lyrics 模块）

- core：`library/lyrics.ts`——`readLyrics(id)` / `deleteLyrics(id): boolean`（ENOENT → false）+ `songAudioPath(id)`；一律先过 `isUuidV4` + 单测（含路径穿越）。M3 歌词写入落同模块。
- `routes/media.ts`：`GET /audio/:id`（spike 三义务：`parseRange` 移植、200/206/416 头部契约、`createReadStream` + `reply.send(stream)` + 显式一次性 release guard、`audio/mpeg` + `no-store`、`touchLastAccessed` 按歌 60s 去抖、错误信封（非 UUID 400 / 歌不存在 404 / 文件缺失 404 `FILE_NOT_FOUND`）、per-request **debug** 日志（Logger 已补 debug））。`GET /lyrics/:id` → `text/plain; charset=utf-8` + `no-store`（无文件 404 `LYRICS_NOT_FOUND`）；`DELETE /lyrics/:id` → `deleteLyrics`（false → 404；成功 → ok + `lyrics:changed`）。
- 测试（真 listen + fetch）：200 头齐备；206 精确断言（1024 字节）；开放式/后缀 Range；越界/畸形/多段 416；中途 abort → release guard 幂等断言（注入计数器）；touch 去抖；lyrics 往返 + 事件断言。

**验收**：`just test-core` + `just test-daemon` 绿。

### T7 player 通道

- `routes/player.ts`（M2-11）：report/status/九命令/ack/gui-register；pending map（关联 active + `onActiveClose` 立即失败 + `sendToActive` false 立即失败 + shutdown 释放）；逐命令校验。
- 测试：无 active → 409；真 listen 端到端（register → SSE → 收命令 → ack → 200）；`ok=false` → 502；不 ack → 504（`ackTimeoutMs:100`）；迟到 ack 幂等；双 GUI 重叠 → 仅 active 收一次；active 断线 → 在途立即 409；**`sendToActive` 写失败（注入抛错/瞬断）→ 立即 409 且 pending 已清**（三轮 ⑦）；参数校验逐命令；report 校验 + status 往返 + gui_online 翻转；shutdown pending 全释放。

**验收**：`just test-daemon` 绿。

### T8 config + capabilities

- `routes/config.ts`（M2-12）+ `routes/system.ts` 扩 capabilities（M2-13）。
- 测试：GET 无 api_key；PATCH 落盘 round-trip + 未知键保留；未知 key 400、非法值逐类 400（与 loadConfig 同值交叉断言——含 LOG_LEVELS 同源生效）；api_key 空串清除；rename 前失败 → 500 双旧值；post-rename 失败（`saveConfigImpl` 注入）→ 500 且 ctx.config 已重载为磁盘新值；**重载失败 → 断言先收到 500 响应、后 `requestFatal` 被调**（记录 stub；真实 exit 1 由 T2 ⑥ 子进程用例覆盖，三轮 ①）；capabilities 双向覆盖守卫。

**验收**：`just test-daemon` 绿。

### T9 守卫 + 收尾

- `scripts/check-log-hygiene.sh`（M2-15）+ 接入 `just check`。**脚本定稿**（三轮 ③：判定基于捕获输出非空，与 rg 退出码解耦——rg 无命中退出 1 恰是通过态；secret 只匹配字段位置）：

  ```bash
  #!/usr/bin/env bash
  # log-hygiene guard (M2-15). Violations are judged by NON-EMPTY captured
  # output, decoupled from rg's exit codes (rg exits 1 on "no match" — that is
  # our PASS state, so bare rg in a recipe would invert the semantics).
  set -u
  viol=0
  SRC=(packages/core/src packages/daemon/src)

  report() { # $1 = rule label, $2 = captured output
    if [ -n "$2" ]; then
      printf '[log-hygiene] %s:\n%s\n' "$1" "$2" >&2
      viol=1
    fi
  }

  # 1) direct console writes (line-level waiver: `// log-hygiene: console-ok`)
  report "console" "$(rg -n 'console\.(log|error|warn)' "${SRC[@]}" -g '!*.test.ts' \
      | grep -v 'log-hygiene: console-ok' || true)"

  # 2) secret FIELD (incl. shorthand) inside a logger call, 200-char window —
  #    field position only, so message text like "token rotated" never matches
  report "secret-field" "$(rg -nU \
      'logger\.\w+\([\s\S]{0,200}?[{,]\s*(token|api_key|authorization)\s*[:,}]' \
      "${SRC[@]}" -g '!*.test.ts' || true)"

  # 3) whole-config injection (field name / spread / direct ctx.config)
  report "config-object" "$(rg -nU \
      'logger\.\w+\([\s\S]{0,200}?(config:\s|\.\.\.\s*(ctx\.)?config\b|\bctx\.config\s*[,)])' \
      "${SRC[@]}" -g '!*.test.ts' || true)"

  exit "$viol"
  ```

  验收演示：人为加 `console.log`、`logger.info({token})`、`logger.info({...ctx.config})` 各红一次后撤销；再确认干净树上脚本退出 0。
- **主计划 §4 事件清单回写 `lyrics:changed`**（标注「M2 增补」）。
- README 补 M2 用法；PROCESS.md 勾选 M2；CLAUDE.md「注意事项」补 M2 实测锁定（如有）；本文件 §7 回填。
- `just check` + `just test` + `just build` 全绿。

**任务顺序**：T1 → T2/T3（可并行）→ T4 → T5/T6/T7/T8（互相独立；T5/T6 的 core 小补先行）→ T9 收口。
**提交批次（建议，每批 commit 信息先给用户过目）**：批 1 = T1+T2+T3（`feat(shared)` + `feat(daemon)` 生命周期/鉴权）；批 2 = T4+T5（`feat(daemon)` events/gui 通道 + `feat(library)` getPlaylist + library 路由）；批 3 = T6+T7（`feat(library)` lyrics + `feat(daemon)` 媒体/player）；批 4 = T8+T9（`feat(daemon)` config/capabilities + `chore(repo)` 守卫 + docs 收尾）。

**用户验收关键路径**：
① `just check`（含新守卫，含「干净树退出 0」确认）+ `just test` 全绿。
② 生命周期：临时 nest `just dev-daemon` → token 0600 → 第二实例拒启 → 无 token `/songs` 401、`/status` 200 → `just stop-daemon`（观察确权 + 等待输出）→ pid 消失、token 保留 → 重启 token 内容变化。
③ CRUD + SSE：`curl -N -H "Authorization: Bearer $(cat …/daemon-token)" '127.0.0.1:47100/events'` 挂住，另一终端建歌单/改歌 → 观察事件。
④ player 单消费者 + 恢复：无 GUI `POST /player/pause` → 409；`scripts/demo-gui-sim.mjs`（register → SSE → ack，兼 M4 参照）→ 200；第二个模拟 GUI 接管 → 命令只被新的执行；重启 daemon → 旧 gui_id 重连收 409 → 脚本重注册后恢复。
⑤ /audio：副本迁移库真实 mp3 → Range 206/416/200 头部契约逐项。
⑥ config：GET 无 api_key；PATCH 落盘 + 未知键保留；非法值 400（内存磁盘均未变）。

## 5. 与 owl 的刻意差异（M2 增补）

| 项 | owl | lark M2 |
|---|---|---|
| readPid 内容校验 | 只排 NaN | 正整数 + safeInteger + >1；非法 fail-closed（M2-3） |
| pid 活性判定 | 任何抛错当陈旧 unlink | 仅 ESRCH；EPERM 不删不杀（M2-3） |
| stop-daemon | 信任 pid 文件即发信号，发完即返回 | `/status` 确权 + 轮询等待退出 5s（M2-3） |
| daemon-status | pid 文件在即报 running | 以 `/status` 为准（M2-3） |
| shutdown 顺序 | removePid 先于 server.close | PID 最后（owner-checked）；teardown/shutdown/abortBoot/requestFatal 四出口 + 生命周期状态机 first-wins（M2-1/M2-4） |
| signal handler 时机 | listen 编排尾部 | 取得 PID 锁后立即 + listen 后发布前状态检查（M2-1） |
| boot 失败清理 | 各失败点手工清理 | 统一 teardown 按资源逆序，含 guiChannel.close（M2-1） |
| 运行期致命错 | 无此概念 | `requestFatal` 幂等非等待，先响应后 teardown（M2-1/M2-12） |
| SSE CORS 头回显 | 无条件 echo | 先过 `isOriginAllowed`（M2-6） |
| SSE 写侧背压 | 无 | 水位超限断开 + 重连自愈（M2-6） |
| SSE client 重试控制 | 只能 abort | `onDisconnect` 可返回 `'stop'`（M2-14） |
| gui/player 通道 | —（无此概念） | 注册 + active 单播 + 接管 + 409 恢复 + 过期/容量 + close 清理（M2-6/M2-11） |
| PATCH /config | 先改内存再落盘；未知键静默丢弃 | clone→save→swap + 失败重载对齐 + requestFatal 兜底；未知键 400（M2-12） |
| errorHandler | 一切 throw 记 error、非 Fastify 错落 500 | 三分类（M2-8） |
| 鉴权错误码 | local/cloud 双体系 | 仅 `UNAUTHORIZED` |
| 401 日志 | 正常打 | 零日志（spike §6.3-7） |
| `POST /events/emit` | 有 | 无——路由层直接 emit（M2-6） |
| `removeLocalTokenFile` | 有（cloud 清陈旧） | 不引入 |
| daemon 测试 logger | console-backed 实现 | 删除 console 版，注入 no-op/记录 stub（M2-5） |
| capabilities 同步 | 无测试 | 双向覆盖守卫 + registerAllRoutes 单一来源（M2-13） |
| `/status` payload | 含 mode/local_auth_version | M0 形态（pid/uptime/version） |
| trustProxy | config 开关 | 不设（恒 false） |
| shutdown 删 token | 不删 | 同；与 M0 spike 差异（M2-3） |
| 日志卫生守卫 | 无 | 输出非空判定 + 字段位置匹配 + 行级豁免（M2-15） |
| 测试 runner | node --test 跑 dist | vitest 跑 TS 源；daemon fork 池（M0-3/M2-17） |

## 6. 风险

| 风险 | 对策 |
|---|---|
| Fastify `send(stream)` 清理语义与 spike 手写 http 不一致 | 显式移植 release guard + abort 断言计数归零（T6）；异常再降级 hijack 手写管道 |
| `/events` preClose 失效 → close 挂死 | T4 预算断言 + T2 子进程 SIGTERM 用例双护栏 |
| player ack 竞态（超时/断线/写失败/迟到交错） | pending 删除即幂等；断线与写失败立即失败；迟到 200 忽略；四分支测试（T7） |
| boot 生命周期状态机与信号交错仍有未覆盖路径 | first-wins + listen 后状态检查收敛双出口；T2 ⑤ 确定性并发用例；发现新交错即补状态检查点并记 §7 |
| gui 恢复协议与 M4 真实 GUI 集成偏差 | 协议冻结在 shared 类型 + 409/`'stop'` 语义 + demo-gui-sim 即 M4 参照；M4 联调回改记录 |
| 注册表参数（10 分钟/容量 8/1MB 水位）与真实使用不符 | 集中常量 + ctx 可注入（测试已用）；M4 联调再调 |
| 真实 nest 上 Go daemon 在跑 → TS daemon 拒启 | 设计行为；文案明示 + 开发用 `LARK_NEST_DIR` 副本（M2-3） |
| 同步发布不变量被重构破坏 | boot.ts 注释写死 + M2-2 决策记录（测试不冒充覆盖） |
| capabilities 清单漂移 | 双向覆盖守卫（M2-13） |
| PATCH 校验与 loadConfig 域定义分叉 | LOG_LEVELS 同源（shared）；数值下限 T8 双侧同值交叉断言 |
| 日志守卫被多行/间接形态绕过 | 有界近似定位（M2-15）+ redact 单测 + 投影约定三层 |
| PID fail-closed 在真垃圾残留时挡启动 | 文案带路径与手查指引；极罕见且一次 rm 解决 |
| config 落盘失败后的 fatal 路径误触发 | 仅「保存失败 且 重载失败」双重失败触发；先回 500 再 setImmediate teardown（不与在飞请求互锁）；T8 顺序断言 + T2 ⑥ 真实退出用例 |

## 7. 实施记录（2026-08-04 落地）

### 7.1 实施中修订的决策

| # | 修订 | 原因 |
|---|---|---|
| 1 | **提交批次改为 批1=T1+T3+T4+T2 / 批2=T5 / 批3=T6+T7 / 批4=T8+T9**（原 批1=T1+T2+T3） | `boot.ts` 要组装 `guiChannel`、`server.ts` 要注册 `/events`——T4 不先落地，批 1 里任何一个 commit 都不可编译。任务内容未变，只改顺序 |
| 2 | **boot 的测试注入走 `BootOptions` 形参**（`stallBeforeListenMs` / `fatalAfterMs`），三个 env 只由 `testing/boot-child.ts` 读 | 原文只说「测试专用注入」。把 env 读取集中在 testing entry，`boot.ts` 保持零测试 env 面——生产路径不可能被游离变量重配 |
| 3 | **信号在 boot 驱动期只「记录」不「执行」**：`requestStop` 置原因后返回，由 boot 的三个 checkpoint（listen 前 / listen 后 / running 后）收口执行 teardown | M2-1 ② 只要求「listen 后状态检查」。但若 handler 自己 teardown，它会与仍在 `await listen()` 的 boot 续体并发关 server；改成单一执行者后，双出口竞态在结构上不存在 |
| 4 | **`just test-core` / `test-cli` 也加 build 前置**（原文只写 test / test-daemon） | core 与 cli 通过 **dist** 消费 `@lark/shared`。T1 当场踩到：`LOG_LEVELS` 上移后不重建 shared，core 测试直接红（`new Set(undefined)` 静默成空集） |
| 5 | **新增 `@lark/core/testing` 子路径导出**（当前仅 `seedGoLegacyDb`） | T2 的「Go 旧库拒启」子进程用例要造 Go 库，而测试夹具不该进主 barrel |
| 6 | **输入契约落为 `daemon/src/validation.ts`**：统一 `InvalidRequestError`（`statusCode=400` → 走 errorHandler 第②类，天然不进 error 日志）；`PATCH /config` 的白名单实现为「逐字段 schema 校验并直接写入 clone」 | 与 M2-16/M2-12 等价，但少一层 filter + deepAssign，且校验与赋值同源，不可能漏过滤 |
| 7 | **多行终端文案先赋值给常量再单行 `console.x(msg)`** | 豁免注释必须与 `console.` 调用同一行，而 Biome 会把超长调用的参数换行——注释被推到参数行后守卫照样报红（落地时真红过一次） |
| 8 | **player `play-playlist` / `switch-playlist` 只校验 id 形态**（uuid 或 `all`），不查存在性 | 与 M2-11「成员归属不校验」同源：GUI 负责解析并用 ack 反馈失败（502）。只有 `play` 按 M2-11 明文查存在性 |

### 7.2 M2 实测锁定（改动前先读）

- **Fastify 5 自带 `text/plain` 解析器**：415 用例必须用 `application/xml` 之类没有注册解析器的类型，`text/plain` 会 200。
- **`reply.hijack()` 之后 onSend 不跑**：SSE 的 CORS 头必须手写回显，且先过 `isOriginAllowed`（owl 无条件 echo）。
- **`/audio` 用 `reply.send(stream)`**：背压由 pipe 天然满足；release guard 挂 `reply.raw` 的 `close`/`error` + stream 的 `close`/`error`，幂等，abort 后计数归零（`audioStreamCount()` 断言）。
- **守卫脚本判定看「捕获输出非空」**：`rg` 无命中退出 1 才是通过态，裸 `rg` 进 recipe 语义正好反过来。
- **豁免注释与调用同一行**（见 7.1 ⑦）。
- **`vi.stubEnv` 而非 `delete process.env.X`**：Biome 的 `noDelete` 拦 delete，而 `process.env.X = undefined` 在 Node 里会写成字符串 `'undefined'`。
- **同毫秒创建的行由 `id` 升序兜底**：`listSongs` 的 `created_at` 并列时按 id 排，测试里两首歌几乎必然同毫秒——断言要按 id 排序而不是插入顺序。

### 7.3 收尾核对

- [x] 主计划 §4 事件清单已回写 `lyrics:changed`（并补 `hello` 与 `player:command` 单播说明）
- [x] 日志卫生守卫接入 `just check`，红/绿演示各跑过一次（`console.log` / `logger.info({token})` / `logger.info({...ctx.config})` 三条规则各命中，撤销后干净树退出 0）
- [x] `just check` + `just test` + `just build` 全绿（shared 23 / core 131 / daemon 223 / cli 3）
- [x] **用户验收通过（2026-08-04）**，副本 nest `/tmp/lark-accept-nest`（`just migrate-go` 对账 20/2/4 后）：
  - ① `just check` / `just test` 全绿
  - ② 生命周期：token 每次启动轮换；`/status` 200 免鉴权、`/songs` 401；第二实例 `daemon is already running (PID …)` 拒启；停机后 `daemon.pid` 消失而 `daemon-token` 保留；GUI 模拟器在 daemon 重启后收 `409 GUI_REGISTRATION_REQUIRED` → 自动重注册恢复
  - ③ CRUD + SSE：建歌单/加 3 首/reorder（顺序确实变）/删成员/删歌单 + 改歌名，SSE 实收 `hello` + `playlists:changed ×6` + `songs:changed`；虚拟 all 合成 `song_count=20`、写它一律 400 `VIRTUAL_PLAYLIST`
  - ④ player：无 GUI → 409 `GUI_OFFLINE`；GUI-1 在线 → 200；GUI-2 接管后 `next` **只落到 GUI-2**、GUI-1 只有先前的 `pause`；非法 seek 400；`gui_online` 正确翻转
  - ⑤ `/audio` 真实 mp3（6 738 544 字节）：200 头部齐备（`audio/mpeg` + `accept-ranges` + `content-length` + `no-store`）；206 精确（1024 / 开放式 / 后缀）；越界·反向·多段一律 416 带 `bytes */<size>`；前 100000 字节、尾段 4096 字节、整文件均与磁盘逐字节相同；401 / 400 / 404 分明；`/lyrics` 200 `text/plain; charset=utf-8`
  - ⑥ config：GET 只给 `has_api_key` 不给 key；PATCH 落盘；非法值 / 未知字段 / 未知 section 一律 400 且磁盘与内存均未变。**「未知键保留」现场未验**（验收脚本注入时机不对，见下），由单测 `keeps unknown keys that were already on disk` 覆盖
- 验收过程中的产出：
  - **真实缺口 1 处（已补）**：`/audio` 多块流的完整性从未被断言——原用例最大 body 4096 字节，8MB 那个只读一块就 abort，若在第一个 highWaterMark 之后截断可以完全逃过测试（而 `curl -s` 会静默吞掉 "transfer closed with N bytes remaining"，只表现为文件损坏）。补 3MB+7 字节的整文件与 100KB 尾段字节精确回归
  - **验收脚本假警报 3 处（非产品问题）**：macOS BSD `cmp -n N` 在首文件恰好在第 N 字节结束时报 `EOF` 并退出 1（GNU cmp 不会）；嵌套 `$( )` 里的 `\"` 被外层引号先解掉，curl 收到被拆散的参数、payload 成坏 JSON；未知键在 daemon 运行中注入，早于它加载
  - **语义澄清**：config 未知键的保留契约是「**daemon 启动时磁盘上就有** → 之后 save 原样带回」。绕过运行中的 daemon 直接改文件，下一次 save 必然覆盖——config 由运行中的 daemon 持有（owl 同）
  - **真实 nest 唯一副作用**：`stop-daemon` 在未 export `LARK_NEST_DIR` 的终端里跑过一次，按 PID 协议清掉了真实 nest 里那个 Go 时代遗留的陈旧 `daemon.pid`（进程早不在，只删文件不发信号）；库与 config 未动
- [x] **M4/M6 待接线清单**：preload 每次现读 token 文件（不缓存、不进 URL/DOM）；GUI 注册 → `?role=gui&gui_id=` 订阅 → 收 409 `GUI_REGISTRATION_REQUIRED` 时 `onDisconnect` 返回 `'stop'` → 重新 `/gui/register` → 新 AbortController 重订阅（`scripts/demo-gui-sim.mjs` 即参照实现）；GUI spawn daemon 后用 `/status.pid === child.pid` 确权（pid 文件不作身份证明）；CLI（M6）代理 `stop-daemon` / `daemon-status`；`ensure-electron-abi` 在 M4 接线
