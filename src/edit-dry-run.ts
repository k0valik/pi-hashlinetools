/**
 * Dry-run wrapper for hashline edit application.
 *
 * Runs the full anchor resolution + apply pipeline in-memory without
 * touching the disk. Returns a `DryRunResult` with per-edit evidence
 * (succeeded, failed, ambiguous) and the would-apply content. The
 * caller decides whether to commit the result based on the per-edit
 * outcomes.
 *
 * Replaces the old "try anchor + apply, catch E_*, re-read file, retry"
 * loop. The new flow:
 *   1. tryDryRun → see what would happen
 *   2. Commit the wouldApply content in one atomic write (or refuse the
 *      whole batch with per-edit evidence)
 */
import type { Buffer } from "node:buffer";
import {
  anchorBareLineNumberEdits,
  type EditBehaviorOptions,
} from "./edit-anchor";
import type { AnchorMedleyResult } from "./edit-strategies";
import {
  applyHashlineEdits,
  type HashlineToolEdit,
  resolveEditAnchors,
} from "./hashline";

export type DryRunEditEvidence = AnchorMedleyResult & {
  editIndex: number;
};

export type DryRunResult = {
  /** The new file content if the edits were applied. */
  wouldApply: string;
  /** Per-edit evidence. Order matches the input edits array. */
  perEdit: DryRunEditEvidence[];
  /** Conflicts between edits (e.g., overlapping spans). */
  conflicts: Array<{ editA: number; editB: number; reason: string }>;
  /** True if the result is identical to the input (no-op). */
  wouldBeNoop: boolean;
  /** First changed line in final-document coordinates. */
  firstChangedLine: number | undefined;
  /** Last changed line in final-document coordinates. */
  lastChangedLine: number | undefined;
  /** Aggregated warnings from anchor resolution (e.g., W_STALE_CONTEXT). */
  warnings: string[];
  /** Edits where the replacement equals the current content. */
  noopEdits: Array<{
    editIndex: number;
    loc: string;
    currentContent: string;
  }>;
};

export type TryDryRunArgs = {
  fileContent: string;
  fileLines: string[];
  visibleLineCount: number;
  edits: HashlineToolEdit[];
  rawBuffer: Buffer;
  options?: EditBehaviorOptions;
};

