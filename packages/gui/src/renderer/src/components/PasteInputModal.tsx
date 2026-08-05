// The multi-line paste box behind the expand button (Go's TextInputModal).
// It only hands text back — parsing and routing stay in the download bar.

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

interface PasteInputModalProps {
  onConfirm: (text: string) => void;
  onClose: () => void;
}

export function PasteInputModal({ onConfirm, onClose }: PasteInputModalProps): React.JSX.Element {
  const [text, setText] = useState('');

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-150">
        <DialogHeader>
          <DialogTitle>批量下载</DialogTitle>
          <DialogDescription>
            每行一个链接或歌曲名称，支持视频、收藏夹与合集链接。
          </DialogDescription>
        </DialogHeader>
        <textarea
          // biome-ignore lint/a11y/noAutofocus: the dialog exists to be typed into
          autoFocus
          aria-label="批量下载输入"
          className="h-56 w-full resize-none rounded-md border bg-transparent p-2 font-mono text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button size="sm" disabled={text.trim() === ''} onClick={() => onConfirm(text)}>
            解析
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
