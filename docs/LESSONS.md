# lark 实测锁定

> 每一条都是**踩出来的**，不是推导出来的。从 `CLAUDE.md` 迁出（2026-08-19）——那份文件是每次会话都加载的常驻规范，历史细节压在里面会把真正常驻的规矩淹掉。**内容逐字节保留、只按时间重排**。
>
> **改动某个模块前先读它对应的那一段**；每段开头的子计划链接是更完整的上下文（判据、决策、逐批记录）。新的实测锁定继续追加到对应段落。
>
> 这里是「**为什么会踩**」。「**现在还必须遵守什么**」在 `INVARIANTS.md`，「**当时怎么定的**」在 `history/`，「**还没做的**」在 `plans/2026-08-26-backlog-before-android-v1.md`。
>
> 按时间分段：**M0–M7**（v0.1，桌面从零）· **v0.2**（同步）· **v0.2.1 / v0.3.0**（m4a 与迁移）· **Phase B**（Android，最长的一段，随批次追加）。找东西直接 grep 模块名。

---

## M0 实测锁定（改动前先读 `docs/plans/2026-07-31-m0-scaffold-media-spike.md` §6）

- **版本**：Electron **43.2.0**、Node 24.13.0（`.node-version`）、全依赖精确锁版；**vite 用根 `pnpm.overrides` 钉 7.3.6**——只锁直接依赖挡不住传递范围把它抬到 8，而 electron-vite 5 的 peer 只到 7，失效方式是静默的（build 照样成功，但 electron 被打进 main bundle）
- **Electron ESM main 不得顶层 `await app.whenReady()`**：ready 只在入口模块求值完成后才发，顶层 await 直接死锁（不开窗、无输出、无退出）。包一层 `async function bootstrap()`
- **renderer CSP 单一来源 = gui 的 Vite 插件**（`order: 'post'` + `head-prepend`）；`index.html` 不手写 meta。dev 比生产多两处放宽：`connect-src` 加 HMR socket、`script-src` 加 `'unsafe-inline'`（React Fast Refresh preamble 是内联 script）
- **M2 的 `/audio` 三条义务**（spike 实测）：尊重 backpressure（写回调 + 速率，不能只按时间节流）、按「单曲可能并存约 6 条 range 流」预算 fd、在响应 `close`/`error` 上做一次性清理（幂等 guard）。**不要用「按块封顶 206」缓解慢速来源**——实测会把媒体元素打进 `MEDIA_ERR_NETWORK`
- **transport 重试**：仅 GET 默认重试（2 次），且只重试 fetch 网络层异常；收到响应后 401/5xx/非 JSON 一律不重试（M0-7）

## M1 实测锁定（详见 `docs/plans/2026-07-31-m1-core-data-layer.md` §7）

- **版本定案**：better-sqlite3 **12.11.1**（engines 显式列 Node 24.x；13.0.x 发布两周不追新首发）、drizzle-orm 0.38.4、pino 9.14.0、pino-roll 2.2.0、smol-toml 1.6.1、@electron/rebuild 4.2.0；`process.versions.modules`：**Node 24.13.0 = 137、Electron 43.2.0 = 148**（双运行时真值探测复核）
- **ABI recipes 已接线**：`ensure-node-abi` 挂 test / test-core / test-daemon / dev-daemon；`ensure-electron-abi` 已落地但 **M4 才接线**（M1–M3 无 Electron 内加载 better-sqlite3 的入口）；core 的 vitest 用 **fork 池**（worker 池下原生模块有崩溃前科，M1-14）
- **迁移锁**：`songs.db.migrate.lock` 是**常驻** SQLite 锁库（持锁 = 连接上 `BEGIN EXCLUSIVE`，内核 fcntl 锁，kill -9 自动释放）——**锁文件永不删除**，其存在与否不携带语义
- **createDatabase 判定前零写入**：`journal_mode=WAL` 必须在三条拒绝路径（>LATEST / Go 旧库 / 未知 v0 非空库）判定之后才设——提前设会把仍在日常使用的 Go 库从 DELETE 静默改成 WAL（测试有字节级不变断言）
- **loadConfig 强制收紧 0600**：存量 0644 的 `lark_config.toml` 即使只加载不保存也会被 chmod 0600，chmod 失败即抛错不带病运行
- ~~migrate-go 的 EXCLUSIVE 触发~~：实现已随 0.3.0 删除（结论仍在 `docs/plans/2026-07-31-m1-core-data-layer.md`：纯读探不到外部未提交写事务，要拿真排他锁得补一次同值写升级）

## M2 实测锁定（详见 `docs/plans/2026-08-04-m2-daemon-routes.md` §7）

- **boot 只有一个执行者**：信号在 boot 驱动期只由 `requestStop` **记录**原因，teardown 由 boot 的三个 checkpoint（listen 前 / listen 后 / running 后）执行——handler 自己 teardown 会与仍在 `await listen()` 的续体并发关 server。`requestFatal` 幂等且**非等待**（路由先回 500 再 `setImmediate` teardown，await 必死锁）
- **测试注入走 `BootOptions` 形参**（`port` / `stallBeforeListenMs` / `fatalAfterMs`），三个 env 只由 `packages/daemon/src/testing/boot-child.ts` 读；正式 CLI 恒 47100
- **`just test-*` 一律前置 build**：core / daemon / cli 都通过 **dist** 消费 `@lark/shared`，改了源码不重建就跑测试会静默用旧 dist
- **Fastify 5 自带 `text/plain` 解析器**：想触发 415 要用 `application/xml` 之类未注册解析器的类型
- **`reply.hijack()` 后 onSend 不跑**：SSE 的 CORS 头必须手写回显，且先过 `isOriginAllowed`
- **`/audio` 用 `reply.send(stream)`**（背压由 pipe 满足）+ 挂在 `reply.raw` 与 stream 双方 `close`/`error` 上的**幂等 release guard**；`audioStreamCount()` 在 abort 后必须归零
- **日志卫生守卫**：判定看「捕获输出非空」（`rg` 无命中退出 1 才是通过态）；`// log-hygiene: console-ok` 豁免注释必须与 `console.` **同一行**——Biome 会把多行调用的参数换行，注释被推走就照样报红，所以多行文案先赋值给常量再单行输出
- **测试里改 env 用 `vi.stubEnv`**：Biome 拦 `delete process.env.X`，而 `= undefined` 在 Node 里会写成字符串 `'undefined'`

## M3 实测锁定（详见 `docs/plans/2026-08-04-m3-download-pipeline.md` §7）

- **`nav` 匿名返回 envelope `code: -101`（未登录）但照给 `wbi_img`**——WBI 取 key 判定**看字段不看 code**，看 code 会在健康环境上 fail-closed
- **`fav/resource/list` 的 `ps=20` 实返 15 条 + `has_more=true`**——分页结束只能信 `has_more`，按 ps 推断会漏掉一半；`folder/created/list-all` 匿名 `data:null`（需登录，但不在链路上，media_id 来自 URL）
- **ffmpeg 输出到 `.tmp` 结尾的路径必须显式 `-f mp3`**——推不出容器时报的是「找不到合适的输出格式」，读起来像编码器问题
- ~~`ffmpeg-static` / `@derhuerst/ffprobe-static` 定版 5.3.0~~ → **M7 已移除**：两包的二进制是 `--enable-nonfree`，不可再分发。现在 ffmpeg 由 `just fetch-ffmpeg` 自建（见下方 M7 段）
- **酷狗三端点全支持 https**（Go 版两处明文 http 无必要）；`krcs.kugou.com/search` **必须带 `hash` + `duration`（毫秒）**，只给 keyword 返回空候选
- **LRC 正则不能一份带 `g` 的同时用于 `.test()` 和 `matchAll`**——`.test()` 留下的 `lastIndex` 会让下一次匹配从半路起步
- **落盘协议只承诺进程崩溃（kill -9）一致性**，不承诺断电（与 M1 同口径）；`.pending` manifest 的 `had_old` 是唯一能区分「崩在 bak 之前」（当前 song.mp3 是完好旧文件，**必须保留**）与「崩在 rename 之后」（未提交新文件，必须删）的信息
- **恢复例程结束时删掉全部 `download.commit.*` 日志行**，不只悬空的——恢复已消费掉所有 manifest，只删悬空的会让库里每次下载永久涨一行
- **`bilibili` client 全 daemon 一份（`ctx.bilibili`）**——同进程两个 client = 两份 WBI/buvid 缓存 = 对风控是两个身份
- **`closeTestContext` 已转 async**，daemon 测试全部 `afterEach` 必须 `await`；漏 await 在 fork 池下表现为句柄泄漏而非断言失败
- **`app.inject` 返回含 `void` 的交叉类型**，包一层 helper 时 `await` 不收窄，helper 必须显式标注返回类型
- **路径遍历 id（`../etc`）被路由器归一化后落到未注册路由 → 404**（不进 handler）；单段非 uuid 才是 400
- **无 scheme 的粘贴按固定前缀白名单补 `https://`**（尾斜杠是防 `bilibili.com.evil.test` 的关键）；带 `:` 的输入到不了修复分支——`new URL()` 把 `:` 前的部分当 scheme，在 https 检查处即拒
- **暂存目录先于传输存在**（同卷 rename 的前提），所以任务未提交就结束时要按「DB 无该行」删掉它；`landSongFile` 只补偿它见过的失败
- **`download:status` 带 `revision`**：`(state, stage)` 不唯一（绑定 song_id 时 stage 仍是 `resolving`）
- **M5 的按需下载加 task kind `ensure-file`**，复用 `#runDownload`；不要另抽 `resolveSongFile`

## M4 实测锁定（详见 `docs/plans/2026-08-05-m4-gui-base.md` §8）

- **daemon 复用判定只信鉴权 `GET /api/instance`**（M4 口径；**M6 T0 起 `/status` 另有公开 `nest_fingerprint`，见下方 M6 段**）：M4 时 `/status` 只有 pid/uptime/version，token 往返也只证明「两边各有一份同样的 token 副本」（整目录复制 nest 后依然成立）。比对 `realpath(nest_dir)` + `local_api_version`，**复用永不认领所有权**，证明不了身份的分支一律弹框中止、不 spawn、不停陌生进程
- **`contextBridge` 冻结 `window.larkAPI`**：改它的字段会**静默失败**（CDP 里覆盖 `pickMp3` → 真的弹出原生对话框）。测试要整体替换 `window.larkAPI` 对象
- **CDP 打字**：窗口不是系统焦点时 `Input.dispatchKeyEvent` 只发 `keyDown` 进不了 React，必须补 `char` + `text: '\r'`
- **pino-roll 写的是 `lark.log.1`**（不是 daemon 打印的 `lark.log`）——读日志断言要 glob `lark.log*`
- **macOS `mkdtemp` 给 `/var/…`、daemon 报 `/private/var/…`**：凡是要跟 daemon 的 `nest_dir` 比对的路径都先 `realpath`
- **`electron-vite preview` 不吃 `--remoteDebuggingPort`**（只有 `dev` 有）：验收直接用 Electron 二进制跑 build 产物
- **只读连接打开 WAL 库会造出 `-wal`/`-shm` 且关闭不删**：断言「副本无边车」必须在打开副本之前
- **两纪元不许混用**：`connectionEpoch`（每次 hello，只刷新）vs `daemonGeneration`（token 内容或 `/status.pid` 变了才递增，**只有它**能 remount 媒体元素，且换代后必须跑带失败终态的恢复状态机）
- **播放器命令共用一条串行队列**（本地点击 + 远程命令），超过 **2.5s** 才轮到的远程命令直接丢弃不 ack（daemon 3s 已回 504）
- **`has_file` 是每次请求现探的磁盘状态**：列表拿到后文件被删，GUI 仍会尝试播放并走 media error 停播；刷新后才灰显拒播

## M5 实测锁定（详见 `docs/plans/2026-08-06-m5-features.md` §8）

- **清理的删除临界区里不许有 await**：探活是 await，期间歌可能被 pin / 改 key / 重下 / 开始播放——取 file claim 后必须**重读行 + 重新 stat + 复查排除集与 per-song 流计数**，再 `unlink`，全程同一个同步段；claim 释放冻结成 `try/finally`（cache 没有 engine 的 `releaseOwner` 兜底）
- **下载完成触发的清理要 `setImmediate` 延后**：`onSucceeded` 在 `#finish` 内同步发出，此刻任务**仍持有 file claim**，立即清理会把刚下载的歌当 busy 跳过且没有补跑；同理 `onSucceeded` 是 void 回调，从里面抛错会穿透 `#finish` 把已提交的成功任务错标 failed（scheduler 必须同步不抛）
- **`config-types.ts` 的 doc 注释里不能出现 `songs/*/song.mp3`**：`*/` 提前闭合注释，Biome 报的是 parse error 而不是格式问题
- **core 测试的 `source_key` 必须像真的**（`/^BV[0-9A-Za-z]+:\d+$/`），且同一 `(provider, key)` 全库唯一——多首歌各要各的 key
- **同毫秒创建的行让「按 created_at 排序」的断言不确定**：导出的两处排序都带 `id` / `song_id` 兜底，测试要么回填 `created_at`，要么按 id 组期望值
- **导入两段式靠 SHA-256 咬合**：commit 重读文件、digest 不符即拒——`reuse[].index` 只有在字节一致时才指向用户看过的那一条
- **dnd-kit 走 legacy**（core 6.3.1 / sortable 10.0.0 / utilities 3.2.2 / modifiers 9.0.0）：新架构 `@dnd-kit/dom` 依赖 jsdom 没有的 `PointerEvent` / `IntersectionObserver` / `elementFromPoint`，每个都以**未捕获异常炸掉整个测试文件**
- **`useSortable` 默认 `attributes` 带 `role="button"`**：落在 `<tr>` 上会让 `getAllByRole('row')` 全数落空，必须 `attributes: {role: 'row'}` 覆盖
- **dnd-kit 的 `PointerSensor` activator 不看目标元素**（只判 `isPrimary` / `button===0`）：整行拖拽必须自建 activator 排除 `input/textarea/select/button/a/[contenteditable]`，否则在内联编辑框里拖选文字就会重排歌单
- **jsdom 里 `getBoundingClientRect` 恒为 0**：dnd-kit 的碰撞检测在测试里没有意义——落点判定写成纯函数单测，拖拽手感交给 CDP 验收
- **renderer 测试没有 jest-dom 匹配器**：`toHaveValue` / `toBeChecked` 报 "Invalid Chai property"，断言要读 `.value` 与 `aria-checked`；`vi.fn(() => …)` 的 `mock.calls[0][0]` 在 tsc 下是空元组，要断言入参就得给 mock 显式形参类型
- **main 项目测 `dialog-ipc.ts` 要 `vi.mock('electron')`**，且必须连 `window.ts` 顶层的 `app.on('before-quit')` 一起假掉

## M5 后续实测锁定（详见 `docs/plans/2026-08-06-m5-followup-batch-actions.md` §5）

- **lark 没有强调色**：shadcn 中性色板的 `--primary` 浅色近黑、深色近白，与正文色同值——`text-primary` 当「激活态」用是**隐形的**（正在播放的行、当前排序项、播放模式激活态三处都中招过）。状态色走独立的 `--state-active`（琥珀），不动 `--primary`（按钮/勾选框/tooltip）
- **状态色都走独立 token**：`--state-active`（琥珀 = 正在播放）与 `--state-pinned`（蓝 = 已固定）；「未激活」用 `text-muted-foreground` 而不是白色——白色在浅色主题上等于隐形
- **`<tr>` 的 border 会被 `border-collapse` 吃掉**：选中的左竖条挂在**第一个 `<td>`**上，且未选中时也留同宽透明边框，否则选中会让整行横移 2px
- **行内复选框必须 `stopPropagation`**：否则行自己的 onClick 也会触发，把多选塌成单选——正好是勾选的反面
- **表头三态复选框的语义是「当前视图内」**：搜索/歌单已经筛过一轮，全选绝不能越过视图去够整个库
- **`mkdtemp` 建的临时目录测试要自己收尾**：`dialog-ipc` 与 M3 的 fixture 各漏了一处，累计在 `/tmp` 留下 237 个目录才被发现——建目录的 `beforeEach`/`beforeAll` 必须配对 `rmSync`

## M6 实测锁定（详见 `docs/plans/2026-08-07-m6-cli.md` §8）

