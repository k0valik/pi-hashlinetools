import { constants, readFileSync } from "node:fs";
import { access as fsAccess, stat as fsStat, readFile } from "node:fs/promises";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { isRecord } from "./types";
import { Type } from "@sinclair/typebox";
import { isAutoReadEnabled } from "./auto-read-state";
import {
  anchorBareLineNumberEdits,
  type EditBehaviorOptions,
} from "./edit-anchor";
import {
  detectLineEnding,
  generateDiffString,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from "./edit-diff";
import { type DryRunResult, tryDryRun } from "./edit-dry-run";
import { formatError } from "./edit-errors";
import { normalizeEditPayload } from "./edit-payload-normalize";
import {
  countOccurrences,
  findClosestPartialMatches,
  formatBytesHex,
  locateOccurrenceLines,
  shortFileHash,
  tryRecovery,
} from "./edit-recovery";
import { buildChangedResponse, buildNoopResponse } from "./edit-response";
import { loadFileKindAndText } from "./file-kind";
import { resolveMutationTargetPath, writeFileAtomically } from "./fs-write";
import { CONTENT_SEP, type HashlineToolEdit } from "./hashline";
import { formatPublicLineRef, getVisibleLineCount } from "./line-ref";
import { resolveToCwd } from "./path-utils";
import { throwIfAborted } from "./runtime";
import { getFileSnapshot } from "./snapshot";
import { getLastEdit, setLastEdit } from "./undo";

/** Sanitize a string for inclusion in a user-facing error/warning message.
 *  Replaces embedded control characters (CR, LF, TAB, etc.) with their
 *  JSON-style escape sequences so the message renders cleanly regardless
 *  of how the terminal displays the surrounding text.
 *  Truncates to 80 chars with an ellipsis to keep messages bounded.
 *
 *  Truncation is done on the ESCAPED string and backtracks to an escape
 *  sequence boundary if the cut would land mid-escape (e.g. a trailing
 *  `\\` or partial `\\u00` would otherwise corrupt the rendered message).
 *  The output is always at most `maxLen + 1` characters (the +1 is the
 *  ellipsis).  */
function sanitizeForMessage(value: string, maxLen = 80): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(
      // biome-ignore lint/suspicious/noControlCharactersInRegex: must match the remaining ASCII control chars
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
  if (escaped.length <= maxLen) return escaped;
  // Cut at maxLen, then backtrack if we landed mid-escape so the
  // result never ends with a partial `\uXXXX` or a lone `\`.
  let cut = maxLen;
  // Partial \u<0-4 hex digits> at the end: backtrack the matched length.
  const tail = escaped.slice(Math.max(0, cut - 5), cut);
  const m = tail.match(/\\u[0-9a-fA-F]{0,4}$/);
  if (m) {
    cut -= m[0].length;
  } else {
    // Trailing `\` (odd count of trailing backslashes) means a partial
    // `\\`, `\r`, `\n`, or `\t` escape: backtrack 1.
    let trailing = 0;
    while (cut - trailing > 0 && escaped[cut - 1 - trailing] === "\\")
      trailing++;
    if (trailing % 2 === 1) cut -= 1;
  }
  return `${escaped.slice(0, cut)}…`;
}

/**
 *  per-edit prefilter for partial-apply. The dry-run's
 * `anchorBareLineNumberEdits` call throws on the first failing edit,
 * which causes the whole batch to be marked failed. We prefilter here
 * so the dry-run sees only the valid subset, and we collect the
 * per-edit error messages for the failed edits.
 */
function partitionByAnchorSuccess(
  edits: HashlineToolEdit[],
  fileContent: string,
  options: EditBehaviorOptions,
  rawBuffer: Buffer,
): { valid: HashlineToolEdit[]; errors: string[] } {
  const valid: HashlineToolEdit[] = [];
  const errors: string[] = [];
  for (const edit of edits) {
    try {
      // Defensive clone: anchorBareLineNumberEdits currently doesn't
      // mutate the input, but it builds an internal normalized copy
      // (see its `const edit = { ...rawEdit, lines: ... }` line). The
      // clone here makes the read-only contract explicit and protects
      // against future internal changes.
      const editClone: HashlineToolEdit = { ...edit };
      anchorBareLineNumberEdits(
        [editClone],
        fileContent,
        options,
        [],
        rawBuffer,
      );
      valid.push(edit);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(msg);
    }
  }
  return { valid, errors };
}

// Content hint after `│` is optional. Bare refs like "42#Xy0" are accepted
// (and the orchestrator warns + uses current file state for that line).
// Full refs like "42#Xy0│const value = 1;" are still preferred for accuracy.
const FULL_ENDPOINT_REF_PATTERN = String.raw`^\s*[>+\-]*\s*\d+(?:#[A-Za-z0-9_\-]{3}|[A-Za-z0-9_\-]{3}|[0-9a-fA-F]{2}|[a-z]|#[0-9A-F]{2})(?:\s*[│|].*)?\s*$`;

function makeEditEntrySchema() {
  return Type.Object(
    {
      range: Type.Optional(
        Type.Array(
          Type.String({ minLength: 1, pattern: FULL_ENDPOINT_REF_PATTERN }),
          {
            minItems: 2,
            maxItems: 2,
            description: `Inclusive line range [start, end] for replace ops. Use full checked endpoint lines copied from recent read or diff output, e.g. ["42Xy0│const value = 1;", "44Z9k│}"]. Required for replace ops; omit for append/prepend/replace_text.`,
          },
        ),
      ),
      lines: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "New content lines for replace/append/prepend ops. Use [] to delete (replace only).",
        }),
      ),
      // P4 (edit): `op` is REQUIRED. The old default-to-replace
      // behavior let the model send `{pos: ..., lines: [...]}` thinking
      // it was `append`, get implicit `replace`, and choke on the unknown
      // `pos` field with a confusing downstream error. With required
      // `op`, AJV rejects the call at the host boundary with a clear
      // "missing required field: op" message.
      op: Type.Union(
        [
          Type.Literal("replace"),
          Type.Literal("append"),
          Type.Literal("prepend"),
          Type.Literal("replace_text"),
        ],
        {
          description:
            "Operation type. Required per-edit. 'append' inserts after pos, 'prepend' inserts before pos, 'replace_text' does exact-unique substring replacement.",
        },
      ),
      pos: Type.Optional(
        Type.String({
          minLength: 1,
          pattern: FULL_ENDPOINT_REF_PATTERN,
          description:
            "Anchor line for append/prepend ops. Uses full checked endpoint line from read output. Omit for BOF/EOF insertion.",
        }),
      ),
      oldText: Type.Optional(
        Type.String({
          minLength: 1,
          description:
            "replace_text only: exact substring to find. Must appear exactly once in the file.",
        }),
      ),
      newText: Type.Optional(
        Type.String({
          description:
            "replace_text only: replacement substring. Empty string deletes the match.",
        }),
      ),
    },
    { additionalProperties: true },
  );
}

