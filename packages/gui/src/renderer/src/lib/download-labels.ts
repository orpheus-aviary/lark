// Chinese text for the download pipeline's enums (D17). The Go daemon sent
// ready-made Chinese progress strings; M3 split state from stage and left the
// wording to the front-end, so the table lives here.

import type { DownloadStage, DownloadTaskData, DownloadTaskInput, TaskState } from '@lark/shared';

export const STAGE_LABELS: Record<DownloadStage, string> = {
  analyzing: '解析中',
  searching: '搜索中',
  resolving: '定位资源',
  naming: '清洗命名',
  downloading: '下载中',
  converting: '转码中',
  saving: '保存中',
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

/** State plus stage in one phrase: only a running task has a stage. */
export function taskLabel(task: DownloadTaskData): string {
  if (task.state === 'running' && task.stage !== null) return STAGE_LABELS[task.stage];
  return STATE_LABELS[task.state];
}
