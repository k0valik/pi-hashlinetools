import { chmod, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeFileAtomically } from "../../src/fs-write";
import { withTempFile } from "../support/fixtures";

describe("fs-write.robust.test.ts - Atomic Write Robustness", () => {
  it("preserves file mode across atomic writes", async () => {
    await withTempFile("mode.txt", "content\n", async ({ cwd, path }) => {
      // Set a specific mode (e.g., 0o600 - read/write by owner only)
      await chmod(path, 0o600);
      const originalStat = await stat(path);

      await writeFileAtomically(path, "new content\n");

      const newStat = await stat(path);
      // Compare only the mode bits we care about
      expect(newStat.mode & 0o777).toBe(originalStat.mode & 0o777);
    });
  });

  it("handles write to a non-existent file in an existing directory", async () => {
    await withTempFile("dummy", "", async ({ cwd }) => {
      const newFile = join(cwd, "new.txt");
      await writeFileAtomically(newFile, "hello\n");

      const s = await stat(newFile);
      expect(s.isFile()).toBe(true);
    });
  });

  it.skipIf(!process.getuid || process.getuid() === 0)(
    "fails gracefully when parent directory is not writable",
    async () => {
      await withTempFile("file.txt", "content\n", async ({ cwd, path }) => {
        // Change mode of cwd to be read-only
        await chmod(cwd, 0o500); // read/execute but not write

        try {
          await writeFileAtomically(path, "wont work\n");
          // If we reach here, writeFileAtomically did not fail as expected.
          expect.fail(
            "writeFileAtomically should have failed on read-only directory",
          );
        } catch (e: any) {
          expect(e.code).toMatch(/EACCES|EPERM/);
        } finally {
          await chmod(cwd, 0o700); // restore for cleanup
        }
      });
    },
  );
});
