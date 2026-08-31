# 仍然生效的约束

> **改对应模块前读这里。** 这些不是历史，是**现在就约束新代码**的规则——每一条都被某一批用判据钉过，改掉它需要一次明确的决定，不是顺手。
>
> 配套：实测踩过的坑在 `LESSONS.md`（「为什么会踩」），逐批经过在 `archive/`（「当时怎么定的」），
> 已经决定不做的事在 `plans/2026-08-26-backlog-before-android-v1.md` 的 E 节（**别再当待办捡起来**）。

## 1 · 曲库安全（每次动库前读）

- 🚨 **开发版碰到旧库就会单向升级**（v2 → v3 时还会当场把 mp3 转成 m4a）。任何 `createDatabase`——dev daemon、`--direct` 写、跑测试时指错 `LARK_NEST_DIR`——碰到旧库都会当场升级并置 `audio_migration_pending`。**旧版本从此拒绝打开它**（`user_version > LATEST`），音频也回不去。
- **开发期一律用副本**：`just backup-nest <目录>` + `LARK_NEST_DIR` 指向它。
- **验副本的可靠做法**：先自己带 `LARK_NEST_DIR` 起 daemon、用 `/api/instance` 核对 `nest_dir`，**再**开 GUI——GUI 认领时会比对 nest，环境变量没生效会弹框中止（不 spawn、不碰真库），这比「开了之后再看」早一步。
- **验收夹具一律自造，不借用户的库**：`accept-m5` 与 `accept-sync` 都因为借库而红过。本机真实曲库现为 **7 首全 `downloaded` / 1 个歌单 / 0 首 imported**，且**至今未绑定任何账号**。
- **缓存清理不变量（R1/R26）**：只清理 `file_origin='downloaded'` 且清理前**探活确认可重下**的文件；imported（含 Go 迁移曲库）是用户资产，**永不自动清理**；歌词文件永不参与清理；探不通就留着（fail-closed）。

## 2 · 依赖方向与守卫

```
shared ← core ← daemon ← gui
cli → shared + core（静态只碰零原生子路径；barrel 只在 --direct 分支 dynamic import）
mobile → @lark/core/portable + @lark/shared + skybridge SDK，仅此三者
```

**`core/portable` 是 core 内部的一层**：一台手机能解析的整个业务图。桌面专有的那半（`db/` · `download/{audio-landing,ffmpeg,resolve,import}` · `sync/file-ops-runtime` · `config/` · `logger/` · `paths.ts` · `media-tools/` · `migration/`）**反向 import 它**，它**不许 import 任何 core**。

**十五条守卫进 `just check`**，破了会红：

