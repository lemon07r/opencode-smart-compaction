# opencode-smart-compaction

Smart Compaction for [OpenCode](https://opencode.ai). When OpenCode compacts a long session, this plugin replaces the summary prompt with a structured six-section checkpoint, keeps opaque identifiers the summary must not lose, and appends the exact file and worktree state after the model finishes writing.

It is the OpenCode counterpart of the Smart Compaction extension in [shariq-pi-extensions](https://github.com/shariqriazz/shariq-pi-extensions) and produces the same checkpoint format.

## What a checkpoint contains

The compaction model writes six sections:

1. Primary goal and constraints, including every "never do X" rule the user stated.
2. Progress ledger: done, in progress (with batch counts), and blocked.
3. Code changes with verbatim snippets of in-flight work.
4. Errors, root causes, and fixes.
5. Key decisions and discarded approaches.
6. Resume anchor and the next concrete step.

After the model finishes, the plugin adds two things the model doesn't write itself:

- **Retained identifiers.** Commit SHAs, UUIDs, URLs, and IPv4 addresses found in your messages or the previous checkpoint are protected. Any the summary dropped are appended verbatim under `### Retained Identifiers`.
- **File and worktree state.** Files the session read or changed through tools, the files git reports as dirty, lockfile and generated-asset changes, and a bounded diff of uncommitted work, including previews of untracked files. Untracked symlinks are never followed.

On the next compaction, the previous checkpoint goes back to the model as `<previous-summary>` and is merged with the new turns. The appended state is regenerated each time rather than carried forward.

## Install

Add the package to the `plugin` list in `~/.config/opencode/opencode.json` (or a project's `opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-smart-compaction"]
}
```

OpenCode installs the package the next time it starts. The plugin targets the OpenCode 1 plugin API (`opencode-ai` 1.18 or later).

## Configure

The plugin has no options of its own. Compaction is configured in OpenCode:

- **Compaction model.** Set `agent.compaction.model` to summarize with a different model than the session's:

  ```json
  {
    "agent": { "compaction": { "model": "provider/model-id" } }
  }
  ```

- **When it runs.** `compaction.auto` (default `true`) and `compaction.reserved` control automatic compaction; `/compact` runs it on demand. Leave `compaction.prune` off unless old tool output becomes a problem, because the checkpoint already records file state.

## Limits

- **No retry or fallback model.** OpenCode runs the compaction request itself, so a summary that comes back incomplete is kept as written. Pi's Smart Compaction can reject it and retry on another model.
- **Experimental hooks.** The plugin relies on `experimental.session.compacting` and `experimental.text.complete`. If an OpenCode release changes them, the plugin logs a warning and OpenCode's own prompt is used instead; sessions never block on the plugin.
- **One text part.** The state is appended to the first text part of the summary message, which is the only one compaction models normally produce.

## Documentation

- [Architecture](docs/ARCHITECTURE.md): the hooks, the session read, and how the summary is completed.
- [Development](docs/DEVELOPMENT.md): commands, tests, and releases.

## License

[MIT](LICENSE)