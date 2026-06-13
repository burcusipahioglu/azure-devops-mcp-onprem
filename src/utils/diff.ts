import { DIFF_MAX_LINES } from "../constants.js";

// Self-contained unified diff over lines. Deliberately no external dependency
// (keeps the small runtime-dep surface) — an LCS dynamic program is simple and
// correct for the bounded inputs this tool diffs. The O(n*m) table lives in a
// flat Int32Array; a side past DIFF_MAX_LINES is refused (tooLarge) rather than
// risking a memory blowup, so the caller falls back to get_file_content instead
// of getting a wrong or oversized answer. Honesty over completeness.

export interface UnifiedDiff {
  diff: string; // unified-diff hunks ("@@ ... @@" blocks); "" when identical
  added: number; // inserted line count
  removed: number; // deleted line count
  identical: boolean; // the two sides are equal
  tooLarge: boolean; // a side exceeded DIFF_MAX_LINES — no diff computed
}

type OpType = "eq" | "del" | "ins";

interface Entry {
  type: OpType;
  text: string;
  oldNo: number | null; // 1-based line number in the old file (null for ins)
  newNo: number | null; // 1-based line number in the new file (null for del)
}

// Split into lines, normalizing CRLF→LF first so a line-ending-only change does
// not render as every line differing, and dropping the spurious empty element a
// trailing newline would otherwise produce.
function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function diffOps(a: string[], b: string[]): { type: OpType; text: string }[] {
  const m = a.length;
  const n = b.length;
  const w = n + 1;
  // dp[i*w + j] = LCS length of a[i:] and b[j:]
  const dp = new Int32Array((m + 1) * w);
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j]
          ? dp[(i + 1) * w + (j + 1)] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)]);
    }
  }
  const ops: { type: OpType; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ type: "eq", text: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) {
      ops.push({ type: "del", text: a[i] });
      i++;
    } else {
      ops.push({ type: "ins", text: b[j] });
      j++;
    }
  }
  while (i < m) ops.push({ type: "del", text: a[i++] });
  while (j < n) ops.push({ type: "ins", text: b[j++] });
  return ops;
}

// Best-effort section hint for a hunk header (like git's "@@ ... @@ funcName"):
// the nearest preceding unchanged line that starts in column 0 with an
// identifier character — a heuristic for the enclosing definition, not a
// guarantee. Language-agnostic; misses indented members by design.
function sectionHint(entries: Entry[], hunkStart: number): string {
  for (let k = hunkStart - 1; k >= 0; k--) {
    const e = entries[k];
    if (e.type !== "eq") continue;
    if (/^[A-Za-z_$]/.test(e.text)) return e.text.trim().slice(0, 80);
  }
  return "";
}

export function computeUnifiedDiff(
  oldText: string,
  newText: string,
  contextLines = 3
): UnifiedDiff {
  if (oldText === newText) {
    return { diff: "", added: 0, removed: 0, identical: true, tooLarge: false };
  }

  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  if (oldLines.length > DIFF_MAX_LINES || newLines.length > DIFF_MAX_LINES) {
    return { diff: "", added: 0, removed: 0, identical: false, tooLarge: true };
  }

  const ctx = Math.max(0, contextLines);
  const ops = diffOps(oldLines, newLines);

  // Number every op against both files and tally the change counts.
  const entries: Entry[] = [];
  let oldNo = 1;
  let newNo = 1;
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === "eq") {
      entries.push({ type: "eq", text: op.text, oldNo: oldNo++, newNo: newNo++ });
    } else if (op.type === "del") {
      entries.push({ type: "del", text: op.text, oldNo: oldNo++, newNo: null });
      removed++;
    } else {
      entries.push({ type: "ins", text: op.text, oldNo: null, newNo: newNo++ });
      added++;
    }
  }

  // Group changed entries into hunks, padding each with up to `ctx` unchanged
  // lines and merging hunks whose context windows touch.
  const hunks: { start: number; end: number }[] = [];
  for (let k = 0; k < entries.length; k++) {
    if (entries[k].type === "eq") continue;
    const lo = Math.max(0, k - ctx);
    const hi = Math.min(entries.length - 1, k + ctx);
    const last = hunks[hunks.length - 1];
    if (last && lo <= last.end + 1) {
      last.end = Math.max(last.end, hi);
    } else {
      hunks.push({ start: lo, end: hi });
    }
  }

  const out: string[] = [];
  for (const h of hunks) {
    const slice = entries.slice(h.start, h.end + 1);
    const oldNos = slice.filter((e) => e.oldNo !== null).map((e) => e.oldNo as number);
    const newNos = slice.filter((e) => e.newNo !== null).map((e) => e.newNo as number);
    const oldStart = oldNos.length ? oldNos[0] : 0;
    const newStart = newNos.length ? newNos[0] : 0;
    const hint = sectionHint(entries, h.start);
    out.push(
      `@@ -${oldStart},${oldNos.length} +${newStart},${newNos.length} @@${
        hint ? " " + hint : ""
      }`
    );
    for (const e of slice) {
      const prefix = e.type === "eq" ? " " : e.type === "del" ? "-" : "+";
      out.push(prefix + e.text);
    }
  }

  return { diff: out.join("\n"), added, removed, identical: false, tooLarge: false };
}
