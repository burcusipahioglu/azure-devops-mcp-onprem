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

// Like resolveMe, but returns the current user's GUID id instead of the display
// name. Use this where an API filters by an identity *id* (e.g. a Git PR
// search's reviewerId/creatorId) rather than a name. Non-@me values pass
// through unchanged — pass an already-resolved id there.
export async function resolveMeId(
  value: string | undefined,
  provider: IConnectionProvider
): Promise<string | undefined> {
  if (!value || value.trim().toLowerCase() !== ME_TOKEN) return value;
  const user = await provider.resolveCurrentUser();
  return user.id;
}
