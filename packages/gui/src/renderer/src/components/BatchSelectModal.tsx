// Batch selection (D19) and the §4.2 mapping onto the wire protocol.
//
// Two submit semantics share one dialog and must not be blurred together:
// every list group goes out as ONE `POST /download/batch`, which the daemon
// commits all-or-nothing; the "single items" group is then submitted one
// request at a time, best-effort, and stops at the first refusal.

import type {
  DownloadBatchGroupInput,
  DownloadNamingMode,
  DownloadPartsData,
  ParsedItem,
} from '@lark/shared';
import { ApiError, VIRTUAL_ALL_PLAYLIST_ID } from '@lark/shared';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '../lib/errors.js';
import { isComposingKey } from '../lib/ime.js';
import { loadNamingMode, rememberNamingMode } from '../lib/naming-mode.js';
import { useDownloads } from '../stores/download.js';
import { useLibrary } from '../stores/library.js';
import { useMediaTools } from '../stores/media-tools.js';
import {
  type BatchGroup,
  type GroupRow,
  checkedRows,
  groupPayload,
  listGroupId,
  listQuery,
  partsGroupId,
} from './batch-groups.js';
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

/**
 * The empty default for `prefetchedParts`, hoisted.
 *
 * 🔴 NOT `= []` IN THE SIGNATURE. A default parameter builds a NEW array on
 * every render, and this one is an effect dependency — so the expansion effect
 * re-ran on every render, re-fetched every list, and reset the ticks somebody
 * had just changed. Caught by「drops a group whose items are all unticked」,
 * which is what that criterion is for.
 */
const NO_PREFETCHED_PARTS: readonly DownloadPartsData[] = [];

/** `POST /download/batch` limits, enforced before the request (§4.2). */
const BATCH_ITEMS_MAX = 1000;
const BATCH_GROUPS_MAX = 20;

/**
 * A pasted line downloaded on its own: a keyword, or a video with one part.
 *
 * 🔴 A MULTI-PART VIDEO IS NOT ONE OF THESE. It becomes a GROUP, exactly like
 * a favourites folder (0.5.1，用户「格式也和合集完全统一」): a name you can
 * edit, a tick per song, one naming answer, and a playlist of its own at the
 * end. The promotion happens in the expansion effect below, so this list only
 * ever holds what `POST /download/song` can take verbatim.
 */
interface SingleItem {
  key: string;
  label: string;
  /** What `POST /download/song` receives verbatim. */
  input: string;
  /** Keywords are named by the model regardless, so the choice skips them. */
  isVideo: boolean;
  /** `null` for keywords — there is nothing to list the parts of. */
  bvid: string | null;
  checked: boolean;
}

interface BatchSelectModalProps {
  items: readonly ParsedItem[];
  /**
   * Parts already fetched by whoever opened this (0.5.1).
   *
   * The single-link path has to ask BEFORE opening — it only opens the dialog
   * when the answer is "more than one" — so handing the answer over is what
   * keeps 「多一次连网」 to one.
   */
  prefetchedParts?: readonly DownloadPartsData[];
  /** The batch went in — this question is answered and done with. */
  onClose: () => void;
  /**
   * Abandoned: the text that produced these items goes back to the box it was
   * typed into (②). Every way out that is NOT a submission lands here — the
   * footer button, Escape, a click on the overlay — because losing a pasted
   * list is the same accident whichever of the three did it.
   */
  onBack: () => void;
}

