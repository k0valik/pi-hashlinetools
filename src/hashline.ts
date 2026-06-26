/**
 * Hashline engine — hash-anchored line editing.
 *
 * Hash algorithm: inline FNV-1a.
 */

import { formatError } from "./edit-errors";
import { publicChecksumFromHash } from "./line-ref";
import { throwIfAborted } from "./runtime";

// --- Types ---

export type Anchor = { line: number; hash: string; textHint?: string };
export type HashlineEdit = {
  op: "replace" | "append" | "prepend" | "replace_text";
  pos: Anchor;
  end?: Anchor;
  lines: string[];
  oldText?: string;
  newText?: string;
};

interface HashMismatch {
  line: number;
  expected: string;
  actual: string;
}

interface NoopEdit {
  editIndex: number;
  loc: string;
  currentContent: string;
}

// --- Hash computation ---

// 3-char URL-safe base64 encoding (18 bits, 6 bits per char)
const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BASE64_REGEX_SAFE = BASE64_ALPHABET.replace(/-/g, "\\-");
const HASH_LENGTH = 3;
const HASH_ALPHABET_RE = new RegExp(`^[${BASE64_REGEX_SAFE}]+$`);

function hashToBase64(h: number): string {
  // Extract high 18 bits from the 32-bit hash for stability
  const bits18 = (h >>> 14) & 0x3ffff;
  const c0 = BASE64_ALPHABET[(bits18 >>> 12) & 0x3f];
  const c1 = BASE64_ALPHABET[(bits18 >>> 6) & 0x3f];
  const c2 = BASE64_ALPHABET[bits18 & 0x3f];
  return c0 + c1 + c2;
}

export const ANCHOR_SEP = "#";
export const CONTENT_SEP = "│";

// FNV-1a 32-bit constants
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function normalizeLine(line: string): string {
  return line.replace(/\r/g, "").trimEnd();
}

/**
 * Compute a hash for line at `index` (0-based) within `fileLines`.
 * Content-only: the hash depends only on the line's own content (with
 * trailing whitespace and `\r` stripped). Editing other lines never
 * invalidates this anchor, so a read can be reused across distant edits.
 */
export function computeLineHash(
  fileLines: string[],
  index: number,
  retry = 0,
): string {
  let curr = normalizeLine(fileLines[index]!);

  // On retry, suffix the retry counter to break collision
  if (retry > 0) curr = `${curr}:R${retry}`;

  let hash = FNV_OFFSET;
  for (let i = 0; i < curr.length; i++) {
    hash = Math.imul(hash ^ curr.charCodeAt(i), FNV_PRIME);
  }
  return hashToBase64(hash >>> 0);
}

/**
 * Batch compute hashes for all lines in a file, with collision resolution.
 * Uses retry counter to guarantee unique anchors even for byte-identical lines.
 */
export function computeLineHashes(content: string): string[] {
  const lines = content.split("\n");
  const hashes = new Array<string>(lines.length);
  const assigned = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    let hash = computeLineHash(lines, i, 0);
    let retry = 0;
    while (assigned.has(hash)) {
      retry++;
      hash = computeLineHash(lines, i, retry);
    }
    assigned.add(hash);
    hashes[i] = hash;
  }
  return hashes;
}

/**
 * Patterns used to detect (and reject) hashline display prefixes inside edit
 * payloads. The runtime no longer strips them — the model must send literal
 * file content. Matching any of these triggers `[E_INVALID_PATCH]`.
 */
const HASHLINE_PREFIX_RE = new RegExp(
  `^\\s*(?:>>>|>>)?\\s*(?:\\d+\\s*${ANCHOR_SEP}\\s*|${ANCHOR_SEP}\\s*)?[A-Za-z0-9_\\-]{3}${CONTENT_SEP}`,
);
const HASHLINE_PREFIX_PLUS_RE = new RegExp(
  `^\\+\\s*(?:\\d+\\s*${ANCHOR_SEP}\\s*|${ANCHOR_SEP}\\s*)?[A-Za-z0-9_\\-]{3}${CONTENT_SEP}`,
);
const DIFF_MINUS_RE = /^-\s*\d+\s{4}/;

