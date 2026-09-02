# 手机端：输入框、列表、下载页三段（2026-09-02）

来源：用户 2026-09-02 报的四个现象 —— ①有些输入框不随输入法移动 ②下拉栏偶尔留一条空通知 ③歌曲页滚动条在抖、担心歌多了会卡 ④编辑一下会变全选。四条都定位到根因之后讨论收敛成本计划；②另有结论，**不在本批**（见 §7）。

一句话：**本批不加任何新依赖，改的是四处已知的错和一条页面生命周期规则。**

---

## §0 已定的决策（讨论结论，实施以此为准）

| 决策 | 结论 | 为什么 |
|---|---|---|
| **输入法怎么修** | **先只试 `KeyboardAvoidingView`**（零依赖），同一个包里带一行临时读数，一次上机同时回答「成没成」和「不成是为什么」 | 根因是 targetSdk 35+ 在 Android 15 上**停用了 `adjustResize`**；KAV 是否有效取决于 `endCoordinates.screenY` 还动不动，**这个只有设备能答** |
| **不引 `react-native-keyboard-controller`** | ❌ 本批不引 | 它**硬依赖 `react-native-reanimated`**（官方安装文档原话）。为「垫多少 padding」引入 Reanimated + worklets 插件，和这个 app「没有 zustand、没有 router、没有手势栈」的整条线冲突 |
| **全选怎么修** | `Prompt` 改**非受控** + `onFocus` 里 `ref.setSelection()`，且**只在第一次获得焦点时**全选 | `selectTextOnFocus` 是 prop，会被 Fabric **每次全量重发的 props 重新武装**；命令式 `setSelection` 不是 prop，切断这条链。限制成首次是因为「点回输入框继续改」是真实动作，那时再全选是破坏性的 |
| **滚动条** | `getItemLayout`，行高**量一次**（onLayout）而不是写死 | 写死会在系统字号放大时竖向裁字 |
| **列表性能** | 只做**搜索节流**和**行 memo** 两项 | 其余两项（去掉 `rows` 复制、分页）到千首级再说，见 §7 |
| **四个 tab 保持挂载** | ✅ 统一四个，不做「只保歌曲页」 | 「为什么只有歌曲页特殊」是一条会被反复重新问起的规则；且设置页保持挂载**顺手修掉 `LESSONS.md:312`**（填到一半按 BACK，草稿连同页面一起没了） |
| **隐藏 ≠ 卸载，所以要有 `visible`** | 新规则：**tab 不卸载；隐藏的 tab 不算「在屏」** | 两条正确性依赖今天靠"卸载"隐式成立（§3），一条性能依赖同理 |
| **下载页段名** | 照桌面：**进行中 / 排队中 / 已结束** | 「已下载」会说谎——那一段里装着失败和已取消 |
| **空段全画 + 一行小字** | ✅ **与桌面有意分叉**（桌面 `count===0` 整段不画） | 手机上这一页就是整个屏幕，「没有在排队」是有人特地进来看的答案；桌面那是对话框，空段只是噪音 |
| **按钮行位置** | `全部取消` + `清空记录` 并排一行，放在**「下载」按钮下面**（表单与三段之间）；**没得做时置灰不隐藏** | 对应桌面对话框底部那一行；置灰则按钮位置固定，下面的内容不会跳动。`全部重试 N` 仍留在「已结束」段头（也照桌面） |
| **排队段的行** | 不写状态行，只留来源 | 段头已经写着「排队中」，手机屏窄 |

---

## §1 · P1 输入框（输入法 + 全选）

**改哪里**

- `ui/settings-tab.tsx` — 现有 `ScrollView` 外包一层 `KeyboardAvoidingView behavior="padding"`。
- `ui/add-tab.tsx` — 整页那个 `FlatList`（`TaskList`）外面同样包一层。
- 🔴 **Modal 里的输入框一律不动**：`sheet.tsx` 的 `Prompt`、`edit-link`、三个 picker、`add-songs`。RN 给 dialog 窗口**单独关掉了 edge-to-edge**（`ReactModalHostView.updateProperties` → `disableEdgeToEdge()`）并设了 `ADJUST_RESIZE`，它们本来就是好的。给它们也包一层只会制造第二个位移源。
- `ui/settings-tab.tsx` 顶部加**一行临时读数**：`keyboardDidShow` 的 `screenY` / `height` / 窗口高度。**验完就删**（release 构建的 `console.log` 到不了 logcat，所以读数要显示在屏幕上，不用连 adb）。

