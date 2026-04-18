import type { IConnectionProvider } from "../connection/provider.js";

const ME_TOKEN = "@me";

export async function resolveMe(
  value: string | undefined,
  provider: IConnectionProvider
): Promise<string | undefined> {
  if (!value || value.trim().toLowerCase() !== ME_TOKEN) return value;
  const user = await provider.resolveCurrentUser();
  return user.displayName;
}