- **`BEGIN EXCLUSIVE` 会在锁库旁留 `-journal`**：备份自己持写锁，所以遍历 nest 时那个边车**一定在**——凡是「复制 / 比对 nest 目录」的逻辑都要按前缀排除两个锁库
- **同进程两个连接照样互斥**：SQLite 在进程内自己记 inode 锁状态，双迁移器 / 双写者的竞争能在单进程测试里真实复现
- **`/status` 的身份字段是必填的显式联合**：两个字段都合法 = M6 形，两个都缺 = pre-M6 形，**半套或畸形一律 unverifiable**（不猜）；指纹一律对 `realpathMissingOk(larkDir())` 求，fresh nest 才能和 daemon 建目录后的结果对上
- **动态 import 的 core 不能用 `instanceof`**：`--direct` 后端按 `err.name` 匹配错误类——动态 import 的模块对象与静态 import 的不是同一个
- **双后端差异要靠冒烟才看得见**：已抓到两处——路由层的 uuid 门禁（直连少了会把 `INVALID_ID` 报成 `NOT_FOUND`）、虚拟 `all` 由 daemon 拼装（直连少了会让「按名字引用歌单」随 daemon 在不在而变）
- **`search` 是 `LIKE` 子串预筛，不是判定**：`<name|id>` 解析必须在结果里再做精确匹配；SQLite 的 `LIKE` 对 ASCII 大小写不敏感，假后端写成 `includes()` 会制造不存在的 bug
- **同样是 POST，能不能省掉 body 取决于路由读不读它**：`recognize-url` 走 `objectBody`，无 body 的 POST 被判 `INVALID_BODY`（要发 `{}`）；`redownload` / `download/lyrics/:id` 不读 body，无 body 照常
- **参数形状的判定要跑在探测 daemon 之前**：否则 `lark download`（零参数）在没有 daemon 时报 `DAEMON_UNAVAILABLE`(4)，把用户支去启动一个同样会拒绝它的 daemon——`withBackend` 的 precheck 缝就是干这个的
- **「哪一行是关键词」只有 `/download/parse` 知道**：本地按「不像链接就是关键词」判 500 字上限会误杀长 URL；预检放 parse 之后仍能按行号报错（items 与行一一对应），8192 单行上限才是必须在分块之前的本地判定
- **任务滚出 ring 是 `TASK_STATE_UNKNOWN` 不是失败**：终态任务只留最近 100 条，查不到 ≠ 失败；批次各项自带终态快照，所以批次能活过它自己的任务
- **commander 把 `--no-x` 存成 `x: false`，从来不是 `noX: true`**：按声明时的名字去读，flag 静默失效——`lark play --no-launch` 因此真的开过一个 GUI 窗口。翻译写成显式函数并配回归测试
- **daemon 先写 pid 文件再 listen**，所以「pid 活着但 `/status` 不应答」是**正在启动**的正常中间态，不是陌生进程——`ensureDaemon` 对它做限时只读重探（10s）而不是当场 fail-closed
- **虚拟时钟的 `sleep` 必须 yield 宏任务**（`setImmediate`）：`Promise.resolve()` 让轮询循环一路跑到 deadline，期间 child 的 `exit` 事件（定时器）永远排不上，测出来的是「超时」而不是被测的分支
- **CLI 不能 import electron**（守卫会拦），要 Electron 二进制就读 `node_modules/electron/path.txt` 拼 `dist/`；daemon 侧用 `process.execPath` + `packages/daemon/dist/cli.js`。两处定位都在 `lib/launch.ts`——M7 已给它们补了打包分支，见下方 M7 段
- **`-o <目录>/` 里的末尾分隔符就是「这是目录」**：只用 `existsSync && isDirectory()` 判，不存在的目录会被当成文件路径——skill export 报 ENOENT，playlist export 更糟（静默写出一个以目录名命名的文件）。判定收敛在 `lib/target-path.ts` 一处
- **验收脚本里 `spawnSync` 会堵住事件循环**：进程内起的 HTTP stub 永远答不上被同步 spawn 的 CLI，五态 stub 判据会全变成「没人监听」——stub 要放子进程
- **`INVALID_ID` 在 CLI 表面不可达**：每个 id 参数都是 `<name|id>`，先过解析——uuid 形状查不到 → `NOT_FOUND`，非 uuid → 当名字搜 → 还是 `NOT_FOUND`。id 门禁仍在（直连补的那个），只是命令行走不到
- **`backupNest` 只在 daemon 停掉后能跑**（在线备份只冻结 DB），验收脚本里凡涉及备份的检查都得排在停机之后
- **管理命令（`status` / `daemon` / `stop-daemon`）不取后端**：它们说的是进程不是曲库，走后端会导致「库坏了就停不了 daemon」；`--direct` 在这一层直接拒

## M7 实测锁定（详见 `docs/plans/2026-08-08-m7-packaging.md` §8）

- **ffmpeg 是自建的，不是装来的**：`ffmpeg-static` / `@derhuerst/ffprobe-static` 的二进制 `--enable-nonfree`，**不可再分发**（连 GPL 都不行）。现在 `just fetch-ffmpeg` 从源码建最小 LGPL profile（FFmpeg + LAME，4.5MB），锁在 `vendor/ffmpeg.lock.json`。它是**发版门禁**：源码 SHA → configure 与锁值逐字节比对 → 见 nonfree 即拒 → 能力清单 → **每一种真实转换各跑一遍闭环**（0.3.0 起三条：WAV→AAC→m4a · m4a→copy→m4a · mp3→AAC→m4a；T1b 删 LAME 后 profile 零外部库，mp3 只剩 demuxer/decoder/parser 供迁移与导入**读**）。`just package bundled` 每次前置跑它，stub 过不了第一道（不是 Mach-O）
- **configure 串必须路径无关**（`--prefix=../out` 这类相对路径）：绝对路径会烙进二进制、`-show_program_version` 读得到，锁值就绑死在某台机器的目录上
- **媒体工具单一真相 = `ctx.mediaTools`（MediaToolsRegistry）**：capabilities / 下载引擎 / `probeAudio` / import 全部共享一份。`ensureMp3` 与 `probeAudio` **接收已解析的路径**，不许自己再找——以前各找各的，能出现「capabilities 报没有 ffmpeg，下载却通过 Homebrew 成功」。`ready` 缓存到执行失败（ENOENT/EACCES）才失效，`missing`/`incompatible` 按 ≥5s 节流重探
- **ready 判定是完整能力清单**（0.3.0 起：demuxer mov/mp3 · decoder aac/mp3 · **encoder aac · muxer ipod** · file protocol · ffprobe JSON），不是 `-version` 退出 0——后者一个 shell 脚本就能过。清单只列**真正用到的**：不写 mp3 了就不能再要求 libmp3lame，否则是对一台能跑 lark 的机器说谎
- **ffmpeg 的清单输出**：`-hide_banner -v quiet -X` **只认第一个清单选项**（串多个只出第一个）；分隔线是 ` ---` 不是 ` --`（8.1 还多一列设备标志），按字面 `--` 匹配会把好构建判成「缺全部能力」
- **单测不能用 `-f lavfi` 造 fixture**：最小 profile 没有 lavfi（AAC 编码器 0.3.0 T0a 起有了，但让被测构建自己造输入本来就是错的形状）。改用 `@lark/core/testing` 的 `toneWav()`（纯 Node 写 44 字节头 + 正弦），真容器只在 `fetch-ffmpeg` 与 accept-pack 的闭环里用（入库夹具 `scripts/fixtures/`，来历与 sha256 见同目录 README）
- **`just package [mode]` 是位置参数**：`mode=system` 这种写法在 just 1.46.0 会被当成第二个 recipe 名（实测报 "does not contain recipe"）
- **`identity: '-'` 在 electron-builder 26.15.3 上是一等公民**（产物 `flags=0x2(adhoc)`）；owl 的 `afterPack` 钩子仍保留，幂等，不赌版本行为
- **打包后定位**：dev 与 packaged 由「能否走到 `pnpm-workspace.yaml`」一次决定。打包态所有路径来自**同一个** `resolveAppBundle()`——包内 Electron 跑包内 daemon 用包内 ffmpeg，`lark gui` 用 `open <该路径>` 而不是 `open -a Lark`（`-a` 由 LaunchServices 挑，可能挑到另一份）
- **`/usr/bin/open` 正常退出不是崩溃**：`LaunchCommand.expectsImmediateExit` + `LaunchedChild.state.exitCode`——按 dev 的「退出即崩溃」判，每一次打包态 `lark gui` 都会在窗口出现前失败
- **验收脚本必须从工作区之外跑 CLI**：仓库内跑时 `isDevCheckout()` 一路走到 `pnpm-workspace.yaml`，`LARK_APP_PATH` 被完全忽略——判据 10 会静默测成 dev 分支（踩过）
- **renderer 不能 `fetch('lark-media://…')`**：CSP 的 `connect-src` 没这个 scheme（媒体走 `media-src`）。观测 206 要么经 daemon 的 player 命令驱动 + 读日志的 `audio range` 行，要么用媒体元素
- **图标**：源图的灰光晕**不透明**，量边界要用饱和度不是 alpha；`lark-icon-source.png`（已去光晕的方块）是唯一 tracked 的图标资产，配方写在 `build-icons.mjs` 注释里。**判据在 0.2.1 改了**：不再是「最外圈不透明像素 = 0」——那条只防得住光晕，防不住 macOS 给「不像 tile 的 icns」垫默认灰底板（0.2.0 就是这么带着一圈灰发出去的，详见下方 0.2.1 段）。现在 `build-icons.mjs` 自己造 tile（铺满 → n=5 超椭圆蒙版 → 缺口填边缘中位色），判据改成**用 `NSWorkspace.icon(forFile:)` 渲染出来的图在系统 tile 内没有灰边**
- **发版**：npm 拒绝 `npm login` 的会话凭据（要 2FA），必须用带 bypass 的 granular token；发布成功后 CDN 还会缓存 404 约 40 秒（`npm access get status` 走 API，那时已经对）。github 在本机三通其一，且 **`git push … | tail` 会吞掉退出码**（管道返回 tail 的）

## v0.2 T0–T3 实测锁定（详见 `docs/history/v0.2.0-shipped.md` 与 `docs/plans/2026-08-11-v0.2-skybridge-sync.md`）

- **sync 的两条通道不许混**：LWW put/墓碑（`create`/`update`/`delete`）带三元组、比键、**跳过自己的回声**；元数据 op（`set_lyrics`/`clear_lyrics`/`reorder`/`set_rank`）无键、只按 `server_seq` 定序、**自己的回声也要重放**——任何 rank 进 LWW 通道都会分叉（D7）
- **rank 全部离开 LWW**：拖拽 = rank-only + `set_rank`；归一化 = 一条 `reorder`（超 4000 退化逐行）；add = **成对 emit**（create 不带 rank）
- **同 `(provider,key)` 允许共存**（D8，0002 去 UNIQUE）：by-key 查找两条命中即 `AMBIGUOUS_SOURCE_KEY`，不猜
- **SQLite `json_set(payload,'$.x',?)` 把绑定数字写成 `…000.0`**（`json_type` = real）：rebase 要 `CAST(? AS INTEGER)` 写、门放宽到 `IN ('integer','real')`，否则看不见自己的产物
- **file-effect journal 的 arg 是快照**：执行器零推断（远端删除的 `audio_origin` 与 `lyrics_disposition` 都在入队事务里定）；boot **先 drain journal 再 recovery**，recovery 跳过 journal 还占着的目录
- **墓碑的 `device_id` 存 `''` 不是 NULL**（`LwwTriple` 入口就把「没有设备」归一化了）——首次注册的重打戳要同时收 NULL / `''` / 本地 uuid 三种写法
- **login 的补偿顺序冻结**：先 revoke（**仅本轮新注册的设备**）再 remote logout——logout 作废整个 token family，反序就没凭证可 revoke 了；复用的存量设备**绝不 revoke**
- **旧 session 在 install 事务之前拆**：回填与 rebase 重写未推送变更的 key，在途的一轮会推旧 key 而本地留新 key
- **一轮里吃了 401 只能 `dropSession`**，不能 `teardownSession`——后者要等在途的轮，而在途的就是自己
- **push-on-mutation 走轮询不走事件**：`emitSyncChange` 在调用方事务内（事件可能早于 COMMIT 或在回滚后存活），而挂事件总线又漏掉 backfill 与 conflict resolve 这两条只 emit 不发曲库事件的路径
- **e2e 的 server 不进依赖（T6）**：`@orpheus-aviary/skybridge-server` 是私有包，运行时按「已安装 → `LARK_SKYBRIDGE_SERVER` → 兄弟仓 `packages/server/dist/src/index.js`」解析，缺了就 skip；`just test-sync-e2e` 用 `LARK_SYNC_E2E_REQUIRED=1` 把 skip 变硬失败
- **song / playlist 的删除只与墓碑比较**（T6a 修，§3.2）：与 `max(行, 墓碑)` 比会让「编辑晚一毫秒」的设备留住别人删掉的歌，且对端有墓碑后拒绝一切 update，永久分叉；membership 仍是 LWW 可复活
- **⚡ op 在自己的回声回来之前不算稳**：一轮先拉后推，拖拽后的第一轮会重放更早的 `reorder` 把顺序拨回去，等自己的 `set_rank` 以更高 `server_seq` 回来才定；测试要跑够轮次
- **源码里别放字面 NUL**：`rebase.ts` 曾用裸 `\0` 当复合 key 分隔符，grep / rg 直接把文件当二进制**静默跳过**（本仓守卫全是 rg 写的），改用 `\u0000`
- **CLI 的归属（T5）**：`sync` 的 login/logout/run/status/file-ops 走 daemon，`unbind` 独占本地库（停 daemon + 写锁），`config-show` 只读凭证文件（无 daemon 无库也能用）；密码只有静音 prompt 或 `--password-stdin`，没有 `--password` flag
- **v1 库在 v0.2 下 `--direct` 读也要先起一次 daemon**：只读打开拒绝迁移（零写入是设计），报 `MIGRATION_PENDING`——`accept-cli` 的夹具因此在 T0 就坏了，T5 已给 harness 补上「复制后升一次级」
- **GUI 的两条口径（T4）**：徽章的「注意力计数」只算冲突与永久失败的 file op（只有人能清的两样），隔离/重复/dead-letter 只在 popover 里列；列表的「重复」标记按**当前视图**算，跨歌单的一对由 `/sync/status` 与 `lark songs --duplicates` 负责
- **CDP 驱动 Radix Tabs 要补 `mousedown`**（激活不在 click 上），且按文本找按钮必须精确匹配——明文 HTTP 复选框的 label 文案里也有「登录」，`includes` 会点到 label 把跳闸开关关掉
- **`lifecycle` mutex 把函数排进微任务**：测「登出插在 refresh 中间」必须等被测函数**真的进去**再动手，否则测到的是排队而不是交错
- **真机 soak 的两条（T6c，2026-08-12）**：**起 GUI 之后、登录之前必须用 `/api/instance` 验 `nest_dir`**——`env LARK_NEST_DIR=…` 一旦没生效，GUI 就会打开**真实曲库**，一次登录把它升到 schema v2（单向，0.1.0 从此打不开）并绑到测试账号；数据不会丢，`sync unbind --force` 能清回未绑定态 · **`resolve('local')` 会被 `SOURCE_KEY_CONFLICT` 挡下**：它走普通写路径 `updateSongInTx`，而冲突挂起期间别的设备可能把这首歌的 source key 给了另一首——apply 允许共存、本地写不允许，两条各自都对，清掉另一首的 key 再恢复即可
- **`accept-sync` 的四条（T6c）**：`--yes` 是全局 flag、`--allow-insecure-http` 是子命令 flag，**位置放反 commander 自己退 1**，与被测的拒绝长得一样 · `--json` 下 `sync unbind` 先往 stderr 打「要丢多少」再打错误信封，**取 `error_code` 要从 stderr 最后一行往回找**，别 parse 整段 · 隔离目录是 **`<song_id>-<op_uuid>`** 不是 `<song_id>` · 制造冲突/重复靠 **`sync logout` 的离线窗口**（pending 门要未推送的本地改动；同 key 共存要两端各自 `assertKeyFree` 都过），且**夹具的四首歌必须互不相同**——把「被远端删的那首」和「重复对的一半」选成同一首，删除会顺手拆掉重复对
- **发版 0.2.0 的四条（T6d）**：**验收判据要随协议走**——`accept-pack` 的 §9 与 §4a 把 `LOCAL_API_VERSION` 写死成 4，T3d 升到 5 之后它们只会在发版当天红（`server.test.ts` 里字面 `'0.1.0'` 的 version 断言同理，已改成读 `DAEMON_VERSION`）· **`accept-pack` 要 `ensure-node-abi`**：它前一步 `just package` 必然把 workspace 留在 Electron ABI 148，而 harness 自己要 import core 跑 `backupNest`——「每个被测运行时自带 binding」对被测对象成立、对 harness 不成立 · **147MB 的 dmg 上传超过工具 10 分钟上限**，`gh release upload` 必须放后台，前台重试循环会被半路杀掉并留下空资产 · **图标看着不对，缓存只是嫌疑之一**：清缓存（删 `~/Library/Caches/com.apple.iconservices.store` + 本用户的 `com.apple.dock.iconcache` + `lsregister -f <app>` + `killall Dock Finder`，都不用 sudo）只治陈旧渲染；0.2.0 那圈灰清完还在，真凶是系统垫的底板——见 0.2.1 段

## v0.2.1 实测锁定

