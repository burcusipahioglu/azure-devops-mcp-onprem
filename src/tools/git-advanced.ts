import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  GitVersionType,
} from "azure-devops-node-api/interfaces/GitInterfaces.js";
import { WorkItemExpand } from "azure-devops-node-api/interfaces/WorkItemTrackingInterfaces.js";
import type { IConnectionProvider } from "../connection/provider.js";
import { withErrorHandling, jsonResponse, extractErrorMessage } from "../utils/tool-response.js";
import { topParam, skipParam } from "../utils/schemas.js";
import { SHORT_COMMIT_SHA_LENGTH } from "../constants.js";
import { resolveMe } from "../utils/me-resolver.js";

// Helpers: extract Git artifact refs from work item relations.
// Git artifact URIs are repo-qualified (unlike TFVC):
//   vstfs:///Git/Commit/<projectId>/<repoId>/<40-hex-sha>
//   vstfs:///Git/PullRequestId/<projectId>/<repoId>/<prId>
// URLs may arrive percent-encoded — decode first, then match tolerantly.
function decodeArtifactUrl(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function extractGitCommitRefs(
  relations: unknown[] | undefined
): { repositoryId: string; commitId: string }[] {
  if (!relations) return [];
  const refs: { repositoryId: string; commitId: string }[] = [];
  for (const rel of relations) {
    const relObj = rel as Record<string, unknown>;
    if (relObj.rel !== "ArtifactLink") continue;
    const rawUrl = relObj.url as string | undefined;
    if (!rawUrl) continue;
    const url = decodeArtifactUrl(rawUrl);
    if (!/vstfs:\/{2,3}Git\/Commit\//i.test(url)) continue;
    const match = url.match(/Git\/Commit\/[^/]+\/([^/]+)\/([0-9a-f]{40})/i);
    if (match) {
      refs.push({ repositoryId: match[1], commitId: match[2].toLowerCase() });
    }
  }
  return refs;
}

function extractPullRequestRefs(
  relations: unknown[] | undefined
): { repositoryId: string; pullRequestId: number }[] {
  if (!relations) return [];
  const refs: { repositoryId: string; pullRequestId: number }[] = [];
  for (const rel of relations) {
    const relObj = rel as Record<string, unknown>;
    if (relObj.rel !== "ArtifactLink") continue;
    const rawUrl = relObj.url as string | undefined;
    if (!rawUrl) continue;
    const url = decodeArtifactUrl(rawUrl);
    if (!/vstfs:\/{2,3}Git\/PullRequestId\//i.test(url)) continue;
    const match = url.match(/Git\/PullRequestId\/[^/]+\/([^/]+)\/(\d+)/i);
    if (match) {
      refs.push({
        repositoryId: match[1],
        pullRequestId: parseInt(match[2], 10),
      });
    }
  }
  return refs;
}

export function registerGitAdvancedTools(server: McpServer, provider: IConnectionProvider): void {
  server.registerTool(
    "list_commits",
    {
      description: "List commits in a Git repository with optional filters (author, date range, path, branch). Returns commit history with messages, authors, and dates.",
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        repositoryId: z.string().describe("Repository name or ID"),
        branch: z
          .string()
          .optional()
          .describe("Branch name (defaults to default branch)"),
        author: z
          .string()
          .optional()
          .describe("Filter by author name or email. Pass '@me' to filter to the authenticated user."),
        fromDate: z
          .string()
          .optional()
          .describe("Start date (ISO format, e.g. 2026-01-01)"),
        toDate: z
          .string()
          .optional()
          .describe("End date (ISO format, e.g. 2026-04-11)"),
        itemPath: z
          .string()
          .optional()
          .describe("Filter commits affecting this file/folder path"),
        top: topParam(25),
        skip: skipParam(),
      },
    },
    ({ repositoryId, branch, author, fromDate, toDate, itemPath, top, skip }) =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getGitContext();

        const searchCriteria: Record<string, unknown> = {
          $top: top,
          $skip: skip,
        };

        const resolvedAuthor = await resolveMe(author, provider);
        if (resolvedAuthor) searchCriteria.author = resolvedAuthor;
        if (fromDate) searchCriteria.fromDate = fromDate;
        if (toDate) searchCriteria.toDate = toDate;
        if (itemPath) searchCriteria.itemPath = itemPath;

        if (branch) {
          searchCriteria.itemVersion = {
            version: branch.replace(/^refs\/heads\//, ""),
            versionType: GitVersionType.Branch,
          };
        }

        const commits = await api.getCommits(
          repositoryId,
          searchCriteria as Parameters<typeof api.getCommits>[1],
          project,
          skip,
          top
        );

        const result = (commits || []).map((commit) => ({
          commitId: commit.commitId,
          shortId: commit.commitId?.substring(0, SHORT_COMMIT_SHA_LENGTH),
          author: commit.author?.name,
          authorEmail: commit.author?.email,
          authorDate: commit.author?.date,
          committer: commit.committer?.name,
          committerDate: commit.committer?.date,
          comment: commit.comment,
          changeCounts: commit.changeCounts,
          url: commit.url,
        }));

        return jsonResponse(result);
      })
  );

  server.registerTool(
    "get_commit_changes",
    {
      description: "Get the list of file changes (adds, edits, deletes) in a specific Git commit",
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        repositoryId: z.string().describe("Repository name or ID"),
        commitId: z.string().describe("Full commit SHA"),
        top: topParam(100),
        skip: skipParam(),
      },
    },
    ({ repositoryId, commitId, top, skip }) =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getGitContext();

        const changes = await api.getChanges(
          commitId,
          repositoryId,
          project,
          top,
          skip
        );

        const result = {
          changeCounts: changes.changeCounts,
          changes: (changes.changes || []).map((change) => ({
            changeType: change.changeType,
            path: change.item?.path,
            originalPath: change.originalPath,
            isFolder: change.item?.isFolder,
          })),
        };

        return jsonResponse(result);
      })
  );

  server.registerTool(
    "compare_branches",
    {
      description: "Compare two branches or commits — shows ahead/behind counts and changed files. Useful for reviewing what changed between branches before creating a PR.",
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        repositoryId: z.string().describe("Repository name or ID"),
        baseBranch: z
          .string()
          .describe("Base branch or commit (e.g. 'main' or a full commit SHA)"),
        targetBranch: z
          .string()
          .describe("Target branch or commit to compare against base"),
        top: topParam(100),
      },
    },
    ({ repositoryId, baseBranch, targetBranch, top }) =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getGitContext();

        const baseDescriptor = {
          version: baseBranch.replace(/^refs\/heads\//, ""),
          versionType: GitVersionType.Branch,
        };

        const targetDescriptor = {
          version: targetBranch.replace(/^refs\/heads\//, ""),
          versionType: GitVersionType.Branch,
        };

        const diffs = await api.getCommitDiffs(
          repositoryId,
          project,
          true, // diffCommonCommit
          top,
          undefined,
          baseDescriptor as Parameters<typeof api.getCommitDiffs>[5],
          targetDescriptor as Parameters<typeof api.getCommitDiffs>[6]
        );

        const result = {
          aheadCount: diffs.aheadCount,
          behindCount: diffs.behindCount,
          baseCommit: diffs.baseCommit,
          targetCommit: diffs.targetCommit,
          commonCommit: diffs.commonCommit,
          changeCounts: diffs.changeCounts,
          allChangesIncluded: diffs.allChangesIncluded,
          changes: (diffs.changes || []).map((change) => ({
            changeType: change.changeType,
            path: change.item?.path,
            originalPath: change.originalPath,
          })),
        };

        return jsonResponse(result);
      })
  );

  server.registerTool(
    "get_work_item_commits",
    {
      description:
        "Get all Git commits and pull requests linked to a work item, including file changes (optional). Useful for reviewing what code changes were made for a bug fix or feature.",
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        workItemId: z
          .number()
          .describe("Work item ID (Bug, Task, User Story, etc.)"),
        includeChanges: z
          .boolean()
          .optional()
          .default(false)
          .describe("Also fetch the changed-file list per commit"),
      },
    },
    ({ workItemId, includeChanges }) =>
      withErrorHandling(async () => {
        const { api: witApi, project } = await provider.getWorkItemContext();
        const { api: gitApi } = await provider.getGitContext();

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

        const commitRefs = extractGitCommitRefs(workItem.relations);
        const prRefs = extractPullRequestRefs(workItem.relations);

        if (commitRefs.length === 0 && prRefs.length === 0) {
          return jsonResponse({
            workItem: {
              id: workItem.id,
              type: workItem.fields?.["System.WorkItemType"],
              title: workItem.fields?.["System.Title"],
            },
            message: "No Git commits or pull requests linked to this work item.",
          });
        }

        const commitResults: Record<string, unknown>[] = [];
        for (const { repositoryId, commitId } of commitRefs) {
          try {
            const commit = await gitApi.getCommit(commitId, repositoryId, project);

            let fileChanges:
              | { changeType: unknown; path: string | undefined }[]
              | undefined;
            if (includeChanges) {
              const changes = await gitApi.getChanges(
                commitId,
                repositoryId,
                project
              );
              fileChanges = (changes.changes || []).map((change) => ({
                changeType: change.changeType,
                path: change.item?.path,
              }));
            }

            commitResults.push({
              commitId: commit.commitId,
              shortId: commit.commitId?.substring(0, SHORT_COMMIT_SHA_LENGTH),
              repositoryId,
              author: commit.author?.name,
              authorEmail: commit.author?.email,
              authorDate: commit.author?.date,
              comment: commit.comment,
              ...(fileChanges ? { fileChanges } : {}),
            });
          } catch (err: unknown) {
            commitResults.push({
              commitId,
              repositoryId,
              error: `Failed to fetch commit: ${extractErrorMessage(err)}`,
            });
          }
        }

        const pullRequestResults: Record<string, unknown>[] = [];
        for (const { repositoryId, pullRequestId } of prRefs) {
          try {
            const pr = await gitApi.getPullRequest(
              repositoryId,
              pullRequestId,
              project
            );
            pullRequestResults.push({
              pullRequestId: pr.pullRequestId,
              repositoryId,
              title: pr.title,
              status: pr.status,
              createdBy: pr.createdBy?.displayName,
              creationDate: pr.creationDate,
              sourceBranch: pr.sourceRefName,
              targetBranch: pr.targetRefName,
            });
          } catch (err: unknown) {
            pullRequestResults.push({
              pullRequestId,
              repositoryId,
              error: `Failed to fetch pull request: ${extractErrorMessage(err)}`,
            });
          }
        }

        return jsonResponse({
          workItem: {
            id: workItem.id,
            type: workItem.fields?.["System.WorkItemType"],
            title: workItem.fields?.["System.Title"],
            state: workItem.fields?.["System.State"],
          },
          totalCommits: commitResults.length,
          commits: commitResults,
          pullRequests: pullRequestResults,
        });
      })
  );
}
