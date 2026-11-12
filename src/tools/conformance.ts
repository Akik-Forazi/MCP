/**
 * Conformance fixtures — the MCP spec test surface used by the official
 * conformance suite (and our CI). Registered only when `serve --conformance`
 * is set; the default product never advertises these names.
 *
 * The fixture names/URIs are fixed by the suite's scenario definitions
 * (modelcontextprotocol/conformance): `test_simple_text`, `test_sampling`,
 * `test://static-text`, `test_simple_prompt`, … plus SEP-1034/1330
 * elicitation schemas, the SEP-1699 `test_reconnection` tool and the
 * SEP-1613 JSON Schema 2020-12 tool.
 *
 * These exercise real protocol machinery — content blocks, progress/logging
 * notifications, server→client sampling/elicitation requests, SSE stream
 * close/resume — not mock features. The evidence: our CI runs the official
 * suite against this mode.
 */

import { Toolbox } from "../core/toolbox.ts";
import type { ToolCallContext, ToolFunctionSchema } from "../core/types.ts";
import type {
  CompletionResult,
  GetPromptResult,
  PromptDef,
  PromptMessage,
  ResourceContents,
  ResourceDef,
  ResourceTemplateDef,
} from "../core/features.ts";
import { PromptArgumentError, PromptNotFoundError, ResourceNotFoundError } from "../core/features.ts";

const S = (description: string) => ({ type: "string", description });

/** 1×1 red PNG. */
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Minimal valid 8-bit mono PCM WAV (16 zero samples at 8 kHz). */
function tinyWav(): string {
  const sampleRate = 8000;
  const samples = Buffer.alloc(16, 0);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + samples.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]).toString("base64");
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function text(role: "user" | "assistant", t: string): PromptMessage {
  return { role, content: { type: "text", text: t } };
}

/** The SEP-1613 tool schema, preserved verbatim through tools/list. */
const JSON_SCHEMA_2020_12_SPEC: ToolFunctionSchema = {
  type: "function",
  function: {
    name: "json_schema_2020_12_tool",
    description: "Tool with JSON Schema 2020-12 features",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        address: { $ref: "#/$defs/address" } as never,
      },
      required: [],
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: {
        address: {
          type: "object",
          properties: { street: { type: "string" }, city: { type: "string" } },
        },
      },
      additionalProperties: false,
    } as never,
  },
};

function elicitSummary(action: unknown, content: unknown): string {
  return `Elicitation completed: action=${String(action)}, content=${JSON.stringify(content ?? null)}`;
}

export class ConformanceFixtures {
  readonly toolbox = new Toolbox();

