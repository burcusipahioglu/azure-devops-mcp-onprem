import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  VersionControlRecursionType,
  TfvcVersionType,
} from "azure-devops-node-api/interfaces/TfvcInterfaces.js";
import { WorkItemExpand } from "azure-devops-node-api/interfaces/WorkItemTrackingInterfaces.js";
import type { IConnectionProvider } from "../connection/provider.js";
import { withErrorHandling, jsonResponse, textResponse, extractErrorMessage } from "../utils/tool-response.js";
import { topParam, skipParam } from "../utils/schemas.js";
import { resolveMe } from "../utils/me-resolver.js";
import { FILE_CONTENT_TRUNCATION_LIMIT } from "../constants.js";

// Helper: Extract changeset IDs from work item relations
function extractChangesetIds(relations: unknown[] | undefined): number[] {
  if (!relations) return [];
  const ids: number[] = [];
  for (const rel of relations) {
    const relObj = rel as Record<string, unknown>;
    if (
      relObj.rel === "ArtifactLink" &&
      (relObj.url as string | undefined)?.includes("vstfs:///VersionControl/Changeset/")
    ) {
      const match = (relObj.url as string).match(/Changeset\/(\d+)/);
      if (match) {
        ids.push(parseInt(match[1], 10));
      }
    }
  }
  return ids;
}