**上机三种结果，各自的下一步**

| 看到 | 结论 | 下一步 |
|---|---|---|
| 字段被顶到键盘上方 | 成 | 删掉临时读数，其余页面照抄，收工 |
| 完全没动，且读数里 `screenY` 不随键盘变 | KAV 这条路走不通 | 进 `softwareKeyboardLayoutMode: 'pan'`（一行）或自建 `lark-insets` 原生模块二选一，**要第二次上机** |
| 动了但还压着一点 | 基准差一个偏移 | `keyboardVerticalOffset` 补，不用第二次上机 |

**全选**（`ui/sheet.tsx` 的 `Prompt`）

- 去掉 `selectTextOnFocus`；`value` → `defaultValue`，值存 ref，`onConfirm` 时读 ref。
- `autoFocus` 保留；`onFocus` 里 `ref.current?.setSelection(0, initial.length)`，用一个 `useRef(false)` 门住只做一次。
- 那段解释「为什么预填 + 全选」的注释要跟着改——`scripts/drive.mjs` 用 `input text` 驱动的前提（打开即全选、输入即替换）在新写法下**仍然成立**，注释要说清是靠 `setSelection` 而不是靠那个 prop。

---

## §2 · P2 列表（滚动条 + 两个旋钮）

**① `getItemLayout`，行高量一次**

- 新增 `ui/row-metrics.ts`：模块级缓存一个行高，**键是 `PixelRatio.getFontScale()`**。
  理由：manifest 的 `configChanges` 里没有 `fontScale`，改系统字号会重建 Activity，而**重建 Activity 不会重启 JS 进程**（`INVARIANTS` §6 的 `bootOnce`），模块级缓存会活下来并且是旧的。
- `ui/song-row.tsx` 第一次渲染时 `onLayout` 上报一次高度；拿到之前 `getItemLayout` 不传，拿到之后传。切换发生一次/进程，可接受。

**② 搜索节流**

- 新增 `ui/use-debounced.ts`（十几行），`SEARCH_DEBOUNCE_MS = 200` —— **和桌面同一个数字**（`gui/.../TopBar.tsx:27`）。
- 用在两处：`songs-tab.tsx` 的搜索框、`add-songs.tsx` 的搜索框。
- 守卫无关：`check-mobile-no-js-timers.sh` 只管 `src/player/`，而它自己的注释写着判断标准是「这个等待在熄屏时还有意义吗」——搜索框按定义屏幕是亮的。

**③ 行 memo**

- `SongRow` 包 `memo`。
- 🔴 **同时必须把 `songs` 这个 prop 拿掉**，否则 memo 白加：每次库变化都是一个新数组，逐行 props 必变。改成传一个**稳定的** `getQueue: () => PlayQueue`（`useCallback` + ref），它本来就只在点下去那一刻需要。
- `renderItem` 从内联箭头提成 `useCallback`。

---

## §3 · P3 四个 tab 保持挂载 + `visible` 语义

**改哪里**：`ui/shell.tsx` 四个 tab 常挂，用 `display: 'none' | 'flex'` 切换，并把 `visible` 传给四个页面。

**四条 gate（这才是本批的主体，性能只是副产品）**

1. **可见队列** —— `useVisibleQueue(build, visible)`，gate 写在 hook 里（只有一处）。
   不做会怎样：`player/visible-queue.ts` 是 last-writer-wins，注释原话 *"tabs are unmounted when you leave them"*。歌单详情 publish 之后切回歌曲页，歌曲页的 effect 依赖没变、不会重跑 → **可见队列还是歌单的**，一个 30 秒后落地的 ensure-file 播放会按错的列表续播（违反 §2.9）。
