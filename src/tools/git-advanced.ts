import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  GitVersionType,
} from "azure-devops-node-api/interfaces/GitInterfaces.js";
import type { IConnectionProvider } from "../connection/provider.js";
import { withErrorHandling, jsonResponse } from "../utils/tool-response.js";
import { topParam, skipParam } from "../utils/schemas.js";
import { SHORT_COMMIT_SHA_LENGTH } from "../constants.js";
import { resolveMe } from "../utils/me-resolver.js";

export function registerGitAdvancedTools(server: McpServer, provider: IConnectionProvider): void {
  server.registerTool(
    "list_commits",
    {
      description: "List commits in a Git repository with optional filters (author, date range, path, branch). Returns commit history with messages, authors, and dates.",
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
}
