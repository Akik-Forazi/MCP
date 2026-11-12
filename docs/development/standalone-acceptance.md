# Standalone acceptance checklist

Status: **proposed gate, not yet met.** Check every item against the implemented
standalone package before declaring the migration complete. Record the command,
date, machine and artifact for each item; do not check an item from intent or
from the presence of a catalog entry.

- [ ] **1. Clean install works.** A fresh prefix with no repo `node_modules`
      installs the published tarball/package on a supported OS and Node version,
      without relying on files from this checkout.
      Evidence: install log, `npm ls --depth=0`, package version.

- [ ] **2. Clean launch works.** The installed package starts in a new empty
      workspace and completes `initialize` + `tools/list`; stdout contains only
      MCP protocol messages.
      Evidence: isolated-prefix launch transcript, tool count, stderr check.

- [ ] **3. Tool surface is complete and non-silent.** All 74 catalog tools are
      either working, adapter-backed, or explicitly marked unsupported with a
      stable error. No tool disappears silently and no catalog-only ghost tool
      is advertised.
      Evidence: `prove-report.json`, catalog parity test, owner/status table.

- [ ] **4. No unreachable dispatch.** `prove` reports **0 unreachable** tools;
      every `env-error` is reproducible as a missing external prerequisite, not
      a broken handler.
      Evidence: `npm run prove` output and environment notes.

- [ ] **5. Core has no Axoniz runtime dependency.** The core server starts and
      serves the non-Axoniz tool set with `@fraziym/axoniz` absent. Any remaining
      Axoniz adapter is optional and fails with a clear unavailable error.
      Evidence: clean prefix without Axoniz, `npm ls`, startup transcript.

- [ ] **6. Heavy/native dependencies are optional and lazy.** `tools/list` and
      startup do not import Axoniz, Axodex, `node-llama-cpp`, tree-sitter,
      `@ladybugdb/core`, screenshot or image libraries. A core-only install stays
      within an agreed size budget.
      Evidence: `npm pack` file list, cold install size, module-load trace,
      optional-dependency tests.

- [ ] **7. Discovery is accurate and cheap.** `catalog.json` matches the
      registered schemas/names exactly; `tools/list` is answered without loading
      a tool family; annotations (`readOnlyHint`, `destructiveHint`,
      `openWorldHint`) match behavior.
      Evidence: catalog parity test, schema snapshot, no-import test.

- [ ] **8. Schemas are stable and versioned.** Existing tool names and required
      arguments remain compatible, or a versioned breaking-change note and
      deprecation path exist. Result shapes follow the documented contract.
      Evidence: schema diff, compatibility test, changelog entry.

- [ ] **9. Error contract is preserved.** Handlers do not throw to the agent
      loop; failures remain `[ERROR] <tool>: <message>`. Timeouts, missing
      binaries and unavailable integrations are distinguishable.
      Evidence: unit tests for success/env-error/unsupported paths.

- [ ] **10. Security is not weakened.** Workspace realpath containment, path/arg
      caps, output truncation, audit redaction, HTTP binding/Origin/auth/rate
      limiting all retain their current tests; new adapters cannot widen the
      workspace.
      Evidence: `test/guard.test.ts`, new adapter-boundary tests, security
      review, fuzz result.

- [ ] **11. Fuzz gate passes.** The adversarial path pack and seeded cases report
      zero escapes and both argument-cap rejections.
      Evidence: `npm run fuzz` + `fuzz-report.json`.

- [ ] **12. Protocol conformance passes.** The official MCP conformance suite
      passes the supported suites with the real surface (not stubs), or a
      documented, reviewed exception exists.
      Evidence: conformance command, version, artifact, date.

- [ ] **13. Memory and configuration are isolated.** Memory/KG/palace/diary
      paths are explicit, workspace-scoped by default, overrideable, and do not
      silently write to a global home. Concurrent workspaces do not corrupt each
      other.
      Evidence: path-isolation tests, concurrent-workspace test.

- [ ] **14. Packaging is correct.** `bin` points at a runnable CLI, `exports`
      resolve, `files` contains no bench/development/cache artifacts, the
      tarball has no multi-gigabyte native payload, and `latest`/`beta` tags are
      consistent.
      Evidence: `npm pack --dry-run`, install from tarball, tag check.

- [ ] **15. Compatibility and deprecation are documented.** `axonizTools`,
      `xorvoidTools`, CLI flags, default 74/87 tool counts and protocol versions
      remain compatible, or have a release-note deprecation path. Stub decisions
      are explicit.
      Evidence: compatibility tests, changelog, migration note.

- [ ] **16. Consumers can migrate.** At least one real Fraziym product (or a
      representative fixture) consumes MCP tools without importing duplicated
      tool implementations; removing its duplicate surface is planned and does
      not regress behavior.
      Evidence: consumer integration test, diff of removed duplicate, smoke run.

- [ ] **17. Verification is honest and self-contained.** Tests, prove, fuzz and
      conformance run from the repo; no public benchmark index or unsupported
      performance claim is required. All reported results were actually run and
      are dated.
      Evidence: CI run, local results, `docs/development/benchmark-history.md`.

## Minimum release blockers

Items **1, 2, 3, 4, 6, 9, 10, 11, 12, 14** are mandatory before any "standalone"
release. Items **5, 7, 8, 13, 15, 16, 17** become mandatory before removing the
Axoniz dependency or switching other products over.