export function BatchSelectModal({
  items,
  prefetchedParts = NO_PREFETCHED_PARTS,
  onClose,
  onBack,
}: BatchSelectModalProps): React.JSX.Element {
  const fetchList = useDownloads((s) => s.fetchList);
  const fetchParts = useDownloads((s) => s.fetchParts);
  const submitBatch = useDownloads((s) => s.submitBatch);
  const downloadSong = useDownloads((s) => s.downloadSong);
  const playlistId = useLibrary((s) => s.playlistId);
  const llmAvailable = useMediaTools((s) => s.llmAvailable);
  // Read once: the dialog's own state owns it from here, and a re-render
  // reaching back into storage would fight the user's clicks.
  const [initialNaming] = useState(() => (llmAvailable === false ? 'original' : loadNamingMode()));

  const [singles, setSingles] = useState<readonly SingleItem[]>(() =>
    items
      .filter((item) => item.kind === 'video' || item.kind === 'keyword')
      .map((item, index) => ({
        key: `single-${index}`,
        // §4.2: a video keeps the normalised url (with `?p=`), a keyword the query.
        label: item.kind === 'video' ? item.url : item.query,
        input: item.kind === 'video' ? item.url : item.query,
        isVideo: item.kind === 'video',
        bvid: item.kind === 'video' ? item.bvid : null,
        checked: true,
      })),
  );
  const [groups, setGroups] = useState<readonly BatchGroup[]>(() =>
    items
      .filter((item) => item.kind === 'favorites' || item.kind === 'collection')
      .map((item) => ({
        kind: 'list' as const,
        id: listGroupId(item),
        query: listQuery(item),
        source: item,
        title: item.kind === 'favorites' ? '收藏夹' : '合集',
        useOriginalTitle: initialNaming === 'original',
        rows: [],
        loading: true,
        error: null,
      })),
  );
  /**
   * Videos still being asked about (0.5.1).
   *
   * A video line is a single item until its page list comes back saying
   * otherwise, and the button must not be pressable in between — otherwise a
   * fast Enter submits a link that is one answer away from becoming a group.
   */
  const [probing, setProbing] = useState<readonly string[]>(() =>
    items.flatMap((item) => (item.kind === 'video' && item.page === null ? [item.url] : [])),
  );
  const [submitting, setSubmitting] = useState(false);
  const [confirmButton, setConfirmButton] = useState<HTMLButtonElement | null>(null);
  const focusedConfirm = useRef(false);
  const [editing, setEditing] = useState<string | null>(null);
  // One answer for every link item in this submission (§3.6-1). The list
  // groups keep their own, because a favourites folder and a pasted link are
  // not obviously the same decision.
  const [singlesNaming, setSinglesNaming] = useState<DownloadNamingMode>(initialNaming);

  // 🔴 EVERY SOURCE EXPANDS WHEN THE DIALOG OPENS (0.5.1，用户「单条和多行都
  // 直接展开」). A list is expanded because it cannot be downloaded without
  // being; a video is expanded because nothing offline can tell whether it has
  // parts, and finding out afterwards is what made the parts arrive in a
  // different shape from a collection's. It costs one request per video line,
  // which is the price named for it.
  //
  // `items` is fixed for as long as the dialog is open, so this runs once each.
  useEffect(() => {
    for (const item of items) {
      if (item.kind === 'video' && item.page === null) {
        const seeded = prefetchedParts.find((data) => data.bvid === item.bvid);
        const answer = seeded === undefined ? fetchParts(item.bvid) : Promise.resolve(seeded);
        void answer
          .then((data) => {
            // One part is not a group: it stays the single line it looks like,
            // and downloads through `/download/song` exactly as before.
            if (data.parts.length > 1) promoteToGroup(item.url, data);
          })
          .catch(() => {
            // Leave it a single line. Submitting it will be refused with
            // MULTI_PART_UNRESOLVED, and that path expands it too — one more
            // chance rather than a dead end.
          })
          .finally(() => setProbing((prev) => prev.filter((url) => url !== item.url)));
        continue;
      }
      if (item.kind !== 'favorites' && item.kind !== 'collection') continue;
      const id = listGroupId(item);
      void fetchList(listQuery(item))
        .then((result) => {
          setGroups((prev) =>
            prev.map((candidate) =>
              candidate.id === id
                ? {
                    ...candidate,
                    title: result.title === '' ? candidate.title : result.title,
                    rows: result.videos.map((video) => ({
                      key: video.bvid,
                      label: video.title,
                      checked: true,
                    })),
                    loading: false,
                    // Partial success keeps the list AND says what went wrong;
                    // only an empty result is an error state (§4.2).
                    error: result.error,
                  }
                : candidate,
            ),
          );
        })
        .catch((err: unknown) => {
          setGroups((prev) =>
            prev.map((candidate) =>
              candidate.id === id
                ? { ...candidate, loading: false, error: errorMessage(err) }
                : candidate,
            ),
          );
        });
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: `promoteToGroup`
    // is defined below and stable for the life of the dialog; `items` is fixed.
  }, [items, fetchList, fetchParts, prefetchedParts]);

  /**
   * A video line becomes a group of its parts.
   *
   * 🔴 NOTHING IS TICKED (§7.3-d), which is what differs from a list: somebody
   * who opened a folder came for the folder, while this screen exists
   * precisely because a person is choosing which parts — and forty ticked in
   * advance turns one stray Enter into forty downloads.
   */
  function promoteToGroup(url: string, data: DownloadPartsData): void {
    setSingles((prev) => prev.filter((item) => item.input !== url));
    setGroups((prev) =>
      prev.some((group) => group.id === partsGroupId(data.bvid))
        ? prev
        : [
            ...prev,
            {
              kind: 'parts' as const,
              id: partsGroupId(data.bvid),
              bvid: data.bvid,
              title: data.title,
              useOriginalTitle: initialNaming === 'original',
              rows: data.parts.map((part) => ({
                key: String(part.page),
                label: part.part === '' ? `P${part.page}` : part.part,
                checked: false,
              })),
              loading: false,
              error: null,
            },
          ],
    );
  }

  const patchGroup = (id: string, patch: { title?: string; useOriginalTitle?: boolean }): void =>
    setGroups((prev) => prev.map((group) => (group.id === id ? { ...group, ...patch } : group)));

  const toggleRow = (id: string, key: string): void =>
    setGroups((prev) =>
      prev.map((group) =>
        group.id === id
          ? {
              ...group,
              rows: group.rows.map((row) =>
                row.key === key ? { ...row, checked: !row.checked } : row,
              ),
            }
          : group,
      ),
    );

  const toggleAll = (id: string, checked: boolean): void =>
    setGroups((prev) =>
      prev.map((group) =>
        group.id === id
          ? { ...group, rows: group.rows.map((row) => ({ ...row, checked })) }
          : group,
      ),
    );

  // Zero-selection groups are filtered out entirely: the daemon requires every
  // group AND every item list to be non-empty (§4.2).
  const activeGroups = groups.filter((group) => checkedRows(group).length > 0);
  const checkedSingles = singles.filter((item) => item.checked);
  const groupItemCount = activeGroups.reduce((sum, group) => sum + checkedRows(group).length, 0);
  const total = groupItemCount + checkedSingles.length;
  // A video still being asked about counts as loading: pressing Enter in that
  // window would submit a link that is one answer away from becoming a group.
  const loading = groups.some((group) => group.loading) || probing.length > 0;

  // Only the groups count against the batch endpoint's limits — the single
  // items go through `/download/song`, one request each.
  const overLimit =
    groupItemCount > BATCH_ITEMS_MAX
      ? `一次最多 ${BATCH_ITEMS_MAX} 个视频（当前 ${groupItemCount}），请分批提交`
      : activeGroups.length > BATCH_GROUPS_MAX
        ? `一次最多 ${BATCH_GROUPS_MAX} 个列表（当前 ${activeGroups.length}），请分批提交`
        : null;
  const canConfirm = total > 0 && !loading && submitting === false && overLimit === null;

  /**
   * Confirm takes the focus, so a list that arrives ready is one Enter away —
   * the same keyboard path the single-link question has.
   *
   * ONCE per opening, and only once it is usable: a favourites folder is still
   * loading when the dialog opens (a disabled button cannot hold focus), and
   * re-focusing on every change would yank the caret out of whatever checkbox
   * the user just reached for.
   */
  useEffect(() => {
    if (!canConfirm || focusedConfirm.current) return;
    focusedConfirm.current = true;
    confirmButton?.focus();
  }, [canConfirm, confirmButton]);

  /** One request, all-or-nothing: every group rides in the same batch. */
  async function submitGroups(): Promise<void> {
    if (activeGroups.length === 0) return;
    const payload: DownloadBatchGroupInput[] = activeGroups.map(groupPayload);
    await submitBatch(payload);
    toast.success(`已提交 ${payload.length} 组，共 ${groupItemCount} 项`);
  }

  /**
   * The backstop: a line the opening probe could not expand, refused at submit.
   *
   * Rare now that every video expands when the dialog opens — it takes a probe
   * that failed and a daemon that answered. It promotes to a group like every
   * other path, so the parts never arrive in a second shape.
   */
  async function expandOnRefusal(item: SingleItem): Promise<void> {
    if (item.bvid === null) return;
    try {
      promoteToGroup(item.input, await fetchParts(item.bvid));
    } catch (err) {
      // Told to pick a part and given no way to pick one is the worse of the
      // two messages, so this one replaces the refusal rather than following it.
      toast.error(`无法列出「${item.label}」的分P：${errorMessage(err)}`);
    }
  }

  /**
   * 🔴 THE MULTI-PART REFUSAL IS A QUESTION, NOT A FAILURE (§7.3-c).
   *
   * It stops the run for the same reason a full queue does — everything after
   * this line is unsubmitted and stays that way — but instead of an error it
   * leaves the line EXPANDED, with its parts listed where it sits. Nothing
   * already queued is rolled back; confirming again picks up from the parts.
   *
   * Anything else is the failure it looks like: a full queue stops the rest,
   * and the count says how far it got.
   */
  async function reportSingleFailure(
    item: SingleItem,
    err: unknown,
    done: number,
  ): Promise<'asked' | 'failed'> {
    const multiPart = err instanceof ApiError && err.errorCode === 'MULTI_PART_UNRESOLVED';
    if (multiPart && item.bvid !== null) {
      await expandOnRefusal(item);
      toast.info(`「${item.label}」有多个分P，请选择要下载的分P`);
      return 'asked';
    }
    toast.error(`单项下载已提交 ${done}/${checkedSingles.length}：${errorMessage(err)}`);
    return 'failed';
  }

  /** One request per item, in order, stopping at the first refusal (§4.2). */
  async function submitSingles(): Promise<'done' | 'stopped' | 'asked'> {
    if (checkedSingles.length === 0) return 'done';
    const target = playlistId === VIRTUAL_ALL_PLAYLIST_ID ? undefined : playlistId;
    let done = 0;
    for (const item of checkedSingles) {
      try {
        await downloadSong(item.input, target, item.isVideo ? singlesNaming : undefined);
        done++;
      } catch (err) {
        // Either way the run stops here; what differs is what the person is
        // left looking at — a group of parts to pick from, or an error.
        return (await reportSingleFailure(item, err, done)) === 'asked' ? 'asked' : 'stopped';
      }
    }
    toast.success(`已提交 ${done} 个单项下载`);
    return 'done';
  }

  async function confirm(): Promise<void> {
    setSubmitting(true);
    rememberNamingMode(singlesNaming);
    try {
      await submitGroups();
      // 🔴 NOT CLOSED WHEN THE RUN STOPPED TO ASK (0.5.1，用户实测). The parts
      // are listed IN THIS DIALOG, so closing it throws the question away the
      // moment it is asked — which is what 「多 P 不会被展开，会失败」 looked
      // like from the outside. Every other outcome keeps the shipped
      // behaviour: a full queue still says how far it got and closes.
      if ((await submitSingles()) === 'asked') return;
      onClose();
    } catch (err) {
      // The batch is all-or-nothing, so nothing was queued by it.
      toast.error(`批量提交失败：${errorMessage(err)}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onBack();
      }}
    >
      <DialogContent
        className="flex max-h-[88vh] flex-col sm:max-w-160"
        onOpenAutoFocus={(event) => {
          // Radix focuses the first tabbable child, which is the 原标题
          // checkbox. For links that need no fetching the button is usable on
          // the first render, and taking focus HERE rather than in the effect
          // below is what makes it stick — FocusScope's own pass runs after a
          // mount effect and would put it straight back.
          //
          // While a list is still loading the button is disabled and cannot
          // hold focus, so Radix keeps it inside the dialog and the effect
          // hands it over when the items arrive.
          if (confirmButton === null || confirmButton.disabled) return;
          event.preventDefault();
          confirmButton.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>批量下载（{total} 项）</DialogTitle>
          <DialogDescription>
            列表会各自新建歌单并一次性提交；单项下载逐条提交到当前歌单。
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 space-y-3 overflow-y-auto">
          {singles.length > 0 && (
            <section className="rounded-md border">
              <header className="flex items-center gap-2 rounded-t-md bg-muted px-3 py-2 text-sm">
                <span className="font-medium">单项下载</span>
                <span className="text-muted-foreground text-xs">({singles.length})</span>
                <label
                  htmlFor="singles-original"
                  className="ml-auto flex items-center gap-1.5 text-muted-foreground text-xs"
                  title={
                    llmAvailable === false
                      ? '没有配置 LLM，只能用原标题'
                      : '勾上 = 直接用视频标题；不勾 = 让 LLM 读出歌名和歌手'
                  }
                >
                  <Checkbox
                    id="singles-original"
                    checked={singlesNaming === 'original'}
                    disabled={llmAvailable === false}
                    onCheckedChange={() =>
                      setSinglesNaming(singlesNaming === 'original' ? 'clean' : 'original')
                    }
                  />
                  原标题
                </label>
              </header>
              <ul className="max-h-48 overflow-y-auto p-2">
                {singles.map((item) => (
                  <li key={item.key} className="flex items-center gap-2 px-1 py-0.5 text-sm">
                    <Checkbox
                      id={item.key}
                      checked={item.checked}
                      onCheckedChange={() =>
                        setSingles((prev) =>
                          prev.map((candidate) =>
                            candidate.key === item.key
                              ? { ...candidate, checked: !candidate.checked }
                              : candidate,
                          ),
                        )
                      }
                    />
                    <label htmlFor={item.key} className="truncate">
                      {item.label}
                    </label>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {groups.map((group) => {
            const checkedCount = checkedRows(group).length;
            return (
              <section key={group.id} className="rounded-md border">
                <header className="flex items-center gap-2 rounded-t-md bg-muted px-3 py-2 text-sm">
                  {editing === group.id ? (
                    <input
                      // biome-ignore lint/a11y/noAutofocus: replaces the title the user just double-clicked
                      autoFocus
                      aria-label="歌单名称"
                      className="flex-1 rounded bg-background px-1 py-0.5 text-sm outline-none"
                      defaultValue={group.title}
                      onBlur={(e) => {
                        const name = e.target.value.trim();
                        if (name !== '') patchGroup(group.id, { title: name });
                        setEditing(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !isComposingKey(e)) e.currentTarget.blur();
                        else if (e.key === 'Escape') setEditing(null);
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="flex-1 truncate text-left font-medium"
                      title="双击编辑歌单名称"
                      onDoubleClick={() => setEditing(group.id)}
                    >
                      {group.title}
                      <span className="ml-1 text-muted-foreground text-xs">
                        ({checkedCount}/{group.rows.length})
                      </span>
                    </button>
                  )}
                  <label
                    htmlFor={`orig-${group.id}`}
                    className="flex items-center gap-1.5 text-muted-foreground text-xs"
                  >
                    <Checkbox
                      id={`orig-${group.id}`}
                      checked={group.useOriginalTitle}
                      onCheckedChange={() =>
                        patchGroup(group.id, { useOriginalTitle: !group.useOriginalTitle })
                      }
                    />
                    原标题
                  </label>
                  {group.rows.length > 0 && (
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => toggleAll(group.id, checkedCount !== group.rows.length)}
                    >
                      {checkedCount === group.rows.length ? '全不选' : '全选'}
                    </Button>
                  )}
                </header>

                {group.error !== null && (
                  <p
                    className={`px-3 py-1.5 text-xs ${
                      group.rows.length > 0
                        ? 'text-amber-600 dark:text-amber-500'
                        : 'text-destructive'
                    }`}
                  >
                    {group.rows.length > 0
                      ? `${group.error}（已取回 ${group.rows.length} 条，可继续选择）`
                      : group.error}
                  </p>
                )}

                {group.loading ? (
                  <p className="px-3 py-3 text-muted-foreground text-xs">加载中…</p>
                ) : (
                  <ul className="max-h-96 overflow-y-auto p-2">
                    {group.rows.map((row: GroupRow) => (
                      <li key={row.key} className="flex items-center gap-2 px-1 py-0.5 text-sm">
                        <Checkbox
                          id={`${group.id}-${row.key}`}
                          checked={row.checked}
                          onCheckedChange={() => toggleRow(group.id, row.key)}
                        />
                        <label htmlFor={`${group.id}-${row.key}`} className="truncate">
                          {row.label}
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>

        <DialogFooter className="items-center">
          {overLimit && <span className="mr-auto text-destructive text-xs">{overLimit}</span>}
          {/* 返回, not 取消: the user asked for one button here rather than
              two, because the accident being guarded against is the misclick
              that throws a pasted list away. Cancelling is still one more
              Escape away from the box this returns to. */}
          <Button variant="outline" size="sm" onClick={onBack}>
            返回
          </Button>
          <Button
            ref={setConfirmButton}
            size="sm"
            disabled={!canConfirm}
            onClick={() => void confirm()}
          >
            {submitting ? '提交中…' : `确认下载（${total}）`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
