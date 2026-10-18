/**
 * Argument readers — LLMs emit loosely-typed JSON, so every read is coerced
 * with a fallback instead of trusting the declared schema.
 */

export function argStr(args: Record<string, unknown>, key: string, fallback = ""): string {
  const v = args[key];
  if (v === undefined || v === null) return fallback;
  return String(v);
}

export function argInt(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key];
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function argBool(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = args[key];
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return fallback;
}
