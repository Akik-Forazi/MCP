/**
 * AXONIZ CodeTools — source-code intelligence (TypeScript port).
 *
 * Ported from `axoniz/tools/code_tools.py`. Provides linting, formatting,
 * structural visualisation and architectural summaries.
 *
 * Python-stdlib mapping:
 *   subprocess.run(["flake8", …]) -> execFileCaptured (no shell)
 *   subprocess.run(["black", …])  -> execFileCaptured (no shell)
 *   os.walk                       -> recursive fs.readdirSync(withFileTypes)
 *   re.match(r"(class|def)\s+(\w+)") -> /^(?:class|def)\s+([\p{L}\p{N}_]+)/u
 */

import fs from "node:fs";
import path from "node:path";

import { errText, execFileCaptured } from "./_internal.ts";

export class CodeTools {
  readonly workspace: string;

  constructor(workspace = ".") {
    this.workspace = path.resolve(workspace);
  }

  /** Translates a relative path into an absolute system path. */
  _resolve(p: string): string {
    return path.isAbsolute(p) ? p : path.join(this.workspace, p);
  }

  /**
   * Static analysis via `flake8` to surface errors / stylistic
   * inconsistencies in Python code.
   */
  async lint(p: string): Promise<string> {
    const full = this._resolve(p);
    try {
      const res = await execFileCaptured("flake8", [full, "--max-line-length=120"], {
        timeoutMs: 30_000,
        cwd: this.workspace,
      });
      const out = res.stdout.trim();
      return out.length > 0 ? `Linting Analysis for ${full}:\n${out}` : `No stylistic issues detected in ${full}.`;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err && err.code === "ENOENT") {
        return "The 'flake8' utility is not installed. Please run: pip install flake8";
      }
      return `An unexpected error occurred during linting: ${errText(e)}`;
    }
  }

  /** Reformat Python source with `black`. */
  async formatCode(p: string): Promise<string> {
    const full = this._resolve(p);
    try {
      const res = await execFileCaptured("black", [full], {
        timeoutMs: 10_000,
        cwd: this.workspace,
      });
      return `Code Formatting Result for ${full}:\n${res.stdout || res.stderr}`;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err && err.code === "ENOENT") {
        return "The 'black' formatter is not installed. Please run: pip install black";
      }
      return `Formatting failed due to an error: ${errText(e)}`;
    }
  }

  /** Visual directory structure to expose the project's physical layout. */
  tree(p = ".", maxDepth = 4): string {
    const full = this._resolve(p);
    const lines: string[] = [`${full}/`];

    const walk = (directory: string, prefix: string, depth: number): void => {
      if (depth > maxDepth) return;
      let items: string[];
      try {
        items = fs.readdirSync(directory).slice().sort();
      } catch {
        // PermissionError in Python -> silently stop.
        return;
      }

      // Exclude non-essential directories to reduce noise.
      const ignore = new Set([".git", "__pycache__", "node_modules", ".venv", "venv", ".axoniz"]);
      items = items.filter((i) => !ignore.has(i));

      items.forEach((item, i) => {
        const isLast = i === items.length - 1;
        const connector = isLast ? "└── " : "├── ";
        const fullPath = path.join(directory, item);
        lines.push(`${prefix}${connector}${item}`);
        let isDir = false;
        try {
          isDir = fs.statSync(fullPath).isDirectory();
        } catch {
          isDir = false;
        }
        if (isDir) {
          const extension = isLast ? "    " : "│   ";
          walk(fullPath, prefix + extension, depth + 1);
        }
      });
    };

    walk(full, "", 1);
    return lines.join("\n");
  }

  /**
   * Scan Python sources and extract structural information (classes and
   * function definitions) as a high-level architectural summary.
   */
  analyze(p = "."): string {
    const full = this._resolve(p);
    const summary: string[] = [`Architectural Overview: ${full}`];

    const filesToScan: string[] = [];
    let isFile = false;
    try {
      isFile = fs.statSync(full).isFile();
    } catch {
      isFile = false;
    }

    if (isFile) {
      if (full.endsWith(".py")) filesToScan.push(full);
    } else {
      for (const root of walkDirs(full)) {
        // Skip internal data and temporary folders.
        if ([".git", "__pycache__", ".axoniz"].some((x) => root.includes(x))) continue;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(root, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const ent of entries) {
          if (ent.isFile() && ent.name.endsWith(".py")) {
            filesToScan.push(path.join(root, ent.name));
          }
        }
      }
    }

    if (filesToScan.length === 0) {
      return `${summary[0]} - No Python source files were found in this directory.`;
    }

    for (const fpath of filesToScan) {
      const rel = path.relative(this.workspace, fpath);
      summary.push(`\nSource File: ${rel}`);
      try {
        const raw = fs.readFileSync(fpath, "utf8");
        for (const rawLine of raw.split("\n")) {
          const line = rawLine.trim();
          if (line.startsWith("class ") || line.startsWith("def ")) {
            const m = /^(class|def)\s+([\p{L}\p{N}_]+)/u.exec(line);
            if (m) summary.push(`  [${m[1]!.toUpperCase()}] ${m[2]!}`);
          }
        }
      } catch (e) {
        summary.push(`  [ERROR] Failed to read file structure: ${errText(e)}`);
      }
    }

    return summary.join("\n");
  }
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

/** Depth-first directory walk mirroring `os.walk` (top-down, root first). */
function* walkDirs(root: string): Generator<string> {
  let isDir = false;
  try {
    isDir = fs.statSync(root).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) return;
  yield root;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.isDirectory()) yield* walkDirs(path.join(root, ent.name));
  }
}
