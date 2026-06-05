import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  VersionControlRecursionType,
} from "azure-devops-node-api/interfaces/GitInterfaces.js";
import type { IConnectionProvider } from "../connection/provider.js";
import { withErrorHandling, jsonResponse, textResponse } from "../utils/tool-response.js";
import { topParam } from "../utils/schemas.js";

export function registerWikiTools(server: McpServer, provider: IConnectionProvider): void {
  server.registerTool(
    "list_wikis",
    {
      description: "List all wikis in the project. Azure DevOps supports project wikis and code wikis (backed by a Git repository).",
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
      inputSchema: {},
    },
    () =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getWikiContext();

        const wikis = await api.getAllWikis(project);

        const result = (wikis || []).map((wiki) => ({
          id: wiki.id,
          name: wiki.name,
          type: wiki.type,
          remoteUrl: wiki.remoteUrl,
          url: wiki.url,
          repositoryId: wiki.repositoryId,
          mappedPath: wiki.mappedPath,
        }));

        return jsonResponse(result);
      })
  );

  server.registerTool(
    "get_wiki_page",
    {
      description: "Get the content of a wiki page by path. Returns the page content in Markdown format.",
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
      inputSchema: {
        wikiIdentifier: z
          .string()
          .describe("Wiki name or ID (use list_wikis to find it)"),
        path: z
          .string()
          .describe("Page path, e.g. '/Home', '/Architecture/Overview'"),
        includeChildren: z
          .boolean()
          .optional()
          .default(false)
          .describe("Include child page paths (one level)"),
      },
    },
    ({ wikiIdentifier, path, includeChildren }) =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getWikiContext();

        const recursionLevel = includeChildren
          ? VersionControlRecursionType.OneLevel
          : VersionControlRecursionType.None;

        const stream = await api.getPageText(
          project,
          wikiIdentifier,
          path,
          recursionLevel,
          undefined,
          true // includeContent
        );

        if (!stream) {
          return textResponse(`Wiki page not found: ${path}`);
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
    "list_wiki_pages",
    {
      description: "List all pages in a wiki with view statistics. Page paths encode the hierarchy (e.g. '/Architecture/Overview') — use this as the table of contents, then read specific pages with get_wiki_page. View counts help find popular or recently viewed documentation.",
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
      inputSchema: {
        wikiIdentifier: z
          .string()
          .describe("Wiki name or ID"),
        top: topParam(50),
        pageViewsForDays: z
          .number()
          .optional()
          .default(30)
          .describe("Include view stats for this many days"),
      },
    },
    ({ wikiIdentifier, top, pageViewsForDays }) =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getWikiContext();

        const batchRequest = {
          pageViewsForDays,
          top,
        };

        const pages = await api.getPagesBatch(
          batchRequest as Parameters<typeof api.getPagesBatch>[0],
          project,
          wikiIdentifier
        );

        const result = (pages || []).map((page) => ({
          id: page.id,
          path: page.path,
          viewStats: page.viewStats?.map((stat) => ({
            day: stat.day,
            count: stat.count,
          })),
        }));

        return jsonResponse(result);
      })
  );
}
