import { describe, expect, it, vi } from "vitest";
import register from "../../index";
import { formatHashlineReadPreview } from "../../src/read";
import { makeFakePiRegistry, withTempFile } from "../support/fixtures";

vi.mock("../../src/file-kind", () => ({
  loadFileKindAndText: vi.fn(),
  classifyFileKind: vi.fn(),
}));

import * as fileKindMod from "../../src/file-kind";

/**
 *  rename read tool's `raw` parameter to `plain`.
 *
 * The previous name `raw` was a poorly-named escape hatch. "Plain" is
 * positive framing — the model says `plain: true` to opt out of the
 * hashline-anchored preview. Default (false) = anchored (current
 * behavior).
 */
describe("read tool `plain` parameter ( )", () => {
  it("formatHashlineReadPreview with `plain: true` returns text without line-number prefixes", () => {
    const result = formatHashlineReadPreview("alpha\nbeta", {
      offset: 1,
      plain: true,
    });
    expect(result.text).toBe("alpha\nbeta");
    expect(result.text).not.toContain("│");
  });

  it("formatHashlineReadPreview with `plain: false` (default) returns anchored format", () => {
    const result = formatHashlineReadPreview("alpha\nbeta", {
      offset: 1,
      plain: false,
    });
    expect(result.text).toMatch(/1[A-Za-z0-9_-]{3}│alpha/);
    expect(result.text).toMatch(/2[A-Za-z0-9_-]{3}│beta/);
  });

  it("formatHashlineReadPreview with no `plain` arg defaults to anchored (anchored = default)", () => {
    const result = formatHashlineReadPreview("alpha\nbeta", { offset: 1 });
    expect(result.text).toMatch(/1[A-Za-z0-9_-]{3}│alpha/);
    expect(result.text).toMatch(/2[A-Za-z0-9_-]{3}│beta/);
  });

  it("the registered read tool's schema accepts `plain: true` and returns plain text", async () => {
    await withTempFile("plain.txt", "alpha\nbeta\n", async ({ cwd }) => {
      vi.mocked(fileKindMod.loadFileKindAndText).mockResolvedValue({
        kind: "text",
        text: "alpha\nbeta\n",
      });
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const readTool = getTool("read");

      const result = await readTool.execute(
        "r1",
        { path: "plain.txt", plain: true },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe("alpha\nbeta");
      expect(result.content[0].text).not.toContain("│");
    });
  });

  it("the registered read tool's schema rejects the old `raw` parameter (renamed away)", async () => {
    await withTempFile("raw.txt", "alpha\nbeta\n", async ({ cwd }) => {
      vi.mocked(fileKindMod.loadFileKindAndText).mockResolvedValue({
        kind: "text",
        text: "alpha\nbeta\n",
      });
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const readTool = getTool("read");

      // The schema field was renamed; the validator should reject the
      // old name. Behavior: the read falls back to anchored format
      // (or the schema throws — either way, `raw` is not honored).
      const result = await readTool.execute(
        "r1",
        { path: "raw.txt", raw: true } as any,
        undefined,
        undefined,
        { cwd } as any,
      );

      // We expect anchored output (raw:true silently ignored) or a thrown
      // validation error. Either way, the text is NOT plain — the old
      // name is no longer wired up.
      const text = result.content[0]?.text ?? "";
      // If we got a result, it must not be the plain output.
      if (text) {
        expect(text).not.toBe("alpha\nbeta");
      }
    });
  });
});
