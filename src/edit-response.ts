/**
 * Edit response builders.
 *
 * Unified diff output: agent and user see the same content. The diff is
 * generated from structuredPatch hunks with hashline-formatted lines.
 */

import { generateDiffString } from "./edit-diff";
import { PACKAGE_INFO } from "./package-info";

// ─── Public types ───────────────────────────────────────────────────────

export type EditMetrics = {
  edits_attempted: number;
  edits_noop: number;
  warnings: number;
  classification: "applied" | "noop";
  added_lines?: number;
  removed_lines?: number;
};

// ─── Builder inputs ─────────────────────────────────────────────────────

type NoopEditEntry = {
  editIndex: number;
  loc: string;
  currentContent: string;
};

export interface NoopResponseInput {
  path: string;
  noopEdits: NoopEditEntry[] | undefined;
  originalNormalized: string;
  snapshotId: string;
  editsAttempted: number;
  warnings: string[] | undefined;
}

export interface SuccessResponseInput {
  path: string;
  originalNormalized: string;
  result: string;
  warnings: string[] | undefined;
  snapshotId: string;
  editsAttempted: number;
  noopEditsCount: number;
  postEditAnchors?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function countDiffLines(diff: string, marker: "+" | "-"): number {
  if (!diff) return 0;
  let count = 0;
  for (const line of diff.split("\n")) {
    if (
      line.startsWith(marker) &&
      !line.startsWith(`${marker}${marker}${marker}`)
    ) {
      count += 1;
    }
  }
  return count;
}

function buildMetrics(args: {
  classification: "applied" | "noop";
  editsAttempted: number;
  noopEditsCount: number;
  warningsCount: number;
  addedLines?: number;
  removedLines?: number;
}): EditMetrics {
  const metrics: EditMetrics = {
    edits_attempted: args.editsAttempted,
    edits_noop: args.noopEditsCount,
    warnings: args.warningsCount,
    classification: args.classification,
  };
  if (args.addedLines !== undefined) metrics.added_lines = args.addedLines;
  if (args.removedLines !== undefined)
    metrics.removed_lines = args.removedLines;
  return metrics;
}

function warningsBlockOf(warnings: string[] | undefined): string {
  if (!warnings?.length) return "";
  // Defense in depth: even though the source dedups warnings, a future
  // code path could reintroduce duplicates. Collapse exact-string
  // duplicates into a single line with a (×N) suffix so the
  // user-facing output is always clean.
  // Singletons are NOT annotated with (×1) — only counts > 1 get a
  // suffix, to avoid visual noise.
  const counts = new Map<string, number>();
  for (const w of warnings) {
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  const rendered: string[] = [];
  for (const [w, n] of counts) {
    rendered.push(n > 1 ? `${w} (×${n})` : w);
  }
  return `\n\nWarnings:\n${rendered.join("\n")}`;
}

/** Extract the 1-based line number from a location string like "42#Xy0".
 *  Used in user-facing noop details to keep the model oriented. The
 *  hash portion is intentionally dropped from the user-facing text. */
function lineNumberFromLoc(loc: string): number {
  const match = loc.match(/^(\d+)/);
  if (!match) return 0;
  const n = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(n) ? n : 0;
}

// ─── Builders ───────────────────────────────────────────────────────────

export function buildNoopResponse(input: NoopResponseInput): ToolResult {
  const { path, noopEdits, snapshotId, editsAttempted, warnings } = input;

  // The user-facing text intentionally avoids leaking internal terminology
  // (no "Classification: noop", no "replacement for N#XXX", no "identical
  // to current content"). The model only needs to know the file was not
  // changed and which line (if any) was the source of the no-op. The
  // internal `classification: "noop"` lives in `details.metrics` for
  // tooling, not in the user-visible text.

  // There are two distinct reasons we can end up here with
  // `noopEdits.length === 0`:
  //   1. The batch was REFUSED (e.g. E_EDIT_CONFLICT, E_LINE_CHANGED).
  //      In that case, `noopEdits` is intentionally empty (the dry-run
  //      refused the batch; no individual edits "matched" the file).
  //      The model needs to know WHY — there is a [E_EDIT_REFUSED]
  //      warning that explains it.
  //   2. The edits APPLIED, but the new content matched the existing
  //      content on disk (rare edge case: the model wrote exactly
  //      what was already there).
  const wasRefused = warnings?.some((w) => w.startsWith("[E_EDIT_REFUSED]"));
  const noopDetailsText = noopEdits?.length
    ? noopEdits
        .map(
          (edit) =>
            `Edit ${edit.editIndex} (line ${lineNumberFromLoc(edit.loc)}): the new content matches the existing content, so nothing was changed.\n  ${edit.currentContent}`,
        )
        .join("\n")
    : wasRefused
      ? "The edit batch was refused; see warnings above for the reason."
      : "Nothing to change: the new content matches the existing content.";

  const warningsBlock = warningsBlockOf(warnings);
  const text = `No changes made to ${path}\n${noopDetailsText}${warningsBlock}`;

  const metrics = buildMetrics({
    classification: "noop",
    editsAttempted,
    noopEditsCount: noopEdits?.length ?? 0,
    warningsCount: warnings?.length ?? 0,
  });

  return {
    content: [{ type: "text", text }],
    details: {
      diff: "",
      snapshotId,
      classification: "noop" as const,
      metrics,
      package: PACKAGE_INFO,
    },
  };
}

export function buildChangedResponse(input: SuccessResponseInput): ToolResult {
  const {
    result,
    warnings,
    snapshotId,
    originalNormalized,
    editsAttempted,
    noopEditsCount,
    postEditAnchors,
  } = input;

  const diffResult = generateDiffString(originalNormalized, result);
  const addedLines = countDiffLines(diffResult.diff, "+");
  const removedLines = countDiffLines(diffResult.diff, "-");
  const warningsBlock = warningsBlockOf(warnings);

  const sections = [diffResult.diff, warningsBlock.trimStart()].filter(
    (section) => section.length > 0,
  );
  if (postEditAnchors) {
    sections.push(postEditAnchors);
  }
  const text = sections.join("\n\n");

  const metrics = buildMetrics({
    classification: "applied",
    editsAttempted,
    noopEditsCount,
    warningsCount: warnings?.length ?? 0,
    addedLines,
    removedLines,
  });

  return {
    content: [{ type: "text", text }],
    details: {
      diff: diffResult.diff,
      snapshotId,
      metrics,
      package: PACKAGE_INFO,
    },
  };
}

// Local shape — pi-coding-agent does not export a public `ToolResult`. The
// builders return `details` as `any` so callers can keep their own per-tool
// details type without re-asserting it here. This file intentionally does
// not import the agent's tool-result type to stay decoupled from internals.
type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details: any;
};
