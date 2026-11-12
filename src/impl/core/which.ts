/**
 * Cross-platform `which` implementation (replacing shutil.which).
 */
import fs from "node:fs";
import path from "node:path";

export function whichSync(cmd: string): string | null {
  if (!cmd) return null;
  if (cmd.includes(path.sep) || cmd.includes("/")) {
    try {
      return fs.existsSync(cmd) ? cmd : null;
    } catch {
      return null;
    }
  }

  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}
