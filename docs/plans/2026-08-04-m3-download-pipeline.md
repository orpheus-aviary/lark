# lark M3 计划：下载管线 + 链接路由

> 2026-08-04 首版（调查：lark-go 全量代码走读 + lark TS 对接面盘点 + bilibili 端点当日实测）。
> 同日一轮评审修订 17 项：① `resolveSongFile` 增 `force`——redownload 不被「文件在→直接用」短路，tmp 下载后原子替换，rename 成功才 `setFileOrigin`；② 任务模型补终态状态机（`state` 与 `stage` 分离 + 时间戳 + `error_code` + `result`），排队取消保留终态，新增 `download:cancelled` 事件、`download:error` 带 `error_code`；③ 落盘与 DB 顺序改为 R22 序（预分配 id → 文件就位 → 单事务 DB 提交 → 失败补偿删目录），tmp 两段命名区分原始流与转码输出，key 预查复用 + 竞态补偿；④ 完成/失败/取消事件改 engine 生命周期回调、boot 层翻译成 bus.emit（「路由层随发」在异步结构中不成立）；⑤ ffprobe 换 `@derhuerst/ffprobe-static@5.3.0`（旧 `ffprobe-static` 无 macOS arm64 构建）、`ffmpeg-static@5.3.0` 当场定版；⑥ teardown 引入 `ctx.shutdownSignal` + 顺序修订（拒新 → abort worker 与全部 request-scoped 长操作 → `server.close` → `downloads.close`），`closeTestContext` 转 async；⑦ 队列容量上限 + 429 `DOWNLOAD_QUEUE_FULL` + 输入/批量/分页护栏；⑧ 去重键 = `kind` + 身份，同下载不同歌单**合并目标集合**；⑨ `activeSongIds` 改 `claimedSongIds`（queued+running）；⑩ `position/total` 从事件与单任务协议删除（二轮 ① 进一步改为独立 batch 对象）；⑪ PUT url-only **显式清除**旧 provider/key、host 白名单判定先于正则且 b23 先展开；⑫ 错误 code 单一来源在 core 错误类字段；⑬ LLM 预检提前到入队前；⑭ engine 注入 `getLlmConfig()`（二轮 ⑩ 收敛为任务级快照）；⑮ 全外呼超时矩阵 + `AbortSignal.any` 组合；⑯ ffmpeg `execFile` 补 `-nostdin -v error` + 显式 maxBuffer，b23/BV 校验收严，歌词启发式冻结；⑰ 文档修正（api-paths 10 条、typo、AGENTS.md 同步、fav/collection 升为 T3 go/no-go gate）。
> 同日二轮评审修订 15 项：① **batch 改独立内存对象**、批量入队一次性预检（三轮 ③ 升级为全请求原子）；② **既有文件替换补 backup/restore** + 启动恢复例程（三轮 ① 重设计为 DB 日志判定）、`DownloadCommitError`；③ **取消冻结不可逆提交点** + **歌词拆独立后置任务**；④ **`download:status` 改 `{task_id, state, stage}`**、`DOWNLOAD_STAGES` 去掉 `queued`；⑤ **恢复 R16 原文限定**（多 P 无 p 需 LLM）；⑥ **anthropic 请求头修正**；⑦ PUT `source_url` 四分支；⑧ 验收④改「lark 与 aviary 均清空」；⑨ `getLlmConfig()` 任务级快照；⑩ **URL 直下命名冻结**；⑪ 在飞任务与编辑竞争 409（三轮 ⑤ 升级为原子 claim）；⑫ **目标集合冻结协议**（saving 冻结 + late 集）；⑬ **`createFileBackedSongInTx`** 专用 helper；⑭ 终态事件按 kind 发；cancel 三态写死；⑮ 小修（BV 字符集、ffprobe 验产物、容量对齐 1000）。
> 同日三轮评审修订 13 项：① **[P0] 落盘提交改「DB 事务内恢复日志」判定**（`local_metadata` 承载，无 schema 变更）；② **孤儿目录移 `trash/recovery-*` 不永久删除**；③ **多 group 全请求原子** `enqueueBatches`；④ **batch item 携终态快照**；⑤ **claim 注册表替代裸 `claimedSongIds`**（四轮 ③ 进一步补 owner/动态绑定）；⑥ **preflight 网络移出 engine 锁**（并发 4 / 预算 60s / 504 `PREFLIGHT_TIMEOUT`）、批量项便宜键；⑦ **task 增 `revision`**，status 去重键 `(state, stage, revision)`；⑧ **去重索引终态语义冻结**（仅覆盖 pending ≝ queued+running，终态即释放，成功复用靠 key 查库）；⑨ **succeeded + lyrics continuation 同临界区**、continuation 豁免容量；⑩ **T1 冻结精确线协议结构**；⑪ **错误 code 范围仅 M3 新增类**；⑫ T6 恢复测试扩为六形态（四轮 ① 增至七）；⑬ 容量口径复核。
> 同日四轮评审修订 12 项：① **[P0] manifest 补 `mode/had_old` 且原子写**——「pending 已写、bak 未发生」的崩溃窗口会把完好旧文件当未提交新文件删除；恢复按 `had_old` 判定 rename 是否已发生（had_old=true 且无 bak → **保留当前文件**），新增第七形态用例；② **batch 多 P 预检取舍定案**：同步多 P 检查仅限单条入口（一次 pagelist 便宜）；batch 项不做 pagelist preflight——无 LLM 时多 P 无 p 的 batch 项**允许入队、任务异步 failed `LLM_NOT_CONFIGURED`**（「同步保证 / preflight 预算 / 无 LLM」三承诺取其二，明写取舍）；③ **claim 模型重写**：类型 `file` / `lyrics` / `exclusive`（删歌独占全类型），`acquireClaim(songId, type) → ClaimToken`（owner 语义，无 token 不能 release）；**queued 任务的互斥由 pending 关联索引承担**（claim 仅 running worker 与路由短操作持有），二者同一 engine 临界区联合判定；download 任务 resolving 绑定既有歌时临界区内 acquire `file`，冲突 → 任务 failed `SONG_BUSY`；④ **post-commit 语义冻结**：DB 事务（含日志行）提交即不可逆成功点——其后 bak/pending/日志清理失败（warning + 残留交启动恢复，恢复对「日志行在」一律保新文件）、late membership 失败（软失败记录）、continuation 派生失败（warning，可手动补）**一律不改判 failed**；补偿删除只存在于 commit 前；⑤ **`BatchTarget` 拆输入/快照两型**——`BatchTargetData` 回填 `{new}` 创建后的真实 `playlist_id`（M4 导航依赖）；冻结 `DownloadBatchRequest/GroupInput/ItemInput`（item 携可信 `title`，批量标题链路闭合）；⑥ **去重初级键统一 `bvid:(p??1)`**（单条与 batch 同源）、不做 cid rekey——跨入口漏合并由任务内 key 查库复用兜底（不重复下载，第二任务快速 succeeded）；⑦ **`{new_name}` 顺序改「校验 → 算容量 → 单 DB 事务建全部歌单 → 内存登记」**，不再依赖补偿删歌单；⑧ 新歌单创建路由层随发 `playlists:changed`；**新增 `download:batches-changed {batch_id}` 事件**（新 batch 全引用已有 pending 任务时否则无任何刷新信号）；⑨ **engine 未知异常兜底 `INTERNAL_ERROR`**：单任务 try/catch/finally 保证 batch 快照回写、claim 与去重索引释放、worker 续行（注入测试）；⑩ **key 失效 + 无 LLM 的终态定 `SOURCE_GONE`**（message 提示配置 LLM 可自动识别新来源；`LLM_NOT_CONFIGURED` 留给入队前同步预检）；⑪ **崩溃恢复范围明写**：只承诺进程崩溃（kill -9）一致性，不承诺断电（与 M1 同口径，不加 fsync 纪律）；⑫ T6 补三组用例（pending-未-bak 保旧文件、post-commit 注入失败仍 succeeded、未知异常 finally 释放）。
> 同日五轮评审修订 10 项：① **auto 选 P 不等同 p=1**——初级键分 `bvid:<页号>` 与 `bvid:auto`（无 p 待 LLM 选集），auto 只与 auto 合并、与显式页号**永不合并**（否则显式 p=1 可能错拿 LLM 选出的 p=2）；② `DownloadBatchItemInput` 改判别联合 `video | keyword`——原形状无法承载 keyword 项，batchAnalyze 的产物在请求协议中没有入口；③ **claim/reservation 单表 owner 记账 + 原子晋升**——queued reservation → running claim 同 owner 不自阻塞（`acquireClaim(songId, type, owner)`），download 任务 resolving「登记关联 + 拿 claim」一步完成，补「自己不阻塞自己、他 owner 被阻塞」用例；④ **`taskErrorCode(err)` 显式映射既有预期错误**——batch 不做 pagelist preflight，页越界在 worker 内抛 `InvalidSourceError`（无 code），按 catch-all 会误报 `INTERNAL_ERROR`：`InvalidSourceError`→`INVALID_SOURCE`、`SourceKeyConflictError`→`SOURCE_KEY_CONFLICT`、`NotFoundError`→`NOT_FOUND`，其余才 `INTERNAL_ERROR`；⑤ batch 返回**完整 `DownloadBatchData[]`**（不另设近似 Response 结构，M4 只维护一套）；⑥ **`DownloadTaskData.failed_playlist_ids`**——late/歌单先删的 membership 软失败对 GUI 可见（revision++ 发 status），不再只写日志；⑦ 冻结 **`FetchListRequest` 判别联合**（favorites/collection 各自必填字段）；⑧ `.pending.*.tmp`（manifest 原子写的中间产物）纳入恢复例程 tmp 直删清单；⑨ import 断言 `probeAudio().format` 实为 mp3（改名的 AAC/M4A 拒绝）；⑩ `INTERNAL_ERROR` 对外 message 用固定安全文案（真实异常只进日志，不泄 SQLite 路径/上游响应）。
> 上游：`2026-07-16-ts-rewrite-master-plan.md` §5.1（下载管线）+ §4（API 表）+ §6 M3 行 + R6/R8/R9/R16/R17/R22/R30；`2026-08-04-m2-daemon-routes.md` §1（四项欠账）+ M2-6（SSE 限频随 M3）+ T6（歌词写入落 `library/lyrics.ts`）；`2026-07-31-m1-core-data-layer.md` T4（source 四象限、语法/语义分界）。
> 完成标准（主计划）：`just check` 全绿 + 对应测试绿 + 用户验收关键路径。**缓存清理 / 导入导出 / GUI 消费 / CLI 命令不在此（M5/M4/M6）。**

