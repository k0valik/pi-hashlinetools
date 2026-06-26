/**
 * Byte-level recovery for hashline edits.
 *
 * Operating on an in-memory `Buffer` rather than reading from disk,
 * this is the "strong tier" strategy in the medley: when fuzzy + hash-index
 * + byte-level text-line strategies all fail, we try byte-level full-buffer
 * matching with relaxed strategies.
 *
 * Three matching strategies, in priority order:
 *   1. exact         — needle bytes match raw file bytes
 *   2. lf-normalized / crlf-normalized — encoding conversion
 *   3. trimmed       — trim trailing whitespace from each line
 *
 * Returns the recovered text (with the new bytes spliced in) and the
 * strategy used. On failure, returns the reason.
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

export type TryRecoveryArgs = {
  rawBuffer: Buffer;
  oldText: string;
  newText: string;
};

export type TryRecoveryResult =
  | {
      success: true;
      recoveredText: string;
      strategy: string;
      /** The actual bytes in the file that matched `oldText` (may differ
       *  from `oldText` when a non-exact strategy like `lf-normalized` or
       *  `trimmed` was used). Used to render a hex preview in the
       *  `W_AUTO_RECOVERY` warning so the model can confirm the matched
       *  region. */
      actualOldBytes: Buffer;
      /** Byte offset in the file where the match starts. */
      matchPosition: number;
    }
  | { success: false; reason: string };

/** Find all occurrences of `needle` bytes in `haystack` bytes. */
function findAllOccurrences(haystack: Buffer, needle: Buffer): number[] {
  // Empty-needle guard: Buffer.indexOf with an empty needle matches at
  // every position, which would cause O(n) wasted iterations and
  // produce a spurious "unique match at every byte" result.
  if (needle.length === 0) return [];
  const indices: number[] = [];
  let i = 0;
  while (i < haystack.length) {
    const idx = haystack.indexOf(needle, i);
    if (idx === -1) break;
    indices.push(idx);
    i = idx + 1;
  }
  return indices;
}

/** Check if a character at `pos` in `haystack` is trailing whitespace
 *  (only spaces/tabs until newline or EOF). Used by the trimmed-match
 *  walk to decide whether to skip a whitespace byte. */
function isTrailingWhitespace(haystack: Buffer, pos: number): boolean {
  for (let i = pos; i < haystack.length; i++) {
    const b = haystack[i];
    if (b === 0x0a || b === 0x0d) return true; // \n or \r
    if (b !== 0x20 && b !== 0x09) return false; // not space or tab
  }
  return true; // end of file: all remaining bytes are trailing
}

