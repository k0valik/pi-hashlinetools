const N = 5_000_000;
const lines = Array.from(
  { length: 100 },
  (_, i) => `const x = ${i}; // some comment here`,
);

const te = new TextEncoder();

// charCodeAt
let s1 = 0;
const t1 = process.hrtime.bigint();
for (let n = 0; n < N; n++) {
  const line = lines[n % lines.length];
  for (let i = 0; i < line.length; i++) {
    s1 += line.charCodeAt(i);
  }
}
const e1 = Number(process.hrtime.bigint() - t1) / 1e9;
console.log("charCodeAt:", e1.toFixed(3), "s", "sum", s1);

// new TextEncoder().encode() each time
let s2 = 0;
const t2 = process.hrtime.bigint();
for (let n = 0; n < N; n++) {
  const line = lines[n % lines.length];
  const bytes = new TextEncoder().encode(line);
  for (let i = 0; i < bytes.length; i++) {
    s2 += bytes[i];
  }
}
const e2 = Number(process.hrtime.bigint() - t2) / 1e9;
console.log("TextEncoder new:", e2.toFixed(3), "s", "sum", s2);

// cached TextEncoder().encode()
let s3 = 0;
const t3 = process.hrtime.bigint();
for (let n = 0; n < N; n++) {
  const line = lines[n % lines.length];
  const bytes = te.encode(line);
  for (let i = 0; i < bytes.length; i++) {
    s3 += bytes[i];
  }
}
const e3 = Number(process.hrtime.bigint() - t3) / 1e9;
console.log("TextEncoder cached:", e3.toFixed(3), "s", "sum", s3);

// Buffer.byteLength (no iteration)
let s4 = 0;
const t4 = process.hrtime.bigint();
for (let n = 0; n < N; n++) {
  const line = lines[n % lines.length];
  s4 += Buffer.byteLength(line, "utf-8");
}
const e4 = Number(process.hrtime.bigint() - t4) / 1e9;
console.log("Buffer.byteLength:", e4.toFixed(3), "s", "sum", s4);
