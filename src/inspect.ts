/**
 * `inspect_text` tool — read-only file inspection operations.
 *
 * Provides `show` (line numbers + hex), `validate` (uniqueness check),
 * and `diff` (byte-level file comparison) operations.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createTwoFilesPatch } from "diff";
import { tryRecovery } from "./edit-recovery";
import { formatPublicLineRef } from "./line-ref";
import { resolveToCwd } from "./path-utils";

function textContent(text: string): TextContent {
  return { type: "text", text };
}

/** Build a tool result envelope. The `details` shape varies by op,
 *  so we widen the type to `Record<string, unknown>` to avoid TS
 *  trying to infer a discriminated union from the early returns.
 *  The runtime shape is what the model sees; the types are for the
 *  tool registration only. */
function inspectResult(
  out: string,
  details: Record<string, unknown>,
): { content: TextContent[]; details: Record<string, unknown> } {
  return { content: [textContent(out)], details };
}

const INSPECT_TEXT_DESC = `Inspect a file for verification: line-numbered hex preview, silent uniqueness check, or byte-level diff.

- \`show\` — line numbers + first 16 bytes of each line (hex). Hashline-anchored for \`edit\`.
- \`validate\` — check \`oldText\` exists uniquely in \`file\`. Same byte-level tolerance as \`edit replace_text\`. Use before sending an edit.
- \`diff\` — byte-level diff between two files.

Not for reading file content. Use \`read\`.
`;

/** Format a single byte as a 2-char lowercase hex string. */
function byteHex(b: number): string {
  return b.toString(16).padStart(2, "0");
}

/** Render the first 16 bytes of `buf` as a hex string. */
function formatHex(buf: Buffer, n = 16): string {
  const len = Math.min(n, buf.length);
  const parts: string[] = [];
  for (let i = 0; i < len; i++) {
    parts.push(byteHex(buf[i] ?? 0));
  }
  return parts.join(" ");
}

/** Render the line-numbered + hex preview for a file. Used by the
 *  `show` op. Line numbers use the hashline read format (e.g. `1│alpha`)
 *  so the model can use the result as anchors for `edit` calls if
 *  needed. The hex column shows the first 16 bytes of each line. */
function renderShow(filePath: string, content: string): string {
  const lines = content.split("\n");
  // Drop the trailing empty string from a final newline so the
  // "N+1" line isn't empty. We track the visible line count and
  // match the read tool's behavior.
  const visibleLines = content.endsWith("\n") ? lines.slice(0, -1) : lines;
  const total = visibleLines.length;
  const width = String(total).length;

  const out: string[] = [];
  out.push(`File: ${filePath} (${total} line${total === 1 ? "" : "s"})`);
  out.push("");
  out.push(
    `${"Line".padStart(width)} │ Text${" ".repeat(40)}│ Hex (first 16 bytes)`,
  );
  out.push(`${"-".repeat(width)}-─┼─${"-".repeat(50)}┼─${"-".repeat(23)}`);

  for (let i = 0; i < visibleLines.length; i++) {
    const line = visibleLines[i] ?? "";
    const lineNumber = i + 1;
    const publicRef = formatPublicLineRef(visibleLines, lineNumber);
    const paddedRef = publicRef.padStart(width, " ");
    // Slice to 16 chars BEFORE Buffer.from to bound the allocation. A long
    // line in a big file would otherwise allocate up to 4× the line length in
    // bytes for a buffer we then truncate to 16 bytes anyway. The trailing
    // subarray(0, 16) is defensive: if any of the 16 chars is multi-byte UTF-8,
    // the buffer can be 16–48 bytes; we always want at most 16.
    const lineBuf = Buffer.from(line.slice(0, 16), "utf-8").subarray(0, 16);
    const hex = formatHex(lineBuf);
    out.push(`${paddedRef} │ ${line.padEnd(50)} │ ${hex}`);
  }
  return out.join("\n");
}

/** Render a `validate` op result. The model gets:
 *  - the match count (1, N>1, or 0)
 *  - line numbers where the matches start
 *  - on recovery, a note that whitespace/line-ending tolerance was
 *    applied (no strategy name leak — same UX as `replace_text`)
 *  - the SHA-256 of the file (so the model can confirm view match)
 */
