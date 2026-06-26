import { createReadStream, type Dir, writeFileSync } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { candidates } from "./src/hashLine.js";

// ── Types ───────────────────────────────────────────────────────────────────

interface LineEntry {
  line: string;
  index: number; // 1-based global index
}

interface EvalData {
  lines: LineEntry[];
  totalBytes: number;
  files: number;
  extensions: string[];
}

interface PerfResult {
  throughputMBps: number;
  latencyMedianUs: number;
  latencyP99Us: number;
}

interface DistResult {
  chiSquared: number;
  outlierBuckets: number;
}

interface CollisionResult {
  totalCollisions: number;
  collisionRate: number;
  worstWindow: number;
}

interface BenchmarkResult {
  candidate: string;
  variant: string;
  perf: PerfResult;
  dist: DistResult;
  collision: Record<number, CollisionResult>;
  seedSensitivity: boolean;
}

interface NormalizedScore {
  candidate: string;
  variant: string;
  throughput: number;
  distribution: number;
  collision: number;
  qualityOnly: number;
  qualityFirst: number;
  balanced: number;
}

// ── Arbitrary baselines ─────────────────────────────────────────────────────
//
// These are fixed targets, not derived from any candidate, so adding/removing
// hashes never shifts the scale.
//
// Collision: theoretical birthday bound for 8-bit output in 5-line windows.
//   5 lines → C(5,2)=10 pairs per window → expected rate = 1/256.
// Distribution: expected chi-squared for perfectly uniform 256 bins (df=255).
// Throughput: round practical target for a simple JS hash (MB/s).

const BASELINE = {
  collisionRate: 1 / 256, // ≈ 0.00390625
  chiSquared: 255,
  throughputMBps: 100,
};

// Fixed ratio: collision weights 2× distribution in every preset.
// Throughput share varies by preset.
function makePreset(name: string, throughputWeight: number) {
  const remaining = 1 - throughputWeight;
  const distribution = remaining / 3; // 1 part
  const collision = remaining - distribution; // 2 parts
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

// ── Data collection ─────────────────────────────────────────────────────────

const EVAL_DIRS: Record<string, string[]> = {
  ".cs": ["C:/Users/Jerry/Projects/Unity"],
  ".patch": ["C:/Users/Jerry/Projects/tModLoader"],
  ".py": ["C:/Users/Jerry/Projects/kimi-cli"],
  ".ts": ["C:/Users/Jerry/Projects/pi-mono"],
  ".rs": ["C:/Users/Jerry/Projects/Bevy"],
  ".md": [
    "C:/Users/Jerry/Projects/Unity",
    "C:/Users/Jerry/Projects/tModLoader",
    "C:/Users/Jerry/Projects/kimi-cli",
    "C:/Users/Jerry/Projects/pi-mono",
    "C:/Users/Jerry/Projects/Bevy",
  ],
};

const EXCLUDE_DIRS = new Set(["node_modules", ".git", "target", "Library"]);

async function* walkFiles(dir: string, ext: string): AsyncGenerator<string> {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let dh: Dir;
    try {
      dh = await opendir(cur);
    } catch {
      continue;
    }
    for await (const ent of dh) {
      const p = join(cur, ent.name);
      if (ent.isDirectory()) {
        if (!EXCLUDE_DIRS.has(ent.name)) stack.push(p);
      } else if (ent.isFile() && p.endsWith(ext)) {
        yield p;
      }
    }
  }
}

async function collectLinesForExt(
  ext: string,
  dirs: string[],
  minLines: number,
): Promise<{ lines: string[]; files: number; totalBytes: number }> {
  const lines: string[] = [];
  let files = 0;
  let totalBytes = 0;

  for (const dir of dirs) {
    for await (const file of walkFiles(dir, ext)) {
      const s = await stat(file);
      totalBytes += s.size;
      const stream = createReadStream(file, { encoding: "utf-8" });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      for await (const l of rl) {
        lines.push(l);
      }
      files++;
      if (lines.length >= minLines) break;
    }
    if (lines.length >= minLines) break;
  }
  return { lines, files, totalBytes };
}

async function buildEvalData(): Promise<EvalData> {
  const allLines: LineEntry[] = [];
  let totalFiles = 0;
  let totalBytes = 0;
  const extensions: string[] = [];

  for (const [ext, dirs] of Object.entries(EVAL_DIRS)) {
    const {
      lines,
      files,
      totalBytes: bytes,
    } = await collectLinesForExt(ext, dirs, 5000);
    for (const line of lines) {
      allLines.push({ line, index: allLines.length + 1 });
    }
    totalFiles += files;
    totalBytes += bytes;
    extensions.push(ext);
    console.error(
      `  ${ext}: ${lines.length.toLocaleString()} lines from ${files} files`,
    );
  }

  return { lines: allLines, totalBytes, files: totalFiles, extensions };
}

// ── Benchmark: Performance ──────────────────────────────────────────────────

