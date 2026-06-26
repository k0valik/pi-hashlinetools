/**
 * Anchor resolution and relocation for hashline edits.
 *
 * Extracted from edit.ts to concentrate the multi-layer relocation algorithm
 * (content-hint match → fuzzy relocate → hash-index relocate → byte-level
 * relocate) into a single module testable independently of tool registration.
 */
import type { Buffer } from "node:buffer";
import { formatError } from "./edit-errors";
import {
  normalizedContentHint,
  runAnchorMedley,
  tryByteRelocate,
  tryFuzzyRelocate,
  tryResolveCompactRef,
} from "./edit-strategies";
import {
  ANCHOR_SEP,
  CONTENT_SEP,
  computeLineHash,
  type HashlineToolEdit,
  parseLineRef,
} from "./hashline";
import {
  computePublicLineChecksum,
  getVisibleLineCount,
  parsePublicLineRef,
} from "./line-ref";

// ── Helpers ──────────────────────────────────────────────────────────────

/** @deprecated import from "./edit-strategies" instead.
 *  Re-exported for backward compat with existing consumers. */
export { normalizedContentHint };

function hasEndpointContent(ref: string): boolean {
  return ref.includes(CONTENT_SEP) || ref.includes("|") || ref.includes(":");
}

const FUZZY_SEARCH_RADIUS = 40;

// ── Relocation strategies moved to ./edit-strategies.ts ──
// (tryFuzzyRelocate, tryByteRelocate, tryResolveCompactRef)

// ── Main anchor resolution ───────────────────────────────────────────────

export type EditBehaviorOptions = {
  maxEditsPerCall?: number;
  postEditVerify?: boolean;
};

