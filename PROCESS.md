# lark 开发进度

> **这个文件只写「现在」。** 逐批的历史记录已经归档到 `docs/history/`，索引在下面。
> 对话以本文件为基准；旧的东西查得到就行，不必读进上下文。

## 当前阶段：**桌面 0.5.1 + Android 0.2.1 —— 全绿，待发版**

**代码完成，`just check` + `just test` 绿；五套 accept 与两端人工验收要在对齐两条之后复跑。** 之后就是 M7 §3.5 的九步。

| | |
|---|---|
| **这一版是什么** | ① **程序坞回归热修**（0.5.0 开桌面歌词就把整个进程降成 macOS accessory 应用：没有 Dock 图标、没有菜单栏、没有 Cmd+Q，而歌照放）② **多 P 视频的选集与命名**（模型不再替人选集；分P 按自己的标题命名；界面上它就是一个「合集」）③ **长期使用复盘两条**（歌词任务按它那首歌排序 · 重下删掉被替换的那一行）④ 手机设置页显示版本号 ⑤ **两端对齐两条**（手机的分P 也建歌单 · 桌面补上下载失败自动重试） |
| **版本线** | 桌面 `0.5.0` → **`0.5.1`**；Android `0.2.0` → **`0.2.1`**（versionCode 4）。**两端必须一起发**——旧手机端连不上新 daemon 的分P 端点 |
| **协议 / schema** | `LOCAL_API_VERSION` **9 → 10**（`POST /download/parts` + `MULTI_PART_UNRESOLVED` + `[download] retry_limit`）；**schema 仍 v3，无 migration，曲库不动**。配置段并进 10 而不是抬 11——**10 从没发布过**，不存在一个答 10 却不认它的 daemon |
| **测试** | **3629**（`just test`），`just check` 绿（守卫十五条） |
| **验收** | 五套共 **134** 条：`accept-gui` **20**（15 → 18 → 20）· `accept-cli` 27 · `accept-m5` 22 · `accept-sync` 36 · `accept-pack` 29。⚠️ **对齐两条之后尚未复跑**——发版第 1 步做 |
| **人工验收** | **桌面全绿**（程序坞三条 · 多 P 五条 · 命名两条 · 记录两条）· **真机全绿**（Android 0.2.1，versionCode 4，签名与版本号都由 `mobile-verify-apk` 验过）。⚠️ **对齐两条是在这之后做的，两端都要复验**——见「下一步」 |
| **业务代码** | 531 文件 / 52,725 行（0.5.0 是 524 / 52,060） |
| **门禁产物** | ⚠️ **作废**（对齐两条之后代码变了）。原记：dmg `79cc06df…3df91de8`（148,343,165 B）· tgz `4d04ac46…f1bce304`。**门禁产物从来不是发布物**——发版要从打了 tag 的 HEAD 重打并重跑 `accept-pack` |

**这一版的形状，一句话**：*没有人替人选分P*。链接是离线识别的，谁都不可能在点之前知道它是多 P；模型以前替人选，答不出就落第 1 P——那是静默下错歌。现在三端都拒绝，由人用 `?p=` / `--part` / 界面回答。

**子计划** → **`docs/plans/2026-08-28-desktop-0.5.1.md`**（§1–§6 热修 · §7 多 P 六条决策与 P1–P6 · §8 复盘两条）+ **`docs/plans/2026-08-31-parity-0.5.1.md`**（两端对齐普查与 P1–P4）。

### 上一站：桌面 0.5.0 + Android 0.2.0（2026-08-28 发布）