function runPerf(
  fn: (line: string, lineIndex: number) => number,
  lines: LineEntry[],
  targetDurationSec: number,
): PerfResult {
  // Warm-up
  for (let i = 0; i < lines.length; i++) {
    fn(lines[i].line, lines[i].index);
  }

  const byteLengths = lines.map((e) => Buffer.byteLength(e.line, "utf-8"));
  const targetNs = BigInt(targetDurationSec) * 1_000_000_000n;
  let totalBytes = 0;

  const start = process.hrtime.bigint();
  while (true) {
    for (let i = 0; i < lines.length; i++) {
      fn(lines[i].line, lines[i].index);
      totalBytes += byteLengths[i];
    }
    const elapsed = process.hrtime.bigint() - start;
    if (elapsed >= targetNs) break;
  }
  const elapsedSec = Number(process.hrtime.bigint() - start) / 1e9;

  const sampleCount = Math.min(1_000_000, lines.length * 100);
  const latencies: number[] = new Array(sampleCount);
  let sampleIdx = 0;
  for (let pass = 0; pass < 100 && sampleIdx < sampleCount; pass++) {
    for (let i = 0; i < lines.length && sampleIdx < sampleCount; i++) {
      const t0 = process.hrtime.bigint();
      fn(lines[i].line, lines[i].index);
      const t1 = process.hrtime.bigint();
      latencies[sampleIdx++] = Number(t1 - t0);
    }
  }
  latencies.length = sampleIdx;
  latencies.sort((a, b) => a - b);
  const median = latencies[Math.floor(latencies.length * 0.5)];
  const p99 = latencies[Math.floor(latencies.length * 0.99)];

  return {
    throughputMBps: totalBytes / elapsedSec / (1024 * 1024),
    latencyMedianUs: median / 1000,
    latencyP99Us: p99 / 1000,
  };
}

// ── Benchmark: Distribution ─────────────────────────────────────────────────

function runDist(
  fn: (line: string, lineIndex: number) => number,
  lines: LineEntry[],
): DistResult {
  const buckets = new Uint32Array(256);
  for (const entry of lines) {
    const h = fn(entry.line, entry.index);
    buckets[h & 0xff]++;
  }

  const expected = lines.length / 256;
  let chiSquared = 0;
  let outliers = 0;
  const stdDev = Math.sqrt(expected);

  for (let i = 0; i < 256; i++) {
    const diff = buckets[i] - expected;
    chiSquared += (diff * diff) / expected;
    if (Math.abs(diff) > 3 * stdDev) outliers++;
  }

  return { chiSquared, outlierBuckets: outliers };
}

// ── Benchmark: Collision rate ───────────────────────────────────────────────

function runCollisions(
  fn: (line: string, lineIndex: number) => number,
  lines: LineEntry[],
  windowSizes: number[],
): Record<number, CollisionResult> {
  const results: Record<number, CollisionResult> = {};

  for (const size of windowSizes) {
    if (size > lines.length) continue;

    const maxStart = lines.length - size;
    const sampleCount = Math.min(10000, maxStart + 1);

    const windows: LineEntry[][] = [];
    if (sampleCount >= maxStart + 1) {
      for (let i = 0; i <= maxStart; i++) {
        windows.push(lines.slice(i, i + size));
      }
    } else {
      for (let i = 0; i < sampleCount; i++) {
        const start = Math.floor((i / sampleCount) * maxStart);
        windows.push(lines.slice(start, start + size));
      }
    }

    let totalCollisions = 0;
    let totalPairs = 0;
    let worstWindow = 0;

    for (const window of windows) {
      let windowCollisions = 0;
      for (let i = 0; i < window.length; i++) {
        const hi = fn(window[i].line, window[i].index);
        for (let j = i + 1; j < window.length; j++) {
          totalPairs++;
          const hj = fn(window[j].line, window[j].index);
          if (hi === hj) {
            totalCollisions++;
            windowCollisions++;
          }
        }
      }
      if (windowCollisions > worstWindow) worstWindow = windowCollisions;
    }

    results[size] = {
      totalCollisions,
      collisionRate: totalPairs === 0 ? 0 : totalCollisions / totalPairs,
      worstWindow,
    };
  }

  return results;
}

// ── Benchmark: Seed sensitivity ─────────────────────────────────────────────

function runSeedSensitivity(
  fn: (line: string, lineIndex: number) => number,
  testLines: string[],
): boolean {
  const windows = [
    [1, 10],
    [347, 356],
    [1234, 1243],
    [50, 59],
    [200, 209],
    [999, 1008],
    [1500, 1509],
    [77, 86],
    [500, 509],
    [3000, 3009],
  ];

  let cleanWindows = 0;
  for (const [start, end] of windows) {
    const hashes = new Map<number, string[]>();
    for (let idx = start; idx <= end; idx++) {
      const line = testLines[(idx - 1) % testLines.length];
      const h = fn(line, idx);
      const arr = hashes.get(h) ?? [];
      arr.push(line);
      hashes.set(h, arr);
    }
    let windowClean = true;
    for (const arr of hashes.values()) {
      if (arr.length > 1) {
        windowClean = false;
        break;
      }
    }
    if (windowClean) cleanWindows++;
  }

  const h1 = fn("", 1);
  const h2 = fn("", 2);
  const blankOk = h1 !== h2;

  return cleanWindows >= 8 && blankOk;
}

