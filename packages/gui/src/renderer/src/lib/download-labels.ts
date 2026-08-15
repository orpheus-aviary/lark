// Chinese text for the download pipeline's enums (D17). The Go daemon sent
// ready-made Chinese progress strings; M3 split state from stage and left the
// wording to the front-end, so the table lives here.

import type { DownloadStage, DownloadTaskData, DownloadTaskInput, TaskState } from '@lark/shared';

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
 * How far the transfer has come, or `null` when that is not a question worth
 * answering — every stage but `downloading`, and the moment before the first
 * chunk lands (§3.5). Percent when the source declared a size, megabytes when
 * it did not: "3.4MB of ?" is still progress, "NaN%" is not.
 */
export function progressLabel(task: DownloadTaskData): string | null {
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
