import type { IWorkItemTrackingApi } from "azure-devops-node-api/WorkItemTrackingApi.js";
import { WORK_ITEM_BATCH_SIZE } from "../constants.js";

export function extractDisplayValue(val: unknown): unknown {
  if (
    typeof val === "object" &&
    val !== null &&
    "displayName" in (val as Record<string, unknown>)
  ) {
    return (val as { displayName: string }).displayName;
  }
  return val;
}

export async function batchGetWorkItems(
  api: IWorkItemTrackingApi,
  ids: number[],
  fields: string[],
  project: string,
  batchSize = WORK_ITEM_BATCH_SIZE
): Promise<{ id?: number; fields?: Record<string, unknown> }[]> {
  const allItems: { id?: number; fields?: Record<string, unknown> }[] = [];
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const items = await api.getWorkItems(
      batch,
      fields,
      undefined,
      undefined,
      undefined,
      project
    );
    if (items) allItems.push(...items);
  }
  return allItems;
}
