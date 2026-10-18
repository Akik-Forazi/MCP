/**
 * File tool wrappers — binds axoniz `FileTools` (workspace-confined) to
 * LLM-callable file_* tools.
 */

import type { FileTools } from "@fraziym/axoniz/tools";

import { argInt, argStr } from "../core/args.ts";
import type { Toolbox } from "../core/toolbox.ts";

const S = (description: string) => ({ type: "string", description });
const I = (description: string) => ({ type: "integer", description });

export function registerFileTools(tb: Toolbox, ft: FileTools): void {
  tb.register(
    "file_read",
    "Read a file with line numbers. Optional start_line/end_line range.",
    { path: S("File path (relative to workspace)"), start_line: I("First line (1-based)"), end_line: I("Last line") },
    ["path"],
    (args) => {
      const start = args.start_line === undefined || args.start_line === null ? null : argInt(args, "start_line", 1);
      const end = args.end_line === undefined || args.end_line === null ? null : argInt(args, "end_line", 1);
      return ft.read(argStr(args, "path"), start, end);
    },
  );

  tb.register(
    "file_write",
    "Write/overwrite a file (auto-creates directories).",
    { path: S("File path"), content: S("Full file content") },
    ["path", "content"],
    (args) => ft.write(argStr(args, "path"), argStr(args, "content")),
    { destructive: true },
  );

  tb.register(
    "file_edit",
    "Find-and-replace inside a file (whitespace-tolerant, shows diff).",
    { path: S("File path"), old: S("Exact text to find"), new: S("Replacement text") },
    ["path", "old", "new"],
    (args) => ft.edit(argStr(args, "path"), argStr(args, "old"), argStr(args, "new")),
    { destructive: true },
  );

  tb.register(
    "file_append",
    "Append text to the end of a file.",
    { path: S("File path"), content: S("Text to append") },
    ["path", "content"],
    (args) => ft.append(argStr(args, "path"), argStr(args, "content")),
    { destructive: true },
  );

  tb.register(
    "file_patch",
    "Apply a unified diff patch to a file.",
    { path: S("File path"), patch: S("Unified diff hunk text") },
    ["path", "patch"],
    (args) => ft.patch(argStr(args, "path"), argStr(args, "patch")),
    { destructive: true },
  );

  tb.register(
    "file_delete",
    "Delete a file or directory.",
    { path: S("File or directory path") },
    ["path"],
    (args) => ft.delete(argStr(args, "path")),
    { destructive: true },
  );

  tb.register(
    "file_list",
    "List directory contents.",
    { path: S('Directory path (default ".")') },
    [],
    (args) => ft.listDir(argStr(args, "path", ".")),
  );

  tb.register(
    "file_search",
    "Find files matching a glob pattern (e.g. *.ts, **/*.json).",
    { pattern: S("Glob pattern"), path: S('Base directory (default ".")') },
    ["pattern"],
    (args) => ft.search(argStr(args, "path", "."), argStr(args, "pattern")),
  );

  tb.register(
    "file_grep",
    "Search file contents for a text/regex pattern (like ripgrep).",
    {
      pattern: S("Regex or literal to search for"),
      path: S('Base directory (default ".")'),
      file_pattern: S('Glob filter for files (default "*")'),
      case_sensitive: { type: "boolean", description: "Case-sensitive match (default true)" },
      max_results: I("Max matched lines (default 50)"),
    },
    ["pattern"],
    (args) =>
      ft.grep(
        argStr(args, "path", "."),
        argStr(args, "pattern"),
        argStr(args, "file_pattern", "*"),
        args.case_sensitive === undefined ? true : args.case_sensitive === true || args.case_sensitive === "true",
        argInt(args, "max_results", 50),
      ),
  );
}
