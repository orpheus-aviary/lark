// Playlist picker, optional-column toggles and search (D10/D3/D6).
//
// The picker is a Popover rather than a DropdownMenu on purpose: renaming and
// creating happen INSIDE it through text inputs, and a menu's typeahead and
// arrow-key handling fight an input for every keystroke.

import type { PlaylistData, PlaylistExportData } from '@lark/shared';
import { VIRTUAL_ALL_PLAYLIST_ID, apiPath, request } from '@lark/shared';
import { ChevronDown, Download, Pencil, Plus, Search, Trash2, Upload, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '../lib/errors.js';
import { getPlatform } from '../platform/index.js';
import { useLibrary } from '../stores/library.js';
import { usePlaylists } from '../stores/playlists.js';
import { OPTIONAL_COLUMNS, type OptionalColumn, useViewPrefs } from '../stores/view-prefs.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { ImportPlaylistDialog } from './ImportPlaylistDialog.js';
import { SettingsDialog } from './SettingsDialog.js';
import { Button } from './ui/button.js';
import { Checkbox } from './ui/checkbox.js';
import { Input } from './ui/input.js';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.js';

/** Long enough that typing a word is one query, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 200;

const COLUMN_LABELS: Record<OptionalColumn, string> = {
  duration: '时长',
  fileSize: '大小',
  createdAt: '创建时间',
};

type Draft = { mode: 'create' } | { mode: 'rename'; id: string };

export function TopBar(): React.JSX.Element {
  const playlists = usePlaylists((s) => s.playlists);
  const createPlaylist = usePlaylists((s) => s.create);
  const renamePlaylist = usePlaylists((s) => s.rename);
  const removePlaylist = usePlaylists((s) => s.remove);
  const playlistId = useLibrary((s) => s.playlistId);
  const setPlaylistId = useLibrary((s) => s.setPlaylistId);
  const setSearch = useLibrary((s) => s.setSearch);
  const storeSearch = useLibrary((s) => s.search);
  const columns = useViewPrefs((s) => s.columns);
  const toggleColumn = useViewPrefs((s) => s.toggleColumn);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftName, setDraftName] = useState('');
  const [pendingDelete, setPendingDelete] = useState<PlaylistData | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const draftRef = useRef<HTMLInputElement>(null);
  const committed = useRef('');

  // Debounce the committed search term; the store refetches on every commit.
  useEffect(() => {
    const timer = setTimeout(() => {
      committed.current = searchInput.trim();
      setSearch(committed.current);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput, setSearch]);

  // A remote `switch-playlist` clears the search in the store (§4.3); without
  // this the box would still show the old term and re-commit it on the next
  // keystroke.
  useEffect(() => {
    if (storeSearch === committed.current) return;
    committed.current = storeSearch;
    setSearchInput(storeSearch);
  }, [storeSearch]);

  useEffect(() => {
    if (draft) draftRef.current?.focus();
  }, [draft]);

  const current = playlists.find((p) => p.id === playlistId);

  function startDraft(next: Draft, name: string): void {
    setDraft(next);
    setDraftName(name);
  }

  async function commitDraft(): Promise<void> {
    const pending = draft;
    const name = draftName.trim();
    // Cleared first so the input's blur cannot commit the same edit twice.
    setDraft(null);
    setDraftName('');
    if (!pending || name === '') return;
    try {
      if (pending.mode === 'create') await createPlaylist(name);
      else await renamePlaylist(pending.id, name);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  function cancelDraft(): void {
    setDraft(null);
    setDraftName('');
  }

  /**
   * Fetch the playlist as a file and hand it to the native save dialog. The
   * daemon answers a normal envelope (M5-12) — the renderer is what turns it
   * into the two-space-indented JSON that lands on disk.
   */
  async function exportPlaylist(playlist: PlaylistData): Promise<void> {
    setPickerOpen(false);
    try {
      const envelope = await request<PlaylistExportData>(
        'GET',
        apiPath.playlistExport(playlist.id),
      );
      if (envelope.data === undefined) throw new Error('导出返回为空');
      const saved = await getPlatform().saveExportFile({
        default_name: `${playlist.name}.lark-playlist.json`,
        content: JSON.stringify(envelope.data, null, 2),
      });
      if (saved) toast.success(`已导出「${playlist.name}」（${envelope.data.songs.length} 首）`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function confirmDelete(): Promise<void> {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!target) return;
    try {
      await removePlaylist(target.id);
      toast.success(`已删除歌单：${target.name}`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const draftInput = (placeholder: string): React.JSX.Element => (
    <input
      ref={draftRef}
      className="w-full border-primary border-b bg-transparent px-3 py-1.5 text-sm outline-none"
      placeholder={placeholder}
      value={draftName}
      onChange={(e) => setDraftName(e.target.value)}
      onBlur={() => void commitDraft()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void commitDraft();
        else if (e.key === 'Escape') cancelDraft();
      }}
    />
  );

  return (
    <div className="flex items-center gap-3 border-b px-3 py-2">
      {/* Top left, before the playlist picker (M5-1). */}
      <SettingsDialog />
      <Popover
        open={pickerOpen}
        onOpenChange={(open) => {
          setPickerOpen(open);
          if (!open) cancelDraft();
        }}
      >
        <PopoverTrigger asChild>
          <Button variant="secondary" size="sm" aria-label="选择歌单">
            <span className="max-w-30 truncate">{current?.name ?? VIRTUAL_ALL_PLAYLIST_ID}</span>
            <ChevronDown className="size-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-60 p-0">
          <ul className="max-h-80 overflow-y-auto py-1">
            {playlists.map((playlist) => (
              <li
                key={playlist.id}
                className={`group flex items-center hover:bg-accent ${
                  playlist.id === playlistId ? 'bg-accent' : ''
                }`}
              >
                {draft?.mode === 'rename' && draft.id === playlist.id ? (
                  draftInput('歌单名称…')
                ) : (
                  <>
                    <button
                      type="button"
                      className="flex-1 truncate px-3 py-1.5 text-left text-sm"
                      onClick={() => {
                        setPlaylistId(playlist.id);
                        setPickerOpen(false);
                      }}
                    >
                      {playlist.name}
                      <span className="ml-1 text-muted-foreground">
                        ({playlist.song_count ?? 0})
                      </span>
                    </button>
                    <span className="flex items-center gap-0.5 pr-1 opacity-0 group-hover:opacity-100">
                      {/* Export works on `all` too — it is the whole library. */}
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`导出 ${playlist.name}`}
                        onClick={() => void exportPlaylist(playlist)}
                      >
                        <Download />
                      </Button>
                      {playlist.id !== VIRTUAL_ALL_PLAYLIST_ID && (
                        <>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={`重命名 ${playlist.name}`}
                            onClick={() =>
                              startDraft({ mode: 'rename', id: playlist.id }, playlist.name)
                            }
                          >
                            <Pencil />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            className="text-destructive"
                            aria-label={`删除 ${playlist.name}`}
                            onClick={() => {
                              setPickerOpen(false);
                              setPendingDelete(playlist);
                            }}
                          >
                            <Trash2 />
                          </Button>
                        </>
                      )}
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
          <div className="border-t">
            {draft?.mode === 'create' ? (
              draftInput('新歌单名称…')
            ) : (
              <button
                type="button"
                className="flex w-full items-center gap-1 px-3 py-1.5 text-left text-sm hover:bg-accent"
                onClick={() => startDraft({ mode: 'create' }, '')}
              >
                <Plus className="size-3.5" />
                新建歌单
              </button>
            )}
            <button
              type="button"
              className="flex w-full items-center gap-1 px-3 py-1.5 text-left text-sm hover:bg-accent"
              onClick={() => {
                setPickerOpen(false);
                setImportOpen(true);
              }}
            >
              <Upload className="size-3.5" />
              导入歌单…
            </button>
          </div>
        </PopoverContent>
      </Popover>

      <div className="flex items-center gap-3 text-muted-foreground text-xs">
        <span>信息：</span>
        {OPTIONAL_COLUMNS.map((column) => (
          <label
            key={column}
            htmlFor={`column-${column}`}
            className="flex cursor-pointer items-center gap-1.5"
          >
            <Checkbox
              id={`column-${column}`}
              checked={columns[column]}
              onCheckedChange={() => toggleColumn(column)}
            />
            {COLUMN_LABELS[column]}
          </label>
        ))}
      </div>

      <div className="flex-1" />

      <div className="relative w-64">
        <Search className="-translate-y-1/2 absolute top-1/2 left-2 size-4 text-muted-foreground" />
        <Input
          type="search"
          aria-label="搜索歌曲或歌手"
          placeholder="搜索歌曲或歌手…"
          className="h-8 pr-8 pl-8"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
        {searchInput !== '' && (
          <button
            type="button"
            aria-label="清除搜索"
            className="-translate-y-1/2 absolute top-1/2 right-2 text-muted-foreground hover:text-foreground"
            onClick={() => setSearchInput('')}
          >
            <X className="size-4" />
          </button>
        )}
      </div>

      <ImportPlaylistDialog open={importOpen} onClose={() => setImportOpen(false)} />

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除歌单"
        description={`确定删除歌单「${pendingDelete?.name ?? ''}」吗？歌单里的歌曲会保留在曲库中。`}
        confirmLabel="删除"
        destructive
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
