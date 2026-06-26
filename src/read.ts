import { constants, readFileSync } from "node:fs";
import { access as fsAccess, readdir as fsReaddir } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createReadTool,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type TruncationResult,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { normalizeToLF, stripBom } from "./edit-diff";
import { loadFileKindAndText } from "./file-kind";
import { formatPublicLineRef } from "./line-ref";
import { PACKAGE_INFO } from "./package-info";
import { resolveToCwd } from "./path-utils";
import { throwIfAborted } from "./runtime";
import { getFileSnapshot } from "./snapshot";

const READ_DESC = readFileSync(
  new URL("../tool-descriptions/read.md", import.meta.url),
  "utf-8",
)
  .replaceAll("{{DEFAULT_MAX_LINES}}", String(DEFAULT_MAX_LINES))
  .replaceAll("{{DEFAULT_MAX_BYTES}}", formatSize(DEFAULT_MAX_BYTES))
  .trim();

const READ_PROMPT_SNIPPET = readFileSync(
  new URL("../tool-descriptions/read-snippet.md", import.meta.url),
  "utf-8",
).trim();

const READ_PROMPT_GUIDELINES = readFileSync(
  new URL("../tool-descriptions/read-guidelines.md", import.meta.url),
  "utf-8",
)
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.startsWith("- "))
  .map((line) => line.slice(2));

