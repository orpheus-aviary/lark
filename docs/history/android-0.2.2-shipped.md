# Android 0.2.2（2026-09-02 发布，桌面不动）

> 从 `PROCESS.md` 的「当前阶段」搬来（发版当天归档）。**第一次只发一条版本线**：这一批
> 只动了 `apps/mobile/`，`packages/` 与 `apps/cli` 一行没碰，所以桌面 `0.5.1` 与
> CLI `0.5.1` 留在线上不动，桌面五套 accept 也没有跑的理由。
>
> [Release android-v0.2.2](https://github.com/orpheus-aviary/lark/releases/tag/android-v0.2.2)（tag → `17f635b`）
>
> 子计划：`docs/plans/2026-09-02-mobile-input-list-downloads.md`（**§9 记着两次修法翻案与三次上机**）。

## 发出去的那一份

| | |
|---|---|
| **这一版是什么** | ① **输入框不跟着输入法走**（根因：targetSdk 35+ 之后 Android 15 强制 edge-to-edge，`adjustResize` 被停用，平台改成只平移出焦点那一个 view）② **弹框顶不上来 / 不自动弹输入法**（根因：sheet 当时是 `Modal`，也就是第二个窗口）③ **编辑一下就整段变选中**（`selectTextOnFocus` 被 Fabric 的整包 props 重发反复重新武装）④ **列表滚动条一边加载一边缩**（缺 `getItemLayout`）⑤ 下载页对齐桌面的三段 ⑥ 歌单页高亮正在播放的歌单 ⑦ 歌曲页新顶栏 ⑧ 四个 tab 保持挂载 ⑨ backlog **C16** 收掉 |
| **HEAD** | `17f635b236996fe21d8475865efadfb758f26964` |
| **版本线** | Android `0.2.1` → `0.2.2`（versionCode 4 → 5）。桌面/CLI 不动 |
| **协议 / schema** | `LOCAL_API_VERSION` 仍 **10** · schema 仍 **v3**。两者都没碰，因为 `packages/` 一行没改 |
| **测试** | **3629**（`just test`），`just check` 绿（守卫十五条） |
| **验收** | **三次真机会话**（清单与逐条结果在子计划 §6 / §9）。桌面五套 accept **未跑**——桌面产物没变 |
| **业务代码** | 535 文件 / 53,109 行（0.5.1 是 531 / 52,725） |
| **产物** | apk 88,613,828 B `0752f82e…ddbc857c`（versionCode 5，签名与 0.2.1 同）。发出去之后 `gh release download` 回读，与本地逐字节同哈希 |

**这一版的形状，一句话**：*一个窗口*。三个还没修好的问题——弹框顶过头、弹框不自动弹输入法、页面不给键盘让位——最后都收敛到同一句话：**边到边强制之后，平台不再缩窗口而是平移，只把焦点那一个 view 露出来**；而 `Modal` 是第二个窗口，它连那份补救都拿不到，平移量还是 JS 读不到的。让位改到应用根上一处、sheet 搬进应用自己的窗口，三条一起消失。

## 三次上机换来的三条

1. **「输入框能用」不等于「修好了」**：平台平移只保证焦点那一个 view 露出来，它下面的按钮照样被盖住。第一次上机差点把这个签名读成绿。
2. **`KeyboardAvoidingView` 在这里修不了**：它拿父容器坐标减屏幕坐标，中间差一个每屏不同又推导不出来的 `keyboardVerticalOffset`。
3. **一次真机读数只该回答一个是非题**（`screenY` 到底动不动），不是三个可以写进代码的常数。代码里一个数都没有。

逐条见 `docs/LESSONS.md` 的「Android 0.2.2 实测锁定」八条；仍然约束新代码的三条在 `docs/INVARIANTS.md` §7（键盘让位在根上 · 「挂载」≠「在屏」· sheet 不是 `Modal`）。

## 🔴 发出去的那一份没有上过机（如实记着）

三次真机会话验的是 `e90c145`。**发出去的是 `17f635b`**，两者差两处，都在发版收尾那一个 commit 里：

1. **版本号** `0.2.1/versionCode 4` → `0.2.2/versionCode 5`
2. **删掉了设置页顶部那行临时探针**（45 行，一个只显示文字的组件 + 它的样式和两个 import）

风险很低——`just check` / `tsc` / 3629 条测试都在 `17f635b` 上跑过，删的是一个没有任何人依赖的只读组件。但这个仓库自己反复说过「**验过的 ≠ 发出去的**」，所以记在这里而不是当它不存在。

**下次插上手机时顺手确认一次**：设置页顶上没有那行读数、版本显示 `0.2.2`。

## 发版路上踩到的两条

- **`android/` 是 prebuild 输出，改了 `app.config.ts` 的版本号要先 `just mobile-prebuild`**：直接构建会拿旧的 versionCode，而 `mobile-verify-apk` 当场红——**这次是门禁替我们抓住了版本号滞后**，历史上协议号和 `DAEMON_VERSION` 都栽过同一类。
- **手机锁屏时 `adb install` 报 `INSTALL_FAILED_ABORTED: User rejected permissions`**，看着像权限被撤，其实只是屏幕黑着（`dumpsys power | grep mWakefulness`）。
