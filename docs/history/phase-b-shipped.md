# 归档：Phase B Android 移动版（N0–N7）

> 归档自 `PROCESS.md`（2026-08-26，Phase B 收口后整理）。**不再更新。**
> 当前进度以 `PROCESS.md` 为准，仍然生效的约束在 `../INVARIANTS.md`，实测踩坑在 `../LESSONS.md`。
>
> 读它的正确姿势是**带着问题来查**（「这个决定当时为什么这么定」「那条判据当时怎么过的」），不是从头读一遍。

从零到「一台 Android 手机是 workspace 里的一台设备」：N0 平台 spike · N1 业务图端口化 · N2 曲库与启动序列 · N3 播放 · N4 下载 · N5 同步 · N6 歌单导入与收尾 · N7 每账号独立工作区。
全期主计划 `docs/plans/2026-08-13-m4a-and-mobile-master-plan.md` §4，各批子计划在 `docs/plans/2026-08-1x/2x-phase-b-mobile-*.md`。

**这一段特别值得查的三处**：N1 子计划 §8.1 的 D5 分段冻结（单一事实源）· N2 §2.2 的启动序列冻结 · N4e §8.5 的测试规模定案。它们仍然约束新代码，摘要在 `../INVARIANTS.md`。

## Phase B Android 移动版（`apps/mobile`）

主计划 `docs/plans/2026-08-13-m4a-and-mobile-master-plan.md` §4（D1–D17）+ N0 子计划 `docs/plans/2026-08-17-phase-b-mobile-n0.md`（**v4**，三轮评审定稿：判据 1–26 / 决策 a–l / R1–R5）。批次 N0a → N0b → N1 → N2 → N3 → N4 → N5 → N6；**N1 起每批开工前另出子计划**。

**版本口径**：APK 独立版本线 0.1.0 / versionCode=1（D14）。桌面 Phase B 期间不必发版；N1 的重构落 main、随下个桌面版本自然发出。中途若发桌面 0.3.x，先复跑 accept 全系列。

**当前状态（2026-08-17）**：**N0a 全部 + N0b-1 + N0b-2 + N0b-3 已完成**。桌面测试 **2480**（加 `@noble/hashes` 之后复跑，逐包相等）；真机 vivo V2408A / Android 15（档案见子计划 §9）。**D4 出口已冻结**（expo-sqlite + per-call transient shim + drizzle 走 `pnpm patch`）。**N0b-3 的 release 实测**：冷启动余量两个数量级（2k 库开库到首屏 max 29.93ms / 预算 3s）· backfill 500 首一段 64.36ms（p95）· **apply 的生产批 500 过不去（p50 164ms），暂定 200/批**（72.98ms）· md5 端口 0.02ms 远超预算，**sha256 的阈值改绑真实歌词尺寸**（1.94ms / 预算 10ms；256KB 上限的 86.81ms 作为标注最坏值记录，用户拍板） · **`globalThis.crypto.getRandomValues` 不存在**、`atob` 与 `Buffer.from(base64)` 在 7 个样本里 2 个发散 → 两者都必须走端口 · **`globalThis.fetch` 就是 `expo/fetch`**，manual redirect / 204 / 流式 `res.body` 三条全过（N1 不必为 fetch 做注入选型）。**N0b-4a 已完成（2026-08-18）**：判据 **22 四条硬 gate 全绿**（login / pushChanges / pullChanges / refresh，SSE 软判据也全绿——桌面 nudge 推的change 经 `onChange` 到达、`unsubscribe` 后零帧）· 判据 **23 双网络各一遍全绿**（md5 端口复现 core 的 `w_rid`、签名 search URL、免签三端点，Wi-Fi 与电信 5G 结果一致）· 判据 19 的**流探针一半**完成，两条实测：**流 URL 只在签发它的那张网上有效**（playurl 按调用方 IP 派节点，桌面签的 `cn-bj-cc-*` 在 5G 上连不上，`adb shell curl` 独立复现），**最低 header 要求按节点而非按平台**（cc 节点缺 `Referer` 403；移动网络派来的 mcdn `:8082` 节点零 header 也给 206，content-type 是 `application/octet-stream`）。音频夹具已产并 push（短 2:17 取自用户收藏夹最短一条；长 37:07 收藏夹里没有，另搜）。

**N0b-4b 已完成（2026-08-18）——D17 出口冻结：raw fMP4 直存达标，GO，不需要 remux**。两条 bilibili 原始字节在 ExoPlayer 上加载 119ms、**时长与 ffprobe 逐毫秒相同**、seek 0/25/50/95% 偏差 ≤0.001s、37 分钟长曲 95% 处 0.256s，单 player 与 playlist 各一遍；后台+锁屏 **330.6s 播放推进 329.9s 零暂停**；锁屏元数据与媒体键（`MEDIA_PAUSE`/`MEDIA_PLAY`）可用；焦点瞬时抢占自动恢复（bilibili 请求 `GAIN_TRANSIENT`）、永久抢占（网易云完整 GAIN）停住且不自恢复。§3.2 的三级兜底一级都没进。**两条红都不是存储格式问题、归 N3**：① **蓝牙断连不暂停而是转外放**（media3 的 `handleAudioBecomingNoisy` 默认关、expo-audio 未暴露，RN 侧也没有该事件 → 要打补丁或自建小原生模块）；② **`release()` 不先 `pause()` 留下停不掉的音轨**（#47569 在 57.0.3 上实证仍在，只有 `am force-stop` 能收 → pause-before-release 是硬要求）。

**N0b-4c 已完成（2026-08-18）——判据 24 绿（软），D13 入口形态不降级**（`expo-share-intent@8.0.1` + `expo-linking@57.0.6`，release 构建）。真 bilibili **8.83.0** 视频页 分享 → 横滑出「更多」→ 系统 chooser 里 **「lark spike」在列** → 点它 → spike **冷启动 +15ms** 收到并原样显示 `莫愁乡--（OfficialMusicVideo）亚细亚旷世奇才 https://b23.tv/cfzPKZX`；系统解析器侧的客观证据是 67 个 text/plain SEND handler 里有我们。合成矩阵三条路径（冷启动 / 后台存活 / 前台 onNewIntent）全绿，文本由主机**逐字符回读比对**（CJK · 换行 · emoji · `?p=2`）。**四条实测**：① **分享文本里没有 bvid，只有 b23.tv 短链**且 `EXTRA_TITLE` 为空 → N4 的添加页在展开短链（一次 `redirect:'manual'` 往返）之前识别不出任何东西，必须有「正在解析」态；② **收藏夹的分享直接进 bilibili 自己的发动态发布器**，到不了系统面板 → 收藏夹/合集只能靠粘贴框；③ **`performance.now()` 在 RN Android 上是 `SystemClock.uptimeMillis()`**——不从 JS context 起算，且**深睡期间不走**（实测与 `/proc/uptime` 差 13.5 小时 = 手机睡的那一夜），跨熄屏算「过了多久」不能问它；④ **payload 是易失的**（`resetOnBackground` 默认开，切后台即清），添加页必须挂载即消费。

**N0b-5a 已完成（2026-08-18）——判据 26 绿，D16 机制落定**。**零写打开取候选 ①（copy-then-open）**：50.2MB 库 copy+open+读 install_id **max 75.36ms**，带 4.0MB 热 WAL 时 **max 149.51ms**（预算 500ms），两组的**原件 size+mtime 五轮前后逐字节不变**，而恢复确实落在副本上（副本的 `-wal` 4,128,272 → 0 字节）；racing-writer 反测 → `FailClosedError`。**no-backup 侧取 SecureStore**（`requireAuthentication: false`），**卸载重装后读不出**，判定落到「fresh」。**backup 排除三层客观判据 10/10**（`just spike-mobile-backup-audit`）：APK 的 merged manifest（`allowBackup=false` + 两个属性经资源表翻回名字确认指向我们那两份）· 两份规则文件各 9 个 domain（`<cloud-backup>` 与 `<device-transfer>` 都有）· `bmgr backupnow` 答 **`Backup is not allowed`** 而同一轮控制组答 `Success`、`dumpsys backup` 里没有我们、restore 回 `0 packages`。**四条实测**：① `allowBackup=false` 只关云备份、关不掉 D2D（那要 `<device-transfer>`）；② **expo-secure-store 默认会抢那两个 manifest 属性**，必须 `configureAndroidBackup: false`，我们的 plugin 见到被占用直接抛错；③ **证据要取在能观测到的那一刻**——第一版查「副本旁边有没有 `-wal`/`-shm`」恒为假，因为关闭连接本身会 checkpoint 并删掉它们；④ **一个 `Uint8Array` 既是值也是对象**，shim 把它当成命名参数表（`bound key '0' …`），已修并在契约补一条 lone-bytes 用例（core 1046 → **1047**，全仓 **2481**）。缺口如实记：设备 API 35，`fullBackupContent` 那条老路只能静态检查；完整 D2D restore 与 fail-closed 分支仍归 **N2 gate 的四组**。**N0b-5b 已完成（2026-08-18）——判据 25 绿，N0b = GO，Stage-2 已落**。**D14 落定**：applicationId `com.orpheusaviary.lark` · APK 0.1.0 / versionCode 1 · keystore `lark-release.jks`（PKCS12 / alias `lark` / RSA 4096 / 有效期至 **2054-01-03** / 证书 SHA-256 `38:54:4C:9F:…:F6:3D`）· **决策 g 由用户拍板**：keystore 与密码**同放** `orpheus-aviary/android-keystore/`（git 仓之外，0700/0600，**不进钥匙串**，每次构建现读，备份由用户拷 U 盘）· **恢复演练过**（整个目录拷走，只用副本签 APK，`apksigner verify` 的指纹逐字符相同）。**政策快照**（查官方页与 FAQ）：2026-09-30 只覆盖巴西/印尼/新加坡/泰国的参与商店，**adb 安装明确豁免**，测量设备在中国不在首发之列，**2027 全球扩大**才相关；真要注册时 **limited distribution account**（免费、无政府 ID、上限 20 台）匹配，注册对象是包名 + 证书 SHA-256。**判据 14/16 因契约扩了一条用例而复跑**：expo **57/0/0** · 漏版反测 55/2 · op-sqlite **51/0/6**。**两条实测**：① **Gradle 的 bundle 任务看不见 `packages/core/dist` 的变化**（core 重建了，APK 里还是旧的，面板上连断言文案都是旧的），release recipe 因此先删生成的 bundle 再构建；② **同一个「Uint8Array 既是值也是对象」的歧义把两个适配器都咬了**，op-sqlite 那边更安静（blob 什么也没绑上、列读回 NULL）——正说明这条该由契约说一次。**GO/NO-GO：GO**（判据 11–26 全完成、gate 全绿、三条 NO-GO 线一条没碰）。

**N1 进行中（2026-08-18 开工）**——子计划 `docs/plans/2026-08-18-phase-b-mobile-n1.md`（v4，决策 a–q 全关，九批 N1a–N1i）。**N1a–N1i 已完成**（判据 22 的「对新构建产物复跑 accept 全系列」尚未做），桌面测试 **2481 → 2532 → 2571 → 2576 → 2578**；Metro 图 36 → 51 → 80 → 90 → 94 → **97 个 portable 模块**，且 bundle smoke 自 N1i 起就在 `just check` 里（整条 ~9s）。**N1h 之后，一台手机能解析的 core 包含 sync 全图、library 全图、SyncCoordinator、LibraryService 与整条下载编排**——`@lark/core/portable` 之外只剩真正属于这台机器的东西：`db/` 的打开与锁、ffmpeg 与落盘协议（`download/{audio-landing,ffmpeg,resolve,import}.ts`）、file-op 执行器、config、logger、paths 根解析，加上 daemon 的定时器/SSE 壳与 wire 层。**只剩 N1i**（守卫收编 + R1–R5 + D5 分段冻结）。

**N2 子计划已出（2026-08-19，v1 → v2 → v3，两轮评审收敛）**——`docs/plans/2026-08-19-phase-b-mobile-n2.md`，七批 N2a–N2g / 判据 22 条，修订对照在子计划 §8 与 §8.1。**两轮评审的性质相同：都不是「写漏了」，是「按它实施会红」。**

**N2a 已完成（2026-08-19，`b5c95f5`）——`apps/mobile` 立项**。Expo 57 + CNG，applicationId `com.orpheusaviary.lark` / versionCode 1 / **minSdk 26**（决策 a），`plugins/with-backup-rules.js` 从 spike 复制一份（`apps/` 不 import `spikes/`）。**判据 2/3/4 绿**：与 spike 共有的依赖逐字节同版（`react-native 0.86.2` 对得上 Expo 的 `bundledNativeModules.json`），三条反测各自点名——barrel import 报 `apps/mobile/src/App.tsx:16`、`node:fs/promises` 由 Metro 打出 import stack、非 portable 的 core 模块由 escapee 检查点名。**两条守卫作用域从 spike 扩到 spike + mobile**（`check-spike-mobile-imports.sh` → `check-mobile-imports.sh`；bundle smoke 建两个 bundle），驱动脚本改吃 `LARK_PACKAGE` / `LARK_APP_ROOT`。`just check` 8s 上下、`just test` **2578 不变**。**判据 1（真机装起显首屏）等手机**。

**N2b 桌面那半已完成（2026-08-19，`eb6a28e`）**：`ensureDeviceUuid` 下沉为 `portable/db-identity.ts`（桌面 `db/index.ts` 改调它并保留 re-export，25 条 `db/index.test.ts` 与两套 daemon e2e 一个字没改）；§2.4 的打开分派落 `portable/open-library.ts`，拆成 **`classifyLibrary`（零写，步骤 ③ 跑在副本上）+ `prepareLibrary`（步骤 ⑦，`onVerdict` 钩子是宿主唯一被允许设 WAL 的时刻）**——放 portable 而不是 `apps/mobile`，就是为了让六格在桌面 test runner 上跑得起来。**六个变异逐条验红**，其中一个抓到自己的测试有洞：converge 用例第一版只断言返回值、没断言持久化，于是「mint 了不落库」是绿的（已补 `expect(stored()).toBe(after)`）。判据 7 的「`core/migration/` 不进图」排在通用 escapee 规则**之前**，否则它是不可达的死代码——`core/migration/`（桌面 ffmpeg 那套）与 `core/portable/migrations/`（schema 链）差一个字符、结论相反。桌面测试 2578 → **2596**。

**N2b 真机验收（2026-08-19，release 构建、冻结设备 V2408A / Android 15 / API 35）——判据 1 绿 + 自检 6/6**。`com.orpheusaviary.lark` 与 `…lark.spike` 同机共存、MainActivity 在前台、首屏三行都在（`schema v3` / `protocol v6` 是从 portable 与 shared 真读出来的，说明 97+ 个 portable 模块在真机上真的解析并执行）。APK 合并 manifest：`minSdkVersion=26` / `targetSdkVersion=36` / `versionCode=1` / `versionName=0.1.0`。数据层自检六条全过：fresh 到 v3 · `0003` 的标志清成 `'0'` 且行还在 · 重开是 `current` 且不动标志 · **步骤 ⑨ mint 出的 uuid 重开还在且幂等** · **收敛后第一次写抛「device_uuid is missing」、跑完 ⑨ 才写得进（新 uuid 与旧的不同——决策 j）** · 更高版本库被 `IncompatibleDbError` 拒绝。

- **第一轮是 5/6，红的那条是我自己的断言写反了**：`openLibrary` 按 §2.2 只做 ⑥⑦，**不产 `device_uuid`**（⑨ 归 N2c 的身份门），而用例假设「开完就该有」。修成断言真正的不变量（开完没有 → mint → 重开还在 → 幂等），并在桌面 `open-library.test.ts` 补一条「`prepareLibrary` 不 mint」守着同一件事。**面板的第一条红是它自己的断言——这正好证明它不是白跑的**。桌面测试 2596 → **2599**

**N2c 进行中（2026-08-19）——身份门的机制半边已接进启动路径**。`identity/{state,store,snapshot,converge}.ts` + `ports/credentials.ts` + `boot/sequence.ts`（§2.2 的 ①–⑫ 一条线一个文件），`App.tsx` 挂载即走 `runBootSequence()`——**到 N2c 才允许接持久化启动入口**，因为在此之前那等于一个会把恢复库当自己库打开的构建（§3）。**判据 19①② 真机绿**：第一次 `fresh` → 双侧写 `install_id`；force-stop 冷启第二次判 `normal`，install_id 与 device_uuid **逐字符不变**——这正是 v2 那个「第二次启动清掉自己刚建的库」的回归测试。

- **§2.2.1 的判定表做成纯函数并单独给 `apps/mobile` 配了 vitest**（`include` 只收 `identity/state.test.ts` 一个文件）：两轮评审的 bug 都长在这张表上，值得用秒级测试而不是「构建-安装-点按」去试错。10 条用例；两个变异验红——把「fresh 由身份判定」写回去（**v2 原样的 bug**）只有为它写的那条红，把 intent 降到 settled 行之后 3 条红
- **一个实现细节值得记**：intent **读不出来时当作没有是安全的**——它写在步骤 ⑤（DB 尚未被碰），落回 settled 行会重新推出同一个结论。intent 买的是幂等（同一个 id），不是正确性
- **converge 比 §2.2.2 的清单多做一件**：`bumpBackfillTarget`。`unbindLibrary` 清同样这些表时也 bump，理由相同——outbox 没了，活下来的东西必须重新发布。不做的话症状要到 N5 才出现，且表现为「同步正常但从不发送已有的东西」
- **步骤 ⑪ 的 boot drain 是注释占位不是空调用**：执行器归 N2d，塞一个 no-op 占位会让顺序看起来已经落实
**N2c 已完成（2026-08-19）——四组 gate 全绿**（16b 已搁置）。验收通道按决策 o 落地：**entrypoint 分叉在 Metro 的模块图上而不是运行期开关**（`metro.config.js` 在 `LARK_ACCEPTANCE=1` 时把 `./src/root` 重定向到 `./src/acceptance/root`）——这样「生产 bundle 里没有 `acceptance/`」才是**守卫查得了**的事，运行期开关永远查不了。两个 artifact 同包名同签名（`just mobile-android-release` / `just mobile-acceptance-release`），不能共存是决策 o③ 认下的代价。

- **判据 16a：10/10**（`just mobile-backup-audit`，真 APK 的 merged manifest + 编译后资源翻回名字 + `bmgr` 三层）。`<device-transfer>` 的九个 domain **在 APK 里是齐的**——搁置的 16b 是「走一遍手机搬家」，不是这份声明
- **判据 17 / 18 / 19②③④⑤⑥：真机 8/8**（acceptance artifact，release 构建）
- **守卫双向都验过**：从产品 import 一个 `acceptance/` 模块 → 红并点名；`LARK_ACCEPTANCE=1` 建出来的图里**必须**有 acceptance 模块（`just mobile-acceptance-smoke`）——**只有后一条能发现「分叉悄悄不分叉了」**，否则生产那条断言会永远绿而每次验收测的都是产品
- **第一轮 6/8，两条红是真 bug**：converge 崩在 DB 事务之后重启会整段重跑，所有 `DELETE` 幂等而 `bumpBackfillTarget` 不是（`backfill 1 → 3`）。判据 19④ 的「只清一次」当时读起来像措辞，实际是唯一能观测它的断言。修法见 `docs/LESSONS.md`
- **决策 o④ 收窄**：D16 自己的判据一条也不需要推文件——夹具在设备上**用真路径造真库再把身份拿掉**（那正是恢复干的事）；`adb push` 通道只服务判据 14 的真实桌面副本，随 N2f 落地
- **崩溃点用「抛」模拟**：持久化状态与真 kill 相同、点位是选的不是猜的；唯一差别（开着的句柄 / 热 WAL）如实记在 `d16.ts` 的头注释里，**到 N2d 的 drain 才重要**
- **步骤 ⑪ 的 boot drain 仍是注释占位**（执行器归 N2d）

**N2d 进行中（2026-08-19）——决策 a 的 native module 与两个端口已落地，判据 9 / 10②③ / 11 真机 7/7**（acceptance artifact，release）。`modules/lark-fs` 自建 Expo native module：一个 `moveAtomic`，`Files.move(REPLACE_EXISTING, ATOMIC_MOVE)`，**没有降级分支**（不支持时直接抛 = 判据 10④ 由实现保证）。判据 10⑤ 已由 APK 合并 manifest 断言 `minSdkVersion=26`。`FileSystemPort` / `PathsPort` 实现完成；`writeTextAtomic` 的临时文件是同目录兄弟 `.<basename>.<uuid>.tmp`，前缀可扫。

- **SDK 57 的 `expo-module-gradle-plugin` 既不推导 `namespace` 也不推导 `versionName`**，两个都要自己写；后者的报错是从 `node_modules/expo/android/build.gradle` 抛出来的，看着像 expo 自己的问题
- **三条红各逮到一个真问题**（无一是断言写错）：Expo 的 `AsyncFunction` 转换 lambda 返回值 → `Files.move` 的 `Path` 变成 `Unknown type: sun.nio.fs.UnixPath` · `just` 的 `*ARGS` 拆掉引号 → 一整组结果读的是另一块面板 · `installPortableRuntime` 里多余的 `installed` 标志缓存了 portable 拥有的状态，`resetRandomForTesting()` 之后永久失配。三条都在 `docs/LESSONS.md`
- **判据 11 是先意外撞上、再转成正式用例的**：验收入口不挂载即启动，于是 `no RandomSource` 自己冒了出来——端口按设计 fail-loud
- **判据 10①（gate）真机绿**（`just mobile-fs-instrumentation`，两线程 + barrier，2000 轮原子替换）。反测**正向断言自己看见了窗口**；把它指向 `AtomicMove.atomic` 后以自己写的那句话失败——**所以原子那条不是恒真**。顺带一个网络坑：`junit:4.13.2` 从 Maven Central 回 403（两个域名都是，Google Maven 与阿里云镜像正常），由用户在网络侧解决，不是构建配置问题
**N2d 后半（一）：控制面已进 portable（2026-08-19，决策 k）**。桌面 `FileEffectRuntime` 424 行拆成两半：调度与**四种 op 的语义**去了 `portable/sync/file-ops-runtime.ts`（drain / retry / discard / claims / 退避 / dead-letter / `deleteRemote` 的分支矩阵 / `locateAudio` / 空歌词即无歌词），桌面 `core/src/sync/file-ops-runtime.ts` 只剩 `nodeSongFiles()`（五个动词）+ 一个把宿主端口预置好的子类 + `recovered-songs/` 的两个 boot 扫描。**call site 一个字没改**（daemon context / boot / `--direct` 仍是 `new FileEffectRuntime({ sqlite, … })`）。

- **新端口 `SongFilesPort`（五个动词）而不是给 `FileSystemPort` 加方法**：后者是**文件级**的「用到的那点面」，而执行器要的是目录级的三件（删目录、把一个文件挪进 `recovered-songs/`、把整个目录挪进去）+ 两个存在性问题。分开之后，一个还没有 journal 要 drain 的宿主一眼能看出自己缺的是哪半。词汇沿用 `PathsPort`：只说 song id 与 quarantine **名字**，`join` 与 R10 都留在适配器
- **`quarantineExists` 是个问句不是 `moveIfAbsent`**：目标已存在意味着「移动发生过、崩在它之后」，该丢下剩余目录还是合并，是执行器的判断，不是宿主的
- **`LYRICS_FILE` 上提到 `ports/paths.ts`**：桌面 `paths.ts` 与 mobile `ports/paths.ts` 各拼各的 `'lyrics.lrc'`，而执行器现在要**按名字**搬这个文件——三处同一个字符串，收到一处
- **判据 12 的桌面那半：原 23 条 + 新 4 条全绿**（core 1175 → 1179，全仓 2599 → 2603；`just test-sync-e2e` 19 条不变）。既有那 23 条现在跑的就是 portable 的决策，**它们原样绿正是「零行为变化」的证据**
- **三个变异逐条验红，其中一个证明新用例不是凑数**：把 `keepLyrics` 写死 false → 红 4 条；**把 `locateAudio` 改成不查存在直接回首选名 → 只有新加的「崩溃重入」那条红**（原 23 条全绿——一个崩溃后会重复搬运的执行器能通过 N2d 之前的全部测试）；把「arg 读不出来」从抛改成静默成功 → 只有新加的 dead-letter 那条红
- **崩溃重入的造法**：不是 `kill`，是**只破一个动词**（`removeSongDir` 第一次抛）——那正是「进程死在两次宿主调用之间」留下的持久状态：文件已救出、目录还在、行还在。顺带这是唯一直接驱动端口缝的用例，而缝正是手机要替换的东西
**N2d 已完成（2026-08-19）——判据 12 真机 9/9，N2d 全绿**（acceptance artifact，release，冻结设备 V2408A）。移动端 `SongFilesPort` 五个动词落 `ports/song-files.ts`，启动序列第 ⑪ 步从注释占位换成真的 drain，`BootResult` 多带 `fileOps` + `drained`（N2e 的服务层必须复用**这一个** runtime——两个 runtime 管一条 journal 就是两套 claim 仲裁）。

- **expo 的两条 move 语义是照 `fsops/CopyMoveStrategy.kt` 读出来的，不是猜的，而且两条都被反测点着**：`File → Directory` 要求目标目录**已存在**（`prepareAsDestination` 抛 `DestinationDoesNotExistException`）· `Directory → Directory` 按目标存不存在分叉——不存在则源**变成**它（父目录要在），存在则源被**塞进它里面**。后者执行器永远不该走到，所以适配器把它变成显式抛错，而不是安静地嵌一层
- **判据 12③ 用的是真 SIGKILL，不是抛**——这笔债是 `d16.ts` 自己记下的（「a death in the middle of the file-op drain leaves half a file operation, which is not a database state at all」）。做法：面板把 drain **停在自己选的点上**（`removeSongDir` 里，两次抢救之后、删目录与删行之前）并显示 `PARKED`，`am force-stop` 打下去，重启后按 `local_metadata` 里的夹具断言。**点是选的、kill 是真的**——决策 o⑤ 要的那两件同时成立
- **四个变异逐条验红**：`quarantineSongFile` 不建目标目录 → 只有矩阵那条红（`executed 1 of 6`）· `quarantineSongDir` 不建 `recovered-songs/` → 两条红 · `removeSongDir` 去掉 `exists` 守卫 → **只有「四种 op」那条红，而且只因为我在写反测前刚补了那个用例**（见下）· **把第 ⑪ 步的 drain 删掉 → 12③ 与 12⑥ 双双红，12⑥ 的失败文案就是 `the boot drain executed 0 of the 1 waiting`**
- **两个用例是「想反测怎么破」时补出来的，不是跑红了才补的**：① `delete_song_files` 的 local 分支**不问 `songDirExists` 直接删**，所以「目录已经没了的本地删除」是 `removeSongDir` 唯一一个会收到不存在目录的入口——原来七条一条都没走它，`exists` 守卫等于没测；② `quarantineExists` 的 **true 分支**（移动发生过、崩在它之后）原来也没人走——造它要把重放的 op 指回**它自己的 target**，另起一个 target 的第二条 op 走的是「没东西可搬」那条路，证明不了任何事
- **顺带一条要如实记的**：D16 的判据 19⑥ 现在有了真的 drain 之后仍然绿，是因为它塞的那条 op 是 `song-x`（过不了 uuid 门）——它断言的是「收敛不动 `sync_file_ops`」，**「并由第 ⑪ 步执行掉」那半由判据 12⑥ 覆盖，不是 19⑥**
- **`recovered-songs/` 的空目录清扫（桌面的 `pruneEmptyQuarantines`）移动端没做**，理由：唯一会造出空目标的是 `quarantineSongFile` 的「建目录后崩」，而那条路径的重放**不查 `quarantineExists`**（只有 `quarantine_song_files` 查，且它的目标是被 rename 本身创建的），所以空目标只是不好看、不会让任何判定说谎。桌面清它是因为 `countQuarantined()` 会把它算成一次隔离——**N5 加徽章时要一起把这条补上**

**N2e 已完成（2026-08-19）——判据 13（gate）真机 18/18**（acceptance artifact，release）。`services/library.ts` 组装 `createLibraryService`，四件依赖**全部来自 `BootResult`**；`acceptance/library-contract.ts` 是第三个 hook，**`cases.ts` 一个字没动**（`services/contract/index.ts:6` 那句承诺兑现）。

- **`files` 也上提进 `BootResult`**：端口明写这一对要「作为调用方已经收到的那个 context 的字段」一起走，就是为了不让两处各造一份模块全局。第 ⑪ 步要它，服务层也要它——同一个 `fileOps` 的理由，同一句话
- **hook 的翻译层是三个里最短的**（没有 wire、没有退出码，直接握着 service），所以它也是**最敏感的那个**：一条用例在这里绿，等于在 service 本身上绿。**没映上的错误原样抛**，不塞成 `other`——`other` 一律算失败，抛出去至少带栈
- **每例一次完整启动序列**（18 次）。直接开库更快，也就不再测应用真正走的那条路了
- **两个变异逐条验红，第二个是这批真正的收获**：① 删掉 `requiredName` 的 `.trim()`（计划要求的破法）→ **红的正是两条 §7 F13 用例**，文案就是当年那个 bug：`a blank playlist name: expected a refusal, got a result`；② **从 hook 的映射表里删掉 `NotFoundError`** → 两条红（`一个用不上的 uuid` 与 `删歌之后再读`），报 `expected a ContractRefusal, got NotFoundError`——**证明那张四行表是承重的，而计划 §1.3 记的「v1 漏了 `NotFoundError`」正是漏掉它会怎样**
- **`cacheStatus` / `runEviction` 的选项定为 `NO_PLAYER_CACHE_OPTIONS`**（`limitBytes: 0` / `isExcluded: () => false` / `streamCount: () => 0`）：播放器归 N3、音频流归 N4，现在诚实地答「没有」而不是留一个到时候会安静作废的占位。缓存**功能**仍是 N4 的，这里只是因为契约的 cache 那一例是 N2 gate 的一部分
- CLI 那条 `it.skip('mobile hook — lands with the mobile app (N2)')` 换成了真断言（18 例），全仓 2603 → **2604**
- **三块旧面板复跑过**（`BootResult` 加了字段、boot 里 `files` 只造一次）：file-op 7/7 · fs 7/7 · D16 8/8

**N2f 前半（一）：排序落点 + 夹具导入通道（2026-08-19）**。`song-sort.ts` 整个搬进 `@lark/shared`（决策 n），桌面四个消费者改吃 `@lark/shared`，`stores/view-prefs.ts` 原地不动（zustand + localStorage 各端各留适配器）；测试跟着走，shared 79 → 90 / gui 443 → 432，全仓 **2604 不变**。真库副本（7 首 / 1 歌单 / 7 个目录）已经在手机上，启动判 `normal`。

- **Hermes 上 `Intl.Collator('zh-CN')` 是真的**（真机 3/3）：`安静 · 半岛铁盒 · 稻香 · 龙卷风` 是拼音序，而**码点序会是** `半岛铁盒 · 安静 · 稻香 · 龙卷风`。用例把两句都断言了——**没有 ICU 的 Hermes 不抛，它回落成码点序**，只断言「等于拼音序」的用例分不出「回落」和「没排」
- 🔴 **`adb push` 到 `/sdcard/Android/data/<pkg>/files/` 应用读不到**（两轮实测）：① push 会把中间目录建成 `shell` 所有，应用随后在 `Android/data` 就被挡住——可见性探针答 `0✓/Android✓/data✗/<pkg>✗/files✗`（对照：spike 那个目录是 `u0_a337`，应用自己建的）；② 光问 Android 要路径也不够——expo 的权限判定是对**路径本身**做 `File(path).canWrite()`（`FilePermissionService.kt`），不存在的目录不可写，于是「这个应用有权建的地方」被拒成 `Missing 'WRITE' permission`
- **所以 `modules/lark-fs` 破例长出第二个函数**（`externalDirectory(name)` = `getExternalFilesDir(null)` + `mkdirs`）。模块原本明写「deliberately one function」，这次是**实测逼出来的**而不是图方便：JS 既拿不到这个路径，也建不了这个目录，而 `getExternalFilesDir` 不是查询——**它以本应用的身份把地方建出来**，adb 之后才推得进去、应用才读得回来。`just mobile-push-fixture` 因此在目标不存在时**拒绝执行**并让人先点一次按钮，而不是自己 `mkdir` 出一个谁也打不开的目录
- **导入通道自己做两处身份改写**（决策 o「本次定死」的落地）：`install_id` 写成本机 committed 值、**删掉 `device_uuid`** 让第 ⑨ 步重铸。两条各验红一次：去掉前者 → 启动判 `converge`（判据 14 会变成在测 D16）；去掉后者 → `582fb1df… → 582fb1df…`，**手机继承了桌面的本机身份**（决策 j 说两台安装绝不能共享的那个值）
- **第二条反测先逼我修了断言**：原来那句「库里存的 uuid 等于 boot 返回的」**恒为真**——⑨ 是新铸的还是沿用桌面的都成立。改成在删之前先把桌面那个读出来带回，再断言两者不同

