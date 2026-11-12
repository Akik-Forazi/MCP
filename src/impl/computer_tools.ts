/**
 * AXONIZ ComputerTools — GUI awareness and control (TypeScript port).
 *
 * Ported from `axoniz/tools/computer_tools.py`.
 *
 * Python dependency mapping:
 *   pyautogui (mouse/keyboard) -> PowerShell P/Invoke against the Win32 API
 *     (`SetCursorPos`, `mouse_event`, `keybd_event`). There is no npm
 *     dependency available for GUI input, and this project must not gain new
 *     ones, so the Win32 calls are driven through `Add-Type`. On non-Windows
 *     hosts these capabilities genuinely cannot be provided and every input
 *     method returns a clear `[ERROR] ... not supported in this build` string
 *     instead of throwing, per the port contract.
 *   pyautogui.screenshot / Pillow -> `screenshot-desktop`
 *   pytesseract / Tesseract-OCR   -> the `tesseract` binary via execFile
 *
 * Screen capture works on Windows/macOS/Linux through `screenshot-desktop`;
 * input control and screen-size queries are Windows-only in this build.
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import { whichSync } from "./core/which.ts";
import { errText, execFileCaptured } from "./_internal.ts";

/** `screenshot-desktop` is CommonJS and ships no type declarations. */
type ScreenshotFn = (opts?: { filename?: string; format?: string }) => Promise<unknown>;

const requireCjs = createRequire(import.meta.url);

/** Common pyautogui key names -> Windows virtual-key codes. */
const VK_CODES: Record<string, number> = {
  enter: 0x0d,
  return: 0x0d,
  tab: 0x09,
  esc: 0x1b,
  escape: 0x1b,
  space: 0x20,
  backspace: 0x08,
  delete: 0x2e,
  del: 0x2e,
  insert: 0x2d,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
  up: 0x26,
  down: 0x28,
  left: 0x25,
  right: 0x27,
  shift: 0x10,
  ctrl: 0x11,
  control: 0x11,
  alt: 0x12,
  win: 0x5b,
  capslock: 0x14,
  f1: 0x70,
  f2: 0x71,
  f3: 0x72,
  f4: 0x73,
  f5: 0x74,
  f6: 0x75,
  f7: 0x76,
  f8: 0x77,
  f9: 0x78,
  f10: 0x79,
  f11: 0x7a,
  f12: 0x7b,
};

const NOT_SUPPORTED =
  "[ERROR] Mouse/keyboard control is not supported in this build (no pyautogui equivalent is available on Node; Win32 input control requires Windows).";

/** P/Invoke prelude shared by every input script. */
const WIN32_PRELUDE = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace Axn -Name Ui -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, System.UIntPtr dwExtraInfo);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);
public static void Move(int x, int y) { SetCursorPos(x, y); }
public static void Press(uint down, uint up) { mouse_event(down, 0, 0, 0, System.UIntPtr.Zero); mouse_event(up, 0, 0, 0, System.UIntPtr.Zero); }
public static void Key(byte vk) { keybd_event(vk, 0, 0, System.UIntPtr.Zero); keybd_event(vk, 0, 2, System.UIntPtr.Zero); }
'@
`;

interface InputResult {
  ok: boolean;
  message: string;
}

export class ComputerTools {
  readonly workspace: string;

  private _available: boolean | null = null;
  private _screenSize: [number, number] = [0, 0];
  private _capture: ScreenshotFn | null | undefined;

  constructor(workspace = ".") {
    this.workspace = path.resolve(workspace);
  }

  /* ── capability detection ──────────────────────────────────────────────── */

  /** True when a PowerShell host exists for the Win32 input path. */
  private _inputBackend(): boolean {
    return process.platform === "win32" && Boolean(whichSync("powershell") ?? whichSync("pwsh"));
  }

  /** Screen capture works wherever `screenshot-desktop` can load its backend. */
  private _captureBackend(): boolean {
    return (
      process.platform === "win32" ||
      process.platform === "darwin" ||
      process.platform === "linux"
    );
  }

  private async _loadCapture(): Promise<ScreenshotFn | null> {
    if (this._capture !== undefined) return this._capture;
    try {
      // CommonJS package without bundled types; loaded through createRequire.
      const mod = requireCjs("screenshot-desktop") as unknown;
      const candidate = typeof mod === "function" ? mod : (mod as { default?: unknown }).default;
      this._capture = typeof candidate === "function" ? (candidate as ScreenshotFn) : null;
    } catch {
      this._capture = null;
    }
    return this._capture;
  }

  /** Mirrors `_check_deps()`: probes the input backend once and caches it. */
  _check_deps(): boolean {
    if (this._available !== null) return this._available;
    this._available = this._inputBackend();
    if (this._available) this._readScreenSize();
    return this._available;
  }

  private _readScreenSize(): void {
    const size = this._runInputScript(`
