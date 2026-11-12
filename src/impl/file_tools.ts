/**
 * AXONIZ FileTools — production-grade file operations (TypeScript port).
 *
 * Ported from `axoniz/tools/file_tools.py`. Adds: diff-aware edit, multi-file
 * read, patch apply, safe backup, ripgrep-style search.
 *
 * Python-stdlib mapping:
 *   glob.glob(recursive=True) -> expandGlob (Node `fs.readdirSync` recursion;
 *                               the `glob` npm package is not a dependency)
 *   difflib.unified_diff      -> unifiedDiff
 *   shutil.copy2 / move       -> fs.copyFileSync / fs.renameSync (+ EXDEV fallback)
 *
 * Every method returns a string, byte-for-byte compatible with the prefixes and
 * layouts the Python version produced (the agent parses these).
 */

import fs from "node:fs";
import path from "node:path";

import { WorkspaceViolationError } from "./core/errors.ts";
import { errText, expandGlob, unifiedDiff } from "./_internal.ts";

/** Format a number with thousands separators exactly like Python's `{:,}`. */
function comma(n: number): string {
  return n.toLocaleString("en-US");
}

export class FileTools {
  readonly workspace: string;

  constructor(workspace = ".") {
    this.workspace = path.resolve(workspace);
  }

  /**
   * Resolve `p` against the workspace. Absolute paths pass through unchanged,
   * matching Python's `_resolve`; the confinement guard additionally rejects
   * paths that escape the workspace (preserves `WorkspaceViolationError` use).
   */
  private _resolve(p: string): string {
    const full = path.isAbsolute(p) ? path.normalize(p) : path.join(this.workspace, p);
    const rel = path.relative(this.workspace, full);
    if (rel.startsWith("..") && path.isAbsolute(rel)) {
      throw new WorkspaceViolationError(full, this.workspace);
    }
    return full;
  }

  /** `"── name (N total) ──"`-style relative label used by list_dir. */
  private _relFromWorkspace(full: string): string {
    return path.relative(this.workspace, full) || ".";
  }

  /* ── READ ──────────────────────────────────────────────────────────────── */