- **macOS 会给「不像 tile」的 app 图标垫一层默认浅灰底板**：系统把图标合成进标准圆角方块 tile，icns 的 alpha 不构成实心圆角方块时，就缩小你的图并垫底。lark 的插画顶部是藤蔓花枝、枝叶间有透明缺口，于是中招；owl 内部是整片实心天空，铺满。量法是 `NSWorkspace.icon(forFile:)` 现场渲染：0.2.0 在 412px 的系统 tile 上每边 50px 灰（`rgb(193)`→`rgb(145)`），owl 0px，而两份 icns 结构同构（最外圈 alpha 全 0、十档边距 4.3–4.9%）——**文件本身没有任何问题，它只是不是一块 tile**
- **比对图标必须改 bundle id**：LaunchServices 按 `CFBundleIdentifier` 缓存图标，复制一份 app 换掉 icns 再渲染，出来的还是旧图（第一次实验就这么假绿过）。改 id + `lsregister -f`，验完 `lsregister -u` 注销、删副本
- **已排除的三条**：清图标缓存 · 把内容拉到 97.5%/100%（owl 自己也只有 91%，尺寸从来不是原因）· 腐蚀 alpha 抹掉深绿描边（露出插画浅色底与裁断的枝叶，更丑）
- **删除文案曾经在撒谎**：`deleteSong` 走 file-effect journal 的 policy `local`，执行器是 `rm(songDirPath, {recursive:true, force:true})`——不进 macOS 废纸篓，T1c 之后也不进 nest 自己的 `trash/`。写用户可见文案前先跟到执行器那一层

## v0.3.0 实测锁定（随批次追加）

- **「应答」不等于「服务」**（T6）：五个 accept harness 全跑在真库副本上，而副本是 v2——daemon 一开它就当场转音频，这段时间 `/status`、`/api/instance`、`/api/capabilities` 答 200 而业务路由全 503。就绪判定要等 `phase === 'normal'`（`scripts/lib/library-ready.mjs`），`blocked_environment` / `needs_attention` 直接抛。**`lark daemon` 在服务之前几分钟就返回了**，照旧 `stop-daemon` 会把库停在半程
- **验收夹具不许借用户的曲库**（T6）：`accept-sync` 的 E5 要一首 imported（不可重下），用户清一次库它就变成在测别人的听歌习惯；D3 断言 `backfill == 全库`，而真实副本里本就躺着未推送的 `create`（正常写入都 emit，与绑定无关）——判据要断言「**没有歌被漏下**」，不是一个恰好成立的数字。同一种病在 accept-m5 早修过一次，晚了一个版本才走到 sync
- **LLM 精修要有自己的短超时**（T6d 实测）：歌词选优在 deepseek-v4-flash 上是 2.3 / 16.6 / 22.8 秒，而它的兜底 `pickByHeuristic` 是 1ms 且三次都选了同一个。这种「可选的精修」挂在通用 `llm: 60s` 上是错配比 → 独立 `lyricsSelect: 10s`。三个歌词平台本身只要 1–3 秒，**不是瓶颈**
- **续作属于它那首歌，不属于队尾**（T6c）：单 worker FIFO 下，下载成功后 `push` 歌词任务 = 先跑完所有下载再跑所有歌词，第一首歌要等最后一首下完才算齐。续作 `unshift`（`runNext`），手动排的歌词任务照常排尾。**先写断言再改代码**：红的那次直接打印出了真实顺序
- **Radix 的 FocusScope 会在 mount effect 之后再抢一次焦点**（T6c）：所以「打开时聚焦某个按钮」只能写在 `onOpenAutoFocus` 里，写在 effect 里只有「那个按钮此刻还禁用、稍后才可用」的路径上看着是对的。两种路径要分别测——批量弹框第一版就是这么假绿的
- **store 的就地更新必须复制事件带的每个字段**（T6c）：`download:status` 的处理只写了 state/stage/revision，把 T5.2 的 `received_bytes`/`total_bytes` 丢了——daemon 一直在发，GUI 从来没显示过。凡是「事件里新加了字段」，接收端的 `{...task, …}` 就是第二处要改的地方
- **全宽的可编辑按钮会把空白变成编辑目标**（T6c）：`block w-full` 让短标题右边的空白也能双击改名，而那里应该是行的双击（播放）。收敛成 `inline-block max-w-full`。同理复选框那一列：整格都要是勾选的命中区，否则点在框外会冒泡到行、把多选塌成单选。**断言 class 要按 token 比**——`max-w-full` 包含子串 `w-full`
- **MP4 必须 `-movflags +faststart`**：默认索引（`moov`）写在音频之后，媒体元素经 HTTP 拿到这种文件连 duration 都报不出来（accept-gui 实测：唯一请求落在文件最后 0.1%）。判据要断言**真文件里 moov 在 mdat 之前**，别断言参数里有没有那个 flag
- **媒体流与 API 必须分 session**：Chromium 每 origin 六条 socket，SSE + API + 每条 range 音频都指向 daemon 同一个 origin，播 m4a 时稳定占满——renderer 连 `/status` 都发不出去，表现成「daemon 重启后 GUI 不再注册」而音频一切正常。`lark-media://` 的上游走独立 partition（`session.fromPartition(…).fetch`）。**`net.fetch` 没有 session 选项**，多传一个字段类型检查不拦、运行时静默无效
- **`songFileInfo(id, { audioMode })` 的 mode 必须显式传**：`canonical` 只认 m4a，`migration-pending` 才兼容 legacy mp3。路径函数不读 DB——谁知道自己的库在不在迁移期，谁负责传
- **0.3.0 开发版打开 0.2.x 曲库 = 当场开始转换**（T3 起）：升 schema v3 之后 daemon 就地跑迁移——mp3 变成 m4a，A 类原件搬进 `migration-backup/`，R 类的原件**删掉**。全程可见、可中断、不静默删（R 类坏文件要探活确认能重下才丢），但**它是不可逆的**，所以开发期只对副本操作这条比 T2 时更硬
- **ffmpeg 的退出码看不见截断**（T2a 实测）：截断一半的 mp3 喂进去，ffmpeg 打一行抱怨、**退出 0**、写出完全合法的 m4a——里面只有 0.47/1.0 秒。所以「验证 m4a」必须查时长（`assessCanonicalAudio`：有音频流 · aac · mp4 族 · 时长 > 0 · 时长 + `max(0.25s, 1%)` ≥ 源时长，**只拦缩短不拦变长**，AAC priming 会让产物略长）
- **错误分型的顺序是判据不是风格**（§9 附表 A）：环境 pattern 必须先于内容 pattern 查（磁盘满时 stderr 里两类消息同时在场）；超时不是中止（两者从 `withTimeout` 出来一模一样，**只有调用方自己的 signal** 能分开）；同一个 errno 按步骤分流（`convert` 的 EACCES = spawn 失败 = 环境，`file_action` 的 EACCES = 这一首 = blocked）；分不清一律环境。**误判成环境的代价是一次重试，误判成内容的代价是一首歌**
- **迁移的恢复从磁盘读，不从 ledger 读**：协调表就是正向路径本身（每步先看目录里有什么、备份里有什么），唯一例外是 `discarding`——它记的是磁盘表达不了的「探活已经说过还能重下」。ledger 一律先写后做，所以崩溃后行永远比现实多说一点。**与主计划 §3.2-9 的偏离**：`blocked` 的重试不重放 `blocked_action` 而是重新判定（更保守，最坏多探活一次），`blocked_action` 是报告字段
- **A 类的 `asset_missing` 压过一个完好的 m4a**：转换是有损的，它从来不是「被保住的那个东西」——mp3 没了、备份里也没有，就算 m4a 完全有效也绝不 done
- **迁移的 scanner 走 `songs/` 目录树，不走曲库表**：0.2.x 库里有「行已删、file-op 还指着」的目录和崩溃留下的非歌目录，两种都握着 mp3。只给**持有 mp3** 的目录建 ledger 行（`total` = 工作量而非曲库大小）
- **迁移期的 daemon 是「可达但不服务」**（T3）：三层 context = BaseContext（含 **bilibili**，因为弃置探活复用缓存清理那一个实现，两个 client = 对风控两个身份）+ **late-bound NormalRuntime**（读早了抛 `RuntimeNotReadyError`，不给 `undefined`）。gate 读**内存里的 phase**，不读 DB flag——flag 是在 activation **中间**清的；三个 preHandler 的顺序是契约（Host → Bearer → 迁移 gate，**401 先于 503**）。pass 在 `listen()` **之后**才起：没人能看见的迁移，和启动时卡死的 daemon 从外面看一模一样
- **boot 先 drain file-op journal 再迁移**（T3a 实测）：所以「排队中的 op 占住目录」根本占不住——它会被执行掉、连歌一起带走。**只有 attempts 到顶的永久失败 op 才是真路障**，造这种夹具必须自己把 attempts 写到上限
- **清空迁移备份的四道锁**（判据 51/61）：不在白名单（迁移期直接 503）· 要 `confirm: true` · 走迁移 mutex · **core 删的是目录本身而不是 ledger 里的路径**——逃逸因此结构上不可能。顺序上 **ledger 先忘记备份、文件后删**：崩溃留下的两种谎里，「没有备份」而文件还在只值一次重跑，「原件安全地躺在备份里」而它已经没了要赔一个文件
- **GUI 在挂载 App 之前就得知道 daemon 服不服务**：迁移期业务路由全 503，而 `App` 一挂载就有五个 store 去 fetch，所以门开在 `App` 外面（`BootGate` 探 `/status`）。**探不到的 daemon 不是正在迁移的 daemon**——落回正常 app，卡在探测上只会把「daemon 正在启动」变成一个空窗口
- **被销毁的 BrowserWindow 仍是一个正常 JS 对象**（T3 演练时抓到的老缺陷）：`!== null` 判活会在窗口被销毁后（渲染进程被杀、teardown 挨 SIGTERM）让下一次 dock 点击对尸体调 `show()`，未捕获异常打死 app 并**留下一个关不掉的错误弹框**。收敛成 `main/window-ref.ts` 的 `WindowRef`：**每次用的时候问 `isDestroyed()`，不记**；`closed` 只是顺带清引用，且旧窗口的事件不许清掉新窗口
- **导入的扩展名不再判定任何事**（T4）：它是与文件对话框共用的一份清单（`@lark/shared` 的 `IMPORT_AUDIO_EXTENSIONS`，两边不同步 = 对话框给的文件 daemon 不收），真正判定的是探测。**装着 AAC-in-MP4 的 `.mp3` 现在正常导入并走 copy**。拒绝三条严格在前：真视频轨（**封面不算**）→ 无音频流 → codec 不在白名单
- **导入的 codec 白名单列「到得了的」，不是 profile 解码器全表**（T4）：`aac_fixed`/`mp3float` 从不作为 `codec_name` 出现，`aac_latm` 需要没建的 LOAS/TS demuxer。这条白名单真正在拦的是 **`pcm_f64le`**——ffprobe 认得出、ffmpeg 到了才说 `no decoder found`，拦在 spawn 之前才换得到一句关于格式的话。它**不进 `REQUIRED_CAPABILITIES`**：一个解不了 flac 的 ffmpeg 照样能下载、转换、播放 lark 产出的一切
- **凡是「shipped profile 能不能做到」的测试都要显式指向 vendored 构建**（T4）：`resolveMediaTools()` 默认挑 Homebrew，那份什么都解得开——在开发机上它会全绿地放走一个缺解码器的构建。用 `@lark/core/testing` 的 `vendoredToolsDir()` 塞 `LARK_MEDIA_TOOLS_DIR`。同源的静态守卫是 `media-tools/profile.test.ts`（读 `vendor/ffmpeg.lock.json` 的 configure 比对三份清单）
- **多音轨文件的容器时长是最长那条轨**（T4 夹具照出来的旧缺陷）：只留第 0 条却记容器时长，曲库行就会宣称一个它的文件没有的长度。`probeAudio` 在「音轨 >1 且流自报时长」时改用流的
- **ipod muxer 会把音频挪到 stream 0**，`-map` 先给封面也没用：所以本仓「音频不在 0 号」的真文件只有 `scripts/fixtures/tone-1s-video.mp4`（h264 在 0、AAC 在 1）——判据 60 的真文件证据只能是它
- **命名模式不进 dedupe key，所以冲突只能拒绝**（T5）：进了就等于同一个视频下两遍去存两个名字；合并则会让第二个提交者悄悄拿到第一个人的答案。全量预检必须在**容量检查与歌单事务之前**，否则 merge 到第 40 项才发现时歌单已经建出来了
- **「取消」在 `clean` 路径上的差别只在一种形态下看得见**（T5）：`inferSongInfo` 吞掉 abort 时，下游任何一次网络调用都会撞上同一个 signal，任务照样进 cancelled——**测试因此在没有修复的情况下也是绿的**。真正的差别在「这首歌本地已有文件」：那条路径上 resolveTarget 之后再没有网络，任务会走过 commit point 报成功并加进用户已取消的歌单。**要验一个 fail-closed 的分支，先确认没有别人替它兜底**
- **`tsc -b` 会跳过没有 `references` 的 project**（T5）：gui 的两个 project 原来没声明依赖，改 `@lark/shared` 不会让它重跑，`just check` 全绿而 renderer 停在旧类型上。**而 `pnpm --filter @lark/gui exec tsc --noEmit` 什么都不检查**（gui 根 tsconfig 是 `files: []` + references）——两个假绿叠在一起。要单独查 renderer 用 `tsc -p tsconfig.web.json`
- **进度节流放在 engine**（T5）：只有它知道自己上次发出去的是什么。阶段切换**先 flush 再归零**（停在 97% 的进度条比没有更糟），终态也归零；`total_bytes` 用 `null` 不用 0——「不知道多大」和「空文件」对进度行是两个问题。字节进度让 `(state, stage, song_id)` 不再唯一，dedupe 只能靠 `revision`
- **同一个词既当分区标题又当状态文案就会撞**（T5）：面板的「排队中」分区与排队任务自己的状态行同字，`getByText` 直接两个命中。分区标题改 `<h3>`（role=heading）才分得开
- **「保存了」不等于「生效了」**（T5b F1/F7）：写盘成功、回读正确、界面照常，而真正持有这个设置的东西（timer / 清理触发器）没被告知。`PATCH /config` 之后要把变了的值**交给正在用它的人**；只在值真的变了时交（同值再保存不该重置周期），且缓存上限**只有变小**才排清理——`0 = 不限` 是最大值，纯数值比较会把「从 0 改成 900」读成放大
- **枚举字段没有域校验 = 静默说错协议**（T5b F5）：`api_format` 只有 `anthropic` 走 Anthropic 分支，**其余一切都走 OpenAI**，所以拼错的值会被保存下来然后安静地用错协议。域要在进来时拒、从盘上读到非法值时收敛回 `''`（跟随 aviary），不是收敛到某个没人选过的协议
- **`''` 是一个值，不是「没设置」**（T5b F5/F6）：`api_format: ''` = 跟随 aviary、空 api_key = 用 aviary 的共享 key。UI 把它们显示成 `openai` / 「未设置」都是在说反话；`''` 要有自己的选项并带上**它当前解析成什么**（`llm_effective_format`，`GET /config` 拿不到）。**Radix 不许 `Select.Item` 的 value 是空串**，替身翻译只发生在那一个 Select 的两端
- **一个 fail-closed 的分支，先确认没有别人替它兜底**（T5/T5b 共同教训）：判据 27 的第一版测试在没有修复时也是绿的（下游的 signal 兜住了），判据 42 的 badge 同理要断言「归零后消失」而不是「显示过」。写完先把修复去掉跑一遍——绿的就是没测到
- **残留的测试 nest 多半是「跑挂的测试」而不是漏了 `rmSync`**：`pnpm -r` 一个包失败会杀掉并行的其它包，它们的 `afterAll` 没机会跑。数一下前缀与时间戳能分清是漏清理还是被打断

## Phase B 实测锁定（随批次追加）

