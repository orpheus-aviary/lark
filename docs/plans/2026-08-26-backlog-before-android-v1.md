# lark 待开发清单 —— Android 首次发版之前（2026-08-26）

> **性质**：备忘清单，不是设计稿。每项记「是什么 / 为什么 / 落点 / 验收 / 已知坑」；开工前若需要设计，另拉 design doc。
> **口径**：Phase B N0–N7 全部完成、Android 尚未发版这一天的盘点。已完成的不列（历史见 `PROCESS.md` 的归档表）。
> **状态源**：当前进度**永远以 `PROCESS.md` 为准**；本文只在有项目完成或新增时改。
> **编号是稳定的**：A1 / C3 / E2 这样的 id 一旦给出就不复用，别的文档可以直接引它。
>
> 盘点来源：`docs/history/phase-b-shipped.md` 的各批残留 · N4/N5/N7 子计划的「不做/搁置」段 · 2026-08-26 的真机会话与文档整理。

## A. 发版前必须做完（Android v1 的门）

> **2026-08-27 更新：A 节已全部关闭**（A5 于 Android 0.1.1 发版当天由用户手动补齐）。原记：**已发版，A 节只剩 A5。** A1 / A2 / A3 / A4 全部完成（下面逐条标注），**A5（手机补 LLM key + 重新登录）由用户自己做**。下一份 backlog 应以「首发之后」为口径重开。

- **A1 · 文档大整理** —— ✅ **完成 2026-08-26**（含 `README.md` 的 Android 一节）。本文件、`PROCESS.md` 瘦身、`docs/INVARIANTS.md`、`docs/history/` 归档、`.tokeignore` 都属于它。剩下的一半是**面向用户的文档**：`README.md` 要加 Android 一节（装什么、从哪装、和桌面什么关系、数据在哪、卸载会丢什么）。
- **A2 · 跨仓文档跟进 Phase B** —— ✅ **完成 2026-08-26**（`aviary` 与 `.github` 两个仓各一条提交）。原文： —— `../aviary/docs/ROADMAP.md` 与 `DESIGN.md`、`.github/profile/README.md` 里 lark 的状态还停在「0.3.0 已发」，**完全没有 Android 这条线**。发版当天一并跟进。
- **A3 · 发版本身** —— ✅ **完成 2026-08-26**（`v0.4.0` + `android-v0.1.0` 两个 Release + npm 0.4.0）。原文： 只在 GitHub Release 发 APK，**不进商店**（⇒ developer verification 不注册），签名从简（已有 lark 自己的 release key，`just mobile-verify-apk` 是门禁）。**桌面版打包记得用图标。**
- **A4 · 发版前复跑桌面 accept 全系列** —— ✅ **完成 2026-08-26**，128/128。原文： 只在这次发版同时动了桌面时才需要；桌面自 2026-08-26 的 128/128 之后若一行未改，可直接引用那次结果。**别把它当成可省的一步**：N1 判据 22 欠了六轮才还上。
- **A5 · 手机恢复可用状态** —— ✅ **完成 2026-08-27**（用户手动补了 LLM API Key 并重新登录）。原文： 现在是**登出**且 **LLM API Key 随卸载丢失**。发版前要用户手动补一次，并确认登录后的完整链路还在。

## B. 明确延后、但已经有形状的

- **B1 · TLS（D15）** —— 已从「阻塞」降为「后续」（2026-08-25，主计划 §4.3 Stage-4 修订）。skybridge server 至今是 `http://<公网IP>:8443`，移动端靠设置页一个明文开关。真要做时验收不变：域名 + DNS · 证书 + 自动续期告警与演练 · 反代 · 两端 `server_url` 迁移 · 真机连通。**负责人 = 用户，AI 协助。**
  ⚠️ 大陆 ECS 有一条坑链：未备案域名的 80/443 被拦 ⇒ 非标端口 ⇒ HTTP-01 / TLS-ALPN-01 都走不通 ⇒ 只剩 DNS-01（Caddy 要带 `caddy-dns/alidns` 重建）。LE 的 IP 证书（6 天 shortlived）可绕开域名但链路未验。见 N5 子计划 §0.1。
  **换 URL 不打断绑定**——锚是 `server_id`。
- **B2 · 移动端后台同步**（N5 决策 b）—— 现在同步只在前台跑，**手机在后台收不到别人的改动**。这是如实的产品形状，不是 bug。真要做要面对 Android 的后台限制（dataSync 配额、Doze），且要重新回答「后台轮次能不能安全地写库」。
- **B3 · 锁屏 / 通知栏的暂停键接进 JS**（N4g 决策 j 的缺口）—— `modules/lark-audio` 加一个 media-session 回调面，让它也能作废等待中的 ensure。**2026-08-25 用户决定先不做**；实际使用中被咬到再捡。

