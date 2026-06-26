# Implement hash function candidates

Implement the four hash algorithms in `profiling/src/hashLine.ts`. All stubs currently return 0 — replace each with a working implementation.

## Interface

```typescript
export type HashFn = (line: string, lineIndex: number): number;
```

- Return: 8-bit unsigned integer (0–255)
- Always incorporate `lineIndex` into the hash (unconditionally, not just for blank lines)
- Trim trailing whitespace from `line` before hashing
- Deterministic: no randomness, no unseeded state
- No file I/O, no external APIs (except `xxhashjs` for candidate 1)

## Candidates

### 1. xxhashjs (baseline)

Use the `xxhashjs` npm package. Compute `XXH.h32(lineIndex).update(trimmedLine).digest().toNumber() >>> 0`, then reduce to 8 bits via mask only (this is the current production behavior — no fold variant needed).

Return value: 0–255.

### 2. FNV-1a

Standard 32-bit FNV-1a:
- offset basis: `0x811c9dc5`
- prime: `0x01000193`
- XOR `lineIndex` into the initial hash value, then process each character of the trimmed line: `hash = (hash ^ charCode) * prime >>> 0`
- Implement **mask** variant: return `hash & 0xFF`
- Implement **fold** variant: return `(hash ^ (hash >> 8) ^ (hash >> 16) ^ (hash >> 24)) & 0xFF`

### 3. DJB2

Classic DJB2:
- starting value: `5381`
- XOR `lineIndex` into the starting value, then process each character: `hash = ((hash * 33) + charCode) >>> 0`
- Use `Math.imul(hash, 33)` for the multiplication to avoid float coercion in JS
- Implement **mask** variant: return `hash & 0xFF`
- Implement **fold** variant: return `(hash ^ (hash >> 8) ^ (hash >> 16) ^ (hash >> 24)) & 0xFF`

### 4. Pearson

Designed for 8-bit output. No reduction needed.

- Use a 256-byte permutation table. Generate from a known-good permutation (e.g. the one from Pearson's original 1990 paper, or a random permutation generated once at module init with a fixed seed for determinism).
- Start with `hash = lineIndex & 0xFF`
- For each byte of the trimmed line: `hash = TABLE[hash ^ byte]`
- Return `hash` (already 0–255)

## Verification

Run `npm test` from the profiling directory. All functional tests must pass:

```
✓ Stability — same input, same output
✓ Seed sensitivity — different lineIndex, different hash (>=90% of pairs)
✓ Content sensitivity — character change changes hash
✓ Range — all outputs in 0–255
```
