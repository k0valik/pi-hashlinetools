/**
 * Individual anchor-resolution strategies used by the edit tool, and
 * the medley runner that composes them.
 *
 * Each strategy is a pure function that takes the current file state and
 * the content hint from a ref, and returns a `StrategyCandidate` —
 * either a line number (1-based) with a confidence, or null with a
 * reason.
 *
 * The medley (`runAnchorMedley`) runs these strategies in priority order
 * with a fast-path optimization: 0-1 line shifts accept immediately,
 * 2-10 line shifts get a single corroboration, and larger shifts or
 * ambiguities trigger the full medley.
 */
import { Buffer } from "node:buffer";
import { ANCHOR_SEP, computeLineHash } from "./hashline";
import { computePublicLineChecksum } from "./line-ref";

/** Normalize a content hint for comparison: trim leading/trailing whitespace.
 *  Used by anchor resolution (Layers 1, 2) to compare the model's content
 *  hint against the actual line content. Re-exported from `edit-anchor.ts`
 *  for backward compat. */
export function normalizedContentHint(value: string): string {
  return value.trim();
}

// ── Strategy result shape ────────────────────────────────────────────────

export type StrategyName =
  | "layer2-fuzzy"
  | "layer4-hash"
  | "layer5-byte"
  | "recovery-byte";
export type StrategyTier = "soft" | "strong";
export type StrategyConfidence =
  | "high"
  | "medium"
  | "low"
  | "ambiguous"
  | "none";

export type StrategyCandidate = {
  name: StrategyName;
  tier: StrategyTier;
  candidate: number | null;
  confidence: StrategyConfidence;
  reason?: string;
};

// ── Per-strategy implementations ─────────────────────────────────────────

/** Layer 2: fuzzy content-hint match within ±radius of the expected line.
 *  Skips the expected line itself. Returns null on zero or multiple matches. */
export function tryFuzzyRelocate(
  expected: string,
  line: number,
  fileLines: string[],
  visibleLineCount: number,
  radius: number,
): number | null {
  const start = Math.max(1, line - radius);
  const end = Math.min(visibleLineCount, line + radius);
  let found: number | null = null;
  for (let l = start; l <= end; l++) {
    if (l === line) continue;
    if (normalizedContentHint(fileLines[l - 1] ?? "") === expected) {
      if (found !== null) return null; // multiple matches → ambiguous, reject
      found = l;
    }
  }
  return found;
}

/** Layer 4: hash-index relocation. Find the line whose public checksum
 *  matches `checksum`. Returns the unique match, or null if zero or
 *  multiple matches. Used when the ref has no content hint. */
export function tryHashIndexRelocate(
  checksum: string,
  fileLines: string[],
  visibleLineCount: number,
): StrategyCandidate {
  const matchingLines: number[] = [];
  for (let l = 1; l <= visibleLineCount; l++) {
    const cs = computePublicLineChecksum(fileLines, l);
    if (cs === checksum) matchingLines.push(l);
  }
  if (matchingLines.length === 1) {
    return {
      name: "layer4-hash",
      tier: "soft",
      candidate: matchingLines[0]!,
      confidence: "medium", // no content verification, just hash match
    };
  }
  if (matchingLines.length > 1) {
    return {
      name: "layer4-hash",
      tier: "soft",
      candidate: null,
      confidence: "ambiguous",
      reason: `hash matches ${matchingLines.length} lines`,
    };
  }
  return {
    name: "layer4-hash",
    tier: "soft",
    candidate: null,
    confidence: "none",
    reason: "no line has matching hash",
  };
}

/** Result of a byte-level relocation attempt.
 *  - `none`: no line-start match found.
 *  - `found`: exactly one line-start match — the line number to use.
 *  - `ambiguous`: 2+ line-start matches — the medley cannot decide. The
 *    caller should surface this as a distinct user-facing error
 *    (E_RELOCATE_AMBIGUOUS) rather than collapsing it into the generic
 *    "content mismatch" error. */
export type ByteRelocateResult =
  | { kind: "none" }
  | { kind: "found"; line: number }
  | { kind: "ambiguous"; count: number };

/** Layer 5: byte-level relocation.
 *  When text-line fuzzy/hash relocation fails, search the raw file bytes for
 *  the content hint.  This catches cases where normalized text differs from
 *  raw bytes (encoding quirks, non-UTF-8 round-trip issues, or shifts beyond
 *  the text-line search radius).  Full-file scan - no radius limit. */
