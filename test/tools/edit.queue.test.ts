import { readFile, symlink } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fullHashRef, withTempFile } from "../support/fixtures";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...original,
    withFileMutationQueue: vi.fn(
      async (_path: string, work: () => Promise<unknown>) => {
        return work();
      },
    ),
  };
});

vi.mock("../../src/read", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/read")>();
  return {
    ...original,
    formatHashlineReadPreview: (text: string) => ({ text }),
  };
});

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { registerEditTool } from "../../src/edit";

function makeFakeRegistry() {
  const tools = new Map<string, any>();
  const pi = {
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    on() {},
  } as any;
  registerEditTool(pi);
  const tool = tools.get("edit");
  if (!tool) throw new Error("Tool not registered: edit");
  return { tool };
}

describe("edit tool file mutation queue", () => {
  beforeEach(() => {
    vi.mocked(withFileMutationQueue).mockClear();
  });

  it("uses the same queue key for repeated edits to the same path", async () => {
    await withTempFile(
      "race.ts",
      "alpha\nbeta\ngamma\n",
      async ({ cwd, path }) => {
        const { tool } = makeFakeRegistry();
        const ctx = { cwd };

        await tool.execute(
          "call-1",
          {
            path: "race.ts",
            edits: [
              {
                range: [
                  fullHashRef(["alpha", "beta", "gamma"], 1),
                  fullHashRef(["alpha", "beta", "gamma"], 1),
                ],
                lines: ["ALPHA"],
              },
            ],
          },
          undefined,
          undefined,
          ctx,
        );
        await tool.execute(
          "call-2",
          {
            path: "race.ts",
            edits: [
              {
                range: [
                  fullHashRef(["ALPHA", "beta", "gamma"], 2),
                  fullHashRef(["ALPHA", "beta", "gamma"], 2),
                ],
                lines: ["BETA"],
              },
            ],
          },
          undefined,
          undefined,
          ctx,
        );

        const queueKeys = vi
          .mocked(withFileMutationQueue)
          .mock.calls.map(([key]) => key);
        const finalContent = await readFile(path, "utf-8");

        expect({ finalContent, queueKeys }).toEqual({
          finalContent: "ALPHA\nBETA\ngamma\n",
          queueKeys: [path, path],
        });
      },
    );
  });

  it("canonicalizes the queue key when a symlink points at the same file", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withTempFile(
      "race.ts",
      "alpha\nbeta\ngamma\n",
      async ({ cwd, path }) => {
        await symlink("race.ts", `${cwd}/linked-race.ts`);

        const { tool } = makeFakeRegistry();
        const ctx = { cwd };

        await tool.execute(
          "call-1",
          {
            path: "race.ts",
            edits: [
              {
                range: [
                  fullHashRef(["alpha", "beta", "gamma"], 1),
                  fullHashRef(["alpha", "beta", "gamma"], 1),
                ],
                lines: ["ALPHA"],
              },
            ],
          },
          undefined,
          undefined,
          ctx,
        );
        await tool.execute(
          "call-2",
          {
            path: "linked-race.ts",
            edits: [
              {
                range: [
                  fullHashRef(["ALPHA", "beta", "gamma"], 2),
                  fullHashRef(["ALPHA", "beta", "gamma"], 2),
                ],
                lines: ["BETA"],
              },
            ],
          },
          undefined,
          undefined,
          ctx,
        );

        const queueKeys = vi
          .mocked(withFileMutationQueue)
          .mock.calls.map(([key]) => key);
        const finalContent = await readFile(path, "utf-8");

        expect({ finalContent, queueKeys }).toEqual({
          finalContent: "ALPHA\nBETA\ngamma\n",
          queueKeys: [path, path],
        });
      },
    );
  });

  it("canonicalizes the queue key when a parent directory is a symlink", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withTempFile(
      "race.ts",
      "alpha\nbeta\ngamma\n",
      async ({ cwd, path }) => {
        await symlink(".", `${cwd}/aliasdir`);

        const { tool } = makeFakeRegistry();
        const ctx = { cwd };

        await tool.execute(
          "call-1",
          {
            path: "race.ts",
            edits: [
              {
                range: [
                  fullHashRef(["alpha", "beta", "gamma"], 1),
                  fullHashRef(["alpha", "beta", "gamma"], 1),
                ],
                lines: ["ALPHA"],
              },
            ],
          },
          undefined,
          undefined,
          ctx,
        );
        await tool.execute(
          "call-2",
          {
            path: "aliasdir/race.ts",
            edits: [
              {
                range: [
                  fullHashRef(["ALPHA", "beta", "gamma"], 2),
                  fullHashRef(["ALPHA", "beta", "gamma"], 2),
                ],
                lines: ["BETA"],
              },
            ],
          },
          undefined,
          undefined,
          ctx,
        );

        const queueKeys = vi
          .mocked(withFileMutationQueue)
          .mock.calls.map(([key]) => key);
        const finalContent = await readFile(path, "utf-8");

        expect({ finalContent, queueKeys }).toEqual({
          finalContent: "ALPHA\nBETA\ngamma\n",
          queueKeys: [path, path],
        });
      },
    );
  });
});