## 0. 目标

1. **core 下载引擎**：bilibili client（WBI 签名 search + 免签 pagelist/view/playurl/fav/collection）、链接识别与联网规范化（p→cid，R30）、ffmpeg/ffprobe 封装、单 worker 队列（终态状态机 / batch 对象 / 取消含不可逆提交点 / 去重索引终态释放 / 容量上限 / claim + pending 索引互斥）、R22 顺序的原子落盘 + DB 日志判定的崩溃恢复、`resolveSongFile(song, {force})` 统一取文件入口 + source_* 回写。
2. **LLM client**：自写轻量一次性 completion（openai/anthropic 双格式与各自请求头、aviary 回退、`<think>` 剥离、JSON 围栏清洗、任务级配置快照）、Go 版六条 prompt 移植；**确定性路径全程无 LLM**（R16 原文：单 P 或显式 `?p` 的 URL、凭 key 重下），依赖 LLM 的操作在入队前同步预检（单条入口）。
3. **歌词管线**：网易云/QQ/酷狗三平台并行 + LLM 精选（end_time ±30s 交叉验证）+ 无 LLM 确定性相似度启发式降级；**作为独立后置任务**（download 提交成功同临界区派生）；写入走 `library/lyrics.ts`（tmp+rename，R22）。
4. **daemon 路由**：`/download/{song,parse,batch,fetch-list,cancel,tasks}`、`POST /download/lyrics/:id`、`POST /songs/import`、`POST /songs/:id/recognize-url`（纯预览 R6）、`POST /songs/:id/redownload`、`PUT /songs/:id` 联网规范化；download 事件族发射（engine 回调 → boot 接线 → bus；enqueue 类同步事件路由层发）。
5. **网络层 mock 测试基建**：`fetchImpl` 注入 + fake bilibili/lyrics/LLM 本地 server（`@lark/core/testing`），ffmpeg 用真实二进制转码 fixture。

## 1. 范围

**M3 做**：上述五项 + shared 线协议扩展（api-paths 10 条、任务/batch/解析类型全量冻结、`DOWNLOAD_STAGES`/`TASK_STATES`、`download:*` 事件族修订含 `batches-changed`）+ core 错误类（M3 新增类带稳定 `code` 字段）与 daemon `error-mapping` 补齐 + ctx/boot/teardown 接线（含 `shutdownSignal`、async teardown 改造、启动恢复例程）+ 对应 vitest + live 探测脚本。**新增依赖（定版）：`ffmpeg-static@5.3.0` + `@derhuerst/ffprobe-static@5.3.0`**（均为当前 latest，npm 实查 2026-08-04；旧 `ffprobe-static` 的 mac 构建是 Intel 版，不匹配 arm64 发布目标——两包同为 @derhuerst 维护、二进制同源）。

**M3 明确不做**：

| 推迟项 | 去处 | 理由 |
|---|---|---|
| 缓存上限 / LRU / `/cache/*` / 清理前探活 | M5 | 缓存模型整体在 M5；M3 只暴露 claim/pending 索引供其互斥 |
| 播放无文件歌曲自动触发下载并开播 | M5 | GUI/player 行为；M3 交付 `resolveSongFile` 机制与 redownload 路由 |
| 导入导出（`/playlists/import|export`） | M5 | R27 |
| GUI 下载栏 / 批量弹窗 / 编辑链接对话框 | M4/M5 | M3 冻结线协议（state/stage/revision + tasks/batches 快照） |
| CLI `lark download` 等命令 | M6 | |
| ffmpeg extraResources 打包 + 冒烟 + 许可交付 | M7 | M3 用 static 包的 dev 二进制；路径解析已预留打包位（M3-8） |
| av 号（av→bvid 转换） | 不做（v0.1） | Go 版亦无；正则不识别时报错文案提示用 BV 链接 |
| UP 主主页批量下载 | 不做 | Go 版已删（`718a075`）；风控形势未变 |
| ID3/封面写入、导入时读 ID3 | 开放议题 | Go 版无此能力；见 §6 末行，默认不做 |
| 下载任务持久化（DB 任务表） | 不做 | 队列纯内存，daemon 重启即清；**恢复日志走既有 `local_metadata`，不加表** |
| 字节级下载进度 | 不做 | Go 版即阶段级；state/stage + batch 快照已够 |
| 断电级持久一致性 | 不做 | 恢复协议只承诺**进程崩溃**（kill -9）一致性，与 M1 同口径；不加 fsync 纪律（四轮 ⑪） |

## 2. 调查实测（2026-08-04）

### 2.1 Go 版基线（功能映射源，代码级走读）

