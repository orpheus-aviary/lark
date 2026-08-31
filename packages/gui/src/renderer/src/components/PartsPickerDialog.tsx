// "Which parts?", asked only once somebody has been told they must answer it
// (0.5.1 §7.3).
//
// 🔴 THE REFUSAL IS THE TRIGGER, not a probe. A pasted link is classified
// offline, so nothing here knows a video has parts until the daemon says so —
// and asking every link would put a request in front of the single-part videos
// that are the overwhelming majority. `MULTI_PART_UNRESOLVED` is a refusal
// that costs nothing (the preflight answers before a task exists), so the
// cheapest way to find out is to try. One mechanism, both entry points: the
// batch dialog reacts to the same refusal in place.
//
// NOTHING IS TICKED WHEN IT OPENS (§7.3-d). The whole point of this dialog is
// that a person chooses; a pre-ticked list of forty parts turns one stray
// Enter into forty downloads.

import type { DownloadNamingMode, DownloadPartData } from '@lark/shared';
import { useState } from 'react';
import { PartsList } from './PartsList.js';
import { Button } from './ui/button.js';
import { Checkbox } from './ui/checkbox.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.js';

export interface PartsPickerDialogProps {
  /** The video these parts belong to, as bilibili titles it. */
  title: string;
  parts: readonly DownloadPartData[];
  /** Pre-selected naming, from last time — the same answer links remember. */
  naming: DownloadNamingMode;
  /** `false` disables cleaning and says why — no LLM is configured. */
  llmAvailable: boolean;
  submitting: boolean;
  onConfirm: (pages: readonly number[], naming: DownloadNamingMode) => void;
  onCancel: () => void;
}

export function PartsPickerDialog({
  title,
  parts,
  naming,
  llmAvailable,
  submitting,
  onConfirm,
  onCancel,
}: PartsPickerDialogProps): React.JSX.Element {
  const [checked, setChecked] = useState<readonly number[]>([]);
  const [mode, setMode] = useState<DownloadNamingMode>(naming);

  const toggle = (page: number): void =>
    setChecked((prev) => (prev.includes(page) ? prev.filter((p) => p !== page) : [...prev, page]));

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-160">
        <DialogHeader>
          <DialogTitle>选择要下载的分P</DialogTitle>
          <DialogDescription className="truncate" title={title}>
            {title}
          </DialogDescription>
        </DialogHeader>

        <PartsList
          idPrefix="picker"
          parts={parts}
          checked={checked}
          onToggle={toggle}
          onToggleAll={(all) => setChecked(all ? parts.map((part) => part.page) : [])}
        />

        <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
          <Checkbox
            id="parts-original"
            checked={mode === 'original'}
            disabled={llmAvailable === false}
            onCheckedChange={() => setMode(mode === 'original' ? 'clean' : 'original')}
          />
          <label
            htmlFor="parts-original"
            title={
              llmAvailable === false
                ? '没有配置 LLM，只能用原标题'
                : '勾上 = 直接用分P 标题；不勾 = 让 LLM 读出歌名和歌手'
            }
          >
            原标题
          </label>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={submitting}>
            取消
          </Button>
          <Button
            onClick={() => onConfirm(checked, mode)}
            disabled={checked.length === 0 || submitting}
          >
            下载选中的 {checked.length} 个
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
