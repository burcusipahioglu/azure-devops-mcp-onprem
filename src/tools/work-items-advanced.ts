import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  JsonPatchOperation,
  Operation,
} from "azure-devops-node-api/interfaces/common/VSSInterfaces.js";
import type { IConnectionProvider } from "../connection/provider.js";
import { withErrorHandling, jsonResponse, extractErrorMessage } from "../utils/tool-response.js";
import { topParam, skipParam } from "../utils/schemas.js";
import { extractDisplayValue } from "../utils/work-item-helpers.js";
import { WORK_ITEM_BATCH_SIZE } from "../constants.js";

export function registerWorkItemAdvancedTools(server: McpServer, provider: IConnectionProvider): void {
  server.registerTool(
    "get_work_item_history",
    {
      description: "Get the full change history of a work item — shows who changed which fields, when, and what the old/new values were. Useful for auditing and understanding how a bug or task evolved over time.",
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

  server.registerTool(
    "bulk_update_work_items",
    {
      description: "Update multiple work items at once with the same field values. Useful for batch state changes, sprint reassignment, or bulk tagging.\n\n⚠️ CRITICAL WARNING: This is a HIGH-RISK BULK WRITE operation. Before calling this tool you MUST:\n1. List ALL work item IDs and the fields that will be changed\n2. Show the user a clear summary: \"I will update [N] work items ([list IDs]) — setting [field1] to [value1], [field2] to [value2]\"\n3. Warn about the impact: \"This will modify [N] items. This action cannot be easily undone.\"\n4. Wait for EXPLICIT user confirmation (e.g. \"yes\", \"go ahead\", \"approved\")\n\nDo NOT proceed without user approval. The tool returns a detailed before/after report for every item.",
      inputSchema: {
        ids: z
          .array(z.number())
          .describe("Array of work item IDs to update"),
        fields: z
          .record(z.string(), z.string())
          .describe(
            "Fields to set on ALL items, e.g. { 'System.State': 'Closed', 'System.Tags': 'Sprint42' }"
          ),
      },
    },
    ({ ids, fields }) =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getWorkItemContext();

        const fieldNames = Object.keys(fields).map((f) =>
          f.startsWith("/fields/") ? f.replace("/fields/", "") : f
        );

        // Step 1: Fetch current state of all work items (before snapshot)
        const beforeItems: Map<number, Record<string, unknown>> = new Map();
        for (let i = 0; i < ids.length; i += WORK_ITEM_BATCH_SIZE) {
          const batch = ids.slice(i, i + WORK_ITEM_BATCH_SIZE);
          const items = await api.getWorkItems(
            batch,
            ["System.Id", "System.Title", ...fieldNames],
            undefined,
            undefined,
            undefined,
            project
          );
          for (const wi of items || []) {
            if (wi.id !== undefined) {
              beforeItems.set(wi.id, wi.fields || {});
            }
          }
        }

        // Step 2: Apply updates
        const document: JsonPatchOperation[] = Object.entries(fields).map(
          ([field, value]) => ({
            op: Operation.Replace,
            path: field.startsWith("/fields/")
              ? field
              : `/fields/${field}`,
            value,
          })
        );

        interface ItemReport {
          id: number;
          title: string | undefined;
          success: boolean;
          error?: string;
          changes?: Record<string, { before: unknown; after: unknown }>;
        }

        const results: ItemReport[] = [];

        for (const id of ids) {
          try {
            const updated = await api.updateWorkItem(
              null,
              document,
              id,
              project
            );

            const beforeFields = beforeItems.get(id) || {};
            const changes: Record<string, { before: unknown; after: unknown }> = {};

            for (const fieldName of fieldNames) {
              changes[fieldName] = {
                before: extractDisplayValue(beforeFields[fieldName]),
                after: extractDisplayValue(updated?.fields?.[fieldName]),
              };
            }

            results.push({
              id,
              title: updated?.fields?.["System.Title"] as string | undefined,
              success: true,
              changes,
            });
          } catch (err: unknown) {
            const msg = extractErrorMessage(err);
            results.push({
              id,
              title: (beforeItems.get(id)?.["System.Title"] as string) || undefined,
              success: false,
              error: msg,
            });
          }
        }

        const succeeded = results.filter((r) => r.success).length;
        const failed = results.filter((r) => !r.success).length;

        return jsonResponse({
          action: "BULK_UPDATE",
          summary: {
            total: ids.length,
            succeeded,
            failed,
            fieldsUpdated: fieldNames,
            newValues: fields,
          },
          items: results,
        });
      })
  );
}
