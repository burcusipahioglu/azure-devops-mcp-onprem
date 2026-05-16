import type { ToolResult } from "./tool-response.js";

// Server-level write policy. AZURE_DEVOPS_MODE accepted values:
//   - "readonly" — all write tools refuse to execute, return isError with a
//     clear message. Read tools unaffected.
//   - unset / "write" / anything else — default behavior, writes allowed.
// "admin" is reserved for a future destructive-ops tier (delete/cancel);
// today it behaves identically to "write" so the env var contract stays
// stable when that tier lands.
//
// Read lazily on every call: module top-level code runs BEFORE index.ts's
// dotenv loadEnv() (ESM import hoisting), so capturing at load time would
// miss values set via .env file. Same trap fixed in audit.ts.
export function isReadonlyMode(): boolean {
  return process.env.AZURE_DEVOPS_MODE?.toLowerCase() === "readonly";
}

export function readonlyBlockedResponse(tool: string): ToolResult {
  return {
    content: [
      {
        type: "text" as const,
        text:
          `Error: Server is in readonly mode (AZURE_DEVOPS_MODE=readonly). ` +
          `The '${tool}' tool is a write operation and is disabled. ` +
          `Unset AZURE_DEVOPS_MODE (or set it to 'write') and restart the server to enable writes.`,
      },
    ],
    isError: true,
  };
}