- **`SqliteLike` 的绑定参数只能是 `unknown[]`**（N0a-1）：better-sqlite3 的 `prepare` 是条件泛型（`BindParameters extends unknown[] | {}`），按约束实例化得到 `Statement<[{}],…> | Statement<unknown[],…>` 的联合——参数收窄成 `null|number|bigint|string|Uint8Array` 时 `{}` 与 `null` 双向都不可赋值，`satisfies` 当场红。**窄类型在这里不是更严格而是更假**：better-sqlite3 自己就是 `unknown[]`，坏值两端都是运行时错误。绑定的三种形态写进 doc 注释而不是类型
- **portable 的测试跟着主体走、被守卫排除**（N0a-1，与 shared 守卫同形态）：它们跑在桌面运行时，合法地用 `node:fs` / better-sqlite3 / `createDatabase` 造夹具；发到手机上的是从 `portable/index.ts` 可达的模块图，没有任何测试在里面。**契约 cases 不是测试**（纯函数），照常受守卫约束
- **re-export 不是重新定义**（N0a-1）：三个迁移 error 移进 `portable/errors.ts` 后由 `errors.ts` re-export，daemon 的 `instanceof` 与 CLI 的 `err.name` 两种消费都不受影响——实证 `core.SchemaMismatchError === portable.SchemaMismatchError`
- **守卫的越界规则按深度计数，不按目录名清单**（N0a-2）：portable 长出子目录之后，`(\.\./)+errors\.js` 分不清合法的 `../../errors.js`（从 `contract/cases/` 看是 portable 自己的）与越界的 `../../../errors.js`。改成「`../` 个数 > 文件在 portable 下的深度 = 越界」——精确、捕获任何逃逸，且不再需要「core 新增顶层目录要来改脚本」
- **「提交后可见」只证明同一个文件，不证明同一条连接**（N0a-2 实证）：把 drizzle 换到第二条连接上，共享连接组两条序列都红；再把两处**未提交窗口断言**删掉，**序列 2 当场变绿**。序列 2 的保护全部来自那一条断言（序列 1 是被写锁本身挡下的）
- **FK 默认值是宿主差异，不许进契约**（N0a-2）：better-sqlite3 开连接时自己就把 `foreign_keys` 打开（读到 1），而 SQLite 与 expo-sqlite 的默认是关。契约只断言「显式 `foreign_keys = ON` 之后强制与级联都对」——core 依赖的是 `db/index.ts` 里那句**按连接**设置，不是任何一家的默认
- **破法选错会得到一个安静的绿**（N0a-2）：验 fail-closed 时把 `PRAGMA user_version` 挪到 `COMMIT` 之后，61/61 全绿——迁移 SQL 抛错时根本走不到 COMMIT，「提交顺序」不崩溃就观测不到。真能证伪的是「去掉事务」与「版本戳提到 DDL 之前」。**反测没红的时候，先怀疑破法而不是判据**
- **契约夹具不许假设空表**（N0a-2）：迁移链自己会往 `local_metadata` 写（0003 的 `audio_migration_pending`），数整张表的用例一上来就红
- **RN 版本要读 Expo 的 `bundledNativeModules.json`，不是 npm latest**（N0b-1）：SDK 57 钉 **react-native 0.86.2**，而 npm 上 latest 是 0.87.0。同理 spike 的 react 要**与 gui 逐字节相同**（19.2.4 / @types 19.2.18）——hoisted 之后全仓只有一份副本，这是判据 13 一次就绿的原因
- **`android/` 是 CNG 产物，不进仓**（N0b-1）：一切影响原生工程的东西都写在 `app.config.ts`；只能靠手改 gradle 表达的，属于 config plugin。spike 的 applicationId 是 `…lark.spike` 而**不是** D14 的产品 id——戴着产品 id 的 spike 会让第一次装真包继承它的 data 目录
- **adb 驱动真机时，先确认 spike 在前台再截屏**（N0b-1/2 各踩一次，两次都拍到了用户自己的应用）：`pidof` 不够（后台也有 pid），要 `dumpsys activity activities`。两种把自己弄出 app 的手势：**dev menu 用一次 BACK 关，第二次就退出**；**连续快速上滑会被当成 home 手势**——滚动要慢（`swipe … 400ms`）且**不要从屏幕边缘起手**
- **`finalizeSync()` 在执行失败后会抛，抛的是那条语句自己的错**（N0b-2）：`sqlite3_finalize()` 返回最近一次求值的错误码，**但无论如何都销毁语句**——所以它不是泄漏，是把正在传播的错又报了一遍。放它从 `finally` 逃出去，`UNIQUE constraint failed` 就变成一句关于 finalizeSync 的话。shim 与 drizzle patch 都**只在 execute 已失败时**吞掉它并照常计数
- **`json_set` 绑定数字的存储类型是宿主差异**（N0b-2）：better-sqlite3 存 `real`，expo-sqlite 存 `integer`，同一份 SQL 同一个 JS number。`rebase.ts` 的 `IN ('integer','real')` 门原本是防御性的，**在第二个宿主上是必需的**。跟 FK 默认值同一类：一家的行为不是契约
- **命名参数三家三种方言**（N0b-2）：core 写 better-sqlite3 形（`@name` + 裸键），expo-sqlite 要键带 sigil，op-sqlite **只有位置参数**。翻译前必须剥掉单引号字面量，否则 `'$.updated_at_ms'` 会被当成参数名
- **spike 经 dist 消费 core**（N0b-2）：改了 core 源码不 `pnpm --filter @lark/core build`，真机重载跑的还是旧代码——与 M2 的「`just test-*` 一律前置 build」同一条
- **`finally` 里不许 `return`**（N0b-2）：它会吞掉正在传播的异常。漏版 shim 的反测若用 `return` 跳过释放，量到的就是「不抛了」而不是「不释放了」
- **release APK 不等于 release bundle**（N0b-3）：spike 依赖里有 `expo-dev-client`，`expo run:android --variant release` 装完就去开 dev-client 的 URL——Metro 还开着的话，release 外壳跑的是 Metro 的 JS。分辨只能靠 `__DEV__`（打包时烙进 bundle）：面板印出自己是哪个 bundle，`judge()` 在 dev bundle 上一律返回 `null`，**debug 跑出来的连 PASS 都渲染不出来**。同一份代码 release 比 debug 快 2–5 倍
- **性能夹具的 journal 模式是判据的一部分**（N0b-3）：不设 `journal_mode` 量到的是 DELETE 模式，500 首一段的 p95 是自己 p50 的 4 倍；照 `db/index.ts` 的顺序补 WAL（**先 busy_timeout/foreign_keys、读完 user_version 再 WAL**，M1 的「判定前零写入」）之后 p95 贴着 p50。量一个产品不会用的模式，得到的分批尺寸没人该信
- **`atob` 不是 `Buffer.from(x,'base64')`**（N0b-3）：7 个样本里 2 个发散——非法字符与 url-safe 字母表上 `atob` 抛而 `Buffer.from` 照常解。`decodeBase64` 的 try/catch 会把「抛」变成 `null`，于是一条本来有歌词的响应静默变成没歌词。base64 端口要按**宽松语义**写，不能包一层 atob 了事
- **`globalThis.crypto.getRandomValues` 在 RN 上不存在**（N0b-3）：`wbi.ts:147-153` 原样搬过去就抛。而 **`globalThis.fetch` 就是 `expo/fetch`**（SDK 57 的 winter runtime 装的同一个函数），manual redirect / 204 / 流式 `res.body` 三条全过——N1 不必为 fetch 做注入选型
- **纯 JS 同步 digest 只在小输入上赢**（N0b-3）：noble md5 签一个 WBI query 0.02ms（比 async 快一个数量级，而每个请求都签），但 sha256 在 256KB（= `SYNC_FILE_OP_INLINE_MAX`）要 86ms，而 `digestStringAsync` 只要 1.9ms。**阈值要绑在调用图真能遇到的尺寸上**：`inlineDigest` 唯一的大输入是内联歌词，真实 LRC 5.7KB 只要 1.94ms，256KB 是上限不是常态——判据因此改绑真实尺寸，上限继续测、降为标注的最坏值（用户拍板）。**改判据要先改代码再重测**，拿旧数字重新解释一遍会得到一份没人跑过的判据
- **release 构建的 `console.log` 到不了 logcat**（N0b-3 实测，六个前缀零命中）：RN 的 console→原生日志是开发工具链的一部分，于是「数值判据必须用的那个构建」正好是唯一打印不出来的那个。结果只能靠面板上屏或回传桌面（spike 的 `probe-host.mjs` + `adb reverse`）；debug 照常有 logcat
- **写语句形状 proxy 要照当前 schema 抄**（N0b-3）：`sync_cursor` 在 0002 被 DROP 重建（`endpoint` → `(server_id, workspace_id)`），按 v1 的记忆写出来的负载在真机上直接报 no such column
- **`ANDROID_HOME` 只活在用户的交互 shell 里**（N0b-3）：从别的进程跑 release 构建会在 Gradle 之后死于 `spawn adb ENOENT`。按 `JAVA_HOME` 同一形态钉进 recipe。顺带：`just … | tail` 会让后台任务报 exit 0 而 recipe 其实失败了——管道吞退出码不分场合
- **签发流 URL 的那张网决定它能不能用**（N0b-4a）：playurl 按**调用方 IP** 派 CDN 节点，桌面家宽拿到的 `cn-bj-cc-*` 在电信 5G 上 DNS 解得出、连不上（`adb shell curl` 独立复现）。探针要跑两遍矩阵：桌面签的（core 真会拉的字节）与**设备自取的**（唯一能回答「这张网能不能拉音频」）。顺带：**最低 header 要求按节点不按平台**——cc 节点缺 `Referer` 403，移动网络派来的 mcdn `:8082` 节点零 header 也给 206，且 content-type 是 `application/octet-stream` 而不是 `video/mp4`
- **VPN 会静默换掉被测网络**（N0b-4a）：第一轮 Wi-Fi 探针跑在 Clash 的 tun0 下（bilibili 不在 bypass 清单），风控看到的不是真实出口 IP。跑网络判据前先 `dumpsys connectivity` 看默认网络是谁
- **判据 19 的证据末端在主机侧，不在 JS**（N0b-4b）：`player.playing` 在焦点被抢期间仍是 true（系统里我们是 `state:paused`），而 `release()` 泄漏的音轨 JS 根本听不见——`drive.mjs audio` 读 `dumpsys audio` 的活跃播放器才是能写进文档的那句话。**`release()` 必须先 `pause()`**（#47569 在 expo-audio 57.0.3 上实证仍在，泄漏的音轨只有 `am force-stop` 能收）；**蓝牙断连不暂停而是转外放**（media3 的 `handleAudioBecomingNoisy` 默认关、expo-audio 未暴露）
- **manifest 声明权限 ≠ 拿到权限**（N0b-4b）：`POST_NOTIFICATIONS` 要运行时申请，而**锁屏控件就是那条通知**——不申请则播放一切正常、锁屏空空如也。同段还有：`shouldPlayInBackground` 单独不够，Android 上不调 `setActiveForLockScreen` 约 3 分钟就停；**熄屏后 JS 定时器被冻结（实测最大 85s 一跳）而播放时钟没有**，所以「后台还在不在播」不能问 JS 定时器
- **切网/开关 VPN 之后 dev client 回不到 Metro**（N0b-4b）：编辑不再热更而面板看起来完全正常（只有旧分组名露馅），deep link 指 `localhost:8081` 也叫不回来，这台 vivo 的 `adb logcat` 还是空的。可靠路径是 **release 构建**（bundle 烙进 APK）。顺带：**`drive.mjs dump` 只列当前屏可见节点**，判断某个按钮在不在要用会滚动的 `tap`
- **分享进来的只有短链，没有 bvid**（N0b-4c）：bilibili 8.83.0 发的是「标题 + `https://b23.tv/xxxxxxx`」，`EXTRA_TITLE` 为空——**添加页在展开短链（一次 `redirect:'manual'` 往返）之前识别不出任何东西**。而**收藏夹根本分享不出来**：它的「分享」直接进 bilibili 自己的发动态发布器，到不了系统面板，所以收藏夹/合集只能走粘贴框。payload 还是**易失的**（`resetOnBackground` 默认开，切后台即清），谁用谁在挂载时消费
- **`performance.now()` 在 RN Android 上是 `SystemClock.uptimeMillis()`**（N0b-4c）：不从 JS context 起算（要自己在模块顶层留基线），且**深睡期间不走**——实测读数比同时刻 `/proc/uptime` 少 13.5 小时，正好是手机睡的那一夜。与「熄屏后 JS 定时器被冻结」是同一件事的两面：跨熄屏的「过了多久」不能问这两个中的任何一个。毫秒级差值（N0b-3 全部数值）不受影响
- **`allowBackup=false` 只关云备份，关不掉 D2D**（N0b-5a）：Android 12+ 的设备迁移走 `dataExtractionRules` 的 `<device-transfer>`，两套开关都要。而 **expo-secure-store 默认会把那两个 manifest 属性指向它自己的规则文件**——必须 `configureAndroidBackup: false` 让位，两个插件写同一对属性时后写的赢且构建日志一声不吭，所以我们的 plugin 见到属性已被占用**直接抛错**。判定证据一律取自 **APK 的 merged manifest**，且编译后属性是数字 id（`@0x7f140002`），要用 `aapt2 dump resources` 翻回名字才知道指的是不是我们那份
- **证据要取在能观测到的那一刻**（N0b-5a）：用「副本旁边有没有 `-wal`/`-shm`」判断「恢复发生在副本上」恒为假——读完就 `closeSync()`，而关闭本身会 checkpoint 并删掉这两个边车。改成跨 open 前后比对副本的 size/mtime 与 WAL 字节（4,128,272 → 0）才看得见。**恒为假的断言和恒为真的一样没用**
- **Gradle 的 bundle 任务看不见 `packages/core/dist` 的变化**（N0b-5b）：`build-core` 做了、APK 里还是旧 core——core 的 dist 经 workspace 符号链接落在任务声明的输入之外，Gradle 判 up-to-date。症状是「桌面已修好的用例在手机上继续红，**面板里连断言文案都是旧的**」。`spike-mobile-android-release` 因此先 `rm -rf` 生成的 bundle 再构建。比 M2/N0b-2 的「先 build」更隐蔽：build 做了，只是没人用
- **一个 `Uint8Array` 既是值也是对象**（N0b-5a，N0b-5b 复现于第二个适配器）：shim 的「单参数是不是命名参数表」只看 `typeof === 'object'`，于是 `run(chunk)` 报 `bound key '0' does not appear as a named parameter`——一句关于错误东西的话。core 今天不绑 blob 所以契约没问过，但 doc 明写值形态含 bytes，**这个歧义对任何「看长相定形态」的宿主都在**。已修 + 契约补一条 lone-bytes 用例（better-sqlite3 回 Buffer、expo 回 Uint8Array，只断言往返）
- **`openLibrary` 停在步骤 ⑦，不产 `device_uuid`**（N2b 真机实测）：这是 §2.2 的分工——⑨ 归 D16 身份门，把它折进打开路径「顺手做掉」会让一个有主的步骤变成没主的。第一版真机面板正好断言反了（「开完就该有」），**面板的第一条红是它自己的断言**，而这恰好证明面板不是白跑的。修法是让用例断言真正的不变量：开完**没有**身份 → 调 `ensureDeviceUuid` → **重开还在** → 再问幂等；桌面 `open-library.test.ts` 同时加了「`prepareLibrary` 不 mint」一条守着同一件事
- **`am force-stop` 紧跟 `am start` 会赛跑**（N2c 实测）：进程起来了，activity 却被压到后台，前台是桌面。`pidof` 说「在」，`dumpsys activity activities` 说「不在」——**这正是 `drive.mjs` 的前台守卫存在的理由**，否则接下来 dump 到的是桌面而结论会写成「应用崩了」。做法是 start 之后先 `top` 确认，必要时再 start 一次（第二次会答 "current task has been brought to the front"）
- **幂等的清理里混进一个不幂等的写，只有「只清一次」这种判据逮得到**（N2c 实测）：converge 崩在 DB 事务之后再重启，会整段重跑一遍——所有 `DELETE` 都幂等，唯独 `bumpBackfillTarget` 不是，实测 `backfill target 1 → 3` 而不是 `1 → 2`。代价是下次登录白跑一整轮 backfill，且症状要到 N5 才显形。修法是**在写 `install_id` 的同一个事务里先读它**，已经等于目标就整体跳过：同一个事务 = 要么全发生要么全没发生，所以这个标记是精确的而不是启发式的。判据 19④ 那句「binding/credentials **只清一次**」当时读起来像措辞，实际是唯一能观测这件事的断言
- **D16 的夹具不必推文件**（N2c）：决策 o④ 的 `adb push` 通道是为判据 14 的真实桌面副本准备的；D16 自己的判据要的是「一个本机没有身份的库」，忠实造法是**用真路径造一个真库再把身份拿掉**——那正是恢复干的事。推文件反而把导入通道一起测进去了
- **崩溃点用「抛」模拟，与真 kill 的差别只有一处**（N2c）：到达崩溃点时该写的都已落盘（SQLite 已提交、SecureStore 的写是同步的），所以抛出留下的**持久化状态**与 `kill -9` 相同，且点位是选的不是猜的（`am force-stop` 猜不准）。唯一的差别是抛出会栈展开、顺手关掉句柄，而真死亡留下开着的句柄和可能热的 WAL。这条差别在 D16 这几条上不重要（N0b-5a 已量过 4MB 热 WAL 的 copy-then-open），**到 N2d 的 file-op drain 才重要**——drain 中途死掉留下的是半个文件操作，那不是数据库状态
- **Expo 的 `AsyncFunction` 会转换 lambda 的返回值**（N2d 实测）：`Files.move(...)` 写在 try 表达式的末句，Kotlin 就把 lambda 的返回类型推成 `Path`，真机上报 `Unknown type: class sun.nio.fs.UnixPath`——一句完全不提「返回值」的话。把 move 提成一个 Unit 函数顺带修掉；提取本身另有理由：**instrumentation 测试必须驱动生产代码，不能是并排的一份复制品**
- **`just <recipe> "带空格的参数"` 会被 `*ARGS` 拆开**（N2d 实测）：`just mobile-drive tap "Run file system scenarios"` 到 `drive.mjs` 手里只剩 `Run`，而 `tapByText` 是子串匹配 → 点了第一个 `Run…` 按钮并自信地打印 `tapped "Run D16 scenarios"`，**一整组结果读的是另一块面板**。驱动脚本改成把 `argv.slice(3)` join 起来。同一类形状：**「它报告自己干了什么」和「它干了你要的那件事」是两件事**
- **缓存别人拥有的状态，就会在别人被重置时永久失配**（N2d 实测）：`installPortableRuntime()` 里有个模块级 `installed` 标志，而 `resetRandomForTesting()` 清的是 portable 那边——标志还说「装过了」，于是重装被跳过，之后每一个 id 都抛。`installRandom` 对同一个对象本来就幂等（source 是模块级常量正是为此），那个标志纯属多余。**判据 11 是先意外撞上、再被转成正式用例的**
- **判据 10① 只能在 instrumentation 里回答**（N2d 实测）：JS 侧同线程轮询下，一个「先删后 rename」的实现与原子实现一样绿——桌面 `node-fs.test.ts:60` 之所以观测得到，是因为那边的写是真异步。移动端的窗口要两条真线程 + barrier，且**反测必须正向断言「我看见了那个窗口」**。**这条自身也验过**：把反测指向 `AtomicMove.atomic`，它以自己写的那句话失败（读者再也看不见缺失）——所以那条断言测的是删除窗口而不是恒真，原子那条才因此有意义。顺带：move 必须从 module 的 lambda 里**提取成顶层函数**，否则测试驱动的是一份并排的复制品，真实现改了它照样绿
- **文本到没到看屏幕，文本对不对看回读**（N0b-4c）：屏幕证不出末尾少一个换行或空格变成 `%20`，所以 `drive.mjs share` 发完就去 `.runtime/` 读设备 POST 回来的那份**逐字符比对**。驱动用户自己的应用要**一步一 dump**：分享面板第一屏没有「更多」（要横滑），而收藏夹那条路上的盲点按钮是**会真的发动态**的

