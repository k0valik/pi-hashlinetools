# Setup: hash profiling project skeleton

Set up the project structure for hash algorithm profiling. Do not implement real hash functions yet — only stubs and the test harness.

## Directory structure

```
profiling/
  package.json        # dependencies: xxhashjs
  src/
    hashLine.ts       # interface + 4 candidate stubs, all returning 0
    index.ts          # re-exports
  test/
    functional.test.ts  # gate tests (stability, seed/content sensitivity, range)
  data/
    dev.ts            # hardcoded test lines for functional tests
```

## package.json

Create `profiling/package.json` with:

- `"type": "module"`
- Dependencies: `"xxhashjs": "^0.2.2"`
- Dev dependencies: `"vitest": "^3.0.0"` (match the version used in the root)
- Scripts: `"test": "vitest run"`

## hashLine.ts — interface and stubs

Define the shared interface:

```typescript
export type HashFn = (line: string, lineIndex: number) => number;
```

Export stubs with three different behaviors to verify the test harness discriminates correctly. Each must match `HashFn`. Trim trailing whitespace from the line before hashing (stubs may ignore it).

| Stub name | Behavior | Expected test results |
|---|---|---|
| `stub_zero` | Always return 0 | Stability: PASS. Seed sensitivity: FAIL (0% differ). Content sensitivity: FAIL. Range: PASS. |
| `stub_random` | Return `Math.floor(Math.random() * 256)` | Stability: FAIL. Seed sensitivity: PASS (random values differ >90%). Content sensitivity: PASS. Range: PASS. |
| `stub_overflow` | Always return 256 | Stability: PASS. Seed sensitivity: FAIL. Content sensitivity: FAIL. Range: FAIL (256 > 255). |

Export as an array so tests can iterate:

```typescript
export const candidates: { name: string; variant: string; fn: HashFn }[] = [
  { name: "stub_zero", variant: "stub", fn: stub_zero },
  { name: "stub_random", variant: "stub", fn: stub_random },
  { name: "stub_overflow", variant: "stub", fn: stub_overflow },
  // Real candidates (all returning 0 — will replace in IMPLEMENT.md):
  { name: "xxhashjs", variant: "mask", fn: xxhashjs_mask },
  { name: "fnv1a", variant: "mask", fn: fnv1a_mask },
  { name: "fnv1a", variant: "fold", fn: fnv1a_fold },
  { name: "djb2", variant: "mask", fn: djb2_mask },
  { name: "djb2", variant: "fold", fn: djb2_fold },
  { name: "pearson", variant: "native", fn: pearson },
];
```

## Functional tests

Using vitest, for each candidate in `candidates`. Pull real line content from a `.ts` file in `C:\Users\Jerry\Projects\pi-mono` (≥500 lines). The agent designs its own test data and file structure.

1. **Stability.** Same `(line, lineIndex)` called twice must return the same hash. Use 50+ diverse inputs.
2. **Seed sensitivity.** Same line at different indices must produce different hashes for ≥90% of index pairs. Use 50+ lines with 4+ indices each, covering both sequential (1,2,3) and scattered (42, 999, 65535) values.
3. **Content sensitivity.** Changing one character must change the hash for ≥80% of pairs. Cover mutations at start, middle, and end of the line; short lines, long lines, and edge cases (empty ↔ non-empty). Use 100+ pairs.
4. **Range.** Every output must be 0–255. Catches implementations that forget reduction (returning values up to 65535 or 4294967295). A few dozen diverse inputs is plenty.
Tests will produce a mix of passes and failures at this stage — see the table in the hashLine.ts section for expected results per stub. The implementation phase will replace all real-candidate stubs so they pass every test.

Run with `npm test` from the profiling directory and confirm the test runner works and the pass/fail pattern matches the table above. Once confirmed, remove `stub_zero`, `stub_random`, and `stub_overflow` from the `candidates` array so the test output is clean (only real candidates remain, all failing).
