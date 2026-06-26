import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isAutoReadEnabled, setAutoReadEnabled } from "./src/auto-read-state";
import { registerEditTool } from "./src/edit";
import { normalizeToLF, stripBom } from "./src/edit-diff";
import { formatHashlineRegion } from "./src/hashline";
import {
  registerInspectTextCommand,
  registerInspectTextTool,
} from "./src/inspect";
import { registerReadTool } from "./src/read";
import { registerUndoTool, setCurrentTurn } from "./src/undo";
import { registerWriteTool } from "./src/write";

// ── Shared auto-read helper ──────────────────────────────────────────────

type ContentBlock = TextContent | ImageContent;

export async function appendAutoRead(
  event: {
    content?: ContentBlock[];
    input: Record<string, unknown>;
  },
  ctx: { cwd: string },
): Promise<{ content?: ContentBlock[] } | undefined> {
  const filePath = (event.input as Record<string, unknown>)?.path;
  if (typeof filePath !== "string") return;

  try {
    const absolutePath = isAbsolute(filePath)
      ? filePath
      : join(ctx.cwd, filePath);
    const content = await readFile(absolutePath, "utf-8");
    const normalized = normalizeToLF(stripBom(content).text);

    if (normalized === "") return;
    const lines = normalized.split("\n");
    const visibleCount = normalized.endsWith("\n")
      ? lines.length - 1
      : lines.length;
    if (visibleCount === 0) return;

    const displayCount = Math.min(visibleCount, 2000);
    const hashlineOutput = formatHashlineRegion(lines, 1, displayCount);

    const paginationHint =
      visibleCount > 2000
        ? `\n\n[Showing lines 1-2000 of ${visibleCount}. Use offset=2001 to continue.]`
        : "";

    if (hashlineOutput) {
      return {
        content: [
          ...(event.content ?? []),
          {
            type: "text",
            text: `\n\n--- Auto-read (hashline anchors) ---\n${hashlineOutput}${paginationHint}`,
          },
        ],
      };
    }
  } catch {
    // Silently skip - file may have been deleted between write and read
  }
}

/**
 * Create the `tool_result` handler. Auto-read is
 * unconditional on commit when the gate is enabled (independent of
 * warnings). When the gate is OFF, the model sees the warnings only —
 * no auto-read is appended.
 *
 * Exported separately from the default export so tests can drive the
 * gate state directly without instantiating the full ExtensionAPI.
 */
export function createAutoReadHandler(
  getEnabled: () => boolean,
): (event: any, ctx: { cwd: string }) => Promise<unknown> {
  return async (event, ctx) => {
    if (!getEnabled()) return;

    // Always auto-read after a successful write
    if (event.toolName === "write" && !event.isError) {
      return appendAutoRead(event, ctx);
    }

    // Auto-read after a successful edit when the gate is enabled.
    // Unconditional on commit — the post-edit state is always fresh, so
    // the model can chain without re-reading. When the gate is OFF, the
    // model sees the warnings only (in the tool result text) and can
    // opt-in to a manual read.
    if (event.toolName === "edit" && !event.isError) {
      return appendAutoRead(event, ctx);
    }
  };
}

export default function (pi: ExtensionAPI): void {
  registerReadTool(pi);
  registerEditTool(pi);
  registerWriteTool(pi);
  registerUndoTool(pi);
  registerInspectTextTool(pi);
  registerInspectTextCommand(pi);

  pi.on("turn_start", async (event) => {
    setCurrentTurn(event.turnIndex);
  });

  // ─── Auto-read after write/edit ─────────────────────────────────────

  const autoReadValue = process.env.PI_HASHLINE_AUTO_READ;
  setAutoReadEnabled(autoReadValue === "1" || autoReadValue === "true");

  if (
    typeof (pi as unknown as Record<string, unknown>).registerCommand ===
    "function"
  ) {
    pi.registerCommand("toggle-auto-read", {
      description: "Toggle automatic hashline anchors after write operations",
      handler: async (_args, ctx) => {
        setAutoReadEnabled(!isAutoReadEnabled());
        ctx.ui.notify(
          `Auto-read after write: ${isAutoReadEnabled() ? "enabled" : "disabled"}`,
          "info",
        );
      },
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("tool_result" as any, createAutoReadHandler(isAutoReadEnabled));

  // ─── Developer toasts for warnings and errors ────────────────────
  //
  // Every W_* (warning) and E_* (error) code that appears in the edit
  // tool's result text surfaces here as a toast for visual feedback
  // during testing. The toast is separate from the tool result; it
  // appears in the TUI but is not in the model's
  // context. This is the "warn me but not the agent" pattern.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("tool_result" as any, async (event: any, ctx: any) => {
    if (event.toolName !== "edit") return;
    if (event.isError) return;
    const text =
      event.content
        ?.filter((c: { type: string; text?: string }) => c.type === "text")
        .map((c: { text?: string }) => c.text ?? "")
        .join("") ?? "";
    if (!text) return;
    // Match both W_* (warnings) and E_* (errors) codes so dev toasts
    // fire for refused-noop paths like [E_EDIT_REFUSED] /
    // [E_EDIT_CONFLICT], not just for W_* warnings.
    const warnings = text.match(/\[(?:W|E)_[A-Z_]+\]/g);
    if (!warnings || warnings.length === 0) return;
    for (const w of warnings) {
      ctx.ui.notify(`hashline-edit: ${w}`, "info");
    }
  });

  // ─── Debug mode ────────────────────────────────────────────────

  const debugValue = process.env.PI_HASHLINE_DEBUG;
  if (debugValue === "1" || debugValue === "true") {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify("Hashline Edit mode active", "info");
    });
  }
}
