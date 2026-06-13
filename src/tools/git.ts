import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  GitVersionType,
  PullRequestStatus,
  CommentThreadStatus,
  CommentType,
} from "azure-devops-node-api/interfaces/GitInterfaces.js";
import type { IConnectionProvider } from "../connection/provider.js";
import { withErrorHandling, jsonResponse, textResponse, dryRunResponse, structuredResponse, toIso } from "../utils/tool-response.js";
import { topParam, dryRunParam } from "../utils/schemas.js";
import { withAudit } from "../utils/audit.js";
import { resolveMeId } from "../utils/me-resolver.js";
import { decodeFileContent } from "../utils/file-content.js";

// Typed-results first wave. Every field optional — server version differences
// must never fail validation. Status enums arrive as numbers from the API.
const pullRequestSummary = z.object({
  id: z.number().optional(),
  title: z.string().optional(),
  status: z.union([z.number(), z.string()]).optional(),
  repository: z.string().optional(),
  createdBy: z.string().optional(),
  creationDate: z.string().optional(),
  sourceBranch: z.string().optional(),
  targetBranch: z.string().optional(),
  mergeStatus: z.union([z.number(), z.string()]).optional(),
  reviewers: z
    .array(
      z.object({
        name: z.string().optional(),
        vote: z.number().optional(),
      })
    )
    .optional(),
});

const listPullRequestsOutput = {
  count: z.number().describe("Number of pull requests returned"),
  items: z.array(pullRequestSummary),
};

const getPullRequestOutput = {
  id: z.number().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  status: z.union([z.number(), z.string()]).optional(),
  isDraft: z.boolean().optional(),
  repository: z.string().optional(),
  createdBy: z.string().optional(),
  creationDate: z.string().optional(),
  closedDate: z.string().optional(),
  sourceBranch: z.string().optional(),
  targetBranch: z.string().optional(),
  mergeStatus: z.union([z.number(), z.string()]).optional(),
  lastMergeSourceCommit: z.string().optional(),
  reviewers: z
    .array(
      z.object({
        name: z.string().optional(),
        vote: z.number().optional(),
        isRequired: z.boolean().optional(),
      })
    )
    .optional(),
  labels: z.array(z.string().optional()).optional(),
  url: z.string().optional(),
};