/** Find a unique match for `needle` in `haystack` using relaxed strategies. */
function findInBuffer(
  haystack: Buffer,
  needle: string,
):
  | { position: number; actualOldBytes: Buffer; strategy: string }
  | { ambiguous: true; strategy: string }
  | null {
  // Pass 1: exact byte match
  const needleBytes = Buffer.from(needle, "utf-8");
  const exact = findAllOccurrences(haystack, needleBytes);
  if (exact.length === 1) {
    const pos = exact[0];
    if (pos === undefined) return null;
    return {
      position: pos,
      actualOldBytes: needleBytes,
      strategy: "exact",
    };
  }
  if (exact.length > 1) {
    return { ambiguous: true, strategy: "exact" };
  }

  // Pass 2: try LF/CRLF encoding variants
  const variants: Array<{ bytes: Buffer; label: string }> = [];
  const lfOnly = needle.replaceAll("\r", "");
  if (lfOnly !== needle) {
    variants.push({
      bytes: Buffer.from(lfOnly, "utf-8"),
      label: "lf-normalized",
    });
  }
  const crlf = needle.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n");
  if (crlf !== needle && crlf !== lfOnly) {
    variants.push({
      bytes: Buffer.from(crlf, "utf-8"),
      label: "crlf-normalized",
    });
  }
  for (const variant of variants) {
    const positions = findAllOccurrences(haystack, variant.bytes);
    if (positions.length === 1) {
      const pos = positions[0];
      if (pos === undefined) continue;
      return {
        position: pos,
        actualOldBytes: variant.bytes,
        strategy: variant.label,
      };
    }
    if (positions.length > 1) {
      return { ambiguous: true, strategy: variant.label };
    }
  }

  // Pass 3: trimmed — the file may have trailing whitespace the model
  // didn't include. Trim the FILE and search.
  const haystackText = haystack.toString("utf-8");
  const haystackLines = haystackText.replaceAll("\r", "").split("\n");
  const trimmedHaystack = haystackLines.map((l) => l.trimEnd()).join("\n");
  const trimmedIdx = trimmedHaystack.indexOf(lfOnly);
  if (trimmedIdx === -1) return null;
  // Verify uniqueness
  const secondIdx = trimmedHaystack.indexOf(lfOnly, trimmedIdx + 1);
  if (secondIdx !== -1) {
    return { ambiguous: true, strategy: "trimmed" };
  }
  // Walk through the original buffer to find the corresponding byte position
  // (the trimmed view dropped some characters). Only skip whitespace if
  // it is trailing (followed only by other spaces/tabs and a newline or EOF).
  let origPos = 0;
  let trimPos = 0;
  while (trimPos < trimmedIdx && origPos < haystack.length) {
    const origByte = haystack[origPos];
    if (origByte === undefined) break;
    const origChar = String.fromCharCode(origByte);
    if (origChar === "\r") {
      origPos++;
      continue;
    }
    if (origChar === " " || origChar === "\t") {
      if (isTrailingWhitespace(haystack, origPos)) {
        origPos++;
        continue;
      }
      // Internal/leading whitespace: don't skip, fall through to character match.
    }
    if (trimmedHaystack[trimPos] === origChar) {
      trimPos++;
    }
    origPos++;
  }
  // Extract the actual bytes at origPos
  const actualBytes = extractBytesForNeedle(haystack, origPos, lfOnly);
  if (actualBytes) {
    return {
      position: origPos,
      actualOldBytes: actualBytes,
      strategy: "trimmed",
    };
  }
  return null;
}

/** Extract the actual bytes in `haystack` at `startPos` that correspond
 *  to `needle` (which may have different whitespace/encoding). */
function extractBytesForNeedle(
  haystack: Buffer,
  startPos: number,
  needle: string,
): Buffer | null {
  const needleLines = needle.split("\n");
  let bytePos = startPos;
  const chunks: Buffer[] = [];
  for (let i = 0; i < needleLines.length; i++) {
    const isLastLine = i === needleLines.length - 1;
    const targetLine = needleLines[i] ?? "";
    let matched = 0;
    const lineStart = bytePos;
    while (matched < targetLine.length && bytePos < haystack.length) {
      const byte = haystack[bytePos];
      if (byte === undefined) break;
      const ch = String.fromCharCode(byte);
      if (ch === "\n" || ch === "\r") break;
      if (ch === targetLine[matched]) {
        matched++;
        bytePos++;
      } else if (ch === " " || ch === "\t") {
        bytePos++; // skip trailing whitespace
      } else {
        return null;
      }
    }
    if (matched < targetLine.length) return null;
    // Absorb trailing whitespace and the newline (only if more lines follow)
    if (!isLastLine) {
      while (bytePos < haystack.length) {
        const byte = haystack[bytePos];
        if (byte === undefined) break;
        const ch = String.fromCharCode(byte);
        if (ch === "\n") {
          bytePos++;
          break;
        }
        if (ch === "\r") {
          bytePos++;
          if (bytePos < haystack.length && haystack[bytePos] === 0x0a)
            bytePos++;
          break;
        }
        if (ch === " " || ch === "\t") {
          bytePos++;
        } else {
          break;
        }
      }
    }
    chunks.push(haystack.subarray(lineStart, bytePos));
  }
  return Buffer.concat(chunks);
}

