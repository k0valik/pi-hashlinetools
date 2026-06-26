import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  type AnchorMedleyArgs,
  runAnchorMedley,
} from "../../src/edit-strategies";
import { computePublicLineChecksum } from "../../src/line-ref";

describe("runAnchorMedley - Rigorous Testing", () => {
  const filler = Array(100).fill("filler");

  function makeArgs(overrides: Partial<AnchorMedleyArgs>): AnchorMedleyArgs {
    const fileLines = overrides.fileLines ?? [...filler];
    return {
      fileLines,
      visibleLineCount: fileLines.length,
      expectedLine: overrides.expectedLine ?? 50,
      contentHint: overrides.contentHint ?? "target",
      rawBuffer:
        overrides.rawBuffer ??
        Buffer.from(fileLines.join("\n") + "\n", "utf-8"),
      checksum: overrides.checksum,
    };
  }

  describe("Tiered Agreement Rules", () => {
    it("Fast Path: 0-line shift accepted immediately", () => {
      const fileLines = [...filler];
      fileLines[49] = "target";
      const args = makeArgs({
        fileLines,
        expectedLine: 50,
        contentHint: "target",
      });
      const result = runAnchorMedley(args);
      expect(result.outcome).toBe("applied");
      expect(result.candidate).toBe(50);
      expect(result.strategies).toHaveLength(1);
      expect(result.strategies[0]?.name).toBe("layer2-fuzzy");
    });

    it("Fast Path: 1-line shift accepted immediately", () => {
      const fileLines = [...filler];
      fileLines[50] = "target"; // actually at 51
      const args = makeArgs({
        fileLines,
        expectedLine: 50,
        contentHint: "target",
      });
      const result = runAnchorMedley(args);
      expect(result.outcome).toBe("relocated");
      expect(result.candidate).toBe(51);
      expect(result.strategies).toHaveLength(1);
    });

    it("Corroboration: 2-10 line shift triggers Layer 5", () => {
      const fileLines = [...filler];
      fileLines[54] = "target"; // at 55 (+5 shift)
      const args = makeArgs({
        fileLines,
        expectedLine: 50,
        contentHint: "target",
      });
      const result = runAnchorMedley(args);
      expect(result.outcome).toBe("relocated");
      expect(result.candidate).toBe(55);
      const names = result.strategies.map((s) => s.name);
      expect(names).toContain("layer2-fuzzy");
      expect(names).toContain("layer5-byte");
    });

    it("Full Medley: >10 line shift", () => {
      const fileLines = [...filler];
      fileLines[70] = "target"; // at 71 (+21 shift)
      const args = makeArgs({
        fileLines,
        expectedLine: 50,
        contentHint: "target",
      });
      const result = runAnchorMedley(args);
      expect(result.outcome).toBe("relocated");
      expect(result.candidate).toBe(71);
      // It uses Layer 2 if it's within radius (40), but doesn't necessarily stop there.
    });

    it("Full Medley: Layer 2 fails (outside radius), Layer 5 succeeds", () => {
      const fileLines = Array(150).fill("filler");
      fileLines[140] = "target"; // at 141 (+91 shift, > 40 radius)
      const args = makeArgs({
        fileLines,
        expectedLine: 50,
        contentHint: "target",
      });
      const result = runAnchorMedley(args);
      expect(result.outcome).toBe("relocated");
      expect(result.candidate).toBe(141);
      const names = result.strategies.map((s) => s.name);
      expect(names).toContain("layer2-fuzzy");
      expect(names).toContain("layer5-byte");
      expect(
        result.strategies.find((s) => s.name === "layer2-fuzzy")?.candidate,
      ).toBeNull();
      expect(
        result.strategies.find((s) => s.name === "layer5-byte")?.candidate,
      ).toBe(141);
    });
  });

  describe("Layer 4 (Hash Index)", () => {
    it("relocates using checksum when contentHint is missing", () => {
      const fileLines = ["a", "b", "c", "d"];
      const checksum = computePublicLineChecksum(fileLines, 3); // "c" at line 3
      const args = makeArgs({
        fileLines,
        expectedLine: 1,
        contentHint: "",
        checksum,
      });
      const result = runAnchorMedley(args);
      expect(result.outcome).toBe("relocated");
      expect(result.candidate).toBe(3);
      expect(result.strategies.some((s) => s.name === "layer4-hash")).toBe(
        true,
      );
    });

    it("is skipped when contentHint is present and Layer 2 succeeds", () => {
      const fileLines = ["a", "b", "c", "d"];
      const checksum = computePublicLineChecksum(fileLines, 3);
      const args = makeArgs({
        fileLines,
        expectedLine: 3,
        contentHint: "c",
        checksum,
      });
      const result = runAnchorMedley(args);
      expect(result.strategies.some((s) => s.name === "layer4-hash")).toBe(
        false,
      );
    });
  });

  describe("Fuzzing/Threshold Constants Verification", () => {
    it("respects FUZZY_RADIUS (40)", () => {
      const fileLines = Array(100).fill("filler");
      fileLines[90] = "target"; // at 91, shift 41 from 50
      const args = makeArgs({
        fileLines,
        expectedLine: 50,
        contentHint: "target",
      });
      const result = runAnchorMedley(args);
      // Layer 2 should fail because 91 is outside [50-40, 50+40] = [10, 90]
      const l2 = result.strategies.find((s) => s.name === "layer2-fuzzy");
      expect(l2?.candidate).toBeNull();
      // But Layer 5 should still find it
      expect(result.candidate).toBe(91);
    });

    it("handles boundary of FUZZY_RADIUS", () => {
      const fileLines = Array(100).fill("filler");
      fileLines[89] = "target"; // at 90, shift 40 from 50. 90 is IN [10, 90]
      const args = makeArgs({
        fileLines,
        expectedLine: 50,
        contentHint: "target",
      });
      const result = runAnchorMedley(args);
      const l2 = result.strategies.find((s) => s.name === "layer2-fuzzy");
      expect(l2?.candidate).toBe(90);
    });
  });
});
