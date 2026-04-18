export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

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
