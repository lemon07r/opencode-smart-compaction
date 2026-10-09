# Development

The toolchain is pinned in `mise.toml`, Bun manages dependencies through `bun.lock`, and tests run under Node's built-in test runner with native TypeScript.

## Commands

- `mise install --locked`: install the pinned Bun and Node.
- `mise exec --locked -- bun install`: install locked dependencies.
- `mise exec --locked -- bun run validate`: typecheck and run the tests.
- `mise exec --locked -- bun run pack:inspect`: list what the npm package would contain.

## Test against a live OpenCode

Point the `plugin` list at the checkout and restart OpenCode:

```json
{ "plugin": ["file:///absolute/path/to/opencode-smart-compaction"] }
```

Compact a session with `/compact` (or `POST /session/:id/summarize` on `opencode serve`), then check the latest `summary: true` message: it should have the six numbered sections, any retained identifiers, and the file-state blocks at the end.

## Releases

Pushing to `main` runs CI (`.github/workflows/ci.yml`). The publish workflow (`.github/workflows/publish-npm.yml`) validates and publishes to npm with provenance whenever `package.json` carries a version that isn't on npm yet, so bump `version` with every functional change.

Publishing uses npm trusted publishing (OIDC): the repository holds no npm token. The package's trusted publisher on npmjs.com must name this repository and `publish-npm.yml`; renaming the workflow file breaks publishing until the npm setting is updated.

## Upgrading OpenCode

1. Raise `@opencode-ai/plugin` in `devDependencies` and run `bun install`.
2. Check that the hook signatures in `node_modules/@opencode-ai/plugin/src/index.ts` still match what `src/index.ts` uses, since the hooks are experimental.
3. Run `validate`, then repeat the live test above.