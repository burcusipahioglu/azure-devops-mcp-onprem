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
    "wiki_browse",
    {
      description: "Browse wiki page tree — list child pages under a given path. Similar to a table of contents view.",
      inputSchema: {
        wikiIdentifier: z
          .string()
          .describe("Wiki name or ID"),
        path: z
          .string()
          .optional()
          .default("/")
          .describe("Parent page path, e.g. '/' for root, '/Architecture' for a section"),
      },
    },
    ({ wikiIdentifier, path }) =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getWikiContext();

        const stream = await api.getPageText(
          project,
          wikiIdentifier,
          path,
          VersionControlRecursionType.OneLevel,
          undefined,
          false // don't include content, just structure
        );

        if (!stream) {
          return {
            content: [
              { type: "text" as const, text: `Wiki path not found: ${path}` },
            ],
          };
        }

        // The response is the page content when using getPageText
        // For browsing, we use getPagesBatch instead
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
          chunks.push(Buffer.from(chunk));
        }
        const content = Buffer.concat(chunks).toString("utf-8");

        // Try to parse as JSON (when recursion returns page metadata)
        // or return raw content
        try {
          const parsed = JSON.parse(content);
          if (Array.isArray(parsed)) {
            const pages = parsed.map((p: Record<string, unknown>) => ({
              path: p.path,
              id: p.id,
              isParentPage: p.isParentPage,
              order: p.order,
            }));
            return jsonResponse(pages);
          }
          return jsonResponse(parsed);
        } catch {
          // Plain text or markdown content
          return textResponse(content);
        }
      })
  );

  server.registerTool(
    "get_wiki_page_stats",
    {
      description: "Get page view statistics for a wiki page. Useful for understanding which documentation pages are most visited.",
      inputSchema: {
        wikiIdentifier: z
          .string()
          .describe("Wiki name or ID"),
        pageId: z
          .number()
          .describe("Wiki page ID (use get_wiki_page or wiki_browse to find it)"),
        pageViewsForDays: z
          .number()
          .optional()
          .default(30)
          .describe("Number of days to look back for page views (default: 30)"),
      },
    },
    ({ wikiIdentifier, pageId, pageViewsForDays }) =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getWikiContext();

        const pageData = await api.getPageData(
          project,
          wikiIdentifier,
          pageId,
          pageViewsForDays
        );

        return jsonResponse(pageData);
      })
  );

  server.registerTool(
    "search_wiki_pages",
    {
      description: "Search for wiki pages by fetching pages in batch with view statistics. Returns page paths and view counts, useful for finding popular or recently viewed documentation.",
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
