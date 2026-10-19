/**
 * Filesystem-path arguments per tool, shared by the guard (jailing) and the
 * schema layer (declarative `maxLength`), so published tools/list schemas
 * advertise the same cap the server enforces.
 */

export const PATH_ARGS: Record<string, string[]> = {
  file_read: ["path"],
  file_write: ["path"],
  file_edit: ["path"],
  file_append: ["path"],
  file_patch: ["path"],
  file_delete: ["path"],
  file_list: ["path"],
  file_search: ["path"],
  file_grep: ["path"],
  code_tree: ["path"],
  code_analyze: ["path"],
  code_lint: ["path"],
  code_format: ["path"],
  git_diff: ["path"],
  git_add: ["path"],
  screen_capture: ["filename"],
};

/** Hard cap for filesystem-path arguments (well above any real path length). */
export const PATH_ARG_MAX = 4096;
