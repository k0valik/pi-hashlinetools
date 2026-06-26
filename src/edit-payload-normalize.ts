/**
 * edit-payload-normalize.ts
 *
 * Soft auto-fix pass for the edit tool's input payload. Detects common
 * model mistakes (display prefixes pasted into `lines`, anchor-line
 * echoed as first/last replacement line, missing indent, wide-range
 * replace that should be an insert), fixes them, and emits `W_*`
 * warnings. Hard errors are reserved for cases we cannot safely fix.
 *
 * This layer runs between `normalizeEditItems` (which converts tool-level
 * `HashlineToolEdit[]` from the wire format) and the dry-run (which
 * resolves anchors via the medley and applies the edits in memory).
 *
 * The `replace_text` flow is NOT touched here — it is a different
 * pipeline (handled in `applyReplaceTextEdits`). Helpers in this file
 * are no-ops for `replace_text` edits.
 *
 * The functions are pure: no I/O, no FS, no side effects on the input.
 */

import type { HashlineToolEdit } from "./hashline";
import {
  computePublicLineChecksum,
  formatPublicLineRef,
  parsePublicLineRef,
} from "./line-ref";

/** Regex for unambiguous display prefixes (line number is present). */
const FULL_PREFIX_RE =
  /^\s*(?:>>>|>>|\+)?\s*(?:\d+\s*#\s*[A-Za-z0-9_-]{3}[│|:]|\d+[A-Za-z0-9_-]{3}│)/;

/** Diff-marker line: `- N    content` (negative-line from a diff). Drop entirely. */
const MINUS_PREFIX_RE = /^-\s*\d+\s{4}/;

/** Tokenize for the broadRangeToInsert overlap heuristic. Splits on any non-word char. */
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(Boolean);
}

/** Whitespace-stripped equality. */
function wsEq(a: string, b: string): boolean {
  return a === b || a.replace(/\s+/g, "") === b.replace(/\s+/g, "");
}

/**
 * Strip unambiguous display prefixes from `lines` (e.g. "42#Xy0│const x = 1"
 * → "const x = 1"). Drop diff-marker lines (e.g. "- 2    foo") entirely.
 * Emit one warning per modified/dropped line.
 *
 * Returns `emptyAfterStrip: true` when the resulting `lines` array is empty
 * or when stripping a single LINE#ID│ prefix left a blank line. The caller
 * must hard-error in that case.
 */
export function validateAndFixLines(
  rawLines: string[] | string | null | undefined,
  editIndex: number,
): { lines: string[]; warnings: string[]; emptyAfterStrip: boolean } {
  let lines: string[];
  if (rawLines == null) {
    lines = [];
  } else if (typeof rawLines === "string") {
    // Match `hashlineParseText` behavior: drop exactly one trailing \n,
    // normalize \r\n → \n, split on \n.
    const stripped = rawLines.endsWith("\n") ? rawLines.slice(0, -1) : rawLines;
    lines = stripped.replaceAll("\r", "").split("\n");
  } else {
    lines = [...rawLines];
  }

  const warnings: string[] = [];
  let strippedSomething = false;
  let prefixStrippedCount = 0;
  let diffMarkerDroppedCount = 0;
  let hasValidLine = false;
  const result: string[] = [];

  // Iterate forward. Silent on success.
  // The diff speaks for itself. Warnings are only emitted in the
  // failure case (emptyAfterStrip) where the auto-fix couldn't fully
  // resolve the input. We count per-line auto-fixes but emit at most
  // one summary per category per edit.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Empty lines pass through (caller's choice).
    if (!line.length) {
      result.push(line);
      hasValidLine = true;
      continue;
    }

    // Diff minus line: drop entirely.
    if (MINUS_PREFIX_RE.test(line)) {
      strippedSomething = true;
      diffMarkerDroppedCount++;
      continue;
    }

    const fullMatch = line.match(FULL_PREFIX_RE);
    if (fullMatch) {
      strippedSomething = true;
      prefixStrippedCount++;
      const stripped = line.slice(fullMatch[0].length);
      if (stripped.length === 0) {
        // Stripping a "42#Xy0│" with nothing after leaves a blank
        // line. Preserve it as "" in the output: a blank line in the
        // middle of a multi-line replace is a real "empty line in
        // the file" the user may have wanted. Silently dropping it
        // would lose user content. Track hasValidLine so that
        // emptyAfterStrip is only true when stripping left us
        // WITHOUT any usable line at all (no pass-through empty
        // line, no other line, just empty).
        result.push("");
        hasValidLine = true;
        continue;
      }
      result.push(stripped);
      hasValidLine = true;
      continue;
    }

    result.push(line);
    hasValidLine = true;
  }

  // Failure-case summary: ONLY when stripping left us empty. This is
  // the only time the model genuinely needs to know what happened.
  // On success (auto-fix worked, result is usable), be silent.
  if (strippedSomething && !hasValidLine) {
    if (prefixStrippedCount > 0) {
      warnings.push(
        `[W_DISPLAY_PREFIX_IN_LINES] edit ${editIndex} had ${prefixStrippedCount} line(s) with a read-output prefix that stripped to empty. The "lines" array needs literal file content.`,
      );
    }
    if (diffMarkerDroppedCount > 0) {
      warnings.push(
        `[W_DIFF_MARKER_IN_LINES] edit ${editIndex} had ${diffMarkerDroppedCount} line(s) that were diff markers (e.g. "- 2    content"); all of them were dropped, leaving the edit empty. The "lines" array needs literal file content, not diff format.`,
      );
    }
  }

  // Hard error only when stripping left us empty AND we actually
  // stripped something. Empty input is the model's choice (e.g. a
  // `replace` of a single line with `lines: []` means "delete the
  // line") — that's not a stripping artifact.
  return {
    lines: result,
    warnings,
    // emptyAfterStrip is true only when we stripped SOMETHING (a
    // prefix or a diff marker) AND the result has no usable line at
    // all. An empty `lines` array is a legitimate "delete" — not a
    // stripping artifact — so it must not trip this flag.
    emptyAfterStrip: strippedSomething && !hasValidLine,
  };
}

