import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, basename } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerExternalResources(server: McpServer): Set<string> {
  const registered = new Set<string>();
  const dir = process.env.AZURE_DEVOPS_RESOURCE_DIR;
  if (!dir) return registered;

  let entries: string[];
  try {
    entries = readdirSync(dir);
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

    const uri = `template://${name}`;

    server.registerResource(
      name,
      uri,
      {
        title: name,
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