**N2f 后半（二）：四 tab + 曲库/歌单 UI（2026-08-19）——判据 14 / 15 真机 26/26**（`just mobile-accept-library`，生产 artifact）。`src/ui/` 七个文件：四 tab（歌曲｜歌单｜添加｜设置，D9）· 搜索 + 排序 · 行动作（改歌名/改歌手/固定/删除）· 歌单列表与详情（新建/改名/删除/加歌/移除）· 添加与设置的显式空态。**零新依赖**——没上 zustand，也没上手势栈（决策见 §8.3）。

- **判据 14 的排序是跨设备对照，不是自洽**：期望顺序由**主机**用同一份 `songs.db` + 同一个 `sortSongs` 算出来，手机屏幕上的顺序要逐首相同。面板做不到这件事，它只能证明手机跟自己一致
- **两条反测各点着该点的**：① UI 不再调 `sortSongs` → 歌名/时长/方向键/「控件不是死的」四条红；② 设置里的「曲库目录」计数改成常数 → **只有「目录跟着没了」那条红**（`0 个 → 0 个`），而「曲库少了一首」照绿——两个观测量确实是独立的
- **如实记一条口径限制**：这份曲库上 **歌手 与 创建时间 两个字段的升序恰好等于默认序**，所以它们的用例在变异下仍是绿的——它们证明的是「没排错」，不是「排了」。真正拦住「控件是死的」那条是 `distinct orders > 1`
- 🔴 **按 BACK 再回来，曲库打不开**（真机实测）：Activity 被销毁而进程还在，第二次 `runBootSequence` 报 `NativeDatabase.prepareSync … NullPointerException`。根因在 expo-sqlite 57.0.1：`OnDestroy` 想关掉缓存的数据库，**而 `removeAllCachedDatabases()` 返回的就是它刚清空的那个 list**，`forEach` 走了个空——留下一批原生已经没了的 JS 句柄。修法是 `bootOnce()`：**启动序列本来就是进程级的**（身份门、迁移、drain），因为一个屏幕重新挂载就再跑一遍，本身就是错的。验收仍直接调 `runBootSequence`（它的活就是反复从自选状态启动）
- 🔴 **`SafeAreaView` 在 Android 上是空操作**：标题直接画在状态栏上（截图可见）。加 `StatusBar.currentHeight` 的 padding
- 🔴 **驱动脚本的两处会安静地测错东西**（都直接观察到）：① `tap` 先滚到顶，**25 次滑动落在打开的 modal 背板上就把它关了**，之后报「找不到标签」，而在那之前的一整轮结果读的是背后那一屏——新增不滚动的 `tap-visible`，并把验收脚本的默认也改成它（按的全是固定控件或已在视野里的行，滚动从一开始就不该是默认）；② `tap` 是**子串匹配**，给设置页加了个「歌曲目录」之后，每一次 `tap "歌曲"` 都按在这个字段上、静静地留在设置页——改成**精确匹配优先、子串兜底**，并把字段改名成「曲库目录」。两条都进 `docs/LESSONS.md`
- **另加了一个 `dismissKeyboard()`（先问 `mInputShown` 再发 BACK，因为没有 IME 时的 BACK 会直接退出应用）**——但要如实说：促使我加它的那两次失败**后来查明是人在动手机**（用户以为跑完了就退出了应用），所以「IME 吃掉第一次点击」这条**没有被证实**。改动留着是因为它本身更稳，不是因为它修好了什么
- ⚠️ **26/26 是在同一份生产代码上跑出来的**（脚本随后只改了健壮性）；**修完驱动之后的完整复跑还没拿到**，几次尝试都被人为操作打断。下次上手先跑一遍 `just mobile-accept-library` 收口
- **`adb shell input text` 只能打 ASCII**（中文会从 `InputShellCommand.sendText` 抛 Java 栈）。所以搜索用的针**从夹具里选**——最长的、命中一部分而非全部的拉丁串（这次是 `LeoFM`，2/7）；中文搜索与 trim 那半由 LibraryContract 的用例在同一台手机上覆盖。`drive.mjs type` 现在自己拦下非 ASCII 并说清楚
- **「删歌带走目录」需要一个能从外面看见的观测量**：`songs/` 是应用私有的，adb 看不了，所以设置页多了「曲库目录 N 个」（真读磁盘）。这也正是判据 15 里「journal 已消费」的证据——`deleteSong` 返回前会 drain，目录还在就说明写下的效果没执行

**N2f 收尾：用户手测一轮，六处改动（2026-08-19，`4f5f442`）——N2f 完成**。手测比机器快，也看见了机器看不见的东西（六条里没有一条是判据能发现的）：

- **行的点击是播放，菜单是自己的按钮**（右侧 ⋮，44dp）。原来「点行出菜单」在手机上不是人预期的动作。播放器要到 N3，所以这一下现在**明说**「播放在 N3 开放」而不是没反应——吞掉点击的行会被当成坏了
- **图钉用桌面的图标和桌面的颜色**，位置在时长之后而不是歌名之前。颜色不是挑的：把桌面暗色主题的 `--state-pinned: oklch(0.72 0.16 255)` 换算成 `#59a6ff`；顺手把 `--state-active`（琥珀 `#efb146`）也放进 theme **留着不用**，N3 的播放行必须是那一个琥珀，不是那时候另挑的一个。图标栈因此引入 `react-native-svg@15.15.4`（照 Expo `bundledNativeModules`）+ `lucide-react-native@1.33.0`，桌面 `just check` / `just test` 复跑无回归
- **删歌要确认**（「删除《歌名》？」→「删除，连同它的文件」）。只有删除问，因为**其他动作都能反着做一遍**，而删歌带走音频、手机上没有撤销也没有回收站
- **取消要落在保存落的地方**：改歌名/改歌手的取消现在直接回列表，底下那层菜单一起关。回到菜单等于还要再点一次才能离开
- **歌单页不显示虚拟 `all`**。这是**这一屏的呈现选择**，不是跟库不一致——`listPlaylists()` 照旧把它放第一位（M6 的契约在服务层settled）；手机的「歌曲」tab 本来就是全部歌曲，再列一遍就是同一份东西出现两次，而桌面之所以列是因为它的曲库视图和歌单列表是两个地方
- **底部 tab 条被手势条压着**：Android 不给这个 inset（除非上 `react-native-safe-area-context`），先加 22px 底部留白
- **验收脚本跟着改了一处**：歌单页的标记从「全部歌曲」换成「新建歌单」，否则它会因为这次改动误报
- **清理**：删掉 `db/self-check.ts`（N2b 的数据层自检面板，N2f 之后没有任何调用者；它那六条判断已由桌面 `open-library.test.ts` 与 PROCESS 的 N2b 段留存）

**N2g 已完成（2026-08-20）——判据 20 / 21 绿，N2 全部完成**。两个模块 + 两份单测：`packages/shared/src/now-playing.ts`（`nowPlayingTitle` + `NowPlayingMode` + `isNowPlayingMode` + 64 code point 上限）与 `packages/core/src/portable/now-playing-mode.ts`（`local_metadata.now_playing_mode` 的读写，决策 c）。全仓 2604 → **2628**（shared 90 → 101、core 1179 → 1192）；portable 的 Metro 图 101 → **102 个模块**。**这批不需要手机**：判据 20 是纯函数、判据 21 是 `SqliteLike` 上的断言，而 **N2 本来就不断言任何蓝牙行为**（没有播放器、没有带屏接收端）。接线与开关归 N3。

- 🔴 **计划的「回落四条」落地成三个分支**：② `lyrics.length === 0` 与 ③ `currentLrcIndex === -1` **不是两个能各自杀死的判断**——空数组进 `currentLrcIndex` 只能回 -1（`lrc.ts:75` 的二分在 `high = -1` 时不进循环），写成两个 `if` 的话第二个是死代码，而判据 20 要求「删掉该分支那条必须红」对死代码不成立。实现因此收成一句 `const line: LrcLine | undefined = lyrics[currentLrcIndex(...)]`：**②③ 共用一个守卫、各留一条用例**（删掉守卫两条一起红）。这是子计划 §8 那条 P1-4 的同一个形状再走一格——**v1 五条 → v2 四条 → 落地三个分支**，每次都是「这两件事函数分不开」
- **五个变异逐条验红**（判据 20 的「每条都要有反测」）：① 删 `mode === 'title'` → 4 红 · ② 删 `line === undefined` 那半 → ②③ 两条红（`Cannot read properties of undefined (reading 'text')`）· ③ 删 `line.text === ''` 那半 → 间奏那条红（`expected '' to be '晴天'`）· ④ `[...text]` 换成 `text.split('')` → emoji 那条红 · ⑤ 上限整个拿掉 → 3 红
- **emoji 用例的那一个前缀是承重的**：`'🎵'.repeat(70)` 按 UTF-16 切在 64 上**正好落在代理对边界**，naive 实现照样绿。加一个 `あ` 把 naive 的切点顶到奇数单元，孤代理才出得来。断言顺序也跟着改——**孤代理那条排在长度之前**，否则长度先红，真正要证的那条永远不执行（同一个形状 N2f 的排序用例里也遇过：先红的断言会盖住后面的）
- **三个变异验红判据 21**：读路径顺手写回 → 六条「不改库」红 · 去掉 `isNowPlayingMode` → 八条红 · upsert 退回普通 INSERT → 「一行」那条红
- **为什么 config 那半在 portable 而不在 shared**：它要 `SqliteLike`。落 `local_metadata` 跟 `device_uuid` 同表同域（per-install 本地偏好），**写它不产 `sync_changes`**（有一条用例守着）；**读路径永不写库**——一个看不懂的值是「另一个版本的这台设备写的」，不是「可以覆盖的」，一个会「修好」自己读不懂的东西的启动路径，就是降级会吃掉设置的那条路

**N3 子计划已出（2026-08-20，v1 → v4，一轮反例评审收敛）**——`docs/plans/2026-08-20-phase-b-mobile-n3.md`，六批 N3a–N3f / 判据 25 条 / **决策 a–p 全部关闭**，修订对照在 §8。**评审逮到两条我的事实错误**：① `AudioStatus.error: string | null` 是存在的（`Audio.types.d.ts:243` + `AudioPlayer.kt:158` 的 `onPlayerError`）——v3 读到 `:215` 就停了，**从一个截断的阅读里断言了一个否定**，于是把「错误只能靠超时表达」写进了设计；② 桌面的 `player/queue.ts`（串行 + generation）是**零 import 的纯 TS**，v3 把它整条归进「不能共享」，等于让移动端没有竞态模型。

- 🔴 **锁屏/车机的「上一首 / 下一首」在钉版上不存在**：`AudioMediaSessionCallback.kt:27-31` 在 `onConnect` 里显式 remove 掉四个曲目导航命令。我又往下查了一步——`AudioControlsService.kt:374` 与 `:455` **两个 MediaSession 注册点用的是同一个 callback**，所以**换 `AudioPlaylist` 也救不了**（评审给的三个选项里第二个不成立）。**用户决定 v1 收窄**：锁屏只承诺播放/暂停/seek，切歌回 app 里；代价是蓝牙歌词开着时「车机上看得见歌词、方向盘上却切不了歌」，逃生口（改 Kotlin + 拦命令 + 桥接 JS + 维护补丁）定价后记在 §1.9
- **「抽五个纯函数」原本没有可抽的东西**：`next`/`prev`/`advanceAfterEnded` 调 `get()`、`ctx`、`ops.play`。v4 先定义 `QueueDecision`（`play`/`restart`/`stop`/`reject` + reason），**播放与提示归宿主**——这顺带解掉了 §2.4 说「静默拒绝」而决策 n 说「主动按键要出声」的两头话
- **四条判据本来是概率题**：shuffle（注入 `random`）· 蓝牙歌词「调用次数 ≈ 歌词行数」（漏了去重，真值是**相邻不同输出的段数**，改成与主机算出的期望值对照）· 「内存无单调增长」（删掉，几十秒内受 GC 干扰）· 音频焦点「测的时候再写成判据」（三条行为开工前冻结）。另有一条规则自相矛盾：「每格一个变异且**不能连带红**」与共享 helper 冲突——共享行为被改坏本来就该多条一起红，改成「每格要有一个**只属于它的**变异」
- **删歌之后队列收敛没有通道**：`library-context.tsx:62` 的 `changed()` 只 `setView`，React 之外没人收得到。取最小做法（`changed()` 顺带打一个可订阅信号，约 15 行），**不做通用 reconcile 协议**——N5 的同步删除到时候接同一个信号
- **N3b 因此是一个零手机的纯桌面批**（真机四模式从 N3b 移到 N3c，那里才有可驱动的生产 UI）

**N3a 已完成（2026-08-20，判据 1/2/3①④/3b/5）——播放内核**。`apps/mobile` 加 expo-audio **57.0.3**（与 spike 逐字节同版，hoist 之后全仓一份）+ 原生配置；`player/` 四个文件（session / driver / store / index）；`createOperationQueue` 从 gui 搬进 `@lark/shared`（决策 p）。全仓 2628 → **2642**（shared 101 → 106 与 gui 432 → 427 是搬迁的账，mobile 10 → 24 是新的竞态单测）。

- **判据 3b（gate）4/4，两个否定断言各自验红**：合并 manifest 里 `POST_NOTIFICATIONS` 在、`RECORD_AUDIO` 不在、播放前台服务已注册、录音服务未注册。写反测时发现第 4 条守的其实是**另一个选项**——`recordAudioAndroid` 管权限，录音服务由 `enableBackgroundRecording` 管（`withAudio.js:71`），两个各打开一次才各自点着。**「这是 recordAudioAndroid 的另一半」是一句读起来很顺的假话**
- **判据 3（gate）的原文和后台播放矛盾，跑的时候才撞上**：v4 初稿写「每条路径之后都看不到活跃播放器」，可开了后台播放，按 home、按 BACK 本来就该继续响。改成对**我们名下的活跃播放器数**断言：切歌恰好一个 · 显式停止零个 · BACK 继续播且仍是一个。**①④ 已绿**（连切三首每次都是 1；BACK 之后前台是 launcher 而播放继续，回前台 UI 上 `▶` 还在那一首——进程级单例扛住了 Activity 重建，`bootOnce` 同一条理由）；②③ 与判据 4 的设备那半需要 acceptance 夹具，随 N3c
- 🔴 **反测把 #47569 在我们自己的应用里复现了**：去掉 `destroy()` 里的 `pause()` → 切歌之后**两条 `state:started` 的 AudioTrack 同时在响**。所以 driver 的面**没有 `remove()` 可调**，只有一个 `destroy()`（pause → 300ms → clearLockScreenControls → remove），这不是纪律是结构
- **`AudioStatus.error` 存在，v3 计划里「错误只能靠超时」是错的**（评审逮到）：`Audio.types.d.ts:243` + `AudioPlayer.kt:158` 的 `onPlayerError`。load 因此是三个终态赛跑（loaded / error / watchdog），watchdog 只管「什么终态都没来」，坏文件不必白等 15 秒
- **竞态模型是两个机制，不是一个**：lane（串行，桌面搬来的 `createOperationQueue`）+ intent 计数（最后一次点击胜出）。**只有 `play` / `stop` claim intent**——让 `seek` 也 claim 会变成「拖进度条取消加载」，那是防竞态的机制自己造出来的竞态。五个变异里四个验红（去 lane · 去放弃机制 · 放弃时销毁「当前的」而不是「自己建的」· 让 seek claim），**第五个没红**：`toggle` 里的 `state.loading` 守卫在 lane 之下根本轮不到，是死代码，删了——**和 N2g 的回落 ②③ 同一个形状，一个批次之后又来一次**
- 🔴 **锁屏一开始只有歌名歌手，没有任何按钮**（用户手测报的）。一张下拉截图定案：**同屏正下方 bilibili 的通知有五个按钮**。根因两层——① expo-audio 只在 API ≤ 32 给通知 `addAction`，33+ 指望 System UI 从 MediaSession 画，而 OriginOS 把它当普通通知画；② **`pnpm patch` 改它的 Kotlin 默认无效**，SDK 57 的模块消费的是包内预编译 AAR，要 `expo.autolinking.buildFromSource` 才走源码。两条都进 `docs/LESSONS.md`。修完是**后退 10s ｜ 播放/暂停 ｜ 前进 10s** 三个按钮，用户手测可用
- **已知不做**：没有进度条、展开态按钮行居左（2026-08-20 用户决定）。居左是系统模板的排法不是我们的 bug——bilibili 的按钮起点与间距完全相同，只是数量填满了整行；要居中得给通知换自建 `RemoteViews`，代价见子计划 §1.9
- **判据 5 = 用户手测通过**（连续播放远超 5 分钟，含后台与锁屏）。**如实记口径差异**：没有按 §1.7 的协议做两侧采样，机器侧的证据只有「BACK 之后前台是 launcher、`dumpsys audio` 仍是 1」那一次

**N3b 已完成（2026-08-20，判据 6 gate / 7）——队列语义只写一遍**。`decideNext` + `QueueDecision` + UI 循环序进 `@lark/shared/play-queue.ts`；`local_metadata.play_mode` 进 `portable/play-mode.ts`（决策 g，照 `now-playing-mode.ts` 的形状）；桌面改吃。全仓 2642 → **2665**（shared 106 → 129、core 1192 → 1196）。**整批不需要手机。**

- **「抽五个纯函数」原本没有可抽的东西**（评审属实）：`next`/`prev`/`playAt`/`randomOther`/`advanceAfterEnded` 调 `get()`、`ctx`、`ops.play`。先定义**返回值**（`play` / `restart` / `stop` / `reject` + reason），桌面那五个函数体才塌成一个 20 行的翻译器 —— **`indexOfCurrent` 与 `playAt`、`randomOther` 被编译器报成没人用**，又是 N1h 那个「切面画对了的信号是一整段代码变成死代码」
- **这个返回值顺带解掉了计划里的两头话**：§2.4 写「静默拒绝」而决策 n 写「主动按键要出声」。纯函数只产出 `reject + reason`，**出不出声是宿主的事**——桌面照旧把 message 递给远程 ack 通道不显示，移动端 N3c 会 toast
- **两个 trigger 在两处分道扬镳，而这是照抄桌面而不是新设计**：① 当前歌不在队列里，`ended` → `stop`（桌面 `advanceAfterEnded` 调 `stopPlayback` 返回 ok:true），`next`/`prev` → `reject`（桌面返回 ok:false 带话）；② 邻居没有文件，同样分。**「手动 next 在 sequential 下 wrap 而自然放完不 wrap」也不是笔误**——`ops.next` 用 `%`，`advanceAfterEnded` 显式判末尾：按键是意图，放完不是
- **八个变异逐条验红，各有各的签名**（判据 6 的「每格要有一个只属于它的变异」）：sequential 末尾停 → 1 红 · repeat-one 提前返回 → 1 红 · shuffle 不排除当前 → 3 红 · shuffle 不过滤有无文件 → 1 红 · not-in-queue 不分 trigger → 3 红（全是 ended 那三条）· prev 也往前走 → 2 红 · `has_file !== false` 改成 `=== true` → 8 红 · shuffle 接管 prev → 1 红
- **shuffle 的 `random` 是注入的**（评审属实：概率测试会被反复重跑到绿为止）。两个确定性实现（永远取第一个 / 永远取最后一个）就把「随机另一首」和「恒定挑同一首」分开了
- **判据 7 绿**：gui **427 不变**，`player.test.ts` / `Controls.test.tsx` / `StatusBar.tsx` 只改 import 来源
- **范围修订：移动端 store 的队列与模式挪到 N3c**。它要三样 boot 之后才存在的东西（按 id 现读库、`sqlite`、库变更信号），而 `player/index.ts` 是 import 时就建好的进程级单例。在没有消费者的批次里先发明「boot 之后绑上去」的接口，是给一个还看不见形状的问题做设计

**N3c 已完成（2026-08-20）——minibar / 全屏页 / 队列面板，判据 8–15**。移动端 store 接上队列快照与模式、`LibraryService.readLyrics`（决策 h）、库变更信号（§2.8）、三个 UI 文件 + 一个共用进度条。全仓 2665 → **2684**（core +7、mobile 24 → 36）。**零新依赖**：进度条是 RN 自带的 `PanResponder`，全屏页是 `Modal`，队列面板复用 N2f 的 sheet。

- **判据 13（队列是快照）绿**：歌单起播 → 切「歌曲」tab → 排序改成时长 → 开面板，**第 2 / 4 首**与歌单顺序逐项不变。**判据 14 绿**：删队列里非当前的一首 → `第 2 / 6 首 → 第 2 / 5 首` 且它从列表消失、播放不受打扰；**删正在播的那首 → 活跃播放器 0、minibar 整个消失**（不滑到隔壁——删除不是一条关于「接下来播什么」的指令）
- **判据 8 的接线绿**（自然放完 → 自动下一首，用拖进度条到尾巴触发）；**四模式各一次的完整矩阵由判据 6 的纯函数单测承担**，真机这一条只验接线
- **判据 9/12 由用户多轮手测通过**，产出 **11 处改动**（下面两段）。⚠️ **判据 10 的「offset ± 写库并立即生效」当时根本没做**——全屏页只有模式键 / 上一首 / 播放 / 下一首 / 队列五个控件，这条记录写宽了（N3d 复核时发现，控件与验收都在 N3d 补上）。**判据 11**（琥珀播放行）截图确认。⚠️ **判据 15 的「点没有文件的歌」没验**——这个夹具库里没有 `has_file === false` 的歌；歌词三态里「无歌词」也没遇上（4 首都有歌词），**如实记着**
- 🔴 **`locationX` 是相对「被触摸的那个子视图」的，两次咬人**：① 点进度条**大概率跳回开头**——手指落在圆头或已填充那段上时，触摸目标是那个小 View，`locationX` 只有几像素，**越是精准点在当前位置越必然发生**；修法是子视图 `pointerEvents="none"`。② 修完之后**拖动起手一瞬间往前滑一截、然后跟位移而不是跟手指**——**症状本身指明了方向**：grant 的读数可信、move 的不可信。改成在 page 空间锚一次（grant 时 `pageX - locationX` 就是 track 左边缘，同步、不用 `measureInWindow`），之后每次 move 是 `pageX - origin`，不累加所以不漂。判据取「**拖到某个位置 = 点击那个位置**」，两条路给出逐字符相同的时间
- 🔴 **加了秒数显示，`uiautomator dump` 直接失败**（`could not get idle state` 且不写文件）——它要等窗口 idle，而走着的时钟永远不 idle。**症状是驱动脚本报「屏幕上没有这个标签」**，一个完全错误的诊断。`drive.mjs` 改成重试三次后说出真正原因。同一批还教会了它读 `content-desc`——播放器的传输键是图标，标签在 `accessibilityLabel` 里，**N2f 那条「控件一律带可见文字」是驱动器的局限不是设计原则**
- **两处百分比布局各错一次**：队列面板 6 首只画 2 行（`maxHeight: '70%'` 挂在一个自己没有高度的父节点上 → 改成算出来的像素）；大歌词不跟着滚（改成按 `onLayout` 实测每行 y——「行高 × 序号」在长行换行之后越往下偏得越多）
- **手测出来的其余几件**：队列开在歌词页**之上**而不是替换它（原来两个覆盖层共用一个状态所以互斥）· 歌词页滚动条常驻 · 队列面板里能换循环模式 · minibar 三排（歌名大一号 / 歌词居中且常驻占位 / 进度条可拖带圆头）· 歌单页的行也改成「点播放、⋮ 出菜单」
- **范围修订**：移动端 store 的队列与模式从 N3b 挪到本批（要 boot 之后才存在的三样东西：按 id 现读库、`sqlite`、库变更信号，而 `player/index.ts` 是 import 时就建好的进程级单例）

**N3d 已完成（2026-08-20）——蓝牙歌词接线 + 设置页开关，判据 16/17/18**。`apps/mobile/src/player/now-playing.ts`（订阅 → `nowPlayingTitle` → 去重 + 节流 → `updateLockScreenMetadata`，外加每首歌的计数）· store 加一个**同步且不进 lane** 的 `publishNowPlaying` · 设置页的开关与诊断行 · 主机侧期望值脚本 `spikes/mobile-foundation/scripts/now-playing-expect.mjs`（`just mobile-now-playing-expect`）。全仓 2684 → **2699**（mobile 36 → 51）。**顺带补上 N3c 漏掉的 offset ±。**

- **判据 16 绿**：开关默认**关**（缺行 → `'title'`）；打开后 `dumpsys media_session` 的 metadata TITLE **逐句跟着歌词走**——采样到的 27 次变化与主机同一份 `nowPlayingTitle` 算出的 27 段**逐项同序**；关掉**当场**变回歌名（`metadata: size=5 → 4`，album 槽一起清空）
- **判据 17 绿，跨设备对照**：设备 **34 次 · 最短间隔 4506 ms · 播放到 197.9s**，主机 `now-playing-expect ... 197.9` 算出 **34 次**。**期望值的可信度来自「五个 tick 相位扫描」**——同一首歌用 0/100/200/300/400ms 五个 tick 相位各算一遍，数一致才说明没有短于一个 tick 的段落、这个数才配拿去要求设备。真实曲库里 **7 首有 3 首被脚本拒收**（`东风志` / `同道殊途` / `莫问归期` 开头的「作词 / 作曲」半秒一行），**这条判据本来就有一半会变成概率题**
- **最短间隔 4506 ms 不是随便一个数**：这首歌最密的两句相隔 4.5s。节流的 500ms 在真实歌词上几乎永远不咬人——它防的是病态输入，不是常态
- **关开关那一下是在暂停状态验的**，正好打在设计上：暂停的播放器一个 tick 都不发，所以 `setMode` **绕过节流强发一次**；否则车机上会一直挂着最后那句歌词。这条判据本身就是那段代码的反测
- **判据 18（只记录不判定）：queue 陷阱的前提条件是成立的。** 我们的 session 是 `androidx.media3.session.id. com.orpheusaviary.lark/androidx.media3.session.id./571`，`queueTitle=null, **size=1**`、`active item id=0`——**队列非空**，正是 AOSP `MediaPlayerWrapper.isMetadataSynced()` 会去比对 queue item 与 metadata 的那个分支；而 expo-audio 建的是 `MediaItem.fromUri(uri)`（`AudioModule.kt:868`，**不带 title**），所以 queue item 的 title 永远不可能等于我们写进去的歌词行。**`CALLBACK_TIMEOUT_MS = 2000` 的触发条件齐了，有没有真的延迟——没有带屏接收端，测不了。**
- **歌名去 album 槽**：标题被歌词占用时 `albumTitle = 歌名`（间奏与关掉时不带，`MetadataInjectingPlayer.getMediaMetadata` 逐字段重建，省略即清空），落到手机通知上是 `setSubText`。**未实测**——没有接收端，写下来是因为它零成本且是歌名唯一能活下来的位置
- **offset ± 补上并验了**（全屏页歌词下方一行，0.5s 一步、与桌面同图标同步长；`lyrics_offset` 写库 → 库变更信号 → store → UI 与蓝牙标题一起动）。**验收撞上一个卡在刀刃上的例子**：暂停在 197.939s、那句歌词起点 195.42s，**offset 拨到 −2.5 时目标 195.439 比边界只大 0.019 秒，标题纹丝不动；再拨一格 −3.0 才翻到上一句**。两端用的是同一个 `currentLrcIndex(lines, time, 库里的 offset)`，这比「看着变了」强得多。屏幕上那个数字是**从 sqlite 读回来的**（`state.song` 来自库变更信号后的现读），所以它同时也是写库的证据
- 🔴 **`dumpsys media_session` 的 `PlaybackState.position` 只在状态变化时更新**，不是当前播放位置。采样脚本一开始拿它对时间轴，看起来「设备比主机快 3 秒」——其实读的是陈旧值。**标题的顺序可信，那个 position 不可信**；判据 17 的时间因此取自 app 自己的诊断行（计数与播放位置在同一帧里）
- **`mode` 每首歌重读一次库**（§2.5 原文），不是「读一次缓存到底」：今天只有开关会写它，但一次 prepared read 的代价换掉「万一别处写了呢」这个问题，是划算的

**N3e 已完成（2026-08-20）——蓝牙断连不转外放，判据 19（gate）/ 21；判据 20 按用户决定搁置**。新增 `apps/mobile/modules/lark-audio`（本仓第二个自建 Expo 原生模块）+ store 的显式 `pause()` + 在 `player/index.ts` import 时订阅。全仓 2699 → **2701**。

- **判据 19 绿（用户手测）**：耳机断开 → 音乐**暂停**、扬声器一声不出；耳机连回来 → **仍然停着**，不自动续播（恢复是用户的决定，与接完电话同一条原则）
- **反测不需要再装一个坏包**：N0b-4b 就是在这台机器、这个 expo-audio 版本上量到坏掉的形态的（旧 AudioTrack 转 `paused`、同时新起一个 `deviceId:3` = speaker 的 `started`），而那次测量发生在修法存在**之前**。**一个在修复前取得的失败测量，就是这条判据的反测**
- **暂停不在原生做**：模块收到广播只 `sendEvent` 就结束，暂停走 store。原生抄近路会多出一条「能停下播放而 store 不知道」的路径。JS 那一跳是微秒级，对上一次音频路由切换不构成风险
- **新加的是 `pause()` 不是复用 `toggle()`**：调用方是「耳机被拔出来了」，它**必须不能启动播放**——`toggle` 在暂停态会续播，也就是拔耳机把音乐**打开**。单测把 `pause` 换成 `toggle` 立刻红
- 🔴 **`ACTION_AUDIO_BECOMING_NOISY` 是受保护广播，模拟不了**：`adb shell am broadcast -a android.media.AUDIO_BECOMING_NOISY` 抛 SecurityException（shell 不是 system uid）。**这条判据没有干跑的办法，只有真的断开一次**
- **判据 21 记录完毕，结论是「原样留着」**：焦点请求是 `gain: GAIN_TRANSIENT`（`req=2`）· `flags: DELAY_OK` · `attr: usage=USAGE_UNKNOWN content=CONTENT_TYPE_MUSIC`，而实际播放的 AudioTrack 是 `usage=USAGE_MEDIA content=CONTENT_TYPE_UNKNOWN`——**两组属性确实不一致，N0b-4b 那条怀疑属实**；都由 expo-audio 自己发出（`AudioModule$$ExternalSyntheticLambda1`），我们没有插手的地方。决策 f 是「判据 20 全过就不动」，而 20 不测了，所以**没有行为证据支持去改它**：改焦点请求是拿一个更难查的病换一个还没出现的病
- **`GAIN_TRANSIENT` 有一个用户会感觉到的后果，写在这里等实际使用验证**：lark 抢焦点时是在告诉别的应用「我只是临时的」，所以别的播放器被打断后，**等 lark 停下来可能会自己接着放**。一个音乐播放器通常该请求完整的 `GAIN`
- **`EventsMap` 要 `type` 不能 `interface`**：`NativeModule<TEventsMap>` 的约束是 `Record<string, (...args:any[])=>void>`，而 interface 没有隐式索引签名——`error TS2344: Type 'LarkAudioEvents' does not satisfy the constraint 'EventsMap'`

