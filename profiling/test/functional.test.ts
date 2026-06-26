import { describe, expect, test } from "vitest";
import { testLines } from "../data/dev.js";
import { candidates } from "../src/hashLine.js";

const seedIndices = [1, 2, 3, 42, 999, 65535, 100000];

function mutationsFor(line: string): string[] {
  if (line.length === 0) return ["x"];
  const mid = Math.floor(line.length / 2);
  const muts: string[] = [];
  // start
  muts.push(`X${line.slice(1)}`);
  // middle
  muts.push(`${line.slice(0, mid)}X${line.slice(mid + 1)}`);
  // end
  muts.push(`${line.slice(0, -1)}X`);
  return muts;
}

for (const candidate of candidates) {
  describe(`${candidate.name} (${candidate.variant})`, () => {
    // ── 1. Stability ───────────────────────────────────────────────────────
    test("stability", () => {
      for (const line of testLines) {
        for (const idx of [0, 1, 42, 999, 65535]) {
          const h1 = candidate.fn(line, idx);
          const h2 = candidate.fn(line, idx);
          expect(h2).toBe(h1);
        }
      }
    });

    // ── 2. Seed sensitivity ────────────────────────────────────────────────
    test("seed sensitivity", () => {
      const lines = testLines.slice(0, 50);
      let totalPairs = 0;
      let differentPairs = 0;

      for (const line of lines) {
        for (let i = 0; i < seedIndices.length; i++) {
          for (let j = i + 1; j < seedIndices.length; j++) {
            const h1 = candidate.fn(line, seedIndices[i]);
            const h2 = candidate.fn(line, seedIndices[j]);
            totalPairs++;
            if (h1 !== h2) differentPairs++;
          }
        }
      }

      const ratio = totalPairs === 0 ? 0 : differentPairs / totalPairs;
      expect(ratio).toBeGreaterThanOrEqual(0.9);
    });

    // ── 3. Content sensitivity ─────────────────────────────────────────────
    test("content sensitivity", () => {
      let totalPairs = 0;
      let differentPairs = 0;

      for (const line of testLines) {
        for (const mut of mutationsFor(line)) {
          totalPairs++;
          if (candidate.fn(line, 1) !== candidate.fn(mut, 1)) {
            differentPairs++;
          }
        }
      }

      // extra edge case: empty ↔ non-empty
      totalPairs++;
      if (candidate.fn("", 1) !== candidate.fn("x", 1)) {
        differentPairs++;
      }

      const ratio = totalPairs === 0 ? 0 : differentPairs / totalPairs;
      expect(ratio).toBeGreaterThanOrEqual(0.8);
    });

    // ── 4. Range ───────────────────────────────────────────────────────────
    test("range", () => {
      for (const line of testLines) {
        for (const idx of [0, 1, 42, 999, 65535]) {
          const h = candidate.fn(line, idx);
          expect(h).toBeGreaterThanOrEqual(0);
          expect(h).toBeLessThanOrEqual(255);
        }
      }
    });
  });
}
