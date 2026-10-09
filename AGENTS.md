# AGENTS.md

## Project

An OpenCode 2 plugin, published to npm as `opencode-smart-compaction`, that writes compaction checkpoints in the Smart Compaction format through the session `compaction` hook. Read `docs/ARCHITECTURE.md` before changing hook behavior.

## Commands

- `mise exec --locked -- bun run validate`: typecheck and tests. Run it before every commit.
- `mise exec --locked -- bun run pack:inspect`: check the npm payload after changing `package.json` or `files`.

## Critical patterns

- Target the OpenCode 2 plugin API only (`{ id, setup }`); do not add a V1 `server()` entrypoint.
- Import only types from `@opencode/plugin`. It stays a dev and optional peer dependency, never a runtime dependency.
- The hook fails open: on any error or empty reply, leave `event.result` unset so OpenCode compacts with its own prompt.
- `src/prompt.ts` and `src/git-state.ts` mirror the Pi extension (`shariq-pi-extensions/extensions/smart-compaction`). A change to the checkpoint format or protected-fact rules belongs in both.
- Prompt strings contain literal XML-style tags. Verify them with `grep` on the file, since some editing tools hide them in their display.
- Test live against the published npm package, not a local path.

## Releases

Bump `version` in `package.json` with every functional change; pushing it to `main` publishes through `.github/workflows/publish-npm.yml`. See `docs/DEVELOPMENT.md`.
