export function sanitizeWiqlValue(value: string): string {
  return value.replace(/'/g, "''");
}
