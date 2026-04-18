import {
  JsonPatchOperation,
  Operation,
} from "azure-devops-node-api/interfaces/common/VSSInterfaces.js";

export function normalizeFieldPath(field: string): string {
  return field.startsWith("/fields/") ? field : `/fields/${field}`;
}

export function buildUpdatePatchDocument(
  fields: Record<string, string>
): JsonPatchOperation[] {
  return Object.entries(fields).map(([field, value]) => ({
    op: Operation.Replace,
    path: normalizeFieldPath(field),
    value,
  }));
}
