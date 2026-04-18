import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { IConnectionProvider } from "../connection/provider.js";
import { withErrorHandling, jsonResponse } from "../utils/tool-response.js";
import { topParam, skipParam } from "../utils/schemas.js";
import { STACK_TRACE_TRUNCATION_LIMIT } from "../constants.js";

const TEST_OUTCOME_MAP: Record<string, number> = {
  Unspecified: 0,
  None: 1,
  Passed: 2,
  Failed: 3,
  Inconclusive: 4,
  Timeout: 5,
  Aborted: 6,
  Blocked: 7,
  NotExecuted: 8,
  Warning: 9,
  Error: 10,
  NotApplicable: 11,
  Paused: 12,
  InProgress: 13,
  NotImpacted: 14,
};

export function registerTestManagementTools(server: McpServer, provider: IConnectionProvider): void {
  server.registerTool(
    "list_test_plans",
    {
      description: "List test plans in the project. Test plans organize test suites and test cases for quality assurance.",
      inputSchema: {
        filterActivePlans: z
          .boolean()
          .optional()
          .default(true)
          .describe("Only show active plans (default true)"),
        includePlanDetails: z
          .boolean()
          .optional()
          .default(true)
          .describe("Include plan details (root suite, iteration)"),
      },
    },
    ({ filterActivePlans, includePlanDetails }) =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getTestPlanContext();

        const plans = await api.getTestPlans(
          project,
          undefined,
          undefined,
          includePlanDetails,
          filterActivePlans
        );

        const result = (plans || []).map((plan) => ({
          id: plan.id,
          name: plan.name,
          state: plan.state,
          iteration: plan.iteration,
          areaPath: plan.areaPath,
          startDate: plan.startDate,
          endDate: plan.endDate,
          owner: plan.owner?.displayName,
          revision: plan.revision,
        }));

        return jsonResponse(result);
      })
  );

  server.registerTool(
    "get_test_plan",
    {
      description: "Get detailed information about a specific test plan",
      inputSchema: {
        planId: z.number().describe("Test plan ID"),
      },
    },
    ({ planId }) =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getTestPlanContext();

        const plan = await api.getTestPlanById(project, planId);

        return jsonResponse(plan);
      })
  );

  server.registerTool(
    "list_test_suites",
    {
      description: "List test suites within a test plan. Suites group related test cases together.",
      inputSchema: {
        planId: z.number().describe("Test plan ID"),
        asTreeView: z
          .boolean()
          .optional()
          .default(false)
          .describe("Return suites as a tree hierarchy"),
      },
    },
    ({ planId, asTreeView }) =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getTestPlanContext();

        const suites = await api.getTestSuitesForPlan(
          project,
          planId,
          undefined,
          undefined,
          asTreeView
        );

        const result = (suites || []).map((suite) => ({
          id: suite.id,
          name: suite.name,
          suiteType: suite.suiteType,
          parentSuite: suite.parentSuite ? { id: suite.parentSuite.id, name: suite.parentSuite.name } : undefined,
          hasChildren: suite.hasChildren,
          revision: suite.revision,
        }));

        return jsonResponse(result);
      })
  );

  server.registerTool(
    "list_test_cases",
    {
      description: "List test cases within a test suite. Returns test case IDs, titles, configurations, and point assignments.",
      inputSchema: {
        planId: z.number().describe("Test plan ID"),
        suiteId: z.number().describe("Test suite ID"),
      },
    },
    ({ planId, suiteId }) =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getTestPlanContext();

        const testCases = await api.getTestCaseList(
          project,
          planId,
          suiteId
        );

        const result = (testCases || []).map((tc) => ({
          testCaseId: tc.workItem?.id,
          title: tc.workItem?.name,
          pointAssignments: tc.pointAssignments?.map((pa) => ({
            configurationId: pa.configurationId,
            configurationName: pa.configurationName,
            tester: pa.tester?.displayName,
          })),
        }));

        return jsonResponse(result);
      })
  );

  server.registerTool(
    "list_test_runs",
    {
      description: "List test runs in the project. Test runs represent executions of test plans/suites and contain test results.",
      inputSchema: {
        planId: z
          .number()
          .optional()
          .describe("Filter by test plan ID"),
        automated: z
          .boolean()
          .optional()
          .describe("Filter: true = automated runs, false = manual runs, omit = all"),
        includeRunDetails: z
          .boolean()
          .optional()
          .default(true)
          .describe("Include run details"),
        top: topParam(25),
        skip: skipParam(),
      },
    },
    ({ planId, automated, includeRunDetails, top, skip }) =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getTestContext();

        const runs = await api.getTestRuns(
          project,
          undefined,
          undefined,
          undefined,
          planId,
          includeRunDetails,
          automated,
          skip,
          top
        );

        const result = (runs || []).map((run) => ({
          id: run.id,
          name: run.name,
          state: run.state,
          isAutomated: run.isAutomated,
          totalTests: run.totalTests,
          passedTests: run.passedTests,
          unanalyzedTests: run.unanalyzedTests,
          incompleteTests: run.incompleteTests,
          notApplicableTests: run.notApplicableTests,
          startedDate: run.startedDate,
          completedDate: run.completedDate,
          createdDate: run.createdDate,
          owner: run.owner?.displayName,
          plan: run.plan ? { id: run.plan.id, name: run.plan.name } : undefined,
          build: run.build ? { id: run.build.id, name: run.build.name } : undefined,
          comment: run.comment,
          url: run.url,
        }));

        return jsonResponse(result);
      })
  );

  server.registerTool(
    "get_test_results",
    {
      description: "Get test results for a specific test run. Shows pass/fail status for each test case, with error messages and durations.",
      inputSchema: {
        runId: z.number().describe("Test run ID"),
        outcomes: z
          .array(z.enum(["Passed", "Failed", "Inconclusive", "Timeout", "Aborted", "Blocked", "NotExecuted", "Warning", "Error", "NotApplicable", "Paused", "InProgress", "NotImpacted"]))
          .optional()
          .describe("Filter by outcomes, e.g. ['Failed', 'Error']. Leave empty for all outcomes."),
        top: topParam(100),
        skip: skipParam(),
      },
    },
    ({ runId, outcomes, top, skip }) =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getTestContext();

        const outcomeFilter = outcomes
          ? outcomes.map((o) => TEST_OUTCOME_MAP[o]).filter((v) => v !== undefined)
          : undefined;

        const results = await api.getTestResults(
          project,
          runId,
          undefined,
          skip,
          top,
          outcomeFilter
        );

        const mapped = (results || []).map((r) => ({
          id: r.id,
          testCaseTitle: r.testCaseTitle,
          testCaseId: r.testCase?.id,
          outcome: r.outcome,
          state: r.state,
          durationInMs: r.durationInMs,
          errorMessage: r.errorMessage,
          stackTrace: r.stackTrace
            ? r.stackTrace.length > STACK_TRACE_TRUNCATION_LIMIT
              ? r.stackTrace.substring(0, STACK_TRACE_TRUNCATION_LIMIT) + "\n... [truncated]"
              : r.stackTrace
            : undefined,
          runBy: r.runBy?.displayName,
          completedDate: r.completedDate,
          configuration: r.configuration ? { id: r.configuration.id, name: r.configuration.name } : undefined,
          comment: r.comment,
        }));

        return jsonResponse(mapped);
      })
  );
}
