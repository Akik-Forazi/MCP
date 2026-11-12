/**
 * Computer tools — mouse, keyboard, and screen control via axoniz `ComputerTools`.
 * Relies on axoniz's optional screen/input dependencies; failures surface as
 * error strings rather than throws.
 */

import type { ComputerTools } from "@fraziym/axoniz/tools";

import { argInt, argStr } from "../core/args.ts";
import type { Toolbox } from "../core/toolbox.ts";

const S = (description: string) => ({ type: "string", description });
const I = (description: string) => ({ type: "integer", description });

const INPUT_META = { destructive: true };

export function registerComputerTools(tb: Toolbox, ct: ComputerTools): void {
  tb.register(
    "mouse_move",
    "Move the mouse cursor to absolute screen coordinates.",
    { x: I("X coordinate"), y: I("Y coordinate") },
    ["x", "y"],
    (args) => ct.mouse_move(argInt(args, "x", 0), argInt(args, "y", 0)),
    INPUT_META,
  );

  tb.register(
    "mouse_click",
    "Click the mouse, optionally moving to absolute coordinates first.",
    {
      x: I("X coordinate (optional)"),
      y: I("Y coordinate (optional)"),
      button: S('Button: "left" (default), "right", "middle"'),
    },
    [],
    (args) => {
      const x = args.x === undefined || args.x === null ? undefined : argInt(args, "x", 0);
      const y = args.y === undefined || args.y === null ? undefined : argInt(args, "y", 0);
      return ct.mouse_click(x, y, argStr(args, "button", "left"));
    },
    INPUT_META,
  );

  tb.register(
    "key_type",
    "Type a text string via the keyboard.",
    {
      text: S("Text to type"),
      interval: { type: "number", description: "Seconds between keystrokes (default 0.02)" },
    },
    ["text"],
    (args) => {
      const interval = typeof args.interval === "number" ? args.interval : undefined;
      return ct.key_type(argStr(args, "text"), interval);
    },
    INPUT_META,
  );

  tb.register(
    "key_press",
    'Press a single key or hotkey combo (e.g. "enter", "ctrl+c").',
    { key: S("Key or combo name") },
    ["key"],
    (args) => ct.key_press(argStr(args, "key")),
    INPUT_META,
  );

  tb.register("screen_size", "Get the primary screen resolution.", {}, [], () => ct.screen_size());

  tb.register(
    "screen_capture",
    "Capture a screenshot of the screen to a PNG file.",
    { filename: S('Output filename (default "screenshot.png")') },
    [],
    (args) => ct.screen_capture(argStr(args, "filename", "screenshot.png")),
  );

  tb.register(
    "screen_find",
    "Find text on screen via OCR; returns its coordinates.",
    { text: S("Text to look for") },
    ["text"],
    (args) => ct.screen_find_text(argStr(args, "text")),
  );
}
