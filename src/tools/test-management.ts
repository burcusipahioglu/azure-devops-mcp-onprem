import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { IConnectionProvider } from "../connection/provider.js";
import { withErrorHandling, jsonResponse } from "../utils/tool-response.js";
import { withAudit } from "../utils/audit.js";
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
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
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
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
      inputSchema: {
        planId: z.number().describe("Test plan ID"),
      },
    },
    ({ planId }) =>
      withErrorHandling(async () => {
        const { api, project } = await provider.getTestPlanContext();

        const plan = await api.getTestPlanById(project, planId);

        return jsonResponse({
          id: plan.id,
          name: plan.name,
          state: plan.state,
          areaPath: plan.areaPath,
          iteration: plan.iteration,
          startDate: plan.startDate,
          endDate: plan.endDate,
          owner: plan.owner?.displayName,
          rootSuite: plan.rootSuite
            ? { id: plan.rootSuite.id, name: plan.rootSuite.name }
            : undefined,
          description: plan.description,
          buildDefinition: plan.buildDefinition
            ? { id: plan.buildDefinition.id, name: plan.buildDefinition.name }
            : undefined,
          revision: plan.revision,
        });
      })
  );

  server.registerTool(
    "list_test_suites",
    {
      description: "List test suites within a test plan. Suites group related test cases together.",
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
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
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
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
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
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
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
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

  server.registerTool(
    "add_test_cases_to_suite",
    {
      description:
        "Add existing Test Case work items to a test suite. A Test Case is a work item (create it with create_work_item, type 'Test Case'); this tool links those work items into a suite so they appear in the plan. WARNING: This is a WRITE operation. Confirm the plan, suite, and test case IDs with the user before calling.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      inputSchema: {
        planId: z.number().describe("Test plan ID the suite belongs to"),
        suiteId: z.number().describe("Test suite ID to add the test cases to"),
        testCaseIds: z
          .array(z.number())
          .min(1)
          .describe("Work item IDs of the Test Cases to add"),
        configurationIds: z
          .array(z.number())
          .optional()
          .describe("Optional test configuration IDs to assign to each added test case"),
      },
    },
    (input) =>
      withAudit(provider, "add_test_cases_to_suite", input, () =>
        withErrorHandling(async () => {
          const { planId, suiteId, testCaseIds, configurationIds } = input;
          const { api, project } = await provider.getTestPlanContext();

          const pointAssignments = configurationIds?.map((configurationId) => ({
            configurationId,
          }));

          const params = testCaseIds.map((id) => ({
            workItem: { id },
            ...(pointAssignments ? { pointAssignments } : {}),
          }));

          const added = await api.addTestCasesToSuite(params, project, planId, suiteId);

          return jsonResponse({
            action: "ADDED",
            planId,
            suiteId,
            requested: testCaseIds.length,
            added: (added || []).map((tc) => ({
              testCaseId: tc.workItem?.id,
              title: tc.workItem?.name,
              order: tc.order,
            })),
          });
        })
      )
  );
}