/**
 * Bare hashline prefix: a single public checksum letter followed by a
 * content separator, with no `LINE#` part (e.g. `f│const x = 1;`).
 *
 * This is the partial-hash failure mode: the model copies the public
 * checksum letter it saw in `read` output into `lines` but drops the
 * `LINE#` part. A single such line is genuinely ambiguous — `f│` or
 * `t│` could be a legitimate file-content prefix — so this regex is
 * never rejected on shape alone. Disambiguation happens against the
 * file's actual public checksum set in `warnBareHashPrefixLines`.
 *
 * Mirrors the public read-output format: single letter from `a-z`,
 * separator accepted as `│` (U+2502), `|`, or `:` (matching what
 * `parsePublicLineRef` accepts).
 */
// Bare hashline prefix, optionally preceded by a diff prefix (+/-/space)
// and a line number. Matches all of:
//   jG│content                  (bare hash + separator)
//   524jG│content               (read tool format: line# + hash + separator)
//   +524jG│content              (diff addition)
//   -524jG│content              (diff deletion)
//   524jG│content       (diff context, leading space)
//
// The `│` separator (U+2502) is the disambiguator: without it, a line
// starting with a few digits + 3 letters could be a date or version.
// Mirrors the public read-output format emitted by `formatPublicLineRef`
// and the diff format emitted by `formatDiffHunks`.
const HASHLINE_BARE_PREFIX_RE = /^\s*[+-]?\s*\d*([A-Za-z0-9_-]{3})│/;

// ─── Parsing ────────────────────────────────────────────────────────────

function diagnoseLineRef(ref: string): string {
  const trimmed = ref.trim();
  const core = ref.replace(/^\s*[>+-]*\s*/, "").trim();

  if (!core.length) {
    return `[E_BAD_REF] Invalid line reference "${ref}". Expected "LINE${ANCHOR_SEP}HASH" (e.g. "5${ANCHOR_SEP}MQ").`;
  }
  if (/^\d+\s*$/.test(core)) {
    return `[E_BAD_REF] Invalid line reference "${ref}": missing hash, use "LINE${ANCHOR_SEP}HASH" from read output (e.g. "5${ANCHOR_SEP}MQ").`;
  }
  if (new RegExp(`^d+s*[:${CONTENT_SEP}]`).test(core)) {
    return `[E_BAD_REF] Invalid line reference "${ref}": wrong separator, use "LINE${ANCHOR_SEP}HASH" instead of "LINE:..." or "LINE${CONTENT_SEP}...".`;
  }

  const hashMatch = core.match(
    new RegExp(
      `^(d+)s*${ANCHOR_SEP}s*([^s${CONTENT_SEP}]+)(?:s*${CONTENT_SEP}.*)?$`,
    ),
  );
  if (hashMatch) {
    const line = Number.parseInt(hashMatch[1]!, 10);
    const hash = hashMatch[2]!;
    if (line < 1) {
      return `[E_BAD_REF] Line number must be >= 1, got ${line} in "${ref}".`;
    }
    if (hash.length !== 3) {
      return `[E_BAD_REF] Invalid line reference "${ref}": hash must be exactly 3 URL-safe base64 characters (A-Za-z0-9_-).`;
    }
    if (!HASH_ALPHABET_RE.test(hash)) {
      return `[E_BAD_REF] Invalid line reference "${ref}": hash uses invalid characters, hashes use URL-safe base64 alphabet (A-Za-z0-9_-).`;
    }
  }

  const missingHashMatch = core.match(new RegExp(`^(d+)s*${ANCHOR_SEP}s*$`));
  if (missingHashMatch) {
    return `[E_BAD_REF] Invalid line reference "${ref}": missing hash after "${ANCHOR_SEP}", use "LINE${ANCHOR_SEP}HASH" from read output.`;
  }

  if (new RegExp(`^0+s*${ANCHOR_SEP}`).test(core)) {
    return `[E_BAD_REF] Line number must be >= 1, got 0 in "${ref}".`;
  }

  return `[E_BAD_REF] Invalid line reference "${trimmed || ref}". Expected "LINE${ANCHOR_SEP}HASH" (e.g. "5${ANCHOR_SEP}MQ").`;
}

export function parseLineRef(ref: string): { line: number; hash: string } {
  // Match LINE#HASH format, tolerating:
  //  - leading ">+" and whitespace (from mismatch/diff display)
  //  - optional trailing display suffix (":..." content)
  const parsed = parseAnchorRef(ref);
  return { line: parsed.line, hash: parsed.hash };
}

