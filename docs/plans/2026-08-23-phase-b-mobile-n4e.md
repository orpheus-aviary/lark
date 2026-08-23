# Phase B · N4e LLM 设置页与它解锁的四条能力（`apps/mobile`）

- **日期**：2026-08-23（**v1，待用户评审**）。决策 a–i 待关闭。
- **这是 N4 子计划里 N4e 那一行的展开**，不替代它：`docs/plans/2026-08-20-phase-b-mobile-n4.md` 的 **§2.8（LLM 配置，已冻结）**· §2.1（文件布局）· 判据 **26–30** 全部原样继承。这份只写「怎么落地、分几批、怎么验」。
- **前置**：**N4d 已完成**（head `c6d8159`，判据 20–23 + 25 + 44–45 真机全绿，**22 是 gate 且反测走了完整一轮构建**）。手机上已经有：添加页（粘贴 → 离线 parse → 命名 chip → 目标 → 提交）· 任务列表（进度/取消/降级态）· 根层分享 intent · 引擎 + 前台服务 + 落盘协议。
- **基线**：2026-08-23 实测 `just check` exit 0、`just test` exit 0 / **2844 passed**（shared 143 · core 1243 · mobile 135 · cli 428+9 skipped · daemon 468 · gui 427）、`just mobile-typecheck` exit 0。
- **冻结设备**：vivo V2408A（Android 15 / API 35），行为判据一律 **release 构建**。
- **用户已拍板两条**（2026-08-23）：**手机上填与桌面同一份 url + model + key**（好处是判据 27 可以拿桌面的命名结果做对照）· **设置页加「测试连接」**（决策 c 因此定为「做」）。

---

## §0 范围

**做**：`portable/llm-config.ts`（`local_metadata` 的三个键，形状照 `now-playing-mode.ts`）· `apps/mobile/src/settings/llm.ts`（拼 `LlmConfig`：三个字段来自库、`api_key` 来自 SecureStore）· 设置页的 LLM 段（四个字段 + 「已配置」+ **测试连接** + 清除）· **把 `getLlmConfig` / `hasLlm` 从常量换成现读** · 判据 **26–30**，外加 **N4d 欠下的判据 24 的设备半边**。

**不做（本批）**：收藏夹 / 合集展开与批量提交（N4f，判据 31–33）· ensure-file 与缓存管理（N4g）· 歌单导出（N4g）· **把 LLM 配置纳入同步**（决策 h：per-install，与 `now_playing_mode` / `play_mode` / `naming_mode` 同域）· 失败任务的重试入口（N4d 决策 i 留下的，仍不做）。

**一句话的边界**：N4d 之后，手机能下「你已经拿到链接的那首歌」；N4e 之后，它能下「你只记得名字的那首歌」，也能在旧链接失效之后自己把歌找回来。

---

## §1 开工前必须知道的

### 1.1 三道门今天全是同一个常量关着，而它们的文案已经写好了

`apps/mobile/src/downloads/engine.ts:67` 是 `NO_LLM_CONFIG`，`:192` 的 `getLlmConfig` 和 `:237` 的 `hasLlm` 都读它。所以：

- `preflightSingle`（`portable/download/preflight.ts:68`）的三道门——**关键词**、**clean 命名**、**多 P 且链接不带 `?p=`**——恒定关闭；
- `reidentifySource`（`portable/download/pipeline.ts:272`）恒定抛 `SourceGoneError`。

**这四处一个字都不用改。** 它们已经在按 `deps.hasLlm` / `deps.llm` 分支，本批只是让那个布尔值第一次可以是 `true`。判据 26–29 因此**不是新功能的判据，是接线的判据**——问的是「配上之后，这四条路是不是真的通了」。

### 1.2 `getLlmConfig` 必须是同步的，而 SecureStore 正好有同步读

`DownloadEngineOptions.getLlmConfig` 的签名是 `() => LlmConfig`（无 Promise），引擎在 `engine.ts:720` 按任务快照一次（`#llmSnapshot`，`:770`）。`expo-secure-store` 的 `getItem` 是**同步**的——`identity/store.ts` 从 N2c 起就靠这一点在启动序列里读身份。所以「每次现读」（§2.8 冻结的口径）落地上没有障碍。

