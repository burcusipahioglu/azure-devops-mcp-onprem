import { z } from "zod";

export const topParam = (defaultVal = 25) =>
  z
    .number()
    .min(1)
    .max(1000)
    .optional()
    .default(defaultVal)
    .describe("Maximum number of results (1-1000)");

export const skipParam = (defaultVal = 0) =>
  z
    .number()
    .min(0)
    .optional()
    .default(defaultVal)
    .describe("Number of results to skip (for pagination)");

export const dryRunParam = z
  .boolean()
  .optional()
  .describe(
    "If true, validate inputs and return the would-be effect WITHOUT calling the Azure DevOps API. Use this to preview the change before committing. The response uses action='WOULD_*' and has the same shape as a real call."
  );
