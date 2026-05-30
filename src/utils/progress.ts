import type { ServerNotification } from "@modelcontextprotocol/sdk/types.js";

// Reports incremental progress for a long-running tool back to the MCP client.
//
// Progress is opt-in per the spec: the client only receives updates if it
// attached a `progressToken` to the request's `_meta`. When it didn't (or no
// `extra` is available), this returns a no-op so call sites stay unconditional.
//
// Best-effort by design — a failed notification is swallowed. A dropped
// progress update must never turn into a tool error.
export type ProgressReporter = (
  progress: number,
  total?: number,
  message?: string
) => Promise<void>;

// Minimal shape we need from the tool callback's `extra` argument. Kept
// structural so we don't couple to the SDK's RequestHandlerExtra generics.
interface ProgressCapableExtra {
  _meta?: { progressToken?: string | number };
  sendNotification: (notification: ServerNotification) => Promise<void>;
}

const NOOP: ProgressReporter = async () => {};

export function makeProgressReporter(
  extra: ProgressCapableExtra | undefined
): ProgressReporter {
  const token = extra?._meta?.progressToken;
  if (!extra || token === undefined) return NOOP;

  return async (progress, total, message) => {
    try {
      await extra.sendNotification({
        method: "notifications/progress",
        params: {
          progressToken: token,
          progress,
          ...(total !== undefined ? { total } : {}),
          ...(message ? { message } : {}),
        },
      });
    } catch {
      // best-effort: never let progress reporting break the tool
    }
  };
}
