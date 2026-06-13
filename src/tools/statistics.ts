import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { IConnectionProvider } from "../connection/provider.js";
import { withErrorHandling, jsonResponse } from "../utils/tool-response.js";
import { sanitizeWiqlValue } from "../utils/wiql.js";
import { batchGetWorkItems } from "../utils/work-item-helpers.js";
import { makeProgressReporter } from "../utils/progress.js";
import { LARGE_RESULT_HINT_THRESHOLD, WIQL_STATISTICS_TOP } from "../constants.js";

// --- Helper types ---

interface StatisticsParams {
  project: string;
  workItemTypes: string[];
  days: number;
  states?: string[];
  areaPathPrefix?: string;
  areaPathContains?: string;
  tags?: string[];
  iterationPath?: string;
}

interface AreaCount {
  total: number;
  byType: Record<string, number>;
}

// --- Decomposed helpers for get_work_item_statistics ---

function buildStatisticsWiql(params: StatisticsParams): string {
  const { project, workItemTypes, days, states, areaPathPrefix, tags, iterationPath } = params;

  const typeFilter = workItemTypes
    .map((t) => `'${sanitizeWiqlValue(t)}'`)
    .join(", ");

  let wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${sanitizeWiqlValue(project)}' AND [System.WorkItemType] IN (${typeFilter}) AND [System.CreatedDate] >= @Today - ${days}`;

  if (states && states.length > 0) {
    const stateFilter = states.map((s) => `'${sanitizeWiqlValue(s)}'`).join(", ");
    wiql += ` AND [System.State] IN (${stateFilter})`;
  }
  if (areaPathPrefix) {
    wiql += ` AND [System.AreaPath] UNDER '${sanitizeWiqlValue(areaPathPrefix)}'`;
  }
  if (tags && tags.length > 0) {
    const tagConditions = tags
      .map((tag) => `[System.Tags] CONTAINS '${sanitizeWiqlValue(tag)}'`)
      .join(" OR ");
    wiql += ` AND (${tagConditions})`;
  }
  if (iterationPath) {
    wiql += ` AND [System.IterationPath] UNDER '${sanitizeWiqlValue(iterationPath)}'`;
  }

  wiql += ` ORDER BY [System.Id] ASC`;
  return wiql;
}

function groupByAreaPath(
  items: { fields?: Record<string, unknown> }[],
  groupByDepth: number,
  areaPathContains?: string
): { countMap: Record<string, AreaCount>; totalProcessed: number } {
  const countMap: Record<string, AreaCount> = {};
  let totalProcessed = 0;

  for (const wi of items) {
    const fullAreaPath = (wi.fields?.["System.AreaPath"] as string) || "Unknown";
    const wiType = (wi.fields?.["System.WorkItemType"] as string) || "Unknown";

    if (
      areaPathContains &&
      !fullAreaPath.toLowerCase().includes(areaPathContains.toLowerCase())
    ) {
      continue;
    }

    const parts = fullAreaPath.split("\\");
    const groupedPath = parts.slice(0, groupByDepth).join("\\");

    if (!countMap[groupedPath]) {
      countMap[groupedPath] = { total: 0, byType: {} };
    }
    countMap[groupedPath].total++;
    countMap[groupedPath].byType[wiType] =
      (countMap[groupedPath].byType[wiType] || 0) + 1;

    totalProcessed++;
  }

  return { countMap, totalProcessed };
}

function buildNarrowingHints(
  totalProcessed: number,
  totalAreas: number,
  params: { areaPathPrefix?: string; areaPathContains?: string; tags?: string[]; iterationPath?: string; states?: string[] }
): string[] {
  const hints: string[] = [];
  if (totalProcessed <= LARGE_RESULT_HINT_THRESHOLD) return hints;

  if (!params.areaPathPrefix && !params.areaPathContains) {
    hints.push(
      `Results contain ${totalProcessed} items across ${totalAreas} areas. Consider narrowing with 'areaPathPrefix' (exact hierarchy) or 'areaPathContains' (keyword search by area path keyword).`
    );
  }
  if (!params.tags || params.tags.length === 0) {
    hints.push("You can also filter by 'tags' if your project uses them consistently.");
  }
  if (!params.iterationPath) {
    hints.push("You can filter by 'iterationPath' to limit to a specific release or sprint.");
  }
  if (!params.states || params.states.length === 0) {
    hints.push("You can filter by 'states' (e.g. ['Active', 'Resolved']) to exclude closed items.");
  }

  return hints;
}