- **写反测的时候才发现用例有洞，比跑红了再补便宜得多**（N2d 实测）：移动端 `SongFilesPort` 的三个变异里，「`removeSongDir` 去掉 `exists` 守卫」原本会**安静地全绿**——七条场景没有一条把不存在的目录交给它，因为 `deleteRemote` 先问 `songDirExists`，而**唯一不问的入口是 `delete_song_files` 的 local 分支**（它无条件删）。同轮还漏了 `quarantineExists` 的 true 分支：造它必须把重放的 op 指回**它自己的 target**，另起一个 target 的第二条 op 走的是「没东西可搬」那条路、什么也证明不了。两条都是**先想「这条要是坏了谁会红」、发现没人会红**，才补的用例
- **expo-file-system 的 move 按目标存不存在分叉，两条都得照 Kotlin 读**（N2d 实测）：`File → Directory` 要求目标目录**已存在**（`prepareAsDestination` 抛 `DestinationDoesNotExistException`）；`Directory → Directory` 则是——目标不存在则源**变成**它（父目录必须在），目标存在则源被**塞进它里面并报成功**。后者对「把歌曲目录挪成 `recovered-songs/<target>`」是安静的错形状，所以适配器把它变成显式抛错。两条各自的「不建目录」变异都在真机上点着了对应的场景
- **一个「停在选定点上」的面板 + `am force-stop` = 又真又准的崩溃点**（N2d 实测）：D16 的崩溃点用抛，对已落盘的数据库状态成立；drain 中途的半状态在**文件系统**上，抛会栈展开而 SIGKILL 不会。做法是让被破坏的宿主动词到达那一刻后返回一个**永不 resolve 的 promise** 并把 `PARKED` 显示出来，主机看见字样再 force-stop——**点是应用自己选的（决策 o⑤），kill 是真的**。夹具里跨进程要活下来的东西（song id、quarantine target）在停下之前就写进 `local_metadata`：停下之后没有任何写入的机会
- **翻译表也要反测，不然它只是装饰**（N2e 实测）：LibraryContract 的 mobile hook 把 core 的四个错误类映成 `ContractFailure`，其中 `NotFoundError` 正是计划 §1.3 记的「v1 漏了的那个」。把它从表里删掉 → **两条用例红**（「一个用不上的 uuid」与「删歌之后再读」），报 `expected a ContractRefusal, got NotFoundError`。同轮的另一个变异是计划要求的破法：删掉 `requiredName` 的 `.trim()` → 红的正是两条 §7 F13 用例，文案就是当年那个 bug（`a blank playlist name: expected a refusal, got a result`）。**没映上的错误要原样抛，不要塞成 `other`**——`other` 一律算失败，抛出去至少带栈
- 🔴 **`adb push` 进 `/sdcard/Android/data/<pkg>/files/` 的目录，应用读不到**（N2f 实测两轮）：① push 会把中间目录建成 `shell` 所有，应用随后在 `Android/data` 就被挡——探针答 `0✓/Android✓/data✗/<pkg>✗/files✗`（对照组：应用自己建的那个目录属主是 `u0_aNNN`）；② 只问 Android 要路径也不够，**expo 的权限判定是对路径本身做 `File(path).canWrite()`**（`FilePermissionService.kt`），不存在的目录不可写，于是「本应用有权建的地方」被拒成 `Missing 'WRITE' permission`。可行顺序只有一个：**应用先用 `getExternalFilesDir(null)` + `mkdirs` 把地方建出来**（这不是查询，是以本应用身份创建），adb 再推，应用才读得回来。推送脚本因此在目标不存在时拒绝执行，而不是自己 `mkdir` 一个谁也打不开的目录
- **没有 ICU 的 Hermes 不抛，它回落成码点序**（N2f 实测，本机是有 ICU 的）：`Intl.Collator('zh-CN')` 的失败形态不是异常而是「安静地按码点排」，也就是它本来要修的那个毛病。所以用例要**两句都断言**——等于拼音序 **且** 不等于码点序；只写前一句的用例分不出「排对了」和「根本没排」
- **「库里存的等于函数刚返回的」这类断言恒为真**（N2f 实测）：验收原本断言 `local_metadata.device_uuid` 等于 `boot.deviceUuid`，而无论第 ⑨ 步是新铸还是沿用了导入库里的旧值，这句都成立。改法是**在删之前把旧值读出来带回**，断言新旧不同——反测（不删旧 uuid）这才红成 `582fb1df… → 582fb1df…`
- 🔴 **按 BACK 再回来，expo-sqlite 的库就打不开了**（N2f 实测）：Activity 被销毁而进程还活着，第二次开库报 `NativeDatabase.prepareSync … NullPointerException`。根因在 expo-sqlite 57.0.1 的 `OnDestroy`——它想关掉缓存的数据库，而 `removeAllCachedDatabases()` **返回的就是它刚 `clear()` 掉的那个 list**（同一个对象），`forEach` 走了个空，留下一批原生已释放的 JS 句柄。修法不是绕过去而是把形状摆正：**启动序列是进程级的**（身份门、迁移、journal drain），`bootOnce()` 每进程一次；一个屏幕重新挂载就重跑整条序列，本身就是错的。验收仍直接调 `runBootSequence`——它的活就是反复从自选状态启动
- **`SafeAreaView` 在 Android 上什么也不做**（N2f 实测）：它只处理 iOS 刘海，标题会直接画在状态栏上。要 `StatusBar.currentHeight` 的 padding
- **按标签驱动的脚本有两处会安静地测错东西**（N2f 实测，同一天各踩一次）：① **滚动会关掉 modal**——`tap` 先滚到顶，25 次滑动落在打开的 sheet 背板上就把它关了，之后报「找不到标签」，而在那之前的一整轮结果读的是背后那一屏。滚动只对「列表比一屏长」有意义，验收脚本的默认应当是**不滚动的 `tap-visible`**；② **子串匹配会被新标签偷走**——给设置页加了个「歌曲目录」之后，每一次 `tap "歌曲"` 都按在这个字段上并静静留在原页。改成**精确匹配优先、子串兜底**（`Run file op scenarios` 这种短语仍要子串），并顺手让两个标签不再互相包含
- **`adb shell input text` 只能打 ASCII**（N2f 实测）：中文会从 `InputShellCommand.sendText` 抛一整段 Java 栈，看着像设备故障而不是「这个字符没法这么输」。驱动脚本自己拦下并说清楚；需要中文的断言换个层做——搜索的针从夹具里挑一个拉丁串，中文与 trim 那半由 LibraryContract 在同一台机器上覆盖
- **真机跑验收的时候，人也在用那台手机**（N2f 实测）：连着几轮失败被我先后归因成「滚动弄丢了控件」和「IME 吃掉了第一次点击」，实际是用户以为跑完了、把应用退了。症状长得像应用 bug——`not in front`、`never found <一个屏幕上明明有的标签>`、`nothing on screen contains <点了行之后本该出现的东西>`。**长时间的真机验收要么先说一声，要么把「前台守卫失败」当成人为干扰的默认解释**，而不是先去改被测代码
- **一个删掉也不会有人红的分支，就是死代码而不是防御**（N2g 实测）：计划把蓝牙歌词的回落写成四条，其中「没有歌词」与「还没到第一行」在 `currentLrcIndex` 之后**不可区分**——空数组进去 `high = -1`，二分不进循环，只能回 `-1`。照四条写就会有一个 `if` 永远轮不到，而判据要求的「删掉该分支那条必须红」对它不成立。收成一句 `const line: LrcLine | undefined = lyrics[currentLrcIndex(...)]` 之后，两种输入共用一个守卫、各留一条用例，删守卫两条一起红。**「几条回落」是行为的数目，不一定是分支的数目**；把它们凑成一样多，多出来的那个是装饰
- **断言的顺序决定哪条会红，而先红的那条会盖住你真正要证的那条**（N2g 实测）：长度上限的 emoji 用例里，「长度是 64」排在「结果里没有孤代理」前面时，把 `[...text]` 换成 `text.split('')` 只会红在长度上——**那句关于「不切半个字符」的断言一次也没执行过**。把它提到第一句，同一个变异才报 `expected true to be false`。同轮还有一处形状相同的：`'🎵'.repeat(70)` 按 UTF-16 切在 **64 这个偶数**上正好落在代理对边界，naive 实现照样绿，**得加一个 `あ` 前缀把切点顶到奇数单元**孤代理才出得来。夹具凑巧对齐时，用例测的是巧合
- 🔴 **`pnpm patch` 打在 Expo 模块的 Kotlin 上，默认是完全无效的**（N3a 实测，两次「改了但没变」才查出来）：SDK 57 的模块在 `expo-module.config.json` 里带 `publication` 字段，Android 侧消费的是包内 `local-maven-repo/…/expo.modules.audio-57.0.3.aar` **预编译产物**，源码根本不参与构建——症状是补丁装上了、`node_modules` 里的 `.kt` 确实变了、Gradle 报 BUILD SUCCESSFUL（**8 秒**），设备上一点变化没有。开关在 `apps/mobile/package.json` 的 `expo.autolinking.buildFromSource`（一个按模块名匹配的正则表；`SettingsManager.kt:71`），加上它之后 Gradle 才出现 `> Task :expo-audio:…`。**「构建成功」和「构建了你改的东西」是两件事**——与 N0b-5b 的「Gradle 看不见 `packages/core/dist`」同一族，但这次连输入都不在图里
- 🔴 **OEM 可能把媒体通知当普通通知画，于是 Notification 自己的 action 才是控件**（N3a 实测，一张截图定的案）：expo-audio 只在 `SDK <= S_V2`（API 32）时给通知 `addAction`，API 33+ 交给 AOSP System UI 从 MediaSession 渲染媒体组件。vivo OriginOS（API 35）不走那条——同一张下拉截图里，lark 只有歌名歌手，正下方 bilibili 的通知有五个按钮。**MediaSession 侧一切正常**（`state=PLAYING`、`actions` 含 `PLAY_PAUSE`/`SEEK_TO`），所以只看 `dumpsys media_session` 会得出「都对」的结论。修法是把那个 API 门限去掉（`patches/expo-audio@57.0.3.patch`）+ 上一条的 `buildFromSource`。**取证的关键是同屏对照**：另一个应用的通知就在下面一行，「是我们的问题还是这台机器的样子」一眼可分
- **按标签驱动的第三条：`uiautomator` 看得见 modal 背后的节点**（N3c 实测）：全屏播放页开着的时候，`tap-visible "暂停"` 报的是**minibar 那个**暂停键的坐标（x=665，正是它；全屏页那个在 541），点下去落在全屏页的空隙里——**脚本说它按了，屏幕上什么也没发生**。这和 N2f 的「滚动会关掉 modal」「子串匹配被新标签偷走」是同一族：**「它报告自己干了什么」和「它干了你要的那件事」是两件事**。稳的做法是先收起 modal 再按，或者干脆用别的通道（这次是 `input keyevent KEYCODE_MEDIA_PAUSE`，顺带证明了 MediaSession 收外部媒体键）
- **图标按钮要驱动，得让脚本读 `content-desc`**（N3c）：`drive.mjs` 原来只匹配 `text`，而 N2f 的 `sheet.tsx` 甚至把「控件一律带可见文字」写成了规矩。播放器的传输键做不到——播放/暂停/下一首/队列在任何音乐软件里都是图标，标签在 `accessibilityLabel`（Android 侧是 `content-desc`）。改成两个属性都读、可见文字优先之后才驱动得动。**那条规矩是驱动器的局限，不是设计原则**
- 🔴 **一个每秒变化的秒数会让 `uiautomator dump` 直接失败**（N3c 实测）：minibar 加了进度条和 `0:33 / 7:50` 之后，播放期间的 dump 报 `ERROR: could not get idle state.` 并且**根本不写文件**——`uiautomator dump` 要等窗口 idle，而一个走着的时钟永远不 idle。**症状是驱动脚本报「屏幕上没有这个标签」**，一个完全错误的诊断。`drive.mjs` 因此改成：重试三次（顺带救了 modal 动画那种瞬时忙），仍失败就**说出真正的原因**并让人先暂停或改用坐标。同一族的第四条：**「它报告自己干了什么」和「它干了你要的那件事」是两件事**
- 🔴 **`locationX` 是相对「被触摸的那个子视图」的，不是相对 responder**（N3c 实测，用户手测报的）：自建进度条 = 一个 `PanResponder` 的 track + 里面的 rail / fill / 圆头。手指落在**圆头或已填充的那段**上时，触摸目标是那个小 View，`locationX` 只有几个像素 → 算出来接近 0 → **点一下跳回开头**。而且**越是精准点在当前位置上，越必然发生**——最像「用户想微调」的那一下最容易坏。修法是给三个子视图加 `pointerEvents="none"`，让 track 永远是目标。**验的时候要取应用自己的读数**：`dumpsys media_session` 在暂停时不刷新 position，看它会得出「四次点击都没生效」的错误结论，读界面上的 `0:03 / 7:50` 才是真的
- 🔴 **同一个 `locationX`，在 touch down 上是对的、在每一次 move 上是错的**（N3c 实测，上一条修完之后用户手测报的第二个症状）：点击精确到秒，**拖动却在起手一瞬间往前滑一截，然后从滑过去的位置开始跟手**——也就是跟的是位移不是手指。**症状本身就指明了方向**：grant 的读数可信，move 的不可信。修法是**在 page 空间里锚一次**——grant 时 `pageX - locationX` 就是 track 在窗口里的左边缘，同步拿到、不用 `measureInWindow`、也不用等异步回调；之后每一次 move 都是 `pageX - origin`，**不累加所以不会漂**。判据是「拖到某个位置 = 点击那个位置」：两条路给出逐字符相同的时间才算对

- 🔴 **`dumpsys media_session` 的 `position` 是「上次状态变化时的位置」，不是现在的位置**（N3d 实测；N3c 只发现了暂停时那一半，其实播放中也一样）：`state=PlaybackState {state=PLAYING(3), position=..., updated=...}` 里的 `position` 与 `updated` 是一对快照，播放期间**不随时间前进**。拿它给采样打时间戳，得到的时间轴会整体偏后——我据此一度以为「设备比主机快 3 秒」，而真相是标题全对、时间戳全错。**能信的是顺序，不能信的是那个数**。要位置就取应用自己报的（判据 17 因此把次数和播放位置放进**同一帧**的诊断行里）
- **跨设备对照一个「发生了多少次」的数，先证明这个数与采样相位无关**（N3d 实测）：主机按 500ms 网格重算「相邻不同输出的段数」，设备按自己的 tick 数——**只要有一个段落短于一个 tick，设备漏掉哪一个就取决于它的 tick 落在哪里**，判据当场变成概率题。做法是让主机用 0/100/200/300/400ms **五个相位各算一遍**，五个数一致才把这个数拿去要求设备，不一致就**拒收这首夹具**并指出短段落。真实曲库 7 首里拒收 3 首——开头「作词 : X」「作曲 : Y」半秒一行，全踩在这个坑上。**这条不是关于歌词的**：任何「主机算期望、设备报实测」的计数判据都该先过这一关
- **一个开关的「立即生效」，在没有心跳的状态下才是真判据**（N3d 实测）：蓝牙歌词的发布走 500ms 节流，而节流的时钟只被状态更新推着走——**暂停时一个 tick 都没有**，于是「关掉开关」如果也排队等节流，就会永远等不到，车机上挂着最后那句歌词。所以 `setMode` 强发一次绕过节流。验收正好在暂停态做的，等于顺手把这段代码的反测跑了。**要验的不是「开关能改值」，是「在最不利的状态下改了值也能落地」**
- 🔴 **一个在修复之前取得的失败测量，就是那条判据的反测**（N3e）：判据 19 要求「拿掉修法必须复现坏掉的形态」，而那个形态 N0b-4b 已经量过——同一台机器、同一个 expo-audio 版本、修法还不存在的时候（旧 AudioTrack 转 `paused`、同时新起 `deviceId:3` = speaker 的 `started`）。再装一个坏包只会得到同一张截图。**顺带：`ACTION_AUDIO_BECOMING_NOISY` 是受保护广播**，`adb shell am broadcast` 抛 SecurityException，所以这条判据也没有干跑的办法——只有真的断开一次
- **焦点请求的属性和播放的属性是两组，可以不一致**（N3e 实测，坐实 N0b-4b 的怀疑）：`dumpsys audio` 的 focus stack 里我们是 `gain: GAIN_TRANSIENT` / `flags: DELAY_OK` / `usage=USAGE_UNKNOWN content=CONTENT_TYPE_MUSIC`，而同时 `state:started` 的 AudioTrack 是 `usage=USAGE_MEDIA content=CONTENT_TYPE_UNKNOWN`——两处都由 expo-audio 自己发出。`GAIN_TRANSIENT` 的含义是「我只是临时的」，**别的播放器被打断后可能在我们停下时自己接着放**。只看 `media_session` 的 `audioAttrs` 会以为一切正常，那是 track 的属性不是请求的属性
- **`NativeModule<TEventsMap>` 的事件表要 `type` 不能 `interface`**（N3e）：约束是 `Record<string, (...args:any[])=>void>`，而 interface 没有隐式索引签名，报 `TS2344: Type 'X' does not satisfy the constraint 'EventsMap'`。改一个关键字就过
- 🔴 **`dumpsys notification` 里按包名 grep，命中的多半是 channel 定义不是通知**（N3f 实测）：判据 22② 要断言「重开之后没有媒体通知」，`grep -c orpheusaviary` 给了 5 条，看着像通知还在。全是 `AppSettings` 与 `NotificationChannel{…}` 这类**配置**记录——通知渠道的存在与通知被 post 是两件事。要看的是 posted 的条目
- **一个恰好整分的数字本身就是证据**（N3f）：进度记忆恢复出 **180.0 秒**，而应用是在 212.7 秒被杀的。只有 60 秒节拍写得出整分钟，暂停与进 background 都写不出——这比单测里的变异更硬，因为它同时排除了「是另一条路径写的」。**设计判据时可以特意挑一个只有目标机制才产生得出的数**
- **失败的加载会漏一个 media session，成功的不会**（N3f 实测）：acceptance 里三次失败加载留下三个 `ExpoAudioBasicMediaSession_<hash>`，`remove()` 收不掉；生产版连切 30 次一个都没多。区别是生产版走 `setActiveForLockScreen` 用共享 session，而从没激活过的 player 拿的是自己那个 basic session。**只在错误路径上漏，而错误路径停死播放且不重试**，所以量级封顶——记着，不修

