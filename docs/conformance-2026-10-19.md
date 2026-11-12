# Official MCP conformance — 2026-10-19

Result: **32/32 scenarios · 47/47 checks · 0 failed** with
`@modelcontextprotocol/conformance@0.1.16` (server suite, spec `2025-11-25`).

## Reproduce

```sh
# 1. Build and start the server with the spec fixture surface enabled
npm run build
node dist/cli/index.js serve --http --port 7777 --conformance --rate-limit off

# 2. Run the official suite against it
npx -y @modelcontextprotocol/conformance@0.1.16 server \
  --url http://127.0.0.1:7777/mcp --suite all -o conformance-report
```

Environment: Windows 11, Node 24.21.0, loopback HTTP, no TLS.

`--conformance` only registers the spec fixture names (`test_simple_text`,
`test://static-text`, `test_simple_prompt`, …). The fixtures drive the same
protocol paths as the real surface — content blocks, progress/logging
notifications, server→client sampling/elicitation, SSE stream close/resume —
so the suite exercises the shipped implementation, not stubs. Without the flag
the server advertises exactly the 74 catalog tools and the real
resources/prompts.

## Scenario results

| Scenario | Checks |
| --- | --- |
| server-initialize | 1 passed |
| logging-set-level | 1 passed |
| ping | 1 passed |
| completion-complete | 1 passed |
| tools-list | 1 passed |
| tools-call-simple-text | 1 passed |
| tools-call-image | 1 passed |
| tools-call-audio | 1 passed |
| tools-call-embedded-resource | 1 passed |
| tools-call-mixed-content | 1 passed |
| tools-call-with-logging | 1 passed |
| tools-call-error | 1 passed |
| tools-call-with-progress | 1 passed |
| tools-call-sampling | 1 passed |
| tools-call-elicitation | 1 passed |
| json-schema-2020-12 | 4 passed |
| elicitation-sep1034-defaults | 5 passed |
| server-sse-polling (SEP-1699) | 3 passed — priming event, retry field, disconnect + `Last-Event-ID` resume |
| server-sse-multiple-streams | 2 passed |
| elicitation-sep1330-enums | 5 passed |
| resources-list | 1 passed |
| resources-read-text | 1 passed |
| resources-read-binary | 1 passed |
| resources-templates-read | 1 passed |
| resources-subscribe | 1 passed |
| resources-unsubscribe | 1 passed |
| prompts-list | 1 passed |
| prompts-get-simple | 1 passed |
| prompts-get-with-args | 1 passed |
| prompts-get-embedded-resource | 1 passed |
| prompts-get-with-image | 1 passed |
| dns-rebinding-protection | 2 passed |

## Protocol surface this exercises

- Dual-era init: legacy `initialize` (with `Mcp-Session-Id` minting) and
  stateless `2026-07-28` requests.
- `logging/setLevel` + level-filtered `notifications/message`.
- Tool results with text/image/audio/embedded-resource/mixed content blocks,
  `isError`, and JSON Schema 2020-12 (`$schema`, `$defs`, `additionalProperties`)
  preserved verbatim in `tools/list`.
- `notifications/progress` for `_meta.progressToken` requests.
- Server→client `sampling/createMessage` and `elicitation/create` over legacy
  SSE POST streams, gated on declared client capabilities (incl. SEP-1034
  default values and SEP-1330 enum variants).
- Resources: list, read (text + binary blob), templates, subscribe/unsubscribe.
- Prompts: list, get with arguments, embedded resource, image.
- `completion/complete`.
- SSE: POST response streams, priming event (`id` + empty `data` + `retry`),
  mid-call stream close (`test_reconnection`), replay after reconnection with
  `Last-Event-ID`, concurrent POST streams.
- DNS-rebinding Origin rejection.