export interface StripAnchorEchoResult {
  lines: string[];
  warnings: string[];
}

/**
 * Detect when the model included the anchor line as the first
 * element of `lines` (leading echo) or the range-end line as the
 * last element of `lines` (trailing echo, only for range replace).
 * Auto-strip the echo and warn.
 *
 * - Leading echo: applies to `replace`, `append`, `prepend`.
 * - Trailing echo: applies to `replace` only when `end` is provided
 *   (i.e. range replace, not single-line replace).
 *
 * Equality is whitespace-stripped (whitespace differences between
 * the anchor and the echoed line are tolerated, because the model
 * may have added/removed trailing spaces in copy-paste).
 */
export function stripAnchorEcho(
  lines: string[],
  anchorLineContent: string | undefined,
  rangeEndLineContent: string | undefined,
  op: string,
  editIndex: number,
): { lines: string[]; warnings: string[] } {
  if (lines.length === 0 || anchorLineContent === undefined) {
    return { lines, warnings: [] };
  }

  // The auto-fix happens silently in the background, but the model
  // now gets a brief reminder per stripped line so it can learn over
  // time. We do NOT make this a hard error — the whole point of the
  // medley is silent fixing + brief reminder. The reminder uses a
  // code name (W_ANCHOR_ECHO_STRIPPED) to distinguish it from a hard error.
  let out = lines;
  let leadingStripped = false;
  let trailingStripped = false;

  // Leading echo: any non-replace_text op, but only when there are
  // additional lines after the echo (otherwise it's a noop, not a
  // duplicate). For `replace`, the echo only matters when the range
  // is multi-line (`rangeEndLineContent` is set): a single-line
  // replace with `lines: ["anchor"]` is a legitimate noop.
  if (op === "append" || op === "prepend") {
    if (out.length > 1 && wsEq(out[0]!, anchorLineContent)) {
      out = out.slice(1);
      leadingStripped = true;
    }
  } else if (op === "replace" && rangeEndLineContent !== undefined) {
    // Range replace (multi-line): leading echo causes a duplicate
    // of the range's first line. Strip when there are additional
    // lines (otherwise it's a noop collapse to one line equal to
    // the start anchor).
    if (out.length > 1 && wsEq(out[0]!, anchorLineContent)) {
      out = out.slice(1);
      leadingStripped = true;
    }
  }

  // Trailing echo: range-replace only (op === "replace" with end provided).
  // The same length > 1 guard protects against a single-line
  // replacement equal to the range end (rare, but possible if the
  // range happens to be a single line).
  if (
    op === "replace" &&
    rangeEndLineContent !== undefined &&
    out.length > 1 &&
    wsEq(out[out.length - 1]!, rangeEndLineContent)
  ) {
    out = out.slice(0, -1);
    trailingStripped = true;
  }

  // Build reminders. None for the no-op cases. One per actual strip.
  const warnings: string[] = [];
  if (leadingStripped) {
    warnings.push(
      `[W_ANCHOR_ECHO_STRIPPED] edit ${editIndex}: removed a leading line that matched the anchor. The "lines" array should contain only new content, not a copy of the start anchor.`,
    );
  }
  if (trailingStripped) {
    warnings.push(
      `[W_ANCHOR_ECHO_STRIPPED] edit ${editIndex}: removed a trailing line that matched the range end. The "lines" array should contain only new content, not a copy of the end anchor.`,
    );
  }

  return { lines: out, warnings };
}

