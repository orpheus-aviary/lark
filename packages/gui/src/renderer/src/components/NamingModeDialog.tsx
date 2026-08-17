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
//
// That keypress is the whole keyboard story here: the remembered answer takes
// FOCUS when the dialog opens, not just a highlight, so paste-enter-enter is
// the fast path and ←/→ is how you take the other one. Radix would otherwise
// focus the first child, which is 取消 — the one answer nobody arrives here
// wanting.

import type { DownloadNamingMode } from '@lark/shared';
import { useState } from 'react';
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
  // A remembered answer this machine cannot honour is not a default.
  const preferred: DownloadNamingMode = value === 'clean' && !llmAvailable ? 'original' : value;
  const [focused, setFocused] = useState<DownloadNamingMode>(preferred);
  const [originalButton, setOriginalButton] = useState<HTMLButtonElement | null>(null);
  const [cleanButton, setCleanButton] = useState<HTMLButtonElement | null>(null);

  /**
   * ←/→ move between the two answers. Focus is the state — the highlight
   * follows it through `onFocus` — so there is one place to be wrong about
   * which one Enter will take, and it is the one the browser already draws a
   * ring around.
   */
  function onArrow(event: React.KeyboardEvent): void {
    if (event.key === 'ArrowRight' && llmAvailable) cleanButton?.focus();
    else if (event.key === 'ArrowLeft') originalButton?.focus();
    else return;
    event.preventDefault();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent
        className="sm:max-w-110"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (preferred === 'clean' ? cleanButton : originalButton)?.focus();
        }}
      >
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
            ref={setOriginalButton}
            variant={focused === 'original' ? 'default' : 'secondary'}
            onFocus={() => setFocused('original')}
            onKeyDown={onArrow}
            onClick={() => onConfirm('original')}
          >
            原标题
          </Button>
          <Button
            ref={setCleanButton}
            variant={focused === 'clean' ? 'default' : 'secondary'}
            disabled={!llmAvailable}
            title={llmAvailable ? undefined : '需要先配置 LLM'}
            onFocus={() => setFocused('clean')}
            onKeyDown={onArrow}
            onClick={() => onConfirm('clean')}
          >
            清洗命名
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
