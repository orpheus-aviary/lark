// The settings page (M5-1): two tabs, one local form draft, and a single
// `PATCH /config` on save.
//
// The shell only: the form fields live in `settings/GeneralTab`, the sync half
// in `settings/SyncTab`, and what a save actually sends in `settings/draft`.
// Two decisions still belong here:
//
//   OPENING REFETCHES. The main process PATCHes the window size behind the
//   renderer's back (M5-3), so the mirror can be stale in exactly the section
//   this page shows — and ffmpeg may have been installed since it was last
//   probed (M7-18).
//
//   THE DRAFT IS LOCAL. Typing must not write; only [保存] does, and it sends
//   only the sections that changed. The sync tab's own actions (login, logout,
//   revoke, retry) are NOT part of the draft: they take effect immediately,
//   because "your password is saved but not applied yet" is not a state worth
//   inventing.

import { ApiError } from '@lark/shared';
import { Settings } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '../lib/errors.js';
import { useCache } from '../stores/cache.js';
import { useConfig } from '../stores/config.js';
import { useMediaTools } from '../stores/media-tools.js';
import { useSettingsUi } from '../stores/settings-ui.js';
import { useSync } from '../stores/sync.js';
import { GeneralTab } from './settings/GeneralTab.js';
import { SyncTab } from './settings/SyncTab.js';
import { type Draft, buildPatch, toDraft } from './settings/draft.js';
import { Button } from './ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs.js';

export function SettingsDialog(): React.JSX.Element {
  const config = useConfig((s) => s.config);
  const refreshConfig = useConfig((s) => s.refresh);
  const patchConfig = useConfig((s) => s.patch);
  const refreshCache = useCache((s) => s.refresh);
  const watchCache = useCache((s) => s.setWatching);
  const refreshMediaTools = useMediaTools((s) => s.refresh);
  const refreshSync = useSync((s) => s.refresh);
  const refreshFileOps = useSync((s) => s.refreshFileOps);

  // The open flag lives in a store rather than here: the sync popover is a
  // second door into this dialog (v0.2 T4), and two components cannot share a
  // `useState`.
  const open = useSettingsUi((s) => s.open);
  const setOpen = useSettingsUi((s) => s.setOpen);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  /** Field path → message, straight from the daemon's `details.path` (M5-20). */
  const [fieldError, setFieldError] = useState<{ path: string; message: string } | null>(null);

  useEffect(() => {
    if (!open) {
      watchCache(false);
      return;
    }
    watchCache(true);
    refreshConfig();
    refreshCache();
    // Re-probed on every open: `brew install ffmpeg` in another window and
    // reopening this dialog is the intended recovery path, no restart (M7-18).
    refreshMediaTools();
    refreshSync();
    refreshFileOps();
    setFieldError(null);
  }, [
    open,
    refreshConfig,
    refreshCache,
    refreshMediaTools,
    refreshSync,
    refreshFileOps,
    watchCache,
  ]);

  // The draft follows the mirror while the dialog is closed, and is left alone
  // once it is open — a background refresh must not discard what was typed.
  useEffect(() => {
    if (config === null) return;
    setDraft((current) => (current === null ? toDraft(config) : current));
  }, [config]);

  const openWith = (next: boolean): void => {
    setOpen(next);
    if (!next) setDraft(null);
    else if (config !== null) setDraft(toDraft(config));
  };

  const save = async (): Promise<void> => {
    if (config === null || draft === null) return;
    const patch = buildPatch(draft, config);
    if (Object.keys(patch).length === 0) {
      openWith(false);
      return;
    }
    setSaving(true);
    try {
      await patchConfig(patch);
      setFieldError(null);
      openWith(false);
      toast.success('设置已保存');
    } catch (err) {
      const path = err instanceof ApiError ? err.details?.path : undefined;
      if (typeof path === 'string') setFieldError({ path, message: errorMessage(err) });
      else toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const errorFor = (path: string): string | undefined =>
    fieldError?.path === path ? fieldError.message : undefined;

  const update = (patch: Partial<Draft>): void =>
    setDraft((current) => (current === null ? current : { ...current, ...patch }));

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="设置"
        title="设置"
        onClick={() => openWith(true)}
      >
        <Settings />
      </Button>

      <Dialog open={open} onOpenChange={openWith}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>设置</DialogTitle>
            <DialogDescription>改动在点击「保存」后才会写入配置文件。</DialogDescription>
          </DialogHeader>

          {draft === null || config === null ? (
            <p className="text-muted-foreground text-sm">正在读取配置…</p>
          ) : (
            <Tabs defaultValue="general">
              <TabsList>
                <TabsTrigger value="general">常规</TabsTrigger>
                <TabsTrigger value="sync">同步</TabsTrigger>
              </TabsList>
              <TabsContent value="general" className="max-h-[60vh] space-y-5 overflow-y-auto pr-1">
                <GeneralTab draft={draft} config={config} update={update} errorFor={errorFor} />
              </TabsContent>
              <TabsContent value="sync" className="max-h-[60vh] space-y-5 overflow-y-auto pr-1">
                <SyncTab draft={draft} update={update} errorFor={errorFor} />
              </TabsContent>
            </Tabs>
          )}

          <DialogFooter>
            <Button variant="secondary" onClick={() => openWith(false)}>
              取消
            </Button>
            <Button disabled={saving || draft === null} onClick={() => void save()}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