| 守卫 | 管什么 |
|---|---|
| core 禁 daemon/gui/electron | 分层 |
| **core/portable 禁一切宿主** | Node builtin（裸名与 `node:` 前缀）· better-sqlite3（含 type import）· `drizzle-orm/better-sqlite3`（`sqlite-core` 放行）· pino/smol-toml/electron · `@lark/core` 自引 · **按深度计数的 `../` 越界** |
| daemon 禁 gui/electron | 分层 |
| shared 禁一切 Node builtin | 它是线协议包 |
| cli 禁 daemon/gui/electron + 禁静态 import core barrel | 启动开销与 ABI |
| **mobile/spike 只许 import portable/shared/skybridge SDK** | `check-mobile-imports.sh`，管 `apps/mobile` 与 `spikes/mobile-foundation` 两处 |
| **Metro bundle smoke** | 读 Metro 真建出来的模块图，答 rg 答不了的三件事。**建两个 bundle**（`disableHierarchicalLookup` 下一边绿证明不了另一边）。🔴 **探针必须放在 barrel 够得到的文件里**——孤立文件不在图里，塞什么都是绿的 |
| **自建原生模块的接线** | `check-mobile-native-modules.sh`：config 声明的类要有 `.kt` · **要有 `android/build.gradle`** · 要有 `index.ts` |
| **播放链路禁 JS 定时器** | `check-mobile-no-js-timers.sh`：`apps/mobile/src/player/` 里禁 `setTimeout`/`setInterval`。熄屏时 JS 定时器会冻（§6），而播放链路上任何一步靠它都等于「等你下次看手机」。`driver.ts` 自己 import expo-audio，进不了 vitest 白名单——**电脑上只有这条守卫会红** |
| **图标资产** | `check-mobile-icon.sh`：`app.config.ts` 要声明 `icon` 与 `adaptiveIcon` 且文件在。**缺失不是错误**——没有它 prebuild 会一声不吭用模板占位图，0.1.0 就是这么发出去的 |
| **工作区收口** | `check-workspace-chokepoint.sh`：只有 `paths.ts` 能拼 `'songs.db'` · 手机上只有 `ports/paths.ts` 能碰 `nestDirectory()` · 全仓禁「清除应用数据重来」这类现在为假的措辞 |
| **渲染进程的 Enter 先问输入法** | `check-gui-ime-guard.sh`：出现 `key === 'Enter'` 的文件都要提到 `isComposingKey`。Chromium 对 IME 选词的那一次回车也报 `Enter`，0.5.0 之前**五个处理器全是这么错的**——文件级判定，粗，但两个方向都没有要紧的假阳/假阴 |
| **桌面歌词窗禁拖拽区** | `check-lyrics-no-drag-region.sh`：`desktop-lyrics/` 和 `lyrics.html` 里不许有 `-webkit-app-region` 声明。拖拽区吞掉这个窗口的控制条赖以出现的那次 hover，**而没有任何测试看得见**——jsdom 对着谁都肯 fire hover，vitest 又把 CSS import 桩成空串（0.5.0 判据 19） |
| **桌面歌词窗不许降级整个进程** | `check-lyrics-dock-icon.sh`：`packages/gui/src/main` 里每一处 `setVisibleOnAllWorkspaces` 都要显式写 `skipTransformProcessType: true`。少了它，Electron 会在歌词窗打开的那一刻把**整个进程** `TransformProcessType` 成 UIElement 应用——**Dock 图标、菜单栏、Cmd+Q 一起没**，而进程还在放歌；**关掉歌词也不还回来**（transform 从来不属于那个窗口），只有重启进程才行。0.5.0 就是这么发出去的 |
| **日志卫生** | `check-log-hygiene.sh`：配置与凭证不许原样进日志（log `redactConfig(cfg)`，不是 config 对象）。**有界近似**——变量间接或跨窗口的调用会漏，**红了一定有问题，绿了不代表一定没有**；另两层是 redact 单测与 Public 投影约定 |

另加 `just mobile-typecheck`——`apps/mobile` 不在根 `tsc -b` 里，不单独跑就等于没类型检查。

## 3 · 桌面

- **daemon 是统一入口**（默认 **47100**，端口段 `471xx` 归 lark）。daemon 存活时 CLI **一律禁止 `--direct` 写**（无 `--force`，R31）。
- **跨进程写互斥**：daemon / `--direct` 写 / backup-nest 三方共守 `songs.db.writer.lock`（常驻 SQLite 锁库，`BEGIN EXCLUSIVE`，kill -9 自动释放，**锁文件永不删**）。锁序冻结 **writer → migrate → 真库 EXCLUSIVE**。读路径不取任何锁。
- **token**：daemon 生成并原子发布 0600 文件；GUI 每次重读，**不进 URL / DOM / 日志 / 媒体 src**（R21/R29）。
- **统一响应** `{"success", "data", "message"}`；例外只有 `/audio`（二进制 + Range）、`/lyrics`（text/plain）、`/events`（SSE）。
- **数据目录** `~/orpheus-aviary-nest/lark/`。canonical 音频 = `songs/<id>/song.m4a`，`/audio` 回 `audio/mp4`。**schema v3**，协议 `LOCAL_API_VERSION = 10`（**以 `packages/shared/src/api-paths.ts` 为准**）。
- **设置页只发「人碰过的字段」**（0.5.0）：草稿在打开那一刻建一次，而配置会在它开着的时候被别的东西改——歌词窗被拖动时自己写几何、它的控制条自己写字号与配色。拿草稿和**当下**配置做 diff，等于把打开那一刻的值写回去（真撞到过：拖完窗口按保存，它弹回原位）。
- **桌面歌词的实时预览不写盘**（0.5.0）：预览 = 把草稿 publish 给那个窗口，取消 = 不再 publish，所以「不保存就变回去」没有撤销这一步。**可预览的只有 `enabled` / `lines` / `font_size` / `preset`**（`DesktopLyricsPreview` 白名单）——`locked` 不可预览（锁上之后连唯一的解锁开关都点不到），几何不可预览（那是窗口自己写的，两边会打架）。

