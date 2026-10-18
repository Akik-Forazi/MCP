# @fraziym/mcp

Shared agent toolbelt for the axo ecosystem. Hardcoded, importable tool
groups — not a runtime server. Tools come from `@fraziym/axoniz` tool
classes (files, shell, web, code, axodex) plus git wrappers added here.

## Install

```bash
npm install @fraziym/mcp
```

## Use — xorvoid group

```ts
import { xorvoidTools } from "@fraziym/mcp/xorvoid";

const tools = xorvoidTools({ workspace: "/path/to/repo" });

// Feed the LLM (OpenAI/OpenRouter-compatible function schemas)
const specs = tools.specs();

// Execute locally — every call resolves to a string
const out = await tools.call("file_read", { path: "src/index.ts" });
```

## Tools (xorvoid group)

| Area | Tools |
| --- | --- |
| Files | `file_read` `file_write` `file_edit` `file_append` `file_patch` `file_delete` `file_list` `file_search` `file_grep` |
| Shell | `shell_run` `shell_python` |
| Web | `web_search` (keyless DuckDuckGo) `web_get` |
| Git | `git_status` `git_diff` `git_log` |
| Code | `code_tree` `code_analyze` `code_lint` `code_format` |
| Graph | `axodex_query` `axodex_context` `axodex_impact` `axodex_smart_read` `axodex_status` |

`tools.meta(name)` flags `destructive` and `network` tools so callers can
scope them per agent role.

More groups (`axoniz`, `axotest`, …) coming as the ecosystem grows.
