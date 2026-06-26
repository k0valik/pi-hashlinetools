import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { appendAutoRead } from "../..";
import { hashlineEditToolSchema } from "../../src/edit";
import { formatHashlineRegion } from "../../src/hashline";

const PATTERN =
  /^\s*[>+-]*\s*\d+(?:#[A-Za-z0-9_-]{3}|[A-Za-z0-9_-]{3}|[0-9a-fA-F]{2}|[a-z]|#[0-9A-F]{2})(?:\s*[│|].*)?\s*$/;

const schema = hashlineEditToolSchema;

describe("FULL_ENDPOINT_REF_PATTERN accepts all emit forms", () => {
  it("accepts the read tool's no-# form (e.g. 12r-│line one)", () => {
    expect("12r-│line one").toMatch(PATTERN);
    expect("23rt│line two").toMatch(PATTERN);
    expect("100abc│    return value").toMatch(PATTERN);
  });

  it("accepts the auto-read # form (e.g. 1#2r-│line one)", () => {
    expect("1#2r-│line one").toMatch(PATTERN);
    expect("42#Xy0│const value = 1;").toMatch(PATTERN);
    expect("100#abc│    return value").toMatch(PATTERN);
  });

  it("accepts legacy 2-char hex with and without #", () => {
    expect("42ab│line").toMatch(PATTERN);
    // Legacy 2-char hex with # requires uppercase hex (pre-existing constraint)
    expect("42#AB│line").toMatch(PATTERN);
  });

  it("accepts legacy single-letter form", () => {
    expect("42f│line").toMatch(PATTERN);
  });

  it("accepts bare compact refs without content hint (e.g. 42#Xy0)", () => {
    expect("42#Xy0").toMatch(PATTERN);
    expect("42Xy0").toMatch(PATTERN);
    expect("42ab").toMatch(PATTERN);
    expect("42f").toMatch(PATTERN);
  });

  it("rejects malformed anchors", () => {
    expect("hello│world").not.toMatch(PATTERN);
    expect("42│line").not.toMatch(PATTERN);
    expect("42@xy│line").not.toMatch(PATTERN);
  });
});

describe("appendAutoRead edge cases", () => {
  it("returns undefined for an empty file", async () => {
    const event = {
      content: [{ type: "text", text: "ok" }],
      input: { path: "/tmp/pi-hashline-edit-empty-test.txt" },
    } as any;
    const { mkdir, writeFile, rm } = await import("node:fs/promises");
    await mkdir("/tmp", { recursive: true });
    await writeFile("/tmp/pi-hashline-edit-empty-test.txt", "");
    try {
      const result = await appendAutoRead(event, { cwd: "/tmp" });
      expect(result).toBeUndefined();
    } finally {
      await rm("/tmp/pi-hashline-edit-empty-test.txt");
    }
  });

  it("returns appended content for a non-empty file", async () => {
    const { mkdir, writeFile, rm } = await import("node:fs/promises");
    await mkdir("/tmp", { recursive: true });
    await writeFile("/tmp/pi-hashline-edit-test.txt", "alpha\nbeta\n");
    try {
      const event = {
        content: [{ type: "text", text: "ok" }],
        input: { path: "/tmp/pi-hashline-edit-test.txt" },
      } as any;
      const result = await appendAutoRead(event, { cwd: "/tmp" });
      expect(result).toBeDefined();
      expect(result?.content).toHaveLength(2);
      // formatHashlineRegion uses #-form: alpha\nbeta → "1#abc│alpha\n2#def│beta"
      const appended = result?.content?.[1];
      if (appended?.type !== "text") throw new Error("expected text content");
      expect(appended.text).toContain("1#");
      expect(appended.text).toContain("alpha");
    } finally {
      await rm("/tmp/pi-hashline-edit-test.txt");
    }
  });
});

describe("computeLineHash is content-only", () => {
  it("hash of a line does not depend on its neighbors", async () => {
    const { computeLineHash } = await import("../../src/hashline");
    const linesA = ["alpha", "beta", "gamma"];
    const linesB = ["ALPHA-CHANGED", "beta", "GAMMA-CHANGED"];
    expect(computeLineHash(linesA, 1)).toBe(computeLineHash(linesB, 1));
  });
});