- 🔴 **一个自建 Expo 模块少了 `android/build.gradle`，autolink 会安静地跳过它**（N4b 实测，代价是一次装机往返）：`modules/lark-media` 带着 Kotlin、`expo-module.config.json` 和 index.ts 就以为齐了——**tsc 过、biome 过、Metro bundle smoke 也过**（原生模块的 JS 面在图里，跟原生半边有没有编译无关），`BUILD SUCCESSFUL`、装上、**一启动就闪退**：`Cannot find native module 'LarkMedia'`，在任何画面渲染之前。`requireNativeModule` 在模块顶层调用，所以少一个原生模块 = 整个 bundle import 失败 = native abort，不是一条错误提示。已加守卫 `scripts/check-mobile-native-modules.sh` 进 `just check`（四件套互相对照：config 声明的类要有 .kt、要有 build.gradle、要有 index.ts），反测拿掉 build.gradle 会红
- 🔴 **MMR 读得出时长 ≠ 文件是完整的**（N4b 实测，判据 7② 抓到的真漏洞）：bilibili 的 fMP4 把 `moov` 放在**文件头**，所以 3.7MB 曲目的**前 64KB** 读回来是完整的 136.8 秒。落盘协议原本假设「④ 读不出时长」能挡住截断的下载——**不成立**，于是一次中途断掉的传输会被提交成一首歌。「能解码」和「完整」是两个问题，而「下载断了」问的是后者。修法是加一步 ③b：拿传输报的 `totalBytes` 对落地文件大小，短了就当传输失败（源没报 total 时是 `null` = 不知道，不是 0）
- 🔴 **合成 signal 的 `reason`，在 `abort` 监听器里同步读是 `undefined`，一个微任务之后才是 `AbortError`**（N4b 实测，两轮才挖到）：`AbortSignal.any([caller, timeout])` 触发时，**先派事件、后落 reason**；Node 上两次读法答案相同，所以桌面 hook 从来不需要知道。症状是契约的超时那一例判成 `other`，而第一版探针「await 完再读」看到的是正常的 `AbortError`——**探针不像生产，就会把真相盖掉**。第二版探针同时报两种读法，差异就摆在面板上。**产品代码不受影响**（原生 transfer 抛自己的 AbortError，`land` 先看 `signal.aborted`，引擎用 `cancelRequested` 分 failed/cancelled），但任何在监听器里读 `reason` 的代码在这个平台上都会拿到 `undefined`
- 🔴 **把红买成绿之前先问「为什么红」**（N4b，同一条的元教训）：超时那一例第一次红时，「这个平台的 abort 没有 TimeoutError 这个名字」是个听着就对的解释，改成「timeout 场景一律算超时」当场就绿了——**而那个解释是错的**（名字确实是 `AbortError`，`isAbortError` 本来就认）。真凶是上面那条时机。判别改回严格版 + 把「归不了类的那个错」原样带进失败文案（`unclassified was: undefined`），一轮就指到了真因
- **判据 5 的答案：bilibili 的音频流两张网都是 https**（N4b 实测，产品配置的 release 构建，冻结设备）：移动数据（电信 5G）派 `https://xy…xy.mcdn.bilivideo.cn:8082`（`application/octet-stream`），Wi-Fi 派 `https://cn-bj-cc-03-03.bilivideo.com`（`video/mp4`），两边 range 请求都回 206 且 `content-range` 带完整长度。**N0b-4a/N1i 那两轮成功不是 spike 的 `usesCleartextTraffic` 给的**——产品线因此不需要任何明文让步。**content-type 仍然按节点不同**，那条老结论原样成立：不许有代码按 content-type 判断「这是不是音频」
- **`MediaMetadataRetriever` 真的不碰音频焦点**（N4b 判据 9 实测，冻结设备）：一边放歌一边读 **37 分钟**那条夹具的时长，**22ms 返回**，播放头 0.8s → 1.7s 照常走，播放器一次 stop 都没报，而**同一刻** `dumpsys audio` 只有 **1 个 `state:started` 的 AudioTrack**。决策 b 的 A 因此不只是「文档说它只吃路径」。**这条判据必须两个按钮**：JS 说得出「没停」，说不出「系统握着几个 track」，所以场景要 park 在还在放的状态让主机去数
- 🔴 **Expo `AsyncFunction` 的最后一个表达式就是返回值，转不了的类型会在副作用发生之后才 reject**（N4c 实测）：`AsyncFunction("start") { … context.startForegroundService(intent) }` 的值是 `ComponentName`，桥转不了，于是 JS 拿到 `Call to function 'LarkTransfer.start' has been rejected. → Caused by: Unknown type: class android.content.ComponentName`——**而服务其实已经起来了**（`dumpsys` 里在）。这个 reject 读起来像「服务起不来」，恰恰相反。**副作用型的 AsyncFunction 末尾要显式写 `Unit`**。
- **驱动真机时，tap 完必须读面板再往下走**（N4c，同一次的操作教训）：我 tap 完 arm 就直接去 `dumpsys` 看服务、看到服务在就熄屏等了四分钟——服务确实在，但那是上面那条 bug 的副作用，**下载根本没入队**。四分钟白等，而且第一眼的结论（「进程没活下来」）与证据自相矛盾（服务还在 = 进程还在）。**每一步的绿都要自己读过，不能靠旁证推断。**
- 🔴 **一条两侧都绿的判据什么也没证明——「熄屏 4 分半」就是**（N4c 实测）：判据 15 想证明前台服务让下载活下来，做法是熄屏下完 54.3MB。**带服务和不带服务都逐字节下完了**（`landed 54273999 of 54273999` ×2）——4 分半、内存宽裕、应用刚离开前台时，Android 压根没打算回收这个进程。**熄屏时长不是区分变量，进程可回收性才是**。改判据：应用切后台 + **`adb shell am kill`**（它只杀「可以安全杀掉的」进程，**明确豁免持有前台服务的进程**），于是不带服务 `pidof` 为空、带服务 pid 存活并照常下完。**判据要挑一个只有目标机制才产生得出的差别。**
- **`am kill` 对前台应用无效**（同上）：可见的 Activity 不属于「可以安全杀掉」，前台状态下两侧都杀不动，看起来像「这个探针没用」。先 `input keyevent 3` 回桌面再杀。
- ✅ **熄屏下 `File.downloadFileAsync` 的传输照走**（N4c 实测，冻结设备）：JS 定时器被冻结、`performance.now()` 不前进，而 54.3MB 在 `mWakefulness=Asleep` 下一次下完、逐字节不差。**传输在原生线程上，没有把 chunk 押在 JS 线程等它**——所以移动端下载**不需要 `PARTIAL_WAKE_LOCK`**（省电量）。
- 🔴 **后台的 `startForegroundService()` 在这台机器上既不抛也不起——它被延后到应用回前台**（N4c-3 实测，冻结设备）：判据 17 的反测本想看见 `ForegroundServiceStartNotAllowedException`。实际是 `start()` 正常 resolve、**整个后台窗口里 `dumpsys` 一次都看不到服务**（0.4 秒一采，16 秒）、**应用一回到前台服务立刻出现**。对设计的意义正是这条判据要的：**在入队时刻起服务 = 整个下载期间毫无保护**，所以 `arm()` 必须在手势那一刻。对代码的意义是 `start()` resolve **只等于「系统收下了这个请求」**，不等于服务在跑——状态机因此在 start 之后 2 秒回头确认一次（`START_CONFIRM_MS`），确认不了就落 `degraded`（`ERR_LARK_FGS_NEVER_STARTED`）。**只认「抛异常」的降级判定会漏掉这一整类。**
- 🔴 **用 JS 定时器安排「进入后台之后做某事」，测的是「回到前台之后做某事」**（N4c-3 实测，反测的第一版就是这么错的）：`await wait(10_000)` 然后 arm，看起来是「后台 10 秒后起服务」——后台的 JS 定时器是冻结的（N3f / N0b-4a 早有结论），那句 wait 直到应用回前台才到期，于是 arm 发生在前台、服务正常起来、反测显示「Android 允许了」。**症状是一个看起来成立的反面结论**。要在后台那一刻执行，只有 `AppState` 的 `change` 回调——它在切换的那一瞬间到达，是 JS 最后能说话的机会。
- **前台服务的通知有大约 10 秒的延后**（N4c-3 实测）：服务 `isForeground=true` 之后，`dumpsys notification` 里前 ~10 秒**查不到**那条通知，t+13s 起才在。判据要断言「通知在」就得等过这段，否则会得到「服务在但通知不见了」的错误结论。（Android 对短命前台服务的通知延后策略。）
- **`pm revoke` 会杀掉应用进程**（N4c-3）：撤权限之后紧接着驱动面板，`drive.mjs` 报「应用不在前台」——不是脚本的问题，是进程真的没了。撤完要重新 `am start` 再操作。
- **`pm clear` 连应用的外部目录一起清**（N4c-3）：判据 19 要全新安装，`pm clear` 之后 `/sdcard/Android/data/<pkg>/files/lark-fixture/` 也没了，音频夹具要重推（先 tap「Import pushed fixture」让应用把目录建出来，再 `just mobile-push-audio-fixtures`）。
- **一个已经在库里的曲目，会把「长下载」判据变成 4 秒**（N4c-3 实测）：判据 22 要两个前台服务同时在，做法是一边放歌一边下 37 分钟那条——第一次跑只共存了 4 秒，因为那首歌前面的判据已经下过了，任务当场完成。**验收要的是过程时，先把库清空**（`resetInstall()` + 删 `songs/`），否则测的是去重逻辑不是共存。
- **一个 config 插件到底改了什么，两次 prebuild 就能对拍出来——不必等装机**（N4d-1 实测）：`expo-share-intent` 的插件确实写 `android:launchMode="singleTask"`（`withAndroidMainActivityAttributes.js:32`），子计划因此把它标成「可能改任务栈语义、答错整批形状要改」的头号风险。做法是把插件整块从 `app.config.ts` 摘掉 prebuild 一次、装回去再 prebuild 一次，diff 两份生成的 `AndroidManifest.xml`：**全部差异是一个 `<intent-filter>`**（ACTION_SEND + `text/*` + DEFAULT）。**`singleTask` 本来就是 Expo SDK 57 模板的默认值**，插件只是把同一个值又写了一遍——任务栈语义从 N2 起没变过，`bootOnce` 和 N3 的每一次真机 session 一直在它下面跑。**「插件文档说它改 X」不等于「你的项目里 X 变了」**：CNG 的生成物是可复现的，摘掉再生成一次比在设备上推断便宜得多，也确定得多。
- 🔴 **`FlatList` 只渲染放得下的行，所以「排到屏幕外」和「不存在」在真机上长得一模一样**（N4d-2 实测）：判据 23 取消成功、页面写着「已取消《…》」，而任务列表里**找不到那一行**——四条都是「已完成」。滚到底才看见它在最后。根因是 `engine.snapshot()` 交回 `[...this.#tasks.values()]`（**Map 插入序，最旧在前**），而 `hub.ts` 的头注释写的是「Newest first」，列表照着它 `slice(0, 20)`，于是**最新的终态排在最底下、被砍掉的也是最新的**。两条教训：① **一句错的注释比没有注释贵**，它让下游写出了「按契约正确」的错代码；② **顺序这种东西不能靠看手机验**，要提成纯函数去测（`downloads/rows.ts` + 7 条单测），设备只用来复验一个人眼看得出的差别（一次下载的「歌词」任务后完成，必须在上面）。
- **`adb shell input tap` 打在输入法窗口上，而 `uiautomator dump` 只报应用自己的坐标**（N4d-2，浪费了十几分钟）：键盘弹起来时底部 tab 栏在 dump 里的 bounds 一切正常（`[810,2181][1080,2303]`），按那个坐标点却全落在输入法上——我那几下把换行敲进了多行输入框（dump 里是 `&#10;&#10;&#10;&#10;`）。**`input keyevent 4` 也收不掉搜狗输入法**（RN 的 `TextInput` 还握着焦点，`mInputShown` 一直是 true）。可用的三条：① 点之前先 `dumpsys input_method | grep mInputShown` 确认；② **键盘上方的控件（提交按钮）照常点得到**，被盖住的只有底部 tab 栏和任务列表；③ **`input text` 不受影响**——焦点还在输入框上时，键盘收起来照样打得进去，所以「让用户收键盘、我来打字」是最省的分工。
- 🔴 **这个 RN 运行时的 `AbortSignal` 是半截的：静态方法有，实例方法没有**（N4e-2 实测，冻结设备 release，手机自答 `any=function · timeout=function · proto.throwIfAborted=undefined · any()→undefined`）。`withTimeout` 用的是 `AbortSignal.any` + `AbortSignal.timeout`，**bilibili 的每一次调用都走它、全都是通的**，所以没有任何迹象提示实例那一侧是空的。而 `signal.throwIfAborted()` 在 core 里唯一的调用点，恰好在**让清洗命名降级的处理器**里 ⇒ 任何一次模型失败都把那个处理器炸成 `TypeError: undefined is not a function`，整个下载失败成 INTERNAL_ERROR。**一条为了「别让任务挂掉」而写的路，自己成了让任务挂掉的原因。** 三条教训：① **「静态有」推不出「实例有」**，polyfill 常常只补一半；② 守卫查的是 import，**查不到运行时能力缺失**，这类只有设备答得了；③ **降级路径是全代码里跑得最少的一段**，在里面用一个没验过的 API，代价是它保护的东西全部失守。修法在 `portable/download/timeouts.ts` 的 `throwIfAborted`（顺带**不用 `DOMException`**——这个运行时大概率也没有，而下游只读 `name === 'AbortError'`）。
- 🔴 **静默降级会伪装成另一个功能**（同上）：`llmJson` 解析失败返回 `null`、`inferSongInfo` 请求失败被 `.catch` 吞掉，两条都不吭声。而清洗命名降级之后落库的是原标题——**和「用户选了原标题」在屏幕上一模一样**。当天两个人为「你到底切没切模式」争了一轮，而 dump 早就证明 chip 是 `selected="true"`。**凡是「悄悄退回一个合理答案」的路，都要留一行日志**，否则它的成功和失败长得一样。
- 🔴 **`describeTaskError` 的「详情见日志」在手机上指向一个不存在的日志**（同上）：engine 的 `logger` 是可选的，`apps/mobile` 没给 ⇒ `NOOP_LOGGER`；而 release 构建的 `console.*` 到不了 logcat ⇒ **INTERNAL_ERROR 在构造上就是不可解释的**。现在 `apps/mobile/src/downloads/log.ts` 是那个日志（5 条内存环），设置页是读它的地方——**在手机上，「日志」只能是一块屏幕**。代价如实记：它带原始错误，也就带 §1.4 那条泄漏面（provider 响应体），脱敏按用户决定未做。
- 🔴 **门开了之后没人接——一个关于「成功」的 bug，而没有任何东西在看它**（N4e-2 实测）：`preflightSingle` 对关键词在**配了模型时返回 target、没配时抛错**。移动端的 `recognise` 只处理了抛错那一半，把「没抛错」当成拒绝并回一句写死的旧文案。它躲过了所有守卫、类型检查和既有测试，因为**从来没有测试跑过「门是开的」那条路**。事后补的回归单测 3 行、对旧代码就是红的。**每加一道门，成功和失败两侧都要有测试**；只测拒绝，等于只测了这个功能不工作的时候。
- **反测搬进单测能便宜三个数量级，而且更准**（N4e-3）：多 P 那道门原本在任何地方都没有直接单测，它的反测是一套设备流程（改 portable → 重建 → 装机 → 验红 → 还原 → 再重建 = 两次构建加一台手机换一个布尔值）。补 `portable/download/preflight.test.ts`（10 例）之后，删掉 `pages.length > 1` **一秒见红**，而旁边三条「narrowness」用例仍绿——后者才是「这条拒绝是窄的」的证据，设备流程根本给不出。**发现某个东西「在任何地方都没有直接单测」时，那通常就是最划算的下一件事。**
- **`input keyevent 4` 有时确实收得掉键盘——但它同时把 tab 也退了**（N4e-2 实测，**更正上一条 N4d-2 的说法**）：设置页填到一半按 BACK，`mInputShown` 从 true 变 false（收掉了），可 `SettingsTab` 同时被卸载，**未保存的草稿一起没了**。所以 BACK 不是收键盘的手段，是「离开这个页面」。要在键盘弹起时点到下方的按钮，**滚动**才是对的：把目标滚到键盘上方再点。
- **`uiautomator dump` 的属性值含双引号时改用单引号包裹**（N4e-2，差点误判成「日志没记录」）：一条 `text` 里带了 provider 的 JSON（`{"error":{...}}`），于是那个节点写成 `text='warn … {"error":…}'`。`grep -oE 'text="[^"]+"'` 对它**静默无输出**，看起来就像那行根本不存在。抓文本要同时收两种引号。
- **`adb shell input text` 打不了中文**（N4e-2）：判据 26 的关键词因此换成 ASCII（`Yesterday Once More Carpenters`）。要中文只能让用户自己敲，或者走剪贴板。
- 🔴 **core 里那个「桌面替你兜住的」嵌套事务**（N4f-2 实测，代价是一次真机会话）：`enqueueBatches` 开着自己的事务调 `createPlaylist`，而后者又开一个 `.immediate()`。**better-sqlite3 发现自己已在事务里会降级成 SAVEPOINT**，所以桌面、daemon、CLI 和 `engine.test.ts` 的全部用例都在无症状地跑着这个 bug；`portable/sqlite.ts` 的契约**明写不保证嵌套**（决策 c2），expo-sqlite 的 shim 就照 SQLite 的规矩拒绝 —— 手机上**每一次批量提交必抛**。旁边的 `library/transfer.ts:393` 一直是对的，`…InTx` 那套拆分就是为这件事存在的。反测：把 sqlite 句柄包一层「不许嵌套」再跑引擎，**一毫秒见红，而它旁边七条 `enqueueBatches` 用例照绿**——这正是它能瞒过桌面的原因。**移植层的价值不在于代码能编译，而在于宿主之间不一样的那几处会当场炸给你看。**
- 🔴 **`startForegroundService()` 之后再 `stopService()`，会把进程杀掉**（N4f-2 实测）：那个调用是一句**承诺**——服务必须在几秒内 `startForeground()`。在服务被创建之前撤销它，`startForeground()` 就永远不会发生，系统抛 `ForegroundServiceDidNotStartInTimeException` 干掉整个应用。触发路径平淡得可怕：**arm 了、然后这次提交被拒绝**（队列空 + 阶段还是 `arming` → 立刻停服务），也就是判据 33 让人去试的「歌单名空着提交」。修法不在 JS：模块**永不撤销一个还没落地的 start**，改成留一个 `stopRequested`，服务起来、`startForeground()` 之后自己 `stopSelf()`。**「我改主意了」和「我从没请求过」在这个 API 上不是一回事。**
- 🔴 **Android 12 起，前台服务的通知默认被压后最多 10 秒**（N4f-2 定位；N4c-3 已经量到过这 10 秒，只是当时当成了「要等过这段」的环境事实）：真正的修法是一句 `setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)`。**下载是这条策略的反例**——人离开屏幕的那一刻正是他要看见「还在下」的时刻，而一条看不见的下载会被当成死掉的下载。**一个「环境如此」的观测，值得回头问一次它是不是可配置的。**
- 🔴 **后台 JS 定时器第四次咬人：停服务是整条下载生命周期里唯一由定时器驱动的一步**（N4f-2，用户报的）：队列清空的回调**跑了**（那是原生传输回调进 JS），它安排的「2 秒宽限后停」没跑，于是通知永远停在「正在下载 1 首」、dataSync 配额也一直占着。修法是问一句「这个宽限期到底在防什么」：**防的是用户连点两次导致服务起停抖动，而后台没有点击**——不在前台就当场停，前台才留宽限。**不是所有定时器都要搬去原生；先看它在那个场景里还有没有意义。**（残留：应用在前台但熄屏时 `AppState` 仍是 `active`，定时器照冻，通知要等解锁——锁屏背后没人看，不修。）
- **蓝牙歌词把歌名挤进了一个没人显示的字段**（N4f-2，用户报的）：开着的时候标题放歌词、歌名塞 `albumTitle`（AVRCP 的 ALBUM）——**手机自己的状态栏组件根本不显示 album**，于是「这首是什么」直接消失了。改成歌手栏 = `歌手 - 歌名` 且**整首不变**（间奏回落时也不变，否则两行字来回跳）。**一个字段在协议里存在，不等于接收端会把它画出来；能不能看见只有真设备说了算。**
- 🔴 **一个必须存在于契约里的东西，会在每一个屏幕上被忘记一次**（N4h，用户发现）：`listPlaylists()` 按服务契约把虚拟 `all` 排在第一位（这样「按名字引用」在有没有 daemon 时解析成同一个东西，M6 的案子）。歌单 tab 显式滤掉了它，**添加页的「存到」没有** ⇒ 那张表里「仅曲库」旁边多一项叫 `all`，选中之后单曲下载变软失败（歌进库、行上留 `failed_playlist_ids`），多行批量在准入阶段被 `#assertPlaylistExists` 拒掉整把。修法是**在 view 层滤一次**而不是在第二个屏幕补第二次筛选——它已经被漏过一次，第三个屏幕（N4i 的「加入歌单」）本来会漏第三次。**「每个消费者自己排除」是一条一定会漏的规则。**
- 🔴 **判据验过 ≠ 用户点得到**（N4h 顺带查出）：`reidentifySource` 在手机上实现完整、判据 29 五条真机全绿，**而生产 UI 没有任何入口**——那五条跑在验收构建里，验收构建有它自己的按钮。桌面上这条能力挂在「编辑链接…」对话框里，移动端从没接。**一个只在验收里被触达的能力，验收会一直是绿的**；判据应当说明它验的是哪个构建的哪条路径。
- **一个输入框有两个读者时，分界必须显式且单一**（N4h）：粘贴多行与单行走的是两套判定，规则定成「≥2 个非空行 = 粘贴」。反过来把整块文本交给 `parseSongInput`，它读作自由文本 → `findSource` 挑出**第一个**链接、其余静默丢弃——症状是「粘了 12 行只下了 1 首」，而每一层单独看都没错。
- 🔴 **一个信号只有一个听众，而注释说它有两个**（N4g，`library-signal.ts`）：`libraryChanged()` 至今只有播放器在听，而 `LibraryProvider.changed()` 自己换 `view` ⇒ **只有手指按在按钮上的写入会刷新列表**。`engine.ts` 那句「the song list rebuilds」因此是假的，且**看起来是真的**——切一次 tab 会重挂屏幕、列表就新了。N4g 有两条没有手指的写入（ensure 完成、清理删掉文件），它们把这件事顶到台面上。修法是 provider 订阅同一个信号、`changed()` 退化成只发信号。**一句「XX 会自动更新」的注释，要能指出谁在听；指不出来就是没人在听。**
- 🔴 **一台设备上没有的那条路由，把它的副作用一起带走了**（N4g 决策 g）：`songs.last_accessed_at` 在桌面由 `/audio` 路由写（`media.ts` 的 `touch(id)`），而手机上 ExoPlayer 直接读文件、根本没有那条路由 ⇒ **谁也没写过它**，LRU 于是实际按 `created_at`。「按最近最少使用清理」在手机上是句假话，**而且没有任何测试会因此红**——清理照常工作，只是清错了顺序。**移植一个模型的时候，要把「它的输入是谁写的」一起移植。**
- 🔴 **`claim()` 放在串行 lane 的里面还是外面，决定了「加载中按暂停」是暂停还是重放**（N4g-3 决策 j）：`play` 在 lane **外**领代际，这样最后一次点击总能作废正在飞的加载。`toggle`/`pause` 照抄就错了——它作废掉那次加载之后，自己的 lane 任务发现 `driver === null`，于是走「重新加载」分支**把歌又播了一遍**。放 lane **里**则由串行性保证此刻没有加载在飞。**同一个动作放在串行边界的两侧，语义相反；N3a 那条「a tap during a load is queued, not dropped」的老用例是唯一会红的东西。**
- **`expo install` 建议加的 plugin，未必是你要的那件事**（N4g-2）：`expo-sharing` 提示「Add expo-sharing to plugins」，而那个 config plugin 管的是 **iOS share extension 与「分享进来」的 intent filter**（两侧都默认 `enabled: false`）；「分享出去」只需要模块本身 autolink，`SharingFileProvider` 与它的 `sharing_provider_paths.xml`（覆盖 cache/files/external）在模块自己的 manifest 里，合并即生效。**加一个 plugin 就是改原生工程；先读它做了什么再决定。**
- 🔴 **跨包做变异测试，必须先重建被改的那个包**（N4i-1）：把 `packages/core` 的一行策略删掉再跑 daemon 的 characterization 套件——**33 条全绿**，看起来「这条断言根本没在守什么」。真相是 daemon 的测试解析 `@lark/core` 到 **`dist/`**，改的是 `src/`。重建之后同一条立刻红。**一个反测没红的时候，先怀疑它有没有真的跑到你改的那份代码**（N0a-2 的「破法选错会得到一个安静的绿」的第二种形态）。
- **「先跳浏览器再跳 app」不是应用的 bug，是 Android 12 起的 App Links 策略**（N4i-3，用户报的）：`Linking.openURL('https://…bilibili.com/video/…')` 落到浏览器，网站再把人送回 app。问系统就有答案且不必启动任何东西——`adb shell cmd package resolve-activity --brief -a android.intent.action.VIEW -d <url>` 给的是 `ResolverActivity` 且 `isDefault=false`（**没有应用通过了这个域名的验证**）。换私有 scheme（`bilibili://`）**实测同样落到选择器**，省不了一步还钉死一个没有文档的约定。**在猜「要不要绕过系统」之前，先问系统它会怎么做。**
- **一条分隔线画在可点区上，就会在文字结束的地方断掉**（N4i-3，用户报的）：歌单详情的行是「可点区 + ⋮」，而 `borderBottom` 在可点区上、可点区又少了 `flex: 1` ⇒ ⋮ 不贴右，线也不到头。**行的边框属于行，不属于行里那个会伸缩的部分。**
- **`maxHeight` 的列表会在键盘开着的时候把卡片从拇指底下抽走**（N4i-3，用户报的）：搜索结果变少 → 列表收缩 → 整张 sheet 变矮 → 你要点的那一行往上跳。**能被输入改变行数的列表用固定高度**；两条结果下面的留白比一次误触便宜。