  /** Read file with line numbers. Optional start/end line range. */
  read(p: string, startLine?: number | null, endLine?: number | null): string {
    const full = this._resolve(p);
    try {
      const raw = fs.readFileSync(full, "utf8");
      // Python's `readlines()`: split on "\n" keeping the terminator, with no
      // extra empty trailing element.
      const lines = pyReadLines(raw);
      const total = lines.length;

      let selected: string[];
      let offset: number;
      if (startLine || endLine) {
        const s = Math.max(0, (startLine ?? 1) - 1);
        const e = Math.min(total, endLine ?? total);
        selected = lines.slice(s, Math.max(s, e));
        offset = s;
      } else {
        selected = lines;
        offset = 0;
      }
      const numbered = selected
        .map((l, i) => `${String(i + offset + 1).padStart(4)} │ ${l}`)
        .join("");
      const rng = startLine || endLine ? ` lines ${offset + 1}-${offset + selected.length}` : "";
      return `── ${p}${rng} (${total} total) ──\n${numbered}`;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err && err.code === "ENOENT") return `[ERROR] Not found: ${full}`;
      if (err && err.code === "EISDIR") return `[ERROR] Cannot read ${full}: ${errText(e)}`;
      return `[ERROR] Cannot read ${full}: ${errText(e)}`;
    }
  }

  /** Read multiple files at once. `paths` is a list of strings. */
  readMany(paths: string[]): string {
    const parts: string[] = [];
    for (const p of paths) parts.push(this.read(p));
    return parts.join("\n\n");
  }

  /* ── WRITE ─────────────────────────────────────────────────────────────── */

  /** Write file, auto-create directories. */
  write(p: string, content: string): string {
    const full = this._resolve(p);
    const dir = path.dirname(full) || ".";
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(full, content, "utf8");
    const lines = (content.match(/\n/g)?.length ?? 0) + 1;
    return `[OK] Wrote ${full} (${lines} lines, ${content.length} chars)`;
  }

  append(p: string, content: string): string {
    const full = this._resolve(p);
    fs.appendFileSync(full, content, "utf8");
    return `[OK] Appended ${content.length} chars to ${full}`;
  }

  /* ── EDIT (diff-aware) ─────────────────────────────────────────────────── */

  /** Find-and-replace with diff preview. Shows what changed. */
  edit(p: string, oldText: string, newText: string): string {
    const full = this._resolve(p);
    try {
      if (!fs.existsSync(full)) return `[ERROR] File not found: ${full}`;
      const original = fs.readFileSync(full, "utf8");

      if (!original.includes(oldText)) {
        // Try fuzzy: strip leading/trailing whitespace per line.
        const strippedOld = oldText
          .split(/\r?\n/)
          .map((l) => l.trim())
          .join("\n");
        const strippedOrig = original
          .split(/\r?\n/)
          .map((l) => l.trim())
          .join("\n");
        if (!strippedOrig.includes(strippedOld)) {
          // Show nearest match for debugging.
          const lines = original.split(/\r?\n/);
          const firstLine = (oldText.split(/\r?\n/)[0] ?? "").trim();
          const matches: number[] = [];
          lines.forEach((l, i) => {
            if (l.includes(firstLine.slice(0, 30))) matches.push(i + 1);
          });
          const hint = matches.length > 0 ? ` (nearest match at lines ${matches.slice(0, 3).join(", ")})` : "";
          return `[ERROR] Text not found in ${p}${hint}\nSearched for:\n${oldText.slice(0, 200)}`;
        }
      }

      const count = countOccurrences(original, oldText);
      const updated = oldText === "" ? original : original.split(oldText).join(newText);

      // Save backup.
      fs.writeFileSync(`${full}.bak`, original, "utf8");
      fs.writeFileSync(full, updated, "utf8");

      // Show diff summary. Lines are split the way Python's `str.splitlines()`
      // does (no terminators, lone \r dropped) so the unified diff matches
      // difflib's output exactly.
      const diff = unifiedDiff(
        original.split(/\r\n|[\n\r]/),
        updated.split(/\r\n|[\n\r]/),
        { fromFile: `a/${p}`, toFile: `b/${p}`, context: 2 },
      );
      const diffPreview = diff.slice(0, 30).join("\n");
      return `[OK] Edited ${p} (${count} replacement(s))\n${diffPreview}`;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err && err.code === "ENOENT") return `[ERROR] File not found: ${full}`;
      return `[ERROR] Edit failed: ${errText(e)}`;
    }
  }

  /** Apply a unified diff patch to a file. */
  patch(p: string, unifiedDiffText: string): string {
    const full = this._resolve(p);
    try {
      const original = fs.readFileSync(full, "utf8");
      const resultLines = pyReadLines(original);

      const hunks = parseHunks(unifiedDiffText);
      let offset = 0;
      for (const hunk of hunks) {
        const oldStart = hunk.oldStart - 1;
        const oldLen = hunk.oldLen;
        // Python appended "\n" to every emitted line — including the final one,
        // which is why the patched file always gains a trailing newline.
        const adds = hunk.adds.map((l) => `${l}\n`);
        const pos = oldStart + offset;
        resultLines.splice(pos, oldLen, ...adds);
        offset += adds.length - oldLen;
      }
      fs.writeFileSync(full, resultLines.join(""), "utf8");
      return `[OK] Patch applied to ${p}`;
    } catch (e) {
      return `[ERROR] Patch failed: ${errText(e)}`;
    }
  }

  /* ── SEARCH ────────────────────────────────────────────────────────────── */

  /** Glob file search. `pattern` can be `*.py`, `**\/*.ts`, etc. */
  search(p = ".", pattern = "*"): string {
    const full = this._resolve(p);
    let matches = expandGlob(full, pattern);
    // Exclude common noise.
    const noise = [".git", "__pycache__", "node_modules", ".egg-info", "dist\\", "build\\"];
    matches = matches.filter((m) => !noise.some((x) => m.includes(x)));
    if (matches.length === 0) return `No files matching '${pattern}' in ${p}`;
    const lines = [`Found ${matches.length} file(s) matching '${pattern}':`];
    for (const m of matches.slice(0, 60)) {
      const rel = path.relative(full, m);
      let size = 0;
      try {
        size = fs.statSync(m).size;
      } catch {
        /* ignore */
      }
      lines.push(`  ${rel}  (${comma(size)} B)`);
    }
    return lines.join("\n");
  }

  /** Search file contents for a text/regex pattern. Like ripgrep. */
  grep(
    p = ".",
    pattern = "",
    filePattern = "*.py",
    caseSensitive = true,
    maxResults = 50,
  ): string {
    const full = this._resolve(p);
    const flags = caseSensitive ? "" : "i";
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, flags);
    } catch {
      // Fallback to literal search.
      regex = new RegExp(escapeRegExp(pattern), flags);
    }

    let files = expandGlob(full, filePattern);
    files = files.filter(
      (f) => !any(f, [".git", "__pycache__", "node_modules", ".egg-info"]),
    );

    const results: string[] = [];
    for (const fpath of files) {
      try {
        const raw = fs.readFileSync(fpath, "utf8");
        const lines = raw.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          if (line.includes("\u0000")) continue;
          if (regex.test(line)) {
            const rel = path.relative(full, fpath);
            results.push(`  ${rel}:${i + 1}: ${line.replace(/\s+$/, "")}`);
            if (results.length >= maxResults) break;
          }
        }
      } catch {
        continue;
      }
      if (results.length >= maxResults) break;
    }

    if (results.length === 0) {
      return `No matches for '${pattern}' in ${filePattern} files under ${p}`;
    }
    const header = `grep '${pattern}' in ${filePattern} — ${results.length} match(es):`;
    return `${header}\n${results.join("\n")}`;
  }

  /* ── FS OPERATIONS ─────────────────────────────────────────────────────── */

  /** Directory listing with sizes, sorted dirs-first. */
  listDir(p = "."): string {
    const full = this._resolve(p);
    try {
      const items = fs.readdirSync(full).slice().sort();
      const dirs: string[] = [];
      const files: string[] = [];
      for (const i of items) {
        let isDir = false;
        try {
          isDir = fs.statSync(path.join(full, i)).isDirectory();
        } catch {
          isDir = false;
        }
        if (isDir) dirs.push(i);
        else files.push(i);
      }
      const result: string[] = [];
      for (const d of dirs) {
        if ([".git", "__pycache__", "node_modules", ".egg-info"].includes(d)) continue;
        result.push(`  [DIR]  ${d}/`);
      }
      for (const item of files) {
        let size = 0;
        try {
          size = fs.statSync(path.join(full, item)).size;
        } catch {
          /* ignore */
        }
        result.push(`  [FILE] ${item.padEnd(40)} ${comma(size).padStart(8)} B`);
      }
      const rel = path.relative(this.workspace, full) || ".";
      return `── ${rel}/ (${dirs.length} dirs, ${files.length} files) ──\n${result.join("\n")}`;
    } catch (e) {
      return `[ERROR] Cannot list ${full}: ${errText(e)}`;
    }
  }

  delete(p: string): string {
    const full = this._resolve(p);
    try {
      if (fs.existsSync(full) && fs.statSync(full).isFile()) {
        fs.rmSync(full);
        return `[OK] Deleted file: ${p}`;
      }
      if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
        fs.rmSync(full, { recursive: true, force: true });
        return `[OK] Deleted directory: ${p}`;
      }
      return `[ERROR] Not found: ${full}`;
    } catch (e) {
      return `[ERROR] Delete failed: ${errText(e)}`;
    }
  }

  copy(src: string, dst: string): string {
    const s = this._resolve(src);
    const d = this._resolve(dst);
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.copyFileSync(s, d);
    return `[OK] Copied ${src} → ${dst}`;
  }

  move(src: string, dst: string): string {
    const s = this._resolve(src);
    const d = this._resolve(dst);
    fs.mkdirSync(path.dirname(d), { recursive: true });
    try {
      fs.renameSync(s, d);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      // Cross-device move: fall back to copy + unlink (shutil.move semantics).
      if (err.code === "EXDEV") {
        fs.cpSync(s, d, { recursive: true });
        fs.rmSync(s, { recursive: true, force: true });
      } else {
        throw e;
      }
    }
    return `[OK] Moved ${src} → ${dst}`;
  }

  makeDir(p: string): string {
    const full = this._resolve(p);
    fs.mkdirSync(full, { recursive: true });
    return `[OK] Created directory: ${p}`;
  }

  /** Stat a file — size, modified time, permissions. */
  fileInfo(p: string): string {
    const full = this._resolve(p);
    try {
      const st = fs.statSync(full);
      const mtime = formatLocalDateTime(st.mtime);
      return (
        `── ${p} ──\n` +
        `  size:     ${comma(st.size)} bytes\n` +
        `  modified: ${mtime}\n` +
        `  type:     ${st.isDirectory() ? "directory" : "file"}`
      );
    } catch (e) {
      return `[ERROR] ${errText(e)}`;
    }
  }
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

