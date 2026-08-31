# lark 开发进度

> **这个文件只写「现在」。** 逐批的历史记录已经归档到 `docs/history/`，索引在下面。
> 对话以本文件为基准；旧的东西查得到就行，不必读进上下文。

## 当前阶段：**桌面 0.5.1 + Android 0.2.1 —— 全绿，待发版**

**代码完成，门禁与人工验收全部通过，尚未发版、尚未 push。** 下一步就是 M7 §3.5 的九步。

| | |
|---|---|
| **这一版是什么** | ① **程序坞回归热修**（0.5.0 开桌面歌词就把整个进程降成 macOS accessory 应用：没有 Dock 图标、没有菜单栏、没有 Cmd+Q，而歌照放）② **多 P 视频的选集与命名**（模型不再替人选集；分P 按自己的标题命名；界面上它就是一个「合集」）③ **长期使用复盘两条**（歌词任务按它那首歌排序 · 重下删掉被替换的那一行）④ 手机设置页显示版本号 |
| **版本线** | 桌面 `0.5.0` → **`0.5.1`**；Android `0.2.0` → **`0.2.1`**（versionCode 4）。**两端必须一起发**——旧手机端连不上新 daemon 的分P 端点 |
| **协议 / schema** | `LOCAL_API_VERSION` **9 → 10**（`POST /download/parts` + `MULTI_PART_UNRESOLVED`）；**schema 仍 v3，无 migration，曲库不动** |
| **测试** | **3609**（`just test`），`just check` 绿（守卫十五条） |
| **验收** | 五套 **132/132**：`accept-gui` **18**（15 → 18）· `accept-cli` 27 · `accept-m5` 22 · `accept-sync` 36 · `accept-pack` 29 |
| **人工验收** | **桌面全绿**（程序坞三条 · 多 P 五条 · 命名两条 · 记录两条）· **真机全绿**（Android 0.2.1，versionCode 4，签名与版本号都由 `mobile-verify-apk` 验过） |
| **业务代码** | 528 文件 / 52,550 行（0.5.0 是 524 / 52,060） |
| **门禁产物** | dmg `79cc06df…3df91de8`（148,343,165 B）· tgz `4d04ac46…f1bce304`。**这两份是门禁产物，不是发布物**——发版要从打了 tag 的 HEAD 重打并重跑 `accept-pack` |

**这一版的形状，一句话**：*没有人替人选分P*。链接是离线识别的，谁都不可能在点之前知道它是多 P；模型以前替人选，答不出就落第 1 P——那是静默下错歌。现在三端都拒绝，由人用 `?p=` / `--part` / 界面回答。

**子计划** → **`docs/plans/2026-08-28-desktop-0.5.1.md`**（§1–§6 热修 · §7 多 P 六条决策与 P1–P6 · §8 复盘两条）。

### 上一站：桌面 0.5.0 + Android 0.2.0（2026-08-28 发布）

[Release v0.5.0](https://github.com/orpheus-aviary/lark/releases/tag/v0.5.0)（tag → `9b359c0`）+ [`@orpheus-aviary/lark-cli@0.5.0`](https://www.npmjs.com/package/@orpheus-aviary/lark-cli) + [Release android-v0.2.0](https://github.com/orpheus-aviary/lark/releases/tag/android-v0.2.0)（同一个 commit）。**桌面歌词**（第二个 renderer 窗口）· 下载记录持久化 + 来源 · 输入法组字不再误提交 · 手机歌词中线跳转。协议 8 → 9，测试 3547，五套 accept 129/129。**发出去当天就撞上程序坞那条回归**，见本页顶部。

### 下一步

**发版。** 九步照 `docs/plans/2026-08-08-m7-packaging.md` §3.5，每步用户确认，**两个 tag**：`v0.5.1` + `android-v0.2.1`。开始之前工作树要干净、要 push。

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
