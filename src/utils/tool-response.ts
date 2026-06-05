export type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

// azure-devops-node-api deserializes contract dates into Date objects;
// structured output wants plain JSON, so normalize to ISO strings.
export function toIso(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return undefined;
}

// Response carrying both machine-readable structuredContent (validated against
// the tool's outputSchema by the SDK) and the classic text payload. `text`
// defaults to the structured object; pass an explicit value to preserve a
// tool's pre-schema text shape exactly (e.g. the bare array list tools have
// always returned), so text-reading clients see no change.
export function structuredResponse(
  structured: Record<string, unknown>,
  text?: unknown
): ToolResult {
  const textValue = text ?? structured;
  return {
    content: [
      {
        type: "text" as const,
        text:
          typeof textValue === "string"
            ? textValue
            : JSON.stringify(textValue, null, 2),
      },
    ],
    structuredContent: structured,
  };
}

function sanitizeErrorMessage(message: string): string {
  return message
    // Remove file system paths (Windows & Unix)
    .replace(/[A-Z]:\\[\w\\./-]+/gi, "[PATH]")
    .replace(/\/(?:home|usr|var|tmp|etc|opt)[\w./-]*/g, "[PATH]")
    // Remove URLs that might contain internal server names (but keep the error context)
    .replace(/https?:\/\/[^\s)]+/g, "[URL]")
    // Remove stack trace lines
    .replace(/\n\s+at\s+.+/g, "")
    // Only keep the first line — the rest is usually stack noise
    .split("\n")[0];
}

export function extractErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function jsonResponse(data: unknown): ToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

export function dryRunResponse(payload: {
  action: string;
  before?: unknown;
  wouldBe: unknown;
  notes?: string;
}): ToolResult {
  return jsonResponse({ dryRun: true, ...payload });
}

export function textResponse(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }] };
}

export function errorResponse(error: unknown): ToolResult {
  const raw = extractErrorMessage(error);
  const message = sanitizeErrorMessage(raw);
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

export function withErrorHandling(
  fn: () => Promise<ToolResult>
): Promise<ToolResult> {
  return fn().catch((error: unknown) => errorResponse(error));
}