export function tryByteRelocate(
  rawBuffer: Buffer,
  contentHint: string,
  visibleLineCount: number,
): ByteRelocateResult {
  // Empty-contentHint guard: Buffer.indexOf with an empty needle matches
  // at every byte position, which would cause O(n) wasted iterations and
  // produce a spurious "match at every position" result. Same fix as in
  // edit-recovery.ts::findAllOccurrences.
  if (contentHint.length === 0) return { kind: "none" };
  const needle = Buffer.from(contentHint, "utf-8");
  const positions: number[] = [];
  const hasBom =
    rawBuffer.length >= 3 &&
    rawBuffer[0] === 0xef &&
    rawBuffer[1] === 0xbb &&
    rawBuffer[2] === 0xbf;
  const bomLength = hasBom ? 3 : 0;
  let idx = 0;
  while (true) {
    idx = rawBuffer.indexOf(needle, idx);
    if (idx === -1) break;
    // Only accept positions at line starts (after \n or at file start / after BOM)
    if (idx === bomLength || (idx > 0 && rawBuffer[idx - 1] === 0x0a)) {
      positions.push(idx);
    }
    idx += 1;
  }
  // Distinguish "no match" (0) from "ambiguous" (2+) so the caller can
  // surface a distinct E_RELOCATE_AMBIGUOUS error.
  if (positions.length === 0) return { kind: "none" };
  if (positions.length > 1) {
    return { kind: "ambiguous", count: positions.length };
  }

  // Map byte position to 1-based line number by counting \n
  let lineNum = 1;
  let i = 0;
  while (i < positions[0]!) {
    // CRLF → one line break (matches normalizeToLF semantics)
    if (rawBuffer[i] === 0x0d && rawBuffer[i + 1] === 0x0a) {
      lineNum++;
      i += 2;
      continue;
    }
    // LF or bare CR → one line break
    if (rawBuffer[i] === 0x0a || rawBuffer[i] === 0x0d) {
      lineNum++;
    }
    i++;
  }
  if (lineNum < 1 || lineNum > visibleLineCount) return { kind: "none" };
  return { kind: "found", line: lineNum };
}

/** Resolve a compact ref (bare line number or LINE#HASH without content
 *  hint) into a full anchor using current file state.
 *  Returns the anchor string in "LINE#HASH" form, or `undefined` if the
 *  ref is invalid or the line is out of range. */