// ── Baseline-normalized scoring ─────────────────────────────────────────────

function computeBaselineScores(results: BenchmarkResult[]): NormalizedScore[] {
  return results.map((r) => {
    const throughput = r.perf.throughputMBps / BASELINE.throughputMBps;
    const distribution = BASELINE.chiSquared / r.dist.chiSquared;
    const collision = BASELINE.collisionRate / r.collision[5].collisionRate;

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
}

// ── Reporting ───────────────────────────────────────────────────────────────

function formatReport(
  evalData: EvalData,
  results: BenchmarkResult[],
  scores: NormalizedScore[],
  durationMin: number,
): string {
  const lines: string[] = [];

  lines.push("# Hash Algorithm Evaluation Report");
  lines.push("");

  lines.push("## Dataset");
  lines.push(`- **Lines**: ${evalData.lines.length.toLocaleString()}`);
  lines.push(`- **Files**: ${evalData.files}`);
  lines.push(`- **Extensions**: ${evalData.extensions.join(", ")}`);
  lines.push(`- **Target per candidate**: ~${durationMin} min`);
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
  for (const r of results) {
    const c = r.collision[5];
    lines.push(
      `| ${r.candidate} (${r.variant}) | ${r.perf.throughputMBps.toFixed(2)} | ${r.dist.chiSquared.toFixed(2)} | ${c.collisionRate.toExponential(3)} | ${c.worstWindow} | ${r.seedSensitivity ? "PASS" : "FAIL"} |`,
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
  const sorted = [...scores].sort((a, b) => b.balanced - a.balanced);
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

  return lines.join("\n");
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const targetDurationSec = parseInt(process.argv[2] || "120", 10);
  const durationMin = Math.round(targetDurationSec / 60);

  console.error("Building evaluation data set...");
  const evalData = await buildEvalData();
  console.error(
    `Total: ${evalData.lines.length.toLocaleString()} lines, ${evalData.files} files, ${(evalData.totalBytes / 1024 / 1024).toFixed(1)} MB\n`,
  );

  const { testLines } = await import("./data/dev.js");

  console.error(
    `Running benchmarks (${durationMin} min perf target per candidate)...\n`,
  );

  const results: BenchmarkResult[] = [];
  for (const c of candidates) {
    console.error(`→ ${c.name} (${c.variant})`);

    const perf = runPerf(c.fn, evalData.lines, targetDurationSec);
    console.error(`  perf: ${perf.throughputMBps.toFixed(2)} MB/s`);

    const dist = runDist(c.fn, evalData.lines);
    console.error(
      `  dist: chi²=${dist.chiSquared.toFixed(2)}, outliers=${dist.outlierBuckets}`,
    );

    const collision = runCollisions(c.fn, evalData.lines, [1, 3, 5, 10]);
    console.error(
      `  collision(5): ${collision[5].totalCollisions} collisions, rate=${collision[5].collisionRate.toExponential(3)}`,
    );

    const seedSensitivity = runSeedSensitivity(c.fn, testLines);
    console.error(`  seed sensitivity: ${seedSensitivity ? "PASS" : "FAIL"}`);

    results.push({
      candidate: c.name,
      variant: c.variant,
      perf,
      dist,
      collision,
      seedSensitivity,
    });
  }

  const scores = computeBaselineScores(results);

  const rawData = {
    meta: {
      baseline: BASELINE,
      lines: evalData.lines.length,
      files: evalData.files,
      extensions: evalData.extensions,
      durationSec: targetDurationSec,
      presets: PRESETS.map((p) => ({ name: p.name, weights: p.weights })),
    },
    results: results.map((r) => ({
      candidate: r.candidate,
      variant: r.variant,
      throughputMBps: r.perf.throughputMBps,
      latencyMedianUs: r.perf.latencyMedianUs,
      latencyP99Us: r.perf.latencyP99Us,
      chiSquared: r.dist.chiSquared,
      outlierBuckets: r.dist.outlierBuckets,
      collisionRate5: r.collision[5].collisionRate,
      totalCollisions5: r.collision[5].totalCollisions,
      worstWindow5: r.collision[5].worstWindow,
      seedSensitivity: r.seedSensitivity,
    })),
    normalized: scores,
  };
  writeFileSync("raw-results.json", JSON.stringify(rawData, null, 2));
  console.error("\nSaved raw results to raw-results.json");

  const report = formatReport(evalData, results, scores, durationMin);
  writeFileSync("RESULTS.md", report);
  console.log(report);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
