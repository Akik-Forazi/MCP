/**
 * Code tool wrappers — binds axoniz `CodeTools` to code_tree / code_analyze
 * (plus python-only lint/format) tools.
 */

import type { CodeTools } from "@fraziym/axoniz/tools";

import { argInt, argStr } from "../core/args.ts";
import type { Toolbox } from "../core/toolbox.ts";

const S = (description: string) => ({ type: "string", description });
const I = (description: string) => ({ type: "integer", description });

export function registerCodeTools(tb: Toolbox, ct: CodeTools): void {
  tb.register(
    "code_tree",
    "Show a file/directory tree of the workspace.",
    { path: S('Directory path (default ".")'), max_depth: I("Max depth (default 4)") },
    [],
    (args) => ct.tree(argStr(args, "path", "."), argInt(args, "max_depth", 4)),
  );

  tb.register(
    "code_analyze",
    "List classes/functions found in Python files under a path.",
    { path: S('Directory path (default ".")') },
    [],
    (args) => ct.analyze(argStr(args, "path", ".")),
  );

  tb.register(
    "code_lint",
    "Lint a Python file with flake8.",
    { path: S("Python file path") },
    ["path"],
    (args) => ct.lint(argStr(args, "path")),
  );

  tb.register(
    "code_format",
    "Format a Python file with black.",
    { path: S("Python file path") },
    ["path"],
    (args) => ct.formatCode(argStr(args, "path")),
    { destructive: true },
  );
}