function renderValidate(
  filePath: string,
  oldText: string,
  rawBuffer: Buffer,
  count: number,
  matchLines: number[],
  recovered: boolean,
): string {
  const out: string[] = [];
  out.push(`File: ${filePath}`);
  out.push(
    `Search: "${oldText.length > 80 ? `${oldText.slice(0, 80)}…` : oldText}"`,
  );
  out.push(
    `File SHA-256: ${createShortHash(rawBuffer)} (your read tool's view of this file should match).`,
  );
  out.push("");

  if (count === 0) {
    out.push("0 matches — text not found in file.");
    return out.join("\n");
  }

  const word = count === 1 ? "match" : "matches";
  const head = `${count} ${word}`;
  if (recovered) {
    out.push(`${head} after applying whitespace/line-ending tolerance.`);
  } else {
    out.push(`${head} in file.`);
  }
  if (matchLines.length > 0) {
    const shown = matchLines.slice(0, 5);
    const more =
      count > shown.length
        ? ` (showing first ${shown.length} of ${count})`
        : "";
    out.push(`Match locations: lines ${shown.join(", ")}${more}.`);
  }
  return out.join("\n");
}

/** Render a `diff` op result. Uses the `diff` package's
 *  `createTwoFilesPatch` for a unified diff format the model already
 *  knows how to read. */
function renderDiff(
  fileA: string,
  fileB: string,
  bufA: Buffer,
  bufB: Buffer,
): string {
  const textA = bufA.toString("utf-8");
  const textB = bufB.toString("utf-8");
  const out: string[] = [];
  out.push(`File A: ${fileA} (${bufA.length} bytes)`);
  out.push(`File B: ${fileB} (${bufB.length} bytes)`);
  out.push("");

  if (bufA.equals(bufB)) {
    out.push("Files are identical.");
    return out.join("\n");
  }

  out.push("Differences:");
  out.push("");
  // The diff package's createTwoFilesPatch returns a unified diff
  // string. We strip the leading file headers to keep the output
  // compact (the model knows the filenames from the lines above).
  const patch = createTwoFilesPatch(fileA, fileB, textA, textB, "", "", {
    context: 3,
  });
  // Trim the first 4 lines (--- / +++ / @@ index markers at the
  // file level); keep the @@ hunk headers and the +/- lines.
  const patchLines = patch.split("\n");
  // Drop everything until we hit the first @@ hunk header.
  const startIdx = patchLines.findIndex((l) => l.startsWith("@@"));
  if (startIdx >= 0) {
    out.push(...patchLines.slice(startIdx));
  } else {
    out.push(...patchLines.slice(4));
  }
  return out.join("\n");
}