export function parseAnchorRef(ref: string): Anchor {
  const core = ref.replace(/^\s*[>+-]*\s*/, "").trimEnd();
  const match = core.match(
    new RegExp(
      `^([0-9]+)\\s*${ANCHOR_SEP}\\s*([^\\s${CONTENT_SEP}]+)(?:\\s*${CONTENT_SEP}(.*))?$`,
      "s",
    ),
  );
  if (!match) {
    throw new Error(diagnoseLineRef(ref));
  }

  const line = Number.parseInt(match[1]!, 10);
  if (line < 1) {
    throw new Error(
      formatError(
        "E_BAD_REF",
        `Line number must be >= 1, got ${line} in "${ref}".`,
      ),
    );
  }

  const hash = match[2]!;
  if (hash.length !== 3) {
    throw new Error(
      formatError(
        "E_BAD_REF",
        `Invalid line reference "${ref}": hash must be exactly 3 URL-safe base64 characters (A-Za-z0-9_-).`,
      ),
    );
  }

  if (!HASH_ALPHABET_RE.test(hash)) {
    throw new Error(
      formatError(
        "E_BAD_REF",
        `Invalid line reference "${ref}": hash uses invalid characters, hashes use URL-safe base64 alphabet (A-Za-z0-9_-).`,
      ),
    );
  }

  const textHint = match[3];
  return {
    line,
    hash,
    ...(textHint !== undefined ? { textHint } : {}),
  };
}

// ─── Mismatch formatting ────────────────────────────────────────────────

function formatMismatchError(
  mismatches: HashMismatch[],
  fileLines: string[],
  retryLines: ReadonlySet<number> = new Set<number>(),
): string {
  const retryLineSet = new Set<number>(retryLines);
  for (const m of mismatches) {
    retryLineSet.add(m.line);
  }

  // De-duplicate: same line + same expected hash = same anchor
  const seenKeys = new Set<string>();
  const uniqueMismatches = mismatches.filter((m) => {
    const key = `${m.line}:${m.expected}`;
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });

  const displayLines = new Set<number>();
  for (const m of uniqueMismatches) {
    for (
      let i = Math.max(1, m.line - 2);
      i <= Math.min(fileLines.length, m.line + 2);
      i++
    ) {
      displayLines.add(i);
    }
  }
  for (const line of retryLineSet) {
    displayLines.add(line);
  }

  const sorted = [...displayLines].sort((a, b) => a - b);
  const maxDisplayLine = sorted[sorted.length - 1] ?? 1;
  const lineNumberWidth = String(maxDisplayLine).length;
  const anchorList = uniqueMismatches
    .map((m) => `${m.line}${ANCHOR_SEP}${m.expected}`)
    .join(", ");
  const out: string[] = [
    `[E_STALE_ANCHOR] ${uniqueMismatches.length} stale anchor${uniqueMismatches.length > 1 ? "s" : ""}: ${anchorList}. Use the >>> lines below as replacement anchors; keep both endpoints for range replaces.`,

    "",
  ];

  let prev = -1;
  for (const num of sorted) {
    if (prev !== -1 && num > prev + 1) out.push("    ...");
    prev = num;
    const content = fileLines[num - 1];
    const hash = computeLineHash(fileLines, num - 1);
    const prefix = `${String(num).padStart(lineNumberWidth, " ")}${ANCHOR_SEP}${hash}`;
    out.push(
      retryLineSet.has(num)
        ? `>>> ${prefix}${CONTENT_SEP}${content}`
        : `    ${prefix}${CONTENT_SEP}${content}`,
    );
  }

  return out.join("\n");
}

// ─── Content preprocessing ─────────────────────────────────────────────────────

/**
 * Reject hashline display prefixes in edit payloads. Strict semantics: the
 * model must send literal file content for `lines`, not the rendered read /
 * diff form. Silent stripping is no longer performed — see AGENTS.md.
 */
/**
 * Strip hashline display prefixes from edit payload lines.
 * Returns the count of lines that were modified.
 *
 * Only strips unambiguous display prefixes that include a line number
 * (e.g. "42#AB│content", ">>> 42#AB│content").  Diff minus lines
 * ("-2    content") are dropped entirely — they represent deletions
 * in the model's copy-pasted diff and should not be included.
 * Bare hash prefixes like "AB│content" are NOT stripped here — they are
 * ambiguous (could be legitimate file content). They are handled later
 * in the pipeline by `stripBareHashPrefixes`, which strips only when
 * confident (a real line checksum match, or ≥ 2 suspects).
 */
