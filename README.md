# opencode-smart-compaction

Smart Compaction for [OpenCode](https://opencode.ai) 2. When OpenCode compacts a long session, this plugin writes the checkpoint itself: a structured six-section summary that keeps the identifiers it must not lose and ends with the exact file and worktree state.

It is the OpenCode counterpart of the Smart Compaction extension in [shariq-pi-extensions](https://github.com/shariqriazz/shariq-pi-extensions) and produces the same checkpoint format.

## What a checkpoint contains

The model writes six sections:

1. Primary goal and constraints, including every "never do X" rule the user stated.
2. Progress ledger: done, in progress (with batch counts), and blocked.
3. Code changes with verbatim snippets of in-flight work.
4. Errors, root causes, and fixes.
5. Key decisions and discarded approaches.
6. Resume anchor and the next concrete step.

The plugin then adds two things the model doesn't write:

- **Retained identifiers.** Commit SHAs, UUIDs, URLs, and IPv4 addresses from your messages or the previous checkpoint are protected. Any the summary dropped are appended verbatim under `### Retained Identifiers`.
- **File and worktree state.** Files the session read or changed through tools, the files git reports as dirty, lockfile and generated-asset changes, and a bounded diff of uncommitted work, including previews of untracked files. Untracked symlinks are never followed.

On the next compaction, the previous checkpoint goes back to the model as `<previous-summary>` and is merged with the new turns. The appended state is regenerated each time.

OpenCode still keeps the most recent conversation (`compaction.keep.tokens`) verbatim beside the checkpoint.

## Install

Add the package to `plugins` in `~/.config/opencode/opencode.json` or a project's `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-smart-compaction"]
}
```

OpenCode installs it from npm on the next start. It needs OpenCode 2.0.26 or later.

## Configure

The plugin has no options. Compaction itself is configured in OpenCode:

- `compaction.auto` (default `true`) and `compaction.buffer` decide when automatic compaction runs; `/compact` runs it on demand.
- `compaction.keep.tokens` (default `15000`) sets how much recent conversation stays verbatim beside the checkpoint.

The checkpoint is written by the session's model. Models set to provider-native compaction (`settings.compaction.type: "native"`) don't call the hook, so the plugin doesn't apply to them.

## Limits

- **No validation retry.** A summary that comes back incomplete is kept as written. Pi's Smart Compaction can reject it and retry on another model.
- **Fails open.** If the plugin can't build or generate a checkpoint, it logs a warning and OpenCode compacts with its own prompt. A session never blocks on the plugin.

## Documentation

- [Architecture](docs/ARCHITECTURE.md): the hook, the request it builds, and how the summary is completed.
- [Development](docs/DEVELOPMENT.md): commands, tests, and releases.

## License

[MIT](LICENSE)
