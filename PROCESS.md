# lark 开发进度

> **这个文件只写「现在」。** 逐批的历史记录已经归档到 `docs/history/`，索引在下面。
> 对话以本文件为基准；旧的东西查得到就行，不必读进上下文。

## 当前阶段：**Android 0.1.1 + 桌面 0.4.2（均已发布，2026-08-27）**

| | |
|---|---|
| **桌面** | **v0.4.2 已发布**（2026-08-27，tag `v0.4.2`）—— `Lark-0.4.2-arm64.dmg` + [`@orpheus-aviary/lark-cli@0.4.2`](https://www.npmjs.com/package/@orpheus-aviary/lark-cli)。一颗多选「下载」（只补缺的音频），**协议未动**（`LOCAL_API_VERSION` 仍 8），曲库不迁移。上一版 v0.4.1 已发布（2026-08-27，tag `v0.4.1`）—— `Lark-0.4.1-arm64.dmg` + [`@orpheus-aviary/lark-cli@0.4.1`](https://www.npmjs.com/package/@orpheus-aviary/lark-cli)。0.1.1 ⑥ 的桌面另一半（`playback.auto_download_next`）+ `DOWNLOAD_TIMEOUT`；协议 `LOCAL_API_VERSION` 7 → **8**（0.4.0 的 daemon 不认识 `[playback]`），**曲库不迁移**（schema 仍 v3）。 |
| **移动** | **Android 0.1.1 已发布**（2026-08-27，tag `android-v0.1.1`）—— `lark-0.1.1.apk`，versionCode 2，minSdk 26，**覆盖安装 0.1.0、曲库不动**（签名相同）。只在 GitHub Release 发，不进商店，无自动更新。 |
| **测试** | **3415**（`just test`）。`just check` 绿（**守卫十二条**——0.1.1 加了「播放链路禁 JS 定时器」，并补上 `INVARIANTS` §2 一直漏记的图标守卫）。桌面五套 accept **128/128** 已对 0.4.2 那份产物复跑。 |
| **业务代码** | 508 文件 / 50,193 行（`tokei`，口径见 `.tokeignore`）。 |
| **设备** | 冻结设备 vivo V2408A / Android 15。数值判据一律 release 构建。 |

**P1–P8 全部完成，0.1.1 已发布（2026-08-27）。** 真机会话两轮：先是十条一次全过，加了 ⑬ 之后又对**要发出去的那份产物**复验 7（熄屏续播）与新增的 11–13（车机/耳机/通知栏切歌），也全过。清单在子计划 §7.2。
**这一版是 D2「长期使用复盘」的第一份收成**：用户用了一天，列回来十一条，其中**只有一条是 bug**（锁屏播完不续播），其余是产品形状。子计划与分批 → **`docs/plans/2026-08-26-android-0.1.1.md`**；更早的待办与已决定不做的 → `docs/plans/2026-08-26-backlog-before-android-v1.md`。

⚠️ **手机当前状态**：装的就是发出去的那份 0.1.1。仍处于**登出**，且 **LLM API Key 随卸载丢失**——要手动补一次（backlog A5）。

### 本阶段记录

- **桌面 0.4.2 发版（2026-08-27）** —— [Release v0.4.2](https://github.com/orpheus-aviary/lark/releases/tag/v0.4.2)（bundled，`Lark-0.4.2-arm64.dmg`）+ [`@orpheus-aviary/lark-cli@0.4.2`](https://www.npmjs.com/package/@orpheus-aviary/lark-cli)。绑定：tag `v0.4.2` → **`f13d84f`**；dmg sha256 `7b1b9411916b6092…`（148,254,829 字节，**验收前后一致，且从 Release 下载回来复校同哈希**）；tgz sha256 `7694ab4086ef2359…`，**registry 回读的 `dist.shasum` = 本地 `npm pack` 的 `adea39dd…`**。九步照 M7 §3.5 走完。
  多选栏加了一颗「下载」：对选中的歌**只补缺的音频**（`POST /songs/:id/ensure-file`），已经在本机的一首都不请求。右键选中多行同一条；单选一行不给这条——一首歌不存在「一半缺一半不缺」，`重新下载` 就是全部答案。
  **缺的从来不是入口，是语义**：选中之后的批量下载 0.4.0 就有，走的却是 `redownload`（强制重取）——选 200 首会把 180 首好好的文件也重下一遍并原地重写。真实场景（新设备登录账号后补齐曲库，元数据同步了、音频本体从不过同步通道）要的是 ensure-file，而 daemon 那一侧从 M5-8 起就有，只是渲染进程只在播放路径上用过它。
  **跳过的行进 toast 而不是消失**：「已开始下载 12 首；另有 3 首已在本机」。`batchMessage` 因此多一个 `note`，附在三种形状之后（失败那种也附）——「已开始下载 3 首」对着十二行的选择是句真话，但不说另外九行的下场就读起来像 bug。没有来源标识的歌照旧交给 daemon 答 400，客户端不预判（和 `redownload` 同一条规矩）。
  **和手机那颗「全部下载」规则不同，是有意的**：手机撞到缓存上限就停下、把剩下的记成失败行；桌面的规则一直是下新删旧（每次下载完成触发 LRU 清理），且默认上限是「不限」。移动端那套预算要走磁盘、按本机 `file_size / duration` 估每秒字节，桌面没有这套基建，也没有理由为一颗按钮造。
  协议未动（仍是 8），schema 未动（仍是 v3），所以 **0.4.1 的 CLI 和 0.4.2 的 daemon 能互通**。测试 3410 → **3415**（两条判据都验过红：把 `ensureFile` 换成 `redownload`，两个文件当场变红）。五套 accept 对这一份产物 **128/128**——其中 `accept-sync` 跑在一份**登录前形状**的 nest 副本上（本机 `active` 当天已经是账号库 `17436a9a…`，而这套判据默认拿去复制的是未绑定的 `local`：D1 的 `bound === false` 先红，最后 `countSongs` 去开一个没被复制过来的 `lark/songs.db` 崩在 `SQLITE_CANTOPEN`——`backupNest` 只 online-backup 活跃工作区那一份）。

- **桌面 0.4.1 发版（2026-08-27，backlog D1 关闭）** —— [Release v0.4.1](https://github.com/orpheus-aviary/lark/releases/tag/v0.4.1)（bundled，`Lark-0.4.1-arm64.dmg`）+ [`@orpheus-aviary/lark-cli@0.4.1`](https://www.npmjs.com/package/@orpheus-aviary/lark-cli)。绑定：tag `v0.4.1` → **`af37b71`**；dmg sha256 `efe352e3189db9c9…`（148,254,310 字节，**验收前后一致，且从 Release 下载回来复校同哈希**）；tgz sha256 `97e78ee6d732ebc0…`，**registry 回读的 `dist.shasum` = 本地 `npm pack` 的 `466660b8…`**。九步照 M7 §3.5 走完。
  0.1.1 动过桌面（`playback.auto_download_next` 进配置与设置页、`DOWNLOAD_TIMEOUT`、`decideNext` 的 `fetchWhenEnded`），这一版把它发出去。**协议号 7 → 8**：0.4.0 的 daemon 对 `PATCH /config` 里的 `playback` 一节直接答 `INVALID_CONFIG: unknown config section`，而 0.4.1 的设置页要写它——**与当年升到 6 完全同形**（「一个写着新版的客户端没法通过旧 daemon 用自己的功能」），所以按 `api-paths.ts` 那条「Bump on any breaking change」抬号，而不是让 GUI 去兼容一个它一定会遇到的 400。版本号十一处一起动（六个 manifest + 三个常量 + 协议号 + `accept-pack` 的 `EXPECTED_API_VERSION`）。
  🔴 **门禁抓到一条判据自己的病**（不是产品的）：`accept-gui` 判据 6 在 daemon 重启后等播放位置恢复，而**等待条件分不清「恢复了」和「卡在原地」**——音频元素没丢流时位置根本不掉，循环当场退出，随后那次 seek 打进 GUI 还没重连回来的窗口，答 `409 GUI_OFFLINE`。**三次复现**才敢说不是 flake。它实际测的是「重连比恢复快吗」，而重连是 `subscribeSse` 从 1 秒起的退避——环境不是契约。改成有界重试（20 秒内必须成）后 15/15，且 seek 真的执行了（200，位置 901.7）。
  五套 accept 对**这一份代码和产物**复跑 **128/128**；单元测试 3410。

- **P8 蓝牙／车机的上一首下一首（⑬，2026-08-27，用户当天追加）** —— 暂停一直是能用的；缺的只有曲目导航，而它是 expo-audio **显式摘掉**的：`AudioMediaSessionCallback.kt` 四行 `.remove(COMMAND_SEEK_TO_{NEXT,PREVIOUS}…)`。
  🔴 **只删那四行不会有任何变化**——Media3 给 controller 的是「session 声明 ∩ **player 报告**」的交集，而 expo-audio 的会话 player 只有一个 media item，ExoPlayer 本来就不报这两条。修法是补一个 `TrackNavigationPlayer`（`ForwardingPlayer`）：**`getAvailableCommands` 和 `isCommandAvailable` 两个都覆写**（后者在 `ForwardingPlayer` 里问的是被包的 player，只改一个会得到「哪里都对、按钮就是死的」），`hasNext/PreviousMediaItem` 为真，四个 seek 方法**不碰 ExoPlayer** 而是发事件——队列在 JS 里，只有宿主知道「下一首」是谁。
  **回调不再替 player 做决定**，改成 player 说了算：没 opt-in 的 app 行为逐字不变。`AudioLockScreenOptions` 加 `showNext` / `showPrevious`（默认 false），JS 类型加 `remoteCommand` 事件——补丁对上游是**加法**，将来提 PR 顺手。补丁 26 行 → **453 行、八个文件**。
  **通知按钮加两遍**（session 的 custom layout 一份、Notification 自己的 action 一份）：冻结设备把媒体通知当普通通知画，custom layout 在那台机器上不算数（N3a 的老账）。折叠态三个位置给 **上一首 ｜ 播放/暂停 ｜ 下一首**，±10s 退到展开态。
  app 侧只有一条线：`player/remote.ts` 翻译两套词汇（session 说 `previous`，`decideNext` 说 `prev`），`driver.ts` 多一条 `onRemote`，`store.ts` 接到**和屏幕上按钮同一个 `advance`**。三条判据破法都验过红——其中「被换掉的 driver 不许再动队列」是**第二版**：第一版写成「stop 之后不再听」，破了照样绿（stop 之后队列已空，advance 本来就不做事），是一条空判据。测试 3404 → **3410**。
  **产物层面另验了一次**：`buildFromSource` 的老坑（改了但预编译 AAR 没变）这次直接查 dex——`TrackNavigationPlayer` 与 `remoteCommand` 都在 `classes3.dex` 里。真机复验（第二轮，对发出去的那份产物）11–13 与回归的 7 全过。

- **P7 发版（2026-08-27）** —— `android-v0.1.1`，GitHub Release 一个资产 `lark-0.1.1.apk`（88,585,008 字节，sha256 `df9fe3e47b0524f55625608b6054d287b17a5b71ffb14a213383cad163ac67f1`）。**发出去之后回读校验**：从 Release 下载回来的那份与本地产物、与手机上装的那份逐字节同哈希。顺序照计划：**先抬版本号（0.1.1 / versionCode 2）→ 构建 → 装机 → 上机**，因为真机验的必须是要发出去的那一份产物。**十条判据一次全过。**
  🔴 **差点验错东西**：第一次 `just mobile-android-release` 从头绿到尾——BUILD SUCCESSFUL、装机成功、`✓ signed with lark's release key`——而 `dumpsys package` 读回来仍是 `0.1.0 / versionCode 1`。`apps/mobile/android/` 是 prebuild 的输出且不进 git，而 release 配方不重跑 prebuild ⇒ Gradle 读的是上一轮那份 `build.gradle`。补跑 `just mobile-prebuild` 重建才对，并给 `mobile-verify-apk` 加了**版本比对**（`aapt2 dump badging` 对 `app.config.ts`，三种破法验过红）：**它是发版链路上唯一读产物的门，此前只读证书**。
  **发版前的代码清理**：全仓导出扫了一遍（值与类型，对照包括 `scripts/` 在内的每一个受控文件——`statusForCode` 只有 `accept-sync` 的 dist import 够得到，范围窄一点就会把它判死）。四个没有任何引用的删掉：`skybridgeErrorCode` · `SkybridgeStash`（注释写着「旧名字，留给还在用的调用方」，而没有调用方）· `isTaskErrorCode`（连同它唯一的支撑 `TASK_SET`）· `legalDocuments`（IPC 直接调 `readLegalDocument`，连同 `LegalDocuments` 一起走）。其余是干净的：没有 TODO/FIXME、没有孤儿模块、⑪ 取证的探针没有残留、2833 个测试体里没有空断言也没有重复用例。**测试仍是 3404——死代码就是没有断言的代码。**
  留着没做的两条进 backlog **C11 / C12**（移动端两处选择态脚手架、三份 StyleSheet 的重复）：**不在发版前动 UI**，那两块只有 tsc 和真机验得到，而真机刚验过的是要发出去的那份产物。

- **P6 自动下载下一首 + 预缓存（⑥，2026-08-27，两端）** —— 规则本体在 `@lark/shared` 的 `decideNext`，**开关做成必传输入而不是带默认值的可选项**：两端不能靠「谁忘了传」而各自变成两套行为。**默认开**——它替掉的那条规则（自然播完不许花流量，N4g-3 为流量写的）会让一个歌单按「碰巧下过哪几首」的顺序播，而不是按它写的顺序播。
  **预缓存问 `decideNext` 要下一首是谁**，不自己走一遍列表：两个「下一首」的算法迟早会取一首、播另一首，而症状不是报错，是偶尔多等一次——正是预缓存本来要消掉的那次等待。随机播放不预取（下一首是播完那一刻才抽的），单曲循环没有下一首。只看一首，不看两首。
  🔴 **预缓存不过缓存上限门，这是对本批计划的一处有意偏离**：上限门是给「批量」的——几十首、没人等着、下新删旧是个意外。而预取正好一首、给的是正在听的这个列表；何况就算拦住，三分钟后播到它时那条路照样会下，拦下来只多出一段空白。
  桌面同步：`playback.auto_download_next` 进 `lark_config.toml`（**配置里第一个布尔字段**，顺带给 loader 加 `bool` 收敛、给 daemon 的 PATCH 白名单加 `boolean()` 校验），设置页一个勾选框，`decideNext` 和 `ensureFile` 一起跟着走。桌面那条老判据「skips a fileless neighbour」如约变红——改成两态各一条。
  测试 3387 → **3404**。

- **P5 缓存上限门 + 歌单「全部下载」（⑤，2026-08-27）** —— 规则按用户定的那条：**自动下载到上限就停，不腾地方**；停下的每首在下载记录里留一行、码 `CACHE_LIMIT`、话里说清楚「调高上限，或者点重下手动下（那会按最近最少使用清理旧文件）」。**「下新删旧」因此是一个人的决定**，不是批量操作背着你做的事。
  三个判断：**要有估算**——没人知道一首歌下完多大，而决定必须在按下的那一刻做；估算是「秒数 × 每秒字节」，而**每秒字节是在这台设备上量出来的**（`file_size` 本来就和 `has_file` 一起挂在每一行上），不是拍脑袋的常数。**撞上了就停，不挑小的往里塞**——跳过塞不下的那首去凑后面的小的，会让「已排 7 首」变成一个谁也说不清是哪七首的数。**用的是设备级的已用字节**（上限本来就是设备级的，清理还会先动别的曲库），所以把设置页那段抽成了 `cache/usage.ts`，两个调用者读同一个数。
  🔴 `CACHE_LIMIT` **明确不进自动重试的白名单**：那条记录之所以存在就是因为没地方了，自动重试等于自己走过自己设的门。
  你提的「清理别动排队中的」机制早就在（`pendingFileSongIds` 覆盖排队+进行中），但既有判据测的是**正在跑**的任务。补了一条**排队中**的——「全部下载」一次排四十首，其中三十九首在等——破法（只认 running）验过会红。
  测试 3369 → **3387**。

- **P4 下载失败自动重试（⑧，2026-08-27）** —— 🔴 **计划里标红的那个前提是真的，而且只对了一半**：连接失败 / HTTP 错 / 流提前断都是 `BILIBILI_FAILED` 认得出，**但超时掉进兜底成了 `INTERNAL_ERROR`**——而超时正是手机上最常见的失败。照原样上「只重试网络类」等于把最该重的那一类漏掉。
  先修这个：`describeTaskError` 认下 AbortError/TimeoutError，给它 `DOWNLOAD_TIMEOUT`。**这一步靠的是引擎早一步就分好了岔**——`engine.ts:743` 的 `cancelRequested || stopping` 走 `cancelled` 且根本不问 `describeTaskError`，所以走到这里的 abort 只可能是 `withTimeout` 的。**桌面同样受益**：它以前也把超时报成「下载任务出现内部错误」。
  重试集合是**白名单**（`DOWNLOAD_TIMEOUT` / `BILIBILI_FAILED` / `PREFLIGHT_TIMEOUT` / `NORMALIZE_FAILED`），逐条写了为什么在、为什么不在——**风控不重试**（再问一次正是它出现的原因）、**LLM_FAILED 不重试**（是别人的网络，且每次都要钱）。次数在设置页选 0/1/2/3，**默认 1**。
  **不做退避**：延迟只能是 JS 定时器，而它熄屏就冻（`INVARIANTS` §6），「30 秒后重试」在进兜里的那一刻等于「等你下次看手机」。立刻重试，N 次，完。
  **一条下载在记录里只占一行**：重试会把被它取代的那条记录删掉，那一行的状态就是最后一次尝试的状态。**链条按任务 id 跟**——按 url / input 这类派生值跟，一旦某次归一化结果不同，计数就重新开始，那不是「多试一次」而是循环。另加一个进程级兜底 50 次并打日志：这条不是策略，是「万一我对两个调度器的先后判断错了」的护栏（`driver.ts` 自己的注释就写着 spike 时代的重试循环是怎么造出请求风暴的）。
  测试 3357 → **3369**。

- **P3 下载记录持久化（⑦⑨，2026-08-27）** —— 引擎的终态环是**内存里的 100 条**、界面只画最近 20 条，所以「在路上失败的那次下载」在有人去看之前就没了。改成：完成过的从一份文件来（**每个工作区一份 `downloads.json`**，原子写，挨着它那个曲库），**引擎的环不再画到屏幕上**——那是引擎的记忆，不是记录。
  **不自动删**，200 是文件的上限不是时间窗；只有「清空」和「删除」会少一条。由此有一条不显眼但要命的规则：**「见过」和「留着」要分开记**——引擎那一整个 launch 都还攥着那些任务，谁要是从快照重新推导，下一次状态事件就会把刚删掉的行顶回来（这条有单测，破法验过）。
  **成功的歌词续跑不进记录**（用户问出来的）：引擎每下成功一首就自动排一个歌词任务，而它带着同一首歌的名字 ⇒ 不管的话每首歌永久占两行、200 条额度一半是噪音。失败的歌词**留着**——那是全 app 唯一一处说得出「这首歌没抓到词」的地方，那一行的「重下」也是唯一能再要一次的入口。
  **「重下」只出现在没成功的行上**（用户定，2026-08-27）：歌曲的 ⋮ 菜单已经有「重新下载」，成功行再放一个就是同一件事的第二个入口，两边迟早不一致。记录仍然完整列出下过什么，只是能按的只有失败和被取消的那些。
  **重下**走的是添加页那同一个识别器，不是第二个解析器；而识别器的五种答案里有三种根本不是下载，`replay.ts` 就是为这个存在的（判定可测，宿主只接线）。**记录不带命名方式**（`DownloadTaskData` 上没有），重试按当下选的 命名 走。
  接线在 `App.tsx` **不在界面里**：从「歌曲」点一首没文件的歌也会起下载，而它在没人打开过「添加」页时失败，正是记录最该抓住的那一类。测试 3328 → **3357**。

- **P2 锁屏续播（⑪，2026-08-27）** —— **先取证再动手**。真机探针（release 构建 + 应用内日志环，debug 装不上去：签名不同，卸载会带走曲库）把链路四步各打一个时间戳：`didJustFinish` 到达 JS +0ms、`decideNext` 判定正确 +55ms、`pause()` +56ms、**`await sleep(300)` 之后 +63 537ms**，解冻后 82ms 内播上下一首。**判断和播放都是对的，卡住的只有那一个 JS 定时器**；而且放开它的是**解锁**，不是屏幕亮（唤醒后连采 1.7 秒仍冻着）。
  修法：`modules/lark-app` 加原生 `delay(ms)`（主 looper 的 `postDelayed`，与显示无关），`player/driver.ts` 的两个定时器——300ms 拆卸间隔与 15 秒加载看门狗——都换掉。**排除过一个候选修法**：「听状态流等暂停生效」在播完这个场景上不成立，`BaseAudioPlayer.kt:84` 把 `STATE_ENDED` 下的 pause 判为 transient 而不发事件。
  电脑上唯一能变红的判据是新守卫 `check-mobile-no-js-timers.sh`（`src/player/` 禁 `setTimeout`）——`driver.ts` 自己 import expo-audio，进不了 vitest 白名单。**剩下的证据只有设备能给**，排在 P7 的那一次会话里。

- **P1 界面账（② ③ ④ ⑩ ⑫，2026-08-27）** —— 五条：顶栏的「lark」删掉（状态栏留白留着，那才是挖孔的那一份）· 添加页整页一个滚动条（任务列表成为唯一滚动容器，表单当它的表头，**必须传元素不能传函数**，否则每敲一个字输入框失焦）· 返回键按「多选 → 歌单详情 → 非歌曲 tab → 系统」四级（**优先级是数字不是注册顺序**：React 的 effect 是子先父后，纯 LIFO 会先问外层）· 歌单里的 ⋮ 变成和「歌曲」同一张菜单（多一条移出歌单，且它不再是红色——红只留给不可逆的删除）· 设置页删掉八项调试信息（留「曲库 N 首」与折叠起来的「最近的错误」，后者是 release 构建唯一能看见错误的地方）。
  顺手修了一个既有的 hooks 顺序 bug：歌单详情的三个 list hook 在 `if (detail === null) return` 下面——别的设备删掉你正打开的歌单时 hook 数量会变、渲染直接崩。要在那儿加 `useBack` 就不能把新 hook 加进同一个坑。
  `playlists-tab.tsx` 592 行拆成 175 + `playlist-detail.tsx` 456 + `add-songs.tsx` 108。测试 3317 → **3328**。

## 历史归档

已走完的阶段的逐批实施记录——经过、判据结果、当时的判断与决策：

| 阶段 | 位置 |
|---|---|
| **v0.1.0 本地全功能**（M0–M7，2026-08-10 发布） | `docs/history/v0.1.0-shipped.md` |
| **v0.2.0 skybridge 同步**（T0–T6，2026-08-13 发布）+ v0.2.1 | `docs/history/v0.2.0-shipped.md` |
| **v0.3.0 m4a 统一 + 一次性迁移**（Phase A，2026-08-17 发布） | `docs/history/v0.3.0-shipped.md` |
| **Phase B Android**（N0 平台 spike → N7 每账号工作区） | `docs/history/phase-b-shipped.md` |
| **0.4.0 + Android 0.1.0 发版**（2026-08-26，含文档大整理与 N7 收口） | `docs/history/0.4.0-android-0.1.0-shipped.md` |
| **决策流水**（2026-07 至 2026-08，「当时为什么这么定」） | `docs/history/decisions.md` |
| 某一批的判据、决策、评审全文 | `docs/plans/<日期>-<里程碑>.md`（路由 `docs/plans/README.md`） |

## 关键参考

- **改代码前必读的约束** → `docs/INVARIANTS.md`
- **实测踩坑**（按时间分段） → `docs/LESSONS.md`
- **待办与已决定不做的** → `docs/plans/2026-08-26-backlog-before-android-v1.md`
- 本仓设计 → `docs/DESIGN.md`；跨仓 → `../aviary/docs/{DESIGN,ROADMAP,SKYBRIDGE_ARCH}.md`
- 常用命令 → `justfile`（`just --list`）

## 怎么往这里加东西

- **一批做完**：在「本阶段记录」追加一段——**经过 · 判据结果 · 当时的判断与决策**，写清「为什么」而不只是「做了什么」。
- **一个阶段做完**（发一次版，或一条大线收口）：整段移进 `docs/history/<阶段>-shipped.md`，在归档表加一行，本文件回到只剩「当前阶段」。**这是一次单独的提交**，照 owl 的 `docs: archive <阶段> + trim PROCESS/CLAUDE post-<版本>`。
- **发现一条仍然约束新代码的规则** → `docs/INVARIANTS.md`，别只留在批次记录里。
- **踩到一个坑** → `docs/LESSONS.md`。
- **决定先不做某件事** → backlog 的对应字母节；**已定的「不做」进 E 节，不是待办**。