- **管线**（`internal/download/engine.go:253-397`）：LLM analyzeInput → 关键词时 search+LLM 选片+多 P 消歧 → view+LLM inferSongInfo（歌名/歌手清洗，UP 主名参与推断）→ playurl `fnval=16` 取 `dash.audio` **最大 bandwidth** → 系统临时目录落盘 → `ensureMP3`（`ffmpeg -vn -acodec libmp3lame -ab 192k -ar 44100 -y`）→ 入库 + `os.Rename` 进 nest → 非 all 歌单加成员 → 歌词（唯一软失败）。
- **LLM**（`internal/llm/client.go`）：仅 openai 兼容、非流式、60s 超时、无重试；`(?s)<think>.*?</think>` 剥离；```` ```json ```` 围栏清洗（`engine.go:436-442`）。六个调用点/prompt：analyze（`engine.go:233-241`）、select（`bilibili.go:84-91`）、multiP（`bilibili.go:178-181`）、inferSongInfo（`engine.go:243-250`）、lyricsSelect（`lyrics.go:99-109`）、batchAnalyze（`engine.go:455-465`）。**缺陷：LLM 是硬依赖**——`analyzeInput` 失败=整个下载失败，未配 LLM 时 `/download/*` 全体 503（`daemon.go:63-70`）。
- **请求头**（`bilibili_batch.go:70-94`）：Chrome UA + `Referer: https://www.bilibili.com` + 随机 `buvid3`（16 字节 hex 大写+`infoc`）；无登录态（非会员音质）。音频流下载仅 UA+Referer，超时 5 分钟。
- **链接识别**（`bilibili_batch.go:40-54` + `engine.go:481-495`）：favlist / 合集 / `BV[\w]+` 三条正则，「正则命中无条件覆盖 LLM 判定」——但顺序是 LLM 先跑、正则纠偏。`?p=N` 尊重 URL；多 P 消歧只在搜索路径做。**无 b23.tv、无 av 号**。
- **队列**（`engine.go:19-196`）：单 goroutine 串行、chan buffer 100（**满则阻塞 HTTP handler**）、全局「同 query 3 秒防抖」（批量误伤）、仅能取消当前任务、无重试、不持久化；进度 = 中文阶段文案广播 `{task_id, stage, position, total}`（批次计数，排空清零）+ `reportStatusHold` sleep hack。
- **歌词**：三平台 goroutine 并行、每平台 ≤3 候选（池上限 9）、候选带 `preview/tail_preview/end_time`；LLM 按 end_time 与音频时长 **±30s 交叉验证**选序号；降级=取第一个候选。网易云 `music.163.com/api/{search/get,song/lyric}`；QQ `c.y.qq.com/{soso/…client_search_cp,lyric/…fcg_query_lyric_new.fcg}`（base64）；酷狗三步 `mobileservice…/search/song` → `krcs.kugou.com/search` → `lyrics.kugou.com/download`（**后两步 http 明文**，取 `candidates[0]`）。`normalizeLRC`：去 BOM、统一换行、**不含 `[0` 即拒**（网易云路径内联重复）。
- **导入**（`songs_handler.go:120-148`）：只取文件名做歌名、artist 恒空、**不读 ID3**；ffprobe 仅取时长；复制；**零去重**；单文件失败静默 continue。
- **已知 bug/债**：`moveFile` 跨设备 rename 失败（`bilibili.go:394`）；ffprobe 不可取消；`SongsWithoutDuration` 死代码；WS 心跳未实现。
- **WBI 历史**：`0d7428b` 加入（`wbi.go` 144 行）→ `718a075` 随 uploader 一并删除。取回参考：`git -C ../lark-go show 0d7428b:internal/download/wbi.go`。

### 2.2 bilibili 端点当日实测（2026-08-04，决定性输入）

| 端点 | 签名 | 结果 |
|---|---|---|
| `x/player/pagelist` | 无，无 cookie | ✅ code 0 |
| `x/web-interface/view` | 无，无 cookie | ✅ code 0 |
| `x/player/playurl?fnval=16&fourk=1` | 无，无 cookie | ✅ code 0，`dash.audio` 三档 `30216/30232/30280`（最高 bandwidth 203786） |
| `x/web-interface/search/type` | 无，随机 buvid3 | ❌ **HTTP 200 + 风控 HTML 拦截页**（Go 版现行写法已失效） |
| 同上 | 无，spi 签发真 buvid3 | ❌ 同上 |
| `x/web-interface/wbi/search/type` | **WBI 签名** + spi buvid3/buvid4 | ✅ code 0，10 条结果 |

结论：**确定性路径（pagelist/view/playurl）今天仍免签**；**关键词搜索必须 WBI**（nav 免登录给 img/sub key；spi 签发 buvid3/buvid4）。搜索结果 `title` 含 `<em class="keyword">` 高亮标记，喂 LLM/展示前须剥离。**fav/collection 分页接口未实测**——T3 首日 probe 是显式 **go/no-go gate**：若也被风控逼签名/失效，`fetch-list` 范围当场上报用户裁决，不默认可用。

### 2.3 lark TS 对接面（现状盘点）

- **shared**：`LarkEvent` 中 `download:status` 目前仅 `{task_id}`（`types.ts:193-202`，标注「M3 才发射」）——按「极简 refresh 信号」哲学 GUI 收到后应能 refetch，而 §4 路由表没有任务查询端点，需 M3 显式决策（M3-6）。api-paths 现 10 静态 + 9 参数化，M3 需增 10 条；注释明确「重命名要炸 build」。
- **core**：`library/` 仅 songs/playlists/lyrics/rank/source 五模块，**download/llm/ffmpeg/bilibili 零占位**。已备好的钩子：`lyrics.ts` 文件头明言「M3's lyrics download writes through this same module」（现无 write）；`setFileOrigin`（`songs.ts:291-307`）注释「only M3's download/import file-write paths may call this, after their atomic file landing succeeds」；`source.ts:13-15`「cid 语义有效性是 M3 联网规范化」；`assertKeyFree` 已做 unique 冲突→`SourceKeyConflictError`。**继承语义**：`updateSongInTx`（`songs.ts:134`）对未提供字段继承旧值——「只给 source_url」不会自然形成 url-only 象限（M3-11）。`createSong` 内部生成 UUID 并立即提交——R22 序需要专用内部创建路径（M3-7）。**既有错误类无 `code` 字段、`error-mapping.ts:24` 硬编码**——「code 单一来源」仅适用 M3 新增类。`resolveLlmConfig` 逐字段回退 aviary（`config/index.ts:114-137`）——「清空 lark 的 llm 配置」不等于无 LLM 环境（验收④已按此改写）。`local_metadata (key PK, value)` 已在 schema v1——恢复日志可承载，无 schema 变更。core 出站 HTTP 先例：`db/probe-go.ts:54` 全局 `fetch` + `AbortSignal.timeout`。
- **daemon**：路由三件套联动（`registerAllRoutes` + `ENDPOINTS` + 双向 diff 守卫）；errorHandler 三分类，**M3 新错误类必须进 `error-mapping.ts`**；`media.ts:99-101` 的 `FILE_NOT_FOUND` 分支即 resolveSongFile 接入点；`PUT /songs/:id` 注释明言联网规范化是 M3。现有路由的事件发射依赖 handler 内**同步完成**的写——下载是异步的，完成事件必须走 engine 回调通道（M3-6/M3-13）。AppContext 加句柄需同步 `context.ts` / `boot.ts` / `build-test-server.ts` 三处。**现有 `deleteLyrics` 内部 `await unlink`**——「先查后删」存在 TOCTOU 窗口，须走 claim API（M3-7）。
- **测试基建**：daemon 测试跑真 core + `:memory:` DB；流式/SSE 用真 listen(port 0)+fetch；**仓内无任何 HTTP mock 设施**。跨包 fixture 既定位置 `@lark/core/testing`。`closeTestContext` 目前同步——M3 teardown 含 async `downloads.close()`，**全部 daemon 既有测试 afterEach 要跟着改**（T7 计入）。
- **依赖**：全仓精确锁版；`pnpm.overrides` 仅 `vite 7.3.6`；`onlyBuiltDependencies` 现有四项——**两个 static 包有 postinstall 下载，须追加**。
- **owl 参照**：`llm-client.ts` 是流式 agent client——不照抄；借鉴 api_format 分派与 url 尾部处理；**anthropic 请求头以 owl `routes/config.ts:88`（`x-api-key` + `anthropic-version`）与官方文档为准**。fetch 注入先例：`health-probe.ts:33`。lark `api_format` 开放字符串、兜底 `'openai'`。

## 3. M3 内定决策（有异议随时推翻）

| # | 决策 | 说明 |
|---|---|---|
| M3-1 | **模块布局**：core 新增 `src/download/`——`llm.ts`、`prompts.ts`、`wbi.ts`、`bilibili.ts`、`link.ts`、`ffmpeg.ts`、`lyrics/{netease,qq,kugou,select}.ts`、`engine.ts`（队列 + claim/pending 索引）、`resolve.ts`（resolveSongFile + 落盘/恢复协议）；歌词**写入**补在 `library/lyrics.ts`。daemon 新增 `routes/download.ts`，songs 相关三条挂进 `routes/songs.ts`。全部网络模块带 `fetchImpl?: typeof fetch` seam，生产用全局 fetch，不引 undici | 依赖方向不变：download 属 core，daemon 只接线 |
| M3-2 | **确定性优先，LLM 只做兜底**（R16 落地）。单条输入解析纯确定性：`parseSongInput` 正则序贯（favlist → 合集 → b23.tv 展开后重解析 → BV URL/裸 BV → 其他 URL 报「非 B 站链接不能驱动下载」→ 非 URL 文本即 keyword）。**零 LLM 的确定性范围按 R16 原文**：单 P 或显式 `?p` 的 URL 直下、凭 key 重下。**同步 LLM/多 P 预检仅限单条入口**（四轮 ②）：`/download/song`、`redownload`、`recognize-url`、PUT 规范化——preflight 拉一次 pagelist（本就是 p→cid 步骤），多 P 无 p 且未配 LLM → 同步 400 `LLM_NOT_CONFIGURED`（文案「加 ?p= 或配置 LLM」）；keyword 项与批量文本 LLM 兜底行同样同步 400。**batch 的 video 项不做 pagelist preflight**（锁外预算约束，M3-5）——多 P 无 p + 无 LLM 的项**允许入队、任务异步 failed `LLM_NOT_CONFIGURED`**：「同步保证 / preflight 预算 / 无 LLM 可用」三承诺取其二，此为明确取舍。已入队后配置被清空/请求失败 → 任务终态 `LLM_FAILED`。歌词降级不算依赖（M3-9）。Go 的 analyzePrompt 调用点收窄为 batch 兜底（prompt 照移植，角色变小——偏离「直接移植」的唯一点） | |
| M3-3 | **WBI 签名进 M3**（实测已被逼出）：仅关键词搜索走 `wbi/search/type`；`wbi.ts` = mixinKeyEncTab + `nav` 取 key（免登录）+ 30 分钟缓存 + MD5 `w_rid`（参照 lark-go 历史 `wbi.go` + bilibili-API-collect）；`spi` 签发 buvid3/buvid4 进程内缓存，全部请求携带。风控响应（非 JSON / code -412）抛 `BilibiliRiskControlError`。pagelist/view/playurl 维持免签；**fav/collection 首日 probe 是 go/no-go gate** | 搜索标题剥 `<em class="keyword">` 与 HTML 实体 |
| M3-4 | **LLM client 自写轻量版**：`chatCompletion(cfg, system, user, {signal, fetchImpl}) → string`；`api_format === 'anthropic'` → `POST {url(剥 /v1)}/v1/messages`，头 **`x-api-key` + `anthropic-version: 2023-06-01`** + `content-type`，body `{model, max_tokens: 4096, system, messages}`，**响应取 `content[]` 全部 `type:'text'` 拼接**；其余 openai 兼容 → `POST {url(剥尾斜杠)}/chat/completions`，头 `Authorization: Bearer`，取 `choices[0].message.content`。非流式、60s 超时、无重试；`<think>` 剥离与围栏清洗为公共 helper。**配置快照按任务**：engine 注入 `getLlmConfig()`，任务开始时取一次、任务内共用；PATCH 影响后续任务与独立请求（每请求现读）。api_key 只进对应请求头，不进日志 | 不引 SDK |
| M3-5 | **队列模型与任务状态机**。单 worker 串行。任务形状（T1 冻结）：`{ id, kind, state, stage, revision, input, song_id, playlist_ids, created_at, started_at, finished_at, error_code, error_message, result }`；`TASK_STATES = ['queued','running','succeeded','failed','cancelled']`；`DOWNLOAD_STAGES = ['analyzing','searching','resolving','downloading','converting','saving','lyrics']`（无 `queued`；download 止于 `saving`，`lyrics` 归歌词任务）；`revision` 任何可见变更递增。**pending ≝ queued + running**；容量 pending ≤ **1000**，超出 429 `DOWNLOAD_QUEUE_FULL`。**batch 独立建模**：`DownloadBatchData { id, target: BatchTargetData, total, items: [{index, task_id, final}], created_at }`，保留近 20 个；item 携终态快照 `final`——任务终态时回写引用方，终态环淘汰不丢进度。**入队协议**：网络 preflight（b23/单条 pagelist/batchAnalyze）**全在 engine 锁外**（并发 4、请求总预算 60s → 504 `PREFLIGHT_TIMEOUT`、挂 request+shutdown signal）；随后单临界区：重查去重索引 → 校验目标（uuid 须存在 404）→ **算全请求净新增、超容量整请求 429** → **`{new_name}` 单 DB 事务创建全部新歌单**（四轮 ⑦：容量判定在前，DB 失败整请求拒，不依赖补偿删歌单）→ 同步登记任务与 batch 对象。**去重索引**：仅覆盖 pending，任何终态立即释放；**初级键形态 `bvid:<页号>` 与 `bvid:auto`**（五轮 ①：显式 p 或 preflight 已确定单 P → 实页号；无 p 待 LLM 选集 → `auto`——auto 只与 auto 合并、与显式页号**永不合并**，否则显式 p=1 可能错拿 LLM 选出的 p=2；不做 cid rekey——跨入口漏合并由任务内 key 查库复用兜底，第二任务快速 succeeded 不重复下载）；关键词 = 归一化 query；`redownload`/`lyrics` = `kind + song_id`。重复 download 携不同歌单目标 → 合并 `playlist_ids`（revision++ 发 status）；**目标集合冻结**：进入 `saving` 冻结，冻结后合并转 late 集、提交后终态前补入单；已终态 → handler 直接对 `result.song_id` 加成员。**取消语义**：queued → `cancelled`；running 且 stage ∈ analyzing…converting → abort 落 `cancelled`；`saving` 后 → 409 `TASK_NOT_CANCELLABLE`；终态重复 cancel → 200 幂等；不存在/已淘汰 → 404。**歌词后置任务**：download 主提交成功后**置 succeeded、释放去重、派生 lyrics 同一临界区原子完成**，continuation 豁免容量（每 download 至多 1 条）。**任务错误分类**（四轮 ⑨ + 五轮 ④⑩）：单任务 try/catch/finally——`taskErrorCode(err)` 统一映射：M3 新类 → `err.code`；**既有预期类显式映射**（`InvalidSourceError`→`INVALID_SOURCE`——batch 不 preflight，页越界在 worker 内抛；`SourceKeyConflictError`→`SOURCE_KEY_CONFLICT`——竞态补偿最终失败；`NotFoundError`→`NOT_FOUND`）；其余 → `INTERNAL_ERROR`，**对外 `error_message` 用固定安全文案**（真实异常只进日志，不泄 SQLite 路径/上游响应）；finally 保证 batch 快照回写、claim/reservation 与去重索引释放、worker 续行。终态任务保留近 100 条 | |
| M3-6 | **进度与事件线协议**。事件族：`download:status { task_id, state, stage }`（入队、开始、stage 流转、目标合并各发一次；去重键 `(state, stage, revision)`）、`download:complete { task_id, song_id }`、`download:error { task_id, error_code, message }`、`download:cancelled { task_id }`、**`download:batches-changed { batch_id }`**（四轮 ⑧：batch 创建即发——新 batch 全引用已有 pending 任务时否则无任何刷新信号）；GUI 详情一律 refetch `GET /download/tasks` → `{ tasks, batches }`。**发射通道**：异步侧 = engine 生命周期回调 `{ onStatus, onSucceeded, onFailed, onCancelled }` → boot 接线翻译成 `eventsBus.emit`；同步侧（enqueue/batch 创建/新歌单）= 路由层发——**`{new_name}` 创建成功随发 `playlists:changed`**（四轮 ⑧）。**伴随事件按 kind 与实际变更发**：download/redownload 成功 → `songs:changed`（+确实加了成员时 `playlists:changed`）；lyrics 任务成功 → 仅 `lyrics:changed` | 主计划 §4 回写（T8） |
| M3-7 | **`resolveSongFile(song, {force})` + R22 落盘 + DB 日志崩溃恢复 + claim/pending 互斥**。决策树：`force=false`——文件在→直接用；缺失→走获取；`force=true`（redownload）——忽略已有文件，全程 tmp。获取：有 key→**探活**（view + pagelist 确认 cid）→playurl→下载→转码；失效或无 key→识别分支（需 LLM；**key 失效 + 无 LLM → 终态 `SOURCE_GONE`**，message 提示配置 LLM 可自动识别，四轮 ⑩）→覆盖回写 source_*。**统一落地协议**：① tmp 下载/转码（`.download.<task_id>.tmp` → `.song.<task_id>.mp3.tmp`）→ ② **原子写 `.pending.<task_id>`** manifest（tmp+rename；json：`task_id, song_id, mode: 'new'|'replace', had_old: boolean`，四轮 ①）→ ③ 旧 `song.mp3` 存在则 rename `.replace.<task_id>.bak` → ④ 新文件 rename `song.mp3` → ⑤ **DB 单事务**：行变更（新歌 `createFileBackedSongInTx {id, file_origin:'downloaded'}` + source_* + duration + 入单 / 既有歌 update + `setFileOrigin`）**+ 同笔写恢复日志行 `local_metadata['download.commit.<task_id>'] = song_id`** → ⑥ 清理：删 `.bak` → 删 `.pending` → 删日志行。**⑤ 失败补偿（commit 前）**：删新 `song.mp3`、`.bak` 恢复、删 `.pending`，failed `DOWNLOAD_COMMIT_FAILED`；新歌删本任务刚建的整目录。**post-commit 语义冻结**（四轮 ④）：⑤ 提交即不可逆成功点——⑥ 任一步失败 → warning + 残留原样交启动恢复（对「日志行在」一律保新文件），**主任务仍 succeeded**；late/歌单先删的 membership 软失败 → 记入 **`task.failed_playlist_ids`**（revision++ 发 status，GUI 可见，五轮 ⑥）；continuation 派生失败 → warning；补偿删除只存在于 commit 前。**启动恢复例程 `recoverSongsStore(db)`**（boot 在 engine 前调用；只承诺进程崩溃一致性，不承诺断电）判定表：tmp 四前缀（`.download.*` / `.song.*.tmp` / `.import.*.tmp` / **`.pending.*.tmp`**——manifest 原子写的中间产物，五轮 ⑧）→ 直删；`.pending` 在 + 日志行在 → 提交完成：删 bak/pending/日志行；`.pending` 在 + 日志行不在 → 未提交：**bak 在** → 删当前 `song.mp3`、恢复 bak、删 pending；**bak 不在 + `had_old=true`** → rename 未发生，当前 `song.mp3` 是完好旧文件，**保留**、只删 pending（四轮 ① 第七形态）；**bak 不在 + `had_old=false`** → 当前 `song.mp3`（若在）是未提交新文件，删之、删 pending；日志行在无 pending → 删日志行；**孤儿目录**（含 `song.mp3` 但 DB 无行、无 pending 可判）→ 移入 `trash/recovery-<时间戳>/<uuid>/` + warning，不永久删除。**claim/reservation 互斥模型**（四轮 ③ + 五轮 ③）：单一注册表按 `(song_id → {type, owner})` 记账，type ∈ **`file`**（文件写路径，download/redownload）/ **`lyrics`**（歌词写删）/ **`exclusive`**（删歌，独占全类型），owner = task_id 或路由操作 token；`acquireClaim(songId, type, owner) → ClaimToken`（同步临界区判定，冲突抛 `SongBusyError`；`release(token)`——owner 语义，无 token 不能释放）。**任务入队即以 owner=task_id 登记 reservation**（redownload/lyrics 入队即知 song_id）；**queued→running 晋升与 download 任务 resolving 绑定既有歌**（key 查库复用命中：登记关联 + 拿 claim 一步完成）都在临界区内**原子完成——acquire 对同 owner 的既有 reservation 不自阻塞**（晋升语义），对其他 owner 按冲突表判定；终态 finally 统一释放。路由操作短暂持有：删歌 = acquire `exclusive`（任何他人 reservation/claim → 409）；`DELETE /lyrics/:id` = acquire `lyrics`；PUT source 编辑 = acquire `file`（联网规范化在 claim 外，落库前 acquire 复检）。绑定冲突（如删除在飞）→ 任务 failed `SONG_BUSY`。**key 预查复用**：任务内规范化出 key 查库命中 → 不新建条目，转「为既有歌落文件（若缺）+ 合并目标歌单」，`result.song_id` 指向既有歌；提交撞 unique index（竞态）→ 补偿后重查一次按复用路径走。**URL 直下命名冻结**：`name = view.title`（剥标记实体 + trim）、`artist = view.owner.name`；批量项用 `DownloadBatchItemInput.title`（对齐 Go `UseOrigTitle`），无 title 再回退 view.title | `setFileOrigin` 只在文件就位后调用；core 小补 = `createFileBackedSongInTx`（INTERNAL 注释） |
| M3-8 | **ffmpeg 封装**：`ffmpeg-static@5.3.0` + `@derhuerst/ffprobe-static@5.3.0`（新 ffprobe 包**默认导出即路径字符串**，import 形状与旧包 `{path}` 不同，T4 核对）；`onlyBuiltDependencies` 追加两项。路径解析：env `LARK_FFMPEG_PATH`/`LARK_FFPROBE_PATH`（M7 打包位）→ static 包导出 → PATH 兜底；解析结果启动 log 一次。参数照 Go 补硬化：`-nostdin -v error -i <in> -vn -acodec libmp3lame -ab 192k -ar 44100 -y <out>`；`execFile` + AbortSignal（ffprobe 也可取消）+ **显式 `maxBuffer: 1MB`**（Node 超限直接杀进程，不能依赖默认值）；stderr 进错误信息。超时见 M3-14。`probeAudio(path)` 返回 `{duration, format}` 兼做导入校验 | 不写 ID3（§6 开放议题） |
| M3-9 | **歌词管线（独立后置任务）**：download 成功同临界区派生 / `POST /download/lyrics/:id` 手动入队，`kind:'lyrics'` 按 `kind+song_id` 去重（终态即释放），可独立取消。三平台 `Promise.allSettled` 并行（每平台整链超时，M3-14）、单平台失败仅 debug；每平台 ≤3 候选（池上限 9）、候选带 `preview/tail_preview/end_time`；LLM 精选 prompt 移植（±30s 交叉验证）。**降级启发式冻结**：`normalize` = NFKC → lowerCase → 去空白标点；`sim` = bigram Dice（`"<name> <artist>"` vs `"<title> <singer>"`）；`penalty` = duration>0 且 end_time 有效时 `min(|end−duration|, 60s)/60s × 0.5`；`score = sim − penalty` 取最高；tie-break：平台序 netease→qq→kugou，再候选原始序——单候选 / 无 LLM / LLM 失败或答非法一律走它。**LRC 有效性 = 时间戳正则 `\[\d{1,2}:\d{2}[.:]\d{2,3}\]` 至少一处**；`normalizeLRC` 单一实现；QQ/酷狗 base64。**写入 = `writeLyrics(id, lrc)`**（tmp+rename，空内容拒绝）；`DELETE /lyrics/:id` 走 claim API（M3-7）。酷狗实施时先试 https，结论记 §7 | 歌词任务失败不影响曲库 |
| M3-10 | **链接识别与联网规范化**（收严版）。一律先 `new URL()` 结构化解析：合法 B 站 host = `bilibili.com` 或 `.bilibili.com` 精确后缀；短链 host = `b23.tv`；均要求 https、无 credentials、默认端口。**b23.tv 展开**：`redirect:'manual'` 取 `Location`，只跟一跳，目标重校验后重解析；失败 → `NORMALIZE_FAILED`。**BV 锚定**：裸 BV = `^BV1[1-9A-HJ-NP-Za-km-z]{9}$`（base58 不含 0）；URL 内提取同字符集于 path 段。favlist/合集正则对齐 Go。`normalizeSourceOnline(url)` = bvid+p → pagelist → cid → `{ source_url: 'https://www.bilibili.com/video/<bvid>' + (p>1 ? '?p=N' : ''), provider: 'bilibili', key: '<bvid>:<cid>' }`（剥跟踪参数）；**p 越界一律报错**（`InvalidSourceError`，不学 Go 静默回退） | |
| M3-11 | **路由与错误分型**。新端点：`POST /download/song` `{input, playlist_id?}`→`{task_id}`；`POST /download/parse` `{input}`→`{items: ParsedItem[]}`（纯解析不入队）；`POST /download/batch` = `DownloadBatchRequest`（T1 冻结）→ preflight 锁外、`enqueueBatches` 全请求单临界区（顺序见 M3-5），返回 **`{batches: DownloadBatchData[]}`**（完整快照对象，不另设近似 Response 结构，五轮 ⑤）；`POST /download/fetch-list` = `FetchListRequest` 判别联合（五轮 ⑦）→分页展开（部分成功：已抓到的 + `error` 字段）；`POST /download/cancel` `{task_id}`（三态见 M3-5）；`GET /download/tasks` → `{tasks, batches}`；`POST /download/lyrics/:id`；`POST /songs/import` `{file_paths}`（仅 .mp3；R22 序：预分配 uuid → mkdir → 复制 `.import.<uuid>.tmp` → `probeAudio` 校验且 **`format` 实为 mp3**（改名的 AAC/M4A 拒绝、reason 明示，五轮 ⑨）→ rename `song.mp3` → DB 提交（`createFileBackedSongInTx {id, file_origin:'imported'}`，文件名为歌名、artist 空）→ 失败补偿删目录；返回 `{imported, failed}`）；`POST /songs/:id/recognize-url`（纯预览：返回单候选不写库）；`POST /songs/:id/redownload`（有 key 确定性、无 key 识别（preflight 检 LLM），`kind:'redownload'`、`resolveSongFile(song, {force:true})`）。**`PUT /songs/:id` 只给 `source_url` 四分支**：null/空串 → 清空三字段；B 站 URL（含 b23 展开）→ 联网规范化写全三元组；非 B 站 http/https → url-only（显式 `provider=null, key=null`）；非法/其他 scheme → 400 `INVALID_SOURCE`。显式三字段路径不变。**编辑与在飞互斥走 claim/pending 联合判定**（M3-7）；任务目标歌单执行前被删 → 歌曲照常成功、记入 `failed_playlist_ids`（五轮 ⑥，GUI 可见）。**错误 code 单一来源（仅 M3 新增类**；既有五类硬编码不迁移）：13 类清单：`LlmNotConfiguredError`→400 · `LlmRequestError`→502 `LLM_FAILED` · `BilibiliApiError`→502 `BILIBILI_FAILED` · `BilibiliRiskControlError`→502 `BILIBILI_RISK_CONTROL` · `SourceGoneError`→410 `SOURCE_GONE` · `NormalizeFailedError`→502 `NORMALIZE_FAILED` · `PreflightTimeoutError`→504 `PREFLIGHT_TIMEOUT` · `FfmpegError`→500 `FFMPEG_FAILED` · `DownloadCommitError`→500 `DOWNLOAD_COMMIT_FAILED` · `TaskNotFoundError`→404 `TASK_NOT_FOUND` · `TaskNotCancellableError`→409 `TASK_NOT_CANCELLABLE` · `SongBusyError`→409 `SONG_BUSY` · `DownloadQueueFullError`→429 `DOWNLOAD_QUEUE_FULL`；**engine 未知异常 → 任务 `error_code='INTERNAL_ERROR'`**（catch-all，非新类）。**输入护栏**：`input` ≤ 8KB、parse 非空行 ≤ 200、batch groups ≤ 20、单请求总 items ≤ 1000、fetch-list ≤ 50 页且累计 ≤ 1000 条、import file_paths ≤ 200 | capabilities 清单同步 |
| M3-12 | **测试策略（网络零真实外呼）**：① 单元层 `fetchImpl` stub——WBI 固定向量对拍、link 正则与 host 校验表、LLM client 双格式请求头/body（`x-api-key`+version、content[] 拼接）与 think 剥离、歌词平台解析、启发式确定性；② 集成层 **fake 上游 server**（真 listen port 0）放 `@lark/core/testing`——engine 端到端（关键词→入库→ffprobe 验 mp3/时长/非零→事件序列）、取消（两切点 + saving 后 409）、key 失效→识别→回写、复用与竞态补偿、新歌 DB 失败补偿、**落地协议与恢复例程七形态摆盘**、post-commit 注入失败、未知异常 finally、风控分型、容量与全请求原子、去重终态释放、late 集、claim/pending 互斥、batch 终态快照、revision 事件；③ ffmpeg 真实 static 二进制（合成 1s m4a → `ensureMp3` → ffprobe 断言）；④ daemon 路由层 buildTestServer + 真 engine + fake 上游，SSE 断言沿用既有 collector；⑤ **live 探测脚本** `scripts/probe-bilibili.mjs`（§2.2 六项 + fav/collection），`just probe-bilibili`，不进 CI，实施首日（gate）与验收手动跑 | |
| M3-13 | **daemon 生命周期接线与关停协议**。`AppContext` 增 `downloads` 与 `shutdownSignal: AbortSignal`；boot 在 engine 创建前调用 `recoverSongsStore`；LLM 未配置也照常创建 engine。M3 新增的 handler 内长操作（preflight b23/pagelist/LLM、fetch-list 分页、recognize-url、PUT 规范化、import ffprobe/copy）不属于 engine worker——**必须逐个 `AbortSignal.any([shutdownSignal, timeout])`**，否则 `server.close()` 等到死。**teardown 顺序**：置 stopping（拒新入队 + 拒新请求）→ reject player pending → abort `shutdownController` → `await server.close()` → `await downloads.close()`（worker 退出、ffmpeg 子进程回收、tmp 清理）→ `guiChannel.close()` → bus.close → sqlite.close → removePid。**async 波及**：`closeTestContext` 改 async，全部 daemon 既有测试 afterEach 跟改（T7 计入）；T2 子进程 SIGTERM 预算用例是回归护栏 | engine 异步回调 → bus；enqueue 类同步事件路由层发（M3-6） |
| M3-14 | **外呼超时矩阵**（一切外呼 = `AbortSignal.any([任务或请求 signal, shutdownSignal, AbortSignal.timeout(N)])`）：bilibili 元数据类 15s；b23 展开 10s；音频流整体 5min；LLM 60s；歌词每平台整链 20s；ffprobe 30s；ffmpeg 10min；preflight 请求级总预算 60s。数值集中常量文件，测试可注入缩短 | |

## 4. 任务分解

### T1 shared 线协议扩展（结构冻结，M4/M6 依赖）

- `api-paths.ts`（10 条）：`downloadSong` / `downloadParse` / `downloadBatch` / `downloadFetchList` / `downloadCancel` / `downloadTasks` / `downloadLyrics(id)` / `songImport` / `songRecognizeUrl(id)` / `songRedownload(id)`。
- `types.ts` **精确结构冻结**：

  ```ts
  export const TASK_STATES = ['queued','running','succeeded','failed','cancelled'] as const;
  export const DOWNLOAD_STAGES = ['analyzing','searching','resolving','downloading','converting','saving','lyrics'] as const;

  export type DownloadTaskInput =
    | { type: 'url'; url: string }            // 规范化展示 URL
    | { type: 'keyword'; query: string }
    | { type: 'song'; song_id: string };      // redownload / lyrics

  export interface DownloadTaskData {
    id: string;
    kind: 'download' | 'redownload' | 'lyrics';
    state: TaskState;
    stage: DownloadStage | null;              // 仅 running 期有值
    revision: number;                         // 任何可见变更递增
    input: DownloadTaskInput;
    song_id: string | null;                   // 关联/复用后填充
    playlist_ids: readonly string[];
    failed_playlist_ids: readonly string[];   // membership 软失败：歌单先删 / late 补入单失败（五轮 ⑥）
    created_at: number; started_at: number | null; finished_at: number | null;
    error_code: string | null; error_message: string | null;
    result: { song_id: string } | null;
  }

  // 请求侧与快照侧分型（四轮 ⑤）：new 创建后回填真实 playlist_id
  export type BatchTargetInput =
    | { kind: 'all' } | { kind: 'playlist'; playlist_id: string } | { kind: 'new'; name: string };
  export type BatchTargetData =
    | { kind: 'all' } | { kind: 'playlist'; playlist_id: string; name: string };

  export type DownloadBatchItemInput =        // 判别联合（五轮 ②：batchAnalyze 的 keyword 产物需要入口）
    | { kind: 'video'; bvid: string; page: number | null; title: string | null }  // title = fetch-list 可信标题（UseOrigTitle 链路）
    | { kind: 'keyword'; query: string };     // 需 LLM——preflight 无网络即可判定，同步 400（M3-2）
  export interface DownloadBatchGroupInput { target: BatchTargetInput; items: readonly DownloadBatchItemInput[]; }
  export interface DownloadBatchRequest { groups: readonly DownloadBatchGroupInput[]; }

  export interface DownloadBatchItemData {
    index: number; task_id: string;
    final: { state: 'succeeded'|'failed'|'cancelled'; error_code: string | null; song_id: string | null } | null;
  }
  export interface DownloadBatchData {
    id: string; target: BatchTargetData; total: number;
    items: readonly DownloadBatchItemData[]; created_at: number;
  }

  export type ParsedItem =
    | { kind: 'video'; bvid: string; page: number | null; url: string }
    | { kind: 'favorites'; media_id: string; url: string }
    | { kind: 'collection'; mid: string; season_id: string; url: string }
    | { kind: 'keyword'; query: string };

  export type FetchListRequest =              // 判别联合（五轮 ⑦：两类各自必填字段）
    | { type: 'favorites'; media_id: string }
    | { type: 'collection'; mid: string; season_id: string };
  export interface FetchListData {
    title: string;
    videos: readonly { bvid: string; title: string; duration: number | null }[];
    error: string | null;                     // 部分成功语义
  }
  export interface RecognizeUrlData { source_url: string; source_provider: string; source_key: string; video_title: string; }
  export interface ImportResultData {
    imported: readonly { song_id: string; name: string }[];
    failed: readonly { path: string; reason: string }[];
  }
  ```

- `LarkEvent` 修订——`download:status {task_id, state, stage}`、`download:error` 加 `error_code`、新增 `download:cancelled {task_id}` 与 **`download:batches-changed {batch_id}`**（M3-6）。
- 测试：类型编译面 + 常量导出；shared-node-free 守卫回归。

**验收**：`just test-shared` 绿。

### T2 core LLM client + prompts

- `download/llm.ts`（M3-4）+ `download/prompts.ts`（六条 prompt 中文原文移植；含 `cleanLlmJson` / `stripThink`）。
- 测试：双格式请求头/body 形状（`x-api-key`+`anthropic-version` vs `Authorization`）、anthropic `content[]` 多 text 拼接、url 尾部处理、超时与外部取消、think 剥离、围栏清洗、非 2xx / 非 JSON → `LlmRequestError`、未配置 → `LlmNotConfiguredError`。

### T3 core bilibili client + WBI + 链接

- `download/wbi.ts` + `download/bilibili.ts`（search[WBI]/pagelist/view/playurl/fav/collection + 请求头 + spi buvid + 风控分型 + `<em>`/实体剥离）+ `download/link.ts`（正则序贯 + 结构化校验 + b23 展开 + `normalizeSourceOnline`）。
- `scripts/probe-bilibili.mjs` + justfile recipe。**实施首日先跑：fav/collection 是 go/no-go gate**。
- 测试：WBI 固定向量对拍；正则/host 校验表全形态（含假 host、credentials、b23 非 B 站目标拒绝、BV 字符集无 `0`）；p 越界报错；风控 HTML → `BilibiliRiskControlError`；playurl 选最大 bandwidth。

### T4 core ffmpeg 封装

- 依赖引入（两包精确锁版 + `onlyBuiltDependencies`；核对 ffprobe 包默认导出即路径）；`download/ffmpeg.ts`（路径三级解析、`ensureMp3`、`probeAudio`、AbortSignal、超时、maxBuffer 1MB）。
- 测试：真实二进制合成 1s fixture → 转码 → ffprobe 断言；取消中途 kill；超时；非音频 → `FfmpegError`；路径解析优先级。

### T5 core 歌词管线 + writeLyrics

- `download/lyrics/{netease,qq,kugou}.ts` + `select.ts`（并行 + 每平台超时、LLM 精选、冻结版启发式、`normalizeLRC` 单一实现 + 时间戳正则）；`library/lyrics.ts` 补 `writeLyrics`。
- 测试：三平台解析（base64/明文/无时间戳拒绝）；单平台失败/挂死不拖累；LLM 选优与 ±30s；启发式确定性（duration=0 无惩罚、tie-break）；writeLyrics 原子性。

### T6 core 下载引擎 + resolveSongFile

- `download/engine.ts`（M3-5：单 worker、状态机、revision、batch 注册表与终态快照、preflight 锁外/临界区登记、`enqueueBatches`（校验→容量→单 DB 事务建歌单→登记）、去重索引统一初级键与终态释放、late 集、取消含提交点、succeeded+continuation 同临界区、**claim/pending 互斥模型（token owner + 分型 + exclusive）**、未知异常 try/catch/finally、生命周期回调、容量、async `close()`）+ `download/resolve.ts`（M3-7：force、探活、识别分支、**manifest(mode/had_old) + DB 日志落地协议 + post-commit 冻结语义**、`recoverSongsStore`、key 复用、命名冻结）+ `library/songs.ts` 小补（`createFileBackedSongInTx`）。
- 测试（fake 上游集成）：单 P URL 直下端到端（lark+aviary 均无 LLM 下成功；产物 ffprobe 验证）；多 P 无 p 无 LLM 单条同步拒 / **batch 项入队后异步 failed**（四轮 ② 取舍断言）；关键词全链路；force 重下双路径（成功→残留全清；DB 失败→旧文件恢复）；**恢复例程七形态摆盘**（① tmp 直删 ② pending+日志行（bak 在/不在）→ 保新文件清净 ③ pending 无日志 + bak → 回滚 ④ **pending 无日志、无 bak、had_old=true → 保留旧文件**（四轮 ① P0 用例）⑤ pending 无日志、无 bak、had_old=false → 删新文件 ⑥ 孤儿目录 → trash/recovery + warning ⑦ 悬空日志行 → 清除）；**post-commit 注入失败**（删 bak/删 pending/删日志行各注入 → 主任务仍 succeeded + 残留可被恢复收敛；late membership 失败软记录）；**未知异常**（注入 throw → `INTERNAL_ERROR` 且 `error_message` 为固定安全文案 + finally 释放 claim/reservation/索引 + batch 快照回写 + worker 续行）；key 失效→识别→回写 / **key 失效 + 无 LLM → `SOURCE_GONE`**；复用与竞态补偿；**去重键 auto/显式分离**（五轮 ①：`bvid:auto` 与 `bvid:1` 不合并、auto-auto 合并；跨入口 cid 漏合并 → 第二任务 key 查库快速 succeeded 不重复下载）；**reservation 原子晋升**（五轮 ③：queued→running 自己不阻塞自己、他 owner 被阻塞）；**resolving 绑定冲突 → failed `SONG_BUSY`**；**taskErrorCode 映射**（五轮 ④：batch 页越界 → `INVALID_SOURCE` 而非 `INTERNAL_ERROR`、竞态终失败 → `SOURCE_KEY_CONFLICT`）；**failed_playlist_ids**（歌单先删/late 失败 → 软记录 + revision 事件，任务仍 succeeded）；late 集补入单 + 终态直加；claim TOCTOU（lyrics claim 不阻塞 source 编辑；exclusive 独占）；取消两切点 + saving 后 409 + 终态重复 200；continuation 满容量下派生不被拒；batch 终态快照重建；revision 事件；容量 429 + 多 group 全请求原子（无任务无残歌单）；`close()` 取消在飞且 await 子进程回收；LWW 隔离断言。

### T7 daemon 路由 + 接线

- `routes/download.ts` + `routes/songs.ts` 扩三条 + PUT 四分支 + claim/pending 互斥 + 单条入口 preflight；`error-mapping.ts` 补 13 类；`context.ts`/`boot.ts`（`recoverSongsStore` + teardown 顺序）/`build-test-server.ts` 接线；**`closeTestContext` 转 async + 全部既有测试 afterEach 改造**；capabilities 同步。
- 测试：各端点契约（护栏上限、parse 不入队、batch 返回完整 `DownloadBatchData[]` 含真实 playlist_id、**batch keyword 项**（无 LLM 同步 400 / 有 LLM 入队）、**`FetchListRequest` 判别联合**（favorites 缺 `media_id` 400 等）、**多 group 容量失败整请求 429 无半生效、`{new_name}` DB 事务失败无残歌单**、fetch-list 部分成功、cancel 三态、tasks 快照含终态快照）；preflight（单条多 P 无 p 同步 400、batch video 项放行入队、`PREFLIGHT_TIMEOUT`）；recognize 不写库；redownload 双分支；import R22 与失败明细 + **改名 AAC 拒绝**（五轮 ⑨）；PUT 四分支 + claimed 409（lyrics 任务运行中 source 编辑**放行**）；SSE 事件端到端（queued 即时可见、合并 revision 必发、cancelled、**batches-changed**、**新歌单 playlists:changed**）；`DELETE /songs|lyrics` claim 互斥；关停：长 handler 在飞 SIGTERM → shutdownSignal 掐断、1s 预算退出。

### T8 守卫 + 收尾

- `just check` / `just test` / `just build` 全绿（日志卫生守卫对新模块生效）。
- 主计划回写：§4 路由表补 `GET /download/tasks`、事件行按 M3-6 修订（标注「M3 增补/修订」）；PROCESS.md 勾选 M3；**CLAUDE.md 与 AGENTS.md 同步**补「M3 实测锁定」；本文件 §7 回填。
- README 补下载用法。

**任务顺序**：T1 → T2/T3/T4（互相独立）→ T5 → T6 → T7 → T8。
**提交批次（建议，每批 commit 信息先给用户过目）**：批 1 = T1+T2+T3；批 2 = T4+T5；批 3 = T6；批 4 = T7+T8。

**用户验收关键路径**（副本 nest + 真实网络）：
① `just check` + `just test` 全绿；`just probe-bilibili` 全项通过（含 fav/collection gate）。
② URL 直下（单 P 或带 `?p`）：`POST /download/song` → SSE 观察 state/stage 流转（入队即可见）→ `song.mp3` 落盘且 `/audio` Range 可播 → `source_*` 回写 `bvid:cid` → 歌词后置任务自动派生并落 `lyrics.lrc`。
③ 关键词下载（LLM）：搜索选片 → 入库，歌名歌手被清洗。
④ 无 LLM 降级：**lark 与 aviary 均清空** → ② 照常、③ 与单条多 P 无 p 同步 400、歌词走启发式仍有产出。
⑤ 取消：下载中 cancel → `cancelled` + 事件 + tmp 清理 + 旧文件无损；saving 后 → 409；`GET /download/tasks` 快照可见终态与 batch（含终态快照）。
⑥ recognize-url 预览不写库；PUT 保存后 key 落库；redownload 凭 key 强制重下 imported→downloaded（文件确换；DB 失败演练旧文件原位恢复）。
⑦ import 本地 mp3 → duration/`imported`/失败明细；坏文件确认无残行残文件。
⑧ 收藏夹 `fetch-list` → `batch`（返回 batch 明细与真实歌单 id；`batches-changed` 与 `playlists:changed` 到达；构造超容量请求确认整请求拒、无任务无残歌单）→ 建歌单成员齐。

## 5. 与 Go 版的刻意差异

| 项 | Go 版 | lark M3 |
|---|---|---|
| LLM 依赖 | analyzeInput 硬依赖，未配 LLM 全体 503 | 正则先行；单 P/显式 p 直下与凭 key 重下零 LLM；单条入口同步预检、batch 项异步失败（明确取舍）；engine 恒可用（M3-2/M3-13） |
| 关键词搜索 | `search/type` 裸请求（已被风控拦截） | WBI 签名 + spi buvid（M3-3） |
| b23.tv 短链 | 不支持 | 一跳展开 + 结构化 host 校验（M3-10） |
| 取消 | 仅当前任务 | 按任务 id；不可逆提交点后 409；终态保留 + 事件（M3-5） |
| 重复提交 | 全局 3 秒防抖 | pending 级去重索引（键 `bvid:<p>`/`bvid:auto` 分离、终态即释放），目标合并 + late 集，成功复用靠 key 查库（M3-5） |
| 任务状态 | 只有进行中文案 | state 状态机 + revision + `{tasks, batches}` 快照（batch 携终态快照与真实歌单 id）（M3-5/M3-6） |
| 进度 | 中文文案广播 + 漂移计数 + sleep hack | `{state, stage}` 事件 + batch 独立对象 + `batches-changed`，文案归 GUI（M3-6） |
| 歌词归属 | 主任务尾阶段 | 独立后置任务（同临界区派生，可独立取消/重试）（M3-9） |
| 队列背压 | chan 满阻塞 handler | 入队即返回；pending ≤1000；preflight 锁外 + 全请求原子提交（M3-5） |
| 落盘与 DB 顺序 | createSong 先提交、文件后就位 | R22 序 + manifest(mode/had_old) + DB 事务内恢复日志；post-commit 不可逆语义；孤儿入 trash/recovery（M3-7） |
| 临时文件 | 系统 tmp，跨设备 rename 失败 | 歌曲目录内两段 tmp，同卷 rename（M3-7） |
| 多 P 越界 p | 静默回退 p1 | 报错（M3-10） |
| URL 直下命名 | LLM inferSongInfo | 冻结 `view.title`/`owner.name`；批量项用 fetch-list 标题（M3-7） |
| 歌词降级 | 取第一个候选 | 冻结版相似度 + 时长差启发式（M3-9） |
| LRC 有效性 | 「不含 `[0` 即拒」 | 时间戳正则（M3-9） |
| ffmpeg 调用 | 系统 PATH、无界缓冲、不可取消 | static 包三级解析、`-nostdin -v error` + maxBuffer、可取消可超时（M3-8/M3-14） |
| 导入 | 失败静默 continue；行先于文件 | R22 序 + 失败明细 + ffprobe 校验（M3-11） |
| 删除/编辑与下载竞争 | 无防护 | 分型 claim（token owner）+ pending 索引联合互斥（M3-7） |
| 任务异常兜底 | goroutine panic 即崩 | try/catch/finally + `INTERNAL_ERROR` + 资源释放 + worker 续行（M3-5） |
| 配置热更新 | 启动时定死 | `getLlmConfig()` 任务级快照（M3-4） |

## 6. 风险

| 风险 | 对策 |
|---|---|
| bilibili 风控继续升级（**fav·collection 未实测**） | probe 先行 + T3 首日 go/no-go gate；`BILIBILI_RISK_CONTROL` 分型可见；WBI 对照社区文档 |
| LLM 输出不可控 | 围栏清洗 + 逐场景降级链 + fake LLM 坏输出测试 |
| static 包 postinstall 被 pnpm 拦截 | `onlyBuiltDependencies` 追加 + 安装后探活断言（T4） |
| 歌词平台接口失效（酷狗 http 明文） | 三平台冗余、每平台超时软处理；独立软任务不影响曲库 |
| 落地协议状态多（tmp/pending/bak/DB 日志），实现易走样 | 协议集中 `resolve.ts` 单模块 + **七形态摆盘**（含 pending-未-bak 保旧文件、post-commit 注入失败两组反向用例）冻结行为（M3-7/T6） |
| engine 临界区膨胀（网络误入锁内） | 决策明文「网络一律锁外」+ T6 注入慢响应断言临界区不含网络等待 |
| claim/pending 互斥模型状态多 | token owner 语义 + 分型冲突表写死（M3-7）+ T6/T7 互斥矩阵用例 |
| 队列与 teardown 交错 | `shutdownSignal` 贯穿 + teardown 顺序修订 + async `downloads.close()`；T2 子进程 1s 预算回归 |
| `closeTestContext` 转 async 波及全部既有测试 | 机械改造一次性过（T7 计入）；漏 await 由 fork 池 handle 泄漏暴露 |
| 搜索 `<em>` 标记污染 | client 层统一剥离 + 断言（M3-3） |
| fake server 与真实端点漂移 | probe 固化真实契约、验收必跑；fake 响应取自 probe 真实样本 |

**开放议题（默认不做，用户点头再排期）**：① 下载/导入时写 ID3 标签与封面；② av 号支持。

## 7. 实施记录（落地时回填）

### 7.1 T3 首日 gate：fav / collection 端点实测（2026-08-05）

**结论 GO**，`just probe-bilibili` 11 项全过（`scripts/probe-bilibili.mjs`，从一次关键词搜索自发现 bvid/mid/season_id/media_id，全部可用 env 钉死）。

| 端点 | 结果 |
|---|---|
| `x/frontend/finger/spi` | ✅ 签发 b_3 / b_4 |
| `x/web-interface/nav` | ✅ **envelope code -101（未登录）但 `data.wbi_img` 照给**——判定必须看字段而非 code |
| `x/web-interface/search/type`（裸） | ✅ 如期被拦（HTTP 200 + `text/html` 风控页），WBI 仍是必需 |
| `x/web-interface/wbi/search/type` | ✅ 10 条结果；**10/10 标题带 `<em>` 标记** |
| `x/player/pagelist` / `view` / `playurl` | ✅ 免签；playurl `dash.audio` 3 档，best bandwidth 319076 |
| `x/v3/fav/folder/info` · `x/v3/fav/resource/list` | ✅ **匿名可用**（953 条的公开收藏夹，`ps=20` 实返 15 条 + `has_more=true`——分页只能信 `has_more`，不能按 ps 推断结束） |
| `x/polymer/web-space/home/seasons_series` · `seasons_archives_list` | ✅ 匿名可用（`page.total` 可信） |

**唯一变化**：`x/v3/fav/folder/created/list-all`（按 up_mid 列收藏夹）匿名一律 `code:0 + data:null`，已登录才有内容。**不影响 M3**——`fetch-list` 的 media_id 来自 URL（`space.bilibili.com/<uid>/favlist?fid=<media_id>`），这个端点从不在链路上；probe 里只用「默认收藏夹 media_id = mid×10+2」约定找样本。

**probe 的一个已知形态**：连续多次跑会触发限流，签名搜索开始返回拦截页，后续每项都以「no mid discovered」级联失败。这是打到限额、不是签名坏了——隔一会儿重跑即可（脚本头部已注明）。

### 7.2 酷狗 https 可用性（2026-08-05）

**三个端点全部支持 https**，Go 版对 `krcs.kugou.com/search` 与 `lyrics.kugou.com/download` 用明文 http 没有必要，已全部改成 https（`LYRICS_ORIGINS`）。另外实测确认：`krcs` 的 `search` **必须带 `hash` + `duration`（毫秒）**，只给 keyword 会返回 `candidates: []`——这是「没歌词」和「问错了」的区别。

### 7.3 实施中修订的决策

| # | 修订 | 原因 |
|---|---|---|
| 1 | **`engine.ts` 拆成 `engine.ts` + `task-data.ts` + `batches.ts`，`claims.ts` 独立** | 单文件 922 行，超本仓「800+ 行强制拆分」硬线（M3-1 原写「engine.ts（队列 + claim/pending 索引）」）。拆分按关注点：调度 / 任务形状与错误映射 / 批次快照 / 冲突表 |
| 2 | **`lyrics/` 增 `lrc.ts` + `shared.ts`** | M3-1 只列了 `{netease,qq,kugou,select}`。`normalizeLRC` 单一实现要有落点，三个平台文件否则得互相 import 或复制辅助函数 |
| 3 | **不导出独立的 `resolveSongFile(song, {force})`** | 决策树（force / 文件在就跳过 / key 探活→失效重识别）实现在引擎的下载路径里。单独再导出一个会复制一份 claim + 落盘编排，等于第二份高风险逻辑。M5 的「播放无文件自动下载」接 `enqueueRedownload` 或加 task kind |
| 4 | **`bilibili` client 收敛到 `ctx.bilibili` 一份** | 原设计路由与 engine 各建一个。同进程两个 client = 两份 WBI/buvid 缓存 = 对风控是两个身份 |
| 5 | **`import` 走 `landSongFile`** | M3-11 描述了一套独立的 import 落盘序。复用同一协议后，import 的崩溃一致性和恢复例程自动等同于下载，且只有一份代码 |
| 6 | **恢复例程结束时删掉「全部」日志行**（不只悬空的） | 恢复已消费掉所有 manifest，任何日志行都不再有意义；只删悬空的会让每次下载永久留一行 |
| 7 | **ffmpeg 补 `-f mp3`** | 输出是 `.tmp` 结尾的任务临时路径，ffmpeg 推不出容器 |
| 8 | **新歌也拿 `file` claim** | 原本只有复用既有歌才 acquire。补上之后「running 的下载一定持有 file claim」无例外，M5 的清理和删歌路由可以直接依赖 |

### 7.4 实施中被测试逼出来的缺陷（全部已修）

1. **恢复例程扫掉已提交的 manifest 后不删日志行** —— `local_metadata` 每次下载永久涨一行。
2. **`songs/` 目录不存在时提前 return** —— 全新安装 + 崩溃残留时悬空日志行永远清不掉。
3. **`fetchAudio` 往还不存在的歌曲目录写临时文件** —— 新歌首次下载必 ENOENT；被 catch-all 兜成 `INTERNAL_ERROR`，脱敏文案正确生效（真实路径只进日志）。
4. **`normalizeLrc` 与 `lrcEndTime` 共用带 `g` 的模块级正则** —— `.test()` 留下的 `lastIndex` 让下一次 `matchAll` 从半路起步，短歌词被误判成「没有时间戳」。
5. **`ffmpeg-static` / `@derhuerst/ffprobe-static` 的 `.d.ts` 与 CJS 实际导出不符** —— NodeNext 下默认导入被当成模块命名空间（运行时是 string）。

### 7.5 M3 实测锁定

- **`nav` 匿名返回 `code: -101` 但照给 `wbi_img`** —— WBI 取 key 必须看字段而不是 envelope code，看 code 会在健康环境上 fail-closed。
- **`fav/resource/list` 的 `ps=20` 实返 15 条 + `has_more=true`** —— 分页结束只能信 `has_more`。
- **`folder/created/list-all` 匿名 `data:null`（需登录）** —— 不在 M3 链路上（media_id 来自 URL）。
- **ffmpeg 输出到 `.tmp` 路径必须 `-f mp3`**。
- **两个 static 包实测都是 arm64 / ffmpeg 6.0**，旧 `ffprobe-static` 的 Intel-only 问题确认避开。
- **酷狗 `krcs` 必须带 hash + duration(ms)**。
- **daemon 测试的 `closeTestContext` 已转 async**，全部 `afterEach` 必须 `await`——漏 await 在 fork 池下表现为句柄泄漏而不是断言失败。
- **`app.inject` 的返回类型是含 `void` 的交叉类型**，包一层 helper 时 `await` 不收窄，helper 必须显式标注返回类型。
- **路径遍历 id（`../etc`）由路由器归一化后落到未注册路由 → 404**，不进 handler；单段非 uuid 才是 400。
