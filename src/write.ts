import { readFileSync } from "node:fs";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createWriteTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";

const WRITE_DESC = readFileSync(
  new URL("../tool-descriptions/write.md", import.meta.url),
  "utf-8",
).trim();

const WRITE_PROMPT_SNIPPET = readFileSync(
  new URL("../tool-descriptions/write-snippet.md", import.meta.url),
  "utf-8",
).trim();

export const writeToolSchema = Type.Object(
  {
    path: Type.String({
      description: "Path to the file to write to",
    }),
    content: Type.String({
      description: "Content to write to the file",
    }),
  },
  { additionalProperties: true },
);

type WriteRequestParams = {
  path: string;
  content: string;
};

export function assertWriteRequest(
  request: unknown,
): asserts request is WriteRequestParams {
  if (
    typeof request !== "object" ||
    request === null ||
    Array.isArray(request)
  ) {
    throw new Error("Write request must be an object.");
  }
  const candidate = request as Record<string, unknown>;
  if (typeof candidate.path !== "string" || candidate.path.length === 0) {
    throw new Error('Write request requires a non-empty "path" string.');
  }
  if (typeof candidate.content !== "string") {
    throw new Error('Write request requires a "content" string.');
  }
}

function formatWriteContentPreview(
  content: string | undefined,
  expanded: boolean,
  theme: { fg: (token: any, text: string) => string },
): string | undefined {
  if (typeof content !== "string" || content.length === 0) return undefined;
  const lines = content.split("\n");
  const maxLines = expanded ? Infinity : 16;
  const shown = lines.slice(0, maxLines).map((line) => theme.fg("dim", line));

  if (lines.length > maxLines) {
    shown.push(theme.fg("muted", `... ${lines.length - maxLines} more lines`));
  }
  return shown.join("\n");
}

function formatWriteCall(
  args: Partial<WriteRequestParams> | undefined,
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
  const lineCount =
    typeof args?.content === "string" ? args.content.split("\n").length : 0;
  const lineInfo =
    lineCount > 0 ? theme.fg("muted", ` (${lineCount} lines)`) : "";
  let text = `${theme.fg("toolTitle", theme.bold("write"))} ${pathDisplay}${lineInfo}`;

  const preview = formatWriteContentPreview(args?.content, expanded, theme);
  if (preview) {
    text += `\n\n${preview}`;
  }

  return text;
}

type WriteToolDefinition = ToolDefinition<typeof writeToolSchema> & {
  renderShell?: "default" | "self";
};

const writeToolDefinition: WriteToolDefinition = {
  name: "write",
  label: "Write",
  description: WRITE_DESC,
  parameters: writeToolSchema,
  promptSnippet: WRITE_PROMPT_SNIPPET,
  renderShell: "default",

  renderCall(args, theme, context) {
    const text =
      context.lastComponent instanceof Text
        ? context.lastComponent
        : new Text("", 0, 0);
    text.setText(formatWriteCall(args, context.expanded, theme));
    return text;
  },

  async execute(toolCallId, params, signal, onUpdate, ctx) {
    assertWriteRequest(params);
    const builtinWrite = createWriteTool(ctx.cwd);
    return builtinWrite.execute(
      toolCallId,
      { path: params.path, content: params.content },
      signal,
      onUpdate,
    );
  },
};

export function registerWriteTool(pi: ExtensionAPI): void {
  pi.registerTool(writeToolDefinition);
}