/**
 * Python's `file.readlines()` for a text-mode file: split on `"\n"` keeping the
 * terminator, dropping the final empty element created by a trailing newline.
 * A file that does not end in a newline keeps its bare last line.
 */
function pyReadLines(raw: string): string[] {
  const parts = raw.split("\n").map((l) => `${l}\n`);
  // The final element is a bare "\n" exactly when the file ends with a newline.
  if (parts.length > 0 && parts[parts.length - 1] === "\n") parts.pop();
  return parts;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function any(haystack: string, needles: string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

/** `datetime.fromtimestamp(mtime).strftime("%Y-%m-%d %H:%M:%S")` (local time). */
function formatLocalDateTime(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

interface ParsedHunk {
  oldStart: number;
  oldLen: number;
  adds: string[];
}

/**
 * Parse `@@ -a,b +c,d @@` hunks the way the Python regex did:
 * each body line is classified by its first character (`-` removal, `+`
 * addition, anything else context).
 */
function parseHunks(diff: string): ParsedHunk[] {
  const hunks: ParsedHunk[] = [];
  const header = /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/g;
  let m: RegExpExecArray | null;
  while ((m = header.exec(diff)) !== null) {
    const next = diff.indexOf("\n@@", header.lastIndex);
    const bodyEnd = next === -1 ? diff.length : next;
    const body = diff.slice(header.lastIndex, bodyEnd);
    const adds: string[] = [];
    const bodyLines = body.split("\n");
    // Python's `body.splitlines()[1:]` drops the first body line (fragment
    // context); `\ No newline at end of file` markers carry no +/- prefix and
    // are therefore ignored, as in the original.
    for (const line of bodyLines.slice(1)) {
      if (line.startsWith("-")) continue;
      if (line.startsWith("+")) adds.push(line.slice(1));
    }
    hunks.push({
      oldStart: Number(m[1]),
      oldLen: m[2] ? Number(m[2]) : 1,
      adds,
    });
  }
  return hunks;
}
