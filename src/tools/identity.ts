import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IConnectionProvider } from "../connection/provider.js";
import { withErrorHandling, jsonResponse } from "../utils/tool-response.js";

// Core identity tool — registered unconditionally, outside the domain gate.
// "Which PAT am I talking through?" must be answerable regardless of which
// domains are enabled (multi-profile debugging depends on it).
export function registerIdentityTools(server: McpServer, provider: IConnectionProvider): void {
  server.registerTool(
    "get_current_user",
    {
      description: "Get the identity of the authenticated Azure DevOps user (the PAT owner). Returns displayName, id, and uniqueName. Useful when you need the 'me' identity explicitly; most owner/author filter params also accept '@me' directly.",
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: {},
    },
    () =>
      withErrorHandling(async () => {
        const user = await provider.resolveCurrentUser();
        return jsonResponse(user);
      })
  );
}