export const hashlineEditToolSchema = Type.Object(
  {
    path: Type.String({
      description: "Absolute or relative path to the file to edit",
    }),

    // multi-edit + dry-run design. The dry-run previews the batch; the model can chain via post-edit anchors.
    edits: Type.Array(makeEditEntrySchema(), {
      minItems: 1,
      description: `One or more edit entries. Each entry's op is required (replace, append, prepend, or replace_text); see the per-field descriptions for required fields.`,
    }),
  },
  { additionalProperties: false },
);

type EditRequestParams = {
  path: string;
  edits: Record<string, unknown>[];
};

type EditMetrics = {
  edits_attempted: number;
  edits_noop: number;
  warnings: number;
  classification: "applied" | "noop";
  added_lines?: number;
  removed_lines?: number;
};

type HashlineEditToolDetails = {
  diff: string;
  snapshotId?: string;
  classification?: "noop";
  metrics?: EditMetrics;
  package: { name: string; version: string };
};

const EDIT_DESC = readFileSync(
  new URL("../tool-descriptions/edit.md", import.meta.url),
  "utf-8",
).trim();

const EDIT_PROMPT_SNIPPET = readFileSync(
  new URL("../tool-descriptions/edit-snippet.md", import.meta.url),
  "utf-8",
).trim();
const DEFAULT_MAX_EDITS_PER_CALL = 5;

function enforceEditCountLimit(
  _edits: Record<string, unknown>[],
  _maxEditsPerCall: number | undefined,
): void {
  // Limit removed — multi-edit failures are handled by the auto-re-read
  // retry loop.  Large batches may naturally produce warnings but no
  // longer produce hard errors.
}

// Safety net for environments where AJV validation is disabled.
// Field-type and schema validation are AJV's responsibility;
// only prevent crashes from missing required top-level fields.
// Path existence is checked in execute() once CWD is available.
export function assertEditRequest(
  request: unknown,
  options: { maxEditsPerCall?: number } = {},
): asserts request is EditRequestParams {
  if (!isRecord(request)) {
    throw new Error(
      formatError("E_INVALID_REQUEST", "Edit request must be an object."),
    );
  }
  if (typeof request.path !== "string" || request.path.length === 0) {
    throw new Error(
      formatError(
        "E_INVALID_REQUEST",
        'Edit request requires a non-empty "path" string.',
      ),
    );
  }
  if (!Array.isArray(request.edits) || request.edits.length === 0) {
    throw new Error(
      formatError(
        "E_INVALID_REQUEST",
        'Edit request requires a non-empty "edits" array.',
      ),
    );
  }
  enforceEditCountLimit(
    request.edits as Record<string, unknown>[],
    options.maxEditsPerCall,
  );
}

export function normalizeEditItems(
  edits: Record<string, unknown>[],
): HashlineToolEdit[] {
  return edits.map((edit, index) => {
    const op = (edit.op as string) || "replace";
    switch (op) {
      case "replace_text":
        return {
          op: "replace_text",
          pos: "",
          oldText: (edit.oldText as string) || "",
          newText: (edit.newText as string) || "",
        };
      case "append":
      case "prepend":
        return {
          op,
          pos: (edit.pos as string) || "",
          lines: (edit.lines as string[]) || [],
        };
      default: {
        if (op !== "replace") {
          throw new Error(
            formatError(
              "E_UNSUPPORTED_OP",
              `Edit ${index}: unsupported op "${String(op)}". Use "replace", "append", "prepend", or "replace_text".`,
            ),
          );
        }
        const [pos, end] =
          Array.isArray(edit.range) && edit.range.length >= 2
            ? (edit.range as [string, string])
            : ["", undefined];
        return {
          op: "replace",
          pos,
          end: end || undefined,
          lines: (edit.lines as string[]) || [],
        };
      }
    }
  });
}

/**
 * Build fresh hashline anchor refs around the changed region so the model can
 * chain subsequent edits without re-reading the file.
 */
function buildPostEditAnchors(
  content: string,
  firstChangedLine: number | undefined,
  lastChangedLine: number | undefined,
  originalLineCount?: number,
  replacementLineCount?: number,
): string | undefined {
  if (firstChangedLine === undefined || lastChangedLine === undefined)
    return undefined;
  const lines = content.split("\n");
  const ctx = 4; // context lines above and below the changed region
  const start = Math.max(1, firstChangedLine - ctx);
  // Use visible line count (excludes trailing empty line from \n-terminated files)
  const visibleLines = getVisibleLineCount(content);
  const end = Math.min(visibleLines, lastChangedLine + ctx);
  const refs: string[] = [
    "Post-edit anchors (use for subsequent edits to avoid re-reading):",
  ];
  // Add summary if line count changed
  if (
    originalLineCount !== undefined &&
    replacementLineCount !== undefined &&
    originalLineCount !== replacementLineCount
  ) {
    const delta = replacementLineCount - originalLineCount;
    const summary =
      delta > 0
        ? `  [${delta} line${delta !== 1 ? "s" : ""} inserted. To undo, use \`undo\` or re-edit the range.]`
        : `  [${Math.abs(delta)} line${Math.abs(delta) !== 1 ? "s" : ""} removed. To undo, use \`undo\` or re-edit the range.]`;
    refs.push(summary);
  }
  for (let i = start; i <= end; i++) {
    // Compact format: ref only, no line content. The content is already
    // visible in the diff and the model's prior read output.
    refs.push(`  ${formatPublicLineRef(lines, i)}${CONTENT_SEP}`);
  }
  return refs.join("\n");
}

type EditTargetResult =
  | { ok: false; error: string; code?: string }
  | {
      ok: true;
      normalized: string;
      rawBuffer: Buffer;
      bom: string;
      ending: "\r\n" | "\n";
      mtimeMs: number;
    };