**范围修订：判据 20（音频焦点行为表）搁置**（2026-08-20 用户决定，「属于是比较少见情况，之后实际使用过程中测」）。照判据 16b 的先例：**搁置的是验收，而这一条连实现都不是我们的**——焦点行为整个由 expo-audio 提供，lark 一行代码都没写，所以不存在「声明了但没验过」的实现面。不做的是那张三条行为表的逐条断言：来电 → 暂停且通话结束**不自动恢复** · 另一个应用开始播放 → 暂停不恢复 · 导航语音 → 压低音量后恢复。**代价一句话**：「来电时会不会暂停、通话完会不会自作主张续播」在 N3 没有证据，推给实际使用；判据 21 已经把当前的请求参数记下来，真撞上问题时从那里改起。

**N3f 已完成（2026-08-20）——进度记忆 + 收尾，判据 22（gate）/ 23 / 24 / 25，外加 3②③ / 4 / 5 的补跑。N3 整个里程碑到此结束。** 新增 `portable/last-playback.ts`（+ 22 条单测）· store 的 `restore` / `remember` / `play(…, startAt)` · `index.ts` 的 `AppState` 订阅与 restore-once 门 · acceptance 的 `playback.ts`。全仓 2701 → **2729**（core 1199 → 1221、mobile 53 → 59）。

- **判据 22 全绿**。① 前台播 3 分钟 → `am force-stop`（杀在 212.7s）→ 重开：同道殊途 · **3:00 / 7:50** · 暂停态 · 列表那行是琥珀。**恢复的位置正好 180.0 秒**——这个数本身就是 60 秒节拍的签名，暂停与进 background 都写不出整分钟，比单测的变异更硬。② 按播放**之前**：活跃播放器 0、我们的 media session 0、**没有 posted 的通知**（`dumpsys notification` 里只有 channel 定义）。③ 按下播放 → 182.6s，从 180 续上。④ ⏭ 去了**何以歌**——歌单的下一首，而不是「歌曲」tab 排序里的下一首（叹云兮），队列确实按存下来的 `source` 重建
- **判据 23 跑在桌面单测上**（22 条）：十四条失效用例逐条断言**「那一行原封不动」**。两条口径值得单记：`duration === 0` 的老库**不拿它当上界**（否则整个导入库的位置全被否掉），而**恰好等于 duration 视为放完**；歌单被删或被清空 → **队列退回整库、歌仍然恢复**
- **判据 24 绿**：27 秒内连切 30 次 → 活跃播放器**恰好 1**，media session 数**前后都是 2**
- **判据 25 绿**：跑完还能换歌、开全屏页、开队列面板（面板正确显示「第 3 / 3 首」）
- **判据 5 复跑绿**：熄屏后台**播放推进 360 秒零暂停**，主机侧全程 1 个活跃播放器。**这仍然只证明「不是一开始就断」**——耐久性（数小时）在 N3 依旧没有证据（决策 k）
- **判据 4 绿（acceptance 3/3）**：空文件 **410ms**、4KB 非音频 **343ms** 被 `status.error` 拒绝，而 watchdog 是 15000ms；不存在的 uri **3346ms**，**也是播放器结束的**不是 watchdog。**判据 3③ 绿**：三次失败加载之后活跃播放器 0
- **判据 3② 绿**：播放中把 lark 从后台任务里划掉 → 进程消失、活跃播放器 0、声音停了。**「显式停止」生产版原本没有入口**（`store.stop()` 零调用方，N3a 注释说的「unmounting the app」并不存在）→ 收尾时把「删掉正在播的那首」那条路改成调用 `stop()`：它本来就是 `stop` 的近似复制，只差没清 queue，而那是一个属于已经不存在的歌的 queue
- 🔴 **失败加载会漏一个 media session**：acceptance 三次失败之后留下三个 `ExpoAudioBasicMediaSession_<hash>`，`remove()` 收不掉；而生产版连切 30 次一个都没多。差别是生产版走 `setActiveForLockScreen` 用共享 session，没激活过的 player 拿的是自己那个 basic session。**只在错误路径上漏，而错误路径停死播放且不重试**，量级封顶——如实记着，不修
- 🔴 **`dumpsys notification` 里的 `orpheusaviary` 命中大多是 channel 定义不是通知**：断言「没有媒体通知」时按包名 grep 会得到 5 条命中然后误判。要看的是有没有 posted 的条目

**N4 子计划已出（2026-08-20，v1 → v2，一轮反例评审收敛）**——`docs/plans/2026-08-20-phase-b-mobile-n4.md`，七批 N4a–N4g / 判据 40 条 / **决策 a–p 待关闭**，修订对照在 §8。**用户同日拍板四条范围**：TLS 移出（见下）· LLM 设置页进 N4 · 收藏夹/合集批量进 N4 · 加 dataSync 前台服务。开工基线实测双绿：`just check` exit 0（含 `spike-media-test` 全段）、`just test` exit 0 / **2729 passed**。

- 🔴 **明文流是本批的头号未知**：N0b-4a 与 R1 在移动网络上拉到的 `*.mcdn.bilivideo.cn:8082`，两轮都跑在 **spike 的构建**上，而 spike 显式开了 `usesCleartextTraffic: true`（`spikes/mobile-foundation/app.config.ts:87`）；`apps/mobile` 没有这一行。如果那是 http URL，产品 release 会在 **4G 下每首歌都失败而 Wi-Fi 全绿**。判据 5 排在写任何 UI 之前，三条出路已定价（优先改选流规则去用 `backupUrl`，而不是放开明文）
- 🔴 **v1 把孤儿写去了 `recovered-songs/`，错的**：桌面崩溃孤儿进 `trashDir()/recovery-*`（`resolve.ts:456`），而 `recovered-songs/` 是远端删除抢救不可重建资产的地方、**会被 `/sync/status` 的 `quarantined_count` 数**（`paths.ts:106-115`）。照 v1 实现会在 N5 上线那天把同步隔离统计污染掉。同段还漏了 `skipSongIds: pendingFileOpSongIds(...)`——桌面 `boot.ts:399` 有，漏了它会让一次待重试的远端删除被清扫先搬走
- 🔴 **preflight 提取会静默改协议**：daemon 对「短链展开后仍是短链」答 **400 INVALID_SOURCE**（`routes/download.ts:87`），而 portable 的等价物 `resolveInput` 抛 `NormalizeFailedError` → **502**；`routes/download.test.ts` 里**短链用例一条都没有**，所以「路由测试原样绿」在这条上是空的。修法便宜：`resolveInput` **生产零调用方**，先补 characterization 钉住 400，再让它迁就
- **时长方案改成阶梯**：`MediaMetadataRetriever`（不碰音频焦点）→ 不达标退瞬时 player → **上游 `page.duration` 永远只做诊断**，用它兜底正好破坏端口「行按落地写」的不变量。顺带更正 `engine.ts:904` 的注释：重下**有** page 可引用（`probeSourceKey` 回的是完整 `NormalizedSource`）
- **前台服务起在用户手势那一刻**，不是任务入队那一刻——入队前还有一段网络预检，用户在这期间切后台就撞上 Android 12+ 的后台启动限制；`onTimeout` 要**停 queued + running 全部**；「被系统暂停」只在应用内可见（没有 `expo-notifications`）；**通知权限今天只在首播申请**（`player/session.ts:14`），先下载的用户看不到下载通知
- **进程级 download hub 必须和引擎同批出生**：`EngineCallbacks` 只在构造时给（`engine.ts:122-128`），没有动态订阅面
- **分享 intent 的消费点在根层**：`ui/shell.tsx:52` 是条件挂载而默认 tab 是「歌曲」，挂在添加页上冷启动**永远收不到**，而 payload 又是易失的

**范围修订：TLS（D15）移出 N4**（2026-08-20 用户决定，主计划 §4.3 已加 **Stage-3 修订**）——⚠️ **其中「硬阻塞 N5」已被 2026-08-25 的 Stage-4 修订推翻（见下面的 N5 段），本段留作历史**。准确口径：**不阻塞 N4 的任何子批**（下载链路不碰 skybridge），**硬阻塞 N5**——server 今天仍是 `http://<公网IP>:8443`，移动端 v1 是 https-only。N5 开工前必须补完 TLS（域名 + 证书 + 自动续期 + 反代 + 两端 `server_url` 迁移 + 真机连通），或单独决定移动端的明文口径。**不算被 N4 消掉**，见「后续」段的待办。

**决策 a–p 全部关闭**（2026-08-20 用户逐条过目「全部确认」，子计划 §5 是定案）。

**N4a 已完成（2026-08-20，纯桌面批，四个 commit）——判据 1–4 全过（1·3 是 gate）。桌面零行为变化，移动实现照冻结的端口写。** 全测试 2729 → **2736**（core 1221 → 1226、daemon 465 → 468；新增短链 characterization ×3、expectedDuration ×1、契约多出的 transfer ×3）。
- **preflight 提取**（`refactor(download)`）：`resolveOne`/`preflightSingle`/`preflightBatch`/`fetchList` 进 `portable/download/preflight.ts`，daemon 路由变薄壳（只剩请求体形状 + `naming_mode` 两条 INVALID_BODY + fetch-list 体读）。顺序照 §2.4 固定：**先补短链 characterization 钉住 400**（`routes/download.test.ts` 原来一条短链用例都没有，靠 `ctx.bilibili.expandShortLink` 打桩）→ 改 `resolveInput` 从 `NormalizeFailedError`(502) 改抛 `InvalidSourceError`(400)（生产零调用方，只动 `link.test.ts` 一条）→ 提取。错误码对照表逐条在路由测试里。
- **AudioLanding 签名冻结 + expectedDuration**（`feat(download)`）：端口加 `request: {url, headers, timeoutMs}`（原生下载用，与 `openStream` 二选一）+ 错误归一契约写进端口注释；client 加 `describeAudioRequest`（共用 `openAudio` 的 `headers()`）。`expectedDurationSeconds` 从 `resolved.source.pages[page-1].duration` 接线，新歌与重下**两条路都有值**（改掉 `engine.ts` 那条「重下没 page」的错注释）。
- **AudioLandingContract 八条 + 桌面 hook**（`test(download)`）：桌面原来手写的 5 条（commit 协议 + 两条 lifecycle）→ `portable/services/contract/audio-landing/`（纯 case + runner + hooks），加 3 条 transfer（非2xx→BilibiliApiError / 超时→中止failed / 取消→cancelled）。桌面 hook 用**真 client + 本地小 HTTP server**（`/ok` `/500` `/hang`）驱动，so `openAudio` 的真实归一在测。`audio-landing.test.ts` 整个换成跑契约。**N4b 加移动 hook，不碰 case**。
- **缓存运行时提取**（`refactor(cache)`，决策 g）：`EvictionScheduler` + `SongLeaseRegistry` + `canRedownload` 进 `portable/library/eviction-runtime.ts`，scheduler 改吃注入的 `EvictionRuntimeDeps`（不再吃 `AppContext`）。**关键是 `defer`**：桌面注入 `setImmediate`（延后宏任务的那条不变量，判据 4 的反测），手机将注入 `setTimeout(fn,0)`。daemon 留 `createEvictionScheduler(ctx)` 装配 + `isExcluded`/`readCacheStatus`/`canRedownload`(BaseContext 壳)，并 re-export 运行时（`new EvictionScheduler(ctx)` → `createEvictionScheduler(ctx)`，其余 import 路径不动）。Metro portable 模块 109。

**N4b 进行中（2026-08-20，用户定「集中开发集中测」——先把 N4b 代码写到能编译，再一次跑完真机判据 5–14；设备已连）。离线可写的先写，逐个给用户看 commit；Kotlin 与判据 5–14 攒到设备 session 一起。**
- **N4b-1 ✅ `3fb15ec`**：`apps/mobile/modules/lark-media`——MMR 时长探测（一个 `AsyncFunction readDurationSeconds`，照 lark-fs 模板）。TS 过、imports/biome 过；**Kotlin 只能真机 build 验**（judge 8）。
- **N4b-2 ✅ `9f3fc6c`**：`apps/mobile/src/ports/audio-landing.ts`（`createMobileAudioLanding`）。**落盘反桌面序（decision c）：② 非 AAC 拒绝 → ③ 原生下载到 `.download.<taskId>.tmp` → ④ MMR 读时长 → ⑤ commit 行 + touchLastAccessed 一个事务 → ⑥ 原子替换**，不做 manifest（崩在 ⑤⑥ 之间自愈）。非 AAC 拒绝 = **`AudioNotAacError` → 任务码 `AUDIO_NOT_AAC`**（非 CodedError，`describeTaskError` 映射，只进 `TASK_ERROR_CODES`——daemon 转码永不产它，**首个纯 task-only 码**）。transfer 是缝（默认 `File.downloadFileAsync`：非 2xx→reject、abort→AbortError、Android 直接流进目标文件失败留半个）；错误归一在 land（abort 原样传、其余非 abort→BilibiliApiError）。shared 129 / core 1226 / cli 9 / errors 66 全绿。
- **N4b-3 ✅ `7ef6935`**：启动清扫 ⑪b（`boot/sweep.ts`）+ trash 命名空间。桌面七形态在这里塌成**三条规则**（没有 manifest，决策 c）：① journal 还认领的 song id 一律不碰（`skipSongIds: pendingFileOpSongIds`）② `.…tmp` 残留删掉（复用 `sweepWriteResidue`）③ 无行的目录：有音频 → `trash/recovery-<ts>-<rand>/<id>/`，什么都没有 → 删。**⑪ → ⑪b → ⑫ 写进 `sequence.ts` 那份「不许移动的排序」清单**（对 N2 §2.2 冻结段落的显式修订）；`BootResult` 多 `swept`。acceptance `sweep.ts` 六条场景（判据 11 的盘上状态那半 · 12 · 13），**判据 13 的反测是能跑的场景**（同夹具不传 skip set → 目录必须被搬走）。
- **N4b-4 ✅ `0ab57f4`**：`downloads/{engine,hub}.ts`。hub = 进程级 external store（照 player 的形状），**必须与引擎同批出生**（`EngineCallbacks` 只在构造时给）；`downloadRuntimeOnce` 是第三处「每进程一次」（Activity 重建会让 `App` 重挂，两个引擎 = 两个队列两本 registry）。**长命 `FileEffectRuntime` 用 `claims: engine.claims` 重建并交给 `createLibrary(boot, fileOps)`**（boot 那本只管 drain，drain 完退役——桌面同形）。`audioStream` 移动端 15 分钟（仍是整条传输 deadline 不是停滞计时）；`getLlmConfig` 诚实空（`NO_LLM_CONFIG`，照 `NO_PLAYER_CACHE_OPTIONS` 先例，真配置在 N4e）。
- **N4b-5 ✅ `8e3cfc0`**：契约移动 hook（`acceptance/audio-landing.ts`）+ 音频夹具通道 + 判据 7/8 场景。🔴 **契约第一次跑就证伪了 N4b-2**：`land` 的 ⑤ 提交事务没有 try/catch，commit 抛出时 tmp 与新歌目录都留着，而契约 2/3 例断言「什么都不许剩」「整个目录要没」——桌面 `landSongFile` 从 M3-7 就有 `rollback`，移动端这一半从没写。已修成 `discard()`（tmp + `mode==='new'` 连目录），三条失败路径共用，提交失败包成**同一个 `DownloadCommitError`**；`land` 复杂度 32 → 19。夹具：`just mobile-push-audio-fixtures` 推 N0b 两条曲目 + **ffprobe 真值由主机 core 的 `probeAudio` 产**（short 实测 136.835215s），manifest 带 `bvid`。**`app.config.ts` 不用改——`INTERNET` 已在生成的 merged manifest 里（Expo 模板给的）**，判据 16 的这一半现在就是绿的。
- **N4b-6 ✅ `67cebed`**：`acceptance/downloads.ts`——判据 5（两行：scheme 是不是 https · 产品构建能不能真读到字节，**每次运行先清 `probed` 缓存**，因为要两张网各跑一遍）· 判据 6（真 bilibili 视频 → 落库落盘，**等任务走 hub 不轮询引擎**，callback 没接就会挂住 = 正确答案）· 判据 14（claims 共享 + 反测场景）。三条决定如实记：**判据 14 用「直接在 `engine.claims` 取 claim」代替「真下载中途删」**（验的是接线：library 的 runtime 用的是不是引擎那本 registry；真下载取的是同一本里的同一个 claim，但要多一张网一条流一个计时窗口）· **判据 6 的 ±1s 对照的是「桌面 ffprobe 读同一个分 P」不是同一个文件**（release 构建 app 私有目录 `adb pull` 不出来）· **下载套件跑完不 `resetInstall()`**（唯一一个，判据 6 的产物就是那首歌，装回 release 构建按播放 = 「能播」那条）。
- **N4b 设备 session（2026-08-21，V2408A，acceptance release 构建，我驱动）——判据 5 · 6 · 7 · 8 · 10 · 11（盘上状态那半）· 12 · 13 · 14 全绿。** 三套面板：downloads **5/5** · landing **13/13** · sweep **6/6**。
  - 🟢 **判据 5（硬 gate）答案：不是明文。** 移动数据（电信 5G，`NOT_VPN`，默认网络已 `dumpsys connectivity` 核过）上 playurl 派的是 **`https://xy220x202x9x156xy.mcdn.bilivideo.cn:8082`**（`mp4a.40.2` / isAac），产品构建 range 请求回 **206 · `application/octet-stream` · `content-range bytes 0-1023/3690190`**。**§1.3 的三条出路一条都不用走**——不改选流规则、不加域名白名单、更不碰 `usesCleartextTraffic`；N0b-4a/N1i 那两轮成功不是 spike 的明文开关给的。**Wi-Fi 那一遍也绿**（`https://cn-bj-cc-03-03.bilivideo.com`，206 · `video/mp4` · 同一个 `content-range …/3690190`）——**两张网都是 https，判据 5 完全关闭**；顺带复现 N0b-4a 那条「content-type 按节点不同」（mcdn 是 `application/octet-stream`，cc 节点是 `video/mp4`），**任何按 content-type 判断是不是音频的新代码都会错**。
  - 🟢 **判据 6**：`莫愁乡--（OfficialMusicVideo）亚细亚旷世奇才` · **136.836s vs 桌面 ffprobe 136.835215s = Δ0.001s** · `file_origin=downloaded` · `source_key=BV176M3zPEZu:30584670526` · **lyrics 任务 succeeded / 1452 字符 lrc**。**「能播」已验**：装回产品 release 构建，曲库里就是它（`1 首 · 亚细亚旷世奇才 · 2:17`），按播放后 `dumpsys audio` 有 **1 个 `state:started` 的 AudioTrack**（`usage=USAGE_MEDIA` / 44100Hz / 2ch，与夹具的 44.1kHz 2ch 对上）+ media3 session 已注册；`uiautomator dump` 当场报 `could not get idle state`，正是「播放中窗口永不 idle」那条已知症状。
  - 🟢 **判据 8**：long **Δ0.000s**（2226.646s）· short **Δ0.001s**。**决策 b 的 A（MMR）成立，不用退 B。**
  - **三个真问题（都已修 + 进 LESSONS）**：① **`lark-media` 少 `android/build.gradle`**，autolink 静默跳过 → 一启动就 `Cannot find native module 'LarkMedia'` 闪退（tsc/biome/bundle smoke 全照不到）→ 补文件 + 新守卫 `scripts/check-mobile-native-modules.sh` 进 `just check`（反测会红）；② 🔴 **MMR 读得出时长 ≠ 文件完整**——fMP4 的 `moov` 在文件头，3.7MB 曲目的前 64KB 读回来是完整 136.8 秒，截断的下载会被提交成歌 → **落盘加 ③b 完整性检查**（落地字节 < 源声明的 total 就当传输失败；计划 §2.3 已记这条修订，实测原生下载 `native progress ×8 last 3690190/3690190`，**守卫在生产上是上了膛的**）；③ 合成 signal 在 `abort` 监听器里同步读 `reason` 是 `undefined`（一个微任务后才是 `AbortError`）——**我一度用「timeout 场景一律算超时」把它改绿，那是买绿**，已改回严格判别并把归不了类的错原样报出来，一轮定位真因。
  - **一条诊断自己错过**：`task.total_bytes` 在终态任务上恒为 `null`，因为引擎每次 stage 变化都 `#resetProgress`，而落盘传输后会 `reportStage('saving')`——它说明不了 ③b 有没有 total 可比。改成报原生下载器实际回调的数。
- **判据 9 与判据 11 的真崩溃点已补完（同一次 session 收尾，用户 2026-08-21 决定放 N4b）**：
  - 🟢 **判据 9**：一边放 short 夹具、一边用 MMR 读 **long（37 分钟）**那条 —— `read 2226.646s in 22ms · 0.8s → 1.7s · never stopped`，主机在**同一刻**数到**恰好 1 个 `state:started` 的 AudioTrack**。**MMR 不碰音频焦点这条从「文档这么写」变成实测。** 场景是两个按钮（arm 停在还在放的状态 / stop 收），因为「系统握着几个 AudioTrack」不是 JS 看得见的事；arm **不开库**，不该为一个跟曲库无关的问题清掉别人的行。
  - 🟢 **判据 11 的真崩溃点**：`createMobileAudioLanding` 加 `crashPoint`（⑤ 与 ⑥ 之间，**park 而不是抛**——抛会展开栈，SIGKILL 不会），arm → `am force-stop` → 重启 → `row still says 136.836s · no canonical file（读作「需要下载」）· .tmp swept · directory kept`，逐字对上崩溃状态表「⑤ 之后 ⑥ 之前（new）」那一行。
  - **判据 11 的反测（不做启动清扫 → `.tmp` 必须还在）没有运行时开关**，如实记着：这条断言只有 ⑪b 跑过才可能成立，而 skip set 那条反测在 sweep 套件里是能跑的。
**N4c 完成（2026-08-21）——判据 15–19 + 41–43 全关（18 只有单测，如实记）。三批 N4c-1/2/3，决策 a–j 全关。**
- **N4c-1 = `modules/lark-transfer`**（dataSync 前台服务：Kotlin service + 通知渠道 + `onTimeout` + 模块自带 manifest）+ `acceptance/foreground.ts`（长曲下载入口与反测）+ **acceptance 面板改成数据驱动列表**（17 个手写 Pressable → `SUITES` 表，复杂度 23 → 过；顺带去掉「运行时把按钮标签改成 Running…」，`drive.mjs` 按标签找按钮，改名会让它第二次按不中）。
- 🟢 **判据 16（merged manifest）**：`FOREGROUND_SERVICE` · **`FOREGROUND_SERVICE_DATA_SYNC`**（**模块自带 `AndroidManifest.xml` 合并进来了——§1.4 那条「不写第四个 config 插件」的路走通**）· `INTERNET` · `LarkTransferService` 的 `foregroundServiceType="dataSync"`，而 expo-audio 的 `AudioControlsService` 仍是 `mediaPlayback`。服务实测起得来：`isForeground=true` · `types=0x00000001` · 通知在 `lark.downloads` 渠道。
- 🔴 **判据 15 当场改写（原文两侧都绿，什么也没证明）**：原判据是「熄屏 4 分半下完 54.3MB」——**带服务与不带服务都逐字节下完**（`landed 54273999 of 54273999` ×2）。4 分半、内存宽裕、刚离开前台时 Android 根本不回收这个进程，**熄屏时长不是区分变量**。改成 **应用切后台 + `adb shell am kill`**（只杀「可以安全杀掉的」进程，**豁免持有前台服务的**）：不带服务 `pidof` **为空**，带服务 **pid 11213 存活**并在熄屏 3 分钟后 `task succeeded · 54273999/54273999 · 2226.646s`。子计划 §4 判据 15 已改写并附原文。
- ✅ **§1.6 答掉、决策 j 关闭**：熄屏下 `File.downloadFileAsync` 的传输照走（原生线程，chunk 不等 JS），**不加 wake lock**。
- **路上两个真 bug**：① 🔴 **Expo `AsyncFunction` 的最后一个表达式就是返回值**——`startForegroundService` 回 `ComponentName`，桥转不了，JS 拿到 `has been rejected. → Unknown type: class android.content.ComponentName`，**而服务其实已经起来了**；副作用型的 AsyncFunction 末尾要显式 `Unit`。② 长曲 BV1LtgV6ZE2U **有 2 个分 P**，链接不带 `?p=1` 会撞多 P 的 LLM 门（`LlmNotConfiguredError`）——**这是 N4a 提取的那条判断在设备上正确生效**，顺带把判据 28 的一半提前验了。
- **我自己的一条操作教训**：第一次 tap 完 arm 就直接看 `dumpsys`、看到服务在就熄屏等了四分半——服务在只是上面①的副作用，**下载根本没入队**。每一步的绿都要自己读过，不能靠旁证推断。
- **N4c-2 = `downloads/foreground.ts` 状态机**（全离线，测试 2759）：`arm` / `settle` / `handleTimeout` 三个入口 + 注入四样（service · hub 的 subscribe/getState · engine 的 snapshot/cancel · now/delay），降级态与 phase 存进 hub（决策 e），`engine.ts` 装配控制器并把 `onTimeout` 接上，通知权限走 `ensureAudioSession()`（决策 g）。**22 条单测**。
- 🟢 **判据 18 全绿（单测）**：`onTimeout` → **queued 与 running 一起取消** → `stop()`，且**取消在 stop 之前**，phase 置 `paused-by-system`。**6 小时配额没有真机证据，如实记「有代码路径、有单测、没有真机证据」。**
- 🟢 **判据 17 的逻辑半边全绿**：①手势那一刻就 `start`（此时零入队）· ②活动归零 **2 秒后**才停（1999ms 不停）· ③起不来照常下完、`degraded` 在 hub 里读得到且不碰任何任务。剩下的一半是 Android 在说话，留给 N4c-3。
- **v1 状态机有两个「没有触发源」的洞，都当场补上并记进子计划 §8**：① **`arming → idle` 那条边**——「预检后零入队」恰恰是没有 hub 事件，于是控制面是 `arm()` + `settle()` 两个调用（后者在调用方 `finally` 里）；② **`paused-by-system` 没有出边**——冻结的图只冻自动边，再点一次下载是用户的决定，配额真没了会落进 `degraded`。另有六条修订（`degraded` 归零也调 `stop()`、降级态带 `reason`、先置 phase 再取消、queued 先于 running、通知标题/正文分工、去重与节流分开测）。
- 🔴 **一条自己踩的假绿**：去重与节流并成一条断言时，**实现里完全没有去重也照样绿**——节流自己把重复的丢掉了。拆成两条、各自反测点着之后才算数。**八条反测逐条跑过**，列在 `foreground.test.ts` 文件头。
- **顺带的真实变化**：`downloads/engine.ts` 现在 import `modules/lark-transfer`，**生产 bundle 启动时就 `requireNativeModule('LarkTransfer')`**（此前只有 acceptance 构建碰它）——判据 20 后半句想要的正是这个性质。
- **N4c-3 = 真机验收**（子计划 §9 有逐条对照表）：acceptance 面板加六个入口（三态观测 · 降级态注入 · 后台 arm 的 arm/check 一对 · 停两次 · 两个服务的 arm/stop 一对），`DownloadRuntimeDeps` 加 `service` 注入缝。**判据 17 · 19 · 41 · 42 · 43 全关**，每条都是「应用自述 + 主机独立核对」两侧。（**本批新增的三条编号从 41 起**——N4 主计划把 20–25 给了 N4d，子计划再用一次 20–22 会让同一个里程碑里的「判据 22」指两件事。）
- 🟢 **17①②**：服务在**手势那一刻**起来（`phase arming · 0 active tasks`，主机 t+2s 见到 `isForeground=true · types=0x00000001 · 渠道 lark.downloads · importance=2`），25 秒**什么也没入队**的停泊期里一直在；活动归零 **+1.0s 还在、+3.5s 已停**，主机在 t+30s 看到它消失。**17③** 注入拒绝：`degraded / ERR_LARK_FGS_NOT_ALLOWED`，下载照样成功，且**没有对着不存在的服务说 update**。
- 🟢 **42**：服务 t+0 起、t+7 停，连停两次不抛，收尾时本包通知数 **0**。🟢 **43**：两个服务共存 **~45 秒**（`AudioControlsService` + `LarkTransferService`），t+21s **两条通知都在**，其间 `state:started` 的 AudioTrack 恒为 1，停下载不影响播放。🟢 **41**：守卫绿 + **生产包装机后正常启动**（启动即 `requireNativeModule('LarkTransfer')`，没抛）。
- 🟢 **19**：`pm clear` 后 `granted=false` → 点下载（**全程未播放**）→ 3 秒内 `granted=true`、服务在、通知在 `lark.downloads`。**反测**：`pm revoke` 后服务照起（t+3s、t+15s 都在）、**通知一条都没有**。（**对话框本身没截到**——这台机器三秒内就 granted 且带 `USER_SET`，是它代答还是弹了没抓到无证据；要证的「申请发生在下载路径上」成立。）
- 🔴 **反测答出第三种行为，并且改了代码**：**后台的 `startForegroundService()` 在这台机器上既不抛也不起——被延后到应用回前台**（后台窗口 16 秒 · 0.4 秒一采 · 一次没见到；回前台立刻出现）。① 对设计：反测比预想的更硬，「入队时刻起服务」= 整个下载期间毫无保护。② 对代码：`start()` resolve 只等于「系统收下了请求」，状态机原本只认抛异常，**这一整类下判据 17③ 的「降级态可读」是假的** → 加 `START_CONFIRM_MS`（start 成功后 2 秒回头确认一次，不 await、只降不升，落 `ERR_LARK_FGS_NEVER_STARTED`），带 generation 与 phase 两道守卫，单测 5 条 + 反测 3 条。**产品线够不到这条路径**（arm 永远由手势触发）。
- 🔴 **反测的第一版是错的**：用 `await wait(10_000)` 安排「后台 10 秒后 arm」——后台 JS 定时器冻结，那句 wait 到回前台才到期，arm 其实发生在前台，**得到一个看起来成立的反面结论**。改用 `AppState` 的 `change` 回调才测到真东西。
- **三条采样陷阱**（已进 `docs/LESSONS.md`）：**前台服务通知有约 10 秒延后**（前 10 秒 `dumpsys notification` 查不到，会误判成「服务在但通知没了」）· **`pm revoke` 会杀进程**、**`pm clear` 连外部夹具目录一起清** · **已在库里的曲目会把「长下载」变成 4 秒**（判据 22 第一次只共存 4 秒，验过程要先清库）。
- **本批不证明的**：6 小时配额（判据 18 只有单测）· 判据 43 量到的是「传输服务自己退场」而不是「取消进行中的下载」（长曲 45 秒自己下完了，对主张等价但记着差别）。
- **N4d 开工**（添加页 v1 + 任务列表 + 分享 intent）：子计划 `docs/plans/2026-08-21-phase-b-mobile-n4d.md`（三批 N4d-1–3 / 判据 20–25 + 新增 44·45）。**决策 a–j 于 2026-08-23 全部按倾向关闭，§5 是定案**。N4c 留给它的两件是 **`arm()`/`settle()` 接到提交按钮**（N4 决策 f）与 **hub 里的 `foreground` 渲染成降级提示**（N4 决策 e）。

#### N4d-1（2026-08-23）依赖与地基 —— 桌面全绿，设备那一步待跑

