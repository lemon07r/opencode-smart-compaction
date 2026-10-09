# AGENTS.md

## Project

An OpenCode 1 plugin, published to npm as `opencode-smart-compaction`, that replaces OpenCode's compaction prompt with the Smart Compaction checkpoint and completes the summary afterwards. See `docs/ARCHITECTURE.md` before changing hook behavior.

## Commands

- `mise exec --locked -- bun run validate`: typecheck and tests. Run it before every commit.
- `mise exec --locked -- bun run pack:inspect`: check the npm payload after changing `package.json` or `files`.

## Critical patterns

- Keep `main` and `exports["./server"]` in `package.json` pointing at `src/index.ts`. OpenCode ignores `exports["."]`, and without them it skips the plugin silently.
- `src/index.ts` default-exports `{ id, server }` and nothing else, because OpenCode's legacy loader calls every exported function as a plugin.
- Both hooks fail open: catch errors, log through `client.app.log`, and leave OpenCode's own behavior in place.
- `src/prompt.ts` and `src/git-state.ts` mirror the Pi extension (`shariq-pi-extensions/extensions/smart-compaction`). A change to the checkpoint format or protected-fact rules belongs in both.
- Prompt strings contain literal XML-style tags. Verify them with `grep` on the file, since some editing tools hide them in their display.

## Releases

Bump `version` in `package.json` with every functional change; pushing it to `main` publishes through `.github/workflows/publish-npm.yml`. See `docs/DEVELOPMENT.md`.