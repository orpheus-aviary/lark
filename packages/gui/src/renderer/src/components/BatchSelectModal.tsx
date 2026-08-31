// Batch selection (D19) and the §4.2 mapping onto the wire protocol.
//
// Two submit semantics share one dialog and must not be blurred together:
// every list group goes out as ONE `POST /download/batch`, which the daemon
// commits all-or-nothing; the "single items" group is then submitted one
// request at a time, best-effort, and stops at the first refusal.

import type {
  DownloadBatchGroupInput,
  DownloadNamingMode,
  DownloadPartData,
  FetchListRequest,
  ParsedItem,
} from '@lark/shared';
import { ApiError, VIRTUAL_ALL_PLAYLIST_ID, listSource } from '@lark/shared';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '../lib/errors.js';
import { isComposingKey } from '../lib/ime.js';
import { loadNamingMode, rememberNamingMode } from '../lib/naming-mode.js';
import { useDownloads } from '../stores/download.js';
import { useLibrary } from '../stores/library.js';
import { useMediaTools } from '../stores/media-tools.js';
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

/** `POST /download/batch` limits, enforced before the request (§4.2). */
const BATCH_ITEMS_MAX = 1000;
const BATCH_GROUPS_MAX = 20;

/**
 * A pasted line that turned out to be multi-part, once it has been expanded.
 *
 * `null` until the daemon says so — a line is classified offline, so nothing
 * here can know. §7.3-c: expanding every pasted link up front would put a
 * request behind each of twenty lines; the refusal costs nothing and only
 * happens to the lines that need it.
 */
interface ExpandedParts {
  title: string;
  list: readonly DownloadPartData[];
  /** Nothing is ticked when it opens (§7.3-d). */
  checked: readonly number[];
}

interface SingleItem {
  key: string;
  label: string;
  /** What `POST /download/song` receives verbatim. */
  input: string;
  /** Keywords are named by the model regardless, so the choice skips them. */
  isVideo: boolean;
  /** `null` for keywords — there is no video to list parts of. */
  bvid: string | null;
  parts: ExpandedParts | null;
  checked: boolean;
}

interface ListVideo {
  bvid: string;
  title: string;
  checked: boolean;
}

interface ListGroup {
  id: string;
  query: FetchListRequest;
  /** What it was picked out of, for the download record (④). */
  source: Extract<ParsedItem, { kind: 'favorites' | 'collection' }>;
  title: string;
  /**
   * Checked = keep the list's own titles; unchecked = let the model read a
   * song name out of them (§3.6-1). Until 0.3.0 both branches stored the same
   * string on a favourites folder, because the "fall back to the LLM" the
   * comment promised only ever existed for keyword searches.
   */
  useOriginalTitle: boolean;
  videos: readonly ListVideo[];
  loading: boolean;
  /** Partial-success warning, or the reason nothing could be fetched. */
  error: string | null;
}

function groupId(item: Extract<ParsedItem, { kind: 'favorites' | 'collection' }>): string {
  return item.kind === 'favorites'
    ? `favorites:${item.media_id}`
    : `collection:${item.mid}:${item.season_id}`;
}

function listQuery(
  item: Extract<ParsedItem, { kind: 'favorites' | 'collection' }>,
): FetchListRequest {
  return item.kind === 'favorites'
    ? { type: 'favorites', media_id: item.media_id }
    : { type: 'collection', mid: item.mid, season_id: item.season_id };
}