function normalizePositiveInteger(
  value: number | undefined,
  name: "offset" | "limit",
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Read request field "${name}" must be a positive integer.`);
  }

  return value;
}

function getPreviewLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }

  const lines = text.split("\n");
  return text.endsWith("\n") ? lines.slice(0, -1) : lines;
}

function formatLineNumberRegion(
  fileLines: string[],
  startLine: number,
  endLine: number,
): string {
  const lineNumberWidth = String(endLine).length;
  return fileLines
    .slice(startLine - 1, endLine)
    .map((line, index) => {
      const lineNumber = startLine + index;
      const publicRef = formatPublicLineRef(fileLines, lineNumber);
      const paddedRef = publicRef.padStart(lineNumberWidth + 1, " ");
      return `${paddedRef}│${line}`;
    })
    .join("\n");
}

export function formatHashlineReadPreview(
  text: string,
  options: { offset?: number; limit?: number; plain?: boolean },
): { text: string; truncation?: TruncationResult; nextOffset?: number } {
  const allLines = getPreviewLines(text);
  const totalLines = allLines.length;
  const startLine = normalizePositiveInteger(options.offset, "offset") ?? 1;
  if (totalLines === 0) {
    if (startLine === 1) {
      return {
        text: "File is empty. Use the write tool to create initial content.",
      };
    }

    return {
      text: `Offset ${startLine} is beyond end of file (0 lines total). The file is empty. Use the write tool to create initial content.`,
    };
  }

  if (startLine > totalLines) {
    return {
      text: `Offset ${startLine} is beyond end of file (${totalLines} lines total). Use offset=1 to read from the start, or offset=${totalLines} to read the last line.`,
    };
  }

  const limit = normalizePositiveInteger(options.limit, "limit");
  const endIdx = limit
    ? Math.min(startLine - 1 + limit, totalLines)
    : totalLines;
  const selected = allLines.slice(startLine - 1, endIdx);
  const formatted = options.plain
    ? selected.join("\n")
    : formatLineNumberRegion(allLines, startLine, endIdx);

  const truncation = truncateHead(formatted);
  if (truncation.firstLineExceedsLimit) {
    return {
      text: `[Line ${startLine} exceeds ${formatSize(truncation.maxBytes)}.]`,

      truncation,
    };
  }

  let preview = truncation.content;
  let nextOffset: number | undefined;
  if (truncation.truncated) {
    const endLineDisplay = startLine + truncation.outputLines - 1;
    nextOffset = endLineDisplay + 1;
    if (truncation.truncatedBy === "lines") {
      preview += `\n\n[Showing lines ${startLine}-${endLineDisplay} of ${totalLines}. Use offset=${nextOffset} to continue.]`;
    } else {
      preview += `\n\n[Showing lines ${startLine}-${endLineDisplay} of ${totalLines} (${formatSize(truncation.maxBytes)} limit). Use offset=${nextOffset} to continue.]`;
    }
  } else if (endIdx < totalLines) {
    nextOffset = endIdx + 1;
    preview += `\n\n[Showing lines ${startLine}-${endIdx} of ${totalLines}. Use offset=${nextOffset} to continue.]`;
  }

  return {
    text: preview,
    truncation: truncation.truncated ? truncation : undefined,
    ...(nextOffset !== undefined ? { nextOffset } : {}),
  };
}

export function registerReadTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "read",
    label: "Read",
    description: READ_DESC,
    promptSnippet: READ_PROMPT_SNIPPET,
    promptGuidelines: READ_PROMPT_GUIDELINES,
    parameters: Type.Object({
      path: Type.String({
        description: "Path to the file to read (relative or absolute)",
      }),
      offset: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: "Line number to start reading from (1-indexed)",
        }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: "Maximum number of lines to read",
        }),
      ),
      plain: Type.Optional(
        Type.Boolean({
          description:
            "Return plain text without line-number prefixes. Use for exploration or reference reads.",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const rawPath = params.path;
      const absolutePath = resolveToCwd(rawPath, ctx.cwd);

      throwIfAborted(signal);
      try {
        await fsAccess(absolutePath, constants.R_OK);
      } catch (error: unknown) {
        const code =
          error instanceof Error
            ? (error as NodeJS.ErrnoException).code
            : undefined;
        if (code === "ENOENT") {
          throw new Error(`File not found: ${rawPath}`);
        }
        if (code === "EACCES" || code === "EPERM") {
          throw new Error(`File is not readable: ${rawPath}`);
        }
        throw new Error(`Cannot access file: ${rawPath}`);
      }

      throwIfAborted(signal);
      const file = await loadFileKindAndText(absolutePath);
      if (file.kind === "directory") {
        const entries = await fsReaddir(absolutePath);
        const listing = entries
          .slice(0, 50)
          .map((name) => `  ${name}`)
          .join("\n");
        const cap =
          entries.length > 50 ? `\n  ... and ${entries.length - 50} more` : "";
        throw new Error(
          `Path is a directory: ${rawPath}\n${listing}${cap}\n\nUse ls to explore further or read a specific file.`,
        );
      }

      if (file.kind === "binary") {
        throw new Error(
          `Path is a binary file: ${rawPath} (${file.description}). Read only supports text files and supported images.`,
        );
      }

      if (file.kind === "image") {
        const builtinRead = createReadTool(ctx.cwd);
        return builtinRead.execute(_toolCallId, params, signal);
      }

      throwIfAborted(signal);
      const normalized = normalizeToLF(stripBom(file.text).text);
      const preview = formatHashlineReadPreview(normalized, {
        offset: params.offset,
        limit: params.limit,
        plain: params.plain,
      });
      const snapshot = await getFileSnapshot(absolutePath);

      // A U+FFFD anywhere in the decoded text means the file held bytes that
      // are not valid UTF-8 (CP1251, GBK, …). Editing rewrites the whole file
      // as UTF-8, so those bytes are lost. Warn once on read — the model can
      // then iconv the file back afterwards. Detect on the full text, not the
      // paged slice, so an out-of-view bad byte still surfaces.
      const previewText = normalized.includes("\uFFFD")
        ? `${preview.text}\n\n[Non-UTF-8 bytes shown as U+FFFD; editing rewrites the file as UTF-8.]`
        : preview.text;

      return {
        content: [{ type: "text", text: previewText }],
        details: {
          truncation: preview.truncation,
          // snapshotId remains in details for host UI (e.g. "file changed since
          // last view"). It is NOT echoed in text — the LLM no longer needs it.
          snapshotId: snapshot.snapshotId,
          ...(preview.nextOffset !== undefined
            ? { nextOffset: preview.nextOffset }
            : {}),
          // Phase 2 C — host-only observability. Truncated reads usually mean
          // a follow-up read with `offset = next_offset` is coming.
          metrics: {
            truncated: !!preview.truncation,
            ...(preview.nextOffset !== undefined
              ? { next_offset: preview.nextOffset }
              : {}),
          },
          package: PACKAGE_INFO,
        },
      };
    },
  });
}