export function registerTfvcTools(server: McpServer, provider: IConnectionProvider): void {
  server.registerTool(
    "tfvc_browse",
    {
      description: "Browse files and folders in TFVC at a given path (like Source Control Explorer)",
      inputSchema: {
        scopePath: z
          .string()
          .optional()
          .default("$/")
          .describe("TFVC path to browse, e.g. $/MyProject/Main/src"),
        recursion: z
          .enum(["none", "oneLevel", "full"])
          .optional()
          .default("oneLevel")
          .describe("Recursion level: none (item only), oneLevel (direct children), full (all descendants)"),
      },
    },
    ({ scopePath, recursion }) =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getTfvcContext();

        const recursionMap: Record<string, VersionControlRecursionType> = {
          none: VersionControlRecursionType.None,
          oneLevel: VersionControlRecursionType.OneLevel,
          full: VersionControlRecursionType.Full,
        };

        const items = await api.getItems(
          project,
          scopePath,
          recursionMap[recursion]
        );

        const result = (items || []).map((item) => ({
          path: item.path,
          isBranch: item.isBranch,
          isFolder: item.isFolder,
          size: item.size,
          version: item.version,
          changeDate: item.changeDate,
          url: item.url,
        }));

        return jsonResponse(result);
      })
  );

  server.registerTool(
    "tfvc_get_file",
    {
      description: "Get the content of a file from TFVC source control",
      inputSchema: {
        path: z
          .string()
          .describe("TFVC file path, e.g. $/MyProject/Main/src/app.ts"),
        version: z
          .string()
          .optional()
          .describe("Changeset number to get a specific version (defaults to latest)"),
      },
    },
    ({ path, version }) =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getTfvcContext();

        const versionDescriptor = version
          ? {
              version,
              versionType: TfvcVersionType.Changeset,
            }
          : undefined;

        const stream = await api.getItemContent(
          path,
          project,
          undefined,
          undefined,
          undefined,
          undefined,
          versionDescriptor
        );

        if (!stream) {
          return textResponse(`File not found: ${path}`);
        }

        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
          chunks.push(Buffer.from(chunk));
        }
        const content = Buffer.concat(chunks).toString("utf-8");

        return textResponse(content);
      })
  );

  server.registerTool(
    "tfvc_get_changeset",
    {
      description: "Get details of a specific TFVC changeset including changes and associated work items",
      inputSchema: {
        id: z.number().describe("Changeset ID"),
        includeWorkItems: z
          .boolean()
          .optional()
          .default(true)
          .describe("Include associated work items"),
        includeDetails: z
          .boolean()
          .optional()
          .default(true)
          .describe("Include changeset details (check-in notes, policy overrides)"),
        maxChangeCount: z
          .number()
          .optional()
          .default(100)
          .describe("Maximum number of file changes to include"),
      },
    },
    ({ id, includeWorkItems, includeDetails, maxChangeCount }) =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getTfvcContext();

        const changeset = await api.getChangeset(
          id,
          project,
          maxChangeCount,
          includeDetails,
          includeWorkItems
        );

        return jsonResponse(changeset);
      })
  );

  server.registerTool(
    "tfvc_list_changesets",
    {
      description: "List recent TFVC changesets with optional filters (author, date range, item path)",
      inputSchema: {
        itemPath: z
          .string()
          .optional()
          .describe("Filter changesets affecting this path, e.g. $/MyProject/Main"),
        author: z
          .string()
          .optional()
          .describe("Filter by author display name or email. Pass '@me' to filter to the authenticated user."),
        fromDate: z
          .string()
          .optional()
          .describe("Start date filter (ISO format, e.g. 2026-01-01)"),
        toDate: z
          .string()
          .optional()
          .describe("End date filter (ISO format, e.g. 2026-04-07)"),
        top: topParam(25),
        skip: skipParam(),
      },
    },
    ({ itemPath, author, fromDate, toDate, top, skip }) =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getTfvcContext();

        const resolvedAuthor = await resolveMe(author, provider);
        const searchCriteria: Record<string, string> = {};
        if (itemPath) searchCriteria.itemPath = itemPath;
        if (resolvedAuthor) searchCriteria.author = resolvedAuthor;
        if (fromDate) searchCriteria.fromDate = fromDate;
        if (toDate) searchCriteria.toDate = toDate;

        const changesets = await api.getChangesets(
          project,
          undefined,
          skip,
          top,
          undefined,
          searchCriteria
        );

        const result = (changesets || []).map((cs) => ({
          changesetId: cs.changesetId,
          author: cs.author?.displayName,
          createdDate: cs.createdDate,
          comment: cs.comment,
          url: cs.url,
        }));

        return jsonResponse(result);
      })
  );

  server.registerTool(
    "tfvc_get_changeset_changes",
    {
      description: "Get the list of file changes (adds, edits, deletes) in a specific changeset",
      inputSchema: {
        changesetId: z.number().describe("Changeset ID"),
        top: topParam(100),
        skip: skipParam(),
      },
    },
    ({ changesetId, top, skip }) =>
      withErrorHandling(async () => {
        const { api } = await provider.getTfvcContext();

        const changes = await api.getChangesetChanges(
          changesetId,
          skip,
          top
        );

        const result = (changes || []).map((change) => ({
          changeType: change.changeType,
          path: change.item?.path,
          version: change.item?.version,
          url: change.item?.url,
        }));

        return jsonResponse(result);
      })
  );

  server.registerTool(
    "tfvc_get_changeset_work_items",
    {
      description: "Get work items associated with a specific TFVC changeset",
      inputSchema: {
        changesetId: z.number().describe("Changeset ID"),
      },
    },
    ({ changesetId }) =>
      withErrorHandling(async () => {
        const { api } = await provider.getTfvcContext();

        const workItems = await api.getChangesetWorkItems(changesetId);

        return jsonResponse(workItems);
      })
  );

  server.registerTool(
    "tfvc_list_branches",
    {
      description: "List TFVC branches in the project",
      inputSchema: {
        includeChildren: z
          .boolean()
          .optional()
          .default(false)
          .describe("Include child branches"),
        includeDeleted: z
          .boolean()
          .optional()
          .default(false)
          .describe("Include deleted branches"),
      },
    },
    ({ includeChildren, includeDeleted }) =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getTfvcContext();

        const branches = await api.getBranches(
          project,
          undefined,
          includeChildren,
          includeDeleted
        );

        const result = (branches || []).map((branch) => ({
          path: branch.path,
          description: branch.description,
          owner: branch.owner?.displayName,
          createdDate: branch.createdDate,
          children: branch.children?.map((child) => ({
            path: child.path,
            description: child.description,
            createdDate: child.createdDate,
          })),
        }));

        return jsonResponse(result);
      })
  );

  server.registerTool(
    "tfvc_list_shelvesets",
    {
      description: "List TFVC shelvesets (pending changes stored on the server)",
      inputSchema: {
        owner: z
          .string()
          .optional()
          .describe("Filter by owner display name (e.g. 'John Smith'), not username/UID. Use the person's full display name as shown in Azure DevOps. Pass '@me' to filter to the authenticated user."),
        top: topParam(25),
        skip: skipParam(),
      },
    },
    ({ owner, top, skip }) =>
      withErrorHandling(async () => {
        const { api } = await provider.getTfvcContext();

        const resolvedOwner = await resolveMe(owner, provider);
        const requestData = resolvedOwner
          ? { owner: resolvedOwner, includeDetails: true }
          : undefined;

        const shelvesets = await api.getShelvesets(
          requestData,
          top,
          skip
        );

        const sorted = (shelvesets || []).sort((a, b) => {
          const dateA = a.createdDate ? new Date(a.createdDate).getTime() : 0;
          const dateB = b.createdDate ? new Date(b.createdDate).getTime() : 0;
          return dateB - dateA;
        });

        const result = sorted.map((ss) => ({
          id: ss.id,
          name: ss.name,
          comment: ss.comment,
          owner: ss.owner?.displayName,
          createdDate: ss.createdDate,
          url: ss.url,
        }));

        return jsonResponse(result);
      })
  );

  server.registerTool(
    "tfvc_get_shelveset",
    {
      description: "Get details of a specific TFVC shelveset including its changes",
      inputSchema: {
        shelvesetId: z
          .string()
          .describe("Shelveset ID (format: name;owner)"),
        includeWorkItems: z
          .boolean()
          .optional()
          .default(true)
          .describe("Include associated work items"),
      },
    },
    ({ shelvesetId, includeWorkItems }) =>
      withErrorHandling(async () => {
        const { api } = await provider.getTfvcContext();

        const shelveset = await api.getShelveset(shelvesetId, {
          includeWorkItems,
          includeDetails: true,
        });

        const changes = await api.getShelvesetChanges(shelvesetId);

        const result = {
          ...shelveset,
          changes: (changes || []).map((change) => ({
            changeType: change.changeType,
            path: change.item?.path,
            url: change.item?.url,
          })),
        };

        return jsonResponse(result);
      })
  );

  server.registerTool(
    "tfvc_list_labels",
    {
      description: "List TFVC labels in the project",
      inputSchema: {
        name: z
          .string()
          .optional()
          .describe("Filter by label name (contains match)"),
        owner: z
          .string()
          .optional()
          .describe("Filter by owner display name. Pass '@me' to filter to the authenticated user."),
        top: topParam(25),
        skip: skipParam(),
      },
    },
    ({ name, owner, top, skip }) =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getTfvcContext();

        const resolvedOwner = await resolveMe(owner, provider);
        const requestData: Record<string, unknown> = {
          includeLinks: false,
          maxItemCount: 0,
        };
        if (name) requestData.name = name;
        if (resolvedOwner) requestData.owner = resolvedOwner;

        const labels = await api.getLabels(
          requestData as Parameters<typeof api.getLabels>[0],
          project,
          top,
          skip
        );

        const result = (labels || []).map((label) => ({
          id: label.id,
          name: label.name,
          description: label.description,
          labelScope: label.labelScope,
          modifiedDate: label.modifiedDate,
          owner: label.owner?.displayName,
          url: label.url,
        }));

        return jsonResponse(result);
      })
  );

  server.registerTool(
    "get_work_item_changesets",
    {
      description: "Get all TFVC changesets linked to a work item, including file changes and changeset details. Useful for reviewing what code changes were made for a bug fix or feature.",
      inputSchema: {
        workItemId: z
          .number()
          .describe("Work item ID (Bug, Task, User Story, etc.)"),
        includeFileContent: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Also fetch the content of changed files (can be large, use with care)"
          ),
        maxFiles: z
          .number()
          .optional()
          .default(20)
          .describe(
            "Maximum number of changed files to include per changeset"
          ),
      },
    },
    ({ workItemId, includeFileContent, maxFiles }) =>
      withErrorHandling(async () => {
        const { api: witApi, project } = await provider.getWorkItemContext();
        const { api: tfvcApi } = await provider.getTfvcContext();

        const workItem = await witApi.getWorkItem(
          workItemId,
          undefined,
          undefined,
          WorkItemExpand.Relations,
          project
        );

        if (!workItem) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Work item ${workItemId} not found.`,
              },
            ],
          };
        }

        const changesetIds = extractChangesetIds(workItem.relations);

        if (changesetIds.length === 0) {
          return jsonResponse({
            workItemId,
            title: workItem.fields?.["System.Title"],
            type: workItem.fields?.["System.WorkItemType"],
            message:
              "No TFVC changesets linked to this work item.",
            hint: "Changesets may be linked via 'Fixed in Changeset' or associated changeset links.",
          });
        }

        const changesetResults: Record<string, unknown>[] = [];

        for (const changesetId of changesetIds) {

          try {
            const changeset = await tfvcApi.getChangeset(
              changesetId,
              project,
              maxFiles,
              true,
              true
            );

            const changes = await tfvcApi.getChangesetChanges(
              changesetId,
              undefined,
              maxFiles
            );

            const fileChanges = (changes || []).map((change) => ({
              changeType: change.changeType,
              path: change.item?.path,
              version: change.item?.version,
            }));

            let fileContents: { path: string; content: string }[] | undefined;
            if (includeFileContent && fileChanges.length > 0) {
              fileContents = [];
              for (const fc of fileChanges.slice(0, maxFiles)) {
                if (!fc.path) continue;
                try {
                  const stream = await tfvcApi.getItemContent(
                    fc.path,
                    project,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    {
                      version: String(changesetId),
                      versionType: 1, // Changeset
                    }
                  );
                  if (stream) {
                    const chunks: Buffer[] = [];
                    for await (const chunk of stream) {
                      chunks.push(Buffer.from(chunk));
                    }
                    const content = Buffer.concat(chunks).toString("utf-8");
                    fileContents.push({
                      path: fc.path,
                      content:
                        content.length > FILE_CONTENT_TRUNCATION_LIMIT
                          ? content.substring(0, FILE_CONTENT_TRUNCATION_LIMIT) +
                            "\n... [truncated, file too large]"
                          : content,
                    });
                  }
                } catch (err: unknown) {
                  fileContents.push({
                    path: fc.path,
                    content: `[Could not retrieve file content: ${extractErrorMessage(err)}]`,
                  });
                }
              }
            }

            changesetResults.push({
              changesetId: changeset.changesetId,
              author: changeset.author?.displayName,
              createdDate: changeset.createdDate,
              comment: changeset.comment,
              checkinNotes: changeset.checkinNotes,
              fileChanges,
              ...(fileContents ? { fileContents } : {}),
              associatedWorkItems: changeset.workItems?.map((wi) => ({
                id: wi.id,
                title: wi.title,
                url: wi.url,
              })),
            });
          } catch (err: unknown) {
            const msg = extractErrorMessage(err);
            changesetResults.push({
              changesetId,
              error: `Failed to fetch changeset: ${msg}`,
            });
          }
        }

        const result = {
          workItem: {
            id: workItem.id,
            type: workItem.fields?.["System.WorkItemType"],
            title: workItem.fields?.["System.Title"],
            state: workItem.fields?.["System.State"],
          },
          totalChangesets: changesetResults.length,
          changesets: changesetResults,
        };

        return jsonResponse(result);
      })
  );
}
