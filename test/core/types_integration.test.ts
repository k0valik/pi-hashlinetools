import { isRecord } from "../../src/types";
import { describe, expect, it } from "vitest";

describe("pi-hashline-edit types integration", () => {
  it("should correctly identify records as used in pi-hashline-edit", () => {
    // pi-hashline-edit uses isRecord to check request and args
    expect(isRecord({ path: "foo.ts", edits: [] })).toBe(true);
    expect(isRecord({ someOption: true })).toBe(true);

    // Negative cases
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord(123)).toBe(false);
  });
});
