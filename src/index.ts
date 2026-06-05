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
import { registerStatisticsTools } from "./tools/statistics.js";
import { registerIdentityTools } from "./tools/identity.js";
import { registerGitAdvancedTools } from "./tools/git-advanced.js";
import { registerTestManagementTools } from "./tools/test-management.js";
import { registerWikiTools } from "./tools/wiki.js";
import { registerExternalResources } from "./resources/external.js";
import { auditSessionStart } from "./utils/audit.js";
import { isReadonlyMode } from "./utils/write-mode.js";
import { configuredWritesPerMin } from "./utils/rate-limit.js";
import { registerRiskPrompt } from "./prompts/work-items.js";
import { registerGitPrompts } from "./prompts/git.js";
import { registerTfvcPrompts } from "./prompts/tfvc.js";

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

const SERVER_VERSION = "1.5.0";

const server = new McpServer(
  { name: config.serverName, version: SERVER_VERSION },
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
  work_items: [registerWorkItemTools, registerStatisticsTools],
  git: [registerGitTools, registerGitAdvancedTools],
  tfvc: [registerTfvcTools],
  pipelines: [registerPipelineTools],
  wiki: [registerWikiTools],
  test_plans: [registerTestManagementTools],
};

// Core tools live outside the domain gate — always registered.
registerIdentityTools(server, provider);

for (const domain of ALL_DOMAINS) {
  if (!config.enabledDomains.has(domain)) continue;
  for (const register of domainModules[domain]) {
    register(server, provider);
  }
}

const loadedResources = registerExternalResources(server);

type PromptRegister = (server: McpServer, provider: AzureDevOpsConnectionProvider) => void;

const promptModules: Partial<Record<DomainName, PromptRegister[]>> = {
  git: [registerGitPrompts],
  tfvc: [registerTfvcPrompts],
};

for (const domain of ALL_DOMAINS) {
  if (!config.enabledDomains.has(domain)) continue;
  for (const reg of promptModules[domain] ?? []) reg(server, provider);
}

// Conditional prompt: risk_impact_analysis only makes sense when the work_items
// domain is enabled AND the team supplied a risk-impact.md template via
// AZURE_DEVOPS_RESOURCE_DIR. Gated outside the domain loop because it depends on
// a loaded resource, not just a domain.
if (config.enabledDomains.has("work_items") && loadedResources.has("risk-impact")) {
  registerRiskPrompt(server, provider);
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

  const user = await provider.resolveCurrentUser().catch(() => null);

  console.error(`Azure DevOps MCP Server "${config.serverName}" running on stdio`);
  console.error(envSource);
  console.error(domainLine);
  if (disabledLine) console.error(disabledLine);
  console.error(resourceLine);
  console.error(
    user
      ? `Authenticated as: ${user.displayName} (${user.uniqueName})`
      : "Warning: Could not resolve current user identity"
  );

  // Self-describing audit header — anchors the records that follow to the
  // server config that produced them. No-op when the audit log is off.
  auditSessionStart({
    serverName: config.serverName,
    version: SERVER_VERSION,
    mode: isReadonlyMode() ? "readonly" : "write",
    enabledDomains: enabled,
    rateLimitWritesPerMin: configuredWritesPerMin(),
    user: user ? user.uniqueName || user.displayName || "unknown" : "unknown",
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