2. **返回键** —— `useBack(active && visible, …)`，三处（歌曲页选择、歌单详情选择、歌单详情本身）。
   不做会怎样：歌曲页勾着几首歌切到设置页，按返回**清掉的是那个看不见的选择**（优先级 30 > tab 的 10），而不是回到歌曲页。
3. **派生值隐藏时冻结** —— 各页面把 `useMemo` 的依赖从 `view` 换成一个「最后一次在屏时的 view」：
   ```ts
   const [shownView, setShownView] = useState(view);
   if (visible && shownView !== view) setShownView(view);   // React 的「渲染期调整 state」
   ```
   成本 profile 因此和今天完全一样（今天也是回来才算），换到的是滚动位置不丢。
4. **设置页的缓存占用走同一个 `shownView`** —— 它是四个里最贵的：`cacheStatus` 的 `scan()` 是**对每一首歌做一次 `statSync`**（`portable/library/cache.ts:143-151`），`readDeviceUsage` 还要**把这台手机上其他工作区一起走一遍**。它挂在 `useMemo(…, [view, …])` 上，不 gate 的话**每下载完一首就把整个曲库 stat 一遍**。
   那段注释写着「this screen is not a hot path」——**那句话成立的前提正是「切走就卸载」**，本批把前提改掉了，就得把话补上。

**滚动位置**

- `onScroll` 把 offset 记进 ref；`visible` 变 true 时 `scrollToOffset({ offset, animated: false })`。
- 为什么无条件写：`display:none` 时子树不参与布局、contentSize 归零，原生 ScrollView 的偏移**可能**被 clamp 到 0。没被 clamp 的话这行是设成同一个值，无害——**这样就不用先上机量一次再决定怎么写**。
- 它依赖 P2 的 `getItemLayout` 才能瞬时且准确，所以 P2 必须在 P3 前面。

**「回到顶部」从免费变成要显式写**

今天靠重挂载一刀切地免费得到，以后要分开写，三条都要：

- 排序字段变 → `scrollToOffset(0)`
- 提交后的搜索文本变 → `scrollToOffset(0)`
- **切 tab 回来 → 不回顶**（这正是要买的东西）

---

## §4 · P4 下载页三段

- `downloads/rows.ts`：`DownloadSection` 从 `'tasks' | 'records'` 扩成 `'running' | 'queued' | 'records'`，按 `task.state` 拆，三段都出 head，空段出一行小字：
  - 进行中 →「没有正在下载的歌」
  - 排队中 →「没有排队的任务」
  - 已结束 →「还没有下载记录」
- `ui/task-list.tsx`：`case 'head'` 分三支；`全部取消` + `清空记录` 从段头移到 header 区（「下载」按钮下面、三段上面），**置灰不隐藏**；`全部重试 N` 留在「已结束」段头；排队段的行不渲染状态行。
- 排序仍用 `orderedTasks`（两端同一个函数），只是分组之后各自排。

---

## §5 判据

**单测能红的（本批唯一一处，就在 P4）**

- `downloads/rows.test.ts`：分组错、空段小字丢了、顺序错——都会红。**其余判据没有能红的单测**：`ui/*.tsx` 都 import react-native，`vitest.config.ts` 的白名单收不到，这一点如实写在这里，不假装。

**只有设备能答的** → 全部集中到 §6 的一次会话。

**跑得到的门禁**：`just check`（十五条守卫）+ `just test` 全绿；新增文件不破分层与移动端 import 守卫。

---

## §6 一次真机会话（用户操作，AI 只装包 + 讲清楚看什么）

按顺序，每条都写了「什么样算红」：