- 🔴 **没有人替人选分P**（0.5.1）：多 P 视频没有 `?p=` 时，**任何一端都拒绝**（`MULTI_PART_UNRESOLVED`），配了 LLM 也一样。以前是模型选一个、答不出就落第 1 P——那是**静默下错歌**。三个回答它的方式：链接里的 `?p=`、CLI 的 `--part` / `--all-parts`、界面上的选择。**唯一还让模型选集的是关键词搜索**，那条路上人从没见过视频、也弹不出窗。
- 🔴 **一个分P 叫它自己的名字**（0.5.1）：`original` 和 `clean` 都从 `pages[page-1].part` 取，`clean` 还会**同时**拿到整稿标题（歌名在分P 里、歌手在主标题里）。**只对真正的多 P 视频成立**——单 P 稿件的 `part` 常是「1」或文件名，动它会平白改掉一堆本来就对的名字。**分P 的批量 item 一律 `title: null`**：pipeline 反正要取 page list，两个来源写同一个字符串迟早走散。
- **多 P 视频在界面上就是一个「合集」**（0.5.1，用户定）：桌面和手机都把它渲染成和收藏夹/合集**同一种组**——可改名的标题、每组自己的「原标题」、全选、提交时新建歌单。**唯一的差别是开局勾选**：列表全勾（打开文件夹的人要整个文件夹），分P 零勾（这一屏存在就是为了让人挑）。
  🔴 **它在线上长什么样由 `portable/download/batch-groups.ts` 的 `partsGroupPayload` 一处产出**，两端都调它（2026-08-31）。上面那句话原样写在这里三天，而**代码是两份**：桌面建歌单、手机提交到当时的「存到」。**一句话不会红，一个两个调用方共用的函数会。** 凡是「两端一致」的规则，落点必须是一处代码，不是一条约定。
- 🔴 **下载失败自动重试：判定两端同一份**（2026-08-31）：白名单与次数语义在 `portable/download/retry.ts`（四个可重试的码，十一个明确不重试的码各有各的理由，**`CACHE_LIMIT` 不在里面**——那条记录之所以存在就是因为没地方了）。**次数各存各的**：手机在 device settings，桌面在 `[download] retry_limit`。**不退避**（JS 定时器熄屏冻结，§6；桌面继承同一答案）。**lyrics 永不自动重试**，由 `engine.enqueueRetry` 答 `null` 来执行。
  **重放的是 task 自己的 target，不是记录里的文本**：`DownloadRecord` 刻意不带命名模式，重建请求就得再答一次「哪种命名」，而自动重试没有人可问——手机曾用「此刻的 chip」作答，于是一首 `original` 提交的歌可能以 `clean` 落库。**手动「重下」两端都仍走旧路**（按下按钮的人给的是今天的答案，0.1.1 ⑨）。
  **桌面跑在 daemon 里**（`download-retry.ts`，挂 `onStatus`），不在渲染进程：GUI 大部分时间关着而 daemon 还在下载，只在开窗时才重试等于在这功能唯一存在的场景里缺席。这也是次数必须进配置而不是 localStorage 的原因。

## 4 · 同步（skybridge）

- **实体 `device_id` 只存 skybridge 注册 ID**；本地身份在 `local_metadata.device_uuid`。**两域不混用**（R18）。
- **凭证在独立文件** `~/orpheus-aviary-nest/lark/skybridge.toml`（0600），**不进 `/config` 通道，backup 每一层都排除**。
- **歌曲本体不同步**：各设备凭 `source_key`（bilibili = `bvid:cid`）按需下载。
- 🔴 **协调器的 `fileOps` 必须是 `downloadRuntimeOnce(boot).fileOps`，不是 `boot.fileOps`**——只有前者带 claim registry。拿错则「远端删除的 drain」与「正在写同一首歌的下载」各自对着一个没人共用的登记表仲裁。
- **流控制器 `portable/coordinator/stream.ts` 两端共用**（借 owl 的两条策略）：`onOpen` 补一轮（**服务器不重放订阅之前的事件**）+ `onFrame` 喂 60 秒看门狗（**半开 socket 一个回调都不触发**）。
- **能不能跑，问的是 `ctx.sync.session !== null`**，不是「配置里有没有凭证」——401 之后凭证还在，session 没了。
- **已撤销的设备永远删不掉**：`changes.device_id` 与 `attachments.uploaded_by_device` 是 `ON DELETE RESTRICT`。而且**撤销后再登录会新注册一台**（`resolveDevice` 把「已撤销」当「已消失」，有意如此）⇒ 列表只增。前端**折叠不过滤**。
- **离开一个账号不会删曲库**——被撤销 / logout / `unbind` 三条路都不删歌，`unbind` 丢的是 outbox 和 tombstone（**以「缺席」表达的东西回不来**）。唯一会动音频的是「别的设备删了这首歌」，且只删 `downloaded`。完整一份见 **`leaving-an-account.md`**。