## C. 技术债与没拿到的证据（都已登记，没有一条是紧急的）

- **C1 · 判据 76：`SYNC_PULL_LIMIT_MOBILE` 在竞争条件下复测** —— 要 ~2000 行合成负载，一边播放一边拉 200/批，p95 ≤ 100ms；超了把常量降到 100（无协议含义）。**真实两端加起来只有 18 首，跑不出这个判据。** 在那之前「200 在竞争下也够」是**未经证明的假设，不是结论**。
- **C2 · 判据 80 / 81 的界面证据** —— 冲突页与失败 file-op 的重试/放弃**在屏幕上一次都没被人看见过**（`resolveConflict` 的语义在 core 有测，界面那一层没有）。造一条真冲突要两台设备互写，造一条失败 file-op 要文件系统在特定时刻失败。下次两端 soak 或真撞上时顺带看一眼。
- **C3 · `imported` 行第一次出现在手机上** —— 同步会照拉 `file_origin`，缓存清理那一半的不变量跟着 portable 搬过来了；危险的是 **ensure-file**（imported 可能没有 `source_key`，无处可下）。**本机库 0 首 imported ⇒ 只能落单测。**
- **C4 · 判据 32 的设备半边**（批量部分成功那一行没在屏幕上见过）· **判据 18**（6 小时 dataSync 配额无真机证据，判据本身已取消）· **判据 31** 按标题而非 bvid 比对（已接受）—— 三条都是「留到实际使用发现再说」。
- **C5 · 判据 116 的真机半边留白** —— 「用第二个账号新建空曲库」这一步 2026-08-26 的会话按用户决定没测；电脑侧单测仍在。
- **C6 · 判据 20（音频焦点行为表）搁置** —— 来电 / 别的应用起播 / 导航语音三条没有逐条断言。**实现整个由 expo-audio 提供，lark 一行没写**，所以不存在「声明了没验过」的实现面。
- **C7 · 判据 16b（D2D 手机搬家）搁置** —— `<device-transfer>` 的九个 domain 照写且 16a 逐 domain 验过文件内容；不做的是走一遍系统「手机搬家」。**这一半是「声明了但没验过」。**
- **C8 · 日志脱敏** —— `downloads/log.ts` 现在带原始错误，也就带泄漏面。判据 30② 与脱敏都按用户决定暂不做。
- **C9 · 歌词平台内部并发** —— 每平台 1+3 次串行往返，约 0.5–2 秒。记录不改。
- **C10 · skill 的「agent 实际可调用」验收** —— M6 起挂着，M7 也没做。需要真的让一个 agent 照 `lark skill export` 的说明书跑几条命令。**归用户手动。**
- **C11 · 移动端选择态脚手架在两个屏幕上重复** —— `songs-tab.tsx` 与 `playlist-detail.tsx` 各有一份 `rows / picked / leaveSelection / useBack(BACK.selection)`（0.1.1 P1 拆分之后才看得见，十行逐字相同）。抽成一个 hook 是对的，**但没在发版前动**：这两块只有 tsc 和真机验得到，而真机刚验过的就是要发出去的那份产物。下一批 UI 工作顺手做。
- **C12 · 三份 StyleSheet 抄着同一批样式** —— `settings-tab.tsx` / `sync-section.tsx` / `edit-link.tsx` 各有一份 `input` / `button` / `field` / `note`（约二十行逐字相同），`playlist-detail.tsx` 与 `playlists-tab.tsx` 之间还有一份 `newButton`。延后的理由同 C11，做的时候一起做。