interface BatchSelectModalProps {
  items: readonly ParsedItem[];
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
        parts: null,
        checked: true,
      })),
  );
  const [groups, setGroups] = useState<readonly ListGroup[]>(() =>
    items
      .filter((item) => item.kind === 'favorites' || item.kind === 'collection')
      .map((item) => ({
        id: groupId(item),
        query: listQuery(item),
        source: item,
        title: item.kind === 'favorites' ? '收藏夹' : '合集',
        useOriginalTitle: initialNaming === 'original',
        videos: [],
        loading: true,
        error: null,
      })),
  );
  const [submitting, setSubmitting] = useState(false);
  const [confirmButton, setConfirmButton] = useState<HTMLButtonElement | null>(null);
  const focusedConfirm = useRef(false);
  const [editing, setEditing] = useState<string | null>(null);
  // One answer for every link item in this submission (§3.6-1). The list
  // groups keep their own, because a favourites folder and a pasted link are
  // not obviously the same decision.
  const [singlesNaming, setSinglesNaming] = useState<DownloadNamingMode>(initialNaming);

  // Expanding the lists is the one thing this dialog does on its own. `items`
  // is fixed for as long as the dialog is open, so this runs once per list.
  useEffect(() => {
    for (const item of items) {
      if (item.kind !== 'favorites' && item.kind !== 'collection') continue;
      const id = groupId(item);
      void fetchList(listQuery(item))
        .then((result) => {
          setGroups((prev) =>
            prev.map((candidate) =>
              candidate.id === id
                ? {
                    ...candidate,
                    title: result.title === '' ? candidate.title : result.title,
                    videos: result.videos.map((video) => ({
                      bvid: video.bvid,
                      title: video.title,
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
  }, [items, fetchList]);

  const patchGroup = (id: string, patch: Partial<ListGroup>): void =>
    setGroups((prev) => prev.map((group) => (group.id === id ? { ...group, ...patch } : group)));

  const toggleVideo = (id: string, bvid: string): void =>
    setGroups((prev) =>
      prev.map((group) =>
        group.id === id
          ? {
              ...group,
              videos: group.videos.map((video) =>
                video.bvid === bvid ? { ...video, checked: !video.checked } : video,
              ),
            }
          : group,
      ),
    );

  const toggleAll = (id: string, checked: boolean): void =>
    setGroups((prev) =>
      prev.map((group) =>
        group.id === id
          ? { ...group, videos: group.videos.map((video) => ({ ...video, checked })) }
          : group,
      ),
    );

  const patchParts = (key: string, checked: readonly number[]): void =>
    setSingles((prev) =>
      prev.map((item) =>
        item.key === key && item.parts !== null
          ? { ...item, parts: { ...item.parts, checked } }
          : item,
      ),
    );

  const togglePart = (key: string, page: number): void => {
    const current = singles.find((item) => item.key === key)?.parts;
    if (current === undefined || current === null) return;
    patchParts(
      key,
      current.checked.includes(page)
        ? current.checked.filter((p) => p !== page)
        : [...current.checked, page],
    );
  };

  const togglePartsAll = (key: string, all: boolean): void => {
    const current = singles.find((item) => item.key === key)?.parts;
    if (current === undefined || current === null) return;
    patchParts(key, all ? current.list.map((part) => part.page) : []);
  };

  // Zero-selection groups are filtered out entirely: the daemon requires every
  // group AND every item list to be non-empty (§4.2).
  const activeGroups = groups.filter((group) => group.videos.some((video) => video.checked));
  // An expanded line is no longer one submission: it is however many parts are
  // ticked, and it never goes back down the single-item path — sending the
  // whole link again would just be refused again (§7.3-c).
  const checkedSingles = singles.filter((item) => item.checked && item.parts === null);
  const expanded = singles.filter((item) => item.parts !== null && item.checked);
  const expandedItemCount = expanded.reduce(
    (sum, item) => sum + (item.parts?.checked.length ?? 0),
    0,
  );
  const groupItemCount =
    activeGroups.reduce(
      (sum, group) => sum + group.videos.filter((video) => video.checked).length,
      0,
    ) + expandedItemCount;
  const total = groupItemCount + checkedSingles.length;
  const loading = groups.some((group) => group.loading);

  // Only the list groups count against the batch endpoint's limits — the
  // single items go through `/download/song`, one request each.
  const overLimit =
    groupItemCount > BATCH_ITEMS_MAX
      ? `一次最多 ${BATCH_ITEMS_MAX} 个视频（当前 ${groupItemCount}），请分批提交`
      : activeGroups.length + expanded.length > BATCH_GROUPS_MAX
        ? `一次最多 ${BATCH_GROUPS_MAX} 个列表（当前 ${activeGroups.length + expanded.length}），请分批提交`
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

  /** One request, all-or-nothing: every list group rides in the same batch. */
  async function submitListGroups(): Promise<void> {
    if (activeGroups.length === 0 && expandedItemCount === 0) return;
    const payload: DownloadBatchGroupInput[] = activeGroups.map((group) => ({
      // Every list group creates its own playlist; the editable title is
      // exactly that name (§4.2) — and, since ④, the name the download record
      // says these songs came from.
      target: { kind: 'new', name: group.title },
      source: listSource(group.source, group.title),
      items: group.videos
        .filter((video) => video.checked)
        .map((video) => ({
          kind: 'video',
          bvid: video.bvid,
          page: null,
          // The list's title travels either way: `original` stores it as it
          // stands, `clean` is what the model reads the song name OUT of. It
          // is the better of the two titles in both cases — sending null on
          // the clean branch would hand the model the video's own title
          // instead, which is exactly what made the checkbox a no-op.
          title: video.title,
          naming: group.useOriginalTitle ? 'original' : 'clean',
        })),
    }));
    // An expanded line is a group of its own: the parts a person ticked, into
    // whatever playlist the library is showing. NO `source` — these came from a
    // pasted link, and inventing a list identity is a lie the download record
    // then repeats forever (0.5.0 ④).
    for (const item of expanded) {
      const picked = item.parts?.checked ?? [];
      if (picked.length === 0) continue;
      payload.push({
        target:
          playlistId === VIRTUAL_ALL_PLAYLIST_ID
            ? { kind: 'all' }
            : { kind: 'playlist', playlist_id: playlistId },
        items: picked.map((page) => ({
          kind: 'video',
          bvid: item.bvid ?? '',
          page,
          // `null`: the pipeline reads the part's own title out of the page
          // list it fetches anyway (§7.4). Two sources for one string drift.
          title: null,
          naming: singlesNaming,
        })),
      });
    }
    if (payload.length === 0) return;
    await submitBatch(payload);
    toast.success(`已提交 ${payload.length} 组，共 ${groupItemCount} 项`);
  }

  /**
   * List one line's parts and show them under it.
   *
   * The line stays checked and stays where it is: a person is picking parts of
   * something they already asked for, and moving it would lose their place in
   * a twenty-line paste.
   */
  async function expandInPlace(item: SingleItem): Promise<void> {
    if (item.bvid === null) return;
    try {
      const data = await fetchParts(item.bvid);
      setSingles((prev) =>
        prev.map((candidate) =>
          candidate.key === item.key
            ? { ...candidate, parts: { title: data.title, list: data.parts, checked: [] } }
            : candidate,
        ),
      );
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
  async function reportSingleFailure(item: SingleItem, err: unknown, done: number): Promise<void> {
    const multiPart = err instanceof ApiError && err.errorCode === 'MULTI_PART_UNRESOLVED';
    if (multiPart && item.bvid !== null) {
      await expandInPlace(item);
      toast.info(`「${item.label}」有多个分P，请选择要下载的分P`);
      return;
    }
    toast.error(`单项下载已提交 ${done}/${checkedSingles.length}：${errorMessage(err)}`);
  }

  /** One request per item, in order, stopping at the first refusal (§4.2). */
  async function submitSingles(): Promise<'done' | 'stopped'> {
    if (checkedSingles.length === 0) return 'done';
    const target = playlistId === VIRTUAL_ALL_PLAYLIST_ID ? undefined : playlistId;
    let done = 0;
    for (const item of checkedSingles) {
      try {
        await downloadSong(item.input, target, item.isVideo ? singlesNaming : undefined);
        done++;
      } catch (err) {
        // Either way the run stops here; what differs is what the person is
        // left looking at — an expanded line, or an error.
        await reportSingleFailure(item, err, done);
        return 'stopped';
      }
    }
    toast.success(`已提交 ${done} 个单项下载`);
    return 'done';
  }

  async function confirm(): Promise<void> {
    setSubmitting(true);
    rememberNamingMode(singlesNaming);
    try {
      await submitListGroups();
      await submitSingles();
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
        className="flex max-h-[80vh] flex-col sm:max-w-160"
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
              <ul className="max-h-40 overflow-y-auto p-2">
                {singles.map((item) => (
                  <li key={item.key} className="px-1 py-0.5 text-sm">
                    <div className="flex items-center gap-2">
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
                        {item.parts === null ? item.label : item.parts.title}
                      </label>
                    </div>
                    {item.parts !== null && (
                      // The same list the single-link picker draws — written
                      // once, on purpose (backlog C12).
                      <div className="mt-1 ml-6">
                        <PartsList
                          idPrefix={item.key}
                          parts={item.parts.list}
                          checked={item.parts.checked}
                          onToggle={(page) => togglePart(item.key, page)}
                          onToggleAll={(all) => togglePartsAll(item.key, all)}
                        />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {groups.map((group) => {
            const checkedCount = group.videos.filter((video) => video.checked).length;
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
                        ({checkedCount}/{group.videos.length})
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
                  {group.videos.length > 0 && (
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => toggleAll(group.id, checkedCount !== group.videos.length)}
                    >
                      {checkedCount === group.videos.length ? '全不选' : '全选'}
                    </Button>
                  )}
                </header>

                {group.error !== null && (
                  <p
                    className={`px-3 py-1.5 text-xs ${
                      group.videos.length > 0
                        ? 'text-amber-600 dark:text-amber-500'
                        : 'text-destructive'
                    }`}
                  >
                    {group.videos.length > 0
                      ? `${group.error}（已取回 ${group.videos.length} 条，可继续选择）`
                      : group.error}
                  </p>
                )}

                {group.loading ? (
                  <p className="px-3 py-3 text-muted-foreground text-xs">加载中…</p>
                ) : (
                  <ul className="max-h-56 overflow-y-auto p-2">
                    {group.videos.map((video) => (
                      <li key={video.bvid} className="flex items-center gap-2 px-1 py-0.5 text-sm">
                        <Checkbox
                          id={`${group.id}-${video.bvid}`}
                          checked={video.checked}
                          onCheckedChange={() => toggleVideo(group.id, video.bvid)}
                        />
                        <label htmlFor={`${group.id}-${video.bvid}`} className="truncate">
                          {video.title}
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
