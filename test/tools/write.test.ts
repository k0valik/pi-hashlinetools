import { readFile } from "node:fs/promises";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import {
  assertWriteRequest,
  registerWriteTool,
  writeToolSchema,
} from "../../src/write";
import { makeFakePiRegistry, withTempFile } from "../support/fixtures";

describe("assertWriteRequest", () => {
  it("accepts a valid write request", () => {
    expect(() =>
      assertWriteRequest({
        path: "a.ts",
        content: "export {};\n",
      }),
    ).not.toThrow();
  });
});

describe("registerWriteTool", () => {
  it("accepts writes with extra properties via additionalProperties", () => {
    // intent/rationale were removed from schema - still accepted via
    // additionalProperties: true.
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(writeToolSchema as any);
    const validWrite = {
      path: "a.ts",
      content: "export {};\n",
    };

    expect(validate(validWrite)).toBe(true);

    // Extra properties are tolerated (additionalProperties: true)
    expect(
      validate({
        ...validWrite,
        intent: "test",
        rationale: "test",
        extra: "nope",
      }),
    ).toBe(true);
  });

  it("silently accepts intent/rationale without rendering provenance", () => {
    // Provenance rendering was removed - intent/rationale accepted via
    // additionalProperties but not displayed.
    const { pi, getTool } = makeFakePiRegistry();
    registerWriteTool(pi);
    const writeTool = getTool("write");
    const theme = {
      bold: (text: string) => text,
      fg: (_token: string, text: string) => text,
    };

    const component = writeTool.renderCall(
      {
        path: "sample.txt",
        content: "hello\n",
        intent: "Create the greeting file.",
        rationale: "The requested output needs this file.",
      },
      theme,
      {
        argsComplete: false,
        state: {},
        cwd: process.cwd(),
        expanded: false,
        lastComponent: undefined,
        invalidate() {},
      },
    ) as { render: (width: number) => string[] };

    const rendered = component.render(200).join("\n");
    expect(rendered).toContain("write sample.txt");
    // Provenance rendering was stripped
    expect(rendered).not.toContain("Write provenance");
    expect(rendered).not.toContain("Intent:");
    expect(rendered).not.toContain("Rationale:");
  });

  it("delegates execution to the built-in write tool", async () => {
    await withTempFile("sample.txt", "old\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerWriteTool(pi);
      const writeTool = getTool("write");

      await writeTool.execute(
        "w1",
        {
          path: "sample.txt",
          content: "new\n",
          intent: "Replace the file with the requested content.",
          rationale: "The write tool is appropriate for full-file replacement.",
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(await readFile(path, "utf-8")).toBe("new\n");
    });
  });
});
