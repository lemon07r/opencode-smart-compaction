# Architecture

The plugin registers one OpenCode 2 session hook, `compaction`, and supplies the checkpoint as the hook's result. OpenCode then skips its own summary request.

## Key files

- `src/index.ts`: the plugin definition (`{ id, setup }`) and the compaction hook.
- `src/session.ts`: reads the previous checkpoint, user text, tool file activity, and a flattened transcript from the request messages.
- `src/checkpoint.ts`: builds the prompt and completes the summary.
- `src/prompt.ts`: the checkpoint prompts, protected-fact extraction, and file-state formatting.
- `src/git-state.ts`: dirty files and a bounded diff with untracked-file previews.

## How it works

1. OpenCode splits the session into an older part to summarize and a recent part it keeps verbatim (`compaction.keep.tokens`), then calls the `compaction` hook with the older part as `event.messages`.
2. When a previous checkpoint exists, it is the first message, wrapped in `<conversation-checkpoint>`. `readSessionFacts` takes its summary out and returns the rest as a transcript: user and assistant text, tool calls, and tool results cut to 1,250 characters, as OpenCode's own compaction does. It also collects user text and file activity: `read` for read files; `edit`, `write`, and the `*** Add/Update/Delete File` and `*** Move to` lines of `patch` for changed files, skipping calls whose result is an error.
3. The plugin looks up the session's directory (`ctx.session.get`) and reads its git state.
4. `buildCheckpoint` assembles one prompt: the directives, the transcript in `<conversation>`, the previous checkpoint in `<previous-summary>` with its appended state stripped (`semanticSummary`), the protected facts, and the initial or update instructions.
5. `ctx.generate.text` runs the prompt on the session's model (`event.model`).
6. `completeSummary` restores dropped protected facts and appends the file-state blocks. The result goes into `event.result.summary`, which OpenCode stores as the checkpoint and puts in front of the recent conversation.

## Decisions and trade-offs

- **The plugin writes the summary.** OpenCode appends its own summary template after hooks run and rejects replies that don't use its headings. Supplying `event.result` is the only way to use the six-section format without fighting that template.
- **Shared format with Pi.** `src/prompt.ts` and `src/git-state.ts` are adapted from the Pi extension's `prompt.ts` and `engine.ts`, so a checkpoint reads the same in either harness. The two copies must change together; revisit this as a shared package if the format starts changing often.
- **Fail open.** Any error, or an empty reply, leaves `event.result` unset, so OpenCode compacts with its own prompt and its own size handling.
- **No runtime dependencies.** The plugin imports only OpenCode types. `Plugin.define` is an identity function, so the default export is a plain object checked with `satisfies Plugin.Plugin`.
- **No size retry.** OpenCode shrinks its own compaction request when a provider rejects it as too long. The plugin's request is a single text prompt; if it is rejected, OpenCode's own compaction takes over.

## Gotchas

- **Entry point.** OpenCode loads an npm plugin from the package's `./server` or `.` export, and a local directory plugin only from an `index` or `server` file at its root. This package uses the `.` export, so test it from npm or from a file under `.opencode/plugins/` that re-exports `src/index.ts`.
- **Literal tags.** Prompt and appendix strings contain XML-style tags (`<previous-summary>`, `<touched-files>`, and others). Some editing tools hide those tags in their display; check the file bytes rather than the rendered view when editing them.

## Related docs

- [README](../README.md): what the checkpoint contains, installation, and configuration.
- [Development](DEVELOPMENT.md): commands, tests, and releases.