**代价要写清楚**：每次读都是一次 Keystore 往返。引擎一个任务只读一次，设置页与添加页各读一次渲染——不是热路径。**不要**为了省这几次去加缓存，缓存会让「刚在设置页改完，添加页还是旧的」成为一个新 bug。

### 1.3 `api_format` 的 `''` 在手机上没有意义

`LLM_API_FORMATS`（`shared/config-types.ts:28`）是 `['', 'openai', 'anthropic']`，而 `''` 的含义是**「跟随 aviary 的共享配置」**——一台手机没有 `aviary_config.toml`，也没有 `resolveLlmConfig` 那条回退链。存 `''` 并把它显示成一个可选项，是把桌面的一个概念搬到了它不存在的地方。

`chatCompletion`（`llm.ts:57`）只判 `=== 'anthropic'`，别的一律当 OpenAI，所以 `''` 在行为上等于 `openai`——**分歧只在 UI 与存储上**，而这正是会长出误解的地方。→ 决策 a。

### 1.4 🔴 key 会不会漏，有一条路是真的存在的

`chatCompletion` 在 `!response.ok` 时抛 `LlmRequestError(\`HTTP ${status}: ${text.slice(0, 500)}\`)`（`llm.ts:80`）——**provider 的响应体原样进错误文案**，而这条文案会走到 `DownloadTaskData.error_message`，也就是任务列表上那行红字。绝大多数 provider 不会把 key 回显在错误里，但**有网关会**（把整个请求 echo 回来的调试网关）。

判据 30 因此不能只查「设置页不回显」，还要**在一次真实的失败上**去 grep 任务快照与日志。→ §4 判据 30 有三处采样点。

请求头里带 key 是必然的（`x-api-key` / `Authorization`），那条路不经过任何文案。

### 1.5 `hasLlm()` 从常量变成可变量之后，谁负责重读

`ui/add-tab.tsx` 在渲染体里读 `runtime.hasLlm()`（不是 state，不是 memo）。四个 tab 是**条件挂载**的（`shell.tsx`），从「设置」切回「添加」会重新挂载 `AddTab`，于是自然重读。

**这条成立的前提是「设置页与添加页不可能同时可见」**——今天成立（一次只渲染一个 tab）。**如果哪一天加了分栏或者把设置做成 modal，这条就断了**，那时候要么把 `hasLlm` 变成 hub 那样的外部 store，要么在设置页保存后广播一次。写在这里，是为了那天有人能查到它为什么原来是对的。→ 决策 d。

### 1.6 判据 24 的设备半边在本批才第一次可跑

N4d 欠下的：没有模型时只有一个可选命名模式（`clean` 是灰的），「选过一次下次默认是它」没有可观测差别。**配上模型之后 `clean` 变成可选**，`resolveNamingMode({ remembered, hasLlm })`（`portable/naming-mode.ts`）的三条规则才第一次全部可见。本批顺手把它关掉。

### 1.7 D16 的语义：恢复一台手机之后，key 会不见

`api_key` 存 SecureStore，而 SecureStore 的键**不跨恢复**（N0b-5a 实测：卸载重装读不回来）——这正是 D16 用来分辨「这个库是不是我的」的那个非对称性。所以**从备份恢复的手机上，url/model 还在（在库里）而 key 没了**，设置页会显示「未配置」。

这是对的，不要去补迁移。但**文案要说得出来**：一个只丢了 key 的配置，看起来像「什么都没配」。→ 决策 g。

### 1.8 手机上打字这件事，本批第一次成为主要交互

N4d 的输入框只需要粘一条链接；本批要填四个字段，其中 url 和 key 都长且不容错。**两条已知的实测约束**（`docs/LESSONS.md`）：键盘弹起时底部 tab 栏和它下面的东西点不到；`adb shell input text` 不解码 `%3F` 之类。前者决定 UI 布局（保存/测试按钮不能压在屏幕底部），后者只影响我驱动设备的方式。

