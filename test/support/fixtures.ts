import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { formatPublicLineRef } from "../../src/line-ref";

async function getWritableTempRoot(): Promise<string> {
  const fallback = join(process.cwd(), ".tmp");
  await mkdir(fallback, { recursive: true });
  return fallback;
}

export async function withTempFile(
  name: string,
  content: string,
  run: (args: { cwd: string; path: string }) => Promise<void>,
): Promise<void> {
  const tempRoot = await getWritableTempRoot();
  const cwd = await mkdtemp(join(tempRoot, "pi-hashline-test-"));
  const path = join(cwd, name);
  try {
    await writeFile(path, content, "utf-8");
    await run({ cwd, path });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

export function makeFakePiRegistry() {
  const tools = new Map<string, any>();
  return {
    pi: {
      registerTool(tool: any) {
        tools.set(tool.name, tool);
      },
      on() {},
    } as any,
    getTool(name: string) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool not registered: ${name}`);
      return tool;
    },
  };
}

export function fullHashRef(fileLines: string[], lineNumber: number): string {
  return `${formatPublicLineRef(fileLines, lineNumber)}│${fileLines[lineNumber - 1] ?? ""}`;
}

/**
 * Per the v2 plan, the edit tool's dry-run refuses the whole batch with a
 * noop response (containing per-edit evidence warnings) when any edit
 * fails or is ambiguous — instead of throwing. This helper asserts the
 * noop + warning pattern: classification is "noop" and the text contains
 * the expected error code.
 */
export function expectRefusedWithError(
  result: {
    details?: { metrics?: { classification?: string } };
    content?: Array<{ type: string; text?: string }>;
  },
  errorCode: RegExp,
): void {
  expect(result.details?.metrics?.classification).toBe("noop");
  const text = result.content?.[0]?.text ?? "";
  expect(text).toMatch(errorCode);
}
