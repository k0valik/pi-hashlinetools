import * as Diff from "diff";
import { formatPublicLineRef } from "./line-ref";

// ─── Line ending normalization ──────────────────────────────────────────

export function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1 || crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(
  text: string,
  ending: "\r\n" | "\n",
): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}

// ─── Diff generation ────────────────────────────────────────────────────

export function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines = 4,
): { diff: string } {
  const patch = Diff.structuredPatch(
    "a",
    "b",
    oldContent,
    newContent,
    undefined,
    undefined,
    {
      context: contextLines,
    },
  );

  if (!patch.hunks.length) {
    return { diff: "" };
  }

  const maxLineNum = Math.max(
    oldContent.split("\n").length,
    newContent.split("\n").length,
  );
  const lineNumWidth = String(maxLineNum).length;
  const oldFileLines =
    oldContent.length === 0
      ? []
      : oldContent.endsWith("\n")
        ? oldContent.split("\n").slice(0, -1)
        : oldContent.split("\n");
  const newFileLines =
    newContent.length === 0
      ? []
      : newContent.endsWith("\n")
        ? newContent.split("\n").slice(0, -1)
        : newContent.split("\n");
  const output: string[] = [];

  for (let h = 0; h < patch.hunks.length; h++) {
    const hunk = patch.hunks[h]!;
    if (h > 0) {
      output.push("    ...");
    }

    let oldLineNum = hunk.oldStart;
    let newLineNum = hunk.newStart;

    for (const line of hunk.lines) {
      if (line === "\\ No newline at end of file") continue;

      const prefix = line[0] as " " | "+" | "-";
      const text = line.slice(1);

      if (prefix === "-") {
        const publicRef = formatPublicLineRef(oldFileLines, oldLineNum);
        const padded = publicRef.padStart(lineNumWidth + 1, " ");
        output.push(`-${padded}│${text}`);
        oldLineNum++;
      } else if (prefix === "+") {
        const publicRef = formatPublicLineRef(newFileLines, newLineNum);
        const padded = publicRef.padStart(lineNumWidth + 1, " ");
        output.push(`+${padded}│${text}`);
        newLineNum++;
      } else {
        const publicRef = formatPublicLineRef(newFileLines, newLineNum);
        const padded = publicRef.padStart(lineNumWidth + 1, " ");
        output.push(` ${padded}│${text}`);
        oldLineNum++;
        newLineNum++;
      }
    }
  }

  return { diff: output.join("\n") };
}

export interface CompactHashlineDiffPreview {
  preview: string;
  addedLines: number;
  removedLines: number;
}

type DiffPreviewKind = "context" | "addition" | "deletion";

function classifyDiffPreviewLine(line: string): DiffPreviewKind | null {
  if (line.startsWith("+")) return "addition";
  if (line.startsWith("-")) return "deletion";
  if (line.startsWith(" ")) return "context";
  return null;
}

function summarizeOmitted(count: number, label: string): string {
  return `... ${count} more ${label} line${count === 1 ? "" : "s"}`;
}

function collapseDiffPreviewRun(
  lines: string[],
  maxVisible: number,
  label: string,
): string[] {
  if (lines.length <= maxVisible) {
    return lines;
  }

  return [
    ...lines.slice(0, maxVisible),
    summarizeOmitted(lines.length - maxVisible, label),
  ];
}

export function buildCompactHashlineDiffPreview(
  diff: string,
  options: {
    maxUnchangedRun?: number;
    maxAdditionRun?: number;
    maxDeletionRun?: number;
    maxOutputLines?: number;
  } = {},
): CompactHashlineDiffPreview {
  const {
    maxUnchangedRun = 2,
    maxAdditionRun = 4,
    maxDeletionRun = 4,
    maxOutputLines = 12,
  } = options;

  if (!diff.trim()) {
    return { preview: "", addedLines: 0, removedLines: 0 };
  }

  const lines = diff.split("\n").filter((line) => line.length > 0);
  const previewLines: string[] = [];
  let addedLines = 0;
  let removedLines = 0;

  for (let index = 0; index < lines.length; ) {
    const kind = classifyDiffPreviewLine(lines[index]!);
    let end = index + 1;
    while (
      end < lines.length &&
      classifyDiffPreviewLine(lines[end]!) === kind
    ) {
      end += 1;
    }

    const run = lines.slice(index, end);
    switch (kind) {
      case "addition":
        addedLines += run.length;
        previewLines.push(
          ...collapseDiffPreviewRun(run, maxAdditionRun, "added"),
        );
        break;
      case "deletion":
        removedLines += run.length;
        previewLines.push(
          ...collapseDiffPreviewRun(run, maxDeletionRun, "removed"),
        );
        break;
      case "context":
        previewLines.push(
          ...collapseDiffPreviewRun(run, maxUnchangedRun, "unchanged"),
        );
        break;
      default:
        previewLines.push(...run);
        break;
    }

    index = end;
  }

  if (previewLines.length > maxOutputLines) {
    const visibleLines = previewLines.slice(0, maxOutputLines);
    visibleLines.push(
      summarizeOmitted(previewLines.length - maxOutputLines, "preview"),
    );
    return {
      preview: visibleLines.join("\n"),
      addedLines,
      removedLines,
    };
  }

  return {
    preview: previewLines.join("\n"),
    addedLines,
    removedLines,
  };
}
