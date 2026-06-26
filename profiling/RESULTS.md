# Hash Algorithm Evaluation Report

## Dataset
- **Lines**: 37,012
- **Files**: 160
- **Extensions**: .cs, .patch, .py, .ts, .rs, .md
- **Target per candidate**: ~1 min

## Baselines
| Metric | Baseline value | Rationale |
|--------|---------------:|-----------|
| Collision rate (5-line) | 3.906e-3 | Birthday bound: 1/256 for 8-bit output |
| Chi-squared | 255 | Expected for uniform 256-bin distribution (df=255) |
| Throughput | 100 MB/s | Round practical target |

Scores = candidate ÷ baseline for throughput; baseline ÷ candidate for collision & distribution. A score of **1.0** means the candidate exactly meets the target. Scores are independent of the candidate set — adding new hashes never shifts existing scores.

## Raw Metrics

| Candidate | Throughput (MB/s) | Chi-squared | Collision rate (5-line) | Worst window | Seed OK |
|-----------|------------------:|------------:|------------------------:|-------------:|:-------:|
| xxhashjs (mask) | 30.39 | 198.21 | 4.030e-3 | 3 | FAIL |
| fnv1a (mask) | 363.58 | 259.66 | 3.610e-3 | 3 | PASS |
| fnv1a (fold) | 359.79 | 232.07 | 3.830e-3 | 3 | PASS |
| djb2 (mask) | 358.97 | 250.08 | 3.930e-3 | 3 | PASS |
| djb2 (fold) | 373.55 | 272.89 | 3.560e-3 | 3 | PASS |
| pearson (native) | 85.15 | 237.99 | 3.570e-3 | 2 | PASS |
| hash8 (r1) | 356.02 | 625.57 | 3.710e-3 | 3 | PASS |
| hash8 (r2) | 302.74 | 261.48 | 3.670e-3 | 3 | FAIL |

## Baseline-Normalized Scores

| Candidate | Throughput | Distribution | Collision |
|-----------|-----------:|-------------:|----------:|
| xxhashjs (mask) | 0.304 | 1.287 | 0.969 |
| fnv1a (mask) | 3.636 | 0.982 | 1.082 |
| fnv1a (fold) | 3.598 | 1.099 | 1.020 |
| djb2 (mask) | 3.590 | 1.020 | 0.994 |
| djb2 (fold) | 3.736 | 0.934 | 1.097 |
| pearson (native) | 0.851 | 1.071 | 1.094 |
| hash8 (r1) | 3.560 | 0.408 | 1.053 |
| hash8 (r2) | 3.027 | 0.975 | 1.064 |

## Composite Scores

Weights: collision 0.467, distribution 0.233, throughput 0.300 (fixed 2:1 collision→distribution ratio).

| Candidate | quality-only | quality-first | balanced |
|-----------|-------------:|--------------:|---------:|
| djb2 (fold) | 1.0430 | 1.5815 | 1.8508 |
| fnv1a (mask) | 1.0487 | 1.5661 | 1.8248 |
| fnv1a (fold) | 1.0462 | 1.5565 | 1.8117 |
| djb2 (mask) | 1.0025 | 1.5200 | 1.7787 |
| hash8 (r1) | 0.8378 | 1.3823 | 1.6545 |
| hash8 (r2) | 1.0347 | 1.4332 | 1.6325 |
| pearson (native) | 1.0866 | 1.0396 | 1.0161 |
| xxhashjs (mask) | 1.0750 | 0.9208 | 0.8437 |

## Recommendation

**djb2 (fold)** — best balanced score (1.8508) against the arbitrary baselines.