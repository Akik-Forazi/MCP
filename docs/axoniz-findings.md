# Axoniz findings (upstream review)

Security review of `@fraziym/axoniz` (baseline **0.1.8-beta.1**), performed while building `@fraziym/mcp`'s guard. These are **report-only**: this package does not patch upstream. Where possible, `@fraziym/mcp` mitigates locally (noted per finding).

## 1. `FileTools` path guard is dead code

**Where:** `axoniz/src/tools/file_tools.ts:43` (path resolution helper checked by `file_read`/`file_write`/`file_edit`/…).

**What:** the guard compares a `path.resolve`d candidate against the workspace prefix without resolving symlinks/realpath and without normalizing case on Windows. Consequences:

- A symlink *inside* the workspace pointing outside passes the check on every read/write via that link.
- Windows case-insensitive comparisons can be sidestepped with 8.3 short names (`C:\PROGRA~1\…`) or trailing-dot/space forms that `path.resolve` does not canonicalize.
- UNC paths (`\\server\share\…`) are not rejected when the workspace is on a different volume (`path.relative` yields an absolute-looking result the prefix check mishandles on some Node versions).

**Impact:** path containment is not actually enforced by axoniz for direct library consumers.

**Local mitigation in `@fraziym/mcp`:** the mcp guard wraps every family (`guardToolbox`): `realpathSync.native` on workspace and target, case-normalized prefix containment, rejection of UNC/device namespaces, NUL bytes, and a 4096-char path cap enforced pre-dispatch (`prove` + `fuzz` exercise this).

**Suggested upstream fix:** resolve the workspace root and the candidate with `fs.realpathSync.native` (creating parents for writes), compare with `path.relative` on normalized case, and reject paths where the relative form starts with `..` or is absolute.

## 2. `quoteArgv` uses MSVCRT quoting where cmd.exe parsing applies

**Where:** `axoniz/src/tools/axodex_tools.ts` (`quoteArgv`, used to assemble axodex CLI invocations).

**What:** the quoting routine implements the classic MSVCRT `argv` rules (`"` doubling, backslash runs). It is correct for direct `CreateProcess` invocations, but the same strings are also handed to `cmd.exe` (`shell: true` paths / `.cmd` shims). cmd.exe does **not** use MSVCRT rules: it strips the first and last quote of `/s /c` command lines and treats `&`, `|`, `^`, `%VAR%`, `(`, `)` as syntax. A model-controlled argument containing `%PATH%` or `& calc` can therefore survive quoting and be re-parsed as commands.

**Impact:** potential argument re-interpretation / command splicing when the CLI resolves through a `.cmd` shim (the common case on Windows, including `npx`).

**Local mitigation in `@fraziym/mcp`:** all subprocess tools use `execFile` without `shell: true`; shim resolution is done by our own `parseCmdShim` (which walks the shim's `SET` assignments to find the real `.js` entry and then spawns `node` directly — cmd.exe never parses model-controlled text). `fix_shadow` writes the user-supplied test command into a `.cmd` file in a throwaway worktree, which sidesteps cmd's `/c` quoting entirely (also fixes cmd swallowing exit codes of quoted programs — found while testing: `cmd /c node -e "process.exit(1)"` exits 0).

**Suggested upstream fix:** spawn `node <resolved shim .js>` directly (never through `cmd.exe`) or port this repo's `parseCmdShim`; if cmd.exe is unavoidable, quote with cmd-specific rules and reject `%`, `!`, `&`, `|`, `<`, `>`, `^` in interpolated values.

## 3. `screen_capture` accepts absolute output filenames

**Where:** `axoniz/src/tools/computer_tools.ts` (`screen_capture`).

**What:** the `filename` argument is passed through to the capture layer without the workspace jail. An absolute path (`C:\Users\…\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\x.lnk`-adjacent writes, or simply a file outside the workspace) is written wherever the caller says.

**Impact:** arbitrary-location file write with the server user's privileges (requires the computer tool family and `--includeInput`-style consent in practice).

**Local mitigation in `@fraziym/mcp`:** the guard jails the `filename` arg like any other path argument; `prove` skips `screen_*`/`mouse_*`/`keyboard_*` by default (`--include-input` to force).

**Suggested upstream fix:** run the filename through the same `FileTools` resolution (finding 1 fixed first), defaulting relative names into a workspace `screenshots/` directory.

---

Verification for all three: `npm run prove` (74/74 tool dispatch) and `npm run fuzz` (327-case jail pack, 0 breaches) in this repo; the cmd.exe exit-code quirk is covered by `test/gateway.test.ts` (`fix_shadow`).
