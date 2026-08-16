// The document `lark skill export` writes (M6-14).
//
// It is a SKILL for an agent, not a manual for a person: what an agent needs
// is the trigger phrases, the exact output contract, the exit codes it can
// branch on, and the handful of rules that make lark refuse — confirmations,
// ambiguous names, and the daemon's monopoly on downloads and playback.
//
// The contract below is enforced by `skill.test.ts`, and one of its clauses is
// a coupling test: every command word registered in `index.ts` has to appear
// somewhere in this text, so a command added to the CLI cannot quietly go
// undocumented.
//
// Contract:
//   1. starts with YAML frontmatter, `name: lark`
//   2. a substantive `description:` (>80 chars) carrying trigger phrases
//   3. the injected version appears in the body
//   4. every command word from the registry appears
//   5. the exit-code table covers all seven values
//   6. it documents the ENVELOPE (`success` / `error_code`) — lark's `--json`
//      contract, and the one thing an agent must not have to guess

export interface SkillTemplateParams {
  version: string;
}

export function renderSkillTemplate({ version }: SkillTemplateParams): string {
  return `---
name: lark
description: Use when the user wants to download, organise, play or inspect music managed by lark (百灵音乐). Trigger for "下载这首歌"/"把这个 B 站链接下下来"、"放首歌"/"暂停"/"下一首"、"加到歌单"/"新建歌单"、"现在在放什么"、"重新下歌词"、"清理缓存", a bilibili video / favourites / collection link pasted with intent to save it, or an explicit "用 lark". This skill wraps the \`lark\` CLI (commander-based; pass --json for machine-readable envelopes). Skip for other music players and for pure shell tasks.
---

# lark — music CLI for agents

lark (version ${version}) is the command line for 百灵音乐. A local daemon owns
the library, the download queue and the link to the GUI player; the CLI talks
to it over \`http://127.0.0.1:47100\`. Read-only commands also work with no
daemon at all (\`--direct\` opens the SQLite library in-process, read-only).

Data lives in \`~/orpheus-aviary-nest/lark/\` — override with \`LARK_NEST_DIR\`.

## Invocation

Run through the Bash tool: \`lark <command> [flags]\` — for example
\`lark songs list --json\`. Install it with
\`npm i -g @orpheus-aviary/lark-cli\` if it is not on PATH.

Inside the lark repository the same commands are \`just cli <command> [flags]\`,
which runs the working copy rather than the installed one.

### Output contract

Pass \`--json\` for anything you intend to parse. Then:

- **exit 0** ⇔ stdout holds EXACTLY ONE success envelope and stderr is empty:
  \`{"success": true, "data": ..., "message": "...", "total": N}\`
  (\`message\` and \`total\` appear only where they mean something)
- **exit ≠ 0** ⇔ stdout is EMPTY and stderr holds one error envelope:
  \`{"success": false, "error_code": "NOT_FOUND", "message": "...", "details": {...}}\`

So \`lark … --json && jq …\` is safe: if it exited 0, stdout parses.

Without \`--json\` the output is human text with no stability promise — do not
parse it. \`--help\` and \`--version\` are plain text at exit 0.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | It worked |
| 1 | The operation failed (\`NOT_FOUND\`, \`TASK_FAILED\`, \`GUI_ERROR\`, \`HTTP_ERROR\`) |
| 2 | The command was wrong — arguments, ids, file contents (\`USAGE_ERROR\`, \`INVALID_ID\`); retrying it unchanged cannot help |
| 3 | The environment says no (\`UNAUTHORIZED\`, \`LLM_NOT_CONFIGURED\`, \`DB_NOT_INITIALIZED\`, \`ABI_MISMATCH\`) |
| 4 | Nothing is listening — start a daemon, or pass \`--direct\` for a read (\`DAEMON_UNAVAILABLE\`, \`GUI_OFFLINE\`) |
| 5 | Something IS there and refuses (\`DAEMON_RUNNING_BLOCKED\`, \`WRITER_BUSY\`, \`AMBIGUOUS_SONG\`, \`SOURCE_KEY_CONFLICT\`) |
| 130 | Interrupted, or a confirmation answered "no" |

### Global flags

- \`--json\` — the contract above
- \`--yes\` — assume yes for confirmations. **Required** outside a TTY and
  ALWAYS required in \`--json\` mode; without it a destructive command exits 2
- \`--direct\` — open the library in this process instead of asking the daemon.
  Reads always work; a WRITE is allowed only when no daemon is running, and is
  refused with \`DAEMON_RUNNING_BLOCKED\` (5) when one is. Download, playback,
  link recognition and daemon management never accept it

## Commands

### lark status

Is OUR daemon running? \`current\` is the only success; every other state
(nothing there, another data directory, an incompatible version, something
unidentifiable) is a non-zero exit with the diagnosis in \`details.identity\`.

### lark daemon / lark stop-daemon

Start or stop the daemon. Both are idempotent: starting a running one reports
\`{"started": false, "pid": N}\` at exit 0, stopping a stopped one reports
\`{"stopped": false, "pid": null}\`. Stopping proves the target is ours before
it signals anything.

### lark download [input]

Download a bilibili link or a search keyword.

\`\`\`bash
lark download "https://www.bilibili.com/video/BV1xx411c7mD"
lark download "周杰伦 晴天" --playlist 深夜
lark download --batch links.txt --yes --wait
echo "BV1xx411c7mD" | lark download --batch - --yes
\`\`\`

- one input → one task, FOLLOWED to its end by default (\`--no-wait\` to return
  as soon as it is queued)
- a favourites / collection link → expanded, summarised, then confirmed
  (\`--yes\`) before anything is queued
- \`--batch <file|->\` → one input per line, \`#\` comments and blank lines
  skipped; the batch does NOT wait unless \`--wait\` is passed
- \`--playlist <name|id>\` puts everything into that playlist
- \`--allow-partial\` accepts a favourites / collection list that only came
  back partially; it is a usage error on any other shape
- \`--clean-name\` names videos with the LLM (song + artist read out of the
  title) instead of keeping the title verbatim; it is a video-only flag, and
  the same video cannot be queued under both namings at once
  (\`NAMING_MODE_CONFLICT\`, exit 2)
- a keyword needs an LLM configured (\`LLM_NOT_CONFIGURED\`, exit 3), and so
  does \`--clean-name\`; a plain bilibili link does not

A finished task prints its full snapshot; a failed one exits 1 with
\`error_code: "TASK_FAILED"\` and the task in \`details.task\`.

### lark songs list / search / get

\`\`\`bash
lark songs list --json --limit 20 --sort created_at --order desc
lark songs search 晴天 --json
lark songs get 晴天 --json
\`\`\`

\`search <keyword>\` is shorthand for \`list --search\`. \`<name|id>\` accepts a
UUID or an exact name; several songs with that name exit 5 (\`AMBIGUOUS_SONG\`)
and list the candidates in \`details.candidates\` — pick one by id, never assume.

### lark songs edit / delete / pin / unpin / redownload

\`\`\`bash
lark songs edit 晴天 --name 晴天 --artist 周杰伦 --lyrics-offset -0.5
lark songs delete 晴天 --yes
lark songs pin 晴天        # protect it from cache eviction
lark songs redownload 晴天 # fetch the audio again
\`\`\`

\`edit\` covers local fields only. \`delete\` asks first, then removes the audio
and the lyrics for good — there is no trash to recover them from.

### lark songs url get / set / recognize

The source link a song can be re-downloaded from.

\`\`\`bash
lark songs url get 晴天 --json
lark songs url set 晴天 "https://www.bilibili.com/video/BV1xx411c7mD"
lark songs url set 晴天 ""            # clear it
lark songs url recognize 晴天 --save  # preview, then store
\`\`\`

\`recognize\` writes nothing without \`--save\`. A key already owned by another
song exits 5 (\`SOURCE_KEY_CONFLICT\`, with \`details.conflicting_song_id\`).

### lark playlist …

\`\`\`bash
lark playlist list --json
lark playlist songs 深夜 --json         # "all" = the whole library
lark playlist create 深夜
lark playlist rename 深夜 深夜电台
lark playlist delete 深夜 --yes         # keeps the songs
lark playlist add 深夜 晴天 稻香
lark playlist remove 深夜 晴天
lark playlist reorder 深夜 晴天 --before 稻香
lark playlist export 深夜 -o ~/backup/
lark playlist import ~/backup/深夜.lark-playlist.json --yes
\`\`\`

\`export\` needs \`-o\` (a file, or a directory to drop the default name into).
\`import\` previews the file, then commits it; \`--to <playlist>\` merges into an
existing one, \`--new <name>\` names a new one, and the default is a new
playlist named after the file.

### lark play / pause / resume / next / prev / seek / mode / now-playing

Playback happens in the GUI; these ask the daemon to forward a command and
wait for the GUI's acknowledgement.

\`\`\`bash
lark play 晴天
lark play --playlist 深夜
lark play 晴天 --playlist 深夜   # start that playlist HERE
lark seek 90
lark mode shuffle               # sequential | repeat-one | repeat-all | shuffle
lark now-playing --json
\`\`\`

\`play\` starts a daemon and a GUI if there is none; \`--no-launch\` makes it
report (exit 4) instead. The others never start anything: with no GUI they
exit 4 (\`GUI_OFFLINE\`). \`now-playing\` is a pure read.

### lark lyrics redownload / delete

\`\`\`bash
lark lyrics redownload 晴天
lark lyrics delete 晴天 --yes
\`\`\`

### lark cache status / evict

\`\`\`bash
lark cache status --json
lark cache evict --yes
\`\`\`

Eviction deletes least-recently-used DOWNLOADED audio only. Imported files and
pinned songs are never touched, and a file whose source cannot be confirmed
re-downloadable is kept.

### lark sync status / login / logout / run

\`\`\`bash
lark sync status --json
lark sync login --server https://sync.example.com --email me@example.com --password-stdin < pw.txt
lark sync run --json
lark sync logout
\`\`\`

Synchronises song / playlist metadata and lyrics with a skybridge server; audio
files are NOT uploaded (other devices re-download them from the source link).
The password is never a flag: it is typed at a muted prompt, or piped in with
\`--password-stdin\`. A plaintext \`http://\` server needs
\`--allow-insecure-http\` AND a confirmation (\`--yes\` in \`--json\` mode).

\`status\` is the one to read first: \`state\` is \`idle\` / \`syncing\` /
\`error\` / \`offline\` / \`auth_required\`, and \`auth_reason\` says why the
last one. Conflicts are resolved in the GUI, not here.

### lark sync file-ops

\`\`\`bash
lark sync file-ops --json                # what sync still owes the filesystem
lark sync file-ops --retry               # retry every row that gave up
lark sync file-ops --discard 7 --yes     # abandon one, permanently
\`\`\`

A sync can owe the filesystem a deletion, a quarantine or a lyrics write; a row
that failed five times stops retrying and waits for a person. \`--discard\`
means the file change will NEVER happen — ask the user before using it.

### lark sync config-show / unbind

\`\`\`bash
lark sync config-show --json   # server, account, device — never the token
lark sync unbind --yes         # detach this library from its workspace
\`\`\`

\`config-show\` reads the credential file directly, so it works when there is
no daemon; \`has_token\` is a boolean and the token itself is never printed.

\`unbind\` needs the library to itself: stop the daemon first (exit 5 says so).
It clears the outbox, the tombstones and the binding — unpushed DELETIONS
cannot be republished afterwards, so it refuses while any exist unless
\`--force\` is added, and it names the count before asking.

### lark songs list --duplicates

\`\`\`bash
lark songs list --duplicates --json
\`\`\`

When two devices add the same video while offline, sync keeps BOTH rather than
guessing which to merge. This lists every song sharing a \`(provider, key)\`
with another; deleting the extra one is the fix. It scans the whole library, so
it cannot be combined with \`--search\` / \`--limit\` / \`--offset\`.

### lark gui

Open the lark window (starting a daemon first if there is none). Already open
is a success with \`{"launched": false}\`.

### lark skill export

Rewrite this document. \`--output <path>\` overrides the default location
(\`~/orpheus-aviary-nest/lark/lark-skill.md\`).

## Patterns worth knowing

- **Get ids to work with**: \`lark songs list --json | jq -r '.data[].id'\`
- **Download then confirm**: a single download already waits, so exit 0 means
  the file is on disk
- **Batch a file of links**: \`lark download --batch links.txt --yes --wait\`
- **Check before playing**: \`lark now-playing --json | jq .data.gui_online\`
- **Work without a daemon**: any read plus \`--direct\`, e.g.
  \`lark songs list --direct --json\`
- **Is sync healthy?**: \`lark sync status --json | jq '.data.state'\`, then
  \`.data.file_op_failures\` and \`.data.duplicate_source_keys\` for the two
  things only a person can clear

## Rules for the agent

- Anything destructive (\`songs delete\`, \`playlist delete\`, \`lyrics delete\`,
  \`cache evict\`, \`sync file-ops --discard\`, \`sync unbind\`, a batch
  download) needs \`--yes\` — in \`--json\` mode ALWAYS,
  because lark refuses to prompt into a stream somebody is parsing
- Never guess between candidates on \`AMBIGUOUS_SONG\` / \`AMBIGUOUS_PLAYLIST\`:
  the ids are in \`details.candidates\`; ask the user which one
- Exit 4 means "start something" (\`lark daemon\`, \`lark gui\`), exit 5 means
  "something is already there and it refuses" — those are different fixes
- Do not try to import lark as a module; it is a CLI
`;
}