/** Try byte-level recovery. Returns the new full file content on success. */
export function tryRecovery(args: TryRecoveryArgs): TryRecoveryResult {
  const { rawBuffer, oldText, newText } = args;
  if (!oldText || oldText.length === 0) {
    return { success: false, reason: "oldText is empty" };
  }
  if (rawBuffer.length === 0) {
    return { success: false, reason: "file is empty" };
  }
  const found = findInBuffer(rawBuffer, oldText);
  if (!found) {
    return {
      success: false,
      reason:
        "oldText not found in file (tried exact, LF-normalized, and trimmed matching)",
    };
  }
  if ("ambiguous" in found) {
    return {
      success: false,
      reason: `oldText occurs multiple times (ambiguous, ${found.strategy} match)`,
    };
  }
  const newBytes = Buffer.from(newText, "utf-8");
  const newBuffer = Buffer.concat([
    rawBuffer.subarray(0, found.position),
    newBytes,
    rawBuffer.subarray(found.position + found.actualOldBytes.length),
  ]);
  return {
    success: true,
    recoveredText: newBuffer.toString("utf-8"),
    strategy: found.strategy,
    actualOldBytes: found.actualOldBytes,
    matchPosition: found.position,
  };
}

/** Count non-overlapping occurrences of `needle` in `haystack`. Empty
 *  needle returns 0. Used by the `replace_text` error path to report
 *  "appears N times" with concrete line numbers. */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while (true) {
    const found = haystack.indexOf(needle, idx);
    if (found === -1) break;
    count++;
    idx = found + needle.length;
  }
  return count;
}

/** Return the 1-based line numbers where the first `max` occurrences of
 *  `needle` start in `haystack`. Returns [] for an empty needle or no
 *  match. Truncated to `max` entries (default 5) to keep error messages
 *  bounded. */
export function locateOccurrenceLines(
  content: string,
  needle: string,
  max = 5,
): number[] {
  if (needle.length === 0) return [];
  const lines: number[] = [];
  let idx = 0;
  let line = 1;
  while (lines.length < max) {
    const found = content.indexOf(needle, idx);
    if (found === -1) break;
    // Count newlines in content[idx..found) to get the 1-based line number.
    for (let i = idx; i < found; i++) {
      if (content.charCodeAt(i) === 10) line++;
    }
    lines.push(line);
    // Count newlines WITHIN the matched needle too, so a multi-line needle
    // like "a\nb" advances the line counter for the next match. Without this,
    // a multi-line needle reports every subsequent match at the wrong 1-based
    // line number (off by the number of newlines in the previous match).
    for (let i = found; i < found + needle.length; i++) {
      if (content.charCodeAt(i) === 10) line++;
    }
    idx = found + needle.length;
  }
  return lines;
}

/** Find lines whose content partially matches `needle`, for the 0-match
 *  `replace_text` error path. Returns up to `max` (default 3) line
 *  numbers, sorted by best-score-first, where the score is the length of
 *  the longest common whitespace-normalized substring between the line
 *  and the needle (case-insensitive). This is the most common model
 *  failure mode: the model wrote `oldText` with slightly different
 *  whitespace, quotes, or escape sequences. Telling it "not found" with
 *  no hint is the worst possible error — give the model something to
 *  act on.
 *
 *  Algorithm: O(n * L) where n = number of lines, L = max(needle, line)
 *  length. Score = longest common substring of normalized(line) and
 *  normalized(needle), capped at 1024 chars. Lines with score below
 *  `minScore` (a floor that filters coincidental single-character
 *  matches) are dropped. The DP buffers are allocated once and reused
 *  per call to avoid GC pressure on large files. */