- **决策 a 落地：三张中文标签表提升进 `@lark/shared`**（新 `download-labels.ts`）。GUI 那份删掉、两个 importer 改成 `@lark/shared`；CLI `wait.ts` 的 `STAGE_TEXT` 拷贝删掉、改读 `STAGE_LABELS`（`stage === null → '排队中'` 留在 CLI，那是它的渲染口径不是枚举的）。**文案一个字没改**，`progressLabel` 从私有改成导出（手机要同一条进度短语）。**新增 17 条测试**——两份拷贝原本都没有测试，而「加一个 stage 会红」正是提升的理由。
- **决策 k + f 落地：`portable/naming-mode.ts`**。与 `play-mode` / `now-playing-mode` 同族（`local_metadata` 一个键、读路径永不写库、值域外读成默认并 warn），**但读与默认拆成两个函数**：`readNamingMode` 回 `DownloadNamingMode | null`（`null` = 从没选过），默认由 `resolveNamingMode({ remembered, hasLlm })` 决定——`clean` 在没有模型的装机上不是偏好而是一堵墙，所以默认不能是常量。**记住的值永远优先**，包括「记着 clean 但模型没了」（chip 会 disabled 并说明原因，替用户改选择比一个带理由的灰按钮更糟）。**17 条测试**。
- **决策 d 落地 + 判据 23 的逻辑半边：`downloads/cancel.ts`**。取消的三种结果（`cancelled` / `refused` / `already-done`）各自作答，「全部取消」是 N 个答案不是一个。**与 `handleTimeout` 共用的是口径与顺序**（`isActive` + `activeInSweepOrder`，queued 先于 running），**错误策略两边各留各的**：系统收权那条对无法解释的错误照旧向上抛（N4c 的断言原样保留），用户点取消那条把 `TASK_NOT_FOUND` 读成「已经结束了」——id 来自这块屏幕刚渲染的列表，它消失只可能是终态后被 ring 滚掉。**14 条测试**，含「一条过了落盘点不能让另外两条报失败」与「不能整批报成功」。
- **`downloads/use-downloads.ts`**（hub 的 `useSyncExternalStore` hook，无 selector 参数——selector 的返回值会被 `Object.is` 比较，正是 hub 特意避开的无限重渲染）+ **`ui/task-list.tsx`**（决策 c：直接渲染引擎自己的 ring，进行中在上、终态最近 20 条；降级/配额两条提示；失败行显示 `error_message` 原文）。**接进了占位的 AddTab**，否则这一批的东西在设备上看不见——粘贴框仍是 N4d-2。
- 🟢 **§1.6 的 `singleTask` 风险在主机上就答完了，不成立**：两次 prebuild 对拍（插件整块摘掉一次、装回去一次，diff 生成的 `AndroidManifest.xml`）——**插件的全部改动是一个 `<intent-filter>`**（ACTION_SEND + `text/*` + DEFAULT），别的一个字没动。`launchMode="singleTask"` **本来就是 Expo SDK 57 模板的默认值**，插件的 `withAndroidMainActivityAttributes.js:32` 只是把同一个值又写了一遍。**任务栈语义从 N2 起没变过**，`bootOnce` 与 N3 的所有真机 session 一直在它下面跑。判据 44 因此收窄成「新依赖没把构建和启动搞坏」，仍要在设备上走三条路径。D16 的两条 backup 属性在 prebuild 后仍是我们自己的 xml（`with-backup-rules` 没抛）。
- **桌面基线**：`just check` exit 0（八条守卫 + 两个 bundle smoke）· `just test` exit 0 / **2812 passed**（shared 146 · core 1243 · mobile 100 · cli 428+9 skipped · daemon 468 · gui 427）· `just mobile-typecheck` exit 0。依赖变动（`expo-share-intent@8.0.1` + `expo-linking@57.0.6`）后的常驻规矩已复跑。
- 🟢 **判据 44 全绿**（2026-08-23 真机，冻结设备 vivo V2408A，release 装机）：**冷启动**前台是 `.MainActivity`、pid 存活、logcat 无 FATAL · **按 BACK 退出再打开**——进程号不变（25875）而 ActivityRecord 与 task 都换了（`2ca8b91/t18922` → `401cd6e/t18923`），**即 Activity 真的被销毁重建了**，正是 N2 那个 expo-sqlite 陷阱的原地，`bootOnce` 顶住，无 `NullPointerException` / `prepareSync` · **去设置再切回来**同一个 ActivityRecord（`401cd6e`），`singleTask` 只有一个实例。装好的 APK 上另外两条也核过：**系统的 ACTION_SEND 解析器已经列出 `com.orpheusaviary.lark.MainActivity`**（判据 22 的前置成立），`FOREGROUND_SERVICE_DATA_SYNC` 仍在（N4c 的模块自带 manifest 没被新插件挤掉）。任务列表这块新屏幕在 release 下渲染正常（空态「还没有下载任务」；无活动任务时不出「全部取消」，`phase=idle` 时不出降级条）。

#### N4d-2（2026-08-23）添加页 v1 —— 桌面全绿，五条判据等设备

- **`ui/add-tab.tsx` 落地 §2.2 的状态机**：粘贴框（400ms 去抖，决策 g）→ 离线 parse → 命名 chip（`clean` 无模型时 disabled 并写明原因，决策 f）→ 目标（默认「仅曲库」+ `Sheet` 选已有歌单，决策 b）→ 提交 → 清空回任务列表。**shell 的占位 AddTab 删掉**，四个 tab 现在都真的做事。
- **`downloads/preflight.ts` 是 portable 的薄壳**：`recognise`（离线 parse + 至多一次短链跳，`onResolving` 在跳之前同步触发 = 判据 21 的落点）+ `submitDownload`（`arm()` → `preflightSingle` → `enqueue` → `finally settle()`，N4c 决策 f 留下的最后一处接线）。
- 🔴 **加了一层计划里没有、但判据 22 没有它就过不去的东西：`findSource`**。N0b-4c 实测的分享原文是**标题和短链在同一行**（`EXTRA_TITLE` 为空），整行读作自由文本 → keyword → 撞 LLM 门，于是**手机上最可能的那种输入会被拒绝，「正在解析」从一次真实分享里永远到不了**。只在整行读作 keyword 时启动，每个候选原样过 `parseSongInput`（结构检查一条不少），第一个可用的胜出；解析成 URL 却被拒的那个会被记下来，因为「youtube 不是 B 站链接」比「关键词搜索需要配置 LLM」说明得多。详见子计划 §8.2-1。
- **三处顺带修正**：提交不再重复展开短链（`recognise` 交回的已经是展开后的 item）· **引擎与预检共享一个 `BilibiliClient`**（此前是两个匿名 buvid + 两份 WBI 缓存）· keyword 的拒绝语**由 portable 现说不抄**（真的调一次 `preflightSingle`，零网络），唯一自己写的句子是收藏夹/合集那条——portable 那句点名了手机上不存在的两个 HTTP 路由。
- **18 条新单测**（判据 21 · 25 的逻辑半边 + arm/settle 的括号），**三条反测逐条跑过、都红在该红的那条**：`onResolving` 挪到 hop 之后 → 判据 21 那条红 · 拿掉 `findSource` → 分享文本三条红 · `settle` 移出 `finally` → 两条红。
- **桌面基线**：`just check` exit 0 · `just test` exit 0 / **2830 passed**（mobile 118）· `mobile-typecheck` exit 0。
- 🟢 **判据 20 · 21 · 23 · 25 全绿**（2026-08-23 真机 session，冻结设备 vivo V2408A，release，5G）：
  - **20**：粘 `b23.tv` 短链 → 预览 `BV176M3zPEZu`「短链已展开 · 第 1 P」→ 提交 → 下载 + 派生歌词两条任务 → **歌曲 tab 有它、2:17、无「需要下载」标记、曲库目录 1 个**。长曲那条另测：54MB 约 6 秒下完，**时长 37:07** 说明整文件落盘（N4b 的 ③b 完整性检查过）。**一条如实记的：进度没采到**——传输比第一次采样还快完成，进度是在判据 23 的长曲上看到的（`下载音频`）。
  - **21**：screencap 连拍抓到瞬态——**spinner + 「正在解析短链…」**，此时提交按钮仍禁用；随后落到真实 bvid。（`uiautomator dump` 一次约 700ms，比「去抖 + 一跳」还慢，抓不到。）
  - **23**：长曲重下、在 `下载音频` 阶段点取消 → 回答「已取消《…》」、任务终态 **已取消**；**曲库 1 首 / 曲库目录 1 个，两数相等 = 没留残骸**。聚合与文案那半按判据原文归单测（14 条）。
  - **25**：`https://www.youtube.com/watch?v=x` → 「www.youtube.com 不是 B 站链接…（下载只支持 bilibili.com）」· 一段乱码 → **portable 的原话**「关键词搜索需要配置 LLM；或者直接粘贴 B 站视频链接」· 顺带撞到第三句「视频链接里的 id 不是合法 BV 号…」。
- 🔴 **判据 24 在这个构建上无法在设备上验证，推到 N4e**：决策 f 决定了没有模型时默认 `original` 且 `clean` 是灰的——屏幕上**只有一个可选模式**，「选过一次下次默认是它」没有可观测差别。逻辑半边 17 条单测守着（读写往返 + `resolveNamingMode` 三条规则 + 「记着 clean 但模型没了不改选择」）。形状同 N4c 的判据 18：**有代码路径、有单测、没有真机证据**。
- 🔴 **真机当场逼出一个排序 bug 并修掉（新增 `downloads/rows.ts` + 7 条单测）**：`engine.snapshot()` 交回 Map 插入序（**最旧在前**），而 `hub.ts` 头注释写的是「Newest first」——列表照着它 `slice(0, 20)`，于是**最新的终态排在最底下、砍掉的也是最新的**，与决策 c 的「终态只留最近 20 条」相反。**是设备逼出来的，但设备看不见它**：`FlatList` 只渲染放得下的行，被排到屏幕外的行和不存在的行长得一样（取消明明成功，列表里却找不到那条）。顺序因此提成纯函数去测，设备只复验一个人眼看得出的差别——**一次下载派生的「歌词」任务后完成，现在排在最上面**。两条踩坑进 `docs/LESSONS.md`（还有一条：`input tap` 打在输入法窗口上，而 `uiautomator dump` 只报应用坐标）。
- **另一处顺带实测**：格式合法但不存在的 BV 号，预检的 `pagelist` 当场回 -400 → **页面上直接显示「bilibili API error -400: 请求错误」，根本没有任务进队列**——正是 §1.1 想要的「不要提交之后从任务列表里冒出一条红字」。
- **收尾基线**：`just check` exit 0 · `just test` exit 0 / **2837 passed**（mobile 125）· `mobile-typecheck` exit 0。

#### N4d-3（2026-08-23）分享 intent —— **N4d 完成**

- **`share/intent.ts`（根层 hook）+ `share/draft.ts`（内存单例）**，拆两个文件的理由同 `rows.ts`：hook 引原生模块测不了，而要守的规则（**取走即清空 · 通知不等于消费 · 空分享不算草稿**）一个 import 都不需要。**10 条单测**，两条反测都红在该红的那条。接线三处：`App` 顶上挂 hook（**在 boot 状态之上**，冷启动的分享在 bundle 跑起来十几毫秒后就到，那时库还没开）· `Shell` 的初始 tab 读 `hasShareDraft()`（**不消费**）并订阅切 tab · `AddTab` 在 `useState` 初值和订阅里各取一次（前者管冷启动，后者管「已经停在添加 tab」——那时 `setTab('添加')` 是空操作、不会重新挂载它）。
- 🟢 **判据 22（gate）绿，四条路径 + 完整反测**：**真 bilibili app 视频详情页分享 → 冷启动开在「添加」**（默认 tab 是「歌曲」）；合成 intent 的**前台**（`intent has been delivered to currently running top-most instance` = `singleTask` + `onNewIntent`）、**后台存活**（任务被拉回前台）、冷启动。**反测走了完整一轮构建**：`useShareIntentBridge()` 从 `App` 搬进 `AddTab` → 重新装机 → 冷启动分享落在「歌曲」、**什么也没收到**；还原重装后又收得到。
- 🟢 **判据 45 绿**：消费过之后 force-stop 重开 → 落在默认「歌曲」tab、添加页是空的（草稿不诈尸）。
- 🟢 **真机直接兑现了 §8.2-1 那个偏离计划的改动**：bilibili 发来的是 `当你意识到这首歌不是《东南苦行山》时…… https://b23.tv/3Prw96Q` ——**标题和短链同一行**，预览显示「从这段文字里认出了链接 · 短链已展开 · 第 1 P」+ `BV1MN9ZBCE8i`。**没有 `findSource` 这一条会撞 keyword 门**，「正在解析」从一次真实分享里永远到不了。
- **N4d 收尾基线**：`just check` exit 0 · `just test` exit 0 / **2847 passed**（shared 146 · core 1243 · **mobile 135** · cli 428+9 skipped · daemon 468 · gui 427）· `mobile-typecheck` exit 0。
- **N4d 未结的一条**：**判据 24 推到 N4e**（无模型的构建上只有一个可选命名模式，没有可观测差别；17 条单测守着逻辑半边）。**下一步 N4e**：LLM 设置页与它解锁的四条能力（关键词 / clean 命名 / 多 P 选集 / 重新识别），外加判据 24 的设备半边。子计划 `docs/plans/2026-08-23-phase-b-mobile-n4e.md`（三批 N4e-1–3 / 判据 24 + 26–30）。**决策 a–i 于 2026-08-23 全部按倾向关闭，§5 是定案**。用户同日拍板三条：**手机上填与桌面同一份 url + model + key** · **设置页加「测试连接」** · 🔒 **移动端的 LLM 配置只有「设置页本地填」这一个渠道**——没有 aviary 回退、不从桌面导入、不进同步、不内置默认端点（子计划 §0 有渠道冻结段）。

#### N4e-1（2026-08-23）存储与接线 —— 三道门第一次可以开

- **`portable/llm-config.ts`（新）+ 18 条单测**：`local_metadata` 的 `llm_url` / `llm_model` / `llm_api_format`，形状照 `now-playing-mode.ts`（读路径永不写库、不认识的值 warn 一次并回缺省、不进 `sync_changes`）。**决策 a 落地**：值域只有 `openai` / `anthropic`，缺省 `openai`；桌面合法的 `''`（= 跟随 aviary）在这里是「不认识的值」——`''` 打头的六个 junk 各一条用例，行原样不动。**三个键一起写**（`transaction().immediate()`）：半份配置 = 新 url 配旧 model，那是没人填过的组合、失败起来还像 provider 的错。url/model **写入时 trim**（`chatCompletion` 只 trim url，model 是原样进请求体的）。
- **`apps/mobile/src/settings/llm.ts`（新）**：库里三个字段 + SecureStore 的 `lark.llm.api_key` 拼成一份 `LlmConfig`。**全同步读**（`SecureStore.getItem` 是同步的，N2c 起就靠这一点），**没有缓存**（§1.2：缓存会让「刚在设置页改完、添加页还是旧的」成为新 bug）。`saveApiKey` 与 `clearApiKey` 分成两个函数，是因为设置页不回显 key——空输入框的意思是「别动它」，只有「清除」才是删。`testLlm()` 用**草稿**（决策 f）跑一次最小 completion，**deadline 取 `DEFAULT_TIMEOUTS.llm`**，与真命名调用同一个预算：测试比它预测的那件事更早放弃，报出来的失败产品本来不会有。
- **`downloads/engine.ts` 换成现读、`NO_LLM_CONFIG` 删除**：`getLlmConfig: () => readLlmConfig(boot.db.sqlite)` · `hasLlm: () => hasLlmConfig(boot.db.sqlite)`。四处消费端（preflight 的三道门 + `reidentifySource`）**一个字没改**——它们本来就在按 `deps.hasLlm` / `deps.llm` 分支，这一批只是让那个布尔值第一次可以是 `true`。**决策 d 写进了 `DownloadRuntime.hasLlm` 的注释**：不订阅是因为四个 tab 条件挂载、设置页与添加页不可能同时可见，将来加分栏或 modal 时这是第一个断的假设。
- **两条反测都红在该红的地方**：① 去掉 `writeLlmEndpoint` 的事务 → 「是全三个或一个都不是」当场红（写到第三句才失败，前两句已经落了）；② 往 `settings/llm.ts` 塞一句 `import 'node:crypto'` → Metro 打出完整 import stack（`settings/llm.ts ← downloads/engine.ts ← App.tsx ← root.ts ← index.ts`），**证明这个新文件真在图里**，不是「孤立文件塞什么都是绿的」那一种。
- **基线**：`just check` exit 0 · `just test` exit 0 / **2862 passed**（shared 143 · **core 1261** · mobile 135 · cli 428+9 skipped · daemon 468 · gui 427，较 N4e 子计划记的 2844 +18）· `mobile-typecheck` exit 0 · bundle smoke **111 个 portable 模块**（+1）。
- **用户 2026-08-23 在 N4e-1 收尾时定了三条**（子计划 §8 是修订正文）：① **脱敏不做**——判据 30② 因此从「由代码保证」降为**一次观测**（结论取决于用户实际配的 provider：Anthropic 不带 key，OpenAI 系带一段掐头去尾的，中转面板可能带完整的）；**grep 不到就记「这个 provider 上不外泄」，不许写成「已保证」，grep 得到就记红**。② **`AddTab` 的 `hasLlm` 收成 per-mount**（`useMemo`），与 N4e-2 一起——决策 d 一个字不动（它要的是重挂载重读，memo 也是每次挂载重算）。③ **上机能并的尽量并**：批次与判据归属不变，**设备验收合并成一次会话、四次构建**（生产正测 → 验收跑判据 29 → **三处破坏并成一次构建**跑三条反测 → 还原构建复验），从 6 次破坏构建压到 2 次。**能并起来的根据是验收与生产是同一个 applicationId 同一份签名**，所以曲库与 SecureStore 留在原地——**配置在生产 build 的设置页里填一次，验收 build 也认**；而「已配置 / 未配置」的切换是设置页上的两次点击，不产生额外构建。
- **本批留给 N4e-2 的两件**：① **脱敏还没做**（§6 第二行 / 判据 30②）——`chatCompletion` 在非 2xx 时把 provider 的响应体原样塞进错误文案，`testLlm` 现在也原样往回递；判据 30 排在 N4e-2，脱敏落在哪一层（core 的 `chatCompletion` 一处管三个采样点，还是显示侧各管各的）跟它一起定；② **`AddTab` 在渲染体里读 `hasLlm()`**（§1.5 记着的形状）——以前读的是常量、免费，现在每次重渲染都是一次 SQLite + 一次 Keystore 往返，而这块屏幕**每敲一个字就重渲染一次**。正确性不受影响（决策 d 只要求重挂载时重读），要不要收成 per-mount 由 N4e-2 一并处理。


#### N4e-2 / N4e-3（2026-08-23）设置页与验收脚手架 —— 桌面全绿，六条判据等设备

- **`ui/settings-tab.tsx`（新，决策 e）**：从 `shell.tsx` 拆出来——**理由不是行数是形状**，设置页从「一个开关 + 一串只读事实」变成了一个**有草稿状态的表单**。LLM 段四字段（接口地址 / 模型名称 / openai·anthropic / API Key）+ 已配置徽章 + **测试连接** + 清除。**保存与测试是两个动作**：测试跑当前草稿（决策 f），不落库；key 字段不回显，所以**空的意思是「别动它」，只有「清除」才是删**，而测试在草稿为空时回落到已存的 key（否则存过的 key 永远试不了）。保存后**回读**再显示（`writeLlmEndpoint` 会 trim，粘进来的尾随空格应该看得见地消失）。决策 g 的文案没有假装知道是哪种情况——**一个 keyless 的本地端点和一台恢复过的手机长得一模一样**，所以那句话把两种都说了。按钮跟在字段后面、不钉屏幕底部（§1.8），`keyboardShouldPersistTaps="handled"`。
- **`ui/chip.tsx`（新）**：add 页的 Chip 提出来两处共用——`theme.ts` 只能挡住「各发明一种灰」，挡不住「各画一种形状」。
- **`ui/add-tab.tsx`**：`hasLlm` 收成 `useMemo` per-mount（§8.4；N4e-1 之前读常量是免费的，现在每敲一个字一次 SQLite + 一次 Keystore），命名 chip 的提示改成「去『设置』填一个」。
- **`acceptance/reidentify.ts`（新，判据 29）**：⓪ 确认有模型 → ① 真下一首再用 **`updateSong`（产品自己的「手动编辑链接」，不是裸 SQL）** 把 `source_key` 改成 `bvid:999999999` → ② 清空配置必须 `SOURCE_GONE` 且文案说得出怎么修 → ③ 还原配置必须重新识别并下成 → ④ 删歌收尾。**③ 不断言「找回同一个视频」**——模型是按歌名+艺术家搜的，一个同名翻唱是合法答案；要成立的是「死 key 没了 + 文件到了」。
- 🔴 **写它的时候发现 §8.3 有个洞并已补**：模型的三个字段在 `local_metadata`，也就是**在 `resetInstall()` 删掉的那个库文件里**，而验收套件里除这一个之外**每一个都以 `resetInstall()` 开场**。所以「配置填一次两个 build 都认」的前提是**验收那次装机上只跑 reidentify 这一个套件**。三处落地：这个套件**不重置**（在现有库上造自己的歌、跑完删掉）· ⓪ 条把「模型被谁清掉了」当场说清楚，而不是让 ③ 以「重新识别坏了」的样子失败 · 面板那一行的 note 写明顺序约束。
- **基线**：`just check` exit 0 · `just test` exit 0 / **2862 passed**（无新增单测：`settings-tab.tsx` / `settings/llm.ts` / `acceptance/` 都进不了 Node 的 runner）· `mobile-typecheck` exit 0 · 生产 bundle smoke 111 portable · **验收 bundle smoke 111 portable + 13 acceptance**（+1，证明新套件真在验收图里）。

#### N4e-2 / N4e-3 真机（2026-08-23）—— 判据 24 · 26 · 27 · 28 · 29 · 30①③ 全绿，**N4e 完成**

**一次会话，6 次构建。抓到三个 bug，其中两个只有设备能抓。**

- 🔴 **`AbortSignal.prototype.throwIfAborted` 在这个 RN 运行时不存在**，而 `AbortSignal.any` / `.timeout` 两个**静态方法存在**（手机自答：`any=function · timeout=function · proto.throwIfAborted=undefined · any()→undefined`）。它在 core 里唯一的调用点在**清洗命名的降级处理器**里 ⇒ 任何一次模型失败都把降级处理器自己炸成 `TypeError`，整个下载失败成 INTERNAL_ERROR。**一条为了「别让任务挂掉」而写的路，自己成了让任务挂掉的原因。** 修法：`portable/download/timeouts.ts` 加不依赖该 API 的 `throwIfAborted`（不用 `DOMException`——这个运行时大概率也没有；下游只读 `name === 'AbortError'`）。
- 🔴 **两条静默降级**（`llmJson` 解析失败 · `inferSongInfo` 请求失败）原本一句话都不说，而「清洗降级了」和「你根本没切模式」**在屏幕上完全一样**——当场把两个人都绕进去了。两条现在都 `logger?.warn`。
- 🔴 **关键词的提交路径在移动端根本没接**：配了模型之后 `preflightSingle` 不再抛错而是返回 target，`recognise` 把「没抛错」当成拒绝并回一句写死的旧文案。补 `Recognition` 的 keyword 分支 + 提交路径（关键词**不带命名模式、不带 url**，命名行隐藏——与桌面 `DownloadBar.tsx:90` 同一条规则）。**3 条回归单测，中间那条对旧代码就是红的。**
- 🔴 **手机上 engine 拿的是 `NOOP_LOGGER`**，所以 `describeTaskError` 的「详情见日志」指向一个不存在的日志，而 release 构建也到不了 logcat ⇒ **INTERNAL_ERROR 在构造上就是不可解释的**。现在 `downloads/log.ts` 是那个日志（5 条内存环），设置页是读它的地方。**它带原始错误，也就带 §1.4 那条泄漏面**——脱敏已按用户决定不做，所以这是明知代价的选择，将来要改是加脱敏而不是把窗口拆掉。
- 🟢 **判据 30①③**：设置页只显示「已配置」、字段不回显（16KB 全量 dump grep 不到 `sk-`）；logcat 全量无 `sk-`、无 `authorization`/`x-api-key`，**连 `deepseek` 这个词都没有**（网络层什么都没打）。**30② 按用户决定不跑**。
- 🟢 **判据 27**：同一条链接 `BV1px411C7Me`，原标题 `【洛天依原创曲】红昭愿`/`音阙诗听` → 清洗 `红昭愿`/`音阙诗听`，与桌面真 core + 真模型的预测**逐字相同**；模型名改成不存在的 → 任务**成功**且落库是原标题（回落，不是失败）——这一条在修 `throwIfAborted` 之前正是那个 INTERNAL_ERROR。
- 🟢 **判据 26**：`Yesterday Once More Carpenters` → 落库 `Yesterday Once More`/`Carpenters`。
- 🟢 **判据 28 两半**：未配置 → 当场用 portable 原话拒绝（`这个视频有 2 个分P：…`）且**没有入队**；配了 → 自动选集并下成。
- 🟢 **判据 24 两个方向**：记住 clean → 冷启动仍 clean；**记住 original → 冷启动仍 original**（压过「有模型时默认 clean」）。
- 🟢 **判据 29（验收构建）5/5**：⓪ 模型在 → ① 真下一首再把 `source_key` 改成 `BV176M3zPEZu:999999999`（走 `updateSong`）→ ② 清空配置 `SOURCE_GONE` 且文案说得出怎么修 → ③ 还原配置**重新识别并下成**（`BV176M3zPEZu:30584670526`，同 bvid 的真 cid）→ ④ 删歌收尾。
- **收尾基线**：`just check` exit 0 · `just test` exit 0 / **2875 passed**（shared 143 · **core 1271** · **mobile 138** · cli 428+9 skipped · daemon 468 · gui 427）· `mobile-typecheck` exit 0。

**三条操作上的坑**：`keyevent 4` 收键盘的同时**把 tab 也退了**（设置页未保存的草稿跟着没），改用「滚动把保存按钮顶到键盘上方」· **`uiautomator` 的属性在值里含双引号时改用单引号**，`grep 'text="…"'` 会静默漏读 · `input text` 打不了中文（判据 26 因此用 ASCII 关键词）。

🔑 **用户 2026-08-23 定下的测试规模（子计划 §8.5 是正文）**：**测试简化，优先功能开发**。默认落单测；**反测全部搬进单测**（设备上「改→建→验红→还原→再建」取消）；一个里程碑最多上机一次；不做预测性桌面探针；判据标注归属而不是默认都要真机证据。**当场兑现了一次**：多 P 门原本在任何地方都没有直接单测，补 `portable/download/preflight.test.ts`（10 例）之后删掉 `pages.length > 1` **一秒见红**，三条 narrowness 用例仍绿。代价如实记：失去设备侧「破了会红」的证据。

- **下一步 N4f 收藏夹 / 合集批量**——子计划已出：`docs/plans/2026-08-23-phase-b-mobile-n4f.md`（两批 N4f-1/2 / 判据 31–33 / **决策 a–h 于 2026-08-23 全部关闭，§5 是定案**）。**portable 那半已经全写好了**（`parseSongInput` 认得收藏夹与合集 · `fetchList` 带部分成功与截断 · `preflightBatch` 的 LLM 门 · `enqueueBatches` · hub 已带 `batches`），手机上缺的只有展开的调用点、勾选 UI、和「新建歌单」那条路。🔴 **`downloads/preflight.ts:74` 的 `LIST_NOT_YET` 与 N4e 之前的 keyword 分支是同一个形状**——一句写死的「等下一批」，所以**N4f-1 一开始就要有「展开成功」那条路的单测**，不靠设备发现。**按新规矩整批只上机一次**。**决策口径由用户给定：能照 PC 端就照 PC 端**——逐条读了桌面代码再关：目标**恒为新建歌单**（`BatchSelectModal.tsx:236` 写死的，v1 提的三选一砍掉）· 默认全选 · 整组一个命名模式 · 超 1000 条自己算并禁用提交（连文案照抄）· 展开在**选择页挂载时**（桌面同一条时序，v1 提的「展开按钮」是我读错了）· **`batchProgress` 从 gui 私有 store 提进 `@lark/shared`**（用户确认，要动桌面但零行为变化）。双击改标题改成**点一下**——手机没有双击习惯，属平台差异换形态。

#### N4f-1（2026-08-23）逻辑与接线 —— 桌面全绿，选择页留给 N4f-2

- **`packages/shared/src/download-batch.ts`**（决策 h）：`batchProgress` 从 gui 私有 store 提上来，函数体逐字节相同，桌面三处改 import（`DownloadBar` / `DownloadPanel` / 它自己的单测）。**单测跟着代码走**——gui 427 → **426**，shared 143 → **146**（搬来的那条 + 两条新的：失败与取消也算「已结算」，否则一批十条挂了三条会永远停在 7/10；以及跨批次找归属）。
- **`apps/mobile/src/downloads/selection.ts`**：勾选模型，纯函数。**按 bvid 去重发生在 `pickable` 一处**——同一个 bvid 在收藏夹里出现两次时引擎本来就会 merge 成一个任务，两行会承诺一次下不成的下载，而 `FlatList` 还会撞 key。`overItemLimit` 抄桌面原句（`BatchSelectModal.tsx:210-217`）。**它进 vitest 的理由与 `rows.ts` 同一条**：5000 行的 `FlatList` 只渲染看得见的那些，「全选真的勾了每一行」在设备上不可观测。
- **`apps/mobile/src/downloads/preflight.ts`**：`Recognition` 加 `list` 分支、**`LIST_NOT_YET` 删掉**；`expandList`（`fetchList` 薄壳，`error` 原样递出、**不 `arm()`**——§1.7：展开是有人盯着屏幕的前台活）· `submitListBatch`（一个列表 = 一个 group = 一次 `enqueueBatches`，目标恒为 `{kind:'new'}`）。
- **顺序与 `submitDownload` 相反，是有理由的**：那边 `arm()` 在最前，因为它括住的 `preflightSingle` 可能去拿 pagelist，而手势那一刻是 Android 唯一肯让前台服务起来的时刻（N4c-3 实测）。这边 `arm()` 之前全是同步零网络（上限是算术、`preflightBatch` 是零请求的 LLM 门），所以先拒绝再 `arm()`——**一次根本没发生的提交不该先弹一条通知**。
- **两处自己加的准入检查**（计划里没有，写下来免得当成来自子计划）：**空勾选**与**超 1000**。daemon 路由对这两件都有请求形状校验，手机上没有路由；只靠「按钮禁用」的话，那就是唯一的真相。空歌单名**不**自己挡——那是引擎的规则，薄壳只负责不吞掉它的回答。
- **判据 32（单测半边）**：core 新增 6 条 `fetchList` 用例（走到底 / 按 total 停 / 中途失败保留已取回 + 原话 / 一条没拿到是抛而不是空列表 / 页上限截断 / 条目上限截断）。**反测跑了**：删掉 `error === null && truncated` 那一步，红的**恰好**是两条截断用例、其余 14 条全绿——失败路径自己带消息，被赌的只有护栏那一句。已还原，`git diff` 干净。薄壳那半断言 `error` 是 `'网络断了'` **一字不差**。
- **判据 33（单测半边）拆成两条 core 用例**，因为它本来就是两个断言：**准入** = 空歌单名 → `新歌单名称不能为空`，歌单表长度不变、零任务、零批次；**执行** = 一条死链 + 一条好链同批 → `['failed','succeeded']`、`total` 仍是 2、好的那首真的落库。前者是「没建歌单没入队」，后者是「失败不拖累同批」，UI 上是两个位置（提交按钮下 / 任务列表里的红字），设备半边只看这一件事。
- **「门开了没人接」的单测**（§1.2 的 N4e 教训）：`does not refuse a list, with or without a model`——不靠设备发现。移动侧另有展开的三条（认收藏夹 / 认合集 / 从分享的一整行里挑出列表链接）与提交映射四条。
- **`ui/add-tab.tsx` 只动了一行预览**（收藏夹 / 合集），是 tsc 逼出来的最小改动：**这一批之后粘一条收藏夹链接会被认出来，但「下载」仍是灰的**——选择页、按钮接线、任务列表的 M/N 都在 N4f-2。
- **基线**：`just check` exit 0 · `just test` exit 0 / **2909 passed**（shared **146** · core **1279** · mobile **162** · cli 428+9 skipped · daemon 468 · **gui 426**）· `mobile-typecheck` exit 0。

#### N4f-2（2026-08-24）选择页 + 一次真机会话 —— 判据 31 · 33 关闭，**N4f 完成**

**一次会话，三次构建。三个 bug，其中两个只有设备抓得到，第三个是用户当场提的产品形状。**