function createShortHash(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

/** Find all match start positions (1-based line numbers) of a
 *  substring in text. Returns the first 5 only. */
function locateLines(text: string, needle: string, max = 5): number[] {
  if (needle.length === 0) return [];
  const lines: number[] = [];
  let idx = 0;
  let line = 1;
  while (lines.length < max) {
    const found = text.indexOf(needle, idx);
    if (found === -1) break;
    for (let i = idx; i < found; i++) {
      if (text.charCodeAt(i) === 10) line++;
    }
    lines.push(line);
    for (let i = found; i < found + needle.length; i++) {
      if (text.charCodeAt(i) === 10) line++;
    }
    idx = found + needle.length;
  }
  return lines;
}

/** Count non-overlapping occurrences of `needle` in `text`. */
function countMatches(text: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while (true) {
    const found = text.indexOf(needle, idx);
    if (found === -1) break;
    count++;
    idx = found + needle.length;
  }
  return count;
}

const inspectTextToolDefinition = {
  name: "inspect_text",
  label: "Inspect",
  description: INSPECT_TEXT_DESC,
  // Input schema: a discriminated union of three op-specific shapes.
  //
  // Provider compatibility note (DeepSeek fix):
  // TypeBox's `Type.Union([...])` compiles to JSON Schema's `anyOf`
  // at the TOP LEVEL, with no `type: "object"`. Some providers
  // (e.g. DeepSeek) strictly require `type: "object"` at the top
  // of every tool's parameters schema and reject the schema with:
  //   "Invalid schema for function 'inspect_text': schema must be
  //    a JSON Schema of 'type: "object"', got 'type: null'"
  //
  // Fix: build the union as normal for type-safety / IDE help, then
  // spread it into a `Type.Unsafe({ type: "object", ...union })` to
  // force a top-level `type: "object"`. The result is a discriminated
  // union (anyOf inside an object envelope) that AJV validates
  // correctly AND that strict providers accept.
  //
  // Note on additionalProperties: each variant below carries
  // `additionalProperties: false` so the model can't smuggle in
  // fields that don't belong to the chosen op. We deliberately do
  // NOT set `additionalProperties: false` at the root — the root
  // has no `properties` of its own (only `anyOf`); setting it at
  // the root would treat every key (e.g. `op`, `file`) as
  // "additional" and reject valid input.
  parameters: Type.Unsafe({
    type: "object",
    ...Type.Union([
      Type.Object(
        {
          op: Type.Literal("show", {
            description: "Inspection operation to perform",
          }),
          file: Type.String({ description: "Path to the file to inspect" }),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          op: Type.Literal("validate", {
            description: "Inspection operation to perform",
          }),
          file: Type.String({ description: "Path to the file to inspect" }),
          oldText: Type.String({ description: "Substring to search for" }),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          op: Type.Literal("diff", {
            description: "Inspection operation to perform",
          }),
          fileA: Type.String({ description: "Path to the first file" }),
          fileB: Type.String({ description: "Path to the second file" }),
        },
        { additionalProperties: false },
      ),
    ]),
  }),

  async execute(
    _toolCallId: string,
    params:
      | { op: "show"; file: string }
      | { op: "validate"; file: string; oldText: string }
      | { op: "diff"; fileA: string; fileB: string },
    _signal: AbortSignal,
    _onUpdate: unknown,
    _ctx: { cwd: string },
  ) {
    // The schema (Type.Union with Type.Literal discriminators) has
    // already enforced: op is one of the three values, and the
    // required per-op fields are present. Switch on `op` for
    // TypeScript narrowing.
    //
    // Defense-in-depth: the explicit
    // [E_*] checks below are MOOT in the normal model path (AJV
    // catches missing params first). They are kept for direct
    // callers that bypass AJV (tests, scripts, host bugs). This
    // matches edit.ts, which kept the `|| "replace"` default in
    // normalizeEditItems for the same reason. Without these
    // guards, a direct caller passing `{ op: "validate" }` (no
    // oldText) silently coerces undefined → literal string
    // "undefined" in countMatches, then crashes in renderValidate
    // with an uncaught TypeError. Same for { op: "show" } without
    // file (resolveToCwd → expandPath → filePath.startsWith →
    // TypeError).
    const op = params.op;

    if (op === "show") {
      // Defense-in-depth (see comment above): if a direct caller
      // (test, script, host bug) calls execute() with `{ op: "show" }`
      // and no `file`, AJV is bypassed and we'd otherwise crash in
      // resolveToCwd with TypeError. Throw an actionable host-level
      // error code instead.
      if (params.file === undefined) {
        throw new Error(
          "[E_INSPECT_SHOW_MISSING_FILE] inspect_text show requires a file path.",
        );
      }
      // Resolve relative paths against the workspace cwd, not the process cwd.
      // Matches the read/edit/undo tools' contract (see path-utils.ts).
      const absPath = resolveToCwd(params.file, _ctx.cwd);
      const rawBuffer = await readFile(absPath);
      const text = rawBuffer.toString("utf-8");
      const out = renderShow(params.file, text);
      return inspectResult(out, {
        op,
        file: params.file,
        size: rawBuffer.length,
      });
    }

    if (op === "validate") {
      // Defense-in-depth (see comment above): same pattern as show.
      // Direct callers bypassing AJV get actionable [E_*] codes
      // instead of opaque TypeError stack traces.
      if (params.file === undefined) {
        throw new Error(
          "[E_INSPECT_VALIDATE_MISSING_FILE] inspect_text validate requires a file path.",
        );
      }
      if (params.oldText === undefined) {
        throw new Error(
          "[E_INSPECT_VALIDATE_MISSING_OLDTEXT] inspect_text validate requires an oldText string.",
        );
      }
      // Resolve relative paths against the workspace cwd, not the process cwd.
      const absPath = resolveToCwd(params.file, _ctx.cwd);
      const rawBuffer = await readFile(absPath);
      const text = rawBuffer.toString("utf-8");
      const oldText = params.oldText;

      // 1) Try the exact match on the raw text. This is the same
      //    shape as the replace_text path uses internally.
      const exactCount = countMatches(text, oldText);
      if (exactCount > 0) {
        const matchLines = locateLines(text, oldText);
        const out = renderValidate(
          params.file,
          oldText,
          rawBuffer,
          exactCount,
          matchLines,
          false,
        );
        return inspectResult(out, {
          op,
          file: params.file,
          count: exactCount,
          matchLines,
          recovered: false,
        });
      }
      // 2) Silently try byte-level recovery (LF/CRLF + trimmed),
      //    mirroring the replace_text `tryRecovery` path. If it
      //    finds a unique match, report it as a 1-match with
      //    a "after applying whitespace/line-ending tolerance"
      //    hint (no strategy name leak).
      //
      //    `tryRecovery` is strict: ambiguous matches return failure, so a
      //    successful recovery guarantees exactly one match. We pass an empty
      //    newText so the splice is a no-op (we don't care about the spliced
      //    buffer; we use `recovery.matchPosition` directly to compute the line).
      const recovery = tryRecovery({ rawBuffer, oldText, newText: "" });
      if (recovery.success) {
        // Count newlines in text[..matchPosition] to get the 1-based line.
        const lineNum =
          (text.slice(0, recovery.matchPosition).match(/\n/g) ?? []).length + 1;
        const out = renderValidate(
          params.file,
          oldText,
          rawBuffer,
          1,
          [lineNum],
          true,
        );
        return inspectResult(out, {
          op,
          file: params.file,
          count: 1,
          matchLines: [lineNum],
          recovered: true,
        });
      }

      // 3) No match even with recovery.
      const out = renderValidate(params.file, oldText, rawBuffer, 0, [], false);
      return inspectResult(out, {
        op,
        file: params.file,
        count: 0,
        matchLines: [],
        recovered: false,
      });
    }

    if (op === "diff") {
      // Defense-in-depth (see comment above): same pattern. Direct
      // callers bypassing AJV get an actionable [E_*] code instead
      // of an opaque TypeError stack trace from resolveToCwd.
      if (params.fileA === undefined || params.fileB === undefined) {
        throw new Error(
          "[E_INSPECT_DIFF_MISSING_FILES] inspect_text diff requires both fileA and fileB paths.",
        );
      }
      // Resolve both paths against the workspace cwd, not the process cwd.
      const [absPathA, absPathB] = [
        resolveToCwd(params.fileA, _ctx.cwd),
        resolveToCwd(params.fileB, _ctx.cwd),
      ];
      const [bufA, bufB] = await Promise.all([
        readFile(absPathA),
        readFile(absPathB),
      ]);
      const out = renderDiff(params.fileA, params.fileB, bufA, bufB);
      return inspectResult(out, {
        op,
        fileA: params.fileA,
        fileB: params.fileB,
        sizeA: bufA.length,
        sizeB: bufB.length,
        identical: bufA.equals(bufB),
      });
    }

    // Unreachable: Type.Union has enforced op ∈ {show, validate, diff}.
    // Kept for type safety — TypeScript needs an exhaustive return.
    throw new Error(
      `[E_INSPECT_UNKNOWN_OP] Unknown inspect_text op: ${op as string}`,
    );
  },
};

export function registerInspectTextTool(pi: ExtensionAPI): void {
  pi.registerTool(inspectTextToolDefinition);
}

/** Register the `/inspect-text` slash command. This is the TUI
 *  prompt entry point for the same operations the `inspect_text`
 *  tool exposes to the model. The command's handler parses the
 *  args, calls the tool's `execute` directly (no model roundtrip),
 *  and shows the result via `ctx.ui.notify`.
 *
 *  Subcommands:
 *    /inspect-text show <file>
 *    /inspect-text validate <file> <oldText>
 *    /inspect-text diff <fileA> <fileB>
 */
export function registerInspectTextCommand(pi: ExtensionAPI): void {
  if (
    typeof (pi as unknown as Record<string, unknown>).registerCommand !==
    "function"
  ) {
    return;
  }
  (
    pi as unknown as {
      registerCommand: (
        name: string,
        spec: {
          description: string;
          handler: (
            args: string,
            ctx: {
              ui: { notify: (m: string, level?: string) => void };
              cwd: string;
            },
          ) => Promise<void>;
        },
      ) => void;
    }
  ).registerCommand("inspect-text", {
    description:
      "Inspect a file: show line numbers + hex, validate uniqueness, or diff two files",
    handler: async (args, ctx) => {
      // Parse `<subcommand> <remainder>`. We split on the FIRST whitespace only
      // (NOT on /\s+/) because the `validate` subcommand's oldText argument can
      // contain multiple consecutive spaces. The TUI prompt hands us the raw
      // user-typed string and a single line, so we can't support real newlines
      // inside oldText here — but we can preserve internal spaces.
      const trimmedArgs = (args ?? "").trim();
      const subEnd = trimmedArgs.search(/\s/);
      const sub = (
        subEnd === -1 ? trimmedArgs : trimmedArgs.slice(0, subEnd)
      ).toLowerCase();
      const remain = subEnd === -1 ? "" : trimmedArgs.slice(subEnd + 1);

      if (!sub) {
        ctx.ui.notify(
          "Usage:\n  /inspect-text show <file>\n  /inspect-text validate <file> <oldText>\n  /inspect-text diff <fileA> <fileB>",
          "info",
        );
        return;
      }

      // Discriminated union: matches the tool's schema. The slash
      // command's usage messages enforce the per-op required fields
      // before we get here, so each branch can construct a fully-typed
      // params object that the tool's execute() accepts without casts.
      let params:
        | { op: "show"; file: string }
        | { op: "validate"; file: string; oldText: string }
        | { op: "diff"; fileA: string; fileB: string };

      if (sub === "show") {
        const file = remain.trim();
        if (!file) {
          ctx.ui.notify("Usage: /inspect-text show <file>", "error");
          return;
        }
        params = { op: "show", file };
      } else if (sub === "validate") {
        const fileEnd = remain.search(/\s/);
        const file = fileEnd === -1 ? remain.trim() : remain.slice(0, fileEnd);
        // Everything after the file path is the oldText, with leading whitespace
        // stripped. We preserve internal whitespace (consecutive spaces survive).
        const oldText =
          fileEnd === -1 ? "" : remain.slice(fileEnd + 1).replace(/^\s+/, "");
        if (!file) {
          ctx.ui.notify(
            "Usage: /inspect-text validate <file> <oldText>",
            "error",
          );
          return;
        }
        if (oldText === "") {
          ctx.ui.notify(
            "Usage: /inspect-text validate <file> <oldText>",
            "error",
          );
          return;
        }
        params = { op: "validate", file, oldText };
      } else if (sub === "diff") {
        const fileAEnd = remain.search(/\s/);
        const fileA =
          fileAEnd === -1 ? remain.trim() : remain.slice(0, fileAEnd);
        const fileB = fileAEnd === -1 ? "" : remain.slice(fileAEnd + 1).trim();
        if (!fileA || !fileB) {
          ctx.ui.notify("Usage: /inspect-text diff <fileA> <fileB>", "error");
          return;
        }
        params = { op: "diff", fileA, fileB };
      } else {
        ctx.ui.notify(
          `Unknown subcommand: ${sub}\nUsage:\n  /inspect-text show <file>\n  /inspect-text validate <file> <oldText>\n  /inspect-text diff <fileA> <fileB>`,
          "error",
        );
        return;
      }

      try {
        const result = await inspectTextToolDefinition.execute(
          "slash-command",
          params,
          new AbortController().signal,
          () => {},
          { cwd: ctx.cwd },
        );
        const text = result.content
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("");
        ctx.ui.notify(text, "info");
      } catch (e) {
        ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
      }
    },
  });
}
