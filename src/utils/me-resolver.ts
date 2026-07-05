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

// Resolve reviewer inputs (display names, sign-in emails/UPNs, '@me', or raw
// GUIDs) to identity GUIDs the PR create API accepts. Fails loud on any input
// that can't be resolved rather than silently dropping a reviewer.
export async function resolveReviewerIds(
  reviewers: string[],
  provider: IConnectionProvider
): Promise<string[]> {
  const resolved = await Promise.all(
    reviewers.map(async (input) => {
      // '@me' → current-user identity via resolveMeId, which yields the GUID
      // directly. It returns "" when the collection's authenticated user has no
      // id — there is nothing to look up then, so treat it as unresolved rather
      // than firing an empty-filter identity search that matches nobody.
      const meResolved = await resolveMeId(input, provider);
      if (!meResolved || !meResolved.trim()) {
        return { input, id: undefined };
      }
      return { input, id: await provider.resolveIdentityId(meResolved) };
    })
  );

  const unresolved = resolved.filter((r) => !r.id).map((r) => r.input);
  if (unresolved.length > 0) {
    throw new Error(
      `Could not resolve reviewer(s) to an Azure DevOps identity: ${unresolved.join(", ")}. ` +
        `Pass a display name, sign-in email/UPN, '@me', or identity GUID that exists in this collection.`
    );
  }

  return resolved.map((r) => r.id as string);
}