- **UI 三件**：`ui/list-picker.tsx`（全屏 Modal，挂载即展开、可取消 = 退出这页 · 歌单名是**可点进去改的输入框**，双击换成点一下是平台差异不是减功能 · 全选/全不选 + 「已选 M/N」· 命名 chip · **两种坏消息两个位置**：展开的部分成功在标题下，准入失败在提交按钮上）· 添加页的 list 分支（命名与「存到」两行隐藏——选择页自己答，问两遍等于第二个答案偷偷赢）· 任务列表顶部 `批量 · <歌单名> M/N`（`batchDone` 进 `@lark/shared`，`latestBatch` 按 `created_at` 取最近一批——**不是**「正在跑的任务所属的批」，后者会在最后一条落地的瞬间消失，`M/M` 永远看不见）。
- 🔴 **`enqueueBatches` 在手机上每次必抛**：它开着自己的事务调 `createPlaylist`，后者又开一个 `.immediate()`。桌面的 better-sqlite3 把嵌套降级成 SAVEPOINT，**所以这个 bug 在桌面无症状地活了几个月**；`portable/sqlite.ts` 的契约明写不保证嵌套（决策 c2），shim 照 SQLite 的规矩拒绝。改用旁边一直是对的 `createPlaylistInTx`。**反测**：把句柄包一层「不许嵌套」跑真引擎，**一毫秒见红、旁边七条 `enqueueBatches` 用例照绿**——这正是它瞒过桌面的原因。**移植层第一次真正兑现了它的价值。**
- 🔴 **抛完之后系统把进程杀了**：`settle()` 见队列空 + 阶段还是 `arming` → 立刻 `stopService()`，而 `startForegroundService()` 才刚发出、服务还没被创建 ⇒ `startForeground()` 永不发生 ⇒ `ForegroundServiceDidNotStartInTimeException`。**这条路自 N4c 就在，只是从没在设备上走过**——而判据 33 的设备半边（歌单名空着提交）走的正是它。修法在原生：**永不撤销一个还没落地的 start**，改留 `stopRequested`，服务起来、`startForeground()` 之后自己 `stopSelf()`。
- **判据 31 ✅（上机）**：收藏夹与合集各走一遍——展开成列表 · 反选掉几条 · 歌单名默认是列表标题、**改过一次并验证用的是改后的名字** · 提交 · `M/N` 走到底 · 歌单里正好是勾选的那些。**一处口径偏差如实记**：release 构建不可调试、`run-as` 进不去私有目录，所以「歌单里是勾选的那些」**按标题比对而不是按 bvid**（子计划 §6 要求 bvid）；一个列表里标题重名才会骗过它。
- **判据 33 ✅（上机）**：歌单名清空提交 → 「新歌单名称不能为空」出现在**提交按钮上方**、歌单 tab 不多空歌单、任务列表不多任务、**应用不崩**。执行失败那半的位置（任务列表里那行红字）由 N4d 起就在。
- **判据 32 ⚠️ 只有单测**：core 六条 `fetchList` 用例 + 反测（删掉 `truncated → error` 一步，**恰好那两条截断用例红、其余 14 条绿**）+ 薄壳「`error` 一字不差递出」。**设备半边没验**——用户的两个列表都完整取回，屏幕上没出现过部分成功那一行。记成「有代码、有单测、没在屏幕上见过」。
- **用户当场报的三条（全部已修并复验）**：① **切后台后通知要等最多 10 秒才出现** → Android 12 起对前台服务通知的默认延后策略，补 `FOREGROUND_SERVICE_IMMEDIATE`（**N4c-3 量到过这 10 秒但当成了环境事实**）· ② **全部下完后通知卡在「正在下载 1 首」** → 停服务是整条生命周期里唯一由 JS 定时器驱动的一步，而后台定时器冻结（本仓第四次栽在这上面）；宽限期防的是「连点两次」，**后台没有点击**，所以不在前台就当场停（残留：前台熄屏时 `AppState` 仍是 `active`，通知要等解锁，锁屏背后没人看，不修）· ③ **蓝牙歌词开着就看不见歌名** → 歌名原本只在 `albumTitle`，手机状态栏组件不显示 ALBUM；`nowPlayingMetadata` 进 `@lark/shared`，开启时歌手栏 = `歌手 - 歌名` 且**整首不变**。
- **收尾基线**：`just check` exit 0 · `just test` exit 0 / **2920 passed**（shared **152** · core **1280** · **mobile 166** · cli 428+9 skipped · daemon 468 · gui 426）· `mobile-typecheck` exit 0。
- **N4f 不会证明的事**（子计划 §7 原样成立）：批次级取消 · 5000 条满载与 1000 条满批 · 合集分页边界 · 失败条目的重试 · 歌曲行多选（N6）· 同步（N5，**TLS 仍硬阻塞**）。外加本批新增的两条：**判据 32 的设备半边**、**判据 31 按标题而非 bvid 比对**。
- **下一步 N4g**：ensure-file 与缓存管理 + 歌单导出（N4 全期子计划 `docs/plans/2026-08-20-phase-b-mobile-n4.md`）。

#### N4h（2026-08-24）多行粘贴 —— 判据 46 真机绿，**N4h 完成**

**用户 2026-08-24 决定把它插在 N4g 之前**（子计划 `docs/plans/2026-08-24-phase-b-mobile-n4h.md`，决策 a–d 同日关闭）。执行顺序自此是 **N4h → N4g → N4i**；字母是登记顺序不是执行顺序。

- **N4h-1 逻辑**：`downloads/multi-line.ts`（`readLines` 纯函数：拆行 · 逐行 `parseLine` · **空行不算行** · 去重 · 200 行上限 · 收藏夹/合集行单独拒绝；`expandLines`：短链**并发 3**、可取消、带进度、**展开后再去重一次**——两条不同短链可能是同一个视频，只有跳转后才知道；`lineItems`：关键词不带命名模式、视频 `title: null`）· `preflight.ts` 把 `recognise` 的离线半边抽成 **`parseLine`**（一行的判定从此只有一份实现，`findSource` 那条分享文本的路多行自动继承）· `submitBatch` 的 target 参数化，`submitListBatch` 收成「列表口味」的薄包装。**三个变异各红一条**：去掉 200 上限 / 去掉去重 / 并发改 100。
- **N4h-2 UI**：**选择页拆成「壳 + 两个来源」**（`ui/picker.tsx` 380 行：Modal · 勾选 · 命名 chip · 计数 · 上限 · 两处坏消息两个位置 · **不能勾的行灰掉、原因写在行下**；`list-picker.tsx` 只剩走列表 + 歌单名 + 提交；`lines-picker.tsx` 只剩展开短链 + 提交到「存到」）· 添加页的判定收进 `useRecognition` hook。
- **一个框两个读者，分界只有一条**：**≥2 个非空行 = 粘贴**（全离线，`readLines`），一行还是原来那条路（一次短链跳 + 「正在解析」）。把整块文本喂给 `parseSongInput` 会读成自由文本 → `findSource` 挑出**第一个**链接、其余静默丢弃，所以这条分界是必须的。
- **判据 46 ✅（上机）**：混合粘贴（视频链接 · 短链 · 整行分享文本 · 关键词 · 乱码 · 重复）→ 预览报行数与可下载条数 → 选择页逐行列出、乱码灰掉带原因、重复只出现一次 → 提交落到「存到」的目标。**单行四种输入复验没被改坏**。判据 47 · 48 是单测。
- **两处与桌面不一致，用户已知并同意**：① **提交是一次原子批次**而不是桌面的逐条 best-effort（换来任务列表的 `M/N`，代价是一条撞容量/命名冲突会拒掉整把）· ② **一次粘贴里不能混「单曲 + 收藏夹」**（桌面可以，它把单项组和列表组并排放在一个对话框里）——手机上一屏只能有一个目标，而列表必须新建歌单、单项要去「存到」。
- 🔴 **顺带修掉一个真 bug（用户发现）**：`listPlaylists()` 按契约把虚拟 `all` 排在第一位，歌单 tab 自己滤掉了，**而添加页的「存到哪里」没滤** ⇒ 那张表里「仅曲库」旁边还有一项叫 `all`，选中它：单曲下载走到 `addSongsToPlaylistInTx('all')` 变成软失败（歌进库了但行上留 `failed_playlist_ids`），**多行批量则在准入阶段被 `#assertPlaylistExists` 拒掉整把**。修在 **view 层一次**（`library-context.tsx`）而不是再补一次筛选——它已经被漏过一次了。
- 🔴 **另一条查出来的账**：**`reidentifySource` 在手机上已实现、判据 29 真机验过五条，但生产 UI 没有入口**，只有验收构建到得了。已计入 N4i（并进「更改链接」）。
- **收尾基线**：`just check` exit 0 · `just test` exit 0 / **2934 passed**（shared 152 · core 1280 · **mobile 180** · cli 428+9 skipped · daemon 468 · gui 426）· `mobile-typecheck` exit 0。
- **N4i 的范围（用户 2026-08-24 同意计入）**：多选批量 + **行菜单补齐**（复制链接需新依赖 `expo-clipboard` · 用 app 打开零成本且只放行 http/https · 更改链接含重新识别）。**「重新下载」留给 N4g**，它和 ensure-file 是同一行的两件事。

#### N4g（2026-08-24）拿回文件 · 管住占用 · 把歌单带走 —— **电脑那半已完成，真机会话待跑**

子计划 `docs/plans/2026-08-24-phase-b-mobile-n4g.md`（**v2，决策 a–h 全关**：a–f 由用户拍板「b 直接获取并播放 · d 不做 · 其余按倾向」，g–h 是开工当天从代码里长出来的）。判据 34–40 原样继承，新增 49（重新下载）· 50（限额存取）。

- **N4g-1 逻辑与装配**：`portable/cache-limit.ts`（`local_metadata.cache_limit_mb`，形状照 `now-playing-mode.ts`：缺行读 0 = 不限 · 看不懂的值读 0 且**不写库** · 写入拒绝负数与非整数）· `services/library.ts` 的 `createCacheOptions`（三条排除：正在播的歌 / ensure 租约 / `pendingFileSongIds`；`streamCount` **恒 0 且这次是真的**）· `cache/runtime.ts`（`EvictionScheduler` 的移动装配：`defer = setTimeout(fn,0)` · `probe = canRedownload` · claims 取引擎的 · `onEvicted → libraryChanged()`）· `downloads/ensure.ts` + `ensure-runtime.ts`（一次播放意图的状态机 + 装配）· `player/visible-queue.ts`。
- **N4g-2 UI 与依赖**：歌曲页与歌单详情的**缺文件行现在是播放**（占位 toast 删了）· 行菜单加「重新下载」· minibar 长出「正在获取《X》」+ 取消 · 设置页缓存区（已用 / 文件数 / 上限 / 立即清理 + 一句回执）· 歌单详情「导出」→ `expo-sharing`（`~57.0.14`，**不需要 config plugin**——它的 plugin 只管 iOS share extension 与「分享进来」的 intent filter，模块本身 autolink，`SharingFileProvider` 在它自己的 manifest 里且 `sharing_provider_paths.xml` 覆盖 cache 目录）。
- **`pnpm install` 变动后的常驻义务已复跑**：桌面 `just check` exit 0 · `just test` exit 0 / **2984 passed**（shared 152 · core **1296** · **mobile 214** · cli 428+9 skipped · daemon 468 · gui 426）· 两个 bundle smoke 都过（生产图 · 验收图 112+13 模块）。
- 🔴 **决策 g：手机上根本没人写 `last_accessed_at`**。桌面写它的地方是 `/audio` 路由（`media.ts` 的 `touch(id)`），而 ExoPlayer 直接读文件、那条路由不存在 ⇒ **不补的话「按最近最少使用清理」在手机上其实是「按创建时间清理」**。补法是播放器 `play()` 里 driver 装好、`built.play()` 之后 touch 一次——**装不上的源不 touch**，那正是清理该先碰的文件（单测两条守着这句）。
- 🔴 **决策 h：`libraryChanged()` 在手机上从来没能刷新过屏幕**。`library-signal.ts` 至今只有播放器在听；`LibraryProvider.changed()` 自己换 `view`，所以**只有手指按在按钮上的写入**会刷新列表——`engine.ts:207` 的注释写着「the song list rebuilds」，它其实只在切 tab 重挂时才重建。N4g 有两条没有手指的写入（ensure 完成、清理删文件），所以改成 **provider 订阅 `onLibraryChanged`，`changed()` 退化成只发信号**：一个信号一个家。
- **ensure-file 的三条规则照 §2.9 落地，代际复用播放器的**（`player.claimIntent()` / `holdsIntent()`）：**任何**起播路径（行、下一首、队列面板、恢复位置）都自动抢占一个等待中的意图，不需要在每个 call site 加一次作废。判据 35 的反测（不判代际 → 必须抢走）**在单测里**（`ensure.test.ts`，把 `holdsIntent` 换成恒真）。
- **队列快照取在起播那一刻**：新增 `player/visible-queue.ts`——列表页发布「我这一屏的队列怎么建」，ensure 落地时读一次；**读到的那一屏不含这首歌就回落到点击时的那一屏**（在 设置 / 添加页 / 另一个歌单里等到文件时就是这种情况）。
- **判据 36（零网络短路）由 core 现有单测承担**（`download/engine.test.ts:1154`「succeeds without a single network call」断言 `upstream.requests` 为空）——去掉短路那条断言必红，形态就是判据要的反测；本批不再造第二份。判据 37 的逻辑半边同理在 `library/cache.test.ts:196`（fail-closed 与「probe 恒真就删」是同一条用例的两半）。
- **待上机（一次会话）**：判据 **34（gate）** ensure-file → 从头播 + N3 判据 15 的三种歌词 · **38** 限额生效且正在播/pin 的没被删 · **39** 导出到系统分享面板、与桌面导出结构相等 · **40** 跑完仍可交互 · **49** 重新下载 · 35 与 37 的设备半边。
- **真机会话（2026-08-24，release 构建，冻结设备 V2408A）——判据 34（gate）· 35 前半 · 37 · 38 · 39 · 40 · 49 全绿**，用户手测。判据 39 的主机那半我这边验完：文件名 `测试.lark-playlist.json` 与桌面逐字一致 · **编码与 GUI 的写法逐字节相同**（`JSON.stringify(data,null,2)`、无末尾换行）· **回环通了**——导进一个全新桌面库再导出，忽略 `exported_at` **结构完全相等**（CLI 那份多一个末尾换行，正是 §1.6 记的既有不一致）。
- **判据 35 的现象与代码逐条对上**（用户连点两首「需要下载」的）：minibar 用后点的**覆盖**先点的（一个槽位）· 先点那条**不取消、照常下完、只入库不播**（`reconcile` 按 taskId 找槽位，对不上整条忽略）· ✕ 只取消槽位里那条。**队列快照那半（35②）仍未上机**。
- 🔴 **用户在会话上提了两条产品问题，都成立，已按决策 i 改掉（N4g-3）**：① 点行会去拿、按「下一首」却弹「还没有文件」——**同一件事两种答复**；② 自然播完停在上一首**最后一秒**，读起来像卡住了。改法：`decideNext` 规则 3 按**有没有手指**分——`next`/`prev` 走 ensure（与点行同一条路），`ended` **跳过**没有文件的找下一首，都没有才停。**桌面跟着变**（`advance` 多传 `ensureFile: trigger !== 'ended'`；桌面的 `ops.play` 早有这条路）。原规则「stop, never skip」的理由（跳过会把「缺文件」变成「不存在」）不再成立：两个宿主都能把文件拿回来，列表里那一行也一直写着「需要下载」。**「不许下载雪崩」这条老约束换了个位置继续存在**——由「`ended` 只跳不拿」保证，桌面与手机各有一条断言守着。测试 2984 → **2989**。
- 🔴 **同一次会话查出来的第三条（我复读代码找到的，用户拍板「对齐桌面」）→ 决策 j**：手机的 `toggle`/`pause` **不领代际**，而桌面的 `pause()` 一直在调 `invalidatePending()` ⇒ 「点了缺文件的 A → 再点正在播的那一行」时 A 落地仍会接管。**最锋利的例子没有手指**：蓝牙断开会 `pause`（N3e），不作废的话半分钟后文件落地就从外放开始放。改成：**表过态的操作（起播别的歌 / 主动暂停或继续 / 下一首）作废等待中的意图，队列自己走到头停下则不作废**；作废后 minibar 那一行立刻消失、下载照常完成只入库。`claim()` 必须放在 lane **里面**——放外面会把「加载中按暂停」变成「重新加载并播放」（N3a 的老用例守着这件事）。**锁屏暂停键不经过 JS，这个缝如实记在子计划 §5 决策 j 下面**。
- **minibar 那一行同时改了措辞与去处（用户第 7 步提的第三条）**：「正在获取《X》**，完成后播放**」——它是一次**播放承诺**，不是下载指示器，这也正是「添加页发起的下载为什么不在这儿」的答案（那些没有承诺，它们的家是任务列表与通知）；文字现在**点得动，跳到添加页的任务列表**看进度。测试 2989 → **2993**。
- **第二次真机会话（2026-08-24，同日，release 构建）——判据 51 · 52 · 35② 全绿，N4g 完成**。用户手测：按「下一首」落到「需要下载」的歌 → 去拿并播（不再弹拒绝）· 自然播完 → 跳过没文件的继续放 · 等待期间按暂停 → minibar 那一行立刻消失、歌照常下完只入库不播 · 从歌单点缺文件的歌、等待期间切到歌曲 tab 改排序 → 起播后队列是**那一屏**。
- **N4g 收尾基线**：`just check` exit 0 · `just test` exit 0 / **2993 passed**（shared 154 · core 1296 · **mobile 220** · cli 428+9 skipped · daemon 468 · gui 427）· `mobile-typecheck` 0 · 两个 bundle smoke 都过。**判据 34–40 + 49–52 全部关闭**；本批唯一新造的欠账是「锁屏暂停键不经过 JS，因此不作废等待中的 ensure」（子计划 §5 决策 j 下面 + §7）。
#### N4i（2026-08-25 起）多选批量 + 行菜单补齐 —— **N4i-1 已完成**

子计划 `docs/plans/2026-08-24-phase-b-mobile-n4i.md`（v1 → **v2**：用户 2026-08-25 追加单首「添加到歌单」与加歌弹窗的搜索框 → **决策 a–j 全关**）。判据 53–64。

- **N4i-1 ✅ 纯桌面批**（测试 2993 → **3008**）：`resolveSourceUrl` / `recognizeSourceUrl` 从 daemon 路由提取进 `portable/download/source-url.ts`，daemon 变薄壳（body 校验 + 超时 + 错误映射 + claim + 事件照旧）。**先补两条 characterization 再搬**（短链展开 · 收藏夹链接），加上 recognize-url 的短链那条共 3 条；提取后**原有 9 条一个字没改地全绿**。portable 侧新增 12 条直接单测。
- **一条事实更正**：用户问「桌面端也支持短链统一行为怎么样」——**桌面本来就展开短链**（`songs.ts:193-196` 与 `:283-286` 各一次），v1 子计划那张表的右栏是「缺的**测试**」，写得像「缺的功能」，已改。**桌面 UI 一个字没动**（用户：桌面端不用预览）。
- **两处有意的行为变化**（子计划 §8.2）：① **短链展开之后仍是短链 → 拒绝**（此前是无预算递归，对上重定向环会永远展开；一跳是 `resolveInput` 早就在用的规则）· ② **纯文本会被当成 url 存**是**既有行为**，本批只把它钉住并写明「要不要改是独立决定」。
- 🔴 **反测第一次跑出了假绿**：改 core 的源码而没重建，daemon 的 characterization 全绿——它跑的是 `packages/core/dist`。重建后两条反测各自见红（去掉 R8 分支 · 短链不展开）。已进 `docs/LESSONS.md`。
- **N4i-2 ✅ 手机那半**（测试 3008 → **3020**）：选择模式（长按进入 · 计数 / 全选 · `BackHandler` 退出 · 批量运行时按钮变灰）· 两个 tab 各一套批量动作（歌曲页：固定 / 取消固定 / 加入歌单 / 删除；歌单详情多一个**移出歌单**）· 行菜单补齐四项（**添加到歌单** · 复制链接 · 用 app 打开 · **更改链接**）· 加歌弹窗重做（搜索走 `view.songs({search})` · **加完不关** · `FlatList`）· `expo-clipboard ~57.0.1`（装完复跑桌面 check+test，两个 bundle smoke 都过）。
  - **`BackHandler` 的注册与选择栏同生命周期**（`ui/selection-bar.tsx`）：它是全局栈，注册在哪个组件里就该由哪个组件注销，散在两个 tab 里迟早漏一个；**批量跑着的时候不响应返回**，否则会在一个正在被删的集合下面把选择丢掉。
  - **勾选模型搬到 `library/selection.ts`**（N4f 写给下载选择页的那五个纯函数，本来就是泛型的）：歌曲行用 `song.id` 当 key 直接复用，**没有第二个勾选模型**。`downloads/selection.ts` 只留下载形状的那半。
  - **`library/batch.ts` + `library/links.ts` 进单测**（12 条）：批量**逐条不中断**且失败要**同时报两个数**（「已删除 7 首，3 首没能删除：忙」）· **打开链接只放行 http(s)**——`intent://` / `file://` / `content://` 全部拒绝，这是 R10 在链接上的等价物。
  - **两个 tab 文件过 500 行**，把 `SongRow` 拆成 `ui/song-row.tsx`（歌曲页 530 → 409）。歌单页 538 行**留着**（`AddSongs` 是下一个自然的切口），过 650 再拆。
- **N4i-3 ✅ 真机会话（2026-08-25，release 构建）——判据 53–59 · 61–64 全绿**（60 是单测）。用户手测：长按进选择模式 / 全选 / 系统返回键退出 · 批量固定与取消固定 · 加入歌单（含「新建歌单…」，已在里面的不重复加）· 批量删除后**设置页的曲库目录数正好少 3** · 歌单里移出 2 首而歌曲 tab 还在 · 复制链接 / 用 app 打开 / 更改链接四分支 · 加歌弹窗搜歌手连加三首。
  - **用户当场报三条，两条是 bug 已修（`c8b7228`）、一条不是**：① 歌单页 ⋮ 不贴右——可点区少 `flex: 1`，**且分隔线画在可点区上**所以线也断在文字末尾（两处一起改成与歌曲页同形）· ② 加歌弹窗高度随结果数变 → 改成**固定 320**（键盘开着时卡片在拇指下移动）· ③ 「用 app 打开」先跳浏览器——**不是 lark 的行为**：问系统 `cmd package resolve-activity` 得到 `ResolverActivity` 且 `isDefault=false`，**Android 12 起未验证的 http(s) 链接默认进浏览器**；换 `bilibili://` 实测**同样落到选择器**，不改，直达的开关在系统设置里。
  - **工程卫生**：两个 tab 文件过 500 行建议阈值，`SongRow` 拆出成 `ui/song-row.tsx`（歌曲页 530 → 409）；歌单页 538 行留着，过 650 再拆。

#### N4 全期收尾（2026-08-25）—— **N4a–N4i 全部完成**

**判据 1–64 全部关闭**（N4 全期 1–48 · N4g 的 49–52 · N4i 的 53–64）。收尾基线：`just check` exit 0 · `just test` exit 0 / **3020 passed**（shared 154 · core 1308 · **mobile 232** · cli 428+9 skipped · daemon 471 · gui 427）· `mobile-typecheck` 0 · 两个 bundle smoke 过。

**六条残留由用户 2026-08-25 逐条定案，都不是待办**：

| 事 | 用户的决定 |
|---|---|
| 判据 18（dataSync 6 小时配额，只有单测） | **取消**——太费时间，之后实际使用发现问题再说 |
| 判据 32 的设备半边（部分成功那一行没在屏幕上见过） | **留到实际使用发现再说** |
| 判据 31 的比对口径（按标题而非 bvid） | **接受当前情况**，能正常使用即可 |
| 判据 11 的反测（没有运行时开关） | **影响不大**，不补 |
| 判据 30②（key 会不会出现在错误文案）+ `downloads/log.ts` 脱敏 | **暂时不做** |
| N4g 决策 j 的缝（锁屏 / 通知栏暂停键不经过 JS ⇒ 不作废等待中的 ensure） | **先不做** |

🔴 **唯一仍然要还的，是一件跨批的事**：**桌面 accept 全系列自 v0.3.0 之后一次没跑过**，而这期间桌面被改了四轮（N1 的整个 portable 重构 · N4a 的三处提取 · N4g 的 `decideNext` 规则 3 + `ops.play(ensureFile)` · N4i-1 的 URL 归一化提取）。单测全绿，但 `accept-gui` / `accept-m5` / `accept-cli` / `accept-sync` / `accept-pack` **一条真实证据都没有**。**N1 判据 22 本来就欠着它**（「对新构建的 dmg/tgz 复跑 accept 全系列」）⇒ **记成下个桌面版本的发版门禁**。（**已于 2026-08-26 的 N7g-1 还清**：五套 128/128，见本文件末尾的 N7g-1 段。此处保留原文作为当时的账。）

### N5 同步（开发中）

**子计划已出**（2026-08-25，`docs/plans/2026-08-25-phase-b-mobile-n5.md`，六批 N5a–N5f / 判据 65–84 / **决策 a–j 同日全部关闭**，b 按用户措辞记为「**暂时不做**」而不是否决）。

🔑 **范围修订：D15 作废，TLS 降为后续**（主计划 §4.3 **Stage-4 修订**）。用户 2026-08-25 决定：**移动端同时支持 https 与明文 http，由设置页一个开关决定是否接受明文**。理由是产品形状——其他用户会自建 server，让他们先能用明文 IP 跑起来比先要求每人搞定域名 + 证书更重要；而「只给某个 IP 开洞」与「支持任意自建 server」互斥（`networkSecurityConfig` 的 host 白名单是编译期 XML，运行时无加例外的 API）。**同一次决定的第二条：接受音频走明文**，代价是判据 5 的第二半从此不证明任何东西。

**开工调查的三条结论**（子计划 §1 是正文）：
- **N5 的主体不是同步逻辑**。N1f 把协调器整个搬进了 portable，宿主只填 `CoordinatorContext` 的 15 个字段（桌面的填法 `daemon/src/sync/coordinator.ts:47-66` 共 20 行）。逐条对完：**6 个手机现成 · 1 个常量已在（`SYNC_PULL_LIMIT_MOBILE`）· 7 个新建，其中五个在十行内**。这是 N1 端口化第一次真正兑现。
- **触发器是唯一没有 portable 对应物的东西**。`daemon/src/sync/triggers.ts` 是 N1f 故意留下的那一半（「操作系统有意见的部分」），而 Android 对这部分意见特别大——**后台 JS 定时器已经咬了四次**。口径定为：前台全开、进后台停定时器 + 断 SSE、**回前台 = 一次触发且先查 token**；**suspend 不碰 session**。如实记下的产品形状差：**手机在后台不会收到别的设备的改动**。
- **两笔继承的旧账**：**首次登录必然跑全量 backfill**（`backfill.ts:63,67`）· 🔴 **`imported` 行会第一次出现在手机上**（N4 §1.5 的整个简化压在「手机上没有 imported」上），危险的不是缓存清理（不变量跟着 portable 搬过来了）而是 **ensure-file**——imported 可能没有 `source_key`。本机库 0 首 imported ⇒ **只能落单测**。

**N5a 完成**（纯桌面）：`sync-labels` 的四张中文表从 GUI 提取进 `@lark/shared`。**characterization 先行**——那个文件搬家前**零直接测试**（和 `download-labels` 当年同一个洞），先在原位补 16 条钉住今天的行为，**反测过**（改两处文案 → 2 红，还原 → 16 绿），再搬；git 认出是 rename。**一处有意的行为变化（判据 68）**：`SYNC_INSECURE_URL` 的文案由「请勾选**下面的选项**」改成「请先打开『**允许明文 HTTP**』」——两端共用的措辞不能描述某一端的控件位置。GUI 三个消费点改成直接 import，**不做 re-export 转发层**。**判据 65 一并关掉**（用户要求从 N5b 提前，免得有一整批的时间里文档还写着「TLS 硬阻塞」）；**历史子计划里的那句一个字不动**。踩到两条：**GUI 的 vitest 解析的是 `@lark/shared` 的 `dist/`**，不重新 build 就是 15 红且与代码无关；**shared 的 tsc 比 GUI 严**（`noUnusedLocals` 拒了一个纯类型守卫变量，而它与 `SYNC_STATES` 的遍历本就重复）。验证：`just check` exit 0 · `just test` **3036 passed**（= 基线 3020 + 新增 16，一条不多一条不少）。

**N5b 完成**（明文开关的存储 + manifest）：开关落 `packages/core/src/portable/sync-insecure.ts`（**不是** `apps/mobile/`——`cache_limit_mb` / `naming_mode` / `now_playing_mode` 三个移动端独有的 `local_metadata` 偏好都住在 portable，多开一处只会让第四个不知道去哪）。**存储格式抄 `audio_migration_pending`：`'1'`/`'0'` + `=== '1'` 判定，格式本身就把 fail-closed 做掉了**——任何这个 build 没写过的值都不是 `'1'`，一律拒绝明文；这个方向上错一次的代价不对称（错向 false = 一次登录失败，错向 true = 密码明文上网）。**反测过**：翻成 fail-open ⇒ 11 红，还原 ⇒ 14 绿。**manifest 对着构建产物验**（照 D14 判据 10⑤）：`processReleaseMainManifest` 产出的**合并 release manifest** 里 `usesCleartextTraffic="true"` 在，且 **D16 的三个属性一个没被顶掉**（`with-backup-rules.js` 是「宁可抛也不覆盖」，原则上可能撞，实测没撞）。**判据 66 一并关掉**——manifest 那一行落地那一刻，`acceptance/downloads.ts` 判据 5 的注释就变成谎话；改法是**如实分档**而不是删：`streamSchemeIsHttps` 从「门」降级成「唯一报告 scheme 的地方」（仍有意义），`streamIsReachable` 的 cleartext 那一半**死了**。留着而不是删掉——一条不再证明其中一半的判据，安静拿掉正是下一个人得出「保证还在」的方式。验证：`just check` exit 0 · `just test` **3050 passed**。

**N5c 完成**（协调器的移动装配）：`apps/mobile/src/sync/{context,hub,quarantine}.ts` + `ports/{device,events}.ts`，`App.tsx` 在 boot 的 `.then()` 里装配一次。🔴 **子计划 §2.2 的 `fileOps` 那一行写错了，这是本批最有价值的更正**——表里写「`boot.fileOps` ✅ 现成」，而 boot 的 runtime 是在下载引擎之前造的、**没有 claim registry**；N4b 之后 `LibraryService` 拿的是 `downloadRuntimeOnce(boot).fileOps`。协调器要是拿错，**远端删除的 drain 会和正在写同一首歌的下载各自对着一个没人共用的登记表仲裁**。顺带修掉 `BootResult.fileOps` 上那段 N4 之后就不成立的注释。**logger 的 R3 复看**：复用 `engineLogger`、环 5→10（它早就不是下载专属，cache 也在写；两个话多的子系统共用五行等于互相擦证据），**设置页标签改「最近的错误」**——sync 失败挂在「下载错误」下面是用户读得到的谎话。**`ports/events.ts` 加注入缝 + 编译期穷尽**（`satisfies never`），因为移动端 vitest 是显式白名单、碰 RN 的文件不许收集，而这个 switch 十二条臂在屏幕上零可观测差异；**反测过**（误接歌词 + 下载事件刷库 ⇒ 7 红）。🔴 **两条缺口如实记着**：`lyrics:changed` 不会让**正在播放**的歌重读歌词（归 N5e）· `sync:file_quarantined` **今天没人发**（两处装配都没传 `onQuarantine`；影响有限，`quarantined_count` 随 status 刷新，接上改的是「什么时候知道」不是「会不会知道」）。**本批没起任何东西**——构造 context 不开 socket、不装定时器、不读凭证；触发器是 N5d。验证：`just check` exit 0 · `just test` **3064 passed**。