- **C13 · 恢复会盖掉一个已经被接受的 seek**（0.5.1 取证时翻出来的）—— daemon 重启后，GUI 的 SSE 命令通道**重新注册得比 `loadedmetadata` 早**，于是 `POST /player/seek` 答 200、位置也确实被设了，紧接着 `player/recovery.ts:70` 无条件写回重启前保存的位置，把它盖掉。**用户看到的是：命令被接受了，但什么都没发生。** 窗口很窄（daemon 重启后的几秒），所以不在热修里动；真要修是让恢复知道「有没有更新的 seek 发生过」，而不是无条件还原。`accept-gui` 判据 6 现在用有界重试跨过这个窗口——**判据不再红了，但产品的这个洞还在**。
- **C14 · `[重复]` 标记只有桌面有**（2026-08-31 普查）—— `renderer/lib/duplicates.ts` 是纯函数但没进 shared，所以手机的同步页只能写「**桌面版的列表里标着「重复」**，删掉一条即可」（`ui/sync-section.tsx`）：它如实告诉用户「这件事去电脑上做」。搬进 `@lark/shared` + `song-row.tsx` 加一个通道即可，**没有设计问题，只是没做**。
- **C15 · 手机歌曲页的多选没有「下载」**（2026-08-31 普查）—— 桌面批量条有「下载」（只补缺失文件）；手机只有歌单详情的「全部下载」（0.1.1 决策 4「只在详情页」，当时是为了承载上限门的失败记录）。**同步下来、不在任何歌单里的一批没文件的歌，在手机上只能一首一首点**。做的话要回答「歌曲页的批量下载走不走预算门」——大概率要走，那就是把 `downloadAll` 的那段抽出来。
- **C16 · 歌单详情的行和歌曲页的行仍是两份**（C11/C12 的第三次代价，2026-08-31 普查）—— `playlist-detail.tsx` 自己画行，只有「歌手 · 需要下载」，**没有时长、没有固定标记**；`song-row.tsx` 两个都有。0.5.1 刚因为同一个根因丢过「需要下载」并补回，**补的是那一处而不是根因**。
- **C17 · 下拉栏偶尔留一条空通知**（2026-09-02 用户报；**只有代码层定位，没有真机取证**）—— 画得出「空通知」的只有 expo-audio：`AudioControlsService.kt` 的 `buildPlaceholderNotification()` 标题是 `\u200E`（不可见字符，上一行注释写明是为了避开「<AppName> is running…」），没有正文、没有按钮。它由 `onStartCommand` 的第一句 `ensureForegroundNotification()` 贴出，而 lark **一首歌一个 driver**（`player/driver.ts`），每次换歌都会 `setActiveForLockScreen` → `bindWithService()` → **`startService()`** → 走一遍 `onStartCommand`；那一刻 `mediaSession` 还没建好（会话在 `mainQueue.launch` 里异步建），`buildNotification()` 返回 null ⇒ 贴占位。**留下来**还要再叠一个条件，两个都够：① **通知 id 会变**——`notificationId = currentPlayer?.hashCode() ?: CHANNEL_ID.hashCode()`，`startForeground(idA)` 之后再 `startForeground(idB)` 不会收走 idA 那条，而 `hideNotification()` 只 cancel 当前 id；② 建会话的协程在 `reactContext` 为 null 时 `return@launch`，那条占位从此没人替换也没人取消。**「下载之后」最容易撞上**：`ensure-file` 完成会自动起播（`downloads/ensure.ts` → `fetchAndPlay`），那是一次没人按的换歌。lark 自己的下载通知画不出空的（永远带「正在下载 N 首」）。**下次出现先取证**：`adb shell dumpsys notification --noredact | grep -B5 -A30 orpheusaviary`，看 posted 记录（不是 channel 定义，`LESSONS` 那条坑）的 channel 是 `expo_audio_channel`（= 这条）还是 `lark.downloads`（则本条推断作废）。真要修是给 `patches/expo-audio@57.0.3.patch` 再加一个 hunk，把 `notificationId` 钉成常量——lark 任何时刻只有一个 driver、一个 session，固定 id 反而更正确。

## D. 首发之后

- **D1 · 桌面下一版** —— ✅ **完成 2026-08-27**（0.4.0 发了 N1/N4/N5/N7 那批，0.4.1 发了 0.1.1 的桌面另一半，两次都走九步、都复跑五套 accept）。原文： N1 的 portable 重构、N4/N5/N7 的桌面改动都还没随任何一个桌面版本发出去。发时走 `docs/history/v0.1.0-shipped.md` 记的那条九步发版链路。
- **D2 · 长期使用复盘** —— owl 的 0.6.2 是靠「用了三周之后回头看日志」挖出一批同步问题的（游标互相清零藏了三周，因为**缺的是轮次 summary 日志**）。lark 两端跑起来之后值得照做一次：先确认日志能回答「这一轮拉了多少推了多少」。
- **D3 · 彻底删除已撤销的设备** —— 现在删不掉（`changes.device_id` 与 `attachments.uploaded_by_device` 是 `ON DELETE RESTRICT`），前端只能折叠。真要做绕不开「那些 change 行的 `device_id` 变成什么」这个协议级决定，**而 owl 用的是同一个 server**。要做就单独拉设计。

