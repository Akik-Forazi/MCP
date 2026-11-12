/**
 * Structural stand-in for axoniz's UnifiedMemory.
 *
 * The real implementation lives in @fraziym/axoniz
 * (integrations/unified_memory.ts — 1,897 lines, pulls in core/config +
 * core/memory + core/extras + core/logger). Importing it here would drag
 * axoniz's entire core into mcp, which is exactly what we removed.
 *
 * mcp only consumes the two methods below. When the real axoniz is present,
 * its UnifiedMemory satisfies this interface structurally — no cast needed.
 */

/** JSON-schema-shaped tool description, as returned by as_tool_schemas(). */
export interface MemoryToolSchema {
  type?: string;
  function?: {
    name?: string;
    description?: string;
    parameters?: {
      type?: string;
      properties?: Record<string, unknown>;
      required?: string[];
      [k: string]: unknown;
    };
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export type MemoryToolHandler = (args: Record<string, unknown>) => unknown;

export interface MemoryApi {
  /** Map of tool-name -> handler. Palaces, recall, remember, forget, etc. */
  as_tool_map(): Record<string, MemoryToolHandler>;
  /** OpenAI-style function schemas for the same tools. */
  as_tool_schemas(): MemoryToolSchema[];
  [k: string]: unknown;
}

/** Back-compat alias: call sites import the name `UnifiedMemory`. */
export type UnifiedMemory = MemoryApi;
