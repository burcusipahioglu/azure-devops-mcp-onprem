import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  Build,
  BuildStatus,
} from "azure-devops-node-api/interfaces/BuildInterfaces.js";
import type { IConnectionProvider } from "../connection/provider.js";
import { withErrorHandling, jsonResponse } from "../utils/tool-response.js";
import { topParam } from "../utils/schemas.js";

const BUILD_STATUS_MAP: Record<string, BuildStatus> = {
  all: BuildStatus.All,
  inProgress: BuildStatus.InProgress,
  completed: BuildStatus.Completed,
  cancelling: BuildStatus.Cancelling,
  postponed: BuildStatus.Postponed,
  notStarted: BuildStatus.NotStarted,
  none: BuildStatus.None,
};

export function registerPipelineTools(server: McpServer, provider: IConnectionProvider): void {
  server.registerTool(
    "list_build_definitions",
    {
      description: "List build/pipeline definitions in the project",
      inputSchema: {
        name: z
          .string()
          .optional()
          .describe("Filter by definition name (contains match)"),
        top: topParam(25),
      },
    },
    ({ name, top }) =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getBuildContext();

        const definitions = await api.getDefinitions(
          project,
          name,
          undefined,
          undefined,
          undefined,
          top
        );

        const result = (definitions || []).map((def) => ({
          id: def.id,
          name: def.name,
          path: def.path,
          queueStatus: def.queueStatus,
          revision: def.revision,
          type: def.type,
          url: def.url,
        }));

        return jsonResponse(result);
      })
  );

  server.registerTool(
    "queue_build",
    {
      description: "Queue (trigger) a build pipeline. WARNING: This is a WRITE operation that starts a build. Show the user the definition ID, branch, and parameters before calling, and ask for confirmation.",
      inputSchema: {
        definitionId: z.number().describe("Build definition ID"),
        sourceBranch: z
          .string()
          .optional()
          .describe("Branch to build (e.g. refs/heads/main)"),
        parameters: z
          .record(z.string(), z.string())
          .optional()
          .describe("Build parameters as key-value pairs"),
      },
    },
    ({ definitionId, sourceBranch, parameters }) =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getBuildContext();

        const build: Partial<Build> = {
          definition: { id: definitionId },
        };

        if (sourceBranch) {
          build.sourceBranch = sourceBranch.startsWith("refs/")
            ? sourceBranch
            : `refs/heads/${sourceBranch}`;
        }

        if (parameters) {
          build.parameters = JSON.stringify(parameters);
        }

        const queuedBuild = await api.queueBuild(build as Build, project);

        return jsonResponse({
          id: queuedBuild.id,
          buildNumber: queuedBuild.buildNumber,
          status: queuedBuild.status,
          url: queuedBuild.url,
          sourceBranch: queuedBuild.sourceBranch,
          definition: queuedBuild.definition?.name,
          requestedBy: queuedBuild.requestedBy?.displayName,
        });
      })
  );

  server.registerTool(
    "get_build",
    {
      description: "Get the status and details of a specific build",
      inputSchema: {
        buildId: z.number().describe("Build ID"),
      },
    },
    ({ buildId }) =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getBuildContext();

        const build = await api.getBuild(project, buildId);

        return jsonResponse({
          id: build.id,
          buildNumber: build.buildNumber,
          status: build.status,
          result: build.result,
          sourceBranch: build.sourceBranch,
          sourceVersion: build.sourceVersion,
          definition: build.definition?.name,
          requestedBy: build.requestedBy?.displayName,
          startTime: build.startTime,
          finishTime: build.finishTime,
          url: build.url,
          logs: build.logs?.url,
        });
      })
  );

  server.registerTool(
    "list_builds",
    {
      description: "List recent builds with optional filters",
      inputSchema: {
        definitionId: z
          .number()
          .optional()
          .describe("Filter by build definition ID"),
        status: z
          .enum([
            "all",
            "inProgress",
            "completed",
            "cancelling",
            "postponed",
            "notStarted",
            "none",
          ])
          .optional()
          .describe("Build status filter"),
        top: topParam(10),
      },
    },
    ({ definitionId, status, top }) =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getBuildContext();


        const builds = await api.getBuilds(
          project,
          definitionId ? [definitionId] : undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          status ? BUILD_STATUS_MAP[status] : undefined,
          undefined,
          undefined,
          undefined,
          top
        );

        const result = (builds || []).map((build) => ({
          id: build.id,
          buildNumber: build.buildNumber,
          status: build.status,
          result: build.result,
          definition: build.definition?.name,
          sourceBranch: build.sourceBranch,
          requestedBy: build.requestedBy?.displayName,
          startTime: build.startTime,
          finishTime: build.finishTime,
        }));

        return jsonResponse(result);
      })
  );

  server.registerTool(
    "list_releases",
    {
      description: "List releases with optional filters",
      inputSchema: {
        definitionId: z
          .number()
          .optional()
          .describe("Filter by release definition ID"),
        top: topParam(25),
      },
    },
    ({ definitionId, top }) =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getReleaseContext();

        const releases = await api.getReleases(
          project,
          definitionId,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          top
        );

        const result = (releases || []).map((release) => ({
          id: release.id,
          name: release.name,
          status: release.status,
          createdOn: release.createdOn,
          createdBy: release.createdBy?.displayName,
          description: release.description,
          releaseDefinition: release.releaseDefinition?.name,
          environments: release.environments?.map((env) => ({
            name: env.name,
            status: env.status,
          })),
        }));

        return jsonResponse(result);
      })
  );
}