function stripDisplayPrefixes(lines: string[]): number {
  const fullPrefixRe =
    /^\s*(?:>>>|>>|\+)?\s*(?:\d+\s*#\s*[A-Za-z0-9_-]{3}[│|:]|\d+[A-Za-z0-9_-]{3}│)/;
  const minusPrefixRe = /^-\s*\d+\s{4}/;
  let stripped = 0;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.length) continue;

    // Diff minus lines ("-2    content") → drop completely
    if (minusPrefixRe.test(line)) {
      lines.splice(i, 1);
      stripped++;
      continue;
    }

    const fullMatch = line.match(fullPrefixRe);
    if (fullMatch) {
      lines[i] = line.slice(fullMatch[0].length);
      stripped++;
    }
  }
  return stripped;
}

/**
 * Replace Unicode confusable hyphens and dashes with ASCII hyphen-minus (U+002D).
 * Models sometimes copy-paste these from web/PDF sources, causing subtle mismatches.
 */
const CONFUSABLE_HYPHENS_RE = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g;

function normalizeConfusableHyphens(line: string): string {
  return line.replace(CONFUSABLE_HYPHENS_RE, "-");
}

/**
 * Parse replacement text into lines.
 *
 * String input is normalized to LF and drops exactly one trailing newline,
 * matching read-preview style content. Array input is preserved verbatim so
 * explicitly provided blank lines remain intact. Display prefixes are
 * rejected by `assertNoDisplayPrefixes`, never silently stripped.
 */
export function hashlineParseText(edit: string[] | string | null): string[] {
  if (edit === null) return [];
  const lines =
    typeof edit === "string"
      ? (edit.endsWith("\n") ? edit.slice(0, -1) : edit)
          .replaceAll("\r", "")
          .split("\n")
      : [...edit];
  // Auto-strip hashline display prefixes so the model's copy-paste
  // mistakes don't break editing.  A companion warning is emitted in
  // applyHashlineEdits for any remaining prefixes.
  stripDisplayPrefixes(lines);
  return lines;
}

/**
 * Map flat tool-schema edits into typed internal representations.
 *
 * Strict: provided anchors must parse successfully.
 */
export function resolveEditAnchors(edits: HashlineToolEdit[]): HashlineEdit[] {
  return edits.map((edit) => {
    if (edit.op === "replace_text") {
      return {
        op: "replace_text",
        pos: { line: 0, hash: "" },
        lines: [],
        oldText: edit.oldText ?? "",
        newText: edit.newText ?? "",
      };
    }
    return {
      op: edit.op,
      pos: parseAnchorRef(edit.pos),
      ...(edit.end ? { end: parseAnchorRef(edit.end) } : {}),
      lines: hashlineParseText(edit.lines ?? null),
    };
  });
}

// ─── Main edit engine ───────────────────────────────────────────────────

/** Schema-level edit as received from the tool layer (pos/end are tag strings, lines may be string|null). */
export type HashlineToolEdit = {
  op: "replace" | "append" | "prepend" | "replace_text";
  pos: string;
  end?: string;
  lines?: string[] | string | null;
  oldText?: string;
  newText?: string;
};

function maybeWarnSuspiciousUnicodeEscapePlaceholder(
  edits: HashlineEdit[],
  warnings: string[],
): void {
  for (const edit of edits) {
    if (edit.lines.some((line) => /\\uDDDD/i.test(line))) {
      warnings.push(
        "The edit content contains literal \\uDDDD text. If you intended a Unicode character, use the actual character instead of this placeholder. If you meant literal text, no change is needed.",
      );
    }
  }
}

/**
 * Strip bare hashline prefixes from edit `lines` that look like they were
 * accidentally pasted from `read` output (e.g. `lines: ["f│const x = 1;"]`).
 *
 * Companion to `assertNoDisplayPrefixes`, which handles the unambiguous
 * full `LINE#HH│` form on shape alone. Bare `c│` prefixes are ambiguous:
 * the public checksum is short, and legitimate file content can contain
 * short prefixes. So we only strip when we're confident, i.e. when:
 *   - any suspect hash matches a real public checksum in the file
 *     (almost certainly a copied anchor), OR
 *   - ≥ 2 lines look like bare prefixes (suggests the model copy-pasted
 *     a block of read output as content).
 *
 * In all other cases, content passes through unchanged and no warning
 * is fired. This mirrors the silent-recovery contract of the other
 * content-recovery layers (`stripAnchorEcho`).
 *
 * A single brief `W_BARE_HASH_PREFIX_STRIPPED` warning is emitted (not
 * one per line) so the model learns over time but isn't drowned in noise.
 *
 * Suspects are collected by regex first, so the common path skips the
 * file hash set entirely.
 *
 * Mutates `edits[*].lines` in place. Returns the list of (editIndex, lineIndex)
 * pairs that were actually stripped, for tests.
 */