export function tryResolveCompactRef(
  ref: string,
  fileLines: string[],
  visibleLineCount: number,
  label: string,
  warnings: string[],
): string | undefined {
  const trimmed = ref.trim();
  const match = trimmed.match(
    /^(\d+)(?:#([A-Za-z0-9_-]{3})|([A-Za-z0-9_-]{3})|([0-9a-fA-F]{2})|[a-z])?$/i,
  );
  if (!match) return undefined;

  const plainNum = Number.parseInt(match[1]!, 10);
  if (plainNum >= 1 && plainNum <= visibleLineCount) {
    const hash = computeLineHash(fileLines, plainNum - 1);
    warnings.push(
      `${label} "${ref}" uses a compact line reference without content. Using the current file state for this line. Prefer full checked endpoint lines from read output (e.g. "42abc│const value = 1;") for accurate results.`,
    );
    return `${plainNum}${ANCHOR_SEP}${hash}`;
  }

  return undefined;
}

// ── Medley runner ────────────────────────────────────────────────────────

/** Constants that gate the fast-path optimization. */
const FAST_PATH_MAX_SHIFT = 1; // 0-1 line shift → accept immediately, no corroboration
const CORROBORATION_MAX_SHIFT = 10; // 2-10 line shift → single corroboration with Layer 5
const FUZZY_RADIUS = 40; // text-line search radius for Layer 2

export type AnchorMedleyArgs = {
  fileLines: string[];
  visibleLineCount: number;
  expectedLine: number;
  contentHint: string;
  /** Optional. When provided, Layer 4 (hash-index) is also run. */
  checksum?: string;
  rawBuffer: Buffer;
};

export type AnchorMedleyResult = {
  /** Where the edit lands. null if no strategy found a match. */
  candidate: number | null;
  /** What the medley decided. */
  outcome: "applied" | "relocated" | "recovered" | "ambiguous" | "failed";
  /** Shift from expectedLine to candidate. 0 = no shift, negative = up, positive = down. */
  relocationDelta: number;
  /** Per-strategy evidence. */
  strategies: StrategyCandidate[];
};

/** Run the anchor-resolution medley. Returns the best candidate according
 *  to the tiered agreement rules.
 *
 *  Fast path: Layer 2 with 0-1 line shift → accept immediately.
 *  Corroboration: 2-10 line shift → Layer 5 confirms.
 *  Full medley: >10 line shift, Layer 2 fail, or Layer 2 ambiguous.
 */
export function runAnchorMedley(args: AnchorMedleyArgs): AnchorMedleyResult {
  const {
    fileLines,
    visibleLineCount,
    expectedLine,
    contentHint,
    checksum,
    rawBuffer,
  } = args;
  const strategies: StrategyCandidate[] = [];

  // ── Fast path: Layer 2 with 0-1 line shift (the common case) ──
  const layer2Line = tryFuzzyRelocate(
    normalizedContentHint(contentHint),
    expectedLine,
    fileLines,
    visibleLineCount,
    FUZZY_RADIUS,
  );

  // Layer 1 short-circuit: content matches at expected line → 0 shift, "applied"
  const expectedContent = fileLines[expectedLine - 1] ?? "";
  if (
    contentHint.length > 0 &&
    normalizedContentHint(expectedContent) ===
      normalizedContentHint(contentHint)
  ) {
    strategies.push({
      name: "layer2-fuzzy",
      tier: "soft",
      candidate: expectedLine,
      confidence: "high",
    });
    return {
      candidate: expectedLine,
      outcome: "applied",
      relocationDelta: 0,
      strategies,
    };
  }

  // Layer 2 found a unique match within radius
  if (layer2Line !== null) {
    const delta = layer2Line - expectedLine;
    strategies.push({
      name: "layer2-fuzzy",
      tier: "soft",
      candidate: layer2Line,
      confidence: "high",
    });

    // 0-1 line shift: fast path
    if (Math.abs(delta) <= FAST_PATH_MAX_SHIFT) {
      return {
        candidate: layer2Line,
        outcome: delta === 0 ? "applied" : "relocated",
        relocationDelta: delta,
        strategies,
      };
    }

    // 2-10 line shift: corroborate with Layer 5
    if (Math.abs(delta) <= CORROBORATION_MAX_SHIFT) {
      const layer5 = tryByteRelocate(rawBuffer, contentHint, visibleLineCount);
      if (layer5.kind === "found") {
        const layer5Line = layer5.line;
        const layer5Candidate: StrategyCandidate = {
          name: "layer5-byte",
          tier: "strong",
          candidate: layer5Line,
          confidence: "high",
        };
        strategies.push(layer5Candidate);

        if (layer5Line === layer2Line) {
          // Agreement: both found same line
          return {
            candidate: layer2Line,
            outcome: "relocated",
            relocationDelta: delta,
            strategies,
          };
        }
        // Disagreement: strong tier (Layer 5) wins
        return {
          candidate: layer5Line,
          outcome: "relocated",
          relocationDelta: layer5Line - expectedLine,
          strategies,
        };
      }
      // Layer 5 didn't run or failed — accept Layer 2's result
      return {
        candidate: layer2Line,
        outcome: "relocated",
        relocationDelta: delta,
        strategies,
      };
    }

    // >10 line shift: accept Layer 2 result (rare; the byte-level scan
    // would be more authoritative but Layer 2's match within radius
    // means the content IS nearby, just shifted)
    return {
      candidate: layer2Line,
      outcome: "relocated",
      relocationDelta: delta,
      strategies,
    };
  }

  // ── Layer 2 failed or returned null (ambiguous) ──
  // Record Layer 2's evidence
  strategies.push({
    name: "layer2-fuzzy",
    tier: "soft",
    candidate: null,
    confidence: "none",
    reason: "no unique match in radius",
  });

  // Run Layer 4 (hash-index) as a soft fallback whenever a checksum is
  // available. Layer 4 always contributes evidence. It only relocates if the
  // hash matches exactly one line (conservative remap); otherwise we fall
  // through to Layer 5 or the E_LINE_CHANGED error.
  //
  // This point is reached only after Layer 1 and Layer 2 both failed to
  // find a content-based match, so Layer 4's hash-only evidence is
  // strictly additional — it never overrides a content-based winner.
  if (checksum !== undefined) {
    const layer4 = tryHashIndexRelocate(checksum, fileLines, visibleLineCount);
    strategies.push(layer4);
    if (layer4.candidate !== null && layer4.confidence === "medium") {
      return {
        candidate: layer4.candidate,
        outcome: "relocated",
        relocationDelta: layer4.candidate - expectedLine,
        strategies,
      };
    }
  }

  // Run Layer 5 (byte-level)
  const layer5 = tryByteRelocate(rawBuffer, contentHint, visibleLineCount);
  if (layer5.kind === "found") {
    const layer5Line = layer5.line;
    strategies.push({
      name: "layer5-byte",
      tier: "strong",
      candidate: layer5Line,
      confidence: "high",
    });
    return {
      candidate: layer5Line,
      outcome: "relocated",
      relocationDelta: layer5Line - expectedLine,
      strategies,
    };
  }
  if (layer5.kind === "ambiguous") {
    // 2+ byte-level matches: caller cannot decide. Surface a distinct
    // outcome so the orchestrator can emit E_RELOCATE_AMBIGUOUS instead
    // of the misleading E_LINE_CONTENT_MISMATCH.
    strategies.push({
      name: "layer5-byte",
      tier: "strong",
      candidate: null,
      confidence: "ambiguous",
      reason: `${layer5.count} line-start matches`,
    });
    return {
      candidate: null,
      outcome: "ambiguous",
      relocationDelta: 0,
      strategies,
    };
  }
  // layer5.kind === "none"
  strategies.push({
    name: "layer5-byte",
    tier: "strong",
    candidate: null,
    confidence: "none",
    reason: "no unique byte-level match",
  });

  // No candidate from any tier
  return {
    candidate: null,
    outcome: "failed",
    relocationDelta: 0,
    strategies,
  };
}