function anchorPublicLineRef(
  ref: string | undefined,
  fileLines: string[],
  visibleLineCount: number,
  label: "range start" | "range end",
  options: EditBehaviorOptions,
  warnings: string[],
  relocations?: {
    label: "range start" | "range end";
    originalLine: number;
    relocatedLine: number;
  }[],
  rawBuffer?: Buffer,
): string | undefined {
  if (typeof ref !== "string") return ref;
  if (!hasEndpointContent(ref)) {
    const compact = tryResolveCompactRef(
      ref,
      fileLines,
      visibleLineCount,
      label,
      warnings,
    );
    if (compact) return compact;
    // API contract: "compact ref" / "full checked endpoint line" are
    // internal phrasing. The model just needs to know the ref doesn't
    // resolve to a line in the current file.
    throw new Error(
      formatError(
        "E_FULL_REF_REQUIRED",
        `${label} "${ref}" is not a valid line reference. Use the line identifier from the read tool output (e.g. "42f${CONTENT_SEP}const value = 1;") which includes the line content.`,
      ),
    );
  }

  const parsed = parsePublicLineRef(ref);
  if (!parsed) return ref;

  const { checksum, contentHint } = parsed;
  let { line } = parsed;

  // ── Layer 1 special case: content matches at expected line, with stale checksum
  // (This is the "edit was made and reverted" failure mode the existing code catches
  // before any relocation runs. Preserved for backward compat — the medley doesn't
  // have access to the parsed checksum context.)
  if (line >= 1 && line <= visibleLineCount) {
    const expected = normalizedContentHint(contentHint ?? "");
    const actual = normalizedContentHint(fileLines[line - 1] ?? "");
    if (expected === actual) {
      // Content matches at expected position — check checksum only
      if (checksum !== undefined) {
        const actualCs = computePublicLineChecksum(fileLines, line);
        if (checksum !== actualCs) {
          // API contract: "line checksum" / "endpoint content" /
          // "current checked line" are internal phrasing. The model just
          // needs to know the line content still matches, so the edit is
          // being applied to the line we expected.
          warnings.push(
            `[W_STALE_CONTEXT] line ${line} content still matches, but the line identifier has changed since you read it; using the current line state.`,
          );
        }
      }
      return `${line}${ANCHOR_SEP}${computeLineHash(fileLines, line - 1)}`;
    }
  }

  // ── Run the medley for everything else (Layers 2-5) ──
  // The medley applies the fast-path optimization and the tiered agreement rules
  // to decide which strategy's answer to use. We translate the per-strategy
  // evidence into the W_* warnings the existing tests expect.
  if ((contentHint ?? "").length === 0 && checksum === undefined) {
    // Nothing to relocate on
    return `${line}${ANCHOR_SEP}${computeLineHash(fileLines, line - 1)}`;
  }

  if (!rawBuffer) {
    // No raw buffer means we can only do text-line strategies
    // Fall back to legacy behavior: run Layer 2 only
    const expected = normalizedContentHint(contentHint ?? "");
    if (expected.length > 0) {
      const relocated = tryFuzzyRelocate(
        expected,
        line,
        fileLines,
        visibleLineCount,
        FUZZY_SEARCH_RADIUS,
      );
      if (relocated !== null) {
        // API contract: avoid the internal "automatic relocation"
        // phrasing. The model just needs to know the line moved and the
        // edit was applied to the new position.
        warnings.push(
          `[W_STALE_CONTEXT] line ${line} content has moved to line ${relocated} since you read it; the edit is being applied to the new position. Verify the diff.`,
        );
        if (relocations) {
          relocations.push({
            label,
            originalLine: line,
            relocatedLine: relocated,
          });
        }
        line = relocated;
        return `${line}${ANCHOR_SEP}${computeLineHash(fileLines, line - 1)}`;
      }
    }
  } else {
    // Full medley
    const medley = runAnchorMedley({
      fileLines,
      visibleLineCount,
      expectedLine: line,
      contentHint: contentHint ?? "",
      checksum,
      rawBuffer,
    });

    if (medley.candidate !== null) {
      const relocated = medley.candidate;
      // Emit the warning based on which strategy won
      const winningStrategy = medley.strategies.find(
        (s) =>
          s.candidate === relocated &&
          s.confidence !== "none" &&
          s.confidence !== "ambiguous",
      );
      const wasStrong =
        medley.strategies.filter((s) => s.candidate !== null).length > 1
          ? medley.strategies.find(
              (s) => s.candidate === relocated && s.tier === "strong",
            )
          : winningStrategy;
      const strategyName =
        wasStrong?.name ?? winningStrategy?.name ?? "layer2-fuzzy";

      if (relocated !== line) {
        // API contract: avoid leaking the internal relocation strategy
        // names ("layer5-byte", "layer4-hash", "layer2-fuzzy", "byte-level
        // relocation", "text-line search exhausted", "hash-index
        // relocation", "automatic relocation"). The model only needs to
        // know the line moved and the edit was applied at the new
        // position. W_STALE_CONTEXT is used uniformly; W_BYTE_RELOCATE and
        // W_HASH_RELOCATE are kept as distinct codes for tooling/grep but
        // collapse to a single user-facing phrasing.
        const userMessage = `line ${line} content has moved to line ${relocated} since you read it; the edit is being applied to the new position. Verify the diff.`;
        if (strategyName === "layer5-byte") {
          warnings.push(`[W_BYTE_RELOCATE] ${userMessage}`);
        } else if (strategyName === "layer4-hash") {
          warnings.push(`[W_HASH_RELOCATE] ${userMessage}`);
        } else {
          warnings.push(`[W_STALE_CONTEXT] ${userMessage}`);
        }
        if (relocations) {
          relocations.push({
            label,
            originalLine: line,
            relocatedLine: relocated,
          });
        }
      }
      line = relocated;
      return `${line}${ANCHOR_SEP}${computeLineHash(fileLines, line - 1)}`;
    }

    // Medley failed; emit the appropriate error
    if (line < 1 || line > visibleLineCount) {
      // API contract: avoid "endpoint line" (jargon). The model just
      // needs to know the line is past the end of the file.
      throw new Error(
        formatError(
          "E_LINE_OUT_OF_RANGE",
          `line ${line} is past the end of the file (file has ${visibleLineCount} line${visibleLineCount === 1 ? "" : "s"}). Use a line reference from a recent read.`,
        ),
      );
    }

    // Layer-5 byte-level search found 2+ matches — the target content
    // appears more than once in the file. The model needs a more specific
    // error than E_LINE_CHANGED (which suggests the line was edited since
    // you read it) — the actual cause is duplicate content, not stale
    // context.
    if (medley.outcome === "ambiguous") {
      const countMatch = medley.strategies
        .find((s) => s.confidence === "ambiguous" && s.reason)
        ?.reason?.match(/(\d+)\s+line-start/);
      const count = countMatch?.[1] ?? "multiple";
      throw new Error(
        formatError(
          "E_RELOCATE_AMBIGUOUS",
          `${label} ${line}${checksum ?? ""} target content appears ${count} times in the file; cannot determine which line to edit. Add the surrounding line content to disambiguate, or use a line number closer to the target.`,
        ),
      );
    }

    const actual = normalizedContentHint(fileLines[line - 1] ?? "");
    const expected = normalizedContentHint(contentHint ?? "");
    // API contract: avoid "checksum" / "endpoint line" jargon. The
    // model just needs to know the line content has changed since it
    // was read, so the edit can't safely target the old content.
    throw new Error(
      formatError(
        "E_LINE_CHANGED",
        `line ${line} content has changed since you read it. Expected: ${JSON.stringify(expected)}, actual: ${JSON.stringify(actual)}. Read the file again to get the current content.`,
      ),
    );
  }

  // Fallback: nothing relocated
  if (line < 1 || line > visibleLineCount) {
    // API contract: same as above — avoid "endpoint line" jargon.
    throw new Error(
      formatError(
        "E_LINE_OUT_OF_RANGE",
        `line ${line} is past the end of the file (file has ${visibleLineCount} line${visibleLineCount === 1 ? "" : "s"}). Use a line reference from a recent read.`,
      ),
    );
  }

  return `${line}${ANCHOR_SEP}${computeLineHash(fileLines, line - 1)}`;
}

