import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  WorkItemExpand,
  CommentSortOrder,
  CommentExpandOptions,
} from "azure-devops-node-api/interfaces/WorkItemTrackingInterfaces.js";
import {
  JsonPatchOperation,
  Operation,
} from "azure-devops-node-api/interfaces/common/VSSInterfaces.js";
import type { IConnectionProvider } from "../connection/provider.js";
import { withErrorHandling, jsonResponse, textResponse, dryRunResponse } from "../utils/tool-response.js";
import { topParam, skipParam, dryRunParam } from "../utils/schemas.js";
import { withAudit } from "../utils/audit.js";
import { extractDisplayValue, batchGetWorkItems } from "../utils/work-item-helpers.js";
import { normalizeFieldPath, buildUpdatePatchDocument } from "../utils/patch-document.js";
import { resolveMe } from "../utils/me-resolver.js";

const WORK_ITEM_EXPAND_MAP: Record<string, WorkItemExpand> = {
  none: WorkItemExpand.None,
  relations: WorkItemExpand.Relations,
  fields: WorkItemExpand.Fields,
  links: WorkItemExpand.Links,
  all: WorkItemExpand.All,
};

export function registerWorkItemTools(server: McpServer, provider: IConnectionProvider): void {
  server.registerTool(
    "query_work_items",
    {
      description: "Execute a WIQL (Work Item Query Language) query against Azure DevOps work items. IMPORTANT WIQL rules: [System.AreaPath] and [System.IterationPath] only support '=', '<>', and 'UNDER' operators (NOT 'CONTAINS'). Use 'UNDER' to match a path and all its children. [System.Tags] supports 'CONTAINS'. Example: [System.AreaPath] UNDER 'MyProject\\Backend'",
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
      inputSchema: {
        query: z
          .string()
          .describe(
            "WIQL query string. IMPORTANT: For AreaPath/IterationPath fields use '=' or 'UNDER' operator (NOT 'CONTAINS'). Example: SELECT [System.Id], [System.Title] FROM WorkItems WHERE [System.AreaPath] UNDER 'MyProject\\MyArea'"
          ),
        top: topParam(50),
      },
    },
    ({ query, top }) =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getWorkItemContext();

        const queryResult = await api.queryByWiql(
          { query },
          { project },
          undefined,
          top
        );

        if (
          !queryResult.workItems ||
          queryResult.workItems.length === 0
        ) {
          return textResponse("No work items found.");
        }

        const ids = queryResult.workItems
          .map((wi) => wi.id)
          .filter((id): id is number => id !== undefined);

        if (ids.length === 0) {
          return textResponse("No work items found.");
        }

        const allWorkItems = await batchGetWorkItems(
          api,
          ids,
          [
            "System.Id",
            "System.Title",
            "System.State",
            "System.AssignedTo",
            "System.WorkItemType",
            "System.CreatedDate",
            "System.ChangedDate",
          ],
          project
        );

        const result = allWorkItems.map((wi) => ({
          id: wi.id,
          type: wi.fields?.["System.WorkItemType"],
          title: wi.fields?.["System.Title"],
          state: wi.fields?.["System.State"],
          assignedTo: extractDisplayValue(wi.fields?.["System.AssignedTo"]),
          createdDate: wi.fields?.["System.CreatedDate"],
          changedDate: wi.fields?.["System.ChangedDate"],
        }));

        return jsonResponse(result);
      })
  );

  server.registerTool(
    "get_work_item",
    {
      description: "Get a work item by ID with all fields and optional relations",
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
      inputSchema: {
        id: z.number().describe("Work item ID"),
        expand: z
          .enum(["none", "relations", "fields", "links", "all"])
          .optional()
          .default("all")
          .describe("Level of detail to include"),
      },
    },
    ({ id, expand }) =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getWorkItemContext();

        const workItem = await api.getWorkItem(
          id,
          undefined,
          undefined,
          WORK_ITEM_EXPAND_MAP[expand],
          project
        );

        if (!workItem) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Work item ${id} not found.`,
              },
            ],
          };
        }

        return jsonResponse(workItem);
      })
  );

  server.registerTool(
    "create_work_item",
    {
      description: "Create a new work item in Azure DevOps. WARNING: This is a WRITE operation that creates a permanent record. You MUST confirm with the user before calling this tool — show them the type, title, and all fields you will set, and ask for explicit approval.",
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
      inputSchema: {
        type: z
          .string()
          .describe(
            "Work item type, e.g. 'Bug', 'User Story', 'Task', 'Feature'"
          ),
        title: z.string().describe("Title of the work item"),
        description: z
          .string()
          .optional()
          .describe("HTML description of the work item"),
        assignedTo: z
          .string()
          .optional()
          .describe("User to assign to (display name or email). Pass '@me' to assign to the authenticated user."),
        areaPath: z.string().optional().describe("Area path"),
        iterationPath: z.string().optional().describe("Iteration path"),
        additionalFields: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Additional field key-value pairs as { 'System.Tags': 'tag1; tag2' }"
          ),
      },
    },
    (input) =>
      withAudit(provider, "create_work_item", input, () => withErrorHandling(async () => {
        const {
          type,
          title,
          description,
          assignedTo,
          areaPath,
          iterationPath,
          additionalFields,
        } = input;
        const { api, project } = await provider.getWorkItemContext();

        const document: JsonPatchOperation[] = [
          {
            op: Operation.Add,
            path: "/fields/System.Title",
            value: title,
          },
        ];

        if (description) {
          document.push({
            op: Operation.Add,
            path: "/fields/System.Description",
            value: description,
          });
        }
        const resolvedAssignedTo = await resolveMe(assignedTo, provider);
        if (resolvedAssignedTo) {
          document.push({
            op: Operation.Add,
            path: "/fields/System.AssignedTo",
            value: resolvedAssignedTo,
          });
        }
        if (areaPath) {
          document.push({
            op: Operation.Add,
            path: "/fields/System.AreaPath",
            value: areaPath,
          });
        }
        if (iterationPath) {
          document.push({
            op: Operation.Add,
            path: "/fields/System.IterationPath",
            value: iterationPath,
          });
        }
        if (additionalFields) {
          for (const [field, value] of Object.entries(additionalFields)) {
            document.push({ op: Operation.Add, path: normalizeFieldPath(field), value });
          }
        }

        const workItem = await api.createWorkItem(
          null,
          document,
          project,
          type
        );

        return jsonResponse({
          action: "CREATED",
          id: workItem?.id,
          type: workItem?.fields?.["System.WorkItemType"],
          title: workItem?.fields?.["System.Title"],
          state: workItem?.fields?.["System.State"],
          assignedTo: extractDisplayValue(workItem?.fields?.["System.AssignedTo"]),
          areaPath: workItem?.fields?.["System.AreaPath"],
          iterationPath: workItem?.fields?.["System.IterationPath"],
          url: workItem?.url,
        });
      }))
  );

  server.registerTool(
    "update_work_item",
    {
      description: "Update an existing work item's fields. WARNING: This is a WRITE operation that modifies an existing record. You MUST confirm with the user before calling — show them the work item ID, current values of fields being changed, and the new values you will set. Ask for explicit approval.",
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        id: z.number().describe("Work item ID to update"),
        fields: z
          .record(z.string(), z.string())
          .describe(
            "Fields to update as { 'System.Title': 'New Title', 'System.State': 'Active' }"
          ),
      },
    },
    (input) =>
      withAudit(provider, "update_work_item", input, () => withErrorHandling(async () => {
        const { id, fields } = input;
        const { api, project } = await provider.getWorkItemContext();

        // Fetch current state before updating
        const fieldNames = Object.keys(fields).map((f) =>
          normalizeFieldPath(f).replace("/fields/", "")
        );
        const before = await api.getWorkItem(
          id,
          fieldNames,
          undefined,
          undefined,
          project
        );

        const document = buildUpdatePatchDocument(fields);

        const workItem = await api.updateWorkItem(
          null,
          document,
          id,
          project
        );

        // Build before/after change report
        const changes: Record<string, { before: unknown; after: unknown }> = {};
        for (const fieldName of fieldNames) {
          changes[fieldName] = {
            before: extractDisplayValue(before?.fields?.[fieldName]),
            after: extractDisplayValue(workItem?.fields?.[fieldName]),
          };
        }

        return jsonResponse({
          action: "UPDATED",
          id: workItem?.id,
          title: workItem?.fields?.["System.Title"],
          url: workItem?.url,
          changes,
        });
      }))
  );

  server.registerTool(
    "get_work_item_comments",
    {
      description: "List comments on a work item, ordered and paginated. Returns the raw CommentList (comments[], continuationToken, totalCount) so callers can page through large threads.",
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
      inputSchema: {
        workItemId: z.number().describe("Work item ID"),
        top: topParam(50),
        order: z
          .enum(["asc", "desc"])
          .optional()
          .default("asc")
          .describe("Sort order by creation date"),
        includeRenderedText: z
          .boolean()
          .optional()
          .default(false)
          .describe("Also return the rendered HTML alongside the raw text/markdown"),
        continuationToken: z
          .string()
          .optional()
          .describe("Token from a previous response to fetch the next page"),
      },
    },
    ({ workItemId, top, order, includeRenderedText, continuationToken }) =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getWorkItemContext();

        const commentList = await api.getComments(
          project,
          workItemId,
          top,
          continuationToken,
          undefined,
          includeRenderedText ? CommentExpandOptions.RenderedText : CommentExpandOptions.None,
          order === "desc" ? CommentSortOrder.Desc : CommentSortOrder.Asc
        );

        return jsonResponse(commentList);
      })
  );

  server.registerTool(
    "add_work_item_comment",
    {
      description: "Add a comment to a work item. WARNING: This is a WRITE operation that notifies subscribers and cannot be silently undone. Show the user the comment text and work item ID before calling, and ask for confirmation. Tip: pass dryRun: true first to preview the exact payload before posting.",
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
      inputSchema: {
        workItemId: z.number().describe("Work item ID"),
        text: z.string().describe("Comment text (HTML supported)"),
        dryRun: dryRunParam,
      },
    },
    (input) =>
      withAudit(provider, "add_work_item_comment", input, () => withErrorHandling(async () => {
        const { workItemId, text, dryRun } = input;
        const { api, project } = await provider.getWorkItemContext();

        if (dryRun) {
          return dryRunResponse({
            action: "WOULD_ADD_COMMENT",
            wouldBe: { project, workItemId, text },
            notes: "No comment posted, no notifications sent. Re-call with dryRun omitted or false to post.",
          });
        }

        const comment = await api.addComment(
          { text },
          project,
          workItemId
        );

        return jsonResponse(comment);
      }))
  );

  server.registerTool(
    "link_work_items",
    {
      description: "Create a link between two work items. WARNING: This is a WRITE operation. Show the user the source ID, target ID, and link type before calling, and ask for confirmation.",
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
      inputSchema: {
        sourceId: z.number().describe("Source work item ID"),
        targetId: z.number().describe("Target work item ID"),
        linkType: z
          .string()
          .default("System.LinkTypes.Related")
          .describe(
            "Link type reference name, e.g. System.LinkTypes.Hierarchy-Forward (parent-child), System.LinkTypes.Related"
          ),
        comment: z.string().optional().describe("Optional link comment"),
      },
    },
    (input) =>
      withAudit(provider, "link_work_items", input, () => withErrorHandling(async () => {
        const { sourceId, targetId, linkType, comment } = input;
        const { api, project, orgUrl } = await provider.getWorkItemContext();

        const targetUrl = `${orgUrl}/_apis/wit/workItems/${targetId}`;

        const document: JsonPatchOperation[] = [
          {
            op: Operation.Add,
            path: "/relations/-",
            value: {
              rel: linkType,
              url: targetUrl,
              attributes: {
                comment: comment || "",
              },
            },
          },
        ];

        const workItem = await api.updateWorkItem(
          null,
          document,
          sourceId,
          project
        );

        return {
          content: [
            {
              type: "text" as const,
              text: `Successfully linked work item ${sourceId} to ${targetId} with link type "${linkType}". Updated work item ID: ${workItem?.id}`,
            },
          ],
        };
      }))
  );

  server.registerTool(
    "get_work_item_history",
    {
      description: "Get the full change history of a work item — shows who changed which fields, when, and what the old/new values were. Useful for auditing and understanding how a bug or task evolved over time.",
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
      inputSchema: {
        workItemId: z.number().describe("Work item ID"),
        top: topParam(50),
        skip: skipParam(),
      },
    },
    ({ workItemId, top, skip }) =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getWorkItemContext();

        const updates = await api.getUpdates(
          workItemId,
          top,
          skip,
          project
        );

        const result = (updates || []).map((update) => {
          const fieldChanges: Record<string, { oldValue: unknown; newValue: unknown }> = {};

          if (update.fields) {
            for (const [field, change] of Object.entries(update.fields)) {
              fieldChanges[field] = {
                oldValue: extractDisplayValue(change.oldValue),
                newValue: extractDisplayValue(change.newValue),
              };
            }
          }

          return {
            id: update.id,
            revisedBy: update.revisedBy?.displayName,
            revisedDate: update.revisedDate,
            fieldChanges: Object.keys(fieldChanges).length > 0 ? fieldChanges : undefined,
            relationChanges: update.relations
              ? {
                  added: update.relations.added?.length || 0,
                  removed: update.relations.removed?.length || 0,
                  updated: update.relations.updated?.length || 0,
                }
              : undefined,
          };
        });

        return jsonResponse(result);
      })
  );
}