[Release v0.5.0](https://github.com/orpheus-aviary/lark/releases/tag/v0.5.0)（tag → `9b359c0`）+ [`@orpheus-aviary/lark-cli@0.5.0`](https://www.npmjs.com/package/@orpheus-aviary/lark-cli) + [Release android-v0.2.0](https://github.com/orpheus-aviary/lark/releases/tag/android-v0.2.0)（同一个 commit）。**桌面歌词**（第二个 renderer 窗口）· 下载记录持久化 + 来源 · 输入法组字不再误提交 · 手机歌词中线跳转。协议 8 → 9，测试 3547，五套 accept 129/129。**发出去当天就撞上程序坞那条回归**，见本页顶部。

### 下一步

**先复跑门禁，再发版。** 对齐两条动了两端，所以：五套 accept 全部复跑（`accept-gui` 现在 20 条）· Android 重新构建 + 装机 · **真机一次会话**（分P 三条：顶上是可改的歌单名、改名提交后歌单以新名字建出来、不改则用视频标题；收藏夹/合集回归一条；自动重试一条：拨动命名 chip 之后让一次下载超时重来，落库的名字仍按原来那次的模式）· 桌面人工补两条（设置页「失败自动重试」存得住 · 只留 daemon 关掉 GUI 时一次失败仍会自动重来，且记录里只有一行）。**版本号不变**（0.5.1 / 0.2.1 都没发过），所以不用 `mobile-prebuild`，但 `mobile-verify-apk` 照跑。

然后九步照 `docs/plans/2026-08-08-m7-packaging.md` §3.5，每步用户确认，**两个 tag**：`v0.5.1` + `android-v0.2.1`。开始之前工作树要干净、要 push。

发版之后的入口：

- **待办与已决定不做的** → `docs/plans/2026-08-26-backlog-before-android-v1.md`（A 发版门 / B 延后 / C 技术债 / D 首发之后 / **E 防止重复捡起**）。C11 / C12（移动端两处选择态脚手架、三份 StyleSheet 与两份 row markup 的重复）在这一版又付了一次代价：歌单里少了「需要下载」正是两份 row 走散的结果。
- **D2「长期使用复盘」**：0.1.1 与 0.5.0 都是这么来的——用一阵子，列回来，再分批。

### 本阶段记录

- **0.5.1 · 桌面歌词把整个进程降级了（2026-08-28，用户报的）** —— 症状是「开启歌词之后程序坞中 lark 没了，但是没退出」。`setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` 是 Electron 文档里让窗口盖住全屏应用的正路，它**顺手**对进程执行 `TransformProcessType(kProcessTransformToUIElementApplication)`——**受害的是进程不是窗口**，所以 Dock 图标、菜单栏、Cmd+Q 一起没有；而主窗口是「红叉 = 隐藏」，**先开歌词再点红叉，这个 lark 在 UI 上就没有入口了**。本机探针（仓库自己的 Electron 43.2.0）：执行那一行前 `dock=true`/`Foreground`，之后 `dock=false`/`UIElement`，**销毁歌词窗和再 `show()` 主窗口都不还回来**。修法是 Electron 43 的 `skipTransformProcessType: true`（实测 dock 保持 `true`，两个 collection behavior 照设）。
  **落了两道门，因为它们答的不是同一个问题**：**第十五条守卫** `check-lyrics-dock-icon.sh` 读源码，答「有没有人把那行改回去」（**验破法用 0.5.0 发出去的那一行原样，红**）；**accept-gui 新增三条**读**产物**，用 `lsappinfo` 从进程外面问 `ApplicationType`，答「Electron 换了行为」或「别处又降级了进程」——`app.dock.isVisible()` 在主进程里，CDP 只够得到渲染进程，这是这个 harness 唯一站得住的观察点。
  🔴 **新判据第一版自己红过一次，形状值得记**：它排在判据 6（daemon 重启 + token 轮换）之后，而 harness 的 `api` 助手闭包着**重启前**的旧 token，`GET /config` 答 401 ⇒ `data` 是 `undefined` ⇒ 整个套件崩在解构上。改用判据 6 自己建的 `newAuth`，并把「配置读到了没有」提成一条明判据。**这次是崩溃所以看得见；同一个错误如果落在一个 `?.` 上，就是一条永远绿的空判据。**
  **教训进 `docs/LESSONS.md`**：0.5.0 的判据 19（拖拽区）和这次的 dock 落在同一条缝里——业务判定被抽进可注入的 factory、单测很漂亮，而**真正碰平台的那几行没有任何判据**。规矩因此是：碰平台的调用，要么进 factory，要么当场落守卫。
  🔴 **门禁又抓到一条判据自己的病（第四次了），而且不是这一版改的那条**：`accept-gui` 判据 6「重启后的 seek 走在新代际上」以 `200 t=1129.9` 红——GUI 的命令通道**重连得比 `loadedmetadata` 早**，seek 答 200 且真的被应用，随后 `player/recovery.ts:70` 无条件写回重启前的位置把它盖掉。0.4.1 只教会它「409 就重试」。改成**重试到位置真的动了为止**（有界）。顺带记下一个真产品洞 → backlog **C13**：daemon 对一个静默没发生的命令答了 200。
  **取证时还翻出一件事**：这套件复制的是**用户当下的曲库**，而用户现在开着桌面歌词 ⇒ GUI 一启动就多一个 renderer 窗口。同一份副本把 `desktop_lyrics.enabled` 改成 `false`，一轮 **18/18**；开着则三轮红两轮。**0.5.0 发版那天判据 6 绿，是因为那个开关当时还没被打开过**——一个新功能可以在不碰任何判据的情况下把另一条判据推过临界点。3:1 不足以叫因果，但足够进 `LESSONS.md`。

- **多 P 选集与分P命名（P1–P5，2026-08-28 → 08-31）** —— 用户报的两件事：不带 `?p=` 的多 P 链接总是落到第 1 P；分P 的歌被命名成合集名。根因都在 `pipeline.ts`——`choosePage` 让模型选一个（答不出退回 1），而 `pages[].part` 解析了、只在选集时用过一次、随后丢掉。**改成没有人替人选**（`MULTI_PART_UNRESOLVED`，配了 LLM 也拒），分P 按自己的标题命名、`clean` 同时看两个标题。协议 9 → **10**（`POST /download/parts`）。三端各一批：桌面弹窗 · CLI `--part` / `--all-parts` · 手机 `Picker` 的第三个来源。**关键词搜索保留模型选集**——那条路上人从没见过视频。
  🔴 **用户用过之后改了两条决策，代价也一起认了**：分P 要**回车后直接展开**（多一次连网）且**和合集完全统一**。于是 `PartsPickerDialog` / `PartsList` / `usePartsPrompt` 删掉，分P 变成和收藏夹**同一种组**（可改名标题 · 每组自己的原标题 · 全选 · 新建歌单），只保留一处差别：**列表全勾、分P 零勾**。组的模型抽进 `components/batch-groups.ts`。
  **两次被既有判据救**：`prefetchedParts = []` 作默认参数每渲染都是新数组 ⇒ effect 反复重拉列表、勾选被重置；`accept-sync` 的 A2/A3 证明新错误码两张注册表都登记了。

- **长期使用复盘两条（2026-08-31）** —— 「匹配歌词」沉到列表底（`lyrics` 是下载成功后**新起**的任务，在「最老的在前」里永远最新）· 重下不删旧行（记录按 task id 去重，重下必然添一行）。前者的修法不是给 `lyrics` 开特例，而是问**这首歌什么时候进的队**，规则进 `portable/download/task-order.ts` 两端共用；后者抽成 `supersededRecord()` 一个类型守卫，三处调用同一句话（自动重试 / 手动重下 / 全部重试）。**手机端此前只有自动重试有这条规则**，人手动点的那条路一份都没有，`全部重试` 会让记录翻倍。

- **上手验收（2026-08-31，两端全绿）** —— 桌面十二条、真机十四条。翻出三件事并已修：**全屏覆盖丢了**（`skipTransformProcessType` 与「盖住全屏」在默认写法下互斥 ⇒ 改 `type: 'panel'`）· **多行里的多 P 不展开**（`confirm()` 无条件 `onClose()`，把刚提的问题连窗一起关掉；判据全绿是因为 jsdom 里 `onClose` 只是个 mock）· 手机设置页没有版本号（Android 不进商店、无自动更新，「我装的是哪一版」只能在这里答）。
  **发版门禁**：`just check` 绿（十五条守卫）· `just test` **3609** · 五套 accept **132/132**（`accept-gui` 15 → 18）· `mobile-verify-apk` 验过签名与 0.2.1/versionCode 4。
  🔴 **`accept-sync` 在门禁上红了两轮，两轮都是夹具**：它自己 `backupNest()` 再真登录一次，而 `just backup-nest` 复制的是**当前活动工作区**（这台机器上是账号库）。照旧笔记删 `libraries/` 等于删掉唯一那份库；把账号库提到根同样不行——它带着 device 绑定和同步 outbox。**能用的夹具是照 `local` 工作区自己造一份**（→ `LESSONS.md`）。

- **两端对齐普查与两条修正（2026-08-31，用户在发版前要求）** —— 逐功能对了一遍桌面与手机，分三类：有意的分叉（出处都在 `INVARIANTS.md` §7 或某个子计划，不动）· 漂移 · 文档与代码不符。改了两条漂移：
  ① 🔴 **手机的分P 不建歌单**。0.5.1 当天写进 `INVARIANTS.md` §3 的是「桌面和手机都渲染成同一种组……**提交时新建歌单**」，而代码是两份：桌面 `{kind:'new'}`、手机提交到「存到」选的目标且标题只读。**一句话不会红**，所以提进 `portable/download/batch-groups.ts` 的 `partsGroupPayload` 一处产出，桌面 `groupPayload` 委托过去，并在桌面测试里直接断言两者逐字段相等——谁再写第二份就红。根因值得记：手机那半的判定在 `ui/parts-picker.tsx` 里，而 `apps/mobile/vitest.config.ts` 的白名单挡住一切 import react-native 的文件 ⇒ **那一行从来没被任何测试看过**（`INVARIANTS.md` §7 最后一条这次以「两端不一致」的形式收费）。
  ② **桌面补下载失败自动重试**。0.1.1 ⑧ 只做了手机。白名单与次数语义搬进 `portable/download/retry.ts` 两端共用（**一个存在两份的白名单迟早会说两句话，而错在两个方向上都是静默的**）；桌面跑在 **daemon**（`download-retry.ts` 挂 `onStatus`）而不是渲染进程——GUI 大部分时间关着而 daemon 还在下载。次数因此必须进配置：`[download] retry_limit`，**并进未发布的协议 10**。
  🔴 **补另一端逼出了第一端从没被问过的问题**：手机的自动重试重放的是记录里的**文本**，于是要再答一次「哪种命名」，答案取自**此刻**设置页记着的那个——一首 `original` 提交的歌可以在自己失败的那几分钟里，因为有人拨了 chip 而以 `clean` 落库。daemon 没有「此刻的 chip」可读，于是改成新的 `engine.enqueueRetry(taskId)`：**重放 task 自己已解析的 target**（同一页、同一命名、同一批歌单，且不需要网络），手机的自动那条路一起换过来。**手动「重下」两端都不动**——按下按钮的人给的是今天的答案（0.1.1 ⑨）。
  **文档三处改到与代码一致**：`INVARIANTS.md` §7 第一条**已经过期**（写着「锁屏上一首/下一首在 expo-audio 上不存在」，而 0.1.1 ⑬ 用 patch 做出来了，**同一份文件的 §8 还写着它的验收方法**）· §3 补「分P 的 wire shape 由一处产出」与自动重试整条 · N4i 决策 f 的两条「不做」（手机歌词管理面 / 复制歌曲 ID）补进 backlog E 节，此前只在子计划里，每次对照都会被重新捡起来问。
  **普查查出、这一批不做的四条进 backlog**：C14（`[重复]` 标记只有桌面有，手机同步页只能写「去电脑上看」）· C15（手机歌曲页多选没有「下载」）· C16（歌单详情的行仍是第二份）· D5（桌面不记「上次听到哪」，而 `portable/last-playback.ts` 是两端共用层）。
  **门禁**：`just check` 绿（十五条）· `just test` **3629**（3609 → +20）· 破法逐条验红（目标重新决定命名 · lyrics 也重放 · 计数键成 url · 先删记录再排队 · 分P 不建歌单 · 给 item 填上分P 标题）。**五套 accept 与两端人工验收待复跑**。
  **计划外的一条**：`[download]` **是 Go 时代就有的段**（里面有个死掉的 `uploader_video_limit`），新字段并进去时「未知键原样回写」那条判据当场红——它断言 `raw.download` 只有那个死键。判据是对的，红得也对。

## 历史归档

已走完的阶段的逐批实施记录——经过、判据结果、当时的判断与决策：

| 阶段 | 位置 |
|---|---|
| **v0.1.0 本地全功能**（M0–M7，2026-08-10 发布） | `docs/history/v0.1.0-shipped.md` |
| **v0.2.0 skybridge 同步**（T0–T6，2026-08-13 发布）+ v0.2.1 | `docs/history/v0.2.0-shipped.md` |
| **v0.3.0 m4a 统一 + 一次性迁移**（Phase A，2026-08-17 发布） | `docs/history/v0.3.0-shipped.md` |
| **Phase B Android**（N0 平台 spike → N7 每账号工作区） | `docs/history/phase-b-shipped.md` |
| **0.4.0 + Android 0.1.0 发版**（2026-08-26，含文档大整理与 N7 收口） | `docs/history/0.4.0-android-0.1.0-shipped.md` |
| **0.4.1 / 0.4.2 + Android 0.1.1**（2026-08-27，第一份「长期使用复盘」） | `docs/history/0.4.x-android-0.1.1-shipped.md` |
| **0.5.0 + Android 0.2.0**（2026-08-28，第二份复盘 + 桌面歌词） | `docs/history/0.5.0-android-0.2.0-shipped.md` |
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
