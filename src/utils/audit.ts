import { appendFileSync } from "node:fs";
import type { IConnectionProvider } from "../connection/provider.js";
import type { ToolResult } from "./tool-response.js";
import { isReadonlyMode, readonlyBlockedResponse } from "./write-mode.js";
import { tryConsume, rateLimitBlockedResponse } from "./rate-limit.js";

// Read env vars lazily on each call — module top-level code runs BEFORE
// index.ts's dotenv `loadEnv()` (ESM hoists imports), so capturing them at
// load time would miss any value set via .env file.
function auditPath(): string | undefined {
  return process.env.AZURE_DEVOPS_AUDIT_LOG;
}
function isRedactMode(): boolean {
  return Boolean(process.env.AZURE_DEVOPS_AUDIT_REDACT);
}

// Pull the structured payload out of a ToolResult so audit records aren't
// just a stringified blob. Falls back to the raw text on parse failure.
function summarizeResult(r: ToolResult): unknown {
  const text = r.content?.[0]?.text;
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// In redact mode, strip all string content but keep numeric IDs, booleans,
// and the *shape* (top-level keys + nested object keys) so the audit still
// answers "who touched what fields when" without leaking values. Specific
// string keys (e.g. "action" labels set by our own code, not user content)
// can be allow-listed via keepStringKeys.
function redactPayload(
  p: unknown,
  opts?: { keepStringKeys?: readonly string[] }
): unknown {
  if (!p || typeof p !== "object" || Array.isArray(p)) return undefined;
  const keep = new Set(opts?.keepStringKeys ?? []);
  const obj = p as Record<string, unknown>;
  const out: Record<string, unknown> = { keys: Object.keys(obj) };
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    } else if (Array.isArray(v) && v.every((x) => typeof x === "number")) {
      out[k] = v;
    } else if (typeof v === "string" && keep.has(k)) {
      out[k] = v;
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      out[`${k}_keys`] = Object.keys(v as Record<string, unknown>);
    }
    // Strings (other than allow-listed), string arrays, and other shapes
    // are intentionally dropped.
  }
  return out;
}

function writeAuditRecord(path: string, record: unknown): void {
  // Best-effort: never let an audit-write failure surface as a tool error.
  try {
    appendFileSync(path, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // swallow
  }
}

// One self-describing header per process, so a log file (or a stretch of a
// shared one) can be interpreted without the producing server's env at hand:
// which version/mode/domains generated the records that follow, and whether
// they are redacted. Contains config and identity only — no user content —
// so redact mode just flags itself rather than stripping fields.
export function auditSessionStart(info: {
  serverName: string;
  version: string;
  mode: "readonly" | "write";
  enabledDomains: string[];
  rateLimitWritesPerMin: number;
  user: string;
}): void {
  const path = auditPath();
  if (!path) return;
  writeAuditRecord(path, {
    event: "session_start",
    ts: new Date().toISOString(),
    redactMode: isRedactMode(),
    ...info,
  });
}

async function resolveUser(provider: IConnectionProvider): Promise<string> {
  try {
    const u = await provider.resolveCurrentUser();
    return u.uniqueName || u.displayName || "unknown";
  } catch {
    // resolveCurrentUser can fail before the connection warms up; the audit
    // record is still useful without it.
    return "unknown";
  }
}

// Wraps a write tool's work. Two responsibilities:
//   1. Enforce server-level write mode — if AZURE_DEVOPS_MODE=readonly, refuse
//      to invoke workFn() and return an isError ToolResult. Blocked attempts
//      are still recorded in the audit log when AZURE_DEVOPS_AUDIT_LOG is set
//      (forensically valuable: shows who tried to write while server was
//      locked down).
//   2. Append a JSONL audit record after the work completes (success or
//      failure), honoring redact mode for environments with strict data
//      classification.
//
// Takes a function (not an already-started Promise) so readonly mode can
// short-circuit before any API call fires.
export async function withAudit(
  provider: IConnectionProvider,
  tool: string,
  input: Record<string, unknown>,
  workFn: () => Promise<ToolResult>
): Promise<ToolResult> {
  const path = auditPath();
  const redactMode = isRedactMode();

  if (isReadonlyMode()) {
    const blocked = readonlyBlockedResponse(tool);
    if (path) {
      const user = await resolveUser(provider);
      const base = {
        ts: new Date().toISOString(),
        tool,
        user,
        dryRun: Boolean(input.dryRun),
        ok: false,
        blocked: "readonly_mode",
        durationMs: 0,
      };
      const record = redactMode
        ? { ...base, redacted: true, input: redactPayload(input) }
        : { ...base, input };
      writeAuditRecord(path, record);
    }
    return blocked;
  }

  const rl = tryConsume();
  if (!rl.allowed) {
    const blocked = rateLimitBlockedResponse(tool, rl);
    if (path) {
      const user = await resolveUser(provider);
      const base = {
        ts: new Date().toISOString(),
        tool,
        user,
        dryRun: Boolean(input.dryRun),
        ok: false,
        blocked: "rate_limit",
        limit: rl.limit,
        retryAfterMs: rl.retryAfterMs,
        durationMs: 0,
      };
      const record = redactMode
        ? { ...base, redacted: true, input: redactPayload(input) }
        : { ...base, input };
      writeAuditRecord(path, record);
    }
    return blocked;
  }

  if (!path) return workFn();

  const start = Date.now();
  const result = await workFn();
  const ok = !result.isError;
  const summary = summarizeResult(result);
  const user = await resolveUser(provider);

  const base = {
    ts: new Date().toISOString(),
    tool,
    user,
    dryRun: Boolean(input.dryRun),
    ok,
    durationMs: Date.now() - start,
  };

  const record = redactMode
    ? {
        ...base,
        redacted: true,
        input: redactPayload(input),
        // "action" is a literal label set by our own response builders
        // ("UPDATED", "CREATED", "WOULD_*") — forensically valuable, not PII.
        result: ok ? redactPayload(summary, { keepStringKeys: ["action"] }) : undefined,
        // Error strings can echo input content; in redact mode keep only the boolean.
      }
    : {
        ...base,
        input,
        result: ok ? summary : undefined,
        error: ok ? undefined : (typeof summary === "string" ? summary : JSON.stringify(summary)),
      };

  writeAuditRecord(path, record);
  return result;
}
