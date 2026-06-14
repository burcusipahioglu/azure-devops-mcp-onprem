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
        "1. Read the resource template:risk-impact — the team's standard template. Use its headings and structure as the exact shape of your output; do not add or rename headings.",
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

// Registered when the work_items domain is enabled (see index.ts). Generic —
// no project-specific terms; the caller supplies titleContains/area at call time.
export function registerWorkItemPrompts(
  server: McpServer,
  _provider: IConnectionProvider
): void {
  server.registerPrompt(
    "work_item_report",
    {
      title: "Work item report (area, timeline, themes)",
      description:
        "Read-only report over a work-item filter: counts by Area Path, a monthly timeline, and AI-grouped recurring themes from titles. Scope it with titleContains, area, workItemTypes, and days.",
      argsSchema: {
        titleContains: z
          .string()
          .optional()
          .describe("Only items whose title contains this substring (case-insensitive), e.g. a topic keyword."),
        area: z
          .string()
          .optional()
          .describe("Area Path keyword to scope to (matched anywhere in the area path)."),
        days: z.coerce
          .number()
          .optional()
          .describe("Look back this many days (default 365)."),
        workItemTypes: z
          .string()
          .optional()
          .describe("Comma-separated work item types (default 'Bug'), e.g. 'Bug,Product Backlog Item'."),
      },
    },
    ({ titleContains, area, days, workItemTypes }) => {
      const lookback = days && days > 0 ? days : 365;
      const types = workItemTypes
        ? workItemTypes.split(",").map((t) => t.trim()).filter(Boolean)
        : ["Bug"];

      const text = [
        `Produce a work item report${titleContains ? ` for items whose title contains "${titleContains}"` : ""}${area ? ` in area "${area}"` : ""}.`,
        "",
        "This task is ADVISORY and READ-ONLY. Use only read tools; never modify anything or call a write tool. Output markdown tables only — do NOT emit Mermaid or other chart code unless the user explicitly asks afterwards.",
        "",
        `1. Get the hard numbers with get_work_item_statistics: workItemTypes ${JSON.stringify(types)}, days ${lookback}${area ? `, areaPathContains "${area}"` : ""}${titleContains ? `, titleContains "${titleContains}"` : ""}. It returns counts grouped by Area Path (topAreas) and a monthly timeline.`,
        `2. For recurring themes, call query_work_items with a WIQL matching the SAME filters (the work item types above, created within the last ${lookback} days${titleContains ? ", title containing the same keyword" : ""}${area ? ", same area" : ""}) and request fields ['System.Title', 'System.State', 'System.AreaPath']. Use the returned titles for clustering.`,
        "",
        "Then produce the report with these sections, grounded in the data above:",
        "- Summary — total count, period, and the filters applied (from get_work_item_statistics summary).",
        "- By area — a markdown table of the top areas: area path, count, per-type breakdown. Counts come ONLY from get_work_item_statistics.",
        "- Monthly timeline — a markdown table of month and count from the statistics 'timeline' field; note any clear rise or fall.",
        "- Recurring themes (ADVISORY) — group the query_work_items titles into recurring topics, with a count per theme and 1-2 example titles. Mark this section clearly as AI-grouped and advisory (not a deterministic count). State how many titles you grouped vs the total (e.g. \"themed 50 of 320\").",
        "- Hotspots & focus — which area and theme dominate, with a concrete, grounded suggestion of where to focus.",
        "",
        'Grounding: every count in "By area" and "Monthly timeline" must come from get_work_item_statistics — never invent or estimate. Themes are advisory (your reading of titles) — label them so. If data is too thin for a section, write "evidence insufficient" rather than padding. Markdown tables only; no charts.',
      ].join("\n");

      return {
        messages: [
          {
            role: "user",
            content: { type: "text", text },
          },
        ],
      };
    }
  );
}