function stripBareHashPrefixes(
  edits: HashlineEdit[],
  fileLines: string[],
  warnings: string[],
): Array<{
  editIndex: number;
  lineIndex: number;
  original: string;
  stripped: string;
}> {
  // Collect bare-prefix suspects up front: regex only. Almost every edit
  // has none, so this lets the common path bail before paying for file
  // hashes.
  type Suspect = {
    editIndex: number;
    lineIndex: number;
    line: string;
    hash: string;
  };
  const suspects: Suspect[] = [];
  for (let e = 0; e < edits.length; e++) {
    const edit = edits[e]!;
    for (let i = 0; i < edit.lines.length; i++) {
      const line = edit.lines[i]!;
      const match = line.match(HASHLINE_BARE_PREFIX_RE);
      if (match) {
        suspects.push({ editIndex: e, lineIndex: i, line, hash: match[1]! });
      }
    }
  }
  if (suspects.length === 0) return [];

  // Compute the file's public checksum set (single letter per line, derived
  // from the internal FNV-1a hash). This is the set the model can actually
  // see in read output.
  const filePublicSet = new Set(
    fileLines.map((_, i) =>
      publicChecksumFromHash(computeLineHash(fileLines, i)),
    ),
  );
  const matchCount = suspects.filter(({ hash }) =>
    filePublicSet.has(hash),
  ).length;

  // Confidence gate: at least ONE hash must match a real public
  // checksum in the file. Without a single match, the lines are
  // almost certainly legitimate content (e.g. a markdown table or
  // text block using `│` as a separator) rather than accidentally-
  // pasted read output. False negatives here (model pasted a
  // different file's read output) are recoverable with a re-read;
  // false positives are silent data loss. The previous
  // `|| suspects.length >= 2` fallback was over-engineering for an
  // edge case and has been removed.
  if (matchCount === 0) return [];

  // Strip the prefix from each suspect line. Drop the whole match
  // (leading whitespace + 3-char hash + │ separator) so the resulting
  // line is the bare file content. If the line had intentional leading
  // indent, `restoreIndent` (later in the pipeline) will re-add it.
  const stripped: Array<{
    editIndex: number;
    lineIndex: number;
    original: string;
    stripped: string;
  }> = [];
  for (const s of suspects) {
    const original = edits[s.editIndex]!.lines[s.lineIndex]!;
    const strippedLine = original.replace(HASHLINE_BARE_PREFIX_RE, "");
    // Only mutate if the replacement actually changed something
    if (strippedLine !== original) {
      edits[s.editIndex]!.lines[s.lineIndex] = strippedLine;
      stripped.push({
        editIndex: s.editIndex,
        lineIndex: s.lineIndex,
        original,
        stripped: strippedLine,
      });
    }
  }

  // One brief reminder for the whole strip event (not one per line).
  if (stripped.length > 0) {
    const matchHint =
      matchCount > 0 ? ` (${matchCount} matched real line checksums)` : "";
    warnings.push(
      `[W_BARE_HASH_PREFIX_STRIPPED] stripped bare hashline prefix from ${stripped.length} line(s) in edit content${matchHint} — looks like text copied from read output. Send "lines" as raw file content next time.`,
    );
  }

  return stripped;
}

type ResolvedEditSpan = {
  index: number;
  label: string;
  start: number;
  end: number;
  replacement: string;
};

type LineIndex = {
  fileLines: string[];
  lineStarts: number[];
};

function buildLineIndex(content: string): LineIndex {
  const fileLines = content.split("\n");
  const lineStarts: number[] = [];
  let offset = 0;

  for (let index = 0; index < fileLines.length; index++) {
    lineStarts.push(offset);
    offset += fileLines[index]?.length ?? 0;
    if (index < fileLines.length - 1) {
      offset += 1;
    }
  }

  return { fileLines, lineStarts };
}