---

## §2 目标结构

### 2.1 文件布局

```
packages/core/src/portable/
└── llm-config.ts             ← 新（N4e-1）：local_metadata 的 llm_url / llm_model /
                              #   llm_api_format，形状照 now-playing-mode.ts

apps/mobile/src/
├── settings/
│   └── llm.ts                ← 新（N4e-1）：读/写整份 LlmConfig（库 + SecureStore），
│                             #   `testLlm()` 一次最小 chatCompletion（决策 c）
├── downloads/
│   └── engine.ts             ← 改（N4e-1）：getLlmConfig / hasLlm 换成现读，删 NO_LLM_CONFIG
├── ui/
│   └── settings-tab.tsx      ← 新（N4e-2）：从 shell.tsx 里拆出来 + LLM 段（决策 e）
└── acceptance/
    └── reidentify.ts         ← 新（N4e-3）：把一首歌的 source_key 改成不存在的 cid（判据 29）
```

### 2.2 存哪、缺省是什么（§2.8 原样继承，只补 `''` 那一条）

| 字段 | 存哪 | 缺省 | 读不懂时 |
|---|---|---|---|
| `url` | `local_metadata.llm_url` | `''` | 读成 `''`，**不写库** |
| `model` | `local_metadata.llm_model` | `''` | 同上 |
| `api_format` | `local_metadata.llm_api_format` | **`'openai'`**（决策 a） | 读成 `'openai'` 并 `logger.warn`，**不写库** |
| `api_key` | SecureStore `lark.llm.api_key`（`requireAuthentication: false`） | `''` | — |

`isLlmConfigured` 沿用 core（`url` + `model` 非空，`llm.ts:37`）——**本地端点合法地没有 key**，所以 key 不进这个判断。

### 2.3 设置页的 LLM 段

```
模型                                    [已配置 ✓] / [未配置]
  接口地址   [https://…                        ]
  模型       [                                 ]
  接口格式   ( openai )  ( anthropic )
  API Key    [••••••••]  ← 已存时显示「已配置 · 清除」，不回显
  [ 测试连接 ]  [ 保存 ]
  <上一次测试/保存的结果，一行>
```

- **保存与测试是两个动作**：测试用**当前编辑中的草稿**，不落库——「先试通了再存」是手机上唯一舒服的顺序。
- **测试 = 一次最小 `chatCompletion`**（system + user 各一句，`max_tokens` 小），当场回「通了」或 provider 的原话。**这条错误文案与判据 30 是同一处**：显示前先过一遍脱敏（§4-30）。
- **不回显 key**（§2.8 冻结）：存过之后字段是空的、旁边写「已配置」，要换就直接输入新的，要删就点「清除」。
- **保存按钮在字段下方、不在屏幕底部**（§1.8），整段在 `ScrollView` 里、`keyboardShouldPersistTaps="handled"`。

### 2.4 接线

```ts
// downloads/engine.ts
getLlmConfig: () => readLlmConfig(boot.db.sqlite),   // 每次现读（§1.2）
hasLlm: () => isLlmConfigured(readLlmConfig(boot.db.sqlite)),
```

`readLlmConfig` 在 `settings/llm.ts`：三个字段走 portable、`api_key` 走 SecureStore、拼成一个 `LlmConfig`。

---

## §3 批次划分

| 批 | 内容 | 需要设备 | 判据 |
|---|---|---|---|
| **N4e-1** | **存储与接线**：`portable/llm-config.ts` + 单测 · `settings/llm.ts`（读/写/测试）· `engine.ts` 换成现读、删 `NO_LLM_CONFIG` | 否 | —（单测） |
| **N4e-2** | **设置页**：`ui/settings-tab.tsx` 从 `shell.tsx` 拆出 + LLM 段（四字段 + 已配置 + 测试 + 清除）+ 键盘布局 | 是 | **30 · 24** |
| **N4e-3** | **四条能力真机验收**：关键词 / clean / 多 P / 重新识别（含 `acceptance/reidentify.ts`）+ 两条反测 | 是 | **26 · 27 · 28 · 29** |

