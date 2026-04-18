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