1. **输入法·设置页**：点最下面那个字段（sync 密码 / LLM key）。红 = 字段仍被键盘压着。**同时记下顶部那行临时读数的 `screenY`**（决定 §1 走哪条后路）。
2. **输入法·添加页**：粘一段链接，键盘弹着时「下载」按钮还看得见吗。
3. **对照组·改歌名弹框**：本来就该是好的。红 = 连 Modal 也坏了 ⇒ 说明我们包错了层。
4. **全选**：改歌名 → 打三个字 → 红 = 变成整段选中；再点别处、点回输入框 → 红 = 又全选了。
5. **滚动条**：从设置页切到歌曲页，看右侧滚动条。红 = 滑块长度还在变。
6. **滚动位置**：歌曲页滚到中间 → 切设置 → 切回。红 = 回到顶部。
7. **排序回顶**：滚到中间 → 换排序字段。红 = 停在半山腰。
8. **搜索回顶**：滚到中间 → 搜一个词。红 = 停在半山腰。
9. **返回键不被隐藏页抢**：歌曲页长按勾 2 首 → 切设置页 → 按返回。绿 = 回到歌曲页且选择还在；**红 = 停在设置页而选择被清掉**（gate ② 没写对）。
10. **可见队列**：先打开一个歌单详情再返回 → 在歌曲页点一首**没有文件**的歌 → 等它下完自动播 → 看下一首。绿 = 歌曲页列表里的下一首；**红 = 歌单里的下一首**（gate ① 没写对）。
11. **隐藏页不重算**：下载三五首，全程停在歌曲页 → 下完切到设置页。绿 = 缓存占用数字是**新的**（说明重算发生在「切回来」那一刻）；红 = 数字是旧的（冻住了没解冻）。
12. **下载页三段**：空库时三段都在、各一行小字，两个按钮置灰；下载时「进行中 / 排队中」分开、排队的行不重复写状态。

**已知的会话风险**：第 1 条如果是「完全没动」，输入法这一条要第二次上机（`pan` 或自建 insets 模块）。其余十一条一次跑完。

---

## §7 明确不做

| | |
|---|---|
| `react-native-keyboard-controller` + Reanimated | ❌ 本批不引，理由见 §0。只有 KAV 与 `pan` 与自建模块三条都不成时才重开这个话题 |
| `@shopify/flash-list` | ❌ 又一个原生依赖；FlatList + `getItemLayout` 到几千行足够 |
| `maintainVisibleContentPosition` | ❌ 暂不加。保持挂载后，新歌插在当前位置上方会让内容错开一行；等真觉得烦再说 |
| 去掉 `rows` 的整份复制 · 列表分页 | ❌ 本批不做（旋钮 3/4）。分页会拿掉「内存里有一份全量列表」这个前提，而排序、可见队列、全选都建立在它上面 —— 真到五千首再谈 |
| 「只保歌曲页挂载」 | ❌ 已否决，见 §0 |
| 空通知（backlog **C17**） | ❌ 本批不修。已记进 backlog，下次出现时先 `dumpsys` 取证 |

---

## §8 收尾要写的三处

- **`docs/INVARIANTS.md`** —— 新规则一条：**「tab 不卸载；隐藏的 tab 不算在屏」**，附三条 gate 清单（可见队列 / 返回键 / 派生值与缓存占用）。这是**会约束新代码**的：以后任何挂在 tab 上的订阅都要回答「隐藏时它该不该跑」。
- **`docs/plans/2026-08-26-backlog-before-android-v1.md` E 节** —— 记「手机三段空段全画，桌面隐藏空段」是**有意分叉**，防止下次两端普查当成漂移重新捡起来。
- **`docs/LESSONS.md`** —— 只有在 §6 第 1 条红了才写：RN 的 `KeyboardAvoidingView` 在 edge-to-edge 下为什么会静默失效（`screenY` 来自 `getWindowVisibleDisplayFrame`，窗口不缩就不动）。

---

## §9 实施修订

（开工后追加，不改上文）

### 2026-09-02 · 第一次上机的结果

装机跑了 §6 的十二条。**三条红线判据全绿**（返回键不被隐藏页抢 · 可见队列 · 隐藏页不重算），**全选也绿**，下载页三段与滚动条绿。

**A / B 红**，而且红的方式改变了修法：设置页的字段和添加页的「下载」按钮都没有被顶到键盘上方，但**输入不受影响**。这两件事同时成立只有一个解释——**平台在平移（pan）而不是缩放**：它只保证焦点那个 view 露出来，它下面的东西照盖。所以「下载」按钮（在输入框下面）和弹框的「保存/取消」（在输入框下面）是同一个根因。