**顺序理由**：N4e-1 是纯逻辑且没有它设置页无处可存；N4e-2 之后设备上才有输入 key 的入口（在那之前四条能力一条都验不了）；N4e-3 全是真机与真模型，排最后。**判据 30 排在 N4e-2 而不是 N4e-3**，因为「key 不外泄」的第一处采样点是设置页本身，而那时它还没被用来发过任何请求——**先证明存进去不漏，再证明用起来不漏**。

---

## §4 判据

**继承 N4 子计划的 26–30，逐条给出「怎么跑」；外加 N4d 欠下的 24。**

24. **命名模式记忆（N4d 欠账，设备半边）**：配上模型 → `清洗命名` chip 变为可选 → 选它 → 提交一次 → **force-stop 重开，添加页默认仍是清洗命名**。再选回原标题、再冷启动一次，默认跟着变。**反测**：把 `writeNamingMode` 那一行去掉 → 冷启动必须回到 `clean`（有模型时的默认），而不是记住的值。
26. **关键词搜索**：设置页填齐 → 添加页粘一个**歌名**（不是链接）→ 预览不再是拒绝 → 提交 → 下成一首歌，歌曲 tab 里有它。
27. **`clean` 真的走了模型**：同一条链接下两次——先 `原标题`、记下 `name`/`artist`，**删掉**，再 `清洗命名`——两次落库的 `name`/`artist` **不同**。**再加一条**：`clean` 失败时**回落到原标题而不是任务失败**（做法：把 model 改成一个不存在的名字、只让命名这一步失败）。
28. **多 P 且不写 `?p=`**：`BV1LtgV6ZE2U`（实测 2 个分 P）不带 `?p=` 提交——**没配 LLM 时**当场说「加 ?p= 或配 LLM」（N4d 已验，本批复跑一次作对照）；**配了之后**自动选集并下成。**反测**：去掉 `preflightSingle` 的多 P 门 → 重建装机 → 未配置时必须变成**异步失败**（任务列表里一行红字）而不是当场说明。
29. **重新识别**：`acceptance/reidentify.ts` 把一首歌的 `source_key` 改成一个不存在的 cid → 重新下载 → **无 LLM 时** `SOURCE_GONE` 且文案说得出怎么修（`「X」原来的来源已失效，且没有配置 LLM 无法自动找到新来源…`）· **有 LLM 时**重新识别并下成。
30. **key 不外泄**，三处采样：① **设置页**只显示「已配置」，字段不回显（截屏 + `uiautomator dump` 全量 grep 不到 key 的任何前缀）；② **一次真实失败之后**（把 key 改错、提交一次 clean 命名），任务列表那行 `error_message` 里 grep 不到 key；③ **logcat**（release 下应用自己不打，但要确认 RN/OkHttp 层没有把请求头打出来）。**反测**：把 key 故意拼进一条测试文案 → ① 必须红。

---

## §5 决策（a–i，**全部待关闭**）