**N5d 完成**（触发器 + 前后台状态机，判据 77 · 78 关，79 关一半）：`sync/triggers.ts` 是状态机、`sync/app-state.ts` 是 15 行的 RN 壳，**分开是为了能测**——移动端 vitest 的 include 是显式白名单，import react-native 的文件收集不到（N4d 劈 `share/draft.ts` 是同一个理由）。**口径**：前台全开、进后台停定时器 + 断 SSE、**回前台 = 一次 `'resume'` 触发且先查 token 再跑轮次**（口袋里两小时的 app 拿的是大概率过期的 token，先跑轮次等于花一个请求撞 401、掉 session、让人莫名重新登录）。**`#suspend` 三件不做**：不碰 session · 不通知 runtime · **不 abort 飞行中的轮次**（系统还没冻住的活儿，杀掉它是自己发明一次失败）。`SyncTrigger` 加了 `'resume'`（全仓没有对它的穷尽 switch，只进日志行；桌面永远不发——桌面没有「走开又回来」）。**会话恢复进一次性闸内**，顺序照 `daemon/src/boot.ts:580`；必须在闸内，因为安装 session 会 bump epoch，Activity 重建后再恢复一次会把飞行中的轮次判废。**反测三条**：resume 顺序调过来 ⇒ 1 红 · suspend 忘停定时器 + 顺手 teardown ⇒ 3 红。⚠️ **判据 79 只关了一半**：合流在 core 有测，「一个进程只有一个」是一个 `if (handles === null)`、没有单测（三个一次性闸都是同样形状，同样没测）。验证：`just check` exit 0 · `just test` **3077 passed**。

**N5d-2 完成**（借 owl 的两条流策略，**两端一起改**，用户 2026-08-25 定；判据 85 · 86）。读完 owl 的 `trigger-gate` / `scheduler` / `health-probe` / `sse-bridge` / `auth-signal`，**两条真该借，而且 lark 依赖的 SDK 早把接口备好了、两端一个都没用**（全仓零处 `onOpen` / `onFrame`）：**① 流不重放 ⇒ `onOpen` 补一轮**（服务器不发订阅之前的事件，一次中断之后对端改动要等下次时钟触发——桌面最多 5 分钟、手机 15 分钟；顺带堵掉 N5d 自己那条缝：resume 先跑轮次、订阅 1 秒后才建立）· **② 流会静默 ⇒ `onFrame` 喂 60 秒看门狗**（半开 socket 一个回调都不触发，客户端永远坐在僵尸「已连接」里）。**②　先核实了心跳存在**：`skybridge/.../routes/events.ts` 开流写 `:ok`、之后每 `PING_INTERVAL_MS = 25_000` 一次 `event: ping`，且是最初那版 SSE（`806a935`）就有的 ⇒ 线上 0.1.4 一定在发；**没有心跳就上看门狗会每 60 秒杀掉一条健康的流**。落点 `portable/coordinator/stream.ts` **两端共用**——N1f 当初把流留给宿主是对的（那时它只是一个 subscribe 加一个冷却），有了两条要保持一致的策略之后就不对了。**桌面三条既有流测试一字未改全绿**（契约没变、只是搬家）。**反测两条**（拿掉补轮次 / 看门狗不重置 各 1 红）。**不借**：`health-probe`（lark 的 30s 冷却 + 1s 轮询已等价，手机上多一个 10s poll 只是白唤醒射频）· `trigger-gate` 的两问分离（**lark 本来就问对了**——owl 因为把「有凭证」当「能跑」，一份日志里出过 163 条连续 `scheduler tick rejected`）。🔴 **记账**：owl 区分「session 没装过」与「token 被拒」两种恢复能力，**lark 两端在 `token_rejected` 之后都没有自动恢复**（既有行为，不是移动端回归）。⚠️ **桌面因此被改第四轮，且这次有意改了桌面行为**（daemon 起来就补一轮）。验证：`just check` exit 0 · `just test` **3092 passed**。

**N5e 完成**（UI 五块 + 补掉 N5c 的歌词缺口）——**这个里程碑第一次有东西能在屏幕上看见**。`ui/sync-section.tsx`（500 行：登录表单含明文开关 · 状态 · 立即同步/退出登录 · 隔离提示 · 失败 file-op 的重试/放弃）· `ui/conflicts-screen.tsx`（207，全屏 Modal，二选一 + CAS 失败如实报）· `ui/sync-devices.tsx`（117，只读、**按需加载**）。**切三个文件是被行数逼的**：`settings-tab.tsx` 已 593 行，塞进去必破 800 硬线。🔴 **`ports/events.ts` 的默认 sink 改成必传——N5d 那个教训的第二次**：补歌词缺口要通知播放器，而播放器 import expo-audio ⇒ `events.ts` 一旦持有真实 sink 就被 vitest 白名单挡在门外，十二臂 switch 立刻失去全部测试；**wiring 归装配根，判定留在能测的文件里**。**歌词缺口已补**：`PlayerStore.refreshLyrics(songId)`（不是当前那首就 no-op）。**两处 React 写法被 biome 顶回来**：`useEffect` + `setRows` 同步数据库 ⇒ 改成**渲染期直接读**（`useMemo` 键在 bump 计数上就是「带失效令牌的缓存」，绕远路做同一件事）。**徽章按决策 i**（设置 tab 标签旁小圆点，明确不挂 minibar——N4g 已把那一行定性为播放承诺）· **设备列表按决策 f**（只读；按需加载是**与桌面的一处已知不一致**）。⚠️ **判据 80 / 81 只做到「实现了」**：造真冲突要两台设备互写、造失败 file-op 要文件系统在特定时刻失败，都没自动化，留给真机会话。验证：`just check` exit 0 · `just test` **3092 passed**。

**N5f 真机会话完成 —— N5 收官**（2026-08-25，一次打包一次会话，**判据 69–73 全绿**）。手机端用户跑，桌面端实证由我从副本库里读出来：**69** 开关关着填 `http://` 被挡住 · **70** 副本 nest 出现 `skybridge.toml`（0600）· **71** 副本库**已推送 104 条 / 未推送 0**，手机的 **11 首歌 + 1 个歌单**到达桌面 · **72** 两个方向都收敛，两端最终都是 **18 首** · **73** 副本 **18 个歌曲目录只有 8 个 `song.m4a`**，手机屏幕上三行「需要下载」 · 附带 **0 冲突 / 0 文件操作 / 0 死信**，设置 tab 旁无小红点。游标 `pulled 1729 / pushed 1727`——那个 workspace 上确有 v0.2 soak 的历史，用户明确选择「就用现有账号，都是测试产物」。🔒 **真实 nest 全程未绑定**（无 `skybridge.toml`、`songs.db` 大小未变），桌面跑在 `just backup-nest ~/lark-n5` 的副本上；⚠️ **那个副本现在是已绑定状态**，以后不带 `LARK_NEST_DIR` 起 daemon 会开到真库。**装包时踩到一条**：`am start -n .../.MainActivity` 起不来而 `monkey -c LAUNCHER` 能（N4d 的 singleTask + intent filter 之后，不带 category 的显式启动静默失败），已进 LESSONS。**收尾清理**：删掉三个没有任何测试在用的投机导出（`resetSync*ForTests`）· 端口 47100/8081 空闲 · Gradle daemon 已停 · 无 `adb reverse` 残留。

🔴 **N5 未了的三笔**（都已登记，不是新待办）：判据 **76**（`SYNC_PULL_LIMIT_MOBILE` 在竞争条件下复测，要 ~2000 行合成负载，**单独一批**；R5 的 200 仍是空载下界）· 判据 **80 / 81**（冲突页与失败 file-op 的界面已实现，但没有自然触发条件、也没有自动化）· 决策 **b** 的后台同步（**暂时不做**，留在账上）。

**下一站**：**N6**（歌单导入 + 设置收尾 + 打磨 + 签名 APK 发布 + developer verification go/no-go）。

### N6 歌单导入 + 收尾发布（开发中）

**子计划已出**（2026-08-25，`docs/plans/2026-08-25-phase-b-mobile-n6.md`，五批 N6a–N6e / 判据 85–101 / **决策 a–j 同日全部关闭**——用户「都同意」）。范围由用户当天定死五条：**导入 UI 与桌面一致、不加内容** · **撤销设备收尾** · **签名从简** · **只在 GitHub Release 发包、不考虑进商店** · **发版前文档大整理（到那一步再细说）**；另加一条提醒：**桌面版打包记得用图标**（判据 99）。判据 **76 / 80 / 81 同日定为「先不做，只记录」**，不进本批范围。

**开工基线**（2026-08-25 复跑）：`just check` exit 0 · `just test` **3092 passed**。

**N6a 完成**（端口打通：sha256 host + 取字节，**判据 85 · 87 关，86 的探针已就位待真机**）。

- **不需要新依赖 —— 子计划 §1.4 的 `expo-document-picker` 作废**：`expo-file-system@57.0.4` 自带 `File.pickFileAsync({ mimeTypes })` 与 `file.bytes()`，两个动作同一个包。**副作用是好的**：`pnpm install` 没变动 ⇒ 判据 13 那条「装完必须复跑桌面 check + test」这次根本不触发。
- 🔴 **「N6's gate」已开**：`portable/runtime/digest.ts` 的整文件 sha256 **故意没有默认实现**（异步签名 ≠ 非阻塞——包一层 Promise 的同步哈希照样冻住 JS 线程，而调用方看不出来），桌面在 `node-runtime.ts:23` 装 `node:crypto`，**手机上一处都没有**，所以在此之前手机调 `parseImportFile` 会当场抛。现在 `boot/runtime.ts` 装两件（Random + sha256），启动序列步骤 ① 的注释跟着改成两种炸法。
- **一处类型摩擦如实记着**：`expo-crypto.digest` 要 `BufferSource`（覆盖普通 `ArrayBuffer` 的视图），端口给的 `Uint8Array` 在 TS 5.9 里是 `Uint8Array<ArrayBufferLike>`（含 `SharedArrayBuffer`）。**用 type guard，不用 `as`，也不无条件复制**：Hermes 没有 `SharedArrayBuffer`，真机永远走「原样递过去」，复制那一支是留给「将来长出来」的诚实答案——20MB 上无条件复制是白花的一次 memcpy。
- **判据 87 是三方独立的**：常量 `488d8f…669d` 由 **`shasum -a 256`** 产出（既不是 node 也不是 expo），单测用 **`@noble/hashes`** 复算，设备探针用 **`expo-crypto`** 复算 —— **没有任何一方给自己判卷**。夹具 `acceptance/import-fixture.ts` 被单测与探针**共用**（两处各写一份常量会各自漂移且双双变绿），里面的中文名是有用的：多字节 ⇒ `TextEncoder` 错了会改数字而不是蒙混过关。**反测已跑**：把 `"duration": 372` 改成 `373`，digest 那条当场红（`c315b2…` ≠ `488d8f…`），改回即绿。
- **判据 86 的探针在面板上**（「Run import digest scenarios」，2MB 与 20MB 各 5 次，nearest-rank p95 = 最慢那次）。**行的绿不代表快**——它绿是因为「真的出了一个 64 位 hex」，数字在 detail 里，这正是「只记录不设阈值」该有的样子。
- **判据 85 成立**：`git diff` 对 `packages/{gui,daemon,cli,core,shared}` **零改动**。子计划 §1.1 的推断由此变成事实 —— **N6 到目前为止真的没动桌面**，发版门禁与 APK 谁先谁后都可以。
- **落点**：`library/import.ts`（纯逻辑：两道尺寸闸 + 调用顺序，进 vitest 白名单）· `services/playlist-import.ts`（原生壳：picker + `bytes()`）· `boot/runtime.ts`（+sha256）· `acceptance/{import-fixture,playlist-import}.ts`。**`ImportFileSource` 是那条分界**：`read()` 是函数而不是一份字节，因为两阶段**各读一次**——URI 过期必须在第二阶段如实失败，而不是被这一层偷偷做的副本盖住。**尺寸闸查两次**是因为声明的 size 可能是 0（SAF `content://` 的 provider 不给 stat），而「系统没说」不等于「文件不大」。
- 验证：`just check` exit 0（bundle smoke：`apps/mobile` **115 个 portable 模块 / 3.1MB**）· `just mobile-typecheck` 通过 · `just test` **3096 passed**（mobile 259 → 263）。

**N6b 完成**（导入 UI，**判据 88 · 89 的逻辑半边 · 90 · 91 关，92 待真机**）。

- 🔴 **判据 88–91 的归属改过，这是本批唯一的计划偏离**：写判据时假设四条都落在移动端单测，实际前提不成立——**手机 vitest 造不出 `PortableDb`**（要 expo-sqlite），而四条问的全是 **core 的语义**。于是 **88 落进 core**（`transfer.test.ts` 新增：`previewImport` 前后四张表计数逐个相等——今天这条路上一个 INSERT 都没有、连事务都不开，**测它是为了把「今天恰好如此」变成承诺**），**90 / 91 发现 core 早就有测**（按选择合并 · 无 target 只进曲库 · 目标里已有的跳过 · 任何一处失败整批回滚），**手机这层不重复测 core**；**89 劈两半**，错误那半有单测、「屏幕退回预览」留给真机。
- **手机自己那一半是「第二次读取」**：读真的发生 · digest 决定成败 · **交出去的 entries 是第二次读的**。最后一条断言的是 **identity 不是 equality**——文件没变时两次解析逐值相等，`toEqual` 分不出来源。**反测已跑**：改回 `preview.entries` 后 `toEqual` 照样绿、identity 当场红。
- **比桌面好一处**：`ImportSourceChangedError` **带着新解析出来的文件**。桌面收到 `IMPORT_SOURCE_CHANGED` 后再发一次预览请求（`ImportPlaylistDialog.tsx:148`）= 同一个文件的**第三次**读取，而且两次读之间还有一个能再变一次的窗口；手机的提交手里已经有新解析，直接退回预览。
- **suspects 按决策 d**：点行展开、单选，行上永远写着当前选择；**默认永远是新建**（R12）。入口按决策 a 放歌单 tab 顶部「新建歌单」旁——**不进添加 tab**（那是「按链接取新歌」，这是「接过别人的一份单子」）。
- **对桌面的唯一改动是一条测试**（`packages/core/.../transfer.test.ts`），零生产代码——判据 85 的口径继续成立。
- 验证：`just check` exit 0（bundle smoke **115 模块 / 3.2MB**）· `just mobile-typecheck` 通过 · `just test` **3100 passed**（mobile 263 → 266 · core 1337 → 1338）。

**N6c 完成**（撤销设备 + 知情与退路，**判据 93 的逻辑半边关；93 设备半边 · 94 · 102 待真机**）。

- **撤销设备**：按钮在每一行，**已撤销的行没有按钮**（不是禁用的——行上已写着「已撤销」，再放一个只会拒绝的控件要额外解释）。**撤销本机允许**（`routes/sync.ts:152` 故意允许）。🔴 **撤销本机之后不做本地清理**，与 daemon 一致：token 留着直到服务器不认，然后走平常的鉴权路径（下一轮 `noteAuthRequired`）——在这里手写登出等于发明第二种结束会话的方式。
- **确认文案落在 `sync/devices.ts`（纯函数 + 单测）**：一台设备只会显示两条里的一条，「另一条不一样」在设备上问不出来。两条的区别就是**对这台手机的承诺**；两条都不提歌，因为撤销一首歌都不动。
- 🔴 **用户当天加进本批的四条**（讨论「多工作区」时定的暂行方案，子计划 §6 是那次讨论的结论）：**登录表单三段文案**（第一次登录是**合并不是覆盖** · 音频不同步 · 可能留下重复 · 一库只能绑一个账号 · 不登录则曲库只在这台手机上）· **重复条数一行**（`duplicate_source_keys` 早就算出来了，从来没渲染过；行标记按用户决定不做）· **绑定不匹配文案手机化**（共享表那句结尾是 `lark sync unbind`，**手机上没有 CLI 跑它**；只拦这一个 code，桌面文案一字未动）· 🔴 **导出整个曲库（判据 102）——补的是一个真洞**：桌面自 M5 就能导出虚拟 `all`，而手机只能从歌单详情页导出、歌单 tab 又把 `all` 丢了 ⇒ **不在任何歌单里的歌在手机上没有退路**，而新文案恰恰在承诺「导出是你的备份」。
- **v1.1 的账已登记**（子计划 §6）：每账号独立工作区**延后**，理由是风险叠加（动 D16 与启动序列，而 N6d 本身就是一次卸载重装）。四个难点：进程内换库 · **`local_metadata` 要先分成设备级/曲库级**（LLM 的 key 在 SecureStore、url/model 在库里，分库会把一份配置劈成两半）· 缓存上限口径 · D16 per-library。**先做 `local_metadata` 分层**是最合适的起点——它对单库版本零影响。
- 验证：`just check` exit 0 · `just mobile-typecheck` 通过 · `just test` **3104 passed**（mobile 266 → 270）。

**N6d 的电脑半边完成**（签名，**判据 95 · 97 关；96 待真机**）。

- 🔴 **在此之前，`just mobile-android-release` 出的每一个 APK 都是 Android debug key 签的**——Expo 模板默认，而 `android/` 是 CNG 产物不入库 ⇒ **仓里没有任何东西说得出这件事**。现由 `plugins/with-release-signing.js` 接上 `lark-release.jks`：改生成的 `app/build.gradle` 两处（`signingConfigs` 插 `release` · `buildTypes.release` 换 `signingConfig`），**两处都锚在结构上而不是模板注释文字上，锚不到就抛**。
- **密码一份都没被复制**（决策 g 的原话：不进仓库 / `gradle.properties` / 环境文件 / CI）：**穿过环境的是目录**（`ORG_GRADLE_PROJECT_LARK_KEYSTORE_DIR`，Gradle 自动变 project property），**密码由 Gradle 在签名时自己读那个 0600 文件**。
- 🔴 **降级是真实存在的，靠读产物的守卫兜住**：没有 property 时 release 仍用 debug 配置（不能在配置期拒绝，否则每个 debug 构建和每次全新 clone 都炸），所以 `mobile-android-release` 构建完**当场跑 `just mobile-verify-apk`**。**读产物的守卫骗不过一个没跑起来的插件。**
- **判据 95 绿 + 反测跑过**：`prebuild --clean` → `assembleRelease` → 证书 `38544c9f…f63d`，与 N0 子计划 §9 逐字符相同；**去掉 property 重建仍然 BUILD SUCCESSFUL**（这就是它危险的地方），产物是 debug key `fac61745…`，校验当场红。校验对**所有签名者去重后**比对。
- **判据 97 落定：不注册 developer verification**（依据进主计划 D14）——只在 GitHub Release 挂 APK、不进商店，adb 侧载明确豁免，2026-09-30 只覆盖四国参与商店；相关日期仍是 2027 全球扩大，到时再复查。
- 🔴 **判据 96 的硬前提**：机上现在是 debug 签名，换签名 ⇒ **装不上，必须先卸载**，而卸载会清空私有目录与 SecureStore。顺序：**先同步到待推送 0 → 卸载 → 装签名版 → 重新登录 → 看全量 backfill**。⚠️ **这次装包用 `adb install` 手动来，不走 `expo run:android`**——它遇到签名不一致可能自己提出卸载重装，那会不声不响清掉曲库。
- **实测取证（2026-08-26）**：从机上 pull 下来的 APK 证书是 **`fac61745…`**，与「去掉 property 重建」那次反测产出的指纹**逐字符相同** ⇒ **现装的确实是 Android debug key 签的**，「必须先卸载」不是假设。

🔑 **2026-08-26 范围修订（用户）：「每账号独立工作区」从 v1.1 提前到「本批真机会话之后、发版之前」**，记作 **N7**，开工前单出子计划。**这个排法把原先担心的风险叠加拆开了**：先用一次真机会话证明 D16 与全新安装那条路是通的（判据 96），拿到一个已知良好的干净安装，再动换库代码，它自己另有一次验证。仍然成立的代价只有一条——**第一个签名 APK 会带着一批刚写完的换库代码**，所以那一批的验证不能省。**起点不变：先做 `local_metadata` 分层**（设备级 / 曲库级），它对现在的单库版本零影响。发版顺序因此变成 **N6d 真机 → N7 分账号曲库 → N6e 文档大整理 → 发版**。

**N6 真机会话完成（2026-08-26，AI 驱动，一次会话关掉六条）——判据 86 · 87 · 92 · 93 · 94 · 96 · 102 全绿**（详见子计划 §5.5）。

- 🔴 **判据 86 让 N0b-3 的「出口 B」彻底作废**：2MB **p95 2ms** · 20MB **p95 13ms**。当年按纯 JS 估的是 ~3MB/s（2MB 660ms），原生 `expo-crypto.digest` 是 **~1.5GB/s，快约 500 倍**。
- **判据 87**：`expo-crypto` / `@noble/hashes` / `shasum` **三方对同一段字节给出同一个 hex**。
- **判据 96**：卸载重装后 **0 首** → 登录 → 收敛回 **18 首 · 2 歌单**，音频 7 → 0（全部「需要下载」），**设备 ID 换新**（旧的成了僵尸条目）。取证：机上旧 APK 证书 `fac61745…` = 反测那把 debug key，**「必须先卸载」是实测**。
- **判据 92**：桌面导出 → 手机导入 → **复用 4 / 新建 0**（key 全命中）→ 点一首没有文件的歌 → ensure-file 取回并从头播。
- 🔴 **判据 102 带出一条新行为**：手机导出的 `all.lark-playlist.json` 与桌面同一份 18 首**逐字段相同，只有一首 `duration` 差 0.00066s**（`470.742` vs `470.741338`）——**正是本次唯一下载过的那首**。⇒ **手机下载完会用 MMR 的时长覆盖 `duration`（毫秒粒度），并把它作为一条同步更新推给 workspace**。N0b 量过「MMR 与 ffprobe 逐毫秒一致」，但没人记过这个差会变成同步流量。**无害，按现状接受，只记录。**
- **判据 93 / 94**：两条确认文案在设备上确实不同（「这台手机不受影响」vs「**这台手机会被踢下线**」+ 按钮「撤销」vs「**撤销本机**」）；撤销后那一行变 `已撤销` 且**按钮消失**（5 台设备只剩 4 个按钮）；撤销本机后紧跟的刷新**被服务器拒绝并如实写在屏幕上**（`device list was refused: token is invalid or revoked`），跑一轮同步后落到 **需要登录 +「登录已失效（服务器拒绝了保存的凭证）」**——与普通登出的文案不同，不是静默失败。
- **收尾**：设备临时 dump 已删 · Gradle daemon 已停 · 无 `adb reverse` 残留。⚠️ **手机现处于登出状态**（94 的代价），且 **LLM API Key 随卸载丢失**，都要用户手动补。

**设备列表只显示 lark**（2026-08-26，用户提）：设备是**按账号**注册的，owl 的两台一直混在里面。`appVersion` 是唯一能分辨的字段（lark 在 `coordinator/login.ts:283` 写 `lark <版本>`）。两条规则：`lark …` 显示；**`appVersion` 为 null 也显示**——证明不了它不是 lark，而这个列表正是「我不再信任某台设备」的去处，往那个方向猜错等于把人要找的东西藏起来。**被滤掉的计数并说出来**（它们持有同一个账号的凭证）。单测用手机真实返回的那五条 + 两个边界。桌面那份**也要改**（用户同意），并进 N7。

### N7 每账号独立工作区（开发中）

**子计划 `docs/plans/2026-08-26-phase-b-mobile-n7.md`（v2）**，七批 **N7a–N7g / 判据 103–123**。**执行顺序：N7 → N6e 文档大整理 → 发版。**

🔑 **蓝本是 owl**（`../owl/packages/core/src/profile/`），六条照抄：① **workspace id = `sha256(serverId + "\n" + userId)` 取前 32 hex**（确定性 ⇒ 同一账号永远落回同一份）· ② **锚是 `server_id` 不是 URL**（换部署/换 URL 不变，32 hex 宽度一旦落盘就冻结）· ③ 保留 id **`local`**（从没登录过的那个）· ④ **零迁移是明写的设计**（`config/paths.ts:53`：老库原地不动当 local，账号库在 `profiles/<id>/`）· ⑤ **并入 = 整库 COPY 绝不 move**（同步永不写 local 库）· ⑥ 桌面多一整块 **switch-lock**（原子写 + owner nonce + pid 存活 + 30s TTL；多进程才需要，手机不需要）。

**用户 2026-08-26 定的五条**：**桌面也一起做**（含设备列表过滤）· **手机不做迁移**（读法 B，旧数据不管，反正能重装重拉；**只有桌面做一次简单迁移**——已绑定的 nest 库按 `sync_binding` 算出 id 后移进 `libraries/<id>/`）· **切换要确认框**（「切换账号需要重启应用，同意/取消」）· **统一缓存上限口径**（显示当前/其他工作区占用，**优先清其他工作区里没固定的**）· 🔴 **设置里的中文说明要跟着改**（N6c 那句「一个曲库只能绑一个账号…只能清除应用数据重来」改完就是假话，判据 **118** 守着它）。

**三条去风险的事实**：**schema 不动**（工作区是库外面的一层，没有 v4）· **`readCacheLimitMb` 等七个读取器在桌面的调用处各为 0**（已实测 ⇒ N7a 对桌面零影响）· **跨工作区清理只删文件不写库**（`has_file` 是探盘得来的，别的库只读打开即可）。

🔴 **判据 122：本批大改桌面 ⇒ accept 全系列（126 条）不可省**，也顺带兑现 N1 判据 22 的旧账。

- **N7a 手机的设备级设置层：完成（判据 103 · 104 · 105 全关，测试 3123）。** §4 表里的六个设置从 `local_metadata` 搬进 `<nest>/device.json`，桌面**零改动**。
  - **`DeviceSettingsPort` 是一个字符串 KV**（`portable/ports/device-settings.ts`），形状与它替换掉的那张表逐条相同：不认识的键忽略、缺的键就是默认值、含义变了的值换新键。**六个读取器一个 parse 都没改**，改的只是字节在哪。
  - 🔑 **读同步、写异步**，这不是折中而是两端的真实形状：设置表单在 render 时读、下载引擎每个任务读一次（`getLlmConfig: () => LlmConfig`，没有 Promise），而「写到落盘」在这个宿主上就是**换掉一个文件**（`writeTextAtomic` → `modules/lark-fs`，决策 a）。于是实现是「构造时读一次进内存，`set` 时先落盘再改内存」。
  - 🔴 **内存跟着磁盘走，不许领先**：设置页保存后会**回读**（`settings-tab.tsx` 两处），先改内存就等于把一个下次启动会消失的值报成「已保存」。三个没有表单可回话的写入点（播放模式 · 蓝牙歌词开关 · 命名模式记忆 · 明文开关）改成 `void … .catch(log)`——**播放器回调里的 unhandled rejection 会带走整个 app**。
  - **写入排队**：两个设置在同一口气里保存，不排队就是两次「整份替换」互相盖掉，赢的那次少一个键。测试用一个挂住的第一次写证明第二次是**接在第一次结果之上**的。
  - **`⑩b` 进了冻结启动序列**（`boot/sequence.ts`）：位置在**身份门 ⑤–⑩ 之后、drain ⑪ 之前**——⑤–⑩ 是「这个库归谁」一个完整的故事，搬设置没资格插进去。**先写 device.json 再删行**，与 ⑤ 先于 ⑥ 同一个理由：两者之间崩掉，下次启动看到「行还在、值已经在文件里」⇒ 保留文件的那份、删行、什么都没丢（`device-settings.test.ts` 有这条）。**永不覆盖设备已有的答案**——第二个库里的那些行是别人写的（converge 过来的恢复，或另一个账号的副本）。
  - 🔴 **判据 105 差点没地方验**：`ports/device-settings.ts` 一旦 `import` 了 `./paths` 就会拉进 expo-file-system，Node 下加载不了，「文件缺失/空/坏 JSON」就只能上真机——而这三个状态在 app-private 目录里**根本没法用 adb 摆出来**。所以**四行碰盘的代码留在 boot**（`load` / `save` 两个 thunk），判定留在能加载的文件里。**同一课第三次**（N5 的 `ports/events.ts` 与 `sync/triggers.ts` 是前两次）。
  - **判据 103 实测**：`git diff` 对 `packages/gui` / `packages/daemon` / `apps/cli` **零改动**；`packages/core` 只有那六个模块 + 两个 barrel + 新增的三个文件。**N7 子计划 §4 那条「桌面调用处各为 0」是真的。**

- **N7b 身份与布局：完成（判据 106 · 107 全关，测试 3179）。** 纯函数 + 两端布局 + 桌面索引读写，**没有任何入口的行为改变**（`dbPath()` 仍然回 `lark/songs.db`，改路由是 N7c）。
  - 🔑 **判据 106 是拿 owl 的构建产物当夹具的**：`node -e "require('../owl/packages/core/dist/profile/id.js').computeProfileId(...)"` 跑出 7 组 (server_id, user_id) → id，**把结果钉进 `workspace.test.ts`**。钉死而不是运行时 import 另一个仓——跨仓 import 在那个仓不在时会「通过」，两仓分开打包的那天就什么都不再证明。**lark 用 `@noble/hashes` 的 sha256、owl 用 `node:crypto`，逐字节同结果**。
  - **`computeWorkspaceId` 落在 `@lark/core/portable/workspace.ts`，不是子计划写的 `@lark/shared`**：① 它不纯——要 sha256，而 sha256 在 `portable/runtime/digest.ts`；② **workspace id 从不上线**（server 完全不知道 workspace 这回事，这是本机存储布局的决定），而 `shared` 是线协议包。CLI 也不需要它——CLI 只需要「打开哪个库」，那是 `paths` 层的事。
  - **一处与 owl 有意的不同：空输入拒绝**（owl 照哈希）。空的 `server_id`/`user_id` 不是账号，是一条少了字段的登录响应，把它变成一个长得很正常的目录名，就是让两次不同的事故共用一个库。
  - **一处如实记下的继承缺陷**：分隔符没转义 ⇒ `('a', 'b\nc')` 与 `('a\nb', 'c')` 同 id。真实 id 是 server 发的不含换行的 token，无害；测试里钉着，让它是个决定不是个惊喜。
  - 🔑 **磁盘是「有哪些工作区」的事实，索引文件不是**（`workspace-index.ts` 抬头）。`libraries/<id>/songs.db` 存在 = 这个工作区存在；索引只存**唯一推不出来的那件事**——`active`——外加标签和 server_url 两项装饰。这样一个坏掉的索引最多值一个名字和一个起点，**永远不会让一个库消失**。判据 107 的落点就是这条。
  - **因此 lark 的门比 owl 的少一道**：owl 查三样（id 合法 · `[profiles.<id>]` 段在 · db 文件在），因为它的 profile db 与凭证在两个文件里，「账号 session + 本地库」和「profile 库 + 旧配置」两种撕裂都可达。**lark 把凭证放进工作区内部**（`libraries/<id>/skybridge.toml`），于是「db 在」与「凭证在」是同一个问题，段检查没有东西可抓。
  - **布局**：设备级留在 nest 根（`lark_config.toml` · `workspaces.toml` · `device.json` · logs · token · pid），工作区级进 `workspacePaths(id)`（db · songs · trash · recovered-songs · migration-backup · **skybridge.toml**）。**`local` 的七条路径与今天逐字节相同**——测试直接断言 `workspacePaths('local').db === dbPath()`，那不是巧合而是零迁移承诺本身。
  - **TOML 的一个坑先量过**：全是数字的 32 hex（`0123…01`）当 TOML bare key 会不会被读回成数字 —— smol-toml 回的是字符串，测试钉着。
  - **backup 顺带补一条**：`skybridge.toml` 的排除一直是**按 basename 每一层**，所以 `libraries/<id>/skybridge.toml` 自动就排除了（补了断言钉住）；新增 `.workspaces.toml.tmp-` 的排除——**索引文件本身要备份**（它是指针和标签不是 token，恢复出来的 nest 应该落回原来的工作区），**半个不要**（半个读作 `local`）。

