// Types and helpers every broker's MCP tools share.

export type JsonSchema = {
  type: "object";
  properties: Record<string, any>;
  required?: string[];
  additionalProperties?: boolean;
};

export interface ToolDef<C> {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  run(args: Record<string, any>, ctx: C): Promise<unknown>;
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError: boolean;
}

export class ToolInputError extends Error {}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[truncated: ${text.length - max} more characters; raise max_chars or narrow the request]`;
}

/** Validate tool arguments: required keys, primitive types, enums, unknown keys. */
export function validateArgs(schema: JsonSchema, args: unknown): string | null {
  if (args === undefined || args === null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) return "arguments must be an object";
  const a = args as Record<string, unknown>;
  for (const r of schema.required ?? []) {
    if (a[r] === undefined || a[r] === null) return `missing required argument "${r}"`;
  }
  for (const [k, v] of Object.entries(a)) {
    const prop = schema.properties[k];
    if (!prop) {
      if (schema.additionalProperties === false) return `unknown argument "${k}"`;
      continue;
    }
    if (v === undefined || v === null) continue;
    const t = prop.type;
    const ok =
      t === undefined ||
      (t === "string" && typeof v === "string") ||
      (t === "integer" && Number.isInteger(v)) ||
      (t === "number" && typeof v === "number") ||
      (t === "boolean" && typeof v === "boolean") ||
      (t === "array" && Array.isArray(v)) ||
      (t === "object" && typeof v === "object" && !Array.isArray(v));
    if (!ok) return `argument "${k}" must be ${t}`;
    if (prop.enum && !prop.enum.includes(v)) return `argument "${k}" must be one of ${prop.enum.join(", ")}`;
    if (t === "integer" && prop.minimum !== undefined && (v as number) < prop.minimum) return `argument "${k}" must be at least ${prop.minimum}`;
    if (t === "integer" && prop.maximum !== undefined && (v as number) > prop.maximum) return `argument "${k}" must be at most ${prop.maximum}`;
  }
  return null;
}