| # | 决策 | 倾向 | 关键理由 |
|---|---|---|---|
| **a** | 手机的 `api_format` 值域 | **只有 `openai` / `anthropic`，缺省 `openai`；不给 `''`** | `''` 的含义是「跟随 aviary 共享配置」，而手机没有那份配置也没有回退链（§1.3）。行为上 `''` 本来就等于 openai，所以这里**只是不把一个不存在的概念摆到 UI 上**。存进库的永远是两个具体值之一 |
| **b** | key 存 SecureStore 还是 `CredentialStore` 端口 | **SecureStore 直存**（§2.8 已冻结，此处只记录不重开） | `CredentialStore` 端口是 skybridge 凭证的形状（账号 + token + server），塞一个裸字符串进去要么改端口要么造假字段 |
| **c** | 测试连接按钮 | **做**（用户 2026-08-23 拍板） | 手机上手敲 url + key 极易错一个字符，而错了的代价是「下载到一半异步失败」——那正是 §1.1 要避免的形状。桌面没有这个按钮，但桌面可以直接改配置文件 |
| **d** | 配置变了谁重读 | **不加订阅**：`getLlmConfig` / `hasLlm` 每次现读，`AddTab` 靠切 tab 重挂载自然重读 | §1.5：四个 tab 条件挂载，设置页与添加页不可能同时可见。**这个前提写进代码注释**，将来加分栏/modal 时它会是第一个断的假设 |
| **e** | `SettingsTab` 拆不拆出 `shell.tsx` | **拆**（`ui/settings-tab.tsx`） | `shell.tsx` 现在 ~230 行且塞着四个 tab 里三个的实现；加一段四字段表单会把它推向 300+。仓库规矩是 500 行建议拆——但这里拆的理由不是行数，是**设置页从「一个开关 + 诊断」变成了一个有草稿状态的表单** |
| **f** | 测试连接用草稿还是已存的值 | **草稿**，且**不落库** | 「先试通了再存」是手机上唯一舒服的顺序；用已存值就必须先存一份可能是错的 |
| **g** | 恢复后只丢 key 的文案 | **区分「未配置」与「key 不见了」**：url/model 还在但 key 空 → 显示「接口地址与模型还在，API Key 需要重新填（它不随备份恢复）」 | §1.7：这台手机上这是**必然会发生**的一种状态，而它看起来和「什么都没配」一样。代价是多一句文案和一个分支 |
| **h** | LLM 配置进不进同步 | **不进**，与 `now_playing_mode` / `play_mode` / `naming_mode` 同域（per-install） | 一台手机和一台笔记本用不同的端点是常态；而 key 进 `sync_changes` 等于把它发到 server 上 |
| **i** | 判据 27 的「同一条链接下两次」怎么造 | **下一次 → 删 → 再下一次**（不是找两条不同的视频） | 判据原文就是「同一条链接」；顺带再走一次 `deleteSong` 的 file-op drain。代价是要删一次库里的歌（跟 N4d 一样，**先问用户**） |

---

## §6 风险

| 风险 | 缓解 |
|---|---|
| **判据 26–29 全依赖一个真实可用的模型端点** | 用户已定：与桌面同一份 url + model + key。**N4e-3 开跑前先用「测试连接」确认一次**，不通就先解决端点，别把端点问题误读成接线问题 |
| 🔴 **key 可能经 provider 的错误响应体外泄**（§1.4） | 判据 30 的采样点 ② 就是为它设的；显示前脱敏（把已知的 key 串从文案里抹掉）**是代码改动不是文案约定** |
| **手机上填四个字段的键盘遮挡** | §1.8：`ScrollView` + `keyboardShouldPersistTaps="handled"`，保存/测试按钮跟在字段后面而不是钉在底部 |
| **判据 27 要删一次库里的歌** | 与 N4d 同一条：**先问用户**，或者由用户自己删 |
| **判据 28 的反测要改 portable 再重建** | 与 N4d 判据 22 的反测同一个规格（改 → 装 → 验红 → 还原 → 装 → 验绿），两次构建各约 1–2 分钟 |
| **`''` 值域收窄可能与桌面的存量值冲突** | 不会：这三个键是**移动端新建的** `local_metadata` 行，桌面的 LLM 配置在 `lark_config.toml`，两边不共享存储 |

---

## §7 本批不会证明的事（先写在这里）

- **收藏夹 / 合集**（N4f 判据 31–33）：本批之后关键词能用了，但列表链接仍然只能被拒绝。
- **ensure-file / 点没有文件的歌**（N4g 判据 34）· **缓存管理**（N4g）· **歌单导出**（N4g）。
- **模型质量**：判据 27 只证明 `clean` 与 `original` **不同**且失败时回落，不判断清洗得对不对。
- **多个 provider 的兼容性**：只验用户配的那一个（openai 或 anthropic 其中一条路）。另一条路只有代码路径和桌面测试，**如实记着**。
- **key 在 Keystore 里的强度**：D16 已经量过「不跨恢复」，本批不重复；也不验 root 设备下能不能读出来。
- **失败任务的重试入口**（N4d 决策 i）：配好模型之后「换个命名模式再来」仍然要手动重新粘一次链接。
