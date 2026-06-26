import { testLines } from "./data/dev.js";
import { candidates } from "./src/hashLine.js";

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

for (const c of candidates.filter((c) => c.name === "hash8")) {
  let clean = 0;
  for (const [start, end] of windows) {
    const hashes = new Map<number, string[]>();
    for (let idx = start; idx <= end; idx++) {
      const line = testLines[(idx - 1) % testLines.length];
      const h = c.fn(line, idx);
      const arr = hashes.get(h) ?? [];
      arr.push(line);
      hashes.set(h, arr);
    }
    let ok = true;
    for (const arr of hashes.values()) {
      if (arr.length > 1) {
        ok = false;
        break;
      }
    }
    if (ok) clean++;
  }
  const blankOk = c.fn("", 1) !== c.fn("", 2);
  console.log(c.name, c.variant, "clean:", `${clean}/10`, "blank:", blankOk);
}