探针读数：`screenY 420 · 高 284 · 窗口 720`。**这条读数只回答了一个是非题**——`screenY` 会不会随输入法移动。会。于是：

- ✅ 不需要 `react-native-keyboard-controller`、不需要 `pan` 模式、不需要自建 insets 模块。
- ❌ 但也**不是** §1 写的 `KeyboardAvoidingView`：它拿自己的布局（父容器坐标）去减 `screenY`（屏幕坐标），中间差着一个每屏都不一样、又推导不出来的 `keyboardVerticalOffset`。
- ✅ **改成在 app 根上垫 `根高 − screenY`**（`App.tsx` + `ui/keyboard.ts`），等于自己把 `adjustResize` 实现一遍。理由是历史的：这个 app 的每一处布局都是照着 `adjustResize` 写的（设置页靠 ScrollView 缩小把焦点行滚进来 · 添加页把按钮放输入框上方 · LESSONS 量过 tab 栏在键盘上方可点）。**把它们当年依赖的前提还回去，比一屏一屏补小。** 代价：tab 栏和迷你条会跟着上移（Android 15 之前就是这样）。
- ✅ **`Modal` 是独立窗口，吃不到根的 padding**，所以 sheet 和三个全屏对话框各自垫 —— 用的是**另一个数**（`endCoordinates.height`），因为 RN 给 dialog 关掉了 edge-to-edge，它本来就停在导航栏上方。两个数**结构上配平，不按机型标定**。
- ✅ **`autoFocus` 改成 `Modal` 的 `onShow`**：`autoFocus` 在 `onAttachedToWindow` 里跑，而 RN 是 `dialog.show()` 的下一行才清 `FLAG_NOT_FOCUSABLE`，`showSoftInput` 静默失败。它一直在赌时序，只是以前被「打开即全选」的视觉盖住了。

### 2026-09-02 · 用户新提的四件，一并做了

1. **播放队列那张表的滚动条**（从 minibar 打开的那张）——`row-metrics.ts` 从「歌曲行高」推广成带 key 的一张表，队列行自己测自己的高度（它一行，歌曲行两行）。**下载任务列表不加**：它的行高不是常数（失败多一行错误、有来源多一行来源），`getItemLayout` 在那儿会算错。
2. **歌单页高亮正在播放的那个歌单**——判据是队列自己带的 `source`：`kind: 'playlist'` 才高亮，从歌曲总览页起播是 `kind: 'all'`，不高亮任何歌单，正是用户要的语义。颜色用 `theme.ts` 已经定义为「正在播放的行」的琥珀。
3. **顺手收掉 backlog C16**——歌单详情改成复用 `SongRow`。一次拿到：当前曲高亮 · 时长 · 固定标记 · 那张表的滚动条。**行为有一处变化**：点正在播的那首现在是暂停/继续（和歌曲页一致），以前是从头重播。
4. **歌曲页顶栏两行**——搜索整行 + 有字时出现的 ✕；第二行 `N 首` + 返回顶部 + 定位当前 + 排序两个。`定位当前` 在「没在播 / 不在这个列表 / 还没量到行高」时**置灰**（`scrollToIndex` 没有 `getItemLayout` 会抛）。

### 下一次上机要看的（在 §6 十二条之外）

1. **设置页最下面的字段、添加页的「下载」按钮**——这次要真的在键盘上方（A/B 复验）
2. **改歌名/改歌手/新建歌单**：打开就自动弹输入法 · 整个卡片在键盘上方（保存和取消都点得到）· 三个弹框行为一致
3. 更改链接 / 分P 选择 / 导入歌单三个对话框，键盘弹起时底部按钮还在
4. **播放队列**那张表的滚动条不再抖
5. **歌单页**：从歌单里起播 → 那一行变琥珀 + ▶；回到歌曲页起播 → 没有任何歌单高亮
6. **歌单详情**：有时长、有固定标记、正在播的那首是琥珀；点正在播的那首是暂停而不是重播
7. **歌曲页顶栏**：✕ 只在有字时出现 · 返回顶部 · 定位当前（没在播时是灰的；播一首列表里的歌之后变亮、点了能跳过去）
8. 探针那行还在，**这次之后再删**