async function resolveEditTarget(
  absolutePath: string,
  path: string,
  accessMode: number,
): Promise<EditTargetResult> {
  try {
    await fsAccess(absolutePath, accessMode);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: false, error: `File not found: ${path}` };
    }
    if (code === "EACCES" || code === "EPERM") {
      const action = accessMode & constants.W_OK ? "writable" : "readable";
      return { ok: false, error: `File is not ${action}: ${path}` };
    }
    return { ok: false, error: `Cannot access file: ${path}` };
  }

  const file = await loadFileKindAndText(absolutePath);
  if (file.kind === "directory") {
    return {
      ok: false,
      error: `Path is a directory: ${path}. Use ls to inspect directories.`,
    };
  }
  if (file.kind === "image") {
    return {
      ok: false,
      error: `Path is an image file: ${path}. Hashline edit only supports text files.`,
    };
  }
  if (file.kind === "binary") {
    return {
      ok: false,
      error: `Path is a binary file: ${path} (${file.description}). Hashline edit only supports text files.`,
    };
  }

  const { bom, text: content } = stripBom(file.text);
  const normalized = normalizeToLF(content);
  if (normalized.length === 0) {
    return {
      ok: false,
      code: "E_EMPTY_FILE",
      error: `File is empty: ${path}. The edit tool requires an existing line reference from read output; use the write tool to create initial content in an empty file.`,
    };
  }

  const rawBuffer = await readFile(absolutePath);
  const fileStat = await fsStat(absolutePath);

  return {
    ok: true,
    normalized,
    rawBuffer,
    bom,
    ending: detectLineEnding(content),
    mtimeMs: fileStat.mtimeMs,
  };
}

type EditPreview = { diff: string } | { error: string };
type EditRenderState = {
  argsKey?: string;
  preview?: EditPreview;
  previewGeneration?: number;
};

function getRenderablePreviewInput(args: unknown): EditRequestParams | null {
  if (!isRecord(args) || typeof args.path !== "string") {
    return null;
  }

  const request: EditRequestParams = {
    path: args.path,
    edits: Array.isArray(args.edits) ? args.edits : [],
  };
  return request.edits.length > 0 ? request : null;
}

function colorDiffLines(
  lines: string[],
  theme: { fg: (token: any, text: string) => string },
): string[] {
  return lines.map((line) => {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      return theme.fg("success", line);
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      return theme.fg("error", line);
    }
    return theme.fg("dim", line);
  });
}
function formatPreviewDiff(
  diff: string,
  expanded: boolean,
  theme: { fg: (token: any, text: string) => string },
): string {
  const lines = diff.split("\n");
  const maxLines = expanded ? 40 : 16;
  const shown = colorDiffLines(lines.slice(0, maxLines), theme);

  if (lines.length > maxLines) {
    shown.push(
      theme.fg("muted", `... ${lines.length - maxLines} more diff lines`),
    );
  }
  return shown.join("\n");
}

function getRenderedEditTextContent(result: {
  content?: Array<{ type: string; text?: string }>;
}): string | undefined {
  const textContent = result.content?.find(
    (entry): entry is { type: "text"; text: string } =>
      entry.type === "text" && typeof entry.text === "string",
  );
  return textContent?.text;
}

function isAppliedChangedResult(
  details: HashlineEditToolDetails | undefined,
): boolean {
  const metrics = details?.metrics;
  return (
    metrics?.classification === "applied" &&
    metrics.added_lines !== undefined &&
    metrics.removed_lines !== undefined
  );
}

