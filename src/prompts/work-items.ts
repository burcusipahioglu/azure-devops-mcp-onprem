import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { IConnectionProvider } from "../connection/provider.js";

// Registered conditionally (see index.ts): only when the work_items domain is
// enabled AND a risk-impact.md resource exists in AZURE_DEVOPS_RESOURCE_DIR.
// Contains no project-specific text and no hardcoded template — the template
// lives in the resource; this prompt only orchestrates reading it and grounding
// the answer in work-item evidence.
export function registerRiskPrompt(
  server: McpServer,
  _provider: IConnectionProvider
): void {
  server.registerPrompt(
    "risk_impact_analysis",
    {
      title: "Risk & impact analysis (team template)",
      description:
        "Fill the team's risk-impact template for a work item, grounded in work-item evidence.",
      argsSchema: {
        workItemId: z.string().describe("Work item ID"),
      },
    },
    ({ workItemId }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Perform a risk and impact analysis for work item ${workItemId}.`,
              "",
              "This task is ADVISORY and READ-ONLY. Use only read tools. Never modify any item or call a write tool.",
              "",
              "1. Read the resource template://risk-impact — the team's standard template. Use its headings and structure as the exact shape of your output; do not add or rename headings.",
              `2. Gather evidence by reading work item #${workItemId} in full (description, comments, relations) and its change history.`,
              "",
              "Fill every heading from the evidence. Where the evidence does not cover a heading, write \"evidence insufficient\" — never invent risk, scope, or impact. Cite the specific work-item or related IDs behind each filled-in claim.",
            ].join("\n"),
          },
        },
      ],
    })
  );
}