Add-Type -AssemblyName System.Windows.Forms
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
Write-Output ($b.Width.ToString() + 'x' + $b.Height.ToString())
`);
    if (size.ok) {
      const m = /^(\d+)x(\d+)$/.exec(size.message.trim());
      if (m) this._screenSize = [Number(m[1]), Number(m[2])];
    }
  }

  /** Run an input script through PowerShell, returning trimmed stdout. */
  private _runInputScript(body: string): InputResult {
    if (!this._inputBackend()) return { ok: false, message: NOT_SUPPORTED };
    const host = whichSync("powershell") ?? whichSync("pwsh");
    if (!host) return { ok: false, message: NOT_SUPPORTED };
    const script = `${WIN32_PRELUDE}\n${body}`;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const res = spawnSync(
      host,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { timeout: 20_000, windowsHide: true, encoding: "utf8" },
    );
    if (res.error) {
      const e = res.error as NodeJS.ErrnoException;
      if (e.code === "ETIMEDOUT") return { ok: false, message: "[ERROR] input command timed out" };
      return { ok: false, message: `[ERROR] ${e.message}` };
    }
    const stdout = typeof res.stdout === "string" ? res.stdout : "";
    const stderr = typeof res.stderr === "string" ? res.stderr : "";
    if (res.status !== 0) {
      const detail = (stderr || stdout).trim().split("\n").slice(0, 4).join(" ").slice(0, 300);
      return { ok: false, message: `[ERROR] ${detail || `exit ${res.status}`}` };
    }
    return { ok: true, message: stdout.trim() };
  }

  /* ── mouse ─────────────────────────────────────────────────────────────── */

  /** Move the mouse to absolute coordinates (x, y). */
  mouse_move(x: number, y: number): string {
    if (!this._check_deps()) return NOT_SUPPORTED;
    const res = this._runInputScript(`[Axn.Ui]::Move(${Math.trunc(x)}, ${Math.trunc(y)})`);
    return res.ok ? `[OK] Mouse moved to (${x}, ${y})` : `[ERROR] mouse_move failed: ${res.message}`;
  }

  /** Click at (x, y), or at the current position when omitted. */
  mouse_click(x?: number | null, y?: number | null, button = "left"): string {
    if (!this._check_deps()) return NOT_SUPPORTED;
    const down = buttonFlagDown(button);
    const up = buttonFlagUp(button);
    if (down === null || up === null) {
      return `[ERROR] mouse_click failed: unsupported button '${button}'`;
    }
    const hasX = x !== null && x !== undefined;
    const hasY = y !== null && y !== undefined;
    const move = hasX || hasY ? `[Axn.Ui]::Move(${Math.trunc(Number(x ?? 0))}, ${Math.trunc(Number(y ?? 0))})\n` : "";
    const res = this._runInputScript(`${move}[Axn.Ui]::Press(${down}, ${up})`);
    const label = button.charAt(0).toUpperCase() + button.slice(1);
    return res.ok
      ? `[OK] ${label} click at (${hasX ? x : "current"}, ${hasY ? y : "current"})`
      : `[ERROR] mouse_click failed: ${res.message}`;
  }

  /* ── keyboard ──────────────────────────────────────────────────────────── */

  /** Type text, forwarding it to the focused window as key events. */
  key_type(text: string, interval = 0.05): string {
    if (!this._check_deps()) return NOT_SUPPORTED;
    void interval; // SendKeys has no per-key delay; accepted for API parity.
    // Literal text is base64-encoded and decoded to UTF-16 in PowerShell, so
    // SendKeys metacharacters (+ ^ % ~ ( ) { } [ ]) are escaped safely.
    const b64 = Buffer.from(text, "utf8").toString("base64");
    const res = this._runInputScript(`
