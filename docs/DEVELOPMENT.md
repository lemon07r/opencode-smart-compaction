# Development

The toolchain is pinned in `mise.toml`, Bun manages dependencies through `bun.lock`, and tests run under Node's built-in test runner with native TypeScript.

## Commands

- `mise install --locked`: install the pinned Bun and Node.
- `mise exec --locked -- bun install`: install locked dependencies.
- `mise exec --locked -- bun run validate`: typecheck and run the tests.
- `mise exec --locked -- bun run pack:inspect`: list what the npm package would contain.

## Test against a live OpenCode

Test the published package. With `"plugins": ["opencode-smart-compaction"]` in the config, confirm the plugin is active:

```bash
opencode api get /api/plugin
```

Compact a session that has at least two exchanges:

```bash
opencode api post /api/session/<session-id>/compact --data '{}'
```

Then read the session's messages (`opencode api get /api/session/<session-id>/message`). The completed `compaction` message should have the six numbered sections, any retained identifiers, and the file-state blocks at the end.

## Releases

Pushing to `main` runs CI (`.github/workflows/ci.yml`). The publish workflow (`.github/workflows/publish-npm.yml`) validates and publishes to npm with provenance whenever `package.json` carries a version that isn't on npm yet, so bump `version` with every functional change.

Publishing uses npm trusted publishing (OIDC), so the repository holds no npm token. The package's trusted publisher on npmjs.com names this repository and `publish-npm.yml`; renaming the workflow file breaks publishing until that setting is updated.

## Upgrading OpenCode

1. Raise `@opencode/plugin` in `devDependencies` and the `peerDependencies` floor, then run `bun install`.
2. Check `node_modules/@opencode/plugin/dist/promise/session.d.ts` for changes to the `compaction` hook event, and the OpenCode compaction source for changes to how the previous checkpoint is wrapped.
3. Run `validate`, publish, and repeat the live test above.