export function findClosestPartialMatches(
  content: string,
  needle: string,
  max = 3,
): number[] {
  if (needle.length === 0 || content.length === 0) return [];
  const needleNorm = normalizeForFuzzy(needle);
  if (needleNorm.length === 0) return [];
  const lines = content.split("\n");
  const scored: Array<{ line: number; score: number }> = [];
  // Allocate the DP buffers ONCE for the whole file, not per line.
  const bufLen = needleNorm.length > 1024 ? 1024 : needleNorm.length;
  const prev = new Uint32Array(bufLen + 1);
  const curr = new Uint32Array(bufLen + 1);
  // Require a minimum score to filter out coincidental single-character
  // overlaps. Without this floor, almost any line in a realistic file
  // shares at least one character with the needle and gets reported as
  // a "closest partial match" — surfacing unrelated noise. The floor
  // caps at needle length so a 2-char needle still has a sensible
  // threshold.
  const minScore = Math.min(4, needleNorm.length);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNorm = normalizeForFuzzy(line);
    if (lineNorm.length === 0) continue;
    // Length precheck: longestCommonSubstringLength cannot return a
    // score greater than the shorter input. Skip the DP work if the
    // line is too short to ever meet minScore.
    if (Math.min(lineNorm.length, needleNorm.length) < minScore) continue;
    const score = longestCommonSubstringLength(
      lineNorm,
      needleNorm,
      prev,
      curr,
    );
    if (score < minScore) continue;
    scored.push({ line: i + 1, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max).map((s) => s.line);
}

/** Normalize a string for fuzzy comparison: collapse internal whitespace
 *  runs, lowercase, and trim. The normalization is intentionally
 *  lossy: it strips leading/trailing whitespace, collapses runs of
 *  internal whitespace to a single space, and lowercases. This makes
 *  common "off-by-one" model errors (extra/missing spaces, wrong case)
 *  detectable. */
function normalizeForFuzzy(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Longest common substring length. Naive O(n*m) DP with two rolling
 *  rows — fine for line-sized inputs (line and needle are both < ~10k
 *  chars in practice). Buffers are passed in by the caller so they can
 *  be reused across many calls in a single file scan (avoids GC
 *  pressure on large files). */
function longestCommonSubstringLength(
  a: string,
  b: string,
  prev: Uint32Array,
  curr: Uint32Array,
): number {
  if (a.length === 0 || b.length === 0) return 0;
  // Cap input size to keep this bounded; beyond 1024 chars the
  // substring-length signal is noise anyway.
  const A = a.length > 1024 ? a.slice(0, 1024) : a;
  const B = b.length > 1024 ? b.slice(0, 1024) : b;
  // Reset the buffers (the caller is expected to allocate them at the
  // max size we need: b.length+1, capped at 1024+1).
  prev.fill(0);
  curr.fill(0);
  let best = 0;
  for (let i = 1; i <= A.length; i++) {
    for (let j = 1; j <= B.length; j++) {
      curr[j] = A[i - 1] === B[j - 1] ? prev[j - 1] + 1 : 0;
      if (curr[j]! > best) best = curr[j]!;
    }
    // Swap prev/curr and clear the new "curr" for the next row. The
    // swap uses a row local `tmp` to avoid an extra allocation.
    const tmp = prev;
    prev = curr;
    curr = tmp;
    curr.fill(0);
  }
  return best;
}

/**
 * Render the first `n` bytes of `buf` as a hex string with byte-level
 * spacing (e.g. `6c 69 6e 65 31 20 0a 6c 69 6e 65 32 0a`). Used by the
 * `W_AUTO_RECOVERY` warning to give the model a way to verify the
 * matched region without leaking internal strategy names.
 *
 * Caps at `n` bytes; shorter buffers are rendered in full.
 */
export function formatBytesHex(buf: Buffer, n = 16): string {
  const len = Math.min(n, buf.length);
  const parts: string[] = [];
  for (let i = 0; i < len; i++) {
    const byte = buf[i];
    if (byte === undefined) break;
    parts.push(byte.toString(16).padStart(2, "0"));
  }
  return parts.join(" ");
}

/**
 * Return the first 16 hex characters of the SHA-256 of `buf`. Used by
 * the `replace_text` 0-match and N-match error paths to give the model
 * a short fingerprint it can compare to its own read of the file.
 * Truncated to 16 chars (8 bytes) to keep the error message bounded.
 */
export function shortFileHash(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex").slice(0, 16);
}
