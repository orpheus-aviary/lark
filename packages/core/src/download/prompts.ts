// The six LLM prompts, ported verbatim from the Go version (M3-2). Their
// Chinese wording is the interface: they were tuned against real bilibili
// titles, and a paraphrase is a behaviour change, not a cleanup.
//
// One call site DID move. In Go, `analyzePrompt` ran first on every download
// and decided url-vs-keyword — which is why an unconfigured LLM took the whole
// pipeline down. Here the regexes decide that (deterministically, offline), so
// the prompt survives only as the multi-line batch fallback. The text is
// unchanged; its authority is not.

/** Split one free-form line into `{type, url, song_name, artist, query}`. */
export const ANALYZE_PROMPT = `你是一个音频下载助手。分析用户输入，判断是URL还是关键词搜索。
用户可能想下载歌曲、播客、相声、直播切片、有声书等任何bilibili音频内容。
返回JSON格式（不要markdown代码块）：
- 如果是URL：{"type":"url","platform":"bilibili","url":"...","song_name":"","artist":""}
- 如果是关键词：{"type":"keyword","song_name":"内容名称","artist":"创作者/歌手","query":"bilibili搜索词"}
注意：
- song_name填内容名称（歌名、节目名、标题等）
- artist填创作者（歌手、UP主、主播、演员等）
- query应该是适合在bilibili搜索的关键词`;

/** Clean a bilibili title + uploader into `{song_name, artist}`. */
export const INFER_SONG_INFO_PROMPT = `你是一个音频下载助手。根据bilibili视频标题、用户输入和UP主信息，推断内容名称和创作者。
内容可能是歌曲、播客、相声、直播切片、有声书等。
返回JSON格式（不要markdown代码块）：{"song_name":"内容名称","artist":"创作者"}
规则：
- 如果是歌曲：song_name填歌名（去掉MV、官方、完整版等后缀），artist填歌手
- 如果是其他内容：song_name填节目/视频标题的核心部分，artist填UP主/主播/演员
- UP主名称可以帮助推断创作者（例如"等什么君Official"说明歌手是"等什么君"）
- 如果无法确定创作者，artist留空`;

/** Split multi-line paste into items. Regexes overrule its classification. */
export const BATCH_ANALYZE_PROMPT = `你是一个音频下载助手。用户输入了多行文本，可能包含多组下载目标。
请将输入拆分为独立的项目，每项是以下之一：
- 关键词（歌名+歌手等）
- 单个视频链接（bilibili.com/video/BV...）
- 收藏夹链接（space.bilibili.com/.../favlist?fid=...）
- 合集链接（space.bilibili.com/.../lists/...）

返回JSON数组（不要markdown代码块）：
[{"type":"keyword|video|favorites|collection","raw":"原始文本","url":"链接(如有)"}]

注意：每行通常是一个独立项目，但也可能一行内有多个链接。`;

/** Pick the best search hit. Answers a bare bvid, or `NONE`. */
export function selectPrompt(songName: string, artist: string): string {
  return `你是一个音频下载助手。从bilibili搜索结果中选择最匹配的视频。
用户想要下载的内容：名称="${songName}"，创作者="${artist}"
搜索结果如下（JSON数组），请返回最匹配的视频的bvid（纯文本，不要JSON）。
如果没有合适的结果，返回"NONE"。
选择规则：
- 如果是歌曲：官方/原创/本家 > 无损/录音棚 > 高清 > 翻唱（除非用户指定版本）
- 如果是其他内容（播客、相声、直播切片等）：选择标题最匹配、创作者最相关的视频
- 避免选择：合集（除非用户明确要合集中的某一期）、教程、评论/反应视频`;
}

/** Pick a part of a multi-P video. Answers a bare page number. */
export function multiPPrompt(songName: string, artist: string): string {
  return `这是一个bilibili多P视频的分P列表。用户想要下载：歌名="${songName}"，歌手="${artist}"
请返回最匹配的分P编号（纯数字，如"3"）。
根据标题和时长判断，优先选择与歌曲名称最匹配的分P。
如果无法判断，返回"1"。`;
}

/**
 * Pick a lyrics candidate. Answers a 1-based index. The ±30s rule is the
 * whole point: title similarity alone happily picks a different cut of the
 * same song, and the last timestamp is the one signal that catches it.
 */
export function lyricsSelectPrompt(songName: string, artist: string, duration: number): string {
  return `你是一个歌词匹配助手。从多个平台的歌词候选中选择最匹配的一个。
目标歌曲：歌名="${songName}"，歌手="${artist}"，音频时长=${formatDuration(duration)}
候选列表如下（JSON数组），请返回最匹配候选的序号（纯数字，从1开始）。
选择规则：
- 歌名和歌手越匹配越好
- 歌词预览内容应该与歌曲相关
- end_time 是歌词最后一行的时间标签，应与音频时长接近（差距越小越好）
- 如果 end_time 与音频时长差距超过30秒，该候选可能不匹配
- tail_preview 是歌词最后几行，可辅助判断歌词是否完整
- 如果多个候选都匹配，优先选择时长最接近且歌词内容更完整的
- 如果无法判断，返回"1"`;
}

/** `M:SS`, or `未知` when the duration is unknown — Go-version parity. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '未知';
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
