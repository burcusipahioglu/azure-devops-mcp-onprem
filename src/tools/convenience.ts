import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { IConnectionProvider } from "../connection/provider.js";
import { withErrorHandling, jsonResponse, textResponse } from "../utils/tool-response.js";
import { sanitizeWiqlValue } from "../utils/wiql.js";
import { topParam } from "../utils/schemas.js";
import { extractDisplayValue, batchGetWorkItems } from "../utils/work-item-helpers.js";
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

// --- Helper: WIQL builders ---

function buildSprintWiql(workItemType?: string, states?: string[]): string {
  let wiql = `SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType], [System.AssignedTo], [Microsoft.VSTS.Scheduling.RemainingWork], [Microsoft.VSTS.Common.Priority] FROM WorkItems WHERE [System.IterationPath] = @CurrentIteration AND [System.AssignedTo] = @Me`;

  if (workItemType) {
    wiql += ` AND [System.WorkItemType] = '${sanitizeWiqlValue(workItemType)}'`;
  }
  if (states && states.length > 0) {
    const stateFilter = states
      .map((s) => `'${sanitizeWiqlValue(s)}'`)
      .join(", ");
    wiql += ` AND [System.State] IN (${stateFilter})`;
  }

  wiql += ` ORDER BY [Microsoft.VSTS.Common.Priority] ASC, [System.ChangedDate] DESC`;
  return wiql;
}

// --- Tool registrations ---

export function registerConvenienceTools(server: McpServer, provider: IConnectionProvider): void {
  server.registerTool(
    "get_my_sprint_items",
    {
      description: "Get all work items assigned to you in the current sprint/iteration. Optionally filter by work item type.",
      inputSchema: {
        workItemType: z
          .string()
          .optional()
          .describe(
            "Filter by type: 'Task', 'Bug', 'User Story', etc. Leave empty for all types."
          ),
        states: z
          .array(z.string())
          .optional()
          .describe(
            "Filter by states, e.g. ['Active', 'New']. Leave empty for all states."
          ),
      },
    },
    ({ workItemType, states }) =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getWorkItemContext();

        const wiql = buildSprintWiql(workItemType, states);

        const queryResult = await api.queryByWiql(
          { query: wiql },
          { project }
        );

        if (
          !queryResult.workItems ||
          queryResult.workItems.length === 0
        ) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No work items found in the current sprint assigned to you.",
              },
            ],
          };
        }

        const ids = queryResult.workItems
          .map((wi) => wi.id)
          .filter((id): id is number => id !== undefined);

        const items = await api.getWorkItems(
          ids,
          [
            "System.Id",
            "System.Title",
            "System.State",
            "System.WorkItemType",
            "System.AssignedTo",
            "System.Tags",
            "Microsoft.VSTS.Common.Priority",
            "Microsoft.VSTS.Scheduling.RemainingWork",
            "Microsoft.VSTS.Scheduling.OriginalEstimate",
          ],
          undefined,
          undefined,
          undefined,
          project
        );

        const result = (items || []).map((wi) => ({
          id: wi.id,
          type: wi.fields?.["System.WorkItemType"],
          title: wi.fields?.["System.Title"],
          state: wi.fields?.["System.State"],
          priority: wi.fields?.["Microsoft.VSTS.Common.Priority"],
          remainingWork: wi.fields?.["Microsoft.VSTS.Scheduling.RemainingWork"],
          originalEstimate:
            wi.fields?.["Microsoft.VSTS.Scheduling.OriginalEstimate"],
          tags: wi.fields?.["System.Tags"],
        }));

        return jsonResponse(result);
      })
  );

  server.registerTool(
    "search_work_items_by_tag",
    {
      description: "Search work items by one or more tags. Returns matching items across all iterations.",
      inputSchema: {
        tags: z
          .array(z.string())
          .describe("Tags to search for (items matching ANY of these tags)"),
        workItemType: z
          .string()
          .optional()
          .describe("Filter by type: 'Bug', 'Task', 'User Story', etc."),
        state: z
          .string()
          .optional()
          .describe("Filter by state: 'Active', 'New', 'Closed', etc."),
        top: z
          .number()
          .optional()
          .default(50)
          .describe("Maximum number of results"),
      },
    },
    ({ tags, workItemType, state, top }) =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getWorkItemContext();

        const tagConditions = tags
          .map((tag) => `[System.Tags] CONTAINS '${sanitizeWiqlValue(tag)}'`)
          .join(" OR ");

        let wiql = `SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType], [System.Tags], [System.AssignedTo] FROM WorkItems WHERE (${tagConditions})`;

        if (workItemType) {
          wiql += ` AND [System.WorkItemType] = '${sanitizeWiqlValue(workItemType)}'`;
        }
        if (state) {
          wiql += ` AND [System.State] = '${sanitizeWiqlValue(state)}'`;
        }

        wiql += ` ORDER BY [System.ChangedDate] DESC`;

        const queryResult = await api.queryByWiql(
          { query: wiql },
          { project },
          undefined,
          top
        );

        if (
          !queryResult.workItems ||
          queryResult.workItems.length === 0
        ) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No work items found with tags: ${tags.join(", ")}`,
              },
            ],
          };
        }

        const ids = queryResult.workItems
          .map((wi) => wi.id)
          .filter((id): id is number => id !== undefined);

        const allItems = await batchGetWorkItems(
          api,
          ids,
          [
            "System.Id",
            "System.Title",
            "System.State",
            "System.WorkItemType",
            "System.Tags",
            "System.AssignedTo",
            "System.AreaPath",
            "System.IterationPath",
          ],
          project
        );

        const result = allItems.map((wi) => ({
          id: wi.id,
          type: wi.fields?.["System.WorkItemType"],
          title: wi.fields?.["System.Title"],
          state: wi.fields?.["System.State"],
          tags: wi.fields?.["System.Tags"],
          assignedTo: extractDisplayValue(wi.fields?.["System.AssignedTo"]),
          areaPath: wi.fields?.["System.AreaPath"],
          iterationPath: wi.fields?.["System.IterationPath"],
        }));

        return jsonResponse(result);
      })
  );

  server.registerTool(
    "get_work_item_statistics",
    {
      description: "Get work item counts grouped by Area Path. Useful for finding which areas have the most bugs, PBIs, or other work item types over a given time period. Supports pagination to retrieve all results beyond the 200-item WIQL limit.",
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
    ({ workItemTypes, days, states, areaPathPrefix, areaPathContains, groupByDepth, tags, iterationPath, topAreas }) =>
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

        // Fetch work item details in batches
        const allItems = await batchGetWorkItems(
          api,
          allIds,
          ["System.Id", "System.AreaPath", "System.WorkItemType"],
          project
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

  server.registerTool(
    "get_current_user",
    {
      description: "Get the identity of the authenticated Azure DevOps user (the PAT owner). Returns displayName, id, and uniqueName. Useful when you need the 'me' identity explicitly; most owner/author filter params also accept '@me' directly.",
      inputSchema: {},
    },
    () =>
      withErrorHandling(async () => {
        const user = await provider.resolveCurrentUser();
        return jsonResponse(user);
      })
  );
}
