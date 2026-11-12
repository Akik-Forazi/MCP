# Clean-install / isolated-launch check (2026-10-19)

Package: local `npm pack` of `@fraziym/mcp@0.1.1-beta.0` after the benchmark
cleanup. Tarball: 138.6 kB packed / 572.8 kB unpacked, 134 files; the file list
contains no `bench`, cache, test or development artifacts. The `latest` npm tag
is still `0.1.0-beta.1` with no bin; this test used the local tarball.

Install command (empty prefix under the opencode temp dir, empty userconfig):

```
npm install --prefix <temp> <repo>/fraziym-mcp-0.1.1-beta.0.tgz --no-audit --no-fund --userconfig <temp>/empty-npmrc
```

Result:

- `added 360 packages in 3m` (no failure).
- Peer warnings: `tree-sitter-bash`/`tree-sitter-css` expect
  `tree-sitter@^0.25.0`, Axodex pins `0.21.1`.
- 21 native/install scripts were **not covered by `allowScripts`** in a consumer
  prefix: `@fraziym/axodex` grammar build, `@ladybugdb/core`, `node-llama-cpp`,
  `@scarf/scarf` and the tree-sitter grammar installs. The package's own
  `allowScripts` field does not authorize scripts for consumers; each consuming
  project must approve them. Launch and non-native tools work; native/code-graph
  builds were not verified.
- `@fraziym/axodex@0.1.1-beta.3` CLI runs (`--version`), and
  `bin/fraziym-mcp.exe version` prints `0.1.1-beta.0`.

Isolated launch from the installed package (cwd = fresh empty workspace, repo not
on the resolution path):

```json
{"server":{"name":"fraziym-mcp","version":"0.1.1-beta.0"},"tools":74,"stderr":0}
```

Isolated tool calls in the same fresh workspace:

| Call | Result |
| --- | --- |
| `get_time` | ok |
| `file_write` (`clean-probe.txt`) | `[OK] Wrote ...` |
| `file_read` (`clean-probe.txt`) | content returned |

Caveat: the server stderr had 132 bytes (Axoniz startup logging); stdout stayed
pure JSON-RPC. This verifies clean install + core launch + catalog/file tools.
It does **not** verify native code intelligence, memory persistence at scale,
desktop automation or HTTP transport.
