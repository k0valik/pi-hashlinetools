import { createReadStream, type Dir } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

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
) {
  const lines: string[] = [];
  let files = 0;
  let totalBytes = 0;
  for (const dir of dirs) {
    for await (const file of walkFiles(dir, ext)) {
      const s = await stat(file);
      totalBytes += s.size;
      const stream = createReadStream(file, { encoding: "utf-8" });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      for await (const l of rl) lines.push(l);
      files++;
      if (lines.length >= minLines) break;
    }
    if (lines.length >= minLines) break;
  }
  return { lines, files, totalBytes };
}

async function main() {
  for (const [ext, dirs] of Object.entries(EVAL_DIRS)) {
    const { lines, files } = await collectLinesForExt(ext, dirs, 5000);
    console.log(`${ext}: ${lines.length} lines from ${files} files`);
  }
}
main();
