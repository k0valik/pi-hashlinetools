import { readFileSync, writeFileSync } from "node:fs";

const raw = JSON.parse(readFileSync("raw-results.json", "utf-8"));

const BASELINE = {
  collisionRate: 1 / 256,
  chiSquared: 255,
  throughputMBps: 100,
};

function makePreset(name: string, throughputWeight: number) {
  const remaining = 1 - throughputWeight;
  const distribution = remaining / 3;
  const collision = remaining - distribution;
  return {
    name,
    weights: { collision, distribution, throughput: throughputWeight },
  };
}

const PRESETS = [
  makePreset("quality-only", 0.0),
  makePreset("quality-first", 0.2),
  makePreset("balanced", 0.3),
];

const scores = raw.results.map((r: any) => {
  const throughput = r.throughputMBps / BASELINE.throughputMBps;
  const distribution = BASELINE.chiSquared / r.chiSquared;
  const collision = BASELINE.collisionRate / r.collisionRate5;

  return {
    candidate: r.candidate,
    variant: r.variant,
    throughput,
    distribution,
    collision,
    qualityOnly:
      collision * PRESETS[0].weights.collision +
      distribution * PRESETS[0].weights.distribution +
      throughput * PRESETS[0].weights.throughput,
    qualityFirst:
      collision * PRESETS[1].weights.collision +
      distribution * PRESETS[1].weights.distribution +
      throughput * PRESETS[1].weights.throughput,
    balanced:
      collision * PRESETS[2].weights.collision +
      distribution * PRESETS[2].weights.distribution +
      throughput * PRESETS[2].weights.throughput,
  };
});

const lines: string[] = [];
lines.push("# Hash Algorithm Evaluation Report");
lines.push("");

lines.push("## Dataset");
lines.push(`- **Lines**: ${raw.meta.lines.toLocaleString()}`);
lines.push(`- **Files**: ${raw.meta.files}`);
lines.push(`- **Extensions**: ${raw.meta.extensions.join(", ")}`);
lines.push(
  `- **Target per candidate**: ~${Math.round(raw.meta.durationSec / 60)} min`,
);
lines.push("");

lines.push("## Baselines");
lines.push("| Metric | Baseline value | Rationale |");
lines.push("|--------|---------------:|-----------|");
lines.push(
  `| Collision rate (5-line) | ${BASELINE.collisionRate.toExponential(3)} | Birthday bound: 1/256 for 8-bit output |`,
);
lines.push(
  `| Chi-squared | ${BASELINE.chiSquared} | Expected for uniform 256-bin distribution (df=255) |`,
);
lines.push(
  `| Throughput | ${BASELINE.throughputMBps} MB/s | Round practical target |`,
);
lines.push("");
lines.push(
  "Scores = candidate ÷ baseline for throughput; baseline ÷ candidate for collision & distribution. " +
    "A score of **1.0** means the candidate exactly meets the target. " +
    "Scores are independent of the candidate set — adding new hashes never shifts existing scores.",
);
lines.push("");

lines.push("## Raw Metrics");
lines.push("");
lines.push(
  "| Candidate | Throughput (MB/s) | Chi-squared | Collision rate (5-line) | Worst window | Seed OK |",
);
lines.push(
  "|-----------|------------------:|------------:|------------------------:|-------------:|:-------:|",
);
for (const r of raw.results) {
  lines.push(
    `| ${r.candidate} (${r.variant}) | ${r.throughputMBps.toFixed(2)} | ${r.chiSquared.toFixed(2)} | ${r.collisionRate5.toExponential(3)} | ${r.worstWindow5} | ${r.seedSensitivity ? "PASS" : "FAIL"} |`,
  );
}
lines.push("");

lines.push("## Baseline-Normalized Scores");
lines.push("");
lines.push("| Candidate | Throughput | Distribution | Collision |");
lines.push("|-----------|-----------:|-------------:|----------:|");
for (const s of scores) {
  lines.push(
    `| ${s.candidate} (${s.variant}) | ${s.throughput.toFixed(3)} | ${s.distribution.toFixed(3)} | ${s.collision.toFixed(3)} |`,
  );
}
lines.push("");

lines.push("## Composite Scores");
lines.push("");
lines.push(
  `Weights: collision ${PRESETS[2].weights.collision.toFixed(3)}, distribution ${PRESETS[2].weights.distribution.toFixed(3)}, throughput ${PRESETS[2].weights.throughput.toFixed(3)} (fixed 2:1 collision→distribution ratio).`,
);
lines.push("");
lines.push("| Candidate | quality-only | quality-first | balanced |");
lines.push("|-----------|-------------:|--------------:|---------:|");
const sorted = [...scores].sort((a: any, b: any) => b.balanced - a.balanced);
for (const s of sorted) {
  lines.push(
    `| ${s.candidate} (${s.variant}) | ${s.qualityOnly.toFixed(4)} | ${s.qualityFirst.toFixed(4)} | ${s.balanced.toFixed(4)} |`,
  );
}
lines.push("");

const best = sorted[0];
lines.push("## Recommendation");
lines.push("");
lines.push(
  `**${best.candidate} (${best.variant})** — best balanced score (${best.balanced.toFixed(4)}) against the arbitrary baselines.`,
);

writeFileSync("RESULTS.md", lines.join("\n"));
console.log("Wrote RESULTS.md");