- **N7c 桌面接线：完成（判据 108–111 全关，测试 3228 + sync e2e 19）。** resolver 单一收口 · switch-lock · 一次性迁移 · 设备列表过滤，四件。
  - 🔑 **收口点就是 path 函数自己**。`dbPath()` / `songsDir()` / `trashDir()` / `recoveredSongsDir()` / `migrationBackupDir()` / `skybridgeConfigPath()` 全部改成走 `activeWorkspacePaths()`，于是三个入口**一行都没改**就都过了 resolver——因为**根本没有「旧路径」可绕**：`lark/songs.db` 只能拼成 `workspacePaths('local').db`。守卫 `check-workspace-chokepoint.sh`（进 `just check`）说：**除 `paths.ts` / `backup-nest.ts` / `db/fixture-go-db.ts` 外，代码里不许出现字符串 `'songs.db'`**（只配引号内，散文用反引号所以注释不受影响）。
  - **门只有两问**（id 合法 · 它的 `songs.db` 在盘上），比 owl 少一道，理由在 N7b 那条。**失败一律回落 `local` 而不是报错**：真库在 `libraries/` 下而索引丢了的设备会开出一个**空库**，看着吓人但什么都没少；反过来「在缺失路径上建一个库」会把新歌写到用户找不到的地方。`verdict.fellBack` 由 daemon boot 打日志，否则那是一次静默的空库。**缓存按 nest 记**（切换=重启，进程内答案不许变；`invalidateActiveWorkspace()` 只有迁移和测试用）。
  - **switch-lock 照抄 owl 三条性质**（原子写 · owner nonce · pid 存活 + 30s TTL）。🔴 **但它在 lark 保护的东西不一样**：lark 的「切换」只是写一行 active 然后重启，那个窗口没什么可抢的；**真正需要它的是「整库搬家」**——本批的一次性迁移，和 N7e 的登录并入（整库 COPY）。两者都会有几秒钟「库在半路上」。CLI direct **两种模式都拒绝**（`WORKSPACE_SWITCHING`，exit 5）：read 不加锁也不写，但**读半个库还是半个库**。
  - **迁移是「可续」而不是「原子」**：要搬的是好几个条目，文件系统没有一次搬多个的办法；**单个 rename 是原子的**，所以任何一刻每个条目都在源或在目标、绝不在中间——journal 补的是「这一组该在哪一边」。六步顺序 + 每步崩掉的代价写在文件抬头。**判据 108 的测试是在函数里挖 seam 打断**（四个点各一次），不是手工摆出「搬了一半」的目录——摆出来的状态只能证明摆法能收敛。
  - 🔴 **本批实测到一个会卡死的坑：WAL sidecar 不能跟着搬**。`songs.db-wal` / `-shm` 属于某一个 db 文件，没法和它一起原子重命名，而**任何只读连接都会在 WAL 库旁边新建一对且关闭时不删**（M6 在 backup 里量到过）。于是「崩在半路 + 有人看了一眼」就会让 sidecar 两端都存在，而拒绝覆盖的 mover **永远收敛不了**。修法是**根本不搬**：搬之前 `wal_checkpoint(TRUNCATE)` + 干净关闭，什么都不剩。有一条专门的回归测试（崩 → 用只读连接去读半搬的库 → 再跑，必须收敛）。
  - **迁移的触发条件是「库的性质」不是一次性开关**：`workspaces.toml` 不存在 · 根上有 `songs.db` · 它有 `sync_binding`。**没绑定的库一个字节都不动，也不写索引**（所以全新 nest 与今天逐字节相同）。目标已存在则**大声拒绝、两个都不动**——合并两个库没人能撤销。
  - **顺带修好三处会被迁移打破的地方**（不是新功能，是同一改动的必然后果）：① **`backup-nest`**——它还假设库在 nest 根，迁移之后 `fileMustExist: true` 会当场抛。现在**活动工作区走 sqlite online backup，其他工作区文件级拷贝**（daemon 已停 + 写锁在手，且一进程只开一个工作区 ⇒ 别的没有 writer 要冻），并且**锁文件的排除扩展到每一层**。② **`sync.files.e2e`**——B 登录即绑定，下一次启动库就搬走了，`openBDatabase` 于是在根上**新建了一个空库**（症状是 `no such table: sync_file_ops`）。③ **三个 accept 脚本**（sync / cli / m5）手工拼库内路径的地方，统一走新的 `scripts/lib/workspace.mjs`。为此 core 多了一个 `activeWorkspaceRootIn(larkDirPath)`——`resolveActiveWorkspace()` 读的是本进程的 `LARK_NEST_DIR`，而这些调用方同时驱动两个 nest。
  - **判据 111 的判定搬进 `@lark/shared/sync-devices.ts`**（`isLarkDevice` / `splitLarkDevices` / `hiddenDevicesNote`），手机原来的 `larkDevices` 删掉改成调它——**两端一份，连那句「另有 N 台…」的文案都是同一份**。桌面的夹具原本写 `app_version: '0.2.0'`（**过时且不真实**，注册真正写的是 `lark <version>`），改对之后两条老测试才继续绿。

- **N7d 手机接线：完成（判据 113 · 114 的电脑半边关闭，测试 3247；判据 112 的真机半边留到 N7g）。**
  - 🔑 **手机侧的隔离保证是一个函数**：`libraryDirectory()`。`ports/paths.ts` 里除了四个设备级文件（`device.json` · `workspaces.json` · `libraries/` · nest 本身），**其余全部改成挂在它下面**——songs / trash / recovered-songs / 每首歌的目录 / `openDatabaseSync` 的目录 / **D16 探针的复制**。守卫 `check-workspace-chokepoint.sh` 扩到手机：**除 `ports/paths.ts` + 两个 acceptance scratch 之外，谁都不许 import `nestDirectory`**（反测过：往 `db/open.ts` 塞一行就红）。
  - 🔴 **SecureStore 的键必须按工作区分，而 `local` 必须保持原样**（`identity/keys.ts`）。两条理由不同量级：共用 `lark.skybridge` ⇒ **converge 一个库会把另一个库登出**（converge 就是 `credentials.delete()`）；共用 `lark.install_id` 更糟——读到别的工作区的 committed id，正是「有库没身份」那个签名，**会去 wipe**。而如果 `local` 也改前缀，**现有手机升级上来会找不到自己的身份 → 直接 converge → 把没人碰过的库的 outbox 清掉**。所以 `workspaceKey(base, id) = id === 'local' ? base : base + '.' + id`，**§2.4 的「手机不迁移」在这里是数据安全而不是省事**。
  - **`lark.llm.api_key` 明确不分工作区**（`DEVICE_SCOPED_KEYS` 把它写出来，让「不在那张表里」是个决定而不是遗漏）：§4 把模型判给设备，而 key 是其中唯一不能进 `device.json` 的那半（明文文件不放密钥）。**tsc 自己就拒绝比较那两个字面量联合**——比运行时断言更强的证据。
  - **两块判定搬进 portable，两端共用**：① `workspaceSegments(id)`（`local` = `[]`、账号 = `['libraries', id]`）——桌面 `join(larkDir, ...segs)`、手机 `new Directory(nest, ...segs)`，**布局只有一份定义**，判据 114 的结构性半边就落在它的测试上（两个工作区的段互不为前缀）；② `decideActiveWorkspace(index, hasLibrary)`——门的两问，`hasLibrary` 由宿主填（`existsSync` / `File.exists`）。**又是「wiring 归装配根、判定留在能加载的文件里」那一课**，这次是主动应用而不是被咬之后补。
  - **boot 多了 ①b**：`activeWorkspaceId()` 在任何东西看路径之前跑一次，然后**一路手传**给 `readCommitted` / `readIntent` / `writeIntent` / `commitIdentity` / `createSecureCredentialStore`（这些函数的默认值就是它，但决定认领哪个库的序列应该看得见自己在点名）。`BootResult` 多一个 `workspace` 字段。
  - 🔴 **给 N7e 的一条硬约束**：`activeWorkspaceId()` 的门要求**目标库的 `songs.db` 已经在盘上**，否则回落 `local`。所以「新建工作区」和「并入」都必须**先把库放好、再翻 active**——顺序反了会得到一个静默回落到 local 的切换。
  - **判据 114 的电脑证据到此为止**：`workspaceSegments` 的两端共用测试 + SecureStore 键互不相交 + 守卫证明每条库内路径只有一个出口。**「A 的歌在 B 里看不见」这句话本身要等 N7e 能造出第二个工作区之后，在 N7g 的真机会话上看**——如实记着，不假装电脑侧已经证明了它。

- **N7e-1 工作区的三个原语：完成（判据 115 · 117 关，测试 3267）。** `prepareWorkspace` / `switchWorkspace` / `listWorkspaces`+`inspectWorkspace`。UI 与登录接线在后面几批。
  - 🔑 **一个被判据逼出来的形状：登录的安装必须跑在「目标工作区」上，不是当前库上。** 推导链条是硬的——判据 116 要求「新建工作区」时**原工作区一条 `sync_changes` 都不多**，所以登录不能先绑当前库；判据 117 要求「并入」之后**原工作区仍然完整可用**，所以也不能绑了当前库再搬走。⇒ 顺序只能是：**远端登录（拿到 server_id/user_id ⇒ 算出 id）→ 备好目标工作区 → 在目标上跑 bind/backfill → 翻 active → 重启**。工作区 id 在登录之前算不出来，这是整条链的起点。
  - **并入的范围：数据库 + 音频一起复制**（用户 2026-08-26 定）。§6 那句「重复下载可接受」本来指向更便宜的「只复制数据库」，但那样一并入，本机所有歌都变成「需要下载」——一次账号操作换来整库重下，不合理。磁盘翻倍由 §2.6 的统一上限兜着（清理优先清其他工作区）。
  - **`prepareWorkspace` 在暂存目录里造、造完一次 rename 到位**。`libraries/<id>/` 正是 `decideActiveWorkspace` 的判据，所以它**绝不能半成品地存在**；目录 rename 到一个不存在的名字是原子的，崩了留下的 `.incoming-<id>` 只是垃圾，**不叫任何工作区、也挡不住任何事**（`isAccountWorkspaceId` 认不了带点的名字）。数据库走 **sqlite online backup 而不是 `cp`**——调用方是 daemon，daemon 就是写者。
  - **`switchWorkspace` 只写一行，别的什么都不做**，这正是它安全的原因：进程继续服务已经打开的那个库（`resolveActiveWorkspace()` 每进程只判一次）。所以「重启才生效」不是功能没做完的托词——§3① 列的四个一次性闸（引擎 claim registry · 同步会话 · 播放器会话 · file-op runtime）加上 expo-sqlite 的 Activity 重建坑，全长在换库这条路上。🔴 **它拒绝指向一个还没有库的工作区**：那样会被门回落到 `local`，得到「看起来切成功了、然后是个空库」——所有失败里最坏的一种，所以「先备库、再翻 active」是唯一存在的顺序。
  - **`listWorkspaces` 列磁盘、用索引装饰**（与 N7b 的「磁盘是事实」一致），并借 owl 的 `hasSyncTraces`——`sync_cursor` / 推过的 change / 存过的 skybridge id——给判据 116 最后那句警告备好判定。⚠️ **如实记一条副作用**：只读连接打开 WAL 库会**新建 `-wal`/`-shm` 且关闭时不删**。那不是改数据，但文件确实会出现；下游都是知道这件事写的（迁移用 checkpoint 而不是搬、备份直接丢掉它们）。

- **N7e-2 daemon 接线：完成（判据 116 · 117 在路由层关闭，测试 3280 + e2e 19）。** 协议 **`LOCAL_API_VERSION` 6 → 7**。
  - **登录多了一处 seam：`resolveTarget`**（`portable/coordinator/login.ts`）。位置是**远端登录之后、第一次本地写之前**——那也是唯一可能的位置（工作区 id 是 `sha256(server_id + "\n" + user_id)`，两半都随登录响应到达）**和唯一安全的位置**（之前什么都没写，之后全是关于某一个库的）。缺省不传 = 「装在这里」，也就是它一直以来的含义。
  - **daemon 侧 `performWorkspaceLogin`**：算 id → 已有就直接用、没有就 `prepareWorkspace` → **打开目标库、取它自己的写锁、造一个一次性的 `CoordinatorContext`** → core 的安装序列一个字没改地跑在上面 → 翻 active。**唯一保持原样的情况是「重新登录进已经打开的那个工作区」**：没有第二个库要备，而且 daemon 已经握着那把写锁，再开一个句柄会自己和自己抢。
  - **一次性 context 的两个刻意选择**：`SyncRuntime({triggers:false})`（这个 runtime 只活一次安装，后台轮次会变成一个进程里的第二个同步器）· **`fileOps` 是一个会抛的绊线**——登录只写 binding/backfill/rebase/device stamp，**不排也不 drain 任何 file effect**；桌面的 `FileEffectRuntime` 用的是模块级的 `recoveredSongsDir()`，那是**活动工作区**的，一旦有人真调它就会隔离到错的库里去。
  - 🔴 **本批修掉一个自己刚写出来的严重 bug**：`switchWorkspace` 原本会 `invalidateActiveWorkspace()`。那会让**同一个进程后续所有的 `songsDir()` / `trashDir()` / `skybridgeConfigPath()` 指向新工作区，而它服务的还是旧库**——一边播旧库、一边把歌和凭证写进新库。现在它**只写那一行，别的什么都不碰**；缓存就是「这个进程打开了哪个库」，必须冻结到进程结束。**判据 115 的「不半切」正是「只做一件事」的直接结果。**
  - **由此长出一个区分**：**`serving`（这个 daemon 打开的） ≠ `active`（下次启动会打开的）**，两者从有人切换到他重启为止都不一样，而那恰恰是切换器必须说实话的窗口。`serving` 记在 `AppContext.workspace` 上（boot 与测试 harness 各记一次，不靠「谁先 resolve」这种隐式顺序）；`listWorkspaces` 的 `active` 改成**过一遍索引的门**算出来。
  - **路由**：`GET /workspaces`（列表 + `serving` + `serving_has_sync_traces`）· `POST /workspaces/switch`（回 `restart_required`）· `POST /sync/login` 收 `workspace_origin` 并回 `local_workspace_id` / `local_workspace_created` / `restart_required`（**`workspace_id` 已经被服务端的 workspace 占了**，所以本机那个只能另起名字）。
  - 🔴 **e2e 抓到了这条链最真实的一段**：`sync.files.e2e` 里 B 是个真子进程，登录之后**它服务的还是 `local`，而账号的库在 `libraries/<id>/`** ⇒ 歌词落在了测试没看的那个目录里。修法不是改断言而是**照用户会做的做：登录后重启 B**。于是这套 e2e 现在跨真进程边界证了整条路——从 `local` 登录 → 并入建库 → 重启 → 在新工作区里同步、drain、隔离、重启后仍然如实。

- **N7e-3 桌面 UI / N7e-4 手机 UI / N7e-5 文案：完成（判据 115 · 116 · 117 · 118 的电脑侧全关，测试 3287）。** 真机那一半留 N7g。
  - **两端的切换器都显示两个事实**：`serving`（这个进程打开着的）与 `active`（下次启动会打开的）。**它们从有人切换到他重启为止都不一样**，而那正是切换器必须说实话的窗口——桌面写「（正在使用）/（重启后使用）」，手机同。
  - **确认框的措辞是让这件事可理解而不是吓人的关键**：「切换只是改一行记录，现在打开的曲库不会受影响……在那之前正在播放和正在下载的都照旧」。**同意才写**（§2.5）。
  - **桌面能自己重启**（`app:restart` IPC → `app.relaunch()` + `app.quit()`）：`relaunch` 只登记「退出之后做什么」，所以走的是**普通退出序列**——窗口尺寸照样落盘、自己起的 daemon 照样停。否则会留下一个握着写锁的 daemon，正好挡住新进程要开的那个库。**手机不能**，所以文案是「完全退出 lark 再打开一次」。
  - **登录二选一默认「并入」**，因为登录一直以来就是这个意思。**owl 的 B8 警告接上了**：判定 `hasSyncTraces` 提进 `portable/sync/traces.ts` 两端共用——桌面只读打开别的工作区问它，**手机只能问自己已经打开的那个库**（这个宿主根本没有只读打开）。
  - 🔴 **手机的 `prepareWorkspace` 比桌面多一件必须做的事：在工作区出现之前就给它认领一个 D16 身份**。不然第一次启动进新工作区时，会看到「一个带着别人 `install_id`、自己没有 committed 身份的库」——**那正是恢复过的备份的签名**——于是 converge，把刚写进去的绑定和凭证一起清掉。顺序照抄冻结的启动序列：**SecureStore intent → 库 → commit**，而且**整件事在 move 到位之前完成**，所以工作区只会「带着身份」出现。
  - **手机的列表不显示歌曲数**，这是决定不是遗漏：数一下就得打开库，而这个宿主**没有只读打开**（`SQLiteOpenOptions` 没有那个 flag，打开 WAL 库可能触发恢复与 checkpoint）。桌面能便宜地问是因为 better-sqlite3 有 `readonly: true`。诚实的选项只有「为了数行复制整个库」和「不数」，设置页的一个列表不值得前者。
  - **判据 118**：两句假话都改了（登录前那段说明、`SYNC_BINDING_MISMATCH` 的报错），并加了**守卫**——`check-workspace-chokepoint.sh` 现在还禁「清除应用数据重来 / 不能改绑 / 只能绑一个账号」这类措辞（反测过：塞回去就红）。一个真了两个里程碑的句子，正是最容易被抄回来的那种。

- **N7f 缓存统一口径：完成（判据 119 · 120 · 121，测试 3298）。** 真机那一半（119 的显示）留 N7g。
  - 🔑 **跨工作区清理就是同一个 `runEviction`，指向别人的库**。这一点是本批最大的省事与最大的安全来源：`runEviction` **只 SELECT**（`has_file` 是探盘不是列，删完没有行要更新），所以把它指向一个本进程不拥有的库是安全的——**判据 121 因此是构造性的，不是靠小心**。每一条不变量也就自动成立：imported 永不清（R1）· 探不通就留着（R26）· 固定的不动 · LRU 顺序。**给「别人的库」写第二套实现，正是让这些漂移的方式。**
  - **`runEviction` 多了一个 `targetBytes`**：设备级预算下，一个工作区的「份额」不是它自己的上限，而且「从这个库里腾出 300MB」用 limit 根本表达不了（0 是「不限」不是「清空」）。所以两者分开：`limitBytes` 说有没有上限，`targetBytes` 说这一趟停在哪。
  - **外来工作区的实时排除项是常量 `false`**，明写而不是继承本进程的：一进程只开一个库，所以别的工作区里没有东西在播、在流、在下载；而**继承本进程的排除项会因为「本库里有个同 id 的歌在播」而悄悄保住别的库的文件**（有测）。
  - **顺序是用户定的那条，也是善意的那条**（§2.6）：先清其他工作区，人正在看的那个库的文件留到最后——那也正是接下来一分钟最可能被按下播放的音频。
  - **两端打开外来库的方式不同，如实记着**：桌面 `readonly: true`（**这不是装饰**——判据 121 靠它在代码之上成立）；**手机没有只读打开**（`SQLiteOpenOptions` 没那个 flag），所以是普通打开、**不调 `prepareLibrary`**（不跑迁移）。仍然成立的是「不写行」；一次打开能对文件做的只有 SQLite 自己的家务——把 kill 留下的 WAL 恢复掉、并留下 `-wal`/`-shm`。那是修复不是改内容，**桌面的只读打开也一样会留下 sidecar**。
  - **打不开的库跳过而不是报错**：调用方是一个设置页的数字或一次后台清理，一个读不了的库不该让整台设备既报不出、也回收不了自己剩下的磁盘。
  - **UI 两端都显示两行**（当前曲库 / 其他曲库 + 「清理时先动这些」），手机那边顺手把两次遍历**并成一个 memo**——`view` 是「有东西变了」的信号，分成两个 memo 会让它在其中一个里成为无用依赖（biome 抓到了，改成一次走完更诚实）。

- **N7g-1 桌面 accept 全系列：判据 122 关闭（2026-08-26，测试 3300）。** 五套 **128/128**（原计 126，accept-sync 多了两条，见下）。**这同时兑现了 N1 判据 22 的旧账**——桌面自 v0.3.0 之后被改了六轮，一条验收都没跑过。
  - `just accept-cli` **27/27** · `just accept-gui` **15/15** · `just accept-m5` **22/22**（真 bilibili）· `just accept-sync` **36/36**（真 server + 两台 daemon + 真 GUI）· `just accept-pack bundled` **28/28**（对本批新建的 `Lark-0.3.0-arm64.dmg` + `orpheus-aviary-lark-cli-0.3.0.tgz`）。
  - 🔴 **它抓到了一个真 bug，而且是最贵的那种形状：CLI 让用户去跑他刚跑成功的那条命令。** `accept-sync` 的 D4 红在 `pending 102, pushed_seq 0`，E1 跟着塌成 0/9。最小复现逐字是：`lark sync login` 退出 0 并打印「已登录 / 首次绑定，已排入回填」→ 紧接着 `lark sync status` 说「**状态：需要登录（还没有登录）· 绑定：未绑定**」→ `lark sync run` 退出 3 `SYNC_AUTH_REQUIRED`，正文是「run `lark sync login` first」。**机制全对**：`local` 永远不可能哈希成账号的 id，所以首次登录必然在 `libraries/<id>/` 备一个库、装进去、翻 active，而 daemon 还开着原来那个（`serving` ≠ `active`，形状 ②）。**坏的只是交代**——`restart_required` / `local_workspace_id` / `local_workspace_created` 三个字段一路铺到了 `SyncLoginResultData`、铺到了 CLI 的测试夹具，**GUI 读了并弹「重启后打开这个账号的曲库」，CLI 一个都没印**。修法是 `reportLogin()`（从 `runSyncLogin` 里提出来，否则 biome 的认知复杂度 16 > 15）：新增「本机曲库：<id>（这次新建）」一行，末尾两行讲清「重启一次才会切过去」+ `lark stop-daemon`。两条单测，反测已跑（撤掉源码改动两条同时红）。
  - **accept-sync 从 34 条变 36 条**，两条都是这次逼出来的：**D3b** 断言登录如实回答「装在别的库里 + 需要重启」；**D3c** 是**判据 117 第一次在真实曲库上拿到证据**——并入之后 `local` 的歌一首不少、且**没有** `skybridge.toml`（装在原库上的话两半都会假）。harness 相应地在登录后**照用户会做的那样重启 daemon**（A 与 B 各一次；B 的 `local` 是全新空库，同样不是账号库）。
  - **accept-pack 的两条红是判据滞后，不是产品问题**：N7 把 `LOCAL_API_VERSION` 抬到 **7**（两条 `/workspaces` 路由），而脚本里两处硬写着 `6`。改成一个具名常量 `EXPECTED_API_VERSION` 两处共用（**仍然是字面量**：§9 拿它和源码常量比，两边都读源码就只证明文件等于自己）。`CLAUDE.md` 里那句 `= 6` 一并改了。这正是 M7 记过的坑「判据里的协议版本会滞后」的第二次发作。
  - **harness 的一处卫生修复**：CLI 阶段用 `lark daemon` 起的是**脱管子进程**，脚本的 `finally` 只 `stopChild(daemonA)` 管不到它——上一轮崩在 E1 时就留了个 daemon 占着 47100，而下一轮的 `backupNest` 会因为「有 daemon 在答话」拒绝复制，**报错点离真正的原因十万八千里**（这次真踩到了）。`finally` 现在补一句 `lark stop-daemon`。
  - ⏸ **只剩判据 123 的真机会话**（用户手操，清单在子计划 §9.2）。

- **N7g-2 真机会话（判据 123 关闭，2026-08-26，用户手操）+ 三处跟进。** 清单 §9.2 的八步里，**除了第 5 步（账号 B 新建空库，用户决定先不测）全部通过**：升级不动旧数据 · 并入后当前曲库一首没少 · 重启后进 A 且音频在 · 互不可见 · 设置项不跟着账号跑 · 缓存两行 · 两个库的启动判定都是 `normal`。**三种最贵的失败（空库 / 要求重新登录 / converge）一次都没出现。** 会话中提出的三处，逐条如下。
  - 🔴 **`label` / `server_url` 从来没有人写过**，所以曲库列表只能显示「账号曲库 085de2c3」。索引里这两个字段自 N7c 就在，`nameWorkspace` 也写好了——**全仓零调用点**；唯一写过 `server_url` 的是一次性迁移（`workspace-migrate.ts:291`），而它连 label 都是 `''`，因为它知道服务器不知道账号。**登录是两者同时已知的唯一时刻**，所以两端的 `performWorkspaceLogin` 现在都在那里写一次（core 新增桌面侧的 `nameWorkspace`）。**每次登录都写，包括登录回当前这个库**——那是已有工作区补上名字的唯一路径。**best-effort**：起不了名是装饰性损失，为一个装饰失败掉整个登录不是。桌面有单测 + 反测。
  - **切换与首次登录之后直接结束进程**（用户要求，替掉「请完全退出 lark 再打开」那句提示）。🔴 **必须是进程级退出，`BackHandler.exitApp()` 不够**：它只 finish Activity，而 RN 的 JS 运行时挂在 Application 上 ⇒ `bootOnce` 的 `booted` promise 和 `ports/paths.ts` 的工作区缓存都会活下来，重开会拿回刚被切走的那个库——**看起来就像切换悄悄没生效**，而 expo-sqlite 的缓存句柄是同一件事的下一层（`bootOnce` 本来就是为它存在的）。于是有了第五个自建模块 `modules/lark-app`，一个 `quit()`：`finishAndRemoveTask()` + `exitProcess(0)`。**两处调用各有独立的 catch**——切换/登录到那一刻**已经成功了**，关不掉不等于没成功，退回原来那句提示而不是把成功报成失败。文案同步改了（「同意并关闭」/「lark 会自动关闭一次……只有登录成功才会关」）。
  - **已撤销的设备折叠起来**（N7g-3）。查清楚了它为什么永远在：skybridge **软撤销**，因为 `changes.device_id` 与 `attachments.uploaded_by_device` 都是 `ON DELETE RESTRICT`——写过一行的设备删不掉，否则历史说不清出处；`GET /devices` 不带任何 `revoked_at` 过滤；服务器**没有任何 change 的清理机制**（搜过 prune/retention/compact/vacuum，零）。而且它们**会累积**：`resolveDevice` 把「已撤销」和「已消失」当同一回事去注册新设备（有意如此，复用等于重开一扇刚关上的门）⇒ **同一台手机撤销三次就是四行**。所以是**折叠不是过滤**——这张列表正是用户来确认「谁还持着我的凭证」的地方，直接藏行会答错那个问题。判定进 `@lark/shared`（`splitRevokedDevices` / `revokedDevicesLabel` / `REVOKED_DEVICES_NOTE`），两端共用，5 条单测 + 反测；桌面顺带把设备区提成 `DeviceList`，**`SyncTab` 的认知复杂度从 22 降回线内**（提取前它本来就是 20，超线的 warning）。
  - **两条用户已定的，不是待办**：**账号 B 的新建空库不测**（判据 116 的真机半边就此留白，电脑侧的单测仍在）· **「登录后再问 claim/fresh」不做**——讨论过形状（`resolveTarget` 那个缝天然可以 await 一个 UI 承诺，且它排在 `resolveDevice` **之前**，所以取消是干净的、不会多注册一台设备），但代价是**手机能做、桌面做不了**（daemon 的 `POST /sync/login` 要么挂着等人几分钟，要么改成两步而远端登录跑两次），两端会从此分叉。**彻底删除已撤销的设备同样不做**：真要做绕不开「那些 change 行的 `device_id` 变成什么」这个协议级决定，而 owl 用的是同一个 server。手工清理只对**一行都没同步过**的设备有效（`db/client.ts:30` 真的开了 `foreign_keys = ON`，所以 `DELETE` 语句本身是安全的——删不掉任何不该删的）。

- **N4 全期至此**：N4a–N4h 全部完成，**下一步 N4i**（多选批量 + 行菜单补齐，子计划 `docs/plans/2026-08-24-phase-b-mobile-n4i.md` v1，决策 a–h 待关闭）。🔴 **N4h 记的那条账要更正**：`reidentifySource` **不是**一个按钮（桌面也不是），它在引擎里——`redownload` 与 `ensure-file` 在存下来的 key 探不通时自动调它（`portable/download/engine.ts:824-841`），**而 N4g 把这两条路都给了生产 UI ⇒ 这条账 N4g 已经结清**。桌面「编辑链接…」里的「自动识别」是另一件事（`recognize-url`，不用 LLM），那个才是 N4i 要做的。仍然欠着的三条如实留着：判据 18（6 小时配额无真机证据）· 判据 32 的设备半边 · 判据 31 按标题而非 bvid 比对。

- **N4b 判据 5–14 全部关闭（head `fd38d09`）。** 下一步 **N4c dataSync 前台服务**——子计划已出：`docs/plans/2026-08-21-phase-b-mobile-n4c.md`（**v1 待评审**，三批 N4c-1–3 / 判据 15–22 / 决策 a–j 待关闭）。**开工前必须先答的一件**：`File.downloadFileAsync` 的传输在熄屏时到底跑在哪（§1.6）——答错了整批形状要改（决策 j 的 wake lock 翻面），所以 N4c-1 的第一件事就是量它。




**范围修订：判据 16b（D2D device-transfer restore）搁置**（2026-08-19 用户决定，「这不是第一版软件需要保证的」）——子计划 §8.2 存了原文与接回步骤。**搁置的是验收不是实现**：`<device-transfer>` 的九个 domain 照写（与 `<cloud-backup>` 同一份 xml 的两段），判据 16a 仍逐 domain 验文件内容；不做的是走一遍系统「手机搬家」再断言四类数据没过来，于是**这一半是「声明了但没验过」**。代价可控的理由：D16 的兜底不在排除规则上而在收敛上，**判据 17 注入的正是「OEM 无视排除、DB 真被恢复了」那个夹具且没有搁置**——排除规则失效恰恰是它的前提。N2c 的 gate 因此是 16a / 17 / 18 / 19 四组。

**决策 a–o 已于 2026-08-19 全部关闭**（用户「照建议关」），子计划 §5 是定案。建议里留白的三处由这一轮一并定死：**决策 a** 取自建 Expo native module + **minSdk 升 26**（判据 10⑤ 因此从「API 24/25 模拟器复跑」改成「断言合并 manifest 的 minSdkVersion = 26」，判据 10① 一律走 instrumentation 两线程 + barrier，`AsyncFunction` 只是「别卡 JS 线程」的理由不是验证机制）· **决策 c** 的 config 字段定为 `local_metadata` 的 `now_playing_mode`（值域 `'title' | 'lyrics'`，缺行或非法值一律读成 `'title'` 且不写回，无版本字段——语义变了就换 key）· **决策 o** 的判据 14 走 **normal**（acceptance 导入通道同时写 DB 侧 `install_id` = 本机 committed 值），理由是 converge 会清 binding/sync 并重建 `device_uuid`，把曲库判据的失败和 D16 的失败搅在一起；converge 由判据 17/18 专测。

**v1 的三条 P0 都不是「写漏了」，是「按它实施会红」**（逐条已代码复核）：

- **移动 bootstrap 缺 `device_uuid` → 一切业务写入抛错**：`ensureDeviceUuid` 在 `db/index.ts:145`，签名吃的是 **`BetterSqlite3.Database`**——N1 没把它端口化，它留在了桌面那半；而 `readLocalDeviceUuid`（`portable/sync/changes.ts:100`）缺行即抛，每一次会 emit `sync_changes` 的写入都过它。v1 的六步 bootstrap 只迁移、验 schema、清 pending，判据 11 的契约与判据 13 的全部写路径会在第一次写入时红。→ 下沉为 portable 的 `ensureDeviceUuid(sqlite: SqliteLike)`（uuid 取 Random 端口），桌面 re-export，桌面现有四条测试原样绿是零行为变化的判据
- **「删除只入队不执行」与现有服务和契约直接冲突**：`portable/library/songs.ts:382` 的 `deleteSong` 在事务后**无条件** `await options.fileOps.drain()`，而契约那一例的名字就叫「deleting a song takes its files with it, not just its row」（`contract/cases.ts:255-262` 断言 `!songFilesExist`）。「只入队」「契约 18 例全绿」「删除后目录还在」三条**不可能同时成立**。→ **file-op 执行器与 boot drain 从 N4 提前到 N2**，判据改成「journal 已消费且目录已删除」
- **D16 排在打开原库之后 = 它自己的不变量不成立**：v1 把正常打开与迁移放 N2b、D16 放 N2f，等于让身份门跑在它要保护的东西后面。→ §2.2 **冻结启动序列**：`installPortableRuntime → 源文件在不在 → copy-then-open 身份判定 → 必要时收敛 → 打开原库 → 版本分派/迁移 → ensureDeviceUuid → 服务/UI`；D16 提前到 N2c，N2b 明令不推真实副本。顺带补上 v1 缺的定义（SecureStore key 与状态转移表 · fail-closed 清哪些表 · **不复用 `unbindLibrary`**——它为「用户主动解绑」而写、带 pending 检查且要完整 `CredentialStore`（`unbind.ts:51-67`）· **收敛后 `device_uuid` 必须重建**，否则两台安装共享本机身份）

