import type { ToolResult } from "./tool-response.js";

// Global sliding-window rate limit across all write tools. Sized to catch
// runaway LLM loops (the typical failure mode: auto-approve client gets
// stuck and fires create_work_item / queue_build / create_pull_request
// repeatedly) without interfering with realistic interactive use, where a
// human-paced LLM session rarely exceeds a handful of writes per minute.
//
// Granularity: all 8 write tools share one counter. A per-tool counter
// could be bypassed by an LLM that spreads its loop across tools; the
// global counter cannot. ADO server load is also a global resource.
//
// Read env lazily — same ESM/dotenv hoisting trap fixed in audit.ts.

const WINDOW_MS = 60_000;
const DEFAULT_LIMIT = 10;

function limit(): number {
  const raw = process.env.AZURE_DEVOPS_RATE_LIMIT_WRITES_PER_MIN;
  if (raw === undefined || raw === "") return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_LIMIT;
  return Math.floor(n);
}

// Configured limit, for the audit session header (0 = disabled).
export function configuredWritesPerMin(): number {
  return limit();
}

// In-memory ring of write timestamps. Process-local; resets on restart,
// which is acceptable — restarts are rare and a fresh process losing its
// rate-limit history is not a meaningful loss vs. the cost of persisting it.
const timestamps: number[] = [];

function prune(now: number): void {
  const cutoff = now - WINDOW_MS;
  while (timestamps.length > 0 && timestamps[0] < cutoff) {
    timestamps.shift();
  }
}

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; limit: number; retryAfterMs: number };

// Check-and-consume in one step. Caller invokes immediately before the
// write fires; if allowed, the timestamp is recorded.
export function tryConsume(): RateLimitDecision {
  const max = limit();
  if (max === 0) return { allowed: true };

  const now = Date.now();
  prune(now);

  if (timestamps.length >= max) {
    // Oldest timestamp leaves the window at oldest + WINDOW_MS; that's when
    // the next slot frees. Clamp at 1ms so a 0 doesn't suggest "ready now".
    const retryAfterMs = Math.max(1, timestamps[0] + WINDOW_MS - now);
    return { allowed: false, limit: max, retryAfterMs };
  }

  timestamps.push(now);
  return { allowed: true };
}

export function rateLimitBlockedResponse(
  tool: string,
  info: { limit: number; retryAfterMs: number }
): ToolResult {
  const seconds = Math.ceil(info.retryAfterMs / 1000);
  return {
    content: [
      {
        type: "text" as const,
        text:
          `Error: Write rate limit exceeded for '${tool}'. ` +
          `Limit is ${info.limit} writes per minute (across all write tools, ` +
          `configurable via AZURE_DEVOPS_RATE_LIMIT_WRITES_PER_MIN; set to 0 to disable). ` +
          `Retry in ~${seconds}s.`,
      },
    ],
    isError: true,
  };
}
