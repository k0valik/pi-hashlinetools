# Evaluate hash function candidates

Build the benchmark harness and run the full evaluation. The hash implementations must already pass the functional tests from `IMPLEMENT.md` before starting.

## Test data

**Development set (small, for iterating):** one `.ts` file from `C:\Users\Jerry\Projects\pi-mono` (≥500 lines). Use this to verify the harness works before scaling up.

**Evaluation set (final):** mix of real code across languages:

| Extension | Path | Notes |
|---|---|---|
| `.cs` | `C:\Users\Jerry\Projects\Unity` | C# |
| `.patch` | `C:\Users\Jerry\Projects\tModLoader` | Diff files |
| `.py` | `C:\Users\Jerry\Projects\kimi-cli` | Python |
| `.ts` | `C:\Users\Jerry\Projects\pi-mono` | TypeScript |
| `.rs` | `C:\Users\Jerry\Projects\Bevy` | Rust |
| `.md` | All project directories above | Markdown |

Pull at least 5,000 lines per extension (if available; otherwise take what's there). Collect all lines into a single flat array with their 1-based indices. Each entry: `{ line: string, index: number }`.

Build the eval set once at startup. All candidates use the same data.

## Harness structure

A single script: `profiling/evaluate.js` (or `.ts`). Run with `node profiling/evaluate.js`.

The script should:

1. Load test data (dev set first, prompt to confirm, then eval set)
2. For each candidate, run all benchmarks
3. Print a formatted report to stdout
4. Exit 0

## Timing target

Each candidate's evaluation must run for at least several minutes. If too fast, repeat the data (cycle through lines multiple times) until the target is met. Use the same expanded data for all candidates.

## Benchmarks

For each candidate, run these in order:

### 1. Performance

- Measure throughput (MB/s) and per-line latency (median, p99 in μs)
- Use `process.hrtime.bigint()` for timing
- Report mask and fold variants separately for 32-bit candidates

### 2. Distribution

- Map each line's 8-bit hash to buckets 0–255 across all test lines combined
- Compute chi-squared goodness-of-fit against a uniform distribution — **this is the distribution score** (lower is better)
- Output an ASCII histogram for human inspection (one `#` per ~1% of expected bucket size)
- Flag any bucket >3 standard deviations from the expected value

### 3. Collision rate within local windows

The most important metric. Methodology:

- From the eval data, randomly sample line-index windows of sizes 1, 3, 5, 10
- Sample enough windows that results stabilize: ≥10,000 windows per size, or all possible windows if the dataset is smaller
- Within each window, count pairs of distinct lines with the same 8-bit hash but **different content** (same-content collisions are impossible when lineIndex is always incorporated — skip those)
- Report: total collisions, collision rate (collisions / distinct-content pairs), worst-case density (max collisions in a single window)

### 4. Seed sensitivity (qualitative)

Using the test cases from `data/dev.ts`:

- Generate 10 random line-number windows (e.g. 1–10, 347–356, 1234–1243)
- For each window, verify no collisions between distinct-content lines with different indices
- Verify two identical blank lines at different indices get different hashes

## Scoring

Compute a single score for each candidate under three presets. Normalize each raw metric to 0–1 across all candidates first (best = 1, worst = 0), then apply weights:

- **`quality-only`:** collision_rate: 0.6, distribution: 0.4, throughput: 0.0
- **`quality-first`:** collision_rate: 0.5, distribution: 0.3, throughput: 0.2
- **`balanced`:** collision_rate: 0.35, distribution: 0.35, throughput: 0.3
- `distribution` = chi-squared from the 256-bucket goodness-of-fit test (lower is better)
- `collision_rate` = collision rate from 5-line windows (lower is better)
- `throughput` = MB/s from the performance benchmark (higher is better)

Normalize each raw metric to 0–1 across all candidates, then **invert** components where lower-is-better (chi-squared, collision rate) so that 1 = best for all components before applying weights. Higher final score = better.

## Report format

Print to stdout:

```
=== HASH ALGORITHM PROFILING REPORT ===
Test data: N lines from X files across Y extensions
Evaluation time: Zm per candidate

--- Performance ---
Candidate        | Throughput (MB/s) | Latency median (μs) | Latency p99 (μs)
...

--- Distribution ---
Candidate        | Chi-squared | Outlier buckets
...
[ASCII histogram per candidate]

--- Collision rate (5-line windows) ---
Candidate        | Total collisions | Rate      | Worst window
...

--- Scores ---
Candidate        | quality-only | quality-first | balanced
...

--- Recommendation ---
<winner> — <brief justification>
```

## Deliverables

- `profiling/evaluate.js` (or `.ts`) — the harness script
- The report output pasted into `profiling/RESULTS.md`