## 5 · 每账号独立工作区（N7）

一台设备可以有多个曲库，各自绑一个账号或谁都不绑，互不可见。`local` 原地不动（零迁移），账号库在 `libraries/<32hex>/`，id = `sha256(server_id + "\n" + user_id)` 前 32 hex（与 owl 逐字节同结果）。

1. **登录的安装必须跑在目标工作区上**——seam 是 core 登录序列里的 `resolveTarget`。顺序：远端登录 → 算 id → 备好工作区 → 在目标上 bind/backfill → 翻 active → 重启。
2. **`switchWorkspace` 只写一行，绝不动 resolver 缓存**（缓存 = 「这个进程打开了哪个库」）⇒ **`serving` ≠ `active`**。
3. **门要求目标库的 `songs.db` 已在盘上** ⇒「先备库再翻 active」是唯一顺序。
4. **手机 `local` 的 SecureStore 键必须不加前缀**——否则升级上来会 converge 掉自己的 outbox。
5. **手机建工作区先认领 D16 身份**（intent → 库 → commit，全在 move 之前）。
6. **跨工作区清理 = 同一个 `runEviction` 指向别人的库**（只 SELECT ⇒ 安全是构造性的），顺序先清其他工作区。
7. **WAL sidecar 不能跟着搬**（迁移用 checkpoint）。
8. **登录时给工作区起名**（`label` = 账号，`server_url`），每次登录都写；不写就只能显示「账号曲库 <8 hex>」。
9. **账号库与 `local` 是两份独立的库**（各有 `songs.db` 和 `songs/`），退出账号不影响 `local`，账号库的音频也不会合并回去。离开账号后各自的下场见 **`leaving-an-account.md`**。

## 6 · 移动端：启动与文件

- **启动序列冻结**（N2 §2.2）：零写预检（含兼容性）→ 写 SecureStore intent → 读写打开 → 收敛 → `ensureDeviceUuid` → 提交 intent → boot drain → 服务。
- 🔴 **每进程只跑一次**（`bootOnce`）——Activity 重建后再开同一个库会崩（expo-sqlite 的 `OnDestroy` 关不掉缓存的库）。
- 🔴 **由此，「重启才生效」的功能自己关 app 时必须结束进程**：`BackHandler.exitApp()` 只 finish Activity，JS 运行时挂在 Application 上，`bootOnce` 与 `ports/paths.ts` 的缓存都会活下来。用 `modules/lark-app` 的 `quit()`（`finishAndRemoveTask()` + `exitProcess(0)`）。
- 🔴 **熄屏时 JS 定时器被冻结，而放开它的是「回到前台」不是「屏幕亮」**（0.1.1 实测：`driver.destroy()` 里的 300ms 走了 **63 537ms**；唤醒屏幕后连采 1.7 秒仍冻着，用户解锁才走完）。**播放链路一律用 `modules/lark-app` 的 `nativeDelay`**，守卫 `check-mobile-no-js-timers.sh` 盯着 `src/player/`。别处是判断题，问法是「这个等待在熄屏时还有意义吗」——N4f-2 的服务停止宽限期因此被**删掉**而不是搬去原生。
- **文件写一律原子替换**——expo-file-system 57 在 Android 上两条路都堵着（`moveSync(overwrite)` 先删目标，`rename` 拒绝已存在），所以有自建的 `modules/lark-fs`。
- **五个自建原生模块**：`lark-fs`（原子替换）· `lark-audio`（becoming-noisy）· `lark-media`（MMR 时长）· `lark-transfer`（dataSync 前台服务）· `lark-app`（结束进程）。**改它们的原生代码，`pnpm patch` 没用**——SDK 57 的模块消费包内预编译 AAR，要在 `apps/mobile/package.json` 加 `expo.autolinking.buildFromSource`。

## 7 · 移动端：产品形状（有意与桌面不同的，如实记着）