  constructor() {
    const tb = this.toolbox;

    tb.register("test_simple_text", "Conformance: returns simple text content.", {}, [], () => "This is a simple text response for testing.");

    tb.register("test_image_content", "Conformance: returns an image content block.", {}, [], () => [
      { type: "image", data: PNG_1PX, mimeType: "image/png" },
    ]);

    tb.register("test_audio_content", "Conformance: returns an audio content block.", {}, [], () => [
      { type: "audio", data: tinyWav(), mimeType: "audio/wav" },
    ]);

    tb.register("test_embedded_resource", "Conformance: returns an embedded resource content block.", {}, [], () => [
      {
        type: "resource",
        resource: { uri: "test://embedded-resource", mimeType: "text/plain", text: "This is an embedded resource content." },
      },
    ]);

    tb.register("test_multiple_content_types", "Conformance: returns text + image + resource blocks.", {}, [], () => [
      { type: "text", text: "Multiple content types test:" },
      { type: "image", data: PNG_1PX, mimeType: "image/png" },
      {
        type: "resource",
        resource: { uri: "test://mixed-content-resource", mimeType: "application/json", text: '{"test":"data","value":123}' },
      },
    ]);

    tb.register("test_error_handling", "Conformance: always returns an error result.", {}, [], () => {
      throw new Error("This tool intentionally returns an error for testing");
    });

    tb.register("test_tool_with_logging", "Conformance: emits 3 log notifications during execution.", {}, [], async (_args, ctx: ToolCallContext | undefined) => {
      ctx?.log?.("info", "Tool execution started");
      await sleep(60);
      ctx?.log?.("info", "Tool processing data");
      await sleep(60);
      ctx?.log?.("info", "Tool execution completed");
      return "Tool with logging completed successfully";
    });

    tb.register("test_tool_with_progress", "Conformance: reports 0/50/100 progress when a token is supplied.", {}, [], async (_args, ctx: ToolCallContext | undefined) => {
      ctx?.progress?.(0, 100);
      await sleep(60);
      ctx?.progress?.(50, 100);
      await sleep(60);
      ctx?.progress?.(100, 100);
      return "Tool with progress completed successfully";
    });

    tb.register(
      "test_sampling",
      "Conformance: requests an LLM completion from the client (sampling/createMessage).",
      { prompt: S("The prompt to send to the LLM") },
      ["prompt"],
      async (args, ctx: ToolCallContext | undefined) => {
        if (!ctx?.sample) {
          return "[ERROR] test_sampling: client did not declare the sampling capability";
        }
        const prompt = String(args.prompt ?? "");
        const result = (await ctx.sample({
          messages: [{ role: "user", content: { type: "text", text: prompt } }],
          maxTokens: 100,
        })) as { content?: { text?: string } };
        return `LLM response: ${result?.content?.text ?? ""}`;
      },
    );

    tb.register(
      "test_elicitation",
      "Conformance: requests user input from the client (elicitation/create).",
      { message: S("The message to show the user") },
      ["message"],
      async (args, ctx: ToolCallContext | undefined) => {
        if (!ctx?.elicit) {
          return "[ERROR] test_elicitation: client did not declare the elicitation capability";
        }
        const result = (await ctx.elicit({
          message: String(args.message ?? ""),
          requestedSchema: {
            type: "object",
            properties: {
              username: { type: "string", description: "User's response" },
              email: { type: "string", description: "User's email address" },
            },
            required: ["username", "email"],
          },
        })) as { action?: unknown; content?: unknown };
        return `User response: action=${String(result?.action)}, content=${JSON.stringify(result?.content ?? null)}`;
      },
    );

    tb.register(
      "test_elicitation_sep1034_defaults",
      "Conformance: elicitation schema with default values for all primitive types (SEP-1034).",
      {},
      [],
      async (_args, ctx: ToolCallContext | undefined) => {
        if (!ctx?.elicit) {
          return "[ERROR] test_elicitation_sep1034_defaults: client did not declare the elicitation capability";
        }
        const result = (await ctx.elicit({
          message: "Please provide your information",
          requestedSchema: {
            type: "object",
            properties: {
              name: { type: "string", default: "John Doe" },
              age: { type: "integer", default: 30 },
              score: { type: "number", default: 95.5 },
              status: { type: "string", enum: ["active", "inactive", "pending"], default: "active" },
              verified: { type: "boolean", default: true },
            },
          },
        })) as { action?: unknown; content?: unknown };
        return elicitSummary(result?.action, result?.content);
      },
    );

    tb.register(
      "test_elicitation_sep1330_enums",
      "Conformance: elicitation schemas with all 5 enum variants (SEP-1330).",
      {},
      [],
      async (_args, ctx: ToolCallContext | undefined) => {
        if (!ctx?.elicit) {
          return "[ERROR] test_elicitation_sep1330_enums: client did not declare the elicitation capability";
        }
        const result = (await ctx.elicit({
          message: "Please choose from each enum",
          requestedSchema: {
            type: "object",
            properties: {
              untitledSingle: { type: "string", enum: ["option1", "option2", "option3"] },
              titledSingle: {
                type: "string",
                oneOf: [
                  { const: "value1", title: "First Option" },
                  { const: "value2", title: "Second Option" },
                  { const: "value3", title: "Third Option" },
                ],
              },
              legacyEnum: { type: "string", enum: ["opt1", "opt2", "opt3"], enumNames: ["Option One", "Option Two", "Option Three"] },
              untitledMulti: { type: "array", items: { type: "string", enum: ["option1", "option2", "option3"] } },
              titledMulti: {
                type: "array",
                items: {
                  anyOf: [
                    { const: "value1", title: "First Choice" },
                    { const: "value2", title: "Second Choice" },
                    { const: "value3", title: "Third Choice" },
                  ],
                },
              },
            },
          },
        })) as { action?: unknown; content?: unknown };
        return elicitSummary(result?.action, result?.content);
      },
    );

    tb.register(
      "test_reconnection",
      "Conformance: closes the SSE stream mid-call so the client must resume with Last-Event-ID (SEP-1699).",
      {},
      [],
      async (_args, ctx: ToolCallContext | undefined) => {
        ctx?.closeStream?.();
        await sleep(50);
        return "Tool call completed after stream reconnection";
      },
    );

    this.toolbox.registerSpec(JSON_SCHEMA_2020_12_SPEC, () => "ok");
  }

