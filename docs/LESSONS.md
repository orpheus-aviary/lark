# lark 实测锁定

> 每一条都是**踩出来的**，不是推导出来的。从 `CLAUDE.md` 迁出（2026-08-19）——那份文件是每次会话都加载的常驻规范，历史细节压在里面会把真正常驻的规矩淹掉。**内容逐字节保留、只按时间重排**。
>
> **改动某个模块前先读它对应的那一段**；每段开头的子计划链接是更完整的上下文（判据、决策、逐批记录）。新的实测锁定继续追加到对应段落。

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

## v0.2 T0–T3 实测锁定（详见 `PROCESS.md` v0.2 段与 `docs/plans/2026-08-11-v0.2-skybridge-sync.md`）

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
