#!/usr/bin/env node
import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, resolve } from "node:path";

// Resolve which .env file to load.
// Precedence:
//   1. AZURE_DEVOPS_ENV_FILE  (explicit path, absolute or relative to project root)
//   2. AZURE_DEVOPS_PROFILE   (loads .env.<profile> from project root)
//   3. .env                   (default)
// In all cases, variables already set in process.env (e.g. from the MCP client
// config) take precedence — dotenv does not override existing vars.
const __filename = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(__filename), "..");

function resolveEnvPath(): string {
  const explicit = process.env.AZURE_DEVOPS_ENV_FILE;
  if (explicit) {
    return isAbsolute(explicit) ? explicit : resolve(projectRoot, explicit);
  }
  const profile = process.env.AZURE_DEVOPS_PROFILE;
  if (profile) {
    return resolve(projectRoot, `.env.${profile}`);
  }
  return resolve(projectRoot, ".env");
}

const envPath = resolveEnvPath();
// quiet: suppress dotenv's stdout banner ("◇ injected env ...") which
// otherwise corrupts the MCP stdio JSON-RPC channel.
const envLoadResult = loadEnv({ path: envPath, quiet: true });
const envFileLoaded = !envLoadResult.error && existsSync(envPath);
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ALL_DOMAINS, DomainName, loadConfig } from "./config.js";
import { AzureDevOpsConnectionProvider } from "./connection/provider.js";
import { registerWorkItemTools } from "./tools/work-items.js";
import { registerGitTools } from "./tools/git.js";
import { registerPipelineTools } from "./tools/pipelines.js";
import { registerTfvcTools } from "./tools/tfvc.js";
import { registerConvenienceTools } from "./tools/convenience.js";
import { registerGitAdvancedTools } from "./tools/git-advanced.js";
import { registerTestManagementTools } from "./tools/test-management.js";
import { registerWikiTools } from "./tools/wiki.js";
import { registerExternalResources } from "./resources/external.js";

const config = loadConfig();
const provider = new AzureDevOpsConnectionProvider(config);

// Sent to the MCP client at handshake — guides AI behavior on cross-cutting
// policy and conventions that don't fit cleanly in any single tool description.
// Keep minimal; domain/tool coverage is discoverable via tools/list.
const SERVER_INSTRUCTIONS = [
  "Filter parameters (owner / author / assignedTo) accept the @me token, resolved per tenant.",
  "",
  "Write safety: every mutating tool short-circuits through an audit wrapper. AZURE_DEVOPS_MODE=readonly refuses all writes; a 10/min global rate limit and optional JSONL audit log apply.",
].join("\n");

const server = new McpServer(
  { name: config.serverName, version: "1.3.0" },
  {
    capabilities: {
      prompts: { listChanged: true },
      resources: { listChanged: true },
    },
    instructions: SERVER_INSTRUCTIONS,
  }
);

type ToolRegister = (server: McpServer, provider: AzureDevOpsConnectionProvider) => void;

const domainModules: Record<DomainName, ToolRegister[]> = {
  work_items: [registerWorkItemTools],
  git: [registerGitTools, registerGitAdvancedTools],
  tfvc: [registerTfvcTools],
  pipelines: [registerPipelineTools],
  wiki: [registerWikiTools],
  test_plans: [registerTestManagementTools],
  convenience: [registerConvenienceTools],
};

for (const domain of ALL_DOMAINS) {
  if (!config.enabledDomains.has(domain)) continue;
  for (const register of domainModules[domain]) {
    register(server, provider);
  }
}

const loadedResources = registerExternalResources(server);

type PromptRegister = (server: McpServer, provider: AzureDevOpsConnectionProvider) => void;

const promptModules: Partial<Record<DomainName, PromptRegister[]>> = {};

for (const domain of ALL_DOMAINS) {
  if (!config.enabledDomains.has(domain)) continue;
  for (const reg of promptModules[domain] ?? []) reg(server, provider);
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const envSource = envFileLoaded
    ? `env file: ${envPath}`
    : "env file: (none — using process env only)";

  const enabled = ALL_DOMAINS.filter((d) => config.enabledDomains.has(d));
  const disabled = ALL_DOMAINS.filter((d) => !config.enabledDomains.has(d));
  const domainLine = `Enabled domains (${enabled.length}/${ALL_DOMAINS.length}): ${enabled.join(", ")}`;
  const disabledLine =
    disabled.length > 0 ? `Disabled domains: ${disabled.join(", ")}` : null;
  const resourceLine = `External resources loaded: ${loadedResources.size}${
    loadedResources.size > 0 ? ` (${[...loadedResources].join(", ")})` : ""
  }`;

  try {
    const user = await provider.resolveCurrentUser();
    console.error(`Azure DevOps MCP Server "${config.serverName}" running on stdio`);
    console.error(envSource);
    console.error(domainLine);
    if (disabledLine) console.error(disabledLine);
    console.error(resourceLine);
    console.error(`Authenticated as: ${user.displayName} (${user.uniqueName})`);
  } catch {
    console.error(`Azure DevOps MCP Server "${config.serverName}" running on stdio`);
    console.error(envSource);
    console.error(domainLine);
    if (disabledLine) console.error(disabledLine);
    console.error(resourceLine);
    console.error("Warning: Could not resolve current user identity");
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