function _previewText(text: string): string {
  const compact = text.replaceAll("\n", "\\n");
  return compact.length > 32 ? `${compact.slice(0, 29)}...` : compact;
}

function describeEdit(edit: HashlineEdit): string {
  return edit.end
    ? `replace ${edit.pos.line}${ANCHOR_SEP}${edit.pos.hash}-${edit.end.line}${ANCHOR_SEP}${edit.end.hash}`
    : `replace ${edit.pos.line}${ANCHOR_SEP}${edit.pos.hash}`;
}

function throwEditConflict(
  left: { index: number; label: string },
  right: { index: number; label: string },
  reason: string,
): never {
  throw new Error(
    formatError(
      "E_EDIT_CONFLICT",
      `Conflicting edits in a single request: edit ${left.index} (${left.label}) and edit ${right.index} (${right.label}) ${reason}. Merge them into one non-overlapping change or split the request.`,
    ),
  );
}

function cloneHashlineEdit(edit: HashlineEdit): HashlineEdit {
  return {
    op: "replace",
    pos: { ...edit.pos },
    ...(edit.end ? { end: { ...edit.end } } : {}),
    lines: [...edit.lines],
  };
}

function resolveEditToSpan(
  edit: HashlineEdit,
  index: number,
  content: string,
  lineIndex: LineIndex,
  noopEdits: NoopEdit[],
): ResolvedEditSpan | null {
  const { fileLines, lineStarts } = lineIndex;

  const startLine = edit.pos.line;
  const endLine = edit.end?.line ?? edit.pos.line;
  const originalLines = fileLines.slice(startLine - 1, endLine);
  if (
    originalLines.length === edit.lines.length &&
    originalLines.every((line, lineIndex) => line === edit.lines[lineIndex])
  ) {
    noopEdits.push({
      editIndex: index,
      loc: `${edit.pos.line}${ANCHOR_SEP}${edit.pos.hash}`,
      currentContent: originalLines.join("\n"),
    });
    return null;
  }

  if (edit.lines.length > 0) {
    return {
      index,
      label: describeEdit(edit),
      start: lineStarts[startLine - 1]!,
      end: lineStarts[endLine - 1]! + (fileLines[endLine - 1]?.length ?? 0),
      replacement: edit.lines.join("\n"),
    };
  }

  if (startLine === 1 && endLine === fileLines.length) {
    return {
      index,
      label: describeEdit(edit),
      start: 0,
      end: content.length,
      replacement: "",
    };
  }

  if (endLine < fileLines.length) {
    return {
      index,
      label: describeEdit(edit),
      start: lineStarts[startLine - 1]!,
      end: lineStarts[endLine]!,
      replacement: "",
    };
  }

  return {
    index,
    label: describeEdit(edit),
    start: Math.max(0, lineStarts[startLine - 1]! - 1),
    end: lineStarts[endLine - 1]! + (fileLines[endLine - 1]?.length ?? 0),
    replacement: "",
  };
}

function assertNoConflictingSpans(spans: ResolvedEditSpan[]): void {
  for (let leftIndex = 0; leftIndex < spans.length; leftIndex++) {
    const left = spans[leftIndex]!;
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < spans.length;
      rightIndex++
    ) {
      const right = spans[rightIndex]!;
      if (left.start < right.end && right.start < left.end) {
        throwEditConflict(
          left,
          right,
          "overlap on the same original line range",
        );
      }
    }
  }
}