- **锁屏/车机有完整的播放/暂停/seek/上一首/下一首**，其中曲目导航是 `patches/expo-audio@57.0.3.patch` 补的（0.1.1 ⑬，expo-audio 自己**显式摘掉**了它）。`remoteCommand` 到 JS → `player/remote.ts` 翻成 `decideNext` 的词汇 → 走**和屏幕按钮同一个 `advance`**：**不许有第二套「下一首」的算法**。怎么验在 §8。
  （**此条 0.5.1 之前是反的**——写着「这个能力不存在，v1 收窄成播放/暂停/seek」，而 0.1.1 已经做出来了，同一份文件的 §8 还写着它的验收方法。文档里一条**过期的约束**比没有更贵：它会劝下一个人别去做已经做好的事。）
- **队列是起播那一刻的快照**（与桌面「队列 = 当前视图」分叉）。
- **点一首没有文件的歌 = 一次播放意图**：拿回来再从头播。「没有文件」不再是墙——`next`/`prev` 会去拿，**自然播完则跳过**（`decideNext` 在 `@lark/shared`，桌面跟着变）。
- **表过态就作废**：起播别的歌 / 主动暂停或继续 / 下一首都会作废等待中的 ensure；**队列自己走到头停下不作废**。`claim()` 必须在 lane **里面**（lane 内外语义相反）。
- **minibar 那一行是播放承诺不是下载指示器**。
- **同步只在前台跑**：进后台停定时器 + 断 SSE，回前台一次 `'resume'` 触发；**suspend 不碰 session 也不 abort 飞行中的轮次**。**手机后台收不到别人的改动**是如实的产品形状。
- **蓝牙歌词只做 Android，桌面整个不做**：复用 AVRCP 的 TITLE 字段，判定在 `@lark/shared/now-playing.ts`，开关在 `local_metadata.now_playing_mode`（缺行或非法值一律读 `'title'`、**读路径不写库**）。歌手栏 = `歌手 - 歌名` 且整首不变。
- 🔒 **移动端的 LLM 配置只有一个来源**：设置页手填、存这台设备。没有 aviary 共享配置回退 · 不从桌面导入 · 不进同步 · 不内置默认端点或 key。
- **明文 HTTP 由设置页一个开关决定**（`local_metadata.sync_allow_insecure`，fail-closed：只有 `'1'` 算数）。理由是产品形状——「只给某个 IP 开洞」与「支持任意自建 server」互斥。
- **`libraryChanged()` 的听众要数得出来**——没有手指的写入刷不出列表。
- **wiring 归装配根，判定留在能加载的文件里**——一旦某个模块持有真实 sink / `AppState`，就被 `apps/mobile/vitest.config.ts` 的白名单挡住，那段逻辑会失去全部测试。

## 8 · 测试与验收

- **默认落单测。** 只有设备才能回答的才上机：原生模块 · Android 策略 · 真网络 · 真机数值。**反测也落单测**。
- **上机由用户操作、集中安排**：一个里程碑最多一次会话，AI 只负责 `just mobile-android-release` 装包 + 讲清楚看什么。AI 自己驱动手机只在两种情况——要抓内容（logcat / dumpsys / 截屏比对），或判据要求一段精确流程。
- **绿不是证据，破了会红才是。** 加一条判据就要能说出它怎么变红；破法选错会得到安静的绿。
- **判据别把环境当契约**，**「快」是可疑信号**除非同时断言干了活，**判据验过 ≠ 用户点得到**（只在验收构建里有入口的能力，验收永远绿）。
- **锁屏/车机的上一首下一首靠 `patches/expo-audio@57.0.3.patch`**（0.1.1 ⑬）：expo-audio 自己没有这个能力。曲目导航以 `remoteCommand` 事件到 JS，`player/remote.ts` 翻译成 `decideNext` 的词汇，最后走**和屏幕按钮同一个 `advance`**——不许有第二套「下一首」的算法。改播放器或升级 expo-audio 之后，验的是 **apk 里有没有那两个符号**（`classes*.dex` 里的 `TrackNavigationPlayer` / `remoteCommand`），不是构建日志。
- **抬了 Android 版本号就必须 `just mobile-prebuild`**：`apps/mobile/android/` 是 prebuild 的输出、不进 git，release 配方不会重跑它。`mobile-verify-apk` 现在同时验**签名**与**版本号**（apk 的 `versionName`/`versionCode` 对 `app.config.ts`），它是发版链路上唯一读产物的门。
- **五套桌面 accept 是发版门禁**：`accept-gui`(15) · `accept-cli`(27) · `accept-m5`(22，真 bilibili) · `accept-sync`(36，真 server + 两台 daemon + 真 GUI) · `accept-pack`(28，对新构建的 dmg/tgz)。**桌面改过就要复跑。**
