# 归档：决策记录（2026-07 至 2026-08）

> 归档自 `PROCESS.md`（2026-08-26，Phase B 收口后整理）。**不再更新。**
> 当前进度以 `PROCESS.md` 为准，仍然生效的约束在 `../INVARIANTS.md`，实测踩坑在 `../LESSONS.md`。
>
> 读它的正确姿势是**带着问题来查**（「这个决定当时为什么这么定」「那条判据当时怎么过的」），不是从头读一遍。

按时间倒着记的定案流水：每条是「什么时候、谁定的、定了什么」，多数附带当时的理由或实测依据。
**仍然生效的那些已经提炼进 `../INVARIANTS.md`**；这里保留原始措辞，用来回答「当时为什么这么定」。

## 决策记录

- 2026-07-16（用户确认）：统一缓存模型 / mp3 + 打包 ffmpeg / 导入按需下载 / 仅 macOS arm64 / 端口 47100（`470xx` 归 owl、`471xx` 归 lark）
- 2026-07-16（计划内定）：SSE 替代 WS、JSON 导出、Go DB 迁移、不抽 daemon-kit
- 2026-07-16（一轮评审修订 R1–R17，详见主计划 §1）：file_origin 清理不变量（导入文件永不自动清理）、v0.1 不写 sync 事件 + v0.2 全量回填、all 虚拟化、owl 式迁移协议、lark-media:// 媒体鉴权、recognize 纯预览、稀疏 rank、provider key 身份、原子落盘、UUID 强校验 + openExternal 仅 http/https、SSE 在线判定 + 命令 ack、导入去重只认 key、单账户单资料库、PATCH /config、信封例外、LLM 降级路径、asar:false + ffmpeg 锁版本 + GPL 许可交付
- 2026-07-16（二轮评审修订 R18–R28，详见主计划 §1）：身份域拆分（实体 device_id 仅存 skybridge 注册 ID、本地身份在 local_metadata.device_uuid）、playlist_songs 补 lww_counter + created_at 同步不可变、DB 级排他迁移（.migrate.lock + EXCLUSIVE + backup API + swap 回滚）、token 模型对齐 owl + M0 媒体 spike、全写路径原子化（导入/删除/歌词）、schema CHECK + provider key 唯一索引、虚拟 all 只读语义、CLI 歧义报错、清理前联网探活 fail-closed + 不可回收上报、导入单事务/上限/版本校验、维持 ad-hoc 签名
- 2026-07-31（M0 实测定案）：Electron 锁 **43.2.0**（owl 的 34 已 EOL，取最新受支持大版本），全依赖精确锁版 + 提交 lockfile；transport 仅 GET 默认重试（M0-7）；renderer CSP 单一来源 = Vite 插件（`order: 'post'`，dev 额外放宽 `script-src 'unsafe-inline'`，因 React Fast Refresh preamble 是内联 script）；Electron ESM main 不得顶层 await `app.whenReady()`；**vite 用 `pnpm.overrides` 钉 7.3.6**——只锁直接依赖挡不住传递范围把 vite 抬到 8，而 electron-vite 5 peer 只到 7，失效方式是静默的（build 仍「成功」但 electron 被打进 main bundle）
- 2026-07-16（三轮评审修订 R29–R32，详见主计划 §1）：token 归 daemon 生成原子发布（main 只传路径、每次重读适应轮换）、source_key 改 `bvid:cid`（p 是位置非身份，规范化时解析 p→cid）、取消 --force（daemon 存活一律禁 direct 写，推翻二轮限权方案）、v0.2 必审清单补三项（同 key 跨设备合并 / HLC rebase / rank 归一化同步语义）；同步更新 CLAUDE.md / AGENTS.md / DESIGN.md 过期表述
- 2026-08-05（M3 实测定案）：bilibili fav/collection **匿名可用**（T3 gate GO，`fetch-list` 保住全部范围）；`nav` 匿名 code -101 但携 `wbi_img`（判定看字段）；`fav/resource/list` 短页 + `has_more` 才是分页真值；ffmpeg 输出到 `.tmp` 必须 `-f mp3`；酷狗三端点全支持 https（Go 的两处明文 http 无必要），`krcs` 必须带 hash + duration(ms)；`ffmpeg-static` / `@derhuerst/ffprobe-static` 定版 **5.3.0**（实测 arm64 / ffmpeg 6.0，两包 `.d.ts` 的 `export default` 与 CJS 实际导出不符，需在导入边界重标类型）；engine 按 800 行硬线拆四文件；bilibili client 全 daemon 一份（`ctx.bilibili`）
- 2026-08-10（M7 实测定案 + 发版）：**`ffmpeg-static` / `@derhuerst/ffprobe-static` 已移除**——其二进制 `--enable-nonfree`，不可再分发（**推翻 2026-08-05 那条定版 5.3.0 的记录**）；改为自建最小 LGPL profile（FFmpeg 8.1.2 + LAME 3.100，4.5MB），`vendor/ffmpeg.lock.json` 锁定、`just fetch-ffmpeg` 做门禁（configure 逐字节比对 + nonfree 拒绝 + 能力清单 + 真实闭环）；交付 `bundled | system` 两个一等模式，控制面是 just **位置参数**；媒体工具收敛成 `ctx.mediaTools` 单一真相（ready 判定 = 完整能力清单，非 `-version` 退出 0），`MEDIA_TOOLS_UNAVAILABLE` 覆盖导入与下载、`LOCAL_API_VERSION` 3→4；打包后进程定位全部出自同一个 `resolveAppBundle()`，`open` 的正常退出不算崩溃；LICENSE = MIT，NOTICE 聚合全部生产依赖（195 个）且带覆盖检查；**v0.1.0 于 2026-08-10 发布**（bundled dmg + `@orpheus-aviary/lark-cli`，tag `9581bbc`）
- 2026-08-07（M5 后续定案）：**lark 引入独立状态色 `--state-active`（琥珀），`--primary` 不动**——shadcn 中性色板里 `--primary` 与正文同色，`text-primary` 当激活态用一直是隐形的（正在播放 / 当前排序 / 播放模式三处）；行状态定为四通道（琥珀=播放中 · 左竖条=选中 · **蓝色图钉按钮**=已固定 · `[需要下载]`=无文件；行内按钮常驻不悬浮），竖条挂第一个 `<td>`（`<tr>` 的 border 会被 border-collapse 吃掉）；排序改两轴（下拉选字段 / 按钮切方向），补 `时长` 与 `创建时间`；多选选区是**有序 id 列表 + 锚点**，表头三态语义限「当前视图内」，批量删除/移除/固定 N 次串行、添加到歌单一次请求，部分失败如实汇报；右键在选区内一律按批量走（否则「选三首删一首」）
- 2026-08-06（M5 实测定案）：`[theme] mode` 进 config，冻结「外观进 config、视图态留 localStorage」；缓存删除临界区 = **file claim + 重读行 + 重新 stat + 复查排除集/流计数，与 unlink 之间零 await**（探活是 await，期间一切可变）；下载完成触发的清理必须 `setImmediate` 延后到 claim 释放之后，否则永远清不掉刚下载的歌；`ensure-file` 成功授予 **60s lease**，跨 drain 保护到 `/audio` 真正开流；导入两段式靠 **SHA-256** 咬合（`reuse[].index` 只在字节一致时有意义），`(provider,key)` 命中优先级高于任何 reuse 指令；dnd-kit **走 legacy**（新架构 `@dnd-kit/dom` 依赖 jsdom 缺失的三个浏览器 API，且以未捕获异常炸整个测试文件），整行拖拽必须自建 activator 排除 input/button，`useSortable` 默认 `role="button"` 会毁掉 `<tr>` 的表格语义
- 2026-08-03（M1 实测定案）：better-sqlite3 定版 **12.11.1**（`process.versions.modules`：Node 137 / Electron 148，双运行时真值探测复核）；迁移锁弃 O_EXCL + pid 改 **SQLite `BEGIN EXCLUSIVE` 常驻锁库**（内核 advisory lock，kill -9 自动释放，锁文件永不删——主计划 §3.3 step 1 已标注修订）；createDatabase 三条拒绝路径判定前零写入（`journal_mode=WAL` 后移，字节级断言）；loadConfig 对存量 0644 强制收紧 0600；migrate-go 源库排他 = 真实读 + **同值写升级**双步（纯读拿不到 EXCLUSIVE 也探不到 RESERVED 写事务）；47020 探活带 `httpProbe` 开关（机器全局端口，测试关闭）；scope 字典补 `repo` / `plan`（用户确认）
