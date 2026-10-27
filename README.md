# background-sessions

A small pane for background Claude Code sessions, grouped by working folder. See which sessions need you, are working, encountered an error, or have closed. Usage and model appear only for sessions running this plugin; other sessions show `-`.

```text
● yellow your turn · ● green working · ● red error/ctx≥80% · ● blue closed
─ Alpha
● Alpha  build      ! YOU  26%  today 10:00  1m  sonnet
● Alpha  review     ▶       -  today 10:05  now -
─ Beta
● Beta   cleanup    ✓       -  today 09:00  1h  -
```

## Install

```text
/plugin marketplace add ArielSoothy/background-sessions
/plugin install background-sessions@background-sessions
```

For a local checkout, launch Claude Code with the absolute plugin path:

```sh
CLAUDE_CODE_PLUGIN_DIRS=/absolute/path/to/background-sessions claude
```

## Requirements and usage

Claude Code with support for mods, the session/usage APIs, panes, and the built-in `/rename` and `/color` commands is required. Development references use Claude Code 2.1.311; an exact minimum engine version has not been established. Install Python 3.9 or newer separately and make `python3` available on PATH. No extra Python packages are required. On macOS, python3 needs the Command Line Tools (`xcode-select --install`). macOS and Linux use the same metadata collector.

Run `/sessions` to open or close the pane. A visible pane refreshes every twenty seconds; session startup and main-turn completion also refresh it. Missing background jobs produce `No background sessions.`. Missing or malformed metadata is skipped. An unreadable jobs directory or helper failure shows one diagnostic line. After a helper failure, collection and record writes back off for ten minutes. The helper runs only in interactive sessions; print/headless sessions are skipped.

Colours describe session state: yellow needs your input, green is working, red means an error or context usage of at least 80%, and blue is closed. A completed reply (`done` in host metadata) means your turn; a stopped job or plugin close marker means closed.

Automatic renaming is **on by default**: the plugin puts the project short name (or folder name) into its own session title through `/rename`, as `<Short> · <existing name>`. Set `BACKGROUND_SESSIONS_NO_RENAME=1` or create `<Claude root>/background-sessions/no-rename` to disable all automatic renaming, including done suffix changes. A manual `/rename` also disables all subsequent automatic renaming for that session, including adding or removing the done suffix. A manual `/color` disables automatic status colours during normal updates.

`/done` marks this session closed in the pane and requests blue plus a ` · done` suffix through the built-in commands. A fresh process startup clears its own close marker and removes the suffix only when its marker records that the plugin added the exact current title and automatic renaming is still enabled. A hook reload preserves the marker. During a turn, normal host colour changes wait until the session is idle. Other sessions' names and colours are never changed.

## Settings

The Claude root is `$CLAUDE_CONFIG_DIR` when set, otherwise `$HOME/.claude`. `~/` in that variable expands using HOME. An absolute CLAUDE_CONFIG_DIR works without HOME; HOME is needed for the default root and to expand `~`. A relative configuration root disables file features. The configured root must already exist: the helper creates only its own data subfolder, never a missing Claude configuration tree.

The plugin data folder is `<Claude root>/background-sessions/`. Create `projects.json` there if you want custom grouping:

```json
{
  "roots": ["~/Projects/alpha", "~/Projects/alpha/tools", "~/code/beta"],
  "catalog": "~/Projects/catalog.json",
  "projects": {
    "alpha": {"title": "Alpha", "short": "Alpha"},
    "tools": {"title": "Alpha tools", "short": "Tools"},
    "beta": {"title": "Beta", "short": "Beta"}
  },
  "merge": {"alpha-copy*": "alpha"}
}
```

All fields are optional. `roots` is a list of project folder paths, with `~` expanded from HOME. The longest matching folder prefix of the job's `cwd` (or `originCwd` when cwd is unavailable) wins; matches respect folder boundaries and also compare resolved realpaths. Root basenames are project ids. `projects` overrides titles and short labels by id. `merge` groups an exact id or a `*` pattern under another id; cyclic merges are ignored.

