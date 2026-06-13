import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { IConnectionProvider } from "../connection/provider.js";

// pullRequestId uses z.coerce.number(): MCP delivers prompt arguments as
// strings (the protocol types them Record<string,string>), so a bare
// z.number() would reject the incoming "123" at validation. Coercion keeps the
// argument number-typed while accepting the string the client actually sends.
export function registerGitPrompts(
  server: McpServer,
  _provider: IConnectionProvider
): void {
  server.registerPrompt(
    "summarize_pull_request",
    {
      title: "Summarize a pull request",
      description:
        "Concise plain-language summary of what a pull request does — purpose, key files, and scope.",
      argsSchema: {
        repository: z.string().describe("Repository name or ID"),
        pullRequestId: z.coerce.number().describe("Pull request ID"),
      },
    },
    ({ repository, pullRequestId }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Summarize pull request #${pullRequestId} in repository ${repository}.`,
              "",
              "This task is ADVISORY and READ-ONLY. Use only this server's read tools — do not post comments, approve, complete, fetch a raw URL, or call the Azure DevOps REST API directly (a raw call won't carry this session's auth).",
              "",
              "Read the PR metadata with get_pull_request (title, source/target branches, reviewers, status), then its changed-file list with get_commit_changes using the lastMergeSourceCommit from that response as the commitId. Then write a concise summary covering: its purpose, the key files it touches, and its overall scope.",
              "",
              "Ground the summary in the actual PR data and file paths. Where intent is not stated, write \"not specified\" rather than guessing.",
            ].join("\n"),
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "review_pull_request",
    {
      title: "Review a pull request",
      description:
        "Structured, advisory code review of a pull request — risks, test gaps, maintainability, and questions for the author.",
      argsSchema: {
        repository: z.string().describe("Repository name or ID"),
        pullRequestId: z.coerce.number().describe("Pull request ID"),
      },
    },
    ({ repository, pullRequestId }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Review pull request #${pullRequestId} in repository ${repository}.`,
              "",
              "Producing this review is ADVISORY and READ-ONLY: do not post, vote, approve, or call any write tool while gathering evidence and writing it — deliver the review as your reply. Use only this server's read tools; do not fetch raw URLs or call the Azure DevOps REST API directly (a raw call won't carry this session's auth and will just hit a login page).",
              "",
              "Gather context: get_pull_request for metadata (note its lastMergeTargetCommit and lastMergeSourceCommit), then get_commit_changes for the changed-file list, using lastMergeSourceCommit as the commitId. For the MOST RELEVANT changed files, get just the changed hunks with get_file_diff (baseVersion = lastMergeTargetCommit, targetVersion = lastMergeSourceCommit) — far cheaper than whole files and focused on the change. ONLY when a change's correctness depends on code outside the hunk, read that file in full with get_file_content. Don't review every file; large diffs/files may be truncated by the tools, which is fine.",
              "",
              "Produce a structured review with exactly these sections:",
              "- Summary — what the PR does.",
              "- Potential Risks — correctness, security, or regression concerns.",
              "- Missing/Insufficient Tests — what is untested or under-tested.",
              "- Style/Maintainability Notes — readability and long-term maintenance.",
              "- Questions for Author — what needs clarification.",
              "",
              "Cite specific file paths for each point. Where you lack the evidence to judge a section, write \"evidence insufficient\" rather than speculating.",
              "",
              "ONLY IF the user explicitly asks afterwards to publish this review to the PR: post each finding as its own add_pull_request_comment, anchored to the file it concerns (filePath + line from the changed-file list), and the Summary as one general comment. Show the user the comment set and get their confirmation before posting (dryRun: true previews the payload). Never vote, approve, or resolve threads — even when asked to publish comments.",
            ].join("\n"),
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "analyze_commit_range",
    {
      title: "Analyze a commit range",
      description:
        "Changelog / release-notes style summary of the commits between two branches, grouped by theme.",
      argsSchema: {
        repository: z.string().describe("Repository name or ID"),
        baseBranch: z.string().describe("Base branch (e.g. main)"),
        targetBranch: z.string().describe("Target branch to compare against base"),
      },
    },
    ({ repository, baseBranch, targetBranch }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Analyze what changed between ${baseBranch} and ${targetBranch} in repository ${repository}.`,
              "",
              "This task is ADVISORY and READ-ONLY. Use only this server's read tools — do not modify any branch/commit/PR, fetch a raw URL, or call the Azure DevOps REST API directly (a raw call won't carry this session's auth).",
              "",
              "Use compare_branches for ahead/behind and the changed-file list, and list_commits for the commit messages in the range; consult get_commit_changes per commit only where you need more detail.",
              "",
              "Produce a changelog / release-notes style summary grouped by theme: Features, Fixes, and Refactors. Where a commit's intent is ambiguous, mark the grouping as uncertain rather than asserting it.",
              "",
              "Ground each entry in commit messages or file paths. Where the range is empty or the intent is unclear, say so explicitly.",
            ].join("\n"),
          },
        },
      ],
    })
  );

  // Git flavor of lessons_learned: loaded only when the git domain is enabled,
  // so it can name the Git read tools directly instead of hedging. Assumes the
  // work_items domain is also enabled (Option A — work_items is on in practice).
  server.registerPrompt(
    "lessons_learned_git",
    {
      title: "Lessons learned from a resolved bug (Git)",
      description:
        "Analyze a resolved bug and its linked Git commits and pull requests to extract root cause, detection/resolution, and a concrete prevention action.",
      argsSchema: {
        workItemId: z.string().describe("Resolved bug work item ID"),
      },
    },
    ({ workItemId }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Produce a "lessons learned" report for resolved bug work item ${workItemId}.`,
              "",
              "This task is ADVISORY and READ-ONLY. Use only this server's read tools — never call a write tool, post a comment, fetch a raw URL, or call the Azure DevOps REST API directly (a raw call won't carry this session's auth and will just hit a login page).",
              "",
              "Gather evidence:",
              `- get_work_item (expand "all") and get_work_item_history for #${workItemId} — description, comments, relations, and the state-change timeline (who changed what, when).`,
              "- get_work_item_commits for the linked commits and pull requests; set includeChanges for the changed-file list. Use get_pull_request for review context on a linked PR.",
              "",
              "Then report exactly three sections:",
              "(a) Root cause — what went wrong at the code or design level.",
              "(b) How it was detected and how it was resolved.",
              "(c) A concrete, specific action to prevent recurrence — not generic advice.",
              "",
              "Ground every claim in a specific ID — a comment, a history revision, a commit SHA, or a pull request ID. Where the evidence does not support a section, write \"evidence insufficient\" rather than inventing a cause or fix.",
            ].join("\n"),
          },
        },
      ],
    })
  );

  // Argument-free: nothing to fill in the client — it always reports the
  // authenticated user's review queue across the whole project.
  server.registerPrompt(
    "my_review_queue",
    {
      title: "My pull request review queue",
      description:
        "List the active pull requests assigned to me as a reviewer across the project, oldest first.",
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "List the pull requests assigned to me as a reviewer, oldest first.",
              "",
              "This task is ADVISORY and READ-ONLY. Use only this server's read tools — do not vote, approve, comment on, or otherwise modify any pull request.",
              "",
              "Call list_pull_requests with reviewer set to \"@me\" and NO repositoryId (so it spans the whole project), status active. Then present the results sorted by creation date, oldest → newest.",
              "",
              "For each PR show: id, title, repository, author, creation date, and my current vote/state as reviewer. If nothing is awaiting my review, say so plainly.",
            ].join("\n"),
          },
        },
      ],
    })
  );
}