/**
 * Restore indentation on `lines[i]` that has zero leading whitespace
 * when the anchor line has non-zero leading whitespace. We only
 * restore when `lines[i]` is completely un-indented (starts with a
 * non-whitespace character) — if the model has provided any indent,
 * we trust it.
 *
 * Safe restore: we do NOT strip whitespace from `lines[i]` if it has any,
 * and we do NOT fall back to a "paired" restore (where old and new have
 * the same length). Both of those risk over-correcting a deliberate change.
 */
export function restoreIndent(
  lines: string[],
  anchorLineContent: string | undefined,
  rangeEndLineContent: string | undefined,
  editIndex: number,
): { lines: string[]; warnings: string[] } {
  if (lines.length === 0) {
    return { lines, warnings: [] };
  }

  const warnings: string[] = [];
  const out = [...lines];
  // Prefer the anchor's indent (it represents the context).
  const anchorIndent = anchorLineContent
    ? (anchorLineContent.match(/^\s*/)?.[0] ?? "")
    : "";

  // Track whether the last line was modified by the anchor-indent
  // pass so the range-end pass can decide whether to overwrite it.
  let lastLineGotAnchorIndent = false;

  if (anchorIndent.length > 0) {
    for (let i = 0; i < out.length; i++) {
      const line = out[i]!;
      if (line.length > 0 && /^\S/.test(line)) {
        out[i] = anchorIndent + line;
        warnings.push(
          `[W_INDENT_RESTORED] edit ${editIndex} line ${i + 1} had no leading whitespace, but the anchor is indented. Restored ${anchorIndent.length} character(s) of indent.`,
        );
        if (i === out.length - 1) {
          lastLineGotAnchorIndent = true;
        }
      }
    }
  }

  // If we have a range-end line with LESS indent than the anchor, the
  // model may have intended the last replacement line to be at the
  // range-end's indent level (e.g. the closing brace of a block).
  // We only override the last line if we just added the anchor's
  // indent to it (i.e. the model had zero indent there and the
  // range-end is the less-indented context). This prevents us from
  // clobbering a line the model explicitly indented.
  if (
    rangeEndLineContent !== undefined &&
    out.length > 0 &&
    lastLineGotAnchorIndent
  ) {
    const rangeEndIndent = rangeEndLineContent.match(/^\s*/)?.[0] ?? "";
    if (
      rangeEndIndent.length > 0 &&
      rangeEndIndent.length < anchorIndent.length
    ) {
      const lastLineOriginalContent = out[out.length - 1]!.slice(
        anchorIndent.length,
      );
      out[out.length - 1] = rangeEndIndent + lastLineOriginalContent;
      // Replace the last "W_INDENT_RESTORED" warning with one
      // that mentions the range-end indent specifically.
      warnings.pop();
      warnings.push(
        `[W_INDENT_RESTORED] edit ${editIndex} last line had no leading whitespace, but the range-end is indented less than the anchor. Restored ${rangeEndIndent.length} character(s) of indent.`,
      );
    }
  }

  return { lines: out, warnings };
}

export interface BroadRangeToInsertResult {
  /** The converted edit, or `null` if no auto-fix applies. */
  edit: HashlineToolEdit | null;
  /** The warning to emit (only set when a conversion is applied). */
  warning: string | null;
}

/** Threshold for "no overlap" — shared/replacement tokens below this is an insertion. */
const RANGE_OVERLAP_THRESHOLD = 0.3;

/**
 * Detect "wide range replace that should be an insert" and convert
 * it to a prepend on the line after the range end. Conditions:
 *
 * 1. `op === "replace"`
 * 2. Both `pos` and `end` are provided (multi-line range, not
 *    single-line replace)
 * 3. `lines.length === 1` (single replacement line)
 * 4. The single replacement line shares <30% of its tokens with
 *    the range content (clearly an insertion, not a collapse)
 *
 * Returns `{ edit, warning }` when conversion applies,
 * `{ edit: null, warning: null }` otherwise. The function never
 * returns a converted edit without a warning — auditability.
 */