When roots are omitted, discovery lists existing direct child folders of `~/Projects`, `~/code`, `~/src`, `~/dev`, and `~/repos`. For unmatched cwd paths, the collector walks upward for a `.git` entry without running Git, stopping at the user’s home directory (never above it), then uses that folder name; if none exists it uses the cwd basename. It never searches conversation content or infers a project from a session title.

`catalog` is an optional JSON file, read only when configured. Missing catalogs are silent. It accepts a list of records or `{"projects": [...]}`, each with `id`, optional `display_title`, and `location` as a path or `{"local_path": "..."}`. Those paths participate in the same longest-prefix matching. Files must be regular JSON files of at most 1 MiB, with no symbolic links below their trusted directory anchor. The Claude configuration, jobs and plugin data roots are resolved once per operation to support symlinked roots; traversal below those resolved roots refuses symlinks. Malformed settings fall back to defaults.

| Variable or empty file in the data folder | Effect |
| --- | --- |
| `BACKGROUND_SESSIONS_READ_ONLY=1` | Disable plugin file writes, pruning, persistent store changes and automatic host commands. The pane still works. |
| `BACKGROUND_SESSIONS_NO_COLOR=1` or `no-color` | Disable automatic `/color`, including `/done` colours. The environment switch also disables standalone helper table colours. |
| `BACKGROUND_SESSIONS_NO_RENAME=1` or `no-rename` | Disable automatic `/rename`, including the done suffix. |
| `BACKGROUND_SESSIONS_NO_DONE=1` or `no-done` | Disable close markers and `/done` effects. |

The helper's `--read-only` flag also disables pruning and record writes before any mutation. Manual commands typed by the person still execute in read-only mode. Pane snapshots remain in transient plugin state.

## What the hook does and changes

The hook module is `hooks/register.tsx`. It registers `/sessions` and `/done`, renders the pane, refreshes metadata on startup and main-turn completion, and polls only while a pane is visible. Turn-start handling tracks an active flag; turn-completion handling tracks whether an error occurred. Neither reads turn text.

The helper opens and parses each job’s `state.json` in memory. It uses exactly `sessionId`, `cwd`, `originCwd`, `state`, `name`, `color`, `createdAt`, `updatedAt`, `lastTerminalAt`, and `inFlight.tasks`. Every other field (which can include the job’s prompt/intent and status detail) is discarded immediately after parsing, never stored or sent. It does not open conversation transcripts or capture turn replies. It queries its own session through `$.session.usage()` and `$.session.model()` and writes numeric usage figures plus a model identifier to `usage/<session-id>.json`. It reads plugin-owned close markers and usage reports for other participating sessions.

It changes its own session's name and colour only through built-in commands. It writes close markers, usage reports, and per-session name/colour ownership records in plugin storage. Startup reopens its own close marker. Session exit writes only a close marker. Stopped jobs from other sessions appear closed only in the pane. Cleanup removes usage/done files and per-session store keys for jobs that no longer exist; the running foreground session's usage/done records and store keys are retained. Cleanup also removes stray `*.tmp` files in the plugin’s data folders. Read-only mode disables this cleanup.

## Commands the mod runs

The mod runs `/rename` and `/color` only on its own session. Startup and idle refreshes prefix the existing title with the project short name and update the status colour. `/done` requests blue and a ` · done` suffix; fresh startup removes that suffix only when an exact owned marker matches the current title.

`BACKGROUND_SESSIONS_READ_ONLY=1` disables automatic commands. `BACKGROUND_SESSIONS_NO_RENAME=1` or `no-rename` disables every automatic rename; a manual `/rename` also disables further automatic renaming for that session. `BACKGROUND_SESSIONS_NO_COLOR=1` or `no-color` disables automatic colours; a manual `/color` disables normal automatic colour updates. `BACKGROUND_SESSIONS_NO_DONE=1` or `no-done` disables close effects. The mod registers `/sessions` to toggle the pane and `/done` to mark its own session closed.

## Programs the hook runs, and why

Every `$.process.run` call uses one of the following argv templates. There is no shell, Git invocation, package install, or other child program.

