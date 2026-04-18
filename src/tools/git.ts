import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  GitVersionType,
  PullRequestStatus,
} from "azure-devops-node-api/interfaces/GitInterfaces.js";
import type { IConnectionProvider } from "../connection/provider.js";
import { withErrorHandling, jsonResponse, textResponse } from "../utils/tool-response.js";
import { topParam } from "../utils/schemas.js";

export function registerGitTools(server: McpServer, provider: IConnectionProvider): void {
  server.registerTool(
    "list_repositories",
    {
      description: "List all Git repositories in the Azure DevOps project",
    },
    () =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getGitContext();
        const repos = await api.getRepositories(project);

        const result = (repos || []).map((repo) => ({
          id: repo.id,
          name: repo.name,
          defaultBranch: repo.defaultBranch,
          webUrl: repo.remoteUrl,
          size: repo.size,
        }));

        return jsonResponse(result);
      })
  );

  server.registerTool(
    "list_branches",
    {
      description: "List branches for a Git repository",
      inputSchema: {
        repositoryId: z.string().describe("Repository name or ID"),
      },
    },
    ({ repositoryId }) =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getGitContext();
        const branches = await api.getBranches(repositoryId, project);

        const result = (branches || []).map((branch) => ({
          name: branch.name,
          commitId: branch.commit?.commitId,
          isBaseVersion: branch.isBaseVersion,
          aheadCount: branch.aheadCount,
          behindCount: branch.behindCount,
        }));

        return jsonResponse(result);
      })
  );

  server.registerTool(
    "get_file_content",
    {
      description: "Get the content of a file from a Git repository",
      inputSchema: {
        repositoryId: z.string().describe("Repository name or ID"),
        path: z
          .string()
          .describe("File path within the repo, e.g. /src/index.ts"),
        branch: z
          .string()
          .optional()
          .describe("Branch name (defaults to default branch)"),
      },
    },
    ({ repositoryId, path, branch }) =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getGitContext();

        const versionDescriptor = branch
          ? {
              version: branch.replace(/^refs\/heads\//, ""),
              versionType: GitVersionType.Branch,
            }
          : undefined;

        const item = await api.getItemContent(
          repositoryId,
          path,
          project,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          versionDescriptor
        );

        if (!item) {
          return textResponse(`File not found: ${path}`);
        }

        const chunks: Buffer[] = [];
        for await (const chunk of item) {
          chunks.push(Buffer.from(chunk));
        }
        const content = Buffer.concat(chunks).toString("utf-8");

        return textResponse(content);
      })
  );

  server.registerTool(
    "list_pull_requests",
    {
      description: "List pull requests in a repository with optional filters",
      inputSchema: {
        repositoryId: z.string().describe("Repository name or ID"),
        status: z
          .enum(["active", "abandoned", "completed", "all"])
          .optional()
          .default("active")
          .describe("PR status filter"),
        top: topParam(25),
      },
    },
    ({ repositoryId, status, top }) =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getGitContext();

        const statusMap: Record<string, PullRequestStatus> = {
          active: PullRequestStatus.Active,
          abandoned: PullRequestStatus.Abandoned,
          completed: PullRequestStatus.Completed,
          all: PullRequestStatus.All,
        };

        const prs = await api.getPullRequests(
          repositoryId,
          { status: statusMap[status] },
          project,
          undefined,
          undefined,
          top
        );

        const result = (prs || []).map((pr) => ({
          id: pr.pullRequestId,
          title: pr.title,
          status: pr.status,
          createdBy: pr.createdBy?.displayName,
          creationDate: pr.creationDate,
          sourceBranch: pr.sourceRefName,
          targetBranch: pr.targetRefName,
          mergeStatus: pr.mergeStatus,
          reviewers: pr.reviewers?.map((r) => ({
            name: r.displayName,
            vote: r.vote,
          })),
        }));

        return jsonResponse(result);
      })
  );

  server.registerTool(
    "get_pull_request",
    {
      description: "Get detailed information about a specific pull request",
      inputSchema: {
        repositoryId: z.string().describe("Repository name or ID"),
        pullRequestId: z.number().describe("Pull request ID"),
      },
    },
    ({ repositoryId, pullRequestId }) =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getGitContext();

        const pr = await api.getPullRequest(
          repositoryId,
          pullRequestId,
          project
        );

        return jsonResponse(pr);
      })
  );

  server.registerTool(
    "create_pull_request",
    {
      description: "Create a new pull request. WARNING: This is a WRITE operation. Show the user the repository, title, source/target branches, and reviewers before calling, and ask for confirmation.",
      inputSchema: {
        repositoryId: z.string().describe("Repository name or ID"),
        title: z.string().describe("PR title"),
        description: z
          .string()
          .optional()
          .describe("PR description (markdown supported)"),
        sourceBranch: z
          .string()
          .describe(
            "Source branch name (will be prefixed with refs/heads/ if needed)"
          ),
        targetBranch: z
          .string()
          .describe(
            "Target branch name (will be prefixed with refs/heads/ if needed)"
          ),
        reviewers: z
          .array(z.string())
          .optional()
          .describe("Array of reviewer unique names or IDs"),
      },
    },
    ({ repositoryId, title, description, sourceBranch, targetBranch, reviewers }) =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getGitContext();

        const normalize = (branch: string) =>
          branch.startsWith("refs/heads/")
            ? branch
            : `refs/heads/${branch}`;

        const prToCreate: Record<string, unknown> = {
          title,
          description: description || "",
          sourceRefName: normalize(sourceBranch),
          targetRefName: normalize(targetBranch),
        };

        if (reviewers && reviewers.length > 0) {
          prToCreate.reviewers = reviewers.map((r) => ({ id: r }));
        }

        const pr = await api.createPullRequest(
          prToCreate as Parameters<typeof api.createPullRequest>[0],
          repositoryId,
          project
        );

        return jsonResponse({
          pullRequestId: pr.pullRequestId,
          title: pr.title,
          status: pr.status,
          url: pr.url,
          sourceBranch: pr.sourceRefName,
          targetBranch: pr.targetRefName,
        });
      })
  );
}
