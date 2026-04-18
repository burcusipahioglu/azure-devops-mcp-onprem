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
const envLoadResult = loadEnv({ path: envPath });
const envFileLoaded = !envLoadResult.error && existsSync(envPath);
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { AzureDevOpsConnectionProvider } from "./connection/provider.js";
import { registerWorkItemTools } from "./tools/work-items.js";
import { registerGitTools } from "./tools/git.js";
import { registerPipelineTools } from "./tools/pipelines.js";
import { registerTfvcTools } from "./tools/tfvc.js";
import { registerConvenienceTools } from "./tools/convenience.js";
import { registerGitAdvancedTools } from "./tools/git-advanced.js";
import { registerWorkItemAdvancedTools } from "./tools/work-items-advanced.js";
import { registerTestManagementTools } from "./tools/test-management.js";
import { registerWikiTools } from "./tools/wiki.js";

const config = loadConfig();
const provider = new AzureDevOpsConnectionProvider(config);

const server = new McpServer({
  name: config.serverName,
  version: "1.0.0",
});

const toolModules = [
  registerWorkItemTools,
  registerWorkItemAdvancedTools,
  registerGitTools,
  registerGitAdvancedTools,
  registerPipelineTools,
  registerTfvcTools,
  registerConvenienceTools,
  registerTestManagementTools,
  registerWikiTools,
];

for (const register of toolModules) {
  register(server, provider);
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const envSource = envFileLoaded
    ? `env file: ${envPath}`
    : "env file: (none — using process env only)";

  try {
    const user = await provider.resolveCurrentUser();
    console.error(`Azure DevOps MCP Server "${config.serverName}" running on stdio`);
    console.error(envSource);
    console.error(`Authenticated as: ${user.displayName} (${user.uniqueName})`);
  } catch {
    console.error(`Azure DevOps MCP Server "${config.serverName}" running on stdio`);
    console.error(envSource);
    console.error("Warning: Could not resolve current user identity");
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
