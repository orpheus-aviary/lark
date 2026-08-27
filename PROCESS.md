# lark 开发进度

> **这个文件只写「现在」。** 逐批的历史记录已经归档到 `docs/history/`，索引在下面。
> 对话以本文件为基准；旧的东西查得到就行，不必读进上下文。

## 当前阶段：**Android 0.1.1 —— 首发之后的 UX 修补（开发中）**

| | |
|---|---|
| **桌面** | **v0.4.0 已发布**（2026-08-26，tag `v0.4.0`）—— `Lark-0.4.0-arm64.dmg` + [`@orpheus-aviary/lark-cli@0.4.0`](https://www.npmjs.com/package/@orpheus-aviary/lark-cli)。协议 `LOCAL_API_VERSION` 6 → 7，**曲库不迁移**（schema 仍 v3）。 |
| **移动** | **Android 0.1.0 已发布**（2026-08-26，tag `android-v0.1.0`）—— `lark-0.1.0.apk`，versionCode 1，minSdk 26。只在 GitHub Release 发，不进商店，无自动更新。 |
| **测试** | **3328**（`just test`）。`just check` 绿（守卫十一条，0.1.1 加了「播放链路禁 JS 定时器」）。桌面五套 accept 的 128/128 仍是 0.4.0 那份产物的成绩。 |
| **业务代码** | 491 文件 / 49,026 行（`tokei`，口径见 `.tokeignore`）。 |
| **设备** | 冻结设备 vivo V2408A / Android 15。数值判据一律 release 构建。 |

**这一版是 D2「长期使用复盘」的第一份收成**：用户用了一天，列回来十一条，其中**只有一条是 bug**（锁屏播完不续播），其余是产品形状。子计划与分批 → **`docs/plans/2026-08-26-android-0.1.1.md`**；更早的待办与已决定不做的 → `docs/plans/2026-08-26-backlog-before-android-v1.md`。

> 📌 发版时要做一次归档提交：把下面 0.4.0 / 0.1.0 那三段移进 `docs/history/`，本文件回到只剩当前阶段。

⚠️ **手机当前状态**：装的是 **0.1.1 开发构建**（2026-08-26 取证那次装的，带临时探针；探针未提交，下一次装包会覆盖掉）。仍处于**登出**，且 **LLM API Key 随卸载丢失**——要手动补一次（backlog A5）。

### 本阶段记录

- **P2 锁屏续播（⑪，2026-08-27）** —— **先取证再动手**。真机探针（release 构建 + 应用内日志环，debug 装不上去：签名不同，卸载会带走曲库）把链路四步各打一个时间戳：`didJustFinish` 到达 JS +0ms、`decideNext` 判定正确 +55ms、`pause()` +56ms、**`await sleep(300)` 之后 +63 537ms**，解冻后 82ms 内播上下一首。**判断和播放都是对的，卡住的只有那一个 JS 定时器**；而且放开它的是**解锁**，不是屏幕亮（唤醒后连采 1.7 秒仍冻着）。
  修法：`modules/lark-app` 加原生 `delay(ms)`（主 looper 的 `postDelayed`，与显示无关），`player/driver.ts` 的两个定时器——300ms 拆卸间隔与 15 秒加载看门狗——都换掉。**排除过一个候选修法**：「听状态流等暂停生效」在播完这个场景上不成立，`BaseAudioPlayer.kt:84` 把 `STATE_ENDED` 下的 pause 判为 transient 而不发事件。
  电脑上唯一能变红的判据是新守卫 `check-mobile-no-js-timers.sh`（`src/player/` 禁 `setTimeout`）——`driver.ts` 自己 import expo-audio，进不了 vitest 白名单。**剩下的证据只有设备能给**，排在 P7 的那一次会话里。

- **P1 界面账（② ③ ④ ⑩ ⑫，2026-08-27）** —— 五条：顶栏的「lark」删掉（状态栏留白留着，那才是挖孔的那一份）· 添加页整页一个滚动条（任务列表成为唯一滚动容器，表单当它的表头，**必须传元素不能传函数**，否则每敲一个字输入框失焦）· 返回键按「多选 → 歌单详情 → 非歌曲 tab → 系统」四级（**优先级是数字不是注册顺序**：React 的 effect 是子先父后，纯 LIFO 会先问外层）· 歌单里的 ⋮ 变成和「歌曲」同一张菜单（多一条移出歌单，且它不再是红色——红只留给不可逆的删除）· 设置页删掉八项调试信息（留「曲库 N 首」与折叠起来的「最近的错误」，后者是 release 构建唯一能看见错误的地方）。
  顺手修了一个既有的 hooks 顺序 bug：歌单详情的三个 list hook 在 `if (detail === null) return` 下面——别的设备删掉你正打开的歌单时 hook 数量会变、渲染直接崩。要在那儿加 `useBack` 就不能把新 hook 加进同一个坑。
  `playlists-tab.tsx` 592 行拆成 175 + `playlist-detail.tsx` 456 + `add-songs.tsx` 108。测试 3317 → **3328**。

- **跨仓文档跟进（2026-08-26，backlog A2 关闭）** —— `aviary/docs/{ROADMAP,DESIGN}.md` 与 `.github/profile/README.md` 里 lark 的状态自 0.3.0 起就没动过、也完全没有 Android 这条线。三处都改了，重点不是「多了个 app」而是**这个 app 是什么**：一台有自己曲库、离线可用、登录后双向同步的**设备**，不是遥控器；每账号一个曲库，id 与 owl 的 per-profile 逐字节同结果；两端业务逻辑同一份代码（`@lark/core/portable`），这是它能做小的前提。

- **发版（2026-08-26）** —— 桌面 **0.4.0** + Android **0.1.0**，两条版本线各自打 tag（`v0.4.0` / `android-v0.1.0`）。
  发版前对**这一份代码和产物**复跑五套 accept：`accept-gui` 15 · `accept-m5` 22 · `accept-cli` 27 · `accept-sync` 36 · `accept-pack` 28 = **128/128**；dmg 与 tgz 的 sha256 与 accept-pack 报的逐字节一致，npm registry 回读的 shasum 与本地 tarball 一致。
  🔴 **门禁抓到一条**：`DAEMON_VERSION` 在其余八处都到 0.4.0 之后还停在 0.3.0——只改源码不够，**dmg 里编译进去的是旧值**，所以重打了包再跑。`accept-pack` §9 读源码比字面量，正是为这个。
  🔴 **发布约一小时后发现 Android 版没有图标**——`app.config.ts` 里既没有 `icon` 也没有 `adaptiveIcon`，`expo prebuild` 一声不吭地用了模板自带的占位图。**离线的门一个都照不到**：缺失不是错误，tsc / biome / bundle smoke / 原生模块守卫全都只管代码，而这是一个从来没被命名过的资产。已补（图标取自桌面那份源图，前景铺满自适应图标的内侧 72/108 安全区，底色 `#0b332f` 是画面自己的描边色，配方在 `apps/mobile/assets/README.md`），并加了守卫 `check-mobile-icon.sh` 进 `just check`（两种破法都验过红）。**APK 就地换掉、版本号与 versionCode 不变**（0.1.0 / 1 ⇒ 覆盖安装、曲库不丢），Release 说明里如实写了换过、新旧 sha256 都记着。
  **顺带补了 `just mobile-android-apk`**：`expo run:android` 没有设备就拒绝构建（它是 run 命令，只是顺带构建），而**发版不该依赖手机插没插在这台电脑上**。

- **文档大整理（2026-08-26，A1 的一半）** —— `PROCESS.md` 1145 行 → 归档成五份 + 本文件（52 行）；`CLAUDE.md` 40KB → 6.6KB，从逐批状态改成「常驻规范 + 全是指针的进度段」；新增 `docs/INVARIANTS.md`（**仍然生效的约束**，从 CLAUDE.md 的状态段里提炼）与 `docs/plans/2026-08-26-backlog-before-android-v1.md`（带字母编号的待办 + **E 节「防止重复捡起」**）；新增 `.tokeignore`（`tokei` 只数业务代码：830 文件 / 92k → **491 文件 / 49,026 行**）。**结构照 owl**（`docs/history/<阶段>-shipped.md` + PROCESS 里一张查找表 + backlog 用稳定字母 id）。CLAUDE.md 同时加了一条**测试规范**：不要过度设计测试，上机由用户操作且集中安排。**A1 剩下的一半是面向用户的 `README.md`。**
- **N7 每账号独立工作区完成（2026-08-26）** —— 判据 103–123 全关。判据 122 是桌面 accept 五套 **128/128**（顺带还清 N1 判据 22 欠了六轮的旧账），判据 123 是一次真机会话（八步里除「第二个账号新建空库」按用户决定不测外全过，**空库 / 要求重新登录 / converge 三种失败一次未现**）。逐批经过见 `docs/history/phase-b-shipped.md`。

## 历史归档

已走完的阶段的逐批实施记录——经过、判据结果、当时的判断与决策：

| 阶段 | 位置 |
|---|---|
| **v0.1.0 本地全功能**（M0–M7，2026-08-10 发布） | `docs/history/v0.1.0-shipped.md` |
| **v0.2.0 skybridge 同步**（T0–T6，2026-08-13 发布）+ v0.2.1 | `docs/history/v0.2.0-shipped.md` |
| **v0.3.0 m4a 统一 + 一次性迁移**（Phase A，2026-08-17 发布） | `docs/history/v0.3.0-shipped.md` |
| **Phase B Android**（N0 平台 spike → N7 每账号工作区） | `docs/history/phase-b-shipped.md` |
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