export function applyHashlineEdits(
  content: string,
  edits: HashlineEdit[],
  signal?: AbortSignal,
): {
  content: string;
  firstChangedLine: number | undefined;
  lastChangedLine: number | undefined;
  warnings?: string[];
  noopEdits?: NoopEdit[];
} {
  throwIfAborted(signal);
  if (!edits.length)
    return { content, firstChangedLine: undefined, lastChangedLine: undefined };

  const workingEdits = edits.map(cloneHashlineEdit);
  const lineIndex = buildLineIndex(content);
  const noopEdits: NoopEdit[] = [];
  const warnings: string[] = [];

  const mismatches: HashMismatch[] = [];
  const retryLines = new Set<number>();
  function validate(ref: Anchor): boolean {
    if (ref.line < 1 || ref.line > lineIndex.fileLines.length) {
      // API contract: prefer the more specific E_LINE_OUT_OF_RANGE
      // message from edit-anchor.ts where possible.
      throw new Error(
        formatError(
          "E_LINE_OUT_OF_RANGE",
          `Line ${ref.line} is past the end of the file (file has ${lineIndex.fileLines.length} line${lineIndex.fileLines.length === 1 ? "" : "s"}).`,
        ),
      );
    }
    const actual = computeLineHash(lineIndex.fileLines, ref.line - 1);
    if (actual === ref.hash) return true;
    mismatches.push({ line: ref.line, expected: ref.hash, actual });
    retryLines.add(ref.line);
    return false;
  }

  for (const edit of workingEdits) {
    throwIfAborted(signal);
    if (edit.end) {
      if (edit.pos.line > edit.end.line) {
        throw new Error(
          formatError(
            "E_BAD_RANGE",
            `Range start line ${edit.pos.line} must be <= end line ${edit.end.line}`,
          ),
        );
      }
      const startOk = validate(edit.pos);
      const endOk = validate(edit.end);
      if (!startOk && endOk) {
        retryLines.add(edit.end.line);
      }
      if (startOk && !endOk) {
        retryLines.add(edit.pos.line);
      }
      if (!startOk || !endOk) continue;
    } else if (!validate(edit.pos)) {
      continue;
    }
    const startLine = edit.pos.line;
    const endLine = edit.end?.line ?? edit.pos.line;

    // Check both boundaries for duplication
    const checkBoundary = (
      candidate: string | undefined,
      boundary: string | undefined,
      label: string,
    ) => {
      if (!candidate || !boundary) return;
      const c = candidate.trim();
      const b = boundary.trim();
      if (c && /[\p{L}\p{N}]/u.test(c) && c === b) {
        warnings.push(
          `[W_BOUNDARY_DUP] The replacement ${label === "after" ? "ends with a line that already exists on the next line" : "starts with a line that already exists on the preceding line"} of the file (after trimming whitespace). This may duplicate content — verify the result.`,
        );
      }
    };
    checkBoundary(edit.lines.at(-1), lineIndex.fileLines[endLine], "after");
    if (startLine > 1)
      checkBoundary(
        edit.lines[0],
        lineIndex.fileLines[startLine - 2],
        "before",
      );
  }
  if (mismatches.length) {
    throw new Error(
      formatMismatchError(mismatches, lineIndex.fileLines, retryLines),
    );
  }

  // Duplicate target detection: warn when multiple edits target the same anchor
  const posKeys = new Map<string, number[]>();
  for (let i = 0; i < workingEdits.length; i++) {
    const edit = workingEdits[i]!;
    if (edit.op === "replace_text") continue;
    const key = `${edit.pos.line}${ANCHOR_SEP}${edit.pos.hash}`;
    if (!posKeys.has(key)) posKeys.set(key, []);
    posKeys.get(key)?.push(i);
  }
  for (const [key, indices] of posKeys) {
    if (indices.length > 1) {
      warnings.push(
        `Edits ${indices.map((i) => i + 1).join(", ")} target the same line range (${key}). This can cause conflicts if their replacements differ — merge them into a single edit.`,
      );
    }
  }

  maybeWarnSuspiciousUnicodeEscapePlaceholder(workingEdits, warnings);
  stripBareHashPrefixes(workingEdits, lineIndex.fileLines, warnings);

  const seenSpanKeys = new Set<string>();
  const resolvedSpans: ResolvedEditSpan[] = [];
  for (const [index, edit] of workingEdits.entries()) {
    throwIfAborted(signal);
    const span = resolveEditToSpan(edit, index, content, lineIndex, noopEdits);
    if (!span) {
      continue;
    }

    const spanKey = `replace:${span.start}:${span.end}:${span.replacement}`;
    if (seenSpanKeys.has(spanKey)) {
      continue;
    }
    seenSpanKeys.add(spanKey);
    resolvedSpans.push(span);
  }

  assertNoConflictingSpans(resolvedSpans);

  const orderedSpans = [...resolvedSpans].sort((left, right) => {
    if (right.end !== left.end) {
      return right.end - left.end;
    }
    return left.index - right.index;
  });

  let result = content;
  for (const span of orderedSpans) {
    throwIfAborted(signal);
    result =
      result.slice(0, span.start) + span.replacement + result.slice(span.end);
  }

  const changedRange = computeChangedLineRange(content, result);
  return {
    content: result,
    firstChangedLine: changedRange?.firstChangedLine,
    lastChangedLine: changedRange?.lastChangedLine,
    ...(warnings.length ? { warnings } : {}),
    ...(noopEdits.length ? { noopEdits } : {}),
  };
}

