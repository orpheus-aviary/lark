// "What should this be called?", asked once per submission (§3.6-1).
//
// The Go version had a checkbox that read "original title" and did nothing:
// both branches stored the same string, so nobody could have noticed it was
// broken by using it. The replacement asks a question with two answers that
// visibly differ, and says what each one costs — one of them is an LLM call
// per video, which is also why it can be unavailable.
//
// No "remember my choice" checkbox: the choice IS remembered as the default
// (§4-e), and a submission that queues 200 downloads under a name policy the
// user last picked days ago is worth one keypress.

import type { DownloadNamingMode } from '@lark/shared';
import { Button } from './ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.js';

interface NamingModeDialogProps {
  open: boolean;
  /** How many link items this answer covers; shown so "one" reads as one. */
  count: number;
  /** Pre-selected, from last time (§4-e). */
  value: DownloadNamingMode;
  /** `false` disables cleaning and says why — no LLM is configured. */
  llmAvailable: boolean;
  onConfirm: (mode: DownloadNamingMode) => void;
  onCancel: () => void;
}

export function NamingModeDialog({
  open,
  count,
  value,
  llmAvailable,
  onConfirm,
  onCancel,
}: NamingModeDialogProps): React.JSX.Element {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent className="sm:max-w-110">
        <DialogHeader>
          <DialogTitle>怎么命名？</DialogTitle>
          <DialogDescription>
            {count === 1 ? '这个链接' : `这 ${count} 个链接`}的歌名和歌手怎么定。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 text-sm">
          <p className="text-muted-foreground">
            <span className="text-foreground">原标题</span>
            ——直接用视频标题，歌手记 UP
            主。不联网、不花钱，但标题里的「【官方MV】」之类会一起进曲库。
          </p>
          <p className="text-muted-foreground">
            <span className="text-foreground">清洗命名</span>
            ——让 LLM 从标题里读出歌名和歌手（读不出就回退成原标题 + UP 主）。每个视频一次调用。
          </p>
          {!llmAvailable && (
            <p className="text-destructive">
              没有配置 LLM，暂时只能用原标题（设置里配好之后可用）。
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            取消
          </Button>
          <Button
            variant={value === 'original' ? 'default' : 'secondary'}
            onClick={() => onConfirm('original')}
          >
            原标题
          </Button>
          <Button
            variant={value === 'clean' ? 'default' : 'secondary'}
            disabled={!llmAvailable}
            title={llmAvailable ? undefined : '需要先配置 LLM'}
            onClick={() => onConfirm('clean')}
          >
            清洗命名
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