export function broadRangeToInsert(
  edit: HashlineToolEdit,
  fileLines: string[],
  editIndex: number,
): BroadRangeToInsertResult {
  if (edit.op !== "replace" || !edit.end) {
    return { edit: null, warning: null };
  }

  // Normalize `lines` to array of length 1.
  const linesArray = (() => {
    if (edit.lines == null) return [];
    if (typeof edit.lines === "string") {
      const stripped = edit.lines.endsWith("\n")
        ? edit.lines.slice(0, -1)
        : edit.lines;
      return stripped.replaceAll("\r", "").split("\n");
    }
    return edit.lines;
  })();

  if (linesArray.length !== 1) {
    return { edit: null, warning: null };
  }

  const replacementLine = linesArray[0]!;

  // Resolve pos and end line numbers.
  const startParsed = parsePublicLineRef(edit.pos);
  const endParsed = parsePublicLineRef(edit.end);
  if (!startParsed || !endParsed) {
    return { edit: null, warning: null };
  }
  if (startParsed.line >= endParsed.line) {
    // Single-line range (start === end), or an invalid range
    // (start > end, e.g. `range: [15, 5]`). Either way, the
    // wide-range → insert auto-fix is not applicable. An invalid
    // range will be properly rejected downstream with E_BAD_RANGE
    // by the medley — we don't want to silently auto-fix it into a
    // prepend at end+1, which would mask the real error.
    return { edit: null, warning: null };
  }
  if (endParsed.line >= fileLines.length) {
    // Range extends to (or past) the last line — can't prepend after.
    return { edit: null, warning: null };
  }

  // Compute token overlap.
  const rangeStart = startParsed.line;
  const rangeEnd = endParsed.line;
  const rangeContentLines: string[] = [];
  for (let i = rangeStart - 1; i < rangeEnd && i < fileLines.length; i++) {
    rangeContentLines.push(fileLines[i] ?? "");
  }
  const rangeContent = rangeContentLines.join("\n");

  const replacementTokens = new Set(tokenize(replacementLine));
  const rangeTokens = new Set(tokenize(rangeContent));

  if (replacementTokens.size === 0) {
    // Empty replacement after tokenization — ambiguous, don't auto-fix.
    return { edit: null, warning: null };
  }

  let shared = 0;
  for (const tok of replacementTokens) {
    if (rangeTokens.has(tok)) shared++;
  }
  const overlap = shared / replacementTokens.size;

  if (overlap >= RANGE_OVERLAP_THRESHOLD) {
    // Looks like a deliberate collapse; let the normal flow handle it.
    return { edit: null, warning: null };
  }

  // Convert: prepend on the line after the range end.
  const newPosLine = rangeEnd + 1;
  if (newPosLine > fileLines.length) {
    return { edit: null, warning: null };
  }
  const newPosLineContent = fileLines[newPosLine - 1] ?? "";
  const newPosChecksum = computePublicLineChecksum(fileLines, newPosLine);
  const newPosRef = formatPublicLineRef(fileLines, newPosLine);

  const converted: HashlineToolEdit = {
    op: "prepend",
    pos: newPosRef,
    lines: [replacementLine],
  };

  // Build a user-readable warning that doesn't leak the new checksum
  // (internal hashline ref) but does include line numbers (the model
  // needs to learn the line where the line was inserted).
  const warning = `[W_RANGE_TOO_BROAD] edit ${editIndex} replaced ${rangeEnd - rangeStart + 1} lines (${rangeStart}-${rangeEnd}) with a single line that has no token overlap with the range — this looks like a single-line insert, not a collapse. Auto-converted to op: "prepend" on line ${newPosLine} (the line after the original range end). Read the file again to verify the new content.`;

  // Suppress unused-var warning on newPosChecksum / newPosLineContent:
  // we deliberately don't use them in the output (no content hint).
  void newPosChecksum;
  void newPosLineContent;

  return { edit: converted, warning };
}

export interface NormalizeEditPayloadResult {
  edits: HashlineToolEdit[];
  warnings: string[];
}

/**
 * Run the full normalization pass over a list of `HashlineToolEdit`s.
 * Applies (in order): `validateAndFixLines`, `stripAnchorEcho`,
 * `restoreIndent`, `broadRangeToInsert`. Collects all warnings.
 *
 * Throws `E_INVALID_PATCH` if any edit ends up with empty `lines`
 * after stripping (we cannot fix that — the model must provide
 * real content).
 */
