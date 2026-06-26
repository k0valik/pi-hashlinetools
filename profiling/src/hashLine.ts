import XXH from "xxhashjs";

export type HashFn = (line: string, lineIndex: number) => number;

// ── Helpers ─────────────────────────────────────────────────────────────────
function trimTrailing(line: string): string {
  return line.trimEnd();
}

function fold32(hash: number): number {
  return (hash ^ (hash >>> 8) ^ (hash >>> 16) ^ (hash >>> 24)) & 0xff;
}

// ── 1. xxhashjs (baseline) ─────────────────────────────────────────────────
const xxhashjs_mask: HashFn = (line, lineIndex) => {
  const trimmed = trimTrailing(line);
  const hash = XXH.h32(lineIndex).update(trimmed).digest().toNumber() >>> 0;
  return hash & 0xff;
};

// ── 2. FNV-1a ──────────────────────────────────────────────────────────────
const FNV1A_OFFSET_BASIS = 0x811c9dc5;
const FNV1A_PRIME = 0x01000193;

function fnv1a(line: string, lineIndex: number): number {
  const trimmed = trimTrailing(line);
  let hash = FNV1A_OFFSET_BASIS ^ lineIndex;
  for (let i = 0; i < trimmed.length; i++) {
    hash = (hash ^ trimmed.charCodeAt(i)) >>> 0;
    hash = Math.imul(hash, FNV1A_PRIME) >>> 0;
  }
  return hash >>> 0;
}

const fnv1a_mask: HashFn = (line, lineIndex) => fnv1a(line, lineIndex) & 0xff;
const fnv1a_fold: HashFn = (line, lineIndex) => fold32(fnv1a(line, lineIndex));

// ── 3. DJB2 ─────────────────────────────────────────────────────────────────
function djb2(line: string, lineIndex: number): number {
  const trimmed = trimTrailing(line);
  let hash = 5381 ^ lineIndex;
  for (let i = 0; i < trimmed.length; i++) {
    hash = (Math.imul(hash, 33) + trimmed.charCodeAt(i)) >>> 0;
  }
  return hash >>> 0;
}

const djb2_mask: HashFn = (line, lineIndex) => djb2(line, lineIndex) & 0xff;
const djb2_fold: HashFn = (line, lineIndex) => fold32(djb2(line, lineIndex));

// ── 4. Pearson ──────────────────────────────────────────────────────────────
// Deterministic 256-byte permutation generated with a fixed-seed shuffle.
const PEARSON_TABLE: number[] = (() => {
  const table: number[] = new Array(256);
  for (let i = 0; i < 256; i++) table[i] = i;
  let seed = 12345;
  for (let i = 255; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const j = seed % (i + 1);
    const tmp = table[i];
    table[i] = table[j];
    table[j] = tmp;
  }
  return table;
})();

const pearson: HashFn = (line, lineIndex) => {
  const trimmed = trimTrailing(line);
  const bytes = new TextEncoder().encode(trimmed);
  let hash = lineIndex & 0xff;
  for (let i = 0; i < bytes.length; i++) {
    hash = PEARSON_TABLE[hash ^ bytes[i]];
  }
  return hash;
};

// ── 5. Discovered hash8 R=1 (fastest, weakest) ─────────────────────────────
const hash8_r1: HashFn = (line, lineIndex) => {
  const trimmed = trimTrailing(line);
  let state = lineIndex & 0xff;
  let s = lineIndex >>> 8;
  while (s !== 0) {
    state ^= s & 0xff;
    s >>>= 8;
  }
  for (let i = 0; i < trimmed.length; i++) {
    state ^= trimmed.charCodeAt(i);
    state = (state * 0x45) & 0xff;
    state = (state + (state >> 5)) & 0xff;
  }
  state = (state + trimmed.length) & 0xff;
  state = (state + (state >> 7)) & 0xff;
  return state;
};

// ── 6. Discovered hash8 R=2 (better avalanche, still fast) ─────────────────
const hash8_r2: HashFn = (line, lineIndex) => {
  const trimmed = trimTrailing(line);
  let state = lineIndex & 0xff;
  let s = lineIndex >>> 8;
  while (s !== 0) {
    state ^= s & 0xff;
    s >>>= 8;
  }
  for (let i = 0; i < trimmed.length; i++) {
    state = (state + trimmed.charCodeAt(i)) & 0xff;
    state = (state * 0x3b) & 0xff;
    state ^= state >> 5;
    state = (state * 0x95) & 0xff;
    state ^= state >> 3;
  }
  state ^= trimmed.length & 0xff;
  state ^= state >> 4;
  return state;
};

// ── Candidate registry ──────────────────────────────────────────────────────

export const candidates: { name: string; variant: string; fn: HashFn }[] = [
  { name: "xxhashjs", variant: "mask", fn: xxhashjs_mask },
  { name: "fnv1a", variant: "mask", fn: fnv1a_mask },
  { name: "fnv1a", variant: "fold", fn: fnv1a_fold },
  { name: "djb2", variant: "mask", fn: djb2_mask },
  { name: "djb2", variant: "fold", fn: djb2_fold },
  { name: "pearson", variant: "native", fn: pearson },
  { name: "hash8", variant: "r1", fn: hash8_r1 },
  { name: "hash8", variant: "r2", fn: hash8_r2 },
];