function buildAppliedChangedResultText(
  text: string | undefined,
  details: HashlineEditToolDetails | undefined,
  preview: EditPreview | undefined,
  expanded: boolean,
  theme: { fg: (token: any, text: string) => string },
): string | undefined {
  const previewDiff =
    preview && !("error" in preview) ? preview.diff : undefined;
  const sections: string[] = [];

  // Result-side diff: respects the caller's `expanded` flag. Mirrors
  // formatPreviewDiff's behaviour but with no upper bound in expanded mode
  // (the call preview is bounded at 40, the result is bounded only by
  // user intent).
  if (details?.diff && details.diff !== previewDiff) {
    const diffLines = details.diff.split("\n");
    const maxLines = expanded ? Infinity : 16;
    const shown = colorDiffLines(diffLines.slice(0, maxLines), theme);
    const diffText = shown.join("\n");

    if (diffLines.length > maxLines) {
      sections.push(
        diffText +
          `\n${theme.fg("muted", `... ${diffLines.length - maxLines} more diff lines`)}`,
      );
    } else {
      sections.push(diffText);
    }
  }

  // Change summary line: "X insertions(+), Y deletion(-)" sits between the
  // diff and the warnings, styled with the accent token. added_lines and
  // removed_lines are populated by edit-response.ts from the apply step.
  if (details?.metrics?.added_lines !== undefined) {
    const added = details.metrics.added_lines ?? 0;
    const removed = details.metrics.removed_lines ?? 0;
    const parts: string[] = [];
    if (added) parts.push(`${added} insertion${added !== 1 ? "s" : ""}(+)`);
    if (removed)
      parts.push(`${removed} deletion${removed !== 1 ? "s" : ""}(-)`);
    if (parts.length) {
      sections.push(theme.fg("accent", parts.join(", ")));
    }
  }

  const warnings = text
    ?.match(/(?:^|\n\n)Warnings:\n[\s\S]*$/)?.[0]
    ?.trimStart();
  if (warnings) sections.push(warnings);

  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

function formatEditCall(
  args: EditRequestParams | undefined,
  state: EditRenderState,
  expanded: boolean,
  theme: {
    bold: (text: string) => string;
    fg: (token: any, text: string) => string;
  },
): string {
  const path = args?.path;
  const pathDisplay =
    typeof path === "string" && path.length > 0
      ? theme.fg("accent", path)
      : theme.fg("toolOutput", "...");
  let text = `${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`;

  if (!state.preview) {
    return text;
  }

  if ("error" in state.preview) {
    text += `\n\n${theme.fg("error", state.preview.error)}`;
    return text;
  }

  if (state.preview.diff) {
    text += `\n\n${formatPreviewDiff(state.preview.diff, expanded, theme)}`;
  }
  return text;
}

/**
 * Apply replace_text edits: exact-unique substring replacement.
 * Operates on normalized content before hashline edits are applied.
 *
 * When normalized-text search fails, falls back to byte-level matching
 * (via `tryRecovery`) which supports LF/CRLF normalization and
 * trailing-whitespace tolerance. Emits `W_AUTO_RECOVERY` /
 * `W_AUTO_RECOVERY_FAILED` warnings into the optional `warnings` array.
 */
export function applyReplaceTextEdits(
  content: string,
  edits: HashlineToolEdit[],
  path: string,
  rawBuffer?: Buffer,
  warnings?: string[],
): string {
  let result = content;
  for (const edit of edits) {
    const oldText = edit.oldText ?? "";
    const newText = edit.newText ?? "";
    if (!oldText) {
      throw new Error(
        formatError(
          "E_REPLACE_TEXT_MISSING",
          "replace_text requires a non-empty oldText.",
        ),
      );
    }
    // indexOf correctly matches across newlines — no single-line restriction needed.

    // The CRLF recovery test (replace-text.rigorous.test.ts) uses a
    // multi-line oldText with CRLF to test the LF/CRLF normalization
    // path; that test must continue to work. If we want to add a
    // multi-line reject in the future, it should be a separate flag
    // (e.g. opt-in via "singleLine": true on the edit) rather than
    // blanket-rejecting any newlines.
    // Count exact occurrences
    let count = 0;
    let pos = -1;
    let idx = 0;
    while (true) {
      idx = result.indexOf(oldText, idx);
      if (idx === -1) break;
      count++;
      pos = idx;
      idx += oldText.length;
    }
    if (count === 0) {
      // Backslash-escape normalization: the model may have written
      // `\"` in JSON producing bare `"` in the decoded string, while
      // the file has literal `\"` (0x5C 0x22).  Try both directions.
      // Try backslash-escape variants.  If any variant matches uniquely,
      // apply it and skip the byte-level fallback for the original oldText.
      let backslashMatched = false;
      const backslashAdded = oldText.replace(/(?<!\\)"/g, '\\"');
      const backslashStripped = oldText.replace(/\\"/g, '"');
      const backslashVariants: string[] = [];
      if (backslashAdded !== oldText) backslashVariants.push(backslashAdded);
      if (backslashStripped !== oldText && backslashStripped !== backslashAdded)
        backslashVariants.push(backslashStripped);

      for (const variant of backslashVariants) {
        let vCount = 0;
        let vPos = -1;
        let vidx = 0;
        while (true) {
          vidx = result.indexOf(variant, vidx);
          if (vidx === -1) break;
          vCount++;
          vPos = vidx;
          vidx += variant.length;
        }
        if (vCount === 1) {
          result =
            result.slice(0, vPos) +
            newText +
            result.slice(vPos + variant.length);
          if (rawBuffer) rawBuffer = Buffer.from(result, "utf-8");
          backslashMatched = true;
          break;
        }
        if (vCount > 1) {
          const vMatchLines = locateOccurrenceLines(result, variant);
          throw new Error(
            formatError(
              "E_REPLACE_TEXT_NOT_UNIQUE",
              `"${sanitizeForMessage(variant)}" occurs ${vCount} times in ${path}. replace_text requires an exact unique match.`,
              vMatchLines.length > 0
                ? `Match locations: lines ${vMatchLines.join(", ")}${vCount > vMatchLines.length ? ` (showing first ${vMatchLines.length} of ${vCount})` : ""}.`
                : undefined,
            ),
          );
        }
        // vCount === 0: try byte-level fallback for this variant too
        if (rawBuffer) {
          const variantBytes = Buffer.from(variant, "utf-8");
          let byteCount = 0;
          let bytePos = -1;
          let bi = 0;
          while (true) {
            bi = rawBuffer.indexOf(variantBytes, bi);
            if (bi === -1) break;
            byteCount++;
            bytePos = bi;
            bi += variantBytes.length;
          }
          if (byteCount === 1) {
            const edited = Buffer.concat([
              rawBuffer.subarray(0, bytePos),
              Buffer.from(newText, "utf-8"),
              rawBuffer.subarray(bytePos + variantBytes.length),
            ]);
            const decoded = edited.toString("utf-8");
            const { text: stripped } = stripBom(decoded);
            result = normalizeToLF(stripped);
            rawBuffer = Buffer.from(result, "utf-8");
            backslashMatched = true;
            break;
          }
          if (byteCount > 1) {
            const vByteLines = locateOccurrenceLines(result, variant);
            throw new Error(
              formatError(
                "E_REPLACE_TEXT_NOT_UNIQUE",
                `"${sanitizeForMessage(variant)}" occurs ${byteCount} times in ${path}. replace_text requires an exact unique match.`,
                vByteLines.length > 0
                  ? `Match locations: lines ${vByteLines.join(", ")}${byteCount > vByteLines.length ? ` (showing first ${vByteLines.length} of ${byteCount})` : ""}.`
                  : undefined,
              ),
            );
          }
        }
      }

      if (backslashMatched) continue; // skip to next edit

      // Byte-level recovery: search raw file bytes when normalized text
      // search fails (e.g. encoding quirks, non-UTF-8 round-trip, trailing
      // whitespace differences). `tryRecovery` is the shared byte-level
      // fallback (exact → LF/CRLF → trimmed) and emits the W_AUTO_RECOVERY
      // warning on success.
      if (rawBuffer) {
        const recovery = tryRecovery({ rawBuffer, oldText, newText });
        if (recovery.success) {
          const { text: stripped } = stripBom(recovery.recoveredText);
          result = normalizeToLF(stripped);
          rawBuffer = Buffer.from(result, "utf-8");
          // The W_AUTO_RECOVERY warning tells the model a non-exact match
          // succeeded. Avoid leaking the internal recovery strategy name
          // (e.g. "exact", "lf-normalized", "crlf-normalized", "trimmed")
          // and the "byte-level" pipeline term; describe the user-visible
          // effect instead. (User-facing UX cleanup.)
          //
          // include a hex preview of the first 16 bytes of the
          // matched region so the model can verify "yes, this is the
          // line I meant" without needing to re-read the file. The
          // strategy name stays hidden; the bytes are visible.
          const matchedHex = formatBytesHex(recovery.actualOldBytes);
          warnings?.push(
            `[W_AUTO_RECOVERY] replace_text: matched "${sanitizeForMessage(oldText)}" in ${path} after applying whitespace/line-ending tolerance. hex: ${matchedHex}. Verify the diff matches your intent.`,
          );
          continue;
        }
        if (recovery.reason.includes("ambiguous")) {
          warnings?.push(
            `[W_AUTO_RECOVERY_FAILED] replace_text: "${sanitizeForMessage(oldText)}" matches multiple times in ${path} even after whitespace/line-ending tolerance. Use the replace op with a range for multi-occurrence changes.`,
          );
          throw new Error(
            formatError(
              "E_REPLACE_TEXT_NOT_UNIQUE",
              `"${sanitizeForMessage(oldText)}" occurs multiple times in ${path}. replace_text requires an exact unique match. Use the replace op with a range for multi-occurrence changes.`,
            ),
          );
        }
        // Recovery failed: fall through to the not-found error.
      }
      // 0-match: give the model a hint about which lines are closest
      // to its oldText (whitespace- and case-insensitive LCS). The
      // intent is to surface lines that might be a near-match after
      // small edits so the model can refine its oldText.
      //
      // also include a short file SHA-256 (when rawBuffer is
      // available) so the model can confirm "yes, the file I'm
      // looking at matches what the tool saw." This is the most
      // common reason for a stale read: a 0-match that's not a
      // whitespace issue but a "my view of the file is out of date"
      // issue. (pi-robust-edit's `findInBuffer` error path does the
      // same thing.)
      const partialLines = findClosestPartialMatches(result, oldText);
      const notFoundContextLines =
        partialLines.length > 0
          ? `Closest partial matches (whitespace/case-insensitive): lines ${partialLines.join(", ")}.`
          : "Check the exact spelling and whitespace.";
      const notFoundFileHash = rawBuffer
        ? `File SHA-256: ${shortFileHash(rawBuffer)} (your read tool's view of this file should match).`
        : null;
      const notFoundContext = notFoundFileHash
        ? `${notFoundFileHash}\n${notFoundContextLines}`
        : notFoundContextLines;
      throw new Error(
        formatError(
          "E_REPLACE_TEXT_NOT_FOUND",
          `"${sanitizeForMessage(oldText)}" not found in ${path}.`,
          notFoundContext,
        ),
      );
    }
    if (count > 1) {
      const matchLines = locateOccurrenceLines(result, oldText);
      const notUniqueContextLines =
        matchLines.length > 0
          ? `Match locations: lines ${matchLines.join(", ")}${count > matchLines.length ? ` (showing first ${matchLines.length} of ${count})` : ""}.`
          : undefined;
      const notUniqueFileHash = rawBuffer
        ? `File SHA-256: ${shortFileHash(rawBuffer)} (your read tool's view of this file should match).`
        : undefined;
      const notUniqueContext =
        notUniqueFileHash && notUniqueContextLines
          ? `${notUniqueFileHash}\n${notUniqueContextLines}`
          : (notUniqueFileHash ?? notUniqueContextLines);
      throw new Error(
        formatError(
          "E_REPLACE_TEXT_NOT_UNIQUE",
          `"${sanitizeForMessage(oldText)}" occurs ${count} times in ${path}. replace_text requires an exact unique match. Use the replace op with a range for multi-occurrence changes.`,
          notUniqueContext,
        ),
      );
    }
    result =
      result.slice(0, pos) + newText + result.slice(pos + oldText.length);
    if (rawBuffer) rawBuffer = Buffer.from(result, "utf-8");
  }
  return result;
}

export async function computeEditPreview(
  request: unknown,
  cwd: string,
  options: EditBehaviorOptions = {
    maxEditsPerCall: DEFAULT_MAX_EDITS_PER_CALL,
  },
): Promise<EditPreview> {
  try {
    assertEditRequest(request, options);
  } catch (error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  const params = request as EditRequestParams;
  const path = params.path;
  const absolutePath = resolveToCwd(path, cwd);
  const toolEdits = normalizeEditItems(params.edits);

  const target = await resolveEditTarget(absolutePath, path, constants.R_OK);
  if (!target.ok) {
    return { error: target.error };
  }
  const { normalized: originalNormalized, rawBuffer } = target;

  try {
    // Separate replace_text edits from hashline edits
    const replaceTextEdits = toolEdits.filter((e) => e.op === "replace_text");
    const hashlineEdits = toolEdits.filter((e) => e.op !== "replace_text");

    // Recovery warnings (W_AUTO_RECOVERY) from applyReplaceTextEdits go here.
    // Preview doesn't surface them, but the array needs to exist for the call.
    const warnings: string[] = [];

    const textContent = applyReplaceTextEdits(
      originalNormalized,
      replaceTextEdits,
      path,
      rawBuffer,
      warnings,
    );

    const updatedRawBuffer =
      textContent === originalNormalized
        ? rawBuffer
        : Buffer.from(textContent, "utf-8");

    // Use the dry-run for consistency with edit.execute, but report the
    // error (rather than returning wouldBeNoop) when any edit fails — the
    // preview is for showing the user what the edit will look like, and
    // silently producing an "identical content" diff for a failed edit
    // would be confusing.
    let dryRun: ReturnType<typeof tryDryRun>;
    try {
      dryRun = tryDryRun({
        fileContent: textContent,
        fileLines: textContent.split("\n"),
        visibleLineCount: getVisibleLineCount(textContent),
        edits: hashlineEdits,
        rawBuffer: updatedRawBuffer,
        options,
      });
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (
      dryRun.perEdit.some(
        (e) => e.outcome === "failed" || e.outcome === "ambiguous",
      ) ||
      dryRun.conflicts.length > 0
    ) {
      const reason =
        dryRun.conflicts[0]?.reason ??
        dryRun.warnings.find((w) => w.startsWith("[")) ??
        "Edit would fail";
      return { error: reason };
    }
    const result = dryRun.wouldApply;

    if (originalNormalized === result) {
      return {
        error: `No changes made to ${path}. The edits produced identical content.`,
      };
    }

    return { diff: generateDiffString(originalNormalized, result).diff };
  } catch (error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

type EditToolDefinition = ToolDefinition<
  typeof hashlineEditToolSchema,
  HashlineEditToolDetails,
  EditRenderState
> & { renderShell?: "default" | "self" };

function makeEditToolDefinition(args: {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  behavior: EditBehaviorOptions;
}): EditToolDefinition {
  return {
    name: args.name,
    label: args.label,
    description: args.description,
    parameters: hashlineEditToolSchema,
    promptSnippet: args.promptSnippet,
    // Force the default tool shell (Box with pending/success/error background) so
    // we don't inherit renderShell: "self" from the built-in edit tool of the
    // same name, which would drop the shared background color block.
    renderShell: "default",
    renderCall(callArgs, theme, context) {
      const previewInput = getRenderablePreviewInput(callArgs);
      if (context.executionStarted) {
        context.state.argsKey = undefined;
        context.state.preview = undefined;
        context.state.previewGeneration =
          (context.state.previewGeneration ?? 0) + 1;
      } else if (!context.argsComplete || !previewInput) {
        context.state.argsKey = undefined;
        context.state.preview = undefined;
        context.state.previewGeneration =
          (context.state.previewGeneration ?? 0) + 1;
      } else {
        const argsKey = JSON.stringify(previewInput);
        if (context.state.argsKey !== argsKey) {
          context.state.argsKey = argsKey;
          context.state.preview = undefined;
          const previewGeneration = (context.state.previewGeneration ?? 0) + 1;
          context.state.previewGeneration = previewGeneration;
          computeEditPreview(previewInput, context.cwd, args.behavior)
            .then((preview) => {
              if (
                context.state.argsKey === argsKey &&
                context.state.previewGeneration === previewGeneration
              ) {
                context.state.preview = preview;
                context.invalidate();
              }
            })
            .catch((err: unknown) => {
              if (
                context.state.argsKey === argsKey &&
                context.state.previewGeneration === previewGeneration
              ) {
                context.state.preview = {
                  error: err instanceof Error ? err.message : String(err),
                };
                context.invalidate();
              }
            });
        }
      }
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(
        formatEditCall(
          getRenderablePreviewInput(callArgs) ?? undefined,
          context.state as EditRenderState,
          context.expanded,
          theme,
        ),
      );
      return text;
    },

    renderResult(result, { isPartial }, theme, context) {
      if (isPartial) {
        const text =
          (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        text.setText(theme.fg("warning", "Editing..."));
        return text;
      }

      const typedResult = result as {
        content?: Array<{ type: string; text?: string }>;
        details?: HashlineEditToolDetails;
      };
      const renderedText = getRenderedEditTextContent(typedResult);

      const renderState = context.state as EditRenderState | undefined;
      const previewBeforeResult = renderState?.preview;
      if (renderState) {
        renderState.preview = undefined;
        renderState.previewGeneration =
          (renderState.previewGeneration ?? 0) + 1;
      }

      if (context.isError) {
        if (!renderedText) {
          return new Text("", 0, 0);
        }
        const text =
          context.lastComponent instanceof Text
            ? context.lastComponent
            : new Text("", 0, 0);
        text.setText(`\n${theme.fg("error", renderedText)}`);
        return text;
      }

      if (isAppliedChangedResult(typedResult.details)) {
        const appliedChangedText = buildAppliedChangedResultText(
          renderedText,
          typedResult.details,
          previewBeforeResult,
          context.expanded,
          theme,
        );
        if (!appliedChangedText) {
          return new Text("", 0, 0);
        }
        const text =
          context.lastComponent instanceof Text
            ? context.lastComponent
            : new Text("", 0, 0);
        text.setText(appliedChangedText);
        return text;
      }

      if (!renderedText) {
        return new Text("", 0, 0);
      }

      const text =
        context.lastComponent instanceof Text
          ? context.lastComponent
          : new Text("", 0, 0);
      text.setText(renderedText);
      return text;
    },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      assertEditRequest(params, args.behavior);

      const path = (params as EditRequestParams).path;
      const absolutePath = resolveToCwd(path, ctx.cwd);
      const toolEdits = normalizeEditItems((params as EditRequestParams).edits);

      const mutationTargetPath = await resolveMutationTargetPath(absolutePath);
      return withFileMutationQueue(mutationTargetPath, async () => {
        throwIfAborted(signal);
        const target = await resolveEditTarget(
          absolutePath,
          path,
          constants.R_OK | constants.W_OK,
        );
        if (!target.ok) {
          const prefix = target.code ? `[${target.code}] ` : "";
          throw new Error(`${prefix}${target.error}`);
        }
        let {
          bom,
          normalized: originalNormalized,
          ending: originalEnding,
          rawBuffer,
          mtimeMs: originalMtimeMs,
        } = target;

        // Separate replace_text edits from hashline edits
        const replaceTextEdits = toolEdits.filter(
          (e) => e.op === "replace_text",
        );
        const hashlineEdits = toolEdits.filter((e) => e.op !== "replace_text");

        // Declare the warnings array early so applyReplaceTextEdits (and
        // the consecutive-edit re-read branch) can append W_AUTO_RECOVERY
        // warnings into it. We merge it with the anchor-resolution warnings
        // and heuristic warnings below.
        const warnings: string[] = [];

        let textContent = applyReplaceTextEdits(
          originalNormalized,
          replaceTextEdits,
          path,
          rawBuffer,
          warnings,
        );

        let updatedRawBuffer =
          textContent === originalNormalized
            ? rawBuffer
            : Buffer.from(textContent, "utf-8");

        // Consecutive-edit auto-re-read: if editing the same file as the last
        // edit, re-read from disk to ensure anchor resolution uses fresh content.
        const lastEditEntry = getLastEdit();
        if (lastEditEntry?.path === path) {
          const freshTarget = await resolveEditTarget(
            absolutePath,
            path,
            constants.R_OK | constants.W_OK,
          );
          if (!freshTarget.ok) {
            const prefix = freshTarget.code ? `[${freshTarget.code}] ` : "";
            throw new Error(`${prefix}${freshTarget.error}`);
          }
          originalNormalized = freshTarget.normalized;
          textContent = applyReplaceTextEdits(
            originalNormalized,
            replaceTextEdits,
            path,
            freshTarget.rawBuffer,
            warnings,
          );
          updatedRawBuffer =
            textContent === originalNormalized
              ? freshTarget.rawBuffer
              : Buffer.from(textContent, "utf-8");
        }

        // ── Payload normalization  ──
        // Soft auto-fix pass: detect common model payload mistakes
        // (display prefixes pasted into `lines`, anchor-line echoed
        // as first/last replacement line, missing indent, wide-range
        // replace that should be an insert), fix them, and emit W_*
        // warnings. Runs AFTER applyReplaceTextEdits + consecutive
        // re-read so the file content is freshest when resolving
        // anchors. Runs BEFORE the heuristic warning pass and the
        // dry-run so the normalized edits are what get checked and
        // applied. See docs/plan-pr1-payload-normalize.md.
        const fileLinesForNormalize = textContent.split("\n");
        const { edits: normalizedEdits, warnings: normalizeWarnings } =
          normalizeEditPayload(toolEdits, fileLinesForNormalize);
        warnings.push(...normalizeWarnings);
        // Recompute hashlineEdits from the normalized output. The
        // normalized edits may have changed op (e.g. range-replace
        // → prepend) so the filter result may differ from before.
        const normalizedHashlineEdits = normalizedEdits.filter(
          (e) => e.op !== "replace_text",
        );

        // ── Dry-run through the medley, then commit ──
        // The new flow (steps 4-5 of the plan): run tryDryRun (which composes
        // the medley and the apply in-memory) once. If the dry-run fails for
        // any edit, the whole batch is refused with per-edit evidence.
        //
        // The dry-run uses the fresh bytes we already have. We also check
        // the file's mtime before commit and re-run if it changed (catches
        // external mutations between our read and our write).
        const runDryRun = (edits = normalizedHashlineEdits): DryRunResult =>
          tryDryRun({
            fileContent: textContent,
            fileLines: textContent.split("\n"),
            visibleLineCount: getVisibleLineCount(textContent),
            edits,
            rawBuffer: updatedRawBuffer,
            options: args.behavior,
          });

        let dryRun = runDryRun();

        // Merge warnings from the dry-run (anchor resolution warnings,
        // E_LINE_CHANGED / E_LINE_OUT_OF_RANGE / E_RELOCATE_AMBIGUOUS
        // messages, etc.) into the shared warnings array BEFORE the
        // refused check, so they appear in both the refused-noop
        // response and the success response.
        warnings.push(...dryRun.warnings);

        //  partial-apply, no count, drop
        // the "X/Y applied cleanly" framing. When some edits fail and
        // others succeed (no batch-level conflict), the successful ones
        // apply and the failed ones emit their per-edit error. The whole
        // batch is NOT refused wholesale.
        //
        // Implementation: prefilter the edits to identify which ones
        // have valid anchors. The dry-run itself is all-or-nothing for
        // anchor resolution (the first failing edit poisons the whole
        // batch), so we identify valid edits up front and re-run the
        // dry-run on the valid subset.
        //
        // The partition function calls anchorBareLineNumberEdits with
        // a single edit, so each edit's anchor is resolved in isolation.
        // This is a small redundancy (the dry-run re-anchors the valid
        // subset), but it's the cleanest way to get per-edit error info.
        const partition = partitionByAnchorSuccess(
          normalizedHashlineEdits,
          textContent,
          args.behavior,
          updatedRawBuffer,
        );
        if (partition.errors.length > 0 && partition.valid.length > 0) {
          // Some failed, some succeeded → partial-apply.
          // Surface the per-edit errors to the model. De-dupe against
          // `warnings` (which already contains the initial dry-run
          // warnings, possibly including the same per-edit errors as
          // [E_*] blocks). Without this filter, a single edit's error
          // would surface twice.
          //
          const alreadyWarned = new Set(warnings);
          for (const errMsg of partition.errors) {
            if (!alreadyWarned.has(errMsg)) {
              warnings.push(errMsg);
            }
          }
          dryRun = runDryRun(partition.valid);

          // the valid subset generates its own warnings (relocation,
          // hash relocate, stale context for the applied edits).
          // Merge them into the shared `warnings` array so the model
          // gets a brief reminder for the silent fixes. Dedup against
          // the initial dry-run's warnings (already in `warnings`) to
          // avoid double-reporting the same relocation.
          const seenForValid = new Set(warnings);
          for (const w of dryRun.warnings) {
            if (!seenForValid.has(w)) {
              warnings.push(w);
              seenForValid.add(w);
            }
          }
        } else if (partition.errors.length > 0) {
          // All edits failed anchor resolution. The initial dry-run
          // (runDryRun() above) only captures the first failing edit's
          // error in its warnings — if multiple edits fail with
          // different errors, the model only sees one. Override
          // dryRun.warnings with the full partition.errors list so the
          // model sees every per-edit failure. Dedup against existing
          // warnings to avoid double-reporting the same error (the
          // dry-run's first-failing-edit error is already in `warnings`
          // from the earlier merge).
          //
          const allFailedSeen = new Set(warnings);
          for (const errMsg of partition.errors) {
            if (!allFailedSeen.has(errMsg)) {
              warnings.push(errMsg);
              allFailedSeen.add(errMsg);
            }
          }
        }
        // Conflicts (E_EDIT_CONFLICT — overlapping ranges) still refuse
        // the batch: the dry-run catches the conflict in the apply-try-
        // catch block and records it in `conflicts[]`, but does not mark
        // any perEdit as failed (the anchor resolution succeeded; the
        // apply just rejected the batch). Partial-apply for overlapping
        // edits is out of scope — too complex, and the model genuinely
        // needs to disambiguate before retrying.
        //
        // The conflicts-only check is critical: without it, a conflict
        // would fall through to the success path and produce a misleading
        // "identical content" noop.
        //
        //  only real E_EDIT_CONFLICT (overlapping ranges) refuses
        // the batch. The dry-run records a "fake" conflict for any apply
        // error with editA === editB === 0; we discriminate by looking at
        // the conflict reason for the `[E_EDIT_CONFLICT]` code prefix.
        const hasConflict = dryRun.conflicts.some((c) =>
          c.reason?.startsWith("[E_EDIT_CONFLICT]"),
        );
        if (hasConflict) {
          warnings.push(
            `[E_EDIT_REFUSED] The edit batch was refused: two edits in this batch target overlapping lines — merge them into a single edit or split the batch, or use op: "replace_text" with the full old content of the overlapping region. Read the file again to get the current line numbers and retry.`,
          );
          const noopSnapshotId = (await getFileSnapshot(absolutePath))
            .snapshotId;
          return buildNoopResponse({
            path,
            noopEdits: dryRun.noopEdits,
            originalNormalized,
            snapshotId: noopSnapshotId,
            editsAttempted: toolEdits.length,
            warnings,
          });
        }

        const result = dryRun.wouldApply;
        // (dryRun.warnings were already merged before the refused check above.)
        const originalLineCount =
          originalNormalized.split("\n").length -
          (originalNormalized.endsWith("\n") ? 1 : 0);
        if (result.length === 0 && originalLineCount > 50) {
          throw new Error(
            formatError(
              "E_WOULD_EMPTY",
              "This edit would delete the entire file. The edit tool does not allow full-file deletion for files with more than 50 lines. If you truly intend to clear the file, use the write tool to overwrite it with an empty string.",
            ),
          );
        }
        const noopEdits = dryRun.noopEdits;
        const editsAttempted = toolEdits.length;

        // mtime check: if the file changed between our read and our write,
        // another process (or parallel tool call) modified it. Re-read once
        // and re-run the dry-run. If still applied, commit. If not, refuse.
        {
          let currentStat: Awaited<ReturnType<typeof fsStat>>;
          try {
            currentStat = await fsStat(absolutePath);
          } catch {
            currentStat = undefined as unknown as Awaited<
              ReturnType<typeof fsStat>
            >;
          }
          if (currentStat && currentStat.mtimeMs !== originalMtimeMs) {
            // API contract: avoid "mtime" (a Unix stat term), avoid
            // "dry-run" (internal pipeline stage), and avoid leaking the
            // numeric mtime values. The model just needs to know the
            // file changed on disk and we're retrying once.
            warnings.push(
              `[W_FILE_CHANGED_SINCE_READ] ${path} was modified on disk after we read it. Re-reading and retrying the edit once.`,
            );
            const fresh = await resolveEditTarget(
              absolutePath,
              path,
              constants.R_OK | constants.W_OK,
            );
            if (!fresh.ok) {
              const prefix = fresh.code ? `[${fresh.code}] ` : "";
              throw new Error(`${prefix}${fresh.error}`);
            }
            originalNormalized = fresh.normalized;
            textContent = applyReplaceTextEdits(
              originalNormalized,
              replaceTextEdits,
              path,
              fresh.rawBuffer,
              warnings,
            );
            updatedRawBuffer =
              textContent === originalNormalized
                ? fresh.rawBuffer
                : Buffer.from(textContent, "utf-8");
            // Re-run the dry-run against the fresh state. The closure
            // captures textContent/updatedRawBuffer by reference.
            dryRun = runDryRun();
            // Merge the new dry-run warnings (anchor resolution evidence).
            warnings.push(...dryRun.warnings);
            //  only real conflicts refuse the batch on retry.
            // Per-edit failures → partial-apply (already handled above).
            const stillHasRealConflict = dryRun.conflicts.some((c) =>
              c.reason?.startsWith("[E_EDIT_CONFLICT]"),
            );
            if (stillHasRealConflict) {
              warnings.push(
                `[E_EDIT_REFUSED] After re-reading, the edit batch was still refused: two edits in this batch target overlapping lines — merge them into a single edit or split the batch, or use op: "replace_text" with the full old content of the overlapping region. Read the file again to get the current line numbers and retry.`,
              );
              const noopSnapshotId = (await getFileSnapshot(absolutePath))
                .snapshotId;
              return buildNoopResponse({
                path,
                noopEdits: dryRun.noopEdits,
                originalNormalized,
                snapshotId: noopSnapshotId,
                editsAttempted: toolEdits.length,
                warnings,
              });
            }
            // Replace the result with the new dry-run output.
            return buildChangedResponse({
              path,
              originalNormalized,
              result: dryRun.wouldApply,
              warnings,
              snapshotId: (await getFileSnapshot(absolutePath)).snapshotId,
              editsAttempted,
              noopEditsCount: dryRun.noopEdits.length,
              postEditAnchors:
                hashlineEdits.length <= 1 || !isAutoReadEnabled()
                  ? undefined
                  : buildPostEditAnchors(
                      dryRun.wouldApply,
                      dryRun.firstChangedLine,
                      dryRun.lastChangedLine,
                      originalNormalized.split("\n").length -
                        (originalNormalized.endsWith("\n") ? 1 : 0),
                      getVisibleLineCount(dryRun.wouldApply),
                    ),
            });
          }
        }

        if (originalNormalized === result) {
          const noopSnapshotId = (await getFileSnapshot(absolutePath))
            .snapshotId;
          return buildNoopResponse({
            path,
            noopEdits,
            originalNormalized,
            snapshotId: noopSnapshotId,
            editsAttempted,
            warnings,
          });
        }
        setLastEdit({ path, previousContent: originalNormalized });
        throwIfAborted(signal);
        const intendedContent =
          bom + restoreLineEndings(result, originalEnding);
        await writeFileAtomically(absolutePath, intendedContent);

        // Post-edit verification: read back and compare byte-for-byte
        if (args.behavior.postEditVerify !== false) {
          throwIfAborted(signal);
          const actualContent = await readFile(absolutePath, "utf8");
          if (actualContent !== intendedContent) {
            // Rollback: restore original content
            let rollbackError: string | undefined;
            try {
              const originalContent =
                bom + restoreLineEndings(originalNormalized, originalEnding);
              await writeFileAtomically(absolutePath, originalContent);
            } catch (e) {
              rollbackError = String(e);
            }
            throw new Error(
              formatError(
                "E_WRITE_VERIFY",
                `Failed to write ${path}: post-write verification mismatch — written content differs from intended.`,
              ),
            );
          }
        }

        const updatedSnapshotId = (await getFileSnapshot(absolutePath))
          .snapshotId;

        // Single-edit calls: no anchors needed (nothing to chain).
        // Multi-edit calls: compact anchors (ref-only, no content) for chaining.
        const isSingleEdit = hashlineEdits.length <= 1;
        const postEditAnchors =
          isSingleEdit || !isAutoReadEnabled()
            ? undefined
            : buildPostEditAnchors(
                result,
                dryRun.firstChangedLine,
                dryRun.lastChangedLine,
                originalLineCount,
                getVisibleLineCount(result),
              );

        return buildChangedResponse({
          path,
          originalNormalized,
          result,
          warnings,
          snapshotId: updatedSnapshotId,
          editsAttempted,
          noopEditsCount: noopEdits.length,
          postEditAnchors,
        });
      });
    },
  };
}

const editToolDefinition: EditToolDefinition = makeEditToolDefinition({
  name: "edit",
  label: "Edit",
  description: EDIT_DESC,
  promptSnippet: EDIT_PROMPT_SNIPPET,
  behavior: {
    maxEditsPerCall: DEFAULT_MAX_EDITS_PER_CALL,
  },
});

export function registerEditTool(pi: ExtensionAPI): void {
  pi.registerTool(editToolDefinition);
}