**另外五条 P1 也都属实**：① 打开协议只写了 fresh 库，而 `db/index.ts:51-58` 有**六类分派** → 补完整矩阵 + 决策「v1/v2 库拒绝而不迁移」；② **判据 10 会假绿**——桌面的「读 400 次」之所以观测得到，是因为 `writeTextAtomic` 是异步的给了事件循环窗口（`node-fs.test.ts:60`），同步 native 调用下同线程轮询恒为真，换成 `moveSync(overwrite)` 也全绿；顺带 **`FileSystemModule.kt:32` 是 `@RequiresApi(O)` = API 26 而 prebuild 实测 minSdk 24**，且 CNG config plugin ≠ Expo native module（前者改生成的原生工程，后者要自己的源码 + autolinking）；③ **真机夹具跑不起来**——`Paths.document` 是私有目录、release 包 push 不进去，两个驱动脚本还硬编码 `com.orpheusaviary.lark.spike`（`drive.mjs:32` / `backup-audit.mjs:28`），且真实桌面 v3 副本天然没有移动端 install_id、推进去会主动 fail-closed；④ **蓝牙歌词的两条回落不可区分**——`parseLrc` 只收带时间戳的行，「没有歌词」与「纯文本无时间戳」都返回 `[]`，五条并成四条；⑤ **「四种排序」没有落点**——`shared/types.ts:57` 只有三个字段，`default`/`duration` 是 GUI renderer 本地逻辑而守卫禁止 mobile import GUI。

**两处数字更正**：`LibraryService` 是 **22** 个方法（v1 写 24、评审说 21，都不对）；契约 **18 例六组**含 cache 1 + transfer 1，所以 mobile hook 必须接 `exportPlaylist` 与 `cacheUsedBytes`，即使这两块的产品功能在 N4/N6。

v1 那条读源码读出来的发现原样保留：

- 🔴 **expo-file-system 57.0.4 在 Android 上没有原子替换**，而 `FileSystemPort.writeTextAtomic` 的合同要求「同目录临时文件 + 原子 rename 覆盖」（`portable/ports/fs.ts:41-61`，N1 §2.4 明写做不到要带回来做决策、不许适配层悄悄弱化）。两条路都堵着：**`moveSync(dst,{overwrite:true})` 先删目标再 rename**（`fsops/CopyMoveStrategy.kt:88-91` 的 `deleteRecursively()`，之后第 95-99 行那句自称 "Fast path: atomic rename" 的 `renameTo` 才跑）——窗口里读到的是「文件不存在」，而 `readText` 把不存在返回成 `null`，也就是**「歌词没了」而不是「歌词是旧的」**；**`rename(newName)` 拒绝已存在的目标**（`FileSystemPath.kt:201` 的 Kotlin `Path.moveTo` 默认 `overwrite = false`）。这正是 N1 §8 预留的那个「单独决策」，成了 N2 的决策 a（建议自建微型 Expo module 走 `Files.move(..., REPLACE_EXISTING, ATOMIC_MOVE)`）。顺带确认**五个端口调用的同步变体都在**（`info()` / `delete()` / `write()` / `textSync()` / `moveSync()`），缺的只有原子性这一条
- **蓝牙歌词进 v1，只做 Android**（2026-08-19 用户决定，主计划 §4.5 已加修订段）：机制是**复用 AVRCP 的 TITLE 字段**（关 = 歌名，开 = 当前歌词行），应用侧不碰蓝牙 API 只写系统 Now Playing。**桌面整个不做**——`MPNowPlayingInfoCenter → AVRCP` 这一跳查不到 Apple 的任何承诺，而桌面只有 mac 一个 target。落点：判定函数（`@lark/shared` 纯函数，唯一有逻辑的地方）+ config 字段 → **N2**；订阅/节流/开关 UI → **N3**。`expo-audio@57.0.3` 的 `updateLockScreenMetadata` 已经是**同步** API（`AudioModule.kt:516` 注册为 `Function`），底层 `MetadataInjectingPlayer` 自带去重，**不需要写原生模块**。**未实测的风险**：AOSP `MediaPlayerWrapper.isMetadataSynced()` 在 queue 非空时比对 queue item 与 metadata 的 (title, artist)，不一致要等 `CALLBACK_TIMEOUT_MS = 2000` 才推——歌词写进 title 正中这个分支。用户**没有带屏蓝牙接收端**，两个实测都不做，先按成熟方案开发

**N1a 的六条实测**：

- **`TextDecoder` 的默认值会静默改掉桌面行为**：它**剥掉** BOM 而 `Buffer.toString('utf8')` 留着，而 `parseAndValidate` 的下游是 `JSON.parse`——它拒绝带 BOM 的文本。照默认写，带 BOM 的导入文件就从「报错」变成「静默接受」。`decodeUtf8` 因此是 `{ ignoreBOM: true }`（这个选项名是反的：true = 保留），BOM 作为第五条 decode 夹具进了常跑测试
- **宽松 base64 有两处 `atob` 之外的分歧**：`Buffer.from(v,'base64')` **遇到第一个 `=` 就停**（哪怕在串中间），且读的是每个 UTF-16 单元的**低字节**——所以夹在中间的 `歌`（U+6B4C）贡献的是 `L` 而不是被跳过。端口按这两条写，20,000 条随机串差分（两套字母表 + padding + 空白 + 非法 ASCII + CJK + 代理对）零分歧
- **守卫的全局 token 半只能读代码**：裸词会红掉「better-sqlite3 hands back a Buffer」这种正确注释；只按代码形态匹配、但不剥注释，仍会红掉 `portable/runtime/base64.ts`——**一个端口必须能说出它在移植什么**。最终形态 = 先剥 `//` 与 JSDoc 再按形态匹配，八条探针（六种代码形态红 / 注释与 JSDoc 绿）
- **`async` 不等于非阻塞，所以整文件 digest 没有缺省**：Promise 包一层同步 noble 照样卡 JS 线程而调用方看不出来。桌面经 core barrel 装 `node:crypto`，移动端在 N6 开放歌单导入前必须自己装，**未装即抛**就是那道门
- **原子写要观测不要断言**：6MB 替换在飞的时候读目标 400 次、每次必须整旧或整新，另一条抓临时文件必须是同目录兄弟（跨文件系统 rename 等于复制，复制就有那个截断窗口）。两条在换成朴素 `writeFile` 时都红——**先把实现换掉跑一遍**才知道测到了
- **Metro smoke 读的是图不是源码**：`expo export:embed` + sourcemap 的 `sources`，1.5s 一次。它能答 rg 守卫答不了的三件事（依赖自己 import 了 builtin / 包的 export map 在 Metro 下解析成另一个文件 / 经 dist 传递进来的 import）。两条反测都点着：portable 里塞 `node:fs` → 报出**具体是哪个 portable 文件**；让一个纯 JS 的 core 模块混进图 → 报出 `download/link.js` 与 `errors.js`。**recipe 必须先 `build-core`**——spike 经 dist 消费 core，源码改了不编译对 Metro 不存在（N0b-5b 同一条）

| 批 | 内容 | 本批 gate | 状态 |
|---|---|---|---|
| Stage-1 | 主计划 §4.3 两处语义修订（N0a 行 c2 收窄 / N0b 收窄为平台 spike ↔ N1 加 R1–R5 与 D5 分段冻结）+ 本段开张 | 单事实源：Stage-1 不做完，N0a 不开工 | ✅ 2026-08-17 |
| N0a-1 | `portable/` 搬迁（schema + migrations + migrate + schema-signature + errors 三类 + `migration/pending.ts`）+ `SqliteLike` + exports + 守卫（判据 1–4、7–10） | `just check` + `just test` 绿 | ✅ 2026-08-17 |
| N0a-2 | DatabaseContract harness（52 例 / 6 组）+ better-sqlite3 文件库包壳 + fake-leaky 反测（判据 5–6） | core 测试绿，假绿检查记录在案 | ✅ 2026-08-17 |
| N0b-1 | spike 脚手架 + 内部包白名单守卫 + workspace 共存（判据 11–13） | **12、13 绿** | ✅ 2026-08-17 |
| N0b-2 | expo-sqlite shim + harness 真机 + migrations/pending + op-sqlite 对照 + drizzle 定案（判据 14–17） | **14、15、17 绿**，D4 出口写定 | ✅ 2026-08-17 |
| N0b-3 | 卡顿 proxy + crypto 定案 + Web 标准全局面清查（判据 18、20–21） | **18 绿** + 20 定案 + 21 清单产出 | ✅ 2026-08-17 |
| N0b-4a | 桌面夹具（音频 + `openAudio()` header 集 + WBI 三件套）+ bilibili 探针 + skybridge SDK（判据 22、23 与判据 19 的流探针一半） | **22 四条硬 gate 绿**、23 双网络绿 | ✅ 2026-08-18 |
| N0b-4b | 播放判定（判据 19 的 expo-audio 一半：时长/seek/暂停/后台锁屏/焦点/蓝牙断连，单 player 与 playlist 各一遍） | **D17 判定写定：raw 直存达标 GO**；两条 expo-audio 行为缺口留给 N3 | ✅ 2026-08-18 |
| N0b-4c | 分享 intent（判据 24，`expo-share-intent@8.0.1`：真 bilibili 分享 + 冷/后台/前台三路径 + 文本逐字符回读）+ §9 汇总 | 24 记录（软判据） | ✅ 2026-08-18 |
| N0b-5a | D16 机制（判据 26）：backup 排除 CNG plugin + SecureStore 载体 + copy-then-open 协议与计时 + 三层客观判据 | **26 绿** | ✅ 2026-08-18 |
| N0b-5b | D14 落定（判据 25）+ GO/NO-GO 汇总 + **Stage-2 主计划修订** | **25 绿；N0b = GO** | ✅ 2026-08-18 |
| N1a | 地基：错误 45 类 + `StructuredLogger` 进 portable · `portable/runtime/` 四件与全部触点改写 · `portable/ports/` 六接口 + 桌面 adapter · 守卫全局 token 半 · Metro bundle smoke recipe | 全测试 + 判据 3–7、19 | ✅ 2026-08-18 |
| N1b | 断边与拆分：`DownloadTarget`/`findSongByKey` 下沉 · file-ops A/B 拆分 + `FileEffectLike` · `countQuarantined` 注入化 | 全测试 + 判据 8 | ✅ 2026-08-18 |
| N1c | PortableDb 收敛（`sqliteOf` 退役 + 类型换血）· FileContext/CredentialStore 接线 · 守卫 `sqliteOf` rg=0 | 全测试 + e2e 19 + 判据 9 | ✅ 2026-08-18 |
| N1d | download client 层进 portable（9 模块 + lyrics/ + 测试，24 文件 8 行改动） | 全测试 + 守卫 + smoke（36 → 51 模块） | ✅ 2026-08-18 |
| — | **R1–R3 真机预跑**（计划 §4 建议动作；正式判据仍在 N1i） | **R1 双网络各 9/9 · R2 8/8 · R3 双网络绿** | ✅ 2026-08-18 |
| N1e | sync + library 强连通体进 portable（52 文件搬迁，正文零改动；两个音频文件名常量随 `PathsPort` 走） | 全测试 + 守卫 + smoke（51 → 80 模块）+ e2e 19 | ✅ 2026-08-18 |
| N1f | SyncCoordinator 提取（八文件 + triggers 对半拆 + `CoordinatorContext`；daemon 只剩组装与定时器/SSE 壳） | 全测试 + 守卫 + smoke（80 → 90 模块）+ e2e 19 + **`accept-sync` 34/34** | ✅ 2026-08-18 |
| N1g | LibraryService + daemon 路由与 CLI direct 同时消费（两个 commit：服务层 / LibraryContract 18 例 × 两 hook） | 全测试 **2571** + smoke（90 → 94 模块）+ **`accept-cli` 27/27** + **contract 两 hook 全绿、mobile hook 显式 skip** | ✅ 2026-08-19 |
| N1h | AudioLanding 切面 + download 编排进 portable（两个 commit：切面与 commit 协议测试 / engine·batches·pipeline 搬迁） | 全测试 **2576** + smoke（94 → 97 模块）+ **`accept-m5` 22/22**（真 bilibili） | ✅ 2026-08-19 |
| N1i | 守卫收编（Metro smoke 进 `just check`）+ `SYNC_PULL_LIMIT_MOBILE` + R5② 接线测试 + **R1–R5 真机全绿** + D5 分段冻结 + 文档 | 全测试 **2578** + 七守卫 + **R1 9/9 · R2 8/8 · R3 绿 · R4 绿 · R5 绿** | ✅ 2026-08-19（判据 22 的发布物复跑待定） |
| N2 | `apps/mobile` 本体 + **D16 身份门** + 数据层（含 `ensureDeviceUuid` 下沉）+ 端口实现与 **file-op 执行器** + 服务层接线 + 四 tab 骨架 + 蓝牙歌词判定函数（七批 N2a–N2g） | 子计划 `docs/plans/2026-08-19-phase-b-mobile-n2.md` 判据 22 条 | ✅ **2026-08-20 全部完成**（判据 1–21 全过；**16b 与 14 的拖柄重排已按用户决定不做**，见 §8.2/§8.3）；全测试 **2628** |
| N3 | 播放：PlayerDriver + 队列与四模式 + minibar / 全屏页 / 队列面板 + 后台锁屏 + 蓝牙歌词接线（六批 N3a–N3f） | 子计划 `docs/plans/2026-08-20-phase-b-mobile-n3.md` 判据 25 条 | ✅ **2026-08-20 全部完成**（六批 N3a–N3f，判据 1–19 + 21–25 全过；**18 与 21 只记录不判定**、**20 已按用户决定搁置**、15 的「无文件的歌」夹具里没有）；全测试 **2729** |
| N4 | 下载：移动 AudioLanding + 落盘协议 + 启动清扫 + 添加页 + 分享 intent + **LLM 设置页** + **收藏夹/合集批量** + **dataSync 前台服务** + ensure-file + 缓存管理 + 歌单导出（七批 N4a–N4g） | 子计划 `docs/plans/2026-08-20-phase-b-mobile-n4.md` 判据 40 条 / 决策 a–p | 🛠 **开发中**：**N4a**（纯桌面，判据 1–4）· **N4b**（判据 5–14）· **N4c**（三批，判据 15–19 + 41–43，子计划 `docs/plans/2026-08-21-phase-b-mobile-n4c.md`）**均已完成**（2026-08-21，测试 **2764**）。下一步 **N4d**（添加页 v1 + 任务列表 + 分享 intent，子计划 `docs/plans/2026-08-21-phase-b-mobile-n4d.md` **v1 待评审**，判据 20–25 + 44·45） |
| N5–N6 | 同步 / 收尾（框架见 N0 子计划 §5） | 各自子计划 | ⏳ |

**R1–R3 真机预跑（2026-08-18，release 构建 · 冻结设备 vivo V2408A · 移动网络与 Wi-Fi 各一遍）**——N1d 刚把 client 层搬进 portable，趁热验「**core 自己的代码**在手机上跑出同样的答案」。跟判据 23 的区别是根本性的：那次是桌面做完 core 的活、设备复现，这次设备上跑的每一行都是 `@lark/core/portable` 的 import，桌面只出**输入**与**它自己算出的参照**（`make-network-fixtures.mjs` 的 `references`，同一份 core）。

- **R1 双网络各 9/9**：`signWbiParams` 在 Hermes 上对同一组 (keys, params, wts) 产出与桌面**逐字节相同**的 `w_rid`（`ebe73d7a…`，整条 query 也相同）· buvid3 经**安装的 Random 端口**成形（RN 没有 `getRandomValues`，不装就抛——这条正是端口存在的理由）· 设备侧现取 WBI key 现签的 search 拿到 20 条 · `view`/`pagelist`/`audioStream` 全过 · b23 一跳展开与桌面同 bvid · **`openAudio()` 流式读到 268KB/40 chunk（移动网络）与 270KB/42 chunk（Wi-Fi），abort 后再读抛 `AbortError`**
- **playurl 按调用方派节点这条，现在是用 core 自己的 client 量到的**：移动网络拿到 `xy118x212x136x211xy.mcdn.bilivideo.cn:8082`（mcdn P2P 节点），Wi-Fi 拿到 `cn-bj-cc-03-03.bilivideo.com`——与桌面同一个。N0b-4a 的结论复现，且这次链路里没有任何 spike 自己的实现
- **R2 8/8**：8 条真实分享文本逐字段与桌面相同，**包括拒绝**——`bilibili.com.evil.test` 两边都抛 `InvalidSourceError`（一个悄悄接受了它的手机端会是同一个守卫上的洞）。顺带把 N0b-4c 的发现钉成了对照：真 bilibili 分享文本（标题 + b23 短链）解析成 **keyword** 而不是链接
- **R3 双网络绿**：qq 中选，三个平台都出了候选，与桌面同一组。**但 LRC 内容不是稳定的**——移动网络那遍 1233 字 64 个时间戳，Wi-Fi 那遍 1057 字 48 个：平台的搜索结果逐次会变。判据因此断言「非空 + 有时间戳 + 平台集合一致」而不是字节相等，**按字节比会是一条随机红的判据**
- **release APK 仍然会以 dev-client 的 URL 启动**（`expo run:android --variant release` 的最后一行就是它），但面板自报 `dev: false`：判断跑的是哪份 bundle 只能信 `__DEV__`，不能信启动方式（N0b-3 同一条）

正式的 R1–R5 判据仍按计划在 **N1i** 用当轮 release 构建复跑；这次预跑的价值是：**core 的业务图在真机上能跑，这件事现在就知道了，而不是等到九批之后。**

**N1i 的 R4/R5 实测（2026-08-19，release bundle · Hermes · 冻结设备 vivo V2408A · 结果经 probe-host 回传）**——这是 N0b-3 那个 statement-shape proxy 第一次被**真函数**替掉：`runFullBackfillInTx` 与 `applyChangesInTx` 直接从 `@lark/core/portable` import，不是复刻。

| 判据 | 结果 | 数 |
|---|---|---|
| **R4** `runFullBackfillInTx`，2000 首欠着 | ✅ | **605.41ms**；`songs === 2000`（5 歌单 / 1000 membership）；**第二次跑回 0**——证明第一次不是空转 |
| **R5①** `SYNC_PULL_LIMIT_MOBILE` | ✅ | 200 |
| **R5③** `applyChangesInTx`，200/批 | ✅ | p50 83.52 / **p95 90.79ms**（预算 100ms）；**applied 2000、skipped 0、dead-lettered 0** |
| R5③ 500/批（参照，不判） | 记录 | p50 205.92 / p95 **226.05ms**；**applied 5000 of 5000、skipped 0**——延续 round 计数之后才干净（第一版跑在 200 已盖过戳的夹具上，只 applied 2400，一半是廉价拒绝） |

**R1–R3 复跑（同一轮 release 构建，2026-08-19）**——`R1 9/9`（**移动网络**；Wi-Fi 这轮未复跑，N1d 预跑时双网络都绿，按用户决定不再跑一遍）· `R2 8/8` · `R3` 绿。逐条：WBI `w_rid` = `ebe73d7a091cca142e72c9b4c3ff1c19` 与桌面**逐字节相同**且整条 query 相同 · buvid3/buvid4 经**安装的 Random 端口**成形 · search 20 条 · `view`/`pagelist`/`audioStream` 全过 · **`openAudio()` 流式读到 268,531B / 40 chunk，abort 之后再读抛 `AbortError`** · b23 短链一跳展开与桌面同 bvid · 歌词 qq 中选（1057 字 / 48 时间戳，候选平台集与桌面一致）。**N0b-4a 的节点差异第三次复现**：手机拿到 `xy220x202x9x147xy.mcdn.bilivideo.cn:8082`（mcdn），桌面同时刻拿到 `cn-bj-cc-03-01.bilivideo.com`——playurl 按调用方 IP 派节点这条，现在有三轮独立证据。

**R5② 的证据在桌面而不在手机**：`portable/coordinator/pull-limit.test.ts` 用捕获型 client 断言 `pullChanges(…, 200)` 真经 `engine.ts` 的 `options.pullLimit ?? SYNC_PULL_LIMIT` 缝传下去；把那句改成写死 `SYNC_PULL_LIMIT` 反测立刻红。

**R5 的四条实测**：

- **proxy 是乐观的，而这正是 R5 存在的理由**：N0b-3 的 statement-shape proxy 给 200/批报 72.98ms，**真 `applyChangesInTx` 是 90.79ms——慢 24%**；500/批 proxy 报 164ms(p50)，真函数 **p50 205.92 / p95 226.05ms**。**200 过了但余量只剩 ~10%**，且这是**空载下界**（空闲手机、2000 首库、没有渲染与播放竞争）。N5 真接同步时要在有竞争的条件下复测；超了就降到 100。**用户体验口径写明**：这段只在「离线很久回来追进度」时出现，表现为 10 次 ~90ms 的顿挫（中间隔着网络往返），滑列表看得见、不操作看不见；**音频走原生 media3，不受影响**；数据与协议完全不受影响
- **「快」本身是可疑信号，除非同时断言干了活**：第一次真机跑 R5③ 是 14ms/批的漂亮数字，而 `applied 0, skipped 2000`——payload 少了 `created_at_ms`，2000 条全被 dead-letter，dead-letter 也计进 skipped。抓住它的是「applied 数也算判据」那一条断言。**同一个形态第二次出现在参照行**：500 那轮跑在已被盖戳的夹具上，一半是廉价拒绝
- **fail-loud 的端口在真机上第一次证明了自己**：面板忘了 `installPortableRuntime()`，`runFullBackfillInTx` 一 mint uuid 就抛 `no RandomSource: this host has no crypto.randomUUID`。RN 没有 `getRandomValues`（N0b-3 量过），N1a 选的是**未装即抛**而不是静默兜底——所以这里得到的是一句准确的话，而不是 2000 个坏 uuid
- **release 面板的失败只写在屏幕最底下**：`console.log` 到不了 logcat，`uiautomator dump` 只列当前屏，所以「点了没反应」既可能是还在算、也可能是早就抛了。分辨方法是**量 app 的 CPU**（0.0% + 累计 16s = 没在干活；146% = 在干活），再慢速上滑到底读 `runner threw:` 那一行

**N1h 的三条实测**：

- **切面画对了的信号，是编译器把一整段代码报成「没人用」**：`fetchAudio` 连同 `StagedAudio`、`countingStream`、四个 `node:` import 与 `PipelineDeps.mediaTools`，在 AudioLanding 落地之后全部变成死代码——**engine 的最后一个 Node 方向 import（`MediaToolsProvider`）也跟着没了**，因为工具链现在属于落地实现而不是队列。搬迁那个 commit 的 diff 因此**只有删除、没有新增**：正文逐行比对下来，改动全是「不再需要的地方」
- **`saving` 只能由落地自己报，而这会挪动一条冻结不变量的机制**：engine 原本在 fetch 与 land 之间设这个阶段，而从一次 `land()` 之外已经看不见那个时刻了——提前设就把事件序倒成 saving → downloading → converting。但进入 `saving` 同时是**冻结目标歌单列表**的那一下（二轮评审 ⑫），所以 `commit` 现在**在自己跑的时候**读 `task.playlistIds`，而不是读一个提前捕获的数组。同一份列表、同一个时刻，且本来就该在冻结之后读
- **不为一个没人读的字段加一次网络往返**：`expect.expectedDurationSeconds` 要的是分 P 时长，而 `choosePage` 只回页码——填它得多打一次 `pagelist`，为的是一个桌面**故意忽略**的参照值（它探的是真到货的字节，因为一条自称 `mp4a.40.2` 却送别的东西的流会被拷成播不了的 canonical 文件），而 redownload 从存下来的 key 解析、根本没有分 P 可引。改成可空、传 `null`，§8 本来就把跨宿主签名留到 N4

**N1g 的四条实测**：

- **两个 hook 不一样敏感，而这件事只有把规则拆掉跑一遍才看得见**：LibraryContract 十八例第一次两边全绿。把 service 的 `requiredName` 里那句 `.trim()` 删掉重跑——**CLI hook 红两例，daemon hook 全绿**。因为 daemon 的 `optionalString` 自己先 trim 了，递给 service 的值已经满足了半条规则，那两例在 daemon 上测的其实是「wire 修过之后还有人拒绝」。补 `stringField`（只查类型、原样递进去）之后再破一次：**两边同样红两例**。**「绿」不是证据，「破了会红」才是**——这条 M5/T5 记过两次，这次是它在一个跨宿主契约上的形态
- **`CodedError` 有语义，不是「带 code 的错误」的意思**：`LibraryInputError` 第一版继承了它，`errors.test.ts` 当场红三条——那个基类的意思是「携带客户端会收到的那个 wire code」，而这个错误存在的全部理由恰恰是**库对前端该报什么码没有意见**。降成普通 `Error` 之后由两边各自翻译（daemon 按 field 归 `INVALID_BODY`/`INVALID_QUERY`，CLI 归 `USAGE_ERROR`）。**一个反射式的注册表测试挡下了一次建模错误**
- **消费服务层的信号是编译器报出一串死代码**：daemon 两个路由文件 + CLI direct 接上 service 之后，`tsc` 报的每一条都是 unused import / unused const——`listSongs`、`getPlaylistSongs`、`SEARCH_MAX`、`writableId`、`validId`、`requiredName`……**没有一条是「要改的地方」，全是「不再需要的地方」**。如果报的是类型不匹配，说明服务层的面画错了
- **契约夹具不许假设插入顺序**：「虚拟 all 是每首歌按创建顺序」第一版断言「先 seed 的排前面」，同毫秒创建的两行在 `created_at` 上打平、回落到 id（M5 记过）。改成**跟它被定义成的那个查询逐首比**（`listSongs({sort:'created_at',order:'asc'})`）——既 tie-safe，又正好是这条规则真正的内容

**N1f 的四条实测**：

- **判据 F5 读错了元素，而它的对错取决于一次后台推送赶不赶得上**（`accept-sync` 连红两次）：徽章按钮的 `innerText` 是「标签 + 注意力计数」拼起来的，而标签本身在有未推送变更时就是 `待同步 1`——于是「按钮文本还以 1 结尾吗」分不清「冲突还在」和「这次 resolve 自己 emit 的那条变更还没被 outbox 触发器推走」。两次红的那一刻 `count 0 · attention 0`，**解决冲突完全成功**；红的只是 800ms 静默 + 1s 轮询有没有落在它等的 1500ms 里。改成读注意力那个 `span`（按钮不在时返回 `null` 而不是 0，否则窗口没渲染出来也算通过）。与 T5 的「同一个词既当分区标题又当状态文案就会撞」同一个形状：**两个数字渲染进一个字符串，断言就只能猜是哪一个**
- **决策 h 没算到夹具**：五个 coordinator 测试全部跑在 daemon 的 `createTestContext` 上（一个带下载引擎、播放器、媒体工具链的完整 `AppContext`），而它搬不进 core。所以「单测跟代码走」的实际代价是**另造一个 `CoordinatorContext` 夹具**（`@lark/core/testing` 的 `createCoordinatorHarness`：真数据库 + 真文件系统 + 真凭证文件，只有 SDK 与时钟是假的）+ `fake-skybridge` 一起搬进 core testing。账本对得上：daemon 495 → **446**，core 1098 → **1147**，全仓 **2532 不变**。daemon 侧的覆盖没丢——`routes/sync.test.ts` 守着线，两套 e2e 守着真 server
- **skybridge SDK 在 Metro 里解得开**（决策 c 由此从纸上变成事实）：`@orpheus-aviary/skybridge-client` / `-proto` 静态进 `portable/coordinator/client.ts` 之后，portable 的 Metro 图 80 → **90 个模块**，bundle 1.5MB。这条只有 bundle smoke 答得了——rg 守卫的禁用清单里本来就没有它们
- **`api` 必须离开 SyncRuntime**（子计划 §1.3）：它原本是 `SyncRuntime` 的字段并**默认落到 `realSkybridgeApi`**，也就是说一个没人注入的 runtime 会自己去连真服务器。移到 `CoordinatorContext` 且必填之后，`ctx.sync.api` 变成 `ctx.api`，daemon 的 `BaseContext` 长出一个 `skybridge` 字段。**coordinator 因此可以在一个还不知道怎么联网的宿主上构造出来**

**N1e 的一条实测**：

- **文件名不是路径，所以它属于端口**：`sync/file-ops.ts` 要 `CANONICAL_AUDIO_FILE` 才能说「这首歌的音频在不在」，而 N1a 把这两个常量从 `library/lyrics.ts` 挪进了桌面的 `paths.ts`（那里有 `node:os`/`node:path`），留一行 re-export 顶着。搬到 portable 的那一刻这行 re-export 就没有源了——**挪错了一层，一个批次之后才显形**。`song.m4a` 在每个宿主上是同一个串，join 才是宿主的事：定义因此进 `portable/ports/paths.ts` 与 `PathsPort` 同住，`paths.ts` 反过来 re-export 保住桌面的读法。这是本批唯一不是 `git mv` 的改动，其余 52 个文件**导入块之外逐字节相同**（拿搬迁前的内容逐个比，不看 diff——N1d 同一条）

**2026-08-17 范围修订（用户决定）——「歌单导入导出」从「明确不做（v1）」移进 v1**（主计划 §4.5 + D12 已改，N0 子计划 §5 的 N4/N6 已加）：

- **N4**：歌单导出 → 系统分享面板（cache 目录 + `expo-sharing`，不碰 SAF，与分享 intent 接收侧同一片原生区域）
- **N6**：导入桌面导出的去 id 文件（`expo-document-picker`；**必须在 N4 之后**，否则导入进来的是一库点不响的行；成本在预览/提交 UI 不在文件 IO）
- D12 的「私有目录卸载即删」只约束**音频**导入：歌单 json 产出的是带 `source_key` 的行 + `downloaded` 文件，全部可重建
- 做 N6 那一节时**连带评估 §9 N0b-3 的「出口 B」**：整文件 sha256 在 10,000 首上限（约 2MB）要一来一回约 1.3s

**开工前要知道的**：

- **N0b 是平台 spike，不是业务图验证**：core 业务模块（bilibili client、link、歌词、backfill、apply、file-ops）要到 N1 端口化后才能被 Metro 解析（`wbi.ts:21` 直接 `node:crypto`、`backfill.ts:29` 直接 `node:fs/promises`）。spike 内**禁止复制 core 实现来假装验证 core**——凡探针需要 core 才能算出的输入（WBI 签名、带签流 URL、header 集），一律由桌面用真 core 产出成 fixture。真实业务图归 N1 出口的 **R1–R5**
- **前置条件三件**：一台 Android 真机（同时是测量协议的**冻结设备**，换设备 = 数值判据全部重测）· 本机 Android 构建链（JDK + SDK + adb，`expo run:android` 本地构建不依赖 EAS）· TLS（D15）与 N0 无耦合（spike 允许 LAN 明文 HTTP，产品线 https-only 不动，死线仍是 N4）
- 🚨 **N0b 起 Expo 进桌面 workspace**：每次 `pnpm install` 变动后必须复跑桌面 `just check` + `just test`（判据 13，常驻义务）
- **待用户拍板**：决策 g（keystore 加密凭证库选择），N0b-5 前定；其余 a–l 已按建议关闭
- **判据 19 已按用户决定修订**（2026-08-17）：后台 + 锁屏 **30min → 5min**、耳机拔出 → **蓝牙断连**（设备无耳机孔）。代价写在子计划 §3.2：5 分钟到不了 vivo 收后台的尺度，这条从此只证明「不是一开始就断」，耐久证据推给 N3 整晚 soak；有线拔出路径本设备不可测