Add-Type -AssemblyName System.Windows.Forms
$t = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}'))
[System.Windows.Forms.SendKeys]::SendWait(($t -replace '([+^%~(){}[\\]])', '{$1}'))
`);
    const preview = text.slice(0, 20);
    return res.ok ? `[OK] Typed: '${preview}...'` : `[ERROR] key_type failed: ${res.message}`;
  }

  /** Press a special key (e.g. 'enter', 'esc', 'ctrl', 'alt'). */
  key_press(key: string): string {
    if (!this._check_deps()) return NOT_SUPPORTED;
    const vk = VK_CODES[key.trim().toLowerCase()];
    if (vk === undefined) {
      return `[ERROR] key_press failed: unknown key '${key}'`;
    }
    const res = this._runInputScript(`[Axn.Ui]::Key(${vk})`);
    return res.ok ? `[OK] Pressed: ${key}` : `[ERROR] key_press failed: ${res.message}`;
  }

  /* ── screen ────────────────────────────────────────────────────────────── */

  /** Get the primary monitor resolution. */
  screen_size(): string {
    if (!this._check_deps()) return NOT_SUPPORTED;
    return `Resolution: ${this._screenSize[0]}x${this._screenSize[1]}`;
  }

  /** Take a screenshot and save it into the workspace. */
  async screen_capture(filename = "screenshot.png"): Promise<string> {
    if (!this._captureBackend()) {
      return "[ERROR] Screen capture is not supported on this platform in this build.";
    }
    const shot = await this._loadCapture();
    if (!shot) {
      return "[ERROR] The 'screenshot-desktop' backend could not be loaded; screen capture is unavailable.";
    }
    const full = path.isAbsolute(filename) ? filename : path.join(this.workspace, filename);
    try {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      await shot({ filename: full, format: "png" });
      const buf = fs.readFileSync(full);
      const dims = pngDimensions(buf);
      const w = dims ? dims[0] : 0;
      const h = dims ? dims[1] : 0;
      return `[OK] Screenshot saved to ${full} (${w}x${h})`;
    } catch (e) {
      return `[ERROR] screen_capture failed: ${errText(e)}`;
    }
  }

  /**
   * Find the coordinates of text on screen using OCR.
   * Requires the `tesseract` binary; if it is absent a clear error string is
   * returned (the Python version raised ImportError for pytesseract).
   */
  async screen_find_text(text: string): Promise<string> {
    if (!this._captureBackend()) {
      return "[ERROR] Screen capture is not supported on this platform in this build.";
    }
    const shot = await this._loadCapture();
    if (!shot) return "[ERROR] Dependencies missing.";
    const tesseract = whichSync("tesseract");
    if (!tesseract) {
      return "[ERROR] 'tesseract' not installed. Install Tesseract-OCR and ensure it is on PATH.";
    }
    const tmp = path.join(this.workspace, `.axoniz_ocr_${process.pid}_${Date.now()}.png`);
    try {
      await shot({ filename: tmp, format: "png" });
      const res = await execFileCaptured(tesseract, [tmp, "stdout", "tsv"], { timeoutMs: 60_000 });
      const target = text.toLowerCase();
      for (const line of res.stdout.split("\n")) {
        const cols = line.split("\t");
        if (cols.length < 12) continue;
        const word = cols[11] ?? "";
        if (word.length === 0) continue;
        if (target.includes(word.toLowerCase()) || word.toLowerCase().includes(target)) {
          const left = Number(cols[6] ?? 0);
          const top = Number(cols[7] ?? 0);
          const width = Number(cols[8] ?? 0);
          const height = Number(cols[9] ?? 0);
          const x = left + Math.floor(width / 2);
          const y = top + Math.floor(height / 2);
          return `[OK] Found '${text}' at (${x}, ${y})`;
        }
      }
      return `[NOT FOUND] Text '${text}' not visible on screen.`;
    } catch (e) {
      return `[ERROR] screen_find_text failed: ${errText(e)}`;
    } finally {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
    }
  }

  /** Tool-name -> callable map, mirroring `as_tool_map()`. */
  as_tool_map(): Record<string, (...args: never[]) => unknown> {
    return {
      mouse_move: this.mouse_move.bind(this) as (...args: never[]) => unknown,
      mouse_click: this.mouse_click.bind(this) as (...args: never[]) => unknown,
      key_type: this.key_type.bind(this) as (...args: never[]) => unknown,
      key_press: this.key_press.bind(this) as (...args: never[]) => unknown,
      screen_size: this.screen_size.bind(this) as (...args: never[]) => unknown,
      screen_capture: this.screen_capture.bind(this) as (...args: never[]) => unknown,
      screen_find: this.screen_find_text.bind(this) as (...args: never[]) => unknown,
    };
  }

  /** camelCase alias of `as_tool_map()` for TypeScript call sites. */
  asToolMap(): Record<string, (...args: never[]) => unknown> {
    return this.as_tool_map();
  }
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

/** MOUSEEVENTF_* down/up flag pairs for the requested button. */
function buttonFlagDown(button: string): number | null {
  switch (button.toLowerCase()) {
    case "left":
      return 0x0002;
    case "right":
      return 0x0008;
    case "middle":
      return 0x0020;
    default:
      return null;
  }
}

function buttonFlagUp(button: string): number | null {
  switch (button.toLowerCase()) {
    case "left":
      return 0x0004;
    case "right":
      return 0x0010;
    case "middle":
      return 0x0040;
    default:
      return null;
  }
}

/** Width/height from a PNG IHDR chunk, or null when the buffer is not a PNG. */
function pngDimensions(buf: Buffer): [number, number] | null {
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (w === 0 || h === 0) return null;
  return [w, h];
}