  listResources(): ResourceDef[] {
    return [
      { uri: "test://static-text", name: "Static Text", description: "Conformance: static text resource.", mimeType: "text/plain" },
      { uri: "test://static-binary", name: "Static Binary", description: "Conformance: static binary (PNG) resource.", mimeType: "image/png" },
    ];
  }

  listResourceTemplates(): ResourceTemplateDef[] {
    return [
      {
        uriTemplate: "test://template/{id}/data",
        name: "Template Data",
        description: "Conformance: parameterized resource (substitutes {id}).",
        mimeType: "application/json",
      },
    ];
  }

  readResource(uri: string): ResourceContents {
    if (uri === "test://static-text") {
      return { uri, mimeType: "text/plain", text: "This is the content of the static text resource." };
    }
    if (uri === "test://static-binary") {
      return { uri, mimeType: "image/png", blob: PNG_1PX };
    }
    const m = /^test:\/\/template\/([^/]+)\/data$/.exec(uri);
    if (m) {
      const id = decodeURIComponent(m[1] ?? "");
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify({ id, templateTest: true, data: `Data for ID: ${id}` }),
      };
    }
    throw new ResourceNotFoundError(uri);
  }

  listPrompts(): PromptDef[] {
    return [
      { name: "test_simple_prompt", description: "Conformance: simple prompt without arguments." },
      {
        name: "test_prompt_with_arguments",
        description: "Conformance: parameterized prompt (arg1, arg2).",
        arguments: [
          { name: "arg1", description: "First test argument", required: true },
          { name: "arg2", description: "Second test argument", required: true },
        ],
      },
      {
        name: "test_prompt_with_embedded_resource",
        description: "Conformance: prompt embedding a resource.",
        arguments: [{ name: "resourceUri", description: "URI of the resource to embed", required: true }],
      },
      { name: "test_prompt_with_image", description: "Conformance: prompt with image content." },
    ];
  }

  getPrompt(name: string, args: Record<string, string>): GetPromptResult {
    const require = (key: string): string => {
      const v = args[key];
      if (typeof v !== "string" || v.length === 0) throw new PromptArgumentError(`missing required prompt argument "${key}"`);
      return v;
    };
    switch (name) {
      case "test_simple_prompt":
        return { messages: [text("user", "This is a simple prompt for testing.")] };
      case "test_prompt_with_arguments": {
        const arg1 = require("arg1");
        const arg2 = require("arg2");
        return { messages: [text("user", `Prompt with arguments: arg1='${arg1}', arg2='${arg2}'`)] };
      }
      case "test_prompt_with_embedded_resource": {
        const resourceUri = require("resourceUri");
        return {
          messages: [
            {
              role: "user",
              content: {
                type: "resource",
                resource: { uri: resourceUri, mimeType: "text/plain", text: "Embedded resource content for testing." },
              },
            },
            text("user", "Please process the embedded resource above."),
          ],
        };
      }
      case "test_prompt_with_image":
        return {
          messages: [
            { role: "user", content: { type: "image", data: PNG_1PX, mimeType: "image/png" } },
            text("user", "Please analyze the image above."),
          ],
        };
      default:
        throw new PromptNotFoundError(name);
    }
  }

  complete(
    ref: { type?: unknown; name?: unknown; uri?: unknown },
    argument: { name?: unknown; value?: unknown },
  ): CompletionResult {
    const name = typeof ref.name === "string" ? ref.name : "";
    const argName = typeof argument.name === "string" ? argument.name : "";
    const value = typeof argument.value === "string" ? argument.value : "";
    if (ref.type === "ref/prompt" && name === "test_prompt_with_arguments") {
      const candidates = ["testValue1", "testValue2", "testValue3", "exampleValue"];
      return { values: candidates.filter((v) => v.startsWith(value)), hasMore: false };
    }
    if (ref.type === "ref/resource") {
      return { values: ["123", "456"].filter((v) => v.startsWith(value)), hasMore: false };
    }
    return { values: [], hasMore: false };
  }
}
