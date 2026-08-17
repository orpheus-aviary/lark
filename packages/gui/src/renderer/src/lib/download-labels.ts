// Chinese text for the download pipeline's enums (D17). The Go daemon sent
// ready-made Chinese progress strings; M3 split state from stage and left the
// wording to the front-end, so the table lives here.

import type {
  DownloadStage,
  DownloadTaskData,
  DownloadTaskInput,
  DownloadTaskKind,
  TaskState,
} from '@lark/shared';

/**
 * §3.6-2's wording, shared with the CLI's. `converting` is "processing"
 * rather than "transcoding": from 0.3.0 an AAC source is rewrapped, and the
 * same stage doing a hundredth of the work should not claim otherwise.
 */
export const STAGE_LABELS: Record<DownloadStage, string> = {
  analyzing: '解析输入',
  searching: '搜索视频',
  resolving: '定位资源',
  naming: '清洗命名',
  downloading: '下载音频',
  converting: '处理音频',
  saving: '落盘',
  lyrics: '匹配歌词',
};

/**
 * What KIND of work this is, for the rows where the name is not enough.
 *
 * A finished download and the lyrics fetch it spawned are two tasks about one
 * song (§3.6-3), so since they started carrying the song's name they read as
 * the same row twice. `download` has no tag on purpose: it is what this panel
 * is for, and tagging every row would only make the exceptions harder to spot.
 */
export const KIND_LABELS: Record<DownloadTaskKind, string | null> = {
  download: null,
  redownload: '重新下载',
  'ensure-file': '按需下载',
  lyrics: '歌词',
};

export const STATE_LABELS: Record<TaskState, string> = {
  queued: '排队中',
  running: '进行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

/** What the task was asked to fetch, short enough for one status line. */
export function inputLabel(input: DownloadTaskInput): string {
  switch (input.type) {
    case 'url':
      return input.url;
    case 'keyword':
      return input.query;
    case 'song':
      return '已有歌曲';
  }
}

/**
 * What to call this task in a list.
 *
 * The daemon fills `title` as soon as anyone can name the song — at enqueue for
 * a task that starts from one, at `naming` for a link. Before that the input IS
 * the honest answer: a queued link has no name yet, and inventing one would be
 * worse than showing the URL.
 */
export function taskTitle(task: DownloadTaskData): string {
  return task.title ?? inputLabel(task.input);
}

/** The title with its kind, for places that get one string: labels, tooltips. */
export function taskDescription(task: DownloadTaskData): string {
  const kind = KIND_LABELS[task.kind];
  return kind === null ? taskTitle(task) : `${kind} ${taskTitle(task)}`;
}

/**
 * How far the transfer has come, or `null` when that is not a question worth
 * answering — every stage but `downloading`, and the moment before the first
 * chunk lands (§3.5). Percent when the source declared a size, megabytes when
 * it did not: "3.4MB of ?" is still progress, "NaN%" is not.
 */
function progressLabel(task: DownloadTaskData): string | null {
  if (task.stage !== 'downloading' || task.received_bytes === 0) return null;
  if (task.total_bytes === null) return `${(task.received_bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.floor((task.received_bytes / task.total_bytes) * 100)}%`;
}

/** State plus stage in one phrase: only a running task has a stage. */
export function taskLabel(task: DownloadTaskData): string {
  if (task.state !== 'running' || task.stage === null) return STATE_LABELS[task.state];
  const progress = progressLabel(task);
  return progress === null ? STAGE_LABELS[task.stage] : `${STAGE_LABELS[task.stage]} ${progress}`;
}
