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
        "Fill the team's risk-impact template for a work item, grounded in work-item evidence. Optionally pass a shelveset to assess the actual pending change against the work item's intent.",
      argsSchema: {
        workItemId: z.string().describe("Work item ID"),
        shelvesetName: z
          .string()
          .optional()
          .describe(
            "Optional TFVC shelveset to review against the work item (name or name;owner). When given, the analysis weighs the actual pending code change, not just the work item text."
          ),
      },
    },
    ({ workItemId, shelvesetName }) => {
      const lines = [
        `Perform a risk and impact analysis for work item ${workItemId}${
          shelvesetName ? `, reviewing the pending change in shelveset ${shelvesetName}` : ""
        }.`,
        "",
        "This task is ADVISORY and READ-ONLY. Use only read tools. Never modify any item or call a write tool.",
        "",
        "1. Read the resource template://risk-impact — the team's standard template. Use its headings and structure as the exact shape of your output; do not add or rename headings.",
        `2. Gather evidence by reading work item #${workItemId} in full (description, comments, relations) and its change history.`,
      ];

      if (shelvesetName) {
        lines.push(
          `3. Read the shelveset's change list with tfvc_get_shelveset (shelvesetId "${shelvesetName}"). If the owner is unknown, resolve the full name;owner id first via tfvc_list_shelvesets (owner '@me').`,
          "4. For the changed files that carry real risk, read their shelved content with tfvc_get_shelveset_file — only the files you need, not every path. Judge the actual change, not just its filename.",
          "5. Assess risk and impact by comparing the pending change against the work item's stated intent and acceptance criteria: does the change do what was asked, more, or less? Flag scope creep, missing tests, and unrelated edits."
        );
      }

      lines.push(
        "",
        'Fill every heading from the evidence. Where the evidence does not cover a heading, write "evidence insufficient" — never invent risk, scope, or impact. Cite the specific work-item, related, or shelved-file evidence behind each filled-in claim.'
      );

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: lines.join("\n"),
            },
          },
        ],
      };
    }
  );
}
