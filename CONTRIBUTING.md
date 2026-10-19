# Contributing

Thanks for helping make `@fraziym/mcp` the best MCP server package. Keep it fast, keep it safe.

## Setup

```sh
git clone https://github.com/Akik-Forazi/MCP.git
cd MCP
npm ci
npm run build     # tsc + regenerate catalog.json
```

## Before every PR

```sh
npm run typecheck
npm test          # node:test suite
npm run fuzz      # adversarial path pack — 0 escapes required
```

Any change that touches a tool's name, description or schema must run `npm run build` (it regenerates `catalog.json` and `docs/tools.md`) and commit the regenerated artifacts.

## Ground rules

- **Binary-identical artifacts matter.** Tool catalogs, hook copies and generated docs are checked for drift in CI-adjacent tests; regenerate, don't hand-edit.
- **No new runtime dependencies** without a written justification in the PR. The single dependency (`@fraziym/axoniz`) is the product's toolbelt integration; everything else ships zero-dep.
- **Security surface changes** (path handling, shell execution, HTTP transport) must add or extend fuzz cases under `src/cli/fuzz.ts`.
- **Performance regressions** are bugs: run `npm run bench` before/after and paste the medians in the PR.

## Releases

1. Bump `version` in `package.json` and update `CHANGELOG.md`.
2. `npm run clean && npm run build && npm run build:exe` (runs automatically via `prepublishOnly`).
3. Tag and publish: the `publish` GitHub workflow publishes with npm provenance (`--provenance`) and picks `beta`/`latest` dist-tag from the version string. Manual fallback: `npm publish --provenance --access public --tag beta`.

Maintainers: enable npm trusted publishing for this repo on npmjs.com so OIDC replaces the `NPM_TOKEN` secret.