// --- Tool registration ---

export function registerStatisticsTools(server: McpServer, provider: IConnectionProvider): void {
  server.registerTool(
    "get_work_item_statistics",
    {
      description: "Get work item counts grouped by Area Path. Useful for finding which areas have the most bugs, PBIs, or other work item types over a given time period. Supports pagination to retrieve all results beyond the 200-item WIQL limit.",
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        workItemTypes: z
          .array(z.string())
          .optional()
          .default(["Bug", "Product Backlog Item"])
          .describe(
            "Work item types to count, e.g. ['Bug', 'Product Backlog Item', 'Task']"
          ),
        days: z
          .number()
          .optional()
          .default(180)
          .describe("Look back this many days from today (default: 180 = ~6 months)"),
        states: z
          .array(z.string())
          .optional()
          .describe(
            "Filter by states, e.g. ['Active', 'Closed']. Leave empty for all states."
          ),
        areaPathPrefix: z
          .string()
          .optional()
          .describe(
            "Filter by Area Path hierarchy (UNDER), e.g. 'MyProject\\Backend'. Returns all items under this path."
          ),
        areaPathContains: z
          .string()
          .optional()
          .describe(
            "Filter by keyword anywhere in Area Path. Useful when you don't know the exact path but know part of the area name."
          ),
        groupByDepth: z
          .number()
          .optional()
          .default(3)
          .describe(
            "Area Path depth for grouping. 1 = root only, 2 = root\\child, 3 = root\\child\\grandchild, etc."
          ),
        tags: z
          .array(z.string())
          .optional()
          .describe(
            "Filter by tags. Items matching ANY of these tags will be included."
          ),
        iterationPath: z
          .string()
          .optional()
          .describe(
            "Filter by Iteration Path prefix, e.g. 'MyProject\\Sprint_2026_Q2'. Leave empty for all iterations."
          ),
        topAreas: z
          .number()
          .optional()
          .default(10)
          .describe("Return only the top N areas by count"),
      },
    },
    ({ workItemTypes, days, states, areaPathPrefix, areaPathContains, groupByDepth, tags, iterationPath, topAreas }, extra) =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getWorkItemContext();

        const wiql = buildStatisticsWiql({
          project,
          workItemTypes,
          days,
          states,
          areaPathPrefix,
          tags,
          iterationPath,
        });

        const queryResult = await api.queryByWiql(
          { query: wiql },
          { project },
          undefined,
          WIQL_STATISTICS_TOP
        );

        if (
          !queryResult.workItems ||
          queryResult.workItems.length === 0
        ) {
          return jsonResponse({
            message: "No work items found matching the criteria.",
            query: { workItemTypes, days, states, areaPathPrefix },
          });
        }

        const allIds = queryResult.workItems
          .map((wi) => wi.id)
          .filter((id): id is number => id !== undefined);

        // Fetch work item details in batches. This is the hot spot — a wide
        // query can pull tens of thousands of items, so stream progress.
        const report = makeProgressReporter(extra);
        const allItems = await batchGetWorkItems(
          api,
          allIds,
          ["System.Id", "System.AreaPath", "System.WorkItemType"],
          project,
          undefined,
          (fetched, total) => report(fetched, total, `Fetched ${fetched}/${total} work items`)
        );

        const { countMap, totalProcessed } = groupByAreaPath(
          allItems,
          groupByDepth,
          areaPathContains
        );

        const sortedAreas = Object.entries(countMap)
          .sort(([, a], [, b]) => b.total - a.total)
          .slice(0, topAreas)
          .map(([areaPath, data], index) => ({
            rank: index + 1,
            areaPath,
            total: data.total,
            breakdown: data.byType,
          }));

        const hints = buildNarrowingHints(
          totalProcessed,
          Object.keys(countMap).length,
          { areaPathPrefix, areaPathContains, tags, iterationPath, states }
        );

        const result: Record<string, unknown> = {
          summary: {
            totalWorkItems: totalProcessed,
            totalAreas: Object.keys(countMap).length,
            period: `Last ${days} days`,
            workItemTypes,
            filters: {
              states: states || "All",
              areaPathPrefix: areaPathPrefix || "All",
              areaPathContains: areaPathContains || "None",
              tags: tags || "None",
              iterationPath: iterationPath || "All",
            },
            groupByDepth,
          },
          topAreas: sortedAreas,
        };

        if (hints.length > 0) {
          result.narrowingHints = hints;
        }

        return jsonResponse(result);
      })
  );
}