- 🔴 **一个模块的默认依赖决定了它能不能被测试——同一课在 N5 上了两次**：`sync/triggers.ts` 若自己 import `AppState`、`ports/events.ts` 若自己持有真实 sink（sink 里有播放器 → expo-audio），两者都会被 `apps/mobile/vitest.config.ts` 的显式白名单挡在门外，而它们各自装的正是**在屏幕上零可观测差异**的东西：一个前后台状态机，一个十二臂的事件分发 switch。修法两次相同——**wiring 交给装配根，判定留在能被加载的文件里**；`AppState` 变成必传参数，`EventSinks` 从「有默认值」变成「必须传」。**「加一个方便的默认值」和「让这段逻辑永远没有测试」经常是同一个动作。**
- 🔴 **一个宿主有两个同名的运行时，计划表会挑错那一个**（N5c）：`boot.fileOps` 与 `downloadRuntimeOnce(boot).fileOps` 都是 `FileEffectRuntime`，而**只有后者带 claim registry**。子计划 §2.2 把协调器的 `fileOps` 写成「`boot.fileOps` ✅ 现成」——真按它接，远端删除的 drain 会和正在写同一首歌的下载**各自对着一个没人共用的登记表仲裁**。`App.tsx:68` 早就为 `LibraryService` 做过同一个选择并写了注释，而 `BootResult.fileOps` 上那段注释在 N4 之后就不成立了、没人改。**「现成的」是最危险的一格：它让人跳过「这两个同名的东西差在哪」。**
- 🔴 **服务器 SSE 不重放，而客户端不会自己发现这件事**（N5d-2，照 owl 的 `sse-bridge.ts`）：订阅之前发生的事件永远不会补，所以一次断流之后的空档没有任何东西会告诉你——只能等下一次时钟触发（lark 桌面 5 分钟、手机 15 分钟）。`onOpen` 补一轮就是全部修法，**而 lark 两端都没接 `onOpen`**，尽管 SDK 一直有这个回调。**协议里"不会发生的事"要主动补，它不会以错误的形式出现。**
- 🔴 **半开的流一个回调都不触发**（同上）：socket 活着、没有 FIN/RST/读错误、服务器悄悄不推了 ⇒ `onError` 永远不响，客户端坐在僵尸「已连接」里。要靠 `onFrame` + 空闲看门狗。**但上看门狗之前必须先核实心跳真的存在**——我先去 `skybridge/packages/server/src/routes/events.ts` 确认了开流写 `:ok`、之后每 `PING_INTERVAL_MS = 25_000` 一次 ping，且这段属于最初那版 SSE（`806a935`）⇒ 线上 0.1.4 一定在发。**没有心跳的话，60 秒看门狗会每分钟杀掉一条健康的流，症状比它要修的病更难查。**
- **「有凭证」不等于「能跑」**（owl 的教训，lark 没犯，记着别被「优化」坏）：owl 的后台触发器曾经 gate 在「配置里有凭证」上，401 之后 session 掉了而凭证还在 ⇒ 一份日志里 **163 条连续的 `scheduler tick rejected`**。lark 的 `SyncRoundQueue.ready()` 问的是 `ctx.sync.session !== null`，问对了。**两个长得很像的问题：「现在能不能成功」与「我们有没有本钱恢复」，只有前者可以拦触发器。**
- **`useMemo` 键在一个 bump 计数上，就是「带失效令牌的缓存」**（N5e，biome 顶回来的）：想在数据库改动后重读一张表，用 `useEffect` + `setState` 会先渲染一次旧值，用 `useMemo([.., version])` 则被 lint 判定「依赖里有 body 没用到的东西」——两条都不对。**同步、单位数的查询，渲染期直接读最诚实**；它本来就是派生状态，不是需要同步的外部系统。
- **`am start -n <pkg>/.MainActivity` 起不来，`monkey -c android.intent.category.LAUNCHER` 能**（N5f）：N4d 的分享 intent 插件把 MainActivity 改成 `singleTask` 并加了 intent filter 之后，不带 category 的显式启动会静默失败（进程起来、Activity 不到前台，logcat 里没有崩溃）。**判断「装完能不能用」要用 launcher 那条路，和用户点图标是同一条。**
- 🔴 **一个新字段铺进共享类型和测试夹具，不等于有人把它印出来**（N7g-1）：N7 给登录加了 `restart_required` / `local_workspace_id` / `local_workspace_created`，三个字段进了 `SyncLoginResultData`、进了 daemon 的响应、**连 CLI 自己的测试夹具都补上了**——GUI 读了并弹「重启后打开这个账号的曲库」，**CLI 一行都没渲染**。症状是最贵的那种：`lark sync login` 退出 0，下一条 `lark sync status` 说「还没有登录」，`lark sync run` 让你去跑「`lark sync login`」。**类型检查、lint、单测全绿**——夹具里有那个字段，没有任何一条断言要求谁读它。只有 `accept-sync` 那种「装一遍、用一遍」的真实验收看得见。**改了一个多宿主共用的响应，就要逐个宿主问「谁渲染它」，而不是「谁的类型编译过了」。**
- **协议版本号会在验收脚本里滞后，而且不止一次**（N7g-1，M7 已记过一次）：`LOCAL_API_VERSION` 6 → 7（N7 的两条 `/workspaces` 路由），`accept-pack` 里两处硬写着 `6` 于是红两条。**修法不是改成读源码常量**——§9 的全部意义就是拿源码常量和一个字面量比，两边都读源码只证明文件等于自己。改成一个具名的字面量 `EXPECTED_API_VERSION`，两处共用，**「抬它」仍然是一个人的刻意动作**。
- **`lark daemon` 起的是脱管子进程，验收脚本的 `finally` 管不到**（N7g-1）：`stopChild(daemonA)` 只能停脚本自己 spawn 的那个。一次崩在中途的 accept-sync 留下了一个 daemon 占着 47100，而下一轮的 `backupNest` 会因为「有 daemon 在答话」拒绝复制——**报错点（复制阶段）离真正的原因（上一轮崩了）十万八千里**。凡是用 `lark daemon` 起的，`finally` 里要按名字 `lark stop-daemon` 收一次。
- 🔴 **一个字段写好了 setter 却零调用点，而 setter 的存在本身让人以为有人在调**（N7g-2）：工作区索引的 `label` / `server_url` 自 N7c 就在，`nameWorkspace` 也在，**全仓没有一处调用**——唯一的写入者是一次性迁移，而它连 `label` 都留空。症状是列表永远显示「账号曲库 085de2c3」。**跟 N7g-1 的 CLI 那条是同一个形状的两面**：那次是「字段有人写、没人读」，这次是「字段有人读、没人写」。**两次都是类型全通、lint 全通、单测全绿**，因为两端都只测了自己那一半。凡是加一个跨模块的字段，要分别问「谁写它」和「谁读它」，并且各要有一条断言。
- **进程级退出在 RN 上必须走原生**（N7g-2）：`BackHandler.exitApp()` 只 finish Activity，而 JS 运行时挂在 Application 上——模块级的 memo（`bootOnce` 的 `booted`、`ports/paths.ts` 的工作区缓存）以及 expo-sqlite 的缓存句柄**全都活过 Activity**。所以「重启才生效」的功能如果自己去关 app，关不干净就等于没关：重开会拿回刚被换掉的那个状态，**看起来是功能悄悄失效**。要 `finishAndRemoveTask()` + `exitProcess(0)`。
- **「已经成功了」之后的收尾动作要有自己的 catch**（N7g-2）：切换和登录写完索引就已经成功，退出 app 只是收尾。把 `quitApp()` 留在同一个 try 里，一次退出失败会走进登录的错误分支，**把成功报成失败**，还会把人引去撤销一个其实生效了的操作。
- 🔴 **「缺失不是错误」是离线的门永远照不到的一类**（0.1.0 发版当天）：`app.config.ts` 里没有 `icon`，于是 Expo 模板自带的占位图上了首发的 APK。tsc、biome、bundle smoke、原生模块守卫**一条都不会红**——它们全是关于代码的，而这是一个**从来没被命名过的资产**。同一天还有两个同形的（登录字段有人写没人读、工作区 `label` 有人读没人写），三次都是全绿。**凡是「配了才有、不配就有个默认」的东西，都要有一条断言说它被配了**；`check-mobile-icon.sh` 就只做这件事。
- **产物里编译进去的常量，改源码不算改**（0.4.0 发版当天）：`DAEMON_VERSION` 从 0.3.0 抬到 0.4.0 之后，dmg 里那份仍是旧值，必须重打包。`accept-pack` §9 读**源码**比字面量、§4a 问**运行中的 daemon**要版本——两条判据分别守着「有没有改」和「产物有没有跟上」，缺任一条都会放过它。
- **`expo run:android` 没有设备就拒绝构建**：它是 run 命令，只是顺带构建。发版要的是产物不是安装，所以有了 `just mobile-android-apk`（`rm` 掉 bundle → `gradlew assembleRelease` → 验签名）。**发版链路上任何一步都不该取决于手机插没插在这台电脑上。**

