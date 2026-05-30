import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { IConnectionProvider } from "../connection/provider.js";

// changesetId uses z.coerce.number() because MCP delivers prompt arguments as
// strings; coercion keeps it number-typed while accepting the string sent.
export function registerTfvcPrompts(
  server: McpServer,
  _provider: IConnectionProvider
): void {
  server.registerPrompt(
    "changeset_summary",
    {
      title: "Summarize a TFVC changeset",
      description:
        "Summarize a TFVC changeset — purpose, files touched, and scope/risk notes.",
      argsSchema: {
        changesetId: z.coerce.number().describe("TFVC changeset ID"),
      },
    },
    ({ changesetId }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Summarize TFVC changeset ${changesetId}.`,
              "",
              "This task is ADVISORY and READ-ONLY. Use only this server's read tools — do not modify anything, fetch a raw URL, or call the Azure DevOps REST API directly (a raw call won't carry this session's auth).",
              "",
              "Use tfvc_get_changeset for the details (check-in comment and associated work items) and tfvc_get_changeset_changes for the file-change list. Then write a summary covering: its purpose (from the check-in comment and linked work items), the files it touches, and any scope or risk notes.",
              "",
              `Ground every statement in the changeset data — the check-in comment, file paths, or linked work-item IDs. Where the purpose is not stated, write "not specified" rather than guessing.`,
            ].join("\n"),
          },
        },
      ],
    })
  );

  // TFVC flavor of lessons_learned: loaded only when the tfvc domain is enabled,
  // so it can name the TFVC read tools directly instead of hedging. Assumes the
  // work_items domain is also enabled (Option A — work_items is on in practice).
  server.registerPrompt(
    "lessons_learned_tfvc",
    {
      title: "Lessons learned from a resolved bug (TFVC)",
      description:
        "Analyze a resolved bug and its linked TFVC changesets to extract root cause, detection/resolution, and a concrete prevention action.",
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
              "Gather evidence efficiently — do NOT bulk-download all changed code:",
              `- get_work_item (expand "all") and get_work_item_history for #${workItemId} — description, comments, relations, and the state-change timeline (who changed what, when).`,
              "- get_work_item_changesets for the linked TFVC changesets to get the changed-file LIST. Do NOT set includeFileContent — pulling every file's content is slow and expensive.",
              "- From that list plus what the bug is about, pick only the few files most likely at fault and read just those with tfvc_get_file at the changeset version. Don't read every file, and don't grep a bulk dump — read the suspect files directly.",
              "",
              "Then report exactly three sections:",
              "(a) Root cause — what went wrong at the code or design level.",
              "(b) How it was detected and how it was resolved.",
              "(c) A concrete, specific action to prevent recurrence — not generic advice.",
              "",
              "Ground every claim in a specific ID — a comment, a history revision, a changeset ID, or a file path. Where the evidence does not support a section, write \"evidence insufficient\" rather than inventing a cause or fix.",
            ].join("\n"),
          },
        },
      ],
    })
  );
}