export function registerGitTools(server: McpServer, provider: IConnectionProvider): void {
  server.registerTool(
    "list_repositories",
    {
      description: "List all Git repositories in the Azure DevOps project",
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
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
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
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
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        repositoryId: z.string().describe("Repository name or ID"),
        path: z
          .string()
          .describe("File path within the repo, e.g. /src/index.ts"),
        branch: z
          .string()
          .optional()
          .describe("Branch name (defaults to default branch)"),
        maxBytes: z
          .number()
          .optional()
          .describe("Truncate file content to this many characters (default uses FILE_CONTENT_TRUNCATION_LIMIT)"),
      },
    },
    ({ repositoryId, path, branch, maxBytes }) =>
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
        const decoded = decodeFileContent(Buffer.concat(chunks), maxBytes);
        if (decoded.binary) {
          return textResponse(`[Binary file — content not shown: ${path}]`);
        }
        return textResponse(decoded.content);
      })
  );

  server.registerTool(
    "list_pull_requests",
    {
      description: "List pull requests with optional filters. Omit repositoryId to search the whole project. Filter by reviewer to find PRs assigned to a person for review.",
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        repositoryId: z
          .string()
          .optional()
          .describe("Repository name or ID. Omit to search across the entire project."),
        reviewer: z
          .string()
          .optional()
          .describe("Only PRs where this person is a reviewer. Pass '@me' for the authenticated user (resolved to their id)."),
        status: z
          .enum(["active", "abandoned", "completed", "all"])
          .optional()
          .default("active")
          .describe("PR status filter"),
        top: topParam(25),
      },
      outputSchema: listPullRequestsOutput,
    },
    ({ repositoryId, reviewer, status, top }) =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getGitContext();

        const statusMap: Record<string, PullRequestStatus> = {
          active: PullRequestStatus.Active,
          abandoned: PullRequestStatus.Abandoned,
          completed: PullRequestStatus.Completed,
          all: PullRequestStatus.All,
        };

        const searchCriteria = {
          status: statusMap[status],
          reviewerId: await resolveMeId(reviewer, provider),
        };

        // Per-repo when a repositoryId is given; otherwise project-wide.
        const prs = repositoryId
          ? await api.getPullRequests(
              repositoryId,
              searchCriteria,
              project,
              undefined,
              undefined,
              top
            )
          : await api.getPullRequestsByProject(
              project,
              searchCriteria,
              undefined,
              undefined,
              top
            );

        const result = (prs || []).map((pr) => ({
          id: pr.pullRequestId,
          title: pr.title,
          status: pr.status,
          repository: pr.repository?.name,
          createdBy: pr.createdBy?.displayName,
          creationDate: toIso(pr.creationDate),
          sourceBranch: pr.sourceRefName,
          targetBranch: pr.targetRefName,
          mergeStatus: pr.mergeStatus,
          reviewers: pr.reviewers?.map((r) => ({
            name: r.displayName,
            vote: r.vote,
          })),
        }));

        return structuredResponse({ count: result.length, items: result }, result);
      })
  );

  server.registerTool(
    "get_pull_request",
    {
      description: "Get detailed information about a specific pull request",
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        repositoryId: z.string().describe("Repository name or ID"),
        pullRequestId: z.number().describe("Pull request ID"),
      },
      outputSchema: getPullRequestOutput,
    },
    ({ repositoryId, pullRequestId }) =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getGitContext();

        const pr = await api.getPullRequest(
          repositoryId,
          pullRequestId,
          project
        );

        return structuredResponse({
          id: pr.pullRequestId,
          title: pr.title,
          description: pr.description,
          status: pr.status,
          isDraft: pr.isDraft,
          repository: pr.repository?.name,
          createdBy: pr.createdBy?.displayName,
          creationDate: toIso(pr.creationDate),
          closedDate: toIso(pr.closedDate),
          sourceBranch: pr.sourceRefName,
          targetBranch: pr.targetRefName,
          mergeStatus: pr.mergeStatus,
          lastMergeSourceCommit: pr.lastMergeSourceCommit?.commitId,
          reviewers: pr.reviewers?.map((r) => ({
            name: r.displayName,
            vote: r.vote,
            isRequired: r.isRequired,
          })),
          labels: pr.labels?.map((l) => l.name),
          url: pr.url,
        });
      })
  );

  server.registerTool(
    "get_pull_request_comments",
    {
      description:
        "List comment threads on a pull request, including file-anchored review comments and replies. System events (vote changes, ref updates) are filtered out by default.",
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        repositoryId: z.string().describe("Repository name or ID"),
        pullRequestId: z.number().describe("Pull request ID"),
        includeSystem: z
          .boolean()
          .optional()
          .default(false)
          .describe("Also include system-generated threads (votes, updates)"),
      },
    },
    ({ repositoryId, pullRequestId, includeSystem }) =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getGitContext();

        const threads = await api.getThreads(
          repositoryId,
          pullRequestId,
          project
        );

        const result = (threads || [])
          .filter((thread) => !thread.isDeleted)
          .filter(
            (thread) =>
              includeSystem ||
              thread.comments?.some((c) => c.commentType === CommentType.Text)
          )
          .map((thread) => ({
            threadId: thread.id,
            status: thread.status,
            filePath: thread.threadContext?.filePath,
            line: thread.threadContext?.rightFileStart?.line,
            lastUpdatedDate: toIso(thread.lastUpdatedDate),
            comments: (thread.comments || [])
              .filter((c) => includeSystem || c.commentType === CommentType.Text)
              .map((c) => ({
                id: c.id,
                parentCommentId: c.parentCommentId,
                author: c.author?.displayName,
                content: c.content,
                publishedDate: toIso(c.publishedDate),
              })),
          }));

        return jsonResponse(result);
      })
  );

  server.registerTool(
    "add_pull_request_comment",
    {
      description:
        "Add a comment to a pull request — a general comment, a file-anchored review comment (pass filePath + line), or a reply to an existing thread (pass threadId; find it with get_pull_request_comments). WARNING: This is a WRITE operation that notifies PR participants and cannot be silently undone. Show the user the PR ID and comment text before calling, and ask for confirmation. Tip: pass dryRun: true first to preview the exact payload before posting.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        repositoryId: z.string().describe("Repository name or ID"),
        pullRequestId: z.number().describe("Pull request ID"),
        content: z.string().describe("Comment text (markdown supported)"),
        threadId: z
          .number()
          .optional()
          .describe("Reply to this existing thread instead of starting a new one. Takes precedence over filePath."),
        filePath: z
          .string()
          .optional()
          .describe("Anchor the comment to this file in the PR diff, repo-relative with leading slash, e.g. /src/index.ts"),
        line: z
          .number()
          .optional()
          .describe("Line number in the file (new version of the diff) to anchor to. Only used with filePath; defaults to 1."),
        dryRun: dryRunParam,
      },
    },
    (input) =>
      withAudit(provider, "add_pull_request_comment", input, () => withErrorHandling(async () => {
        const { repositoryId, pullRequestId, content, threadId, filePath, line, dryRun } = input;
        const { api, project } = await provider.getGitContext();

        if (threadId !== undefined) {
          // Reply mode
          const comment = { content, commentType: CommentType.Text };

          if (dryRun) {
            return dryRunResponse({
              action: "WOULD_REPLY_TO_PR_THREAD",
              wouldBe: { project, repositoryId, pullRequestId, threadId, payload: comment },
              notes: "No reply posted, no notifications sent. Re-call with dryRun omitted or false to post.",
            });
          }

          const created = await api.createComment(
            comment,
            repositoryId,
            pullRequestId,
            threadId,
            project
          );

          return jsonResponse({
            action: "REPLY_ADDED",
            pullRequestId,
            threadId,
            commentId: created.id,
            author: created.author?.displayName,
            publishedDate: toIso(created.publishedDate),
          });
        }

        // New thread mode (general or file-anchored)
        const thread = {
          comments: [{ content, commentType: CommentType.Text }],
          status: CommentThreadStatus.Active,
          ...(filePath
            ? {
                threadContext: {
                  filePath,
                  rightFileStart: { line: line ?? 1, offset: 1 },
                  rightFileEnd: { line: line ?? 1, offset: 1 },
                },
              }
            : {}),
        };

        if (dryRun) {
          return dryRunResponse({
            action: "WOULD_ADD_PR_COMMENT",
            wouldBe: { project, repositoryId, pullRequestId, payload: thread },
            notes: "No comment posted, no notifications sent. Re-call with dryRun omitted or false to post.",
          });
        }

        const created = await api.createThread(
          thread,
          repositoryId,
          pullRequestId,
          project
        );

        return jsonResponse({
          action: "COMMENT_ADDED",
          pullRequestId,
          threadId: created.id,
          status: created.status,
          filePath: created.threadContext?.filePath,
          commentId: created.comments?.[0]?.id,
        });
      }))
  );

  server.registerTool(
    "create_pull_request",
    {
      description: "Create a new pull request. WARNING: This is a WRITE operation that notifies reviewers and creates a record visible to the team. Show the user the repository, title, source/target branches, and reviewers before calling, and ask for confirmation. Tip: pass dryRun: true first to preview the exact payload before posting.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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
        dryRun: dryRunParam,
      },
    },
    (input) =>
      withAudit(provider, "create_pull_request", input, () => withErrorHandling(async () => {
        const { repositoryId, title, description, sourceBranch, targetBranch, reviewers, dryRun } = input;
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

        if (dryRun) {
          return dryRunResponse({
            action: "WOULD_CREATE_PULL_REQUEST",
            wouldBe: { project, repositoryId, payload: prToCreate },
            notes: "No PR created, no reviewers notified. Re-call with dryRun omitted or false to post.",
          });
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
      }))
  );
}