export function normalizeEditPayload(
  edits: HashlineToolEdit[],
  fileLines: string[],
): NormalizeEditPayloadResult {
  const warnings: string[] = [];
  const out: HashlineToolEdit[] = [];

  edits.forEach((edit, editIndex) => {
    if (edit.op === "replace_text") {
      // Not touched by this layer.
      out.push(edit);
      return;
    }

    // 1. validateAndFixLines — strip display prefixes, drop diff
    //    markers, hard-error on empty-after-strip.
    const v = validateAndFixLines(edit.lines, editIndex);
    if (v.emptyAfterStrip) {
      throw new Error(
        `[E_INVALID_PATCH] edit ${editIndex} has no replacement content after stripping display prefixes and diff markers. The "lines" array must contain at least one line of real file content — for example, "lines": ["const x = 1;"] not "lines": ["42#Xy0│"] (which strips to empty).`,
      );
    }
    warnings.push(...v.warnings);

    // Build the working copy of the edit.
    let workingEdit: HashlineToolEdit = {
      ...edit,
      lines: v.lines,
    };

    // 2. broadRangeToInsert — convert wide-range-replace with no
    //    overlap into a prepend. This must run BEFORE stripAnchorEcho
    //    because the converted edit no longer has an `end` field.
    //
    // Only apply this conversion for SINGLE-edit batches. For
    // multi-edit batches, the conversion can hide overlap conflicts.
    // Single-edit batches are the safe case — the common model mistake
    // is where the model uses `range: [N, M]` to add a new line.
    // The single-edit-batch gate for broadRangeToInsert counts
    // HASHLINE edits only — `replace_text` is a different pipeline
    // and is not a candidate for range→insert conversion. Counting
    // `edits.length` (which includes `replace_text` entries when
    // the caller's batch mixes both ops) is wrong: a batch of
    // `[replace_text, wide-range-replace]` has length 2, but the
    // single hashline edit IS a valid candidate for the auto-fix.
    //
    const hashlineEditCount = edits.filter(
      (e) => e.op !== "replace_text",
    ).length;
    const br =
      hashlineEditCount === 1
        ? broadRangeToInsert(workingEdit, fileLines, editIndex)
        : { edit: null, warning: null };
    if (br.edit && br.warning) {
      warnings.push(br.warning);
      workingEdit = br.edit;
      // Continue with the (converted) edit through the rest of
      // the pipeline. stripAnchorEcho will run on the converted
      // edit's anchor (line-after-end) which is fine.
    }

    // 3. stripAnchorEcho — only meaningful for non-replace_text.
    const anchorLineContent = lookupLine(fileLines, workingEdit.pos);
    // Only resolve the end content when the range is actually
    // multi-line (start.line !== end.line). For single-line
    // replace (`range: [a, a]` or `pos: a` without `end`), the
    // `lines: ["anchor"]` pattern is a legitimate noop — don't
    // strip it.
    const startParsedForEcho = parsePublicLineRef(workingEdit.pos);
    const endParsedForEcho =
      workingEdit.end !== undefined
        ? parsePublicLineRef(workingEdit.end)
        : undefined;
    const isMultiLineRangeForEcho = !!(
      startParsedForEcho &&
      endParsedForEcho &&
      startParsedForEcho.line !== endParsedForEcho.line
    );
    const rangeEndLineContent =
      isMultiLineRangeForEcho && workingEdit.end !== undefined
        ? lookupLine(fileLines, workingEdit.end)
        : undefined;

    const echo = stripAnchorEcho(
      workingEdit.lines as string[],
      anchorLineContent,
      rangeEndLineContent,
      workingEdit.op,
      editIndex,
    );
    warnings.push(...echo.warnings);
    workingEdit = { ...workingEdit, lines: echo.lines };

    // 4. restoreIndent — only meaningful for non-empty lines.
    const indent = restoreIndent(
      workingEdit.lines as string[],
      anchorLineContent,
      rangeEndLineContent,
      editIndex,
    );
    warnings.push(...indent.warnings);
    workingEdit = { ...workingEdit, lines: indent.lines };

    out.push(workingEdit);
  });

  return { edits: out, warnings };
}

/** Resolve a public line ref to its content in `fileLines`, or undefined. */
function lookupLine(fileLines: string[], ref: string): string | undefined {
  const parsed = parsePublicLineRef(ref);
  if (!parsed) return undefined;
  if (parsed.line < 1 || parsed.line > fileLines.length) {
    return undefined;
  }
  return fileLines[parsed.line - 1];
}