- **D4 · iOS** —— 从来没在范围内，记一笔是因为 `apps/mobile` 的端口层本来就是为「换一个宿主」写的。真要做，先数 `modules/` 下五个自建原生模块各要多少工。
- **D5 · 桌面记住「上次听到哪」**（2026-08-31 普查）—— `portable/last-playback.ts` 是两端共用层，注释里还写着「**桌面侧**的写入节奏刻意粗」，但全仓只有 `apps/mobile/src/App.tsx` 读它；daemon 明写「重启合法地忘掉播放状态」（`player-runtime.ts`）。**桌面关了再开，播放器是空的**，手机记得。规则、存储、失效面都现成，缺的是 GUI 侧的写入与启动恢复。要先答一个问题：桌面的「上次」存哪——`local_metadata`（跟着曲库走，和手机同构）还是 localStorage（跟着安装走，和 `play_mode` / 排序同构）。

## E. 已决定不做 / 已完成 —— 防止重复捡起

| 项 | 结论 |
|---|---|
| **登录后再问「并入 / 新建」**（而不是登录前选） | ❌ **2026-08-26 用户决定不做**。形状是通的（`resolveTarget` 天然可以 await 一个 UI 承诺，且它排在 `resolveDevice` **之前**，所以取消是干净的、不会多注册设备），但**手机能做、桌面做不了**——daemon 的 `POST /sync/login` 要么挂着等人几分钟，要么改成两步而远端登录跑两次。两端会从此分叉。**别再提。** |
| **`lark sync login` 加 `--workspace-origin` 标志** | ❌ **2026-08-26 用户决定不加**。CLI 首次登录默认走 `claim`（并入），会静默复制整个曲库。已知并接受。 |
| **N2 判据 14 的拖柄重排** | ❌ 用户决定不做。 |
| **N0b-3 的「出口 B」（整文件 sha256 走 JS）** | ✅ **作废**——N6a 实测原生比按纯 JS 的估算快约 500 倍（2MB p95 **2ms** / 20MB **13ms**）。`expo-crypto` 就是答案。 |
| **`expo-document-picker`** | ✅ **作废**——`expo-file-system@57` 自带 `File.pickFileAsync` + `file.bytes()`，零新依赖。 |
| **抽 `@orpheus-aviary/daemon-kit`** | ❌ v0.1 就决定直接复制 owl 模式，出现明显重复再重构。至今没有。 |
| **桌面做蓝牙歌词** | ❌ **整个不做**——`MPNowPlayingInfoCenter → AVRCP` 这一跳查不到 Apple 的任何承诺，而桌面只有 mac 一个 target。 |
| **`ffmpeg-static` / `@derhuerst/ffprobe-static`** | ✅ **已移除**（其二进制 `--enable-nonfree`，不可再分发）。改自建最小 LGPL profile + `just fetch-ffmpeg` 门禁。**别再装回来。** |
| **给「只有自己用」的导出摘掉 `export`**（49 处） | ❌ **2026-08-27 决定不做**。发版前的扫描里有 49 个导出没有任何外部引用，但它们绝大多数是**词汇表**（`FILE_OP_KINDS`、`SYNC_ENTITY_TYPES`、`EXIT_*`、`LIBRARY_LIMITS`）或一个包有意留的公开面，摘掉只是把三十个文件搅一遍。**真正死掉的四个已经删了**（0.1.1 P7）。 |
| **`@dnd-kit` 新架构** | ❌ 走 legacy。新架构依赖 jsdom 缺失的三个浏览器 API，且以未捕获异常炸整个测试文件。 |
| **手机的歌词管理面**（重新下载歌词 / 删除歌词） | ❌ **N4i 决策 f**（2026-08-24）。桌面行菜单有这两项，手机连一个歌词管理面都没有，两项**没有落脚点**。留给「有人真的需要」的那天。**2026-08-31 补记进 E 节**：此前它只写在 `plans/2026-08-24-phase-b-mobile-n4i.md` 里，每次两端对照都会被重新捡起来问一遍。 |
| **手机的「复制歌曲 ID」** | ❌ **N4i 决策 f**（2026-08-24）。ID 在手机上**没有消费者**——没有控制台、没有 CLI。同上，2026-08-31 补记进 E 节。 |
| **桌面做下载预算门**（批量下载撞缓存上限就停） | ❌ **0.1.1 决策**（2026-08-27，「桌面**不做**预缓存，只跟规则和开关」）。手机做是因为手机的盘是紧的；桌面的缓存上限照旧靠下载后的清理来满足。 |
| **设备上做「改→建→验红→还原→再建」的反测** | ✅ **取消**（2026-08-23 测试规模定案）——反测全部搬进单测。代价是失去设备侧「破了会红」的证据，已接受。 |
