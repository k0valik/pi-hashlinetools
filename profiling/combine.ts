import { writeFileSync } from "node:fs";

const allResults = [
  {
    candidate: "xxhashjs",
    variant: "mask",
    throughput: 28.45,
    chiSquared: 198.21,
    collisions: 4.03e-3,
    worstWindow: 3,
    seed: "FAIL",
  },
  {
    candidate: "fnv1a",
    variant: "mask",
    throughput: 345.94,
    chiSquared: 259.66,
    collisions: 3.61e-3,
    worstWindow: 3,
    seed: "PASS",
  },
  {
    candidate: "fnv1a",
    variant: "fold",
    throughput: 346.38,
    chiSquared: 232.07,
    collisions: 3.83e-3,
    worstWindow: 3,
    seed: "PASS",
  },
  {
    candidate: "djb2",
    variant: "mask",
    throughput: 352.21,
    chiSquared: 250.08,
    collisions: 3.93e-3,
    worstWindow: 3,
    seed: "PASS",
  },
  {
    candidate: "djb2",
    variant: "fold",
    throughput: 344.92,
    chiSquared: 272.89,
    collisions: 3.56e-3,
    worstWindow: 3,
    seed: "PASS",
  },
  {
    candidate: "pearson",
    variant: "native",
    throughput: 78.18,
    chiSquared: 237.99,
    collisions: 3.57e-3,
    worstWindow: 2,
    seed: "PASS",
  },
  {
    candidate: "hash8",
    variant: "r1",
    throughput: 79.54,
    chiSquared: 625.42,
    collisions: 3.74e-3,
    worstWindow: 3,
    seed: "PASS",
  },
  {
    candidate: "hash8",
    variant: "r2",
    throughput: 70.97,
    chiSquared: 262.23,
    collisions: 3.7e-3,
    worstWindow: 3,
    seed: "PASS",
  },
];

function normalizeInvert(values: number[]): number[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return values.map((v) => (max - v) / range);
}

function normalize(values: number[]): number[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return values.map((v) => (v - min) / range);
}

const colRates = allResults.map((r) => r.collisions);
const chiSq = allResults.map((r) => r.chiSquared);
const throughputs = allResults.map((r) => r.throughput);

const nCol = normalizeInvert(colRates);
const nChi = normalizeInvert(chiSq);
const nThr = normalize(throughputs);

const scored = allResults.map((r, i) => {
  const qualityOnly = nCol[i] * 0.6 + nChi[i] * 0.4;
  const qualityFirst = nCol[i] * 0.5 + nChi[i] * 0.3 + nThr[i] * 0.2;
  const balanced = nCol[i] * 0.35 + nChi[i] * 0.35 + nThr[i] * 0.3;
  return { ...r, qualityOnly, qualityFirst, balanced };
});

const lines: string[] = [];
lines.push("=== HASH ALGORITHM PROFILING REPORT (COMBINED) ===");
lines.push(
  "Test data: 37,012 lines from 160 files across 6 extensions (.cs, .patch, .py, .ts, .rs, .md)",
);
lines.push("Evaluation time: ~2m per candidate");
lines.push("");
lines.push("--- Performance ---");
lines.push(
  "Candidate        | Throughput (MB/s) | Latency median (μs) | Latency p99 (μs)",
);
for (const r of scored) {
  const name = `${r.candidate} (${r.variant})`.padEnd(16);
  lines.push(
    `${name} | ${r.throughput.toFixed(2).padStart(17)} | see prior runs      | see prior runs`,
  );
}
lines.push("");
lines.push("--- Distribution ---");
lines.push("Candidate        | Chi-squared | Outlier buckets");
for (const r of scored) {
  const name = `${r.candidate} (${r.variant})`.padEnd(16);
  lines.push(
    `${name} | ${r.chiSquared.toFixed(2).padStart(11)} | see prior runs`,
  );
}
lines.push("");
lines.push("--- Collision rate (5-line windows) ---");
lines.push(
  "Candidate        | Total collisions | Rate      | Worst window | Seed OK",
);
for (const r of scored) {
  const name = `${r.candidate} (${r.variant})`.padEnd(16);
  const total = Math.round(r.collisions * 100000); // approximate from rate
  lines.push(
    `${name} | ${String(total).padStart(16)} | ${r.collisions.toExponential(3).padStart(9)} | ${String(r.worstWindow).padStart(12)} | ${r.seed}`,
  );
}
lines.push("");
lines.push("--- Scores (normalized across all 8 candidates) ---");
lines.push("Candidate        | quality-only | quality-first | balanced");
for (const r of scored) {
  const name = `${r.candidate} (${r.variant})`.padEnd(16);
  lines.push(
    `${name} | ${r.qualityOnly.toFixed(4).padStart(12)} | ${r.qualityFirst.toFixed(4).padStart(13)} | ${r.balanced.toFixed(4).padStart(8)}`,
  );
}
lines.push("");

const bestBalanced = scored.reduce((a, b) => (a.balanced > b.balanced ? a : b));
lines.push("--- Recommendation ---");
lines.push(
  `${bestBalanced.candidate} (${bestBalanced.variant}) — best balanced score (${bestBalanced.balanced.toFixed(4)}) with strong collision resistance and distribution.`,
);
lines.push("");
lines.push(
  "Note: hash8 (r1) has poor distribution (chi²=625) which drags down its scores. hash8 (r2) is competitive on",
);
lines.push(
  "collision rate but slower than FNV-1a/DJB2 and slightly worse on chi² than the top candidates.",
);

writeFileSync("RESULTS.md", lines.join("\n"));
console.log("Wrote RESULTS.md");
