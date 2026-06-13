import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, basename } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// First prose paragraph of the file (headings skipped, blockquote markers
// stripped) — surfaces in resources/list so clients see what a template is for
// without reading it. Captured once at registration; only the description goes
// stale on file edits, content reads stay live.
function extractDescription(fullPath: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(fullPath, "utf-8");
  } catch {
    return undefined;
  }
  const collected: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const text = line.replace(/^>\s?/, "").trim();
    if (text === "" || text.startsWith("#")) {
      if (collected.length > 0) break;
      continue;
    }
    collected.push(text);
  }
  if (collected.length === 0) return undefined;
  const joined = collected.join(" ");
  return joined.length > 200 ? `${joined.slice(0, 197)}...` : joined;
}

export function registerExternalResources(server: McpServer): Set<string> {
  const registered = new Set<string>();
  const dir = process.env.AZURE_DEVOPS_RESOURCE_DIR;
  if (!dir) return registered;

  let entries: string[];
  try {
    // Sort: readdir order is filesystem-dependent, so the same template dir
    // would list in different order across machines, defeating client cache.
    entries = readdirSync(dir).sort();
  } catch (err: unknown) {
    console.error(
      `External resources: could not read AZURE_DEVOPS_RESOURCE_DIR (${dir}): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return registered;
  }

  for (const entry of entries) {
    if (extname(entry).toLowerCase() !== ".md") continue;
    const fullPath = join(dir, entry);

    try {
      if (!statSync(fullPath).isFile()) continue;
    } catch {
      continue;
    }

    const name = basename(entry, extname(entry));
    if (registered.has(name)) continue;

    const description = extractDescription(fullPath);

    // Opaque form (`template:<encoded>`, no `://` authority): the raw basename
    // can contain spaces/special chars that make an authority-form URI invalid
    // per RFC3986. encodeURIComponent keeps it spec-compliant; `title` stays
    // human-readable and the URI is just an opaque client handle.
    const uri = `template:${encodeURIComponent(name)}`;

    server.registerResource(
      name,
      uri,
      {
        title: name,
        ...(description ? { description } : {}),
        mimeType: "text/markdown",
      },
      async () => {
        const text = readFileSync(fullPath, "utf-8");
        return {
          contents: [
            {
              uri,
              mimeType: "text/markdown",
              text,
            },
          ],
        };
      }
    );

    registered.add(name);
  }

  return registered;
}