// ── Batch anchor resolution ──────────────────────────────────────────────

export function anchorBareLineNumberEdits(
  edits: HashlineToolEdit[],
  content: string,
  options: EditBehaviorOptions,
  warnings: string[] = [],
  rawBuffer?: Buffer,
): { edits: HashlineToolEdit[]; warnings: string[] } {
  const fileLines = content.split("\n");
  const visibleLineCount = getVisibleLineCount(content);

  const anchored: HashlineToolEdit[] = [];
  for (const rawEdit of edits) {
    // Normalize `edit.lines` defensively. The JSON schema strictly
    // requires `lines: string[]`, but the internal `HashlineToolEdit`
    // type also allows `string | string[] | null`. Without this
    // normalization, the E_EMPTY_LINES check below would use the
    // string's character count instead of the array length, and
    // subsequent `[...edit.lines]` spreading would split a string into
    // individual characters.
    const edit: HashlineToolEdit = {
      ...rawEdit,
      lines: Array.isArray(rawEdit.lines)
        ? rawEdit.lines
        : typeof rawEdit.lines === "string"
          ? rawEdit.lines.replace(/\r/g, "").split("\n")
          : [],
    };

    // replace_text is handled separately in apply; skip anchor resolution
    if (edit.op === "replace_text") {
      anchored.push(edit);
      continue;
    }

    // append/prepend with no lines to insert: throw a clear E_EMPTY_LINES
    // error instead of falling through to the noop-conversion path that
    // produces a confusing "replacement for N#XXX is identical to
    // current content" message.
    if (
      (edit.op === "append" || edit.op === "prepend") &&
      (!edit.lines || edit.lines.length === 0)
    ) {
      throw new Error(
        formatError(
          "E_EMPTY_LINES",
          `${edit.op === "append" ? "append" : "prepend"} requires at least one line in "lines"; got an empty array. Either provide the lines to insert, or remove this edit from the request.`,
        ),
      );
    }

    // BOF/EOF: no pos means file boundary
    if ((edit.op === "append" || edit.op === "prepend") && !edit.pos) {
      const newLines = (edit.lines as string[]) || [];
      if (edit.op === "append") {
        // EOF: replace last line with [lastLine, ...newLines]
        if (visibleLineCount === 0) {
          anchored.push({ op: "replace", pos: "", lines: newLines });
          continue;
        }
        const lastLine = visibleLineCount;
        const hash = computeLineHash(fileLines, lastLine - 1);
        anchored.push({
          op: "replace",
          pos: `${lastLine}${ANCHOR_SEP}${hash}`,
          lines: [fileLines[lastLine - 1]!, ...newLines],
        });
      } else {
        // BOF: replace first line with [...newLines, firstLine]
        if (visibleLineCount === 0) {
          anchored.push({ op: "replace", pos: "", lines: newLines });
          continue;
        }
        const hash = computeLineHash(fileLines, 0);
        anchored.push({
          op: "replace",
          pos: `1${ANCHOR_SEP}${hash}`,
          lines: [...newLines, fileLines[0]!],
        });
      }
      continue;
    }

    // Resolve the anchor for replace, append-with-pos, and prepend-with-pos
    const relos: {
      label: "range start" | "range end";
      originalLine: number;
      relocatedLine: number;
    }[] = [];
    let pos =
      anchorPublicLineRef(
        edit.pos,
        fileLines,
        visibleLineCount,
        "range start",
        options,
        warnings,
        relos,
        rawBuffer,
      ) ?? edit.pos;
    // Optimization for single-line ranges: when the model sent the same
    // line number for both pos and end (e.g. `range: [ref, ref]`), the
    // second anchorPublicLineRef call would emit a duplicate relocation
    // warning for the same line. We compare the ORIGINAL refs (not the
    // resolved `pos`) so the check works before any medley runs.
    //
    let end: string | undefined;
    if (edit.end === undefined) {
      end = undefined;
    } else {
      const originalPosParsed = parsePublicLineRef(edit.pos);
      const endParsed = parsePublicLineRef(edit.end);
      if (
        originalPosParsed &&
        endParsed &&
        originalPosParsed.line === endParsed.line
      ) {
        // Single-line range — end is the same line as pos. Reuse pos
        // for the resolution (skip the duplicate anchorPublicLineRef
        // call that would emit a duplicate relocation warning). Also
        // push a synthetic relos entry for "range end" so the
        // asymmetric-shift check below sees matching offsets. If the
        // start was relocated, the end was implicitly relocated to
        // the same target line.
        end = pos;
        const startRelo = relos.find((r) => r.label === "range start");
        if (startRelo) {
          relos.push({
            label: "range end",
            originalLine: startRelo.originalLine,
            relocatedLine: startRelo.relocatedLine,
          });
        }
      } else {
        end = anchorPublicLineRef(
          edit.end,
          fileLines,
          visibleLineCount,
          "range end",
          options,
          warnings,
          relos,
          rawBuffer,
        );
      }
    }

    // Layer 3: asymmetric-shift rejection for multi-line edits (replace only)
    if (edit.end) {
      const startRelo = relos.find((r) => r.label === "range start");
      const endRelo = relos.find((r) => r.label === "range end");
      const startOffset = startRelo
        ? startRelo.relocatedLine - startRelo.originalLine
        : 0;
      const endOffset = endRelo
        ? endRelo.relocatedLine - endRelo.originalLine
        : 0;
      if (startOffset !== endOffset) {
        // Layer 3b: coincidental exact-match check.
        // When one endpoint relocated by N lines but the other matched
        // exactly at its original position, the exact match may be
        // coincidental (e.g. a blank separator line appears at many
        // positions).  Check whether the non-relocated content also
        // appears at original+N - if so, the shift is uniform.
        const shiftedOffset = startOffset !== 0 ? startOffset : endOffset;
        const nonRelocatedIsStart = startOffset === 0;
        const nonReloOrigLine = nonRelocatedIsStart
          ? parsePublicLineRef(edit.pos)?.line
          : parsePublicLineRef(edit.end)?.line;
        const shiftedLine = (nonReloOrigLine ?? 0) + shiftedOffset;

        if (
          nonRelocatedIsStart ? endRelo !== undefined : startRelo !== undefined
        ) {
          const nonReloContentHint = normalizedContentHint(
            nonRelocatedIsStart
              ? (parsePublicLineRef(edit.pos)?.contentHint ?? "")
              : (parsePublicLineRef(edit.end)?.contentHint ?? ""),
          );
          if (
            nonReloOrigLine !== undefined &&
            shiftedLine >= 1 &&
            shiftedLine <= visibleLineCount &&
            nonReloContentHint.length > 0 &&
            nonReloContentHint ===
              normalizedContentHint(fileLines[shiftedLine - 1] ?? "")
          ) {
            // Coincidental match at original position; content also
            // exists at the uniformly-shifted position. Adjust.
            // API contract: avoid "coincidentally", "uniform shift",
            // and "Using shifted position" — the model just needs to know
            // the line moved and the edit is being applied to the new
            // position.
            warnings.push(
              `[W_UNIFORM_SHIFT] ${nonRelocatedIsStart ? "range start" : "range end"} was found at line ${nonReloOrigLine} and also at line ${shiftedLine} (matches shifted by ${shiftedOffset}). Applying the edit at the shifted position.`,
            );
            if (nonRelocatedIsStart) {
              pos = `${shiftedLine}${ANCHOR_SEP}${computeLineHash(fileLines, shiftedLine - 1)}`;
            } else {
              end = `${shiftedLine}${ANCHOR_SEP}${computeLineHash(fileLines, shiftedLine - 1)}`;
            }
          } else {
            // Genuine asymmetric shift - reject.
            const startOrig = startRelo
              ? startRelo.originalLine
              : parsePublicLineRef(edit.pos)?.line;
            const startRelocated = startRelo
              ? startRelo.relocatedLine
              : startOrig;
            const endOrig = endRelo
              ? endRelo.originalLine
              : edit.end
                ? parsePublicLineRef(edit.end)?.line
                : undefined;
            const endRelocated = endRelo ? endRelo.relocatedLine : endOrig;
            // API contract: avoid "structurally modified", "endpoint
            // refs" (jargon), "fresh endpoint refs" (jargon), and
            // "asymmetric shift" (internal). The model just needs to
            // know the start and end moved by different amounts, so the
            // range can't be safely applied.
            throw new Error(
              formatError(
                "E_ASYMMETRIC_SHIFT",
                `the start of the range (line ${startOrig}) moved by ${startOffset >= 0 ? "+" : ""}${startOffset} line(s) but the end (line ${endOrig}) moved by ${endOffset >= 0 ? "+" : ""}${endOffset} — the lines between them changed by a different amount than the range itself. Read the file again to get the current line numbers and retry.`,
              ),
            );
          }
        } else {
          // Neither endpoint relocated - asymmetric shift is real.
          const startOrig = startRelo
            ? startRelo.originalLine
            : parsePublicLineRef(edit.pos)?.line;
          const startRelocated = startRelo
            ? startRelo.relocatedLine
            : startOrig;
          const endOrig = endRelo
            ? endRelo.originalLine
            : edit.end
              ? parsePublicLineRef(edit.end)?.line
              : undefined;
          const endRelocated = endRelo ? endRelo.relocatedLine : endOrig;
          // API contract: same as above — avoid "structurally
          // modified", "endpoint refs", "fresh endpoint refs", and
          // "asymmetric shift".
          throw new Error(
            formatError(
              "E_ASYMMETRIC_SHIFT",
              `the start of the range (line ${startOrig}) moved by ${startOffset >= 0 ? "+" : ""}${startOffset} line(s) but the end (line ${endOrig}) moved by ${endOffset >= 0 ? "+" : ""}${endOffset} — the lines between them changed by a different amount than the range itself. Read the file again to get the current line numbers and retry.`,
            ),
          );
        }
      }
    }

    // Convert append/prepend to replace using the resolved anchor
    if (edit.op === "append" || edit.op === "prepend") {
      const parsed = parseLineRef(pos);
      const newLines = (edit.lines as string[]) || [];
      if (edit.op === "append") {
        // append after line N: replace line N+1 with [newLines..., existingLineN+1]
        const targetLine = parsed.line + 1;
        if (targetLine > visibleLineCount) {
          // After last line becomes EOF
          const lastLine = visibleLineCount;
          const hash = computeLineHash(fileLines, lastLine - 1);
          anchored.push({
            op: "replace",
            pos: `${lastLine}${ANCHOR_SEP}${hash}`,
            lines: [fileLines[lastLine - 1]!, ...newLines],
          });
        } else {
          const hash = computeLineHash(fileLines, targetLine - 1);
          anchored.push({
            op: "replace",
            pos: `${targetLine}${ANCHOR_SEP}${hash}`,
            lines: [...newLines, fileLines[targetLine - 1]!],
          });
        }
      } else {
        // prepend before line N: replace line N with [newLines..., existingLineN]
        const hash = computeLineHash(fileLines, parsed.line - 1);
        anchored.push({
          op: "replace",
          pos: `${parsed.line}${ANCHOR_SEP}${hash}`,
          lines: [...newLines, fileLines[parsed.line - 1]!],
        });
      }
      continue;
    }

    // Default: replace op
    anchored.push({ ...edit, pos, end });
  }

  return { warnings, edits: anchored };
}