## Android 0.1.1 实测锁定（随批次追加）

- 🔴 **一条自动链路上，只要有一个 JS 定时器，整条链路就按那个定时器的时钟走**（⑪，2026-08-26 真机取证，冻结设备）：熄屏播完一首之后不续播。链路上四步里三步都是原生的、全部准时——`didJustFinish` 到达 JS（+0ms）、`decideNext` 判定正确（+55ms）、`driver.pause()` 执行（+56ms，**这就是用户看到的「自动暂停」**）——第四步 `await sleep(300)` 走了 **63 537ms**，解冻后 82ms 内全部走完（**这就是「解锁之后就会自动播」**）。**症状离原因很远**：看起来像队列判断错了或者播放器坏了，实际上判断和播放都对，只是中间那 300 毫秒被冻住了。
- 🔴 **放开冻结的是「Activity 回到前台」，不是「屏幕亮」**（同上）：`keyevent 224` 唤醒屏幕后，`dumpsys media_session` 连采 24 次（1.7 秒）仍是 `STOPPED(1) position=328031`，直到用户解锁才走完。所以「熄屏后某某没发生」这类判据，**唤醒屏幕不算恢复条件**。
- **「听状态流等暂停生效」这条路在播完这个场景上走不通**（同上，一个被排除的修法）：`BaseAudioPlayer.kt:84` 把 `!isPlaying && playbackState == STATE_ENDED` 判为 transient 并 `return`，**不发状态更新**——而播完正是这个状态。用事件代替定时器之前要先去看那个事件在目标场景下发不发。
- 🔴 **一条判据在等「恢复」，而它分不清「恢复了」和「卡在原地」**（0.4.1 发版门禁，accept-gui 判据 6）：daemon 重启后先等播放位置回到重启前，再发一次 seek 断言它走在新代际上。等待循环的条件是 `time >= before - 5`——**位置根本没掉下去的时候它当场就退出**（音频元素没丢流，位置冻在 1127.0），于是 seek 打进 GUI 还没重连回来的窗口，答 `409 GUI_OFFLINE`。三次复现，不是 flake。**它测的其实是「重连比恢复快吗」**，而重连是 `subscribeSse` 从 1 秒起的退避——环境，不是契约。改成有界重试（409 就再来一次，20 秒内必须成）后 15/15，且 seek 真的被执行了（200，位置 901.7）。**「判据别把环境当契约」的又一例，而这次的伪装是一个看起来很负责的等待循环。**
- 🔴 **Media3 的可用命令是两处的交集，而 `ForwardingPlayer.isCommandAvailable` 不问你覆写的那一处**（⑬，0.1.1）：expo-audio 在 `AudioMediaSessionCallback` 里用四行 `.remove(...)` 摘掉曲目导航，看起来把那四行删掉就完了——**不会有任何变化**。controller 拿到的是「session 声明 ∩ **player 报告**」，而 expo-audio 的会话 player 只有一个 media item，ExoPlayer 本来就不报 `SEEK_TO_NEXT_MEDIA_ITEM`。补一个 `ForwardingPlayer` 时还有第二个坑：`getAvailableCommands()` 覆写了不够，`isCommandAvailable(int)` 在 `ForwardingPlayer` 里是**直接问被包的 player**，不走你的命令集——只改一个的症状是「dumpsys 里哪里都对，按钮就是死的」。另外 `hasNextMediaItem()` 是第三处：legacy `PlaybackState`（AVRCP 真正看的那份）拿它决定 SKIP_TO_NEXT 灰不灰。**一个「能力开关」在一个框架里可能有三个地方在答，全找到之前不要下结论。**
- **`buildFromSource` 那条老坑，这次是拿 dex 验的**（⑬）：改完 expo-audio 的 Kotlin，`BUILD SUCCESSFUL` 依旧证明不了产物里是新代码。`unzip -p app-release.apk classes*.dex | strings | grep <新类名>` 一条命令就能答——`TrackNavigationPlayer` 与 `remoteCommand` 都在 `classes3.dex` 里。**凡是改了被预编译过的依赖，验的对象是 apk，不是日志。**
- 🔴 **`apps/mobile/android/` 是 prebuild 的输出，抬了版本号不 prebuild，装上去的还是上一版**（0.1.1 发版当天）：`app.config.ts` 改成 `0.1.1` / `versionCode 2` 之后 `just mobile-android-release` 从头绿到尾——BUILD SUCCESSFUL、装机成功、`✓ signed with lark's release key`——而 `dumpsys package` 读回来是 **`versionName=0.1.0 versionCode=1`**。那个目录被 `.gitignore` 排除、只由 `expo prebuild` 生成，而 release 配方不跑它 ⇒ Gradle 读的是上一轮那份 `build.gradle`。**唯一读产物的那道门当时只读证书**。修法两件：补跑 `just mobile-prebuild` 再重建；给 `mobile-verify-apk` 加上版本比对（`aapt2 dump badging` 对 `app.config.ts`，三种破法——只改 version、只改 versionCode、config 读不出来——都验过红）。**「源码改了」和「产物跟上了」是两件事**，0.4.0 的 `DAEMON_VERSION` 是同一课的桌面版。
- **取证不能装 debug 构建**（同上）：debug 用 Android 调试签名，和手机上的 release 签名不一致 ⇒ `install -r` 直接拒；先卸载会把曲库一起带走（app-private + `allowBackup: false`）。release 又到不了 logcat，所以探针只能写进应用内那圈日志（`downloads/log.ts`）再从设置页读。**`Date.now()` 可用**，`performance.now()` 不可用（深睡不走）。


## 0.5.0 / Android 0.2.0 上手验收锁定（随批次追加）

- 🔴 **`-webkit-app-region: drag` 吞掉的，正是它自己那条控制条赖以出现的 hover**（§2.5 判据 19，用户上手第一分钟撞上）：桌面歌词窗**整窗**是拖拽区，而控制条只在 `onMouseEnter` 之后才渲染——拖拽区吃掉区域内的全部鼠标事件（Electron 文档明写），于是 `hovering` 永远是 `false`，五颗按钮和把手一次都没出现过。`no-drag` 救不了：它只能在**已经画出来**的子元素上打洞，而那条控制条正是因为 hover 没发生才没画出来。**鸡生蛋的形状在代码里看不出来**——两段各自都对，不成立的是它们的先后。附带症状一个：macOS 把拖拽区当标题栏，所以在歌词上右键会弹出一个窗口菜单。修法是不要拖拽区，pointer 手动拖（main 读 `screen.getCursorScreenPoint()`，按按下那一刻的锚点 `setBounds`）。
- 🔴 **jsdom 会对着一个真实浏览器永远碰不到的元素 fire hover**（同上）：`DesktopLyrics.test.tsx` 九条判据全程绿着，其中一条的名字就叫「offers its controls on hover」。**jsdom 不认识 `-webkit-app-region`**，那一整条 CSS 在它眼里不存在。想补一条读样式表的判据也不行——**vitest 默认把 CSS import 桩成空串**（`test.css` 默认 `false`），`import css from './lyrics.css?raw'` 拿到的是 `''`，`expect(css).not.toMatch(...)` 永远通过。**那是一条最标准的空判据，而且是在验破法的时候才露馅的**：把 drag 区放回去，它照样绿。最后落成 `just check` 的第十四条守卫（源码是唯一看得见这件事的地方）。
- **透明窗口不可 resize，Electron 文档里写着**（同批）：右下角那个把手原本只是「提示」，真正的 resize 指望窗口边缘——而 `transparent: true` 的窗口在 macOS 上边缘拉不动，把手于是是一句空承诺。改成和拖动同一套 pointer 手势，自己改宽高，并把下限（200×40）挪到人真的够得到的地方。**「平台会办」这类假设，在透明/无边框窗口上要先去文档确认。**
- **jsdom 也没有 `PointerEvent`**（同批）：`fireEvent.pointerDown(el, { button: 0 })` 会退化成一个裸 `Event`，`button` 到达处理器时是 `undefined`，于是「左键才拖」的判断把测试自己挡在门外。test-setup 里补一个 `extends MouseEvent` 的最小实现即可——**不要为了让测试过，去松动生产代码里那条 `button !== 0`**。
- 🔴 **「和当下的配置比」是一个会动的基准**（0.5.0 上手验收顺带翻出来的真 bug）：设置页的草稿在打开那一刻建一次，`buildPatch` 却拿它和**当下**的配置逐字段 diff。而这一版的歌词窗被拖动时会自己写几何、它的控制条会自己写字号和配色——于是「设置页开着的时候拖一下窗口，回去点保存」会把窗口弹回打开设置页那一刻的位置。**没人碰过那些字段，它们却被送了出去**。修法是记「碰过没有」而不是比差异；同一个集合顺带定义了预览该显示什么。
- 🔴 **判据没走到会出问题的那条路，就等于没写**（同批）：给歌词窗加实时预览时，合并函数在「没有预览」时**直接返回存好的那个对象**，身份天然稳定。于是「每句一条消息、不是每 tick 一条」的新判据在**去掉 `useMemo` 之后照样绿**——它全程跑在 `preview === null` 上，而只有合并真的构造对象时才会出问题。**破法验红是唯一发现这件事的方式**；判据改成「预览开着的时候把时间往前拨」才真的守得住。
- 🔴 **两个「永不抛」之间，没有人听得见取消**（0.2.0 真机会话，用户报的）：取消一个正在搜歌词的任务，最后是 `failed / NOT_FOUND`「三个歌词源都没有可用结果」。信号是通的、`cancel()` 也确实 abort 了——问题在它一路上撞见的两个设计决定：`collectLyricsCandidates` 是 `Promise.allSettled`（**被 abort 的平台和宕机的平台落进同一个 `failures`**），`selectLyricsCandidate` 文档写着 never throws（**被 abort 的模型退回启发式**）。两条各自都对，合起来把 abort 吃干净，于是引擎那句 `catch { if (cancelRequested) finish('cancelled') }` 永远没机会跑。**按了取消的人被告知网络断了**；平台若已经答完则更糟——歌词照写、任务成功。**凡是「这一段永不抛」的路径，取消都要被显式地问一次**（`throwIfAborted`），因为容错和取消都走 catch，而容错会先把它吃掉。
- **一个界面画了两份行，它们一定会走散**（同批）：歌单详情自己写了一份 row markup，曲库 tab 用 `SongRow`；后者有 `· 需要下载`，前者没有。同步来的歌有元数据没有音频，在歌单里于是和一首能直接播的歌长得一模一样。**重复不是在写的时候出错的，是在只改一边的时候出错的**——这份重复 backlog C12 已经记了，代价先以「少一个状态」的形式付了出来。

## 0.5.1 实测锁定（0.5.0 发出去之后，用户第一天就撞上）

- 🔴 **一个窗口的选项，动的是整个进程**（0.5.1 §1，用户报的：「开启歌词之后程序坞里 lark 没了，但是没退出」）：`setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` 是 Electron 文档里让窗口盖住全屏应用的正路，它**顺手**对进程执行 `TransformProcessType(kProcessTransformToUIElementApplication)`。UIElement 应用没有 Dock 图标、没有菜单栏，于是 **Cmd+Q 也没了**；而主窗口是「红叉 = 隐藏」，一旦隐藏就再没有任何 UI 入口能把它叫回来——进程还在放歌，人却摸不到它。**关掉桌面歌词不还回来**：transform 从来不属于那个窗口，销毁它、再 `show()` 主窗口，实测都是 `dock.isVisible=false`，只有重启进程才行。修法是 Electron 43 的 `skipTransformProcessType: true`（实测 dock 保持 `true`，两个 collection behavior 照设）。**读一个 API 的时候，要问的不只是「它对这个窗口做什么」，还有「它对进程做什么」。**
- **这件事在电脑上唯一能被看见的地方是源码**（同上）：坏掉的是 macOS 上一个真 Electron 的进程属性，vitest 两样都没有；而这个窗口是由 `createDesktopLyricsWindow` 建的——`desktop-lyrics-window.ts` 那个可注入 factory 唯一没有罩住的那一半（控制器的生命周期全是单测，窗口的**构造**不是）。于是落成第十五条守卫 `check-lyrics-dock-icon.sh`，**验破法用的是 0.5.0 发出去的那一行原样**，红。
- 🔴 **可注入的边界画到哪，测试就只看得见到哪**（同上，第二遍学同一件事）：0.5.0 的判据 19（拖拽区）和这次的 dock，两条都落在同一条缝里——业务判定被抽干净、单测很漂亮，而**真正碰平台的那几行没有任何判据**。这类文件的规矩因此是：**每加一个碰平台的调用，要么它进 factory，要么当场落一条守卫**，不要指望回头补。
- 🔴 **「第一个非 409 的回答」不等于「这件事发生了」**（0.5.1 门禁，accept-gui 判据 6 第二次生病）：0.4.1 给它加了「409 就重试」，这一版它以 `200 t=1129.9` 红——seek 被接受、被应用，然后被恢复盖掉。GUI 的命令通道**重连得比 `loadedmetadata` 早**，而 `player/recovery.ts:70` 在拿到元数据之后**无条件**写回重启前的位置（1127.0 + 等待 ≈ 1129.9，这个数在两轮里逐位相同，一眼看去像确定性，其实是同一条时间线上的同一个竞态）。**判据该断言的是它自己那句话——「让一个 GUI 动起来」——所以重试到位置真的动了为止。** 顺带落出一条真产品洞（backlog C13）：daemon 对一个静默没发生的命令答了 200。
- 🔴 **这套件复制的是用户当下的曲库，所以用户的设置会改判据的时序**（同上）：判据 6 在**开着桌面歌词**的库上三轮里红了两轮，把 `desktop_lyrics.enabled` 改成 `false` 的同一份库上一轮就绿（`18/18`）。0.5.0 发版那天它绿，是因为那个开关当时还没被打开过——**一个新功能可以在不碰任何判据的情况下，把另一条判据推过临界点**。证据只有 3:1，不足以叫因果；但足以说明**「判据别把环境当契约」里的「环境」包括用户自己的配置**，而这套件按设计就是要跑在那份配置上。
