import { writeFileSync } from "node:fs";

// Original 6-candidate bounds (fixed reference so adding new candidates doesn't shift old scores)
const BOUNDS = {
  chiSq: { min: 198.21, max: 272.89 },
  collision: { min: 3.56e-3, max: 4.03e-3 },
  throughput: { min: 28.45, max: 352.21 },
};

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function normInvert(value: number, min: number, max: number): number {
  return clamp01((max - value) / (max - min));
}

function norm(value: number, min: number, max: number): number {
  return clamp01((value - min) / (max - min));
}

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
  // New candidates (charCodeAt-optimized)
  {
    candidate: "hash8",
    variant: "r1",
    throughput: 332.23,
    chiSquared: 625.57,
    collisions: 3.71e-3,
    worstWindow: 3,
    seed: "PASS",
  },
  {
    candidate: "hash8",
    variant: "r2",
    throughput: 298.86,
    chiSquared: 261.48,
    collisions: 3.67e-3,
    worstWindow: 3,
    seed: "FAIL*",
  },
];

const scored = allResults.map((r) => {
  const nCol = normInvert(
    r.collisions,
    BOUNDS.collision.min,
    BOUNDS.collision.max,
  );
  const nChi = normInvert(r.chiSquared, BOUNDS.chiSq.min, BOUNDS.chiSq.max);
  const nThr = norm(r.throughput, BOUNDS.throughput.min, BOUNDS.throughput.max);
  const qualityOnly = nCol * 0.6 + nChi * 0.4;
  const qualityFirst = nCol * 0.5 + nChi * 0.3 + nThr * 0.2;
  const balanced = nCol * 0.35 + nChi * 0.35 + nThr * 0.3;
  return { ...r, nCol, nChi, nThr, qualityOnly, qualityFirst, balanced };
});

scored.sort((a, b) => b.balanced - a.balanced);

const lines: string[] = [];
lines.push("=== HASH ALGORITHM PROFILING REPORT (COMBINED) ===");
lines.push(
  "Test data: 37,012 lines from 160 files across 6 extensions (.cs, .patch, .py, .ts, .rs, .md)",
);
lines.push("Evaluation time: ~2m per candidate");
lines.push("");
lines.push(
  "NOTE: Scores are normalized against the original 6-candidate bounds so earlier",
);
lines.push(
  "results remain stable. New candidates are placed on the same objective scale.",
);
lines.push(
  "* hash8 (r2) seed sensitivity is marginal (7/10 clean windows) with charCodeAt.",
);
lines.push("");

lines.push("--- Performance ---");
lines.push(
  "Candidate        | Throughput (MB/s) | Latency median (μs) | Latency p99 (μs)",
);
for (const r of scored) {
  const name = `${r.candidate} (${r.variant})`.padEnd(16);
  lines.push(
    `${name} | ${r.throughput.toFixed(2).padStart(17)} | see full runs      | see full runs`,
  );
}
lines.push("");

lines.push("--- Distribution ---");
lines.push("Candidate        | Chi-squared | Outlier buckets");
for (const r of scored) {
  const name = `${r.candidate} (${r.variant})`.padEnd(16);
  lines.push(
    `${name} | ${r.chiSquared.toFixed(2).padStart(11)} | see full runs`,
  );
}
lines.push("");

lines.push("--- Collision rate (5-line windows) ---");
lines.push(
  "Candidate        | Total collisions | Rate      | Worst window | Seed OK",
);
for (const r of scored) {
  const name = `${r.candidate} (${r.variant})`.padEnd(16);
  const total = Math.round(r.collisions * 100000);
  lines.push(
    `${name} | ${String(total).padStart(16)} | ${r.collisions.toExponential(3).padStart(9)} | ${String(r.worstWindow).padStart(12)} | ${r.seed}`,
  );
}
lines.push("");

lines.push("--- Scores (normalized against original 6-candidate bounds) ---");
lines.push("Candidate        | quality-only | quality-first | balanced");
for (const r of scored) {
  const name = `${r.candidate} (${r.variant})`.padEnd(16);
  lines.push(
    `${name} | ${r.qualityOnly.toFixed(4).padStart(12)} | ${r.qualityFirst.toFixed(4).padStart(13)} | ${r.balanced.toFixed(4).padStart(8)}`,
  );
}
lines.push("");

const best = scored[0];
lines.push("--- Recommendation ---");
lines.push(
  `${best.candidate} (${best.variant}) — best balanced score (${best.balanced.toFixed(4)}) on the original scale.`,
);
lines.push("");
lines.push("Key findings:");
lines.push(
  "- TextEncoder().encode() was the throughput bottleneck for the discovered hashes.",
);
lines.push(
  "  Switching to charCodeAt (consistent with FNV-1a/DJB2) raised hash8 (r1) from ~80 to ~332 MB/s.",
);
lines.push(
  "- hash8 (r2) has competitive collision rate (3.670e-3) but marginal seed sensitivity (7/10).",
);
lines.push(
  "- hash8 (r1) has poor distribution (chi²=625) which heavily penalizes it under quality weights.",
);

writeFileSync("RESULTS.md", lines.join("\n"));
console.log("Wrote RESULTS.md");
