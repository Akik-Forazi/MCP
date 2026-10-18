/**
 * Toolbox subset/merge tests — the primitives behind `serve --read-only`,
 * `--no-network` and the "all" group.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { Toolbox } from "../src/core/toolbox.ts";

function sample(): Toolbox {
  const tb = new Toolbox();
  tb.register("a", "tool a", {}, [], () => "a", { destructive: true });
  tb.register("b", "tool b", {}, [], () => "b", { network: true });
  tb.register("c", "tool c", {}, [], () => "c");
  return tb;
}

test("subset keeps only matching tools and their handlers", async () => {
  const tb = sample().subset((_s, m) => m.destructive !== true);
  assert.deepEqual(tb.names().sort(), ["b", "c"]);
  assert.equal(await tb.call("a"), "[ERROR] Unknown tool: a");
  assert.equal(await tb.call("c"), "c");
});

test("subset preserves meta", () => {
  const tb = sample().subset(() => true);
  assert.deepEqual(tb.meta("b"), { network: true });
});

test("merge dedups by name, this side wins", async () => {
  const left = new Toolbox().register("x", "left x", {}, [], () => "left");
  const right = new Toolbox()
    .register("x", "right x", {}, [], () => "right")
    .register("y", "right y", {}, [], () => "right y");
  const merged = left.merge(right);
  assert.deepEqual(merged.names().sort(), ["x", "y"]);
  assert.equal(await merged.call("x"), "left");
  assert.equal(await merged.call("y"), "right y");
});