// ─── Affected-line computation (for returning anchors after edit) ───────

const ANCHOR_CONTEXT_LINES = 2;
const ANCHOR_MAX_OUTPUT_LINES = 12;

/**
 * Compute the post-edit line range covering changed lines plus context.
 * Uses `firstChangedLine` and `lastChangedLine` from the edit result for
 * precise bounds. Returns null if the range (with context) exceeds the
 * output budget, signalling that the LLM should re-read instead.
 */
export function computeAffectedLineRange(params: {
  firstChangedLine: number | undefined;
  lastChangedLine: number | undefined;
  resultLineCount: number;
  contextLines?: number;
  maxOutputLines?: number;
}): { start: number; end: number } | null {
  const {
    firstChangedLine,
    lastChangedLine,
    resultLineCount,
    contextLines = ANCHOR_CONTEXT_LINES,
    maxOutputLines = ANCHOR_MAX_OUTPUT_LINES,
  } = params;

  if (firstChangedLine === undefined || lastChangedLine === undefined) {
    return null;
  }

  // Empty file after edit: no meaningful anchor block.
  if (resultLineCount === 0) {
    return null;
  }

  const start = Math.max(1, firstChangedLine - contextLines);
  const end = Math.min(resultLineCount, lastChangedLine + contextLines);

  // Guard against inverted range (can happen when context pushes end below start).
  if (end < start) {
    return null;
  }

  if (end - start + 1 > maxOutputLines) {
    return null;
  }

  return { start, end };
}

export function formatHashlineRegion(
  fileLines: string[],
  startLine: number,
  endLine: number,
): string {
  const lineNumberWidth = String(endLine).length;
  return fileLines
    .slice(startLine - 1, endLine)
    .map((line, index) => {
      const lineNumber = startLine + index;
      const paddedLineNumber = String(lineNumber).padStart(
        lineNumberWidth,
        " ",
      );
      return `${paddedLineNumber}${ANCHOR_SEP}${computeLineHash(fileLines, startLine - 1 + index)}${CONTENT_SEP}${line}`;
    })
    .join("\n");
}

// ─── Edit line range computation ────────────────────────────────────────

/**
 * Compute first/last changed line numbers from the edit result.
 * Uses character-level diff to locate the changed span, then maps to line
 * numbers in the result document so downstream anchor chaining works.
 */
function computeChangedLineRange(
  original: string,
  result: string,
): { firstChangedLine: number; lastChangedLine: number } | null {
  if (original === result) return null;

  function countVisibleLines(text: string): number {
    if (text.length === 0) {
      return 0;
    }
    const lines = text.split("\n");
    return text.endsWith("\n") ? lines.length - 1 : lines.length;
  }

  if (original.length === 0) {
    return {
      firstChangedLine: 1,
      lastChangedLine: countVisibleLines(result),
    };
  }

  if (result.startsWith(original) && original.endsWith("\n")) {
    return {
      firstChangedLine: countVisibleLines(original) + 1,
      lastChangedLine: countVisibleLines(result),
    };
  }

  let firstDiff = 0;
  const minLen = Math.min(original.length, result.length);
  while (firstDiff < minLen && original[firstDiff] === result[firstDiff]) {
    firstDiff++;
  }
  if (firstDiff === minLen && original.length === result.length) return null;

  let lastOrig = original.length - 1;
  let lastRes = result.length - 1;
  while (
    lastOrig >= firstDiff &&
    lastRes >= firstDiff &&
    original[lastOrig] === result[lastRes]
  ) {
    lastOrig--;
    lastRes--;
  }

  function indexToLine(charIdx: number, text: string): number {
    let line = 1;
    for (let i = 0; i < charIdx && i < text.length; i++) {
      if (text[i] === "\n") line++;
    }
    return line;
  }

  const firstChangedLine = indexToLine(firstDiff + 1, result);
  let lastChangedLine: number;
  if (lastRes < firstDiff) {
    lastChangedLine = result.length === 0 ? 1 : countVisibleLines(result);
  } else if (
    firstDiff === 0 &&
    original.length > 0 &&
    result.endsWith(original)
  ) {
    lastChangedLine = firstChangedLine;
  } else {
    lastChangedLine = indexToLine(lastRes + 1, result);
  }

  return { firstChangedLine, lastChangedLine };
}