/** Run a dry-run of the edit pipeline in-memory. */
export function tryDryRun(args: TryDryRunArgs): DryRunResult {
  const { fileContent, fileLines, visibleLineCount, edits, rawBuffer } = args;
  const behaviorOptions = args.options ?? {};

  if (edits.length === 0) {
    return {
      wouldApply: fileContent,
      perEdit: [],
      conflicts: [],
      wouldBeNoop: true,
      firstChangedLine: undefined,
      lastChangedLine: undefined,
      warnings: [],
      noopEdits: [],
    };
  }

  // Step 1: anchor resolution (uses the medley internally).
  // Wrapped in try-catch because anchorBareLineNumberEdits throws
  // E_RANGE_OOB / E_LINE_CONTENT_MISMATCH / E_ASYMMETRIC_SHIFT /
  // E_STALE_ANCHOR on any anchoring failure. We want to capture those
  // as per-edit failures in DryRunResult, not propagate them.
  //
  // If anchoring fails, return a synthetic "all edits failed" result
  // immediately. Do NOT synthesize fake `pos: ""` edits and pass them
  // through `resolveEditAnchors` — that path then re-parses "" as a
  // line ref, throws E_BAD_REF with empty string, and the apply
  // try-catch (below) captures that as a secondary warning, producing
  // noisy output like:
  //   [E_LINE_CONTENT_MISMATCH] range start 5#Xy0 ...
  //   [E_BAD_REF] Invalid line reference "". Expected "LINE#HASH"...
  //   [E_EDIT_REFUSED] The edit batch was refused: ...
  //
  // hypothesis in §6.2 was a red herring — the real source was the
  // synthetic empty `pos` we pass into `parseAnchorRef`.)
  let anchorResult: {
    edits: import("./hashline").HashlineToolEdit[];
    warnings: string[];
  };
  try {
    anchorResult = anchorBareLineNumberEdits(
      edits,
      fileContent,
      behaviorOptions,
      [],
      rawBuffer,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Surface the error as a per-edit failure (orchestrator refuses the
    // batch via the conflicts[] check + perEdit outcomes). No need to
    // continue with a synthetic anchorResult.
    return {
      wouldApply: fileContent,
      perEdit: edits.map((_, index) => ({
        editIndex: index,
        candidate: null,
        outcome: "failed",
        relocationDelta: 0,
        strategies: [],
      })),
      // Use a single conflict entry pointing at the anchor error. The
      // reason text is the original error message (e.g.
      // "[E_LINE_CONTENT_MISMATCH] ...") which the orchestrator passes
      // through to the user without re-parsing it.
      conflicts: [{ editA: 0, editB: 0, reason: msg }],
      wouldBeNoop: true,
      firstChangedLine: undefined,
      lastChangedLine: undefined,
      warnings: [msg],
      noopEdits: [],
    };
  }

  // Build per-edit evidence from the anchor resolution
  const perEdit: DryRunEditEvidence[] = edits.map((edit, index) => {
    const anchored = anchorResult.edits[index];
    if (!anchored || !anchored.pos) {
      return {
        editIndex: index,
        candidate: null,
        outcome: "failed",
        relocationDelta: 0,
        strategies: [],
      };
    }
    // Extract line number from the resolved anchor (e.g., "42#ABC" → 42)
    const posMatch = anchored.pos.match(/^(\d+)#|^(\d+)/);
    const resolvedLine = posMatch
      ? Number.parseInt(posMatch[1] ?? posMatch[2] ?? "0", 10)
      : null;
    return {
      editIndex: index,
      candidate: resolvedLine,
      outcome: resolvedLine !== null ? "relocated" : "failed",
      relocationDelta: 0, // would need to track original line
      strategies: [],
    };
  });

  // Step 2: try to apply the resolved edits
  let wouldApply: string;
  let firstChangedLine: number | undefined;
  let lastChangedLine: number | undefined;
  let noopEdits: Array<{
    editIndex: number;
    loc: string;
    currentContent: string;
  }> = [];
  let applyWarnings: string[] = [];
  try {
    const resolved = resolveEditAnchors(anchorResult.edits);
    const applied = applyHashlineEdits(fileContent, resolved);
    wouldApply = applied.content;
    firstChangedLine = applied.firstChangedLine;
    lastChangedLine = applied.lastChangedLine;
    noopEdits = (applied.noopEdits ?? []).map((n) => ({
      editIndex: n.editIndex,
      loc: n.loc,
      currentContent: n.currentContent,
    }));
    applyWarnings = applied.warnings ?? [];
  } catch (err) {
    // Apply failed; mark only the offending edit (best-effort heuristic) as
    // failed. Do NOT blanket-mark all edits as failed — in a multi-edit batch,
    // other edits may have applied cleanly. Analysis
    // correctly flagged the previous `else if` as producing false negatives.
    const errorMessage = err instanceof Error ? err.message : String(err);
    // Try to extract the offending line from the error message
    const lineMatch = errorMessage.match(/line\s+(\d+)/);
    const failingLine = lineMatch ? Number.parseInt(lineMatch[1]!, 10) : null;
    for (let i = 0; i < perEdit.length; i++) {
      const edit = perEdit[i]!;
      if (edit.outcome === "relocated" && edit.candidate === failingLine) {
        edit.outcome = "failed";
      }
      // Other edits retain their pre-apply outcome (relocated, applied, etc.).
      // They were individually anchored; the apply failure is batch-level, not
      // per-edit.
    }
    return {
      wouldApply: fileContent,
      perEdit,
      conflicts: [{ editA: 0, editB: 0, reason: errorMessage }],
      wouldBeNoop: true,
      firstChangedLine: undefined,
      lastChangedLine: undefined,
      // Include the apply error message in warnings too, so the orchestrator's
      // noop response text surfaces it. For E_EDIT_CONFLICT (overlapping
      // ranges), the error doesn't have a 'line N' reference, but the
      // message starts with the E_EDIT_CONFLICT code which the model can
      // match on.
      warnings: [...anchorResult.warnings, errorMessage],
      noopEdits: [],
    };
  }

  const wouldBeNoop = wouldApply === fileContent;
  return {
    wouldApply,
    perEdit,
    conflicts: [], // conflict detection happens inside applyHashlineEdits now
    wouldBeNoop,
    firstChangedLine,
    lastChangedLine,
    // Merge anchor resolution warnings with apply warnings (e.g. W_BOUNDARY_DUP).
    warnings: [...anchorResult.warnings, ...applyWarnings],
    noopEdits,
  };
}