| Exact argv template | Why |
| --- | --- |
| `['python3', '<plugin root>/bin/sessions', '--json', '--own-session', '<session id>']` | Collect bounded local metadata and prune obsolete plugin usage/done files. |
| `['python3', '<plugin root>/bin/sessions', '--json', '--own-session', '<session id>', '--read-only']` | Collect the same metadata with all helper mutations disabled. |
| `['python3', '<plugin root>/bin/sessions', '--write-record', 'usage', '<session id>', '<JSON>']` | Atomically write this session's numeric usage and model identifier under plugin storage. |
| `['python3', '<plugin root>/bin/sessions', '--read-marker', '<session id>']` | Read this session’s own done marker to check suffix ownership before clearing it. |
| `['python3', '<plugin root>/bin/sessions', '--write-record', 'done', '<session id>', '<JSON>']` | Atomically write or clear this session's own close marker. Clearing an absent marker creates no file. |

`<plugin root>` is `$.plugin.root`; `<session id>` comes from `$.session.id()`. Usage JSON contains only `sessionId`, `model`, `contextUsed`, `window`, `percent` and `at`. Done JSON contains `at` and either a fixed `reason` (`done-command` or `session-end`) or `cleared: true`; a marker may also contain `suffixName`, the exact title with the suffix the plugin added. The JSON is one argv element, never shell text. Python validates the schema, writes only `usage` or `done` files under the plugin folder, and refuses links while traversing directories. Calls have a five-second timeout. Missing Python disables helper collection and record writes for ten minutes and shows a pane diagnostic.

## What the hook sends, and where

The only environment variables the hook and helper read are `HOME`, `CLAUDE_CONFIG_DIR`, and the `BACKGROUND_SESSIONS_*` switches listed above. None are sent anywhere. Standalone table width comes from the terminal (or defaults to 160 columns), with `--width` as an explicit override. The helper inherits the local process environment; no environment values are copied into argv or reports.

The plugin sends nothing over the network and makes no model calls. `/rename` and `/color` requests go only to the current session's built-in command handlers. Usage reports and done markers go under the plugin data folder. Persistent plugin store records hold prefix/colour ownership; transient plugin state holds the current board and startup flag. There is no message-context injection.

## Privacy

The plugin does not open conversation transcripts or capture turn replies, and never edits Claude Code’s own session files directly. It parses whole job state files as disclosed above and retains only the listed fields. Existing host session names appear locally in the pane and may be stored as `lastSet` in prefix-ownership records or as `suffixName` in done markers. These names may come from Claude Code’s own auto-generated name, which can be derived from the conversation. See [PRIVACY.md](PRIVACY.md) for retention and deletion.

## Developing

The `.claude-plugin/types/` declarations are generated by Anthropic's Claude Code engine and ignored here. Type checking requires these declarations to be generated first with the command below; runtime does not require these files. `tsconfig.json` intentionally extends the generated engine configuration. Root `types/index.d.ts` is project-owned and contains the plugin state contract. TypeScript 5.4 or newer is needed for type checking. The Claude Code 2.1.311 engine test runner can also run without the generated declarations.

Replace the example path with your absolute checkout location and regenerate declarations with this command:

```sh
CLAUDE_CODE_PLUGIN_DIR_WATCH=1 CLAUDE_CODE_PLUGIN_DIRS=/absolute/path/to/background-sessions claude --print /help --no-session-persistence
```

On Claude Code 2.1.311, a message that `/help` is unavailable after loading is expected; the declarations are still generated. This uses a version-dependent watch switch. Redistribution permission for generated declarations has not been verified.

Run the checks from `/absolute/path/to/background-sessions`:

```sh
claude plugin validate --profile directory --strict .
claude plugin test .
python3 -I -m unittest discover -s tests -p '*test.py'
bunx --no-install tsc --noEmit -p .
```

Tests use synthetic fixtures, temporary folders and intercepted hook effects. They never run the helper against the real Claude directory. Do not use live session files for testing. No dependency installation is part of the test commands; the compiler must already be installed for the last check.

## Support

Report problems through [GitHub issues](https://github.com/ArielSoothy/background-sessions/issues). Remove private paths and session names from reports before posting.

## License

MIT — Copyright (c) 2026 Ariel Soothy. See [LICENSE](LICENSE).
