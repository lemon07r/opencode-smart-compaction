# Architecture

The plugin rewrites OpenCode's compaction prompt before the summary request and finishes the summary text after the model writes it. Both steps run through experimental OpenCode 1 plugin hooks; the plugin never calls a model itself.

## Key files

- `src/index.ts`: the plugin (`server`) and its three hooks. The module default-exports `{ id, server }` and exports nothing else.
- `src/session.ts`: reads user text, the previous checkpoint, and tool file activity from the session's messages.
- `src/checkpoint.ts`: builds the prompt and completes the summary.
- `src/prompt.ts`: the checkpoint prompts, protected-fact extraction, and file-state formatting.
- `src/git-state.ts`: dirty files and a bounded diff with untracked-file previews.

## How it works

1. **`experimental.session.compacting`** fires when OpenCode starts a compaction. The plugin reads the session through the SDK client (`client.session.messages`), collects git state for the worktree, and sets `output.prompt`. OpenCode then sends that prompt followed by the conversation it selected for summarizing.
2. Setting `output.prompt` replaces OpenCode's own prompt builder, and that builder is what carries the previous checkpoint forward. The plugin therefore finds the latest assistant message with `summary: true` itself and includes it as `<previous-summary>`, with the previously appended state stripped off (`semanticSummary`).
3. The checkpoint (protected facts plus the rendered file-state appendix) waits in a per-session map.
4. **`experimental.text.complete`** fires for every finished text part. For a session with a waiting checkpoint, the plugin fetches the message (`client.session.message`) and acts only when it is the compaction summary (`summary: true`). It then restores dropped protected facts and appends the state (`completeSummary`), and clears the waiting checkpoint so it completes one summary only.
5. **`event`** clears a waiting checkpoint on `session.compacted`, `session.error`, or `session.deleted`, so an abandoned compaction can't attach its state to a later message.

File activity comes from completed tool parts: `read` for read files; `edit`, `write`, and the `*** Add/Update/Delete File` and `*** Move to` lines of `apply_patch` for changed files. It spans the whole session, so files touched before an earlier compaction still appear.

## Decisions and trade-offs

- **Shared format with Pi.** `src/prompt.ts` and `src/git-state.ts` are adapted from the Pi extension's `prompt.ts` and `engine.ts`, so a session checkpointed in either harness reads the same. The two copies must change together; revisit this as a shared package if the format starts changing often.
- **Prompt order.** OpenCode puts the plugin prompt before the conversation, so the prompts refer to "the conversation history below" where Pi's say the tags above.
- **Fail open.** Any error in either hook is logged through `client.app.log` and leaves OpenCode's behavior in place. A broken plugin must not stop a session from compacting.
- **No validation retry.** OpenCode owns the compaction request, so there is no hook to reject a summary and ask again. Deterministic repair (restoring identifiers, appending state) is what the hooks allow.

## Gotchas

- **Entry point resolution.** OpenCode loads a package plugin from `exports["./server"]` or `main`, not from `exports["."]`. Without one of them, OpenCode skips the plugin silently, both from npm and from a `file://` path. `package.json` sets both.
- **Exports.** OpenCode's legacy loader treats every exported function as a plugin, so helpers must stay out of `src/index.ts` exports.
- **Literal tags.** Prompt and appendix strings contain XML-style tags (`<previous-summary>`, `<touched-files>`, and others). Some editing tools hide those tags in their display; check the file bytes rather than the rendered view when editing them.

## Related docs

- [README](../README.md): what the checkpoint contains, installation, and configuration.
- [Development](DEVELOPMENT.md): commands, tests, and releases.