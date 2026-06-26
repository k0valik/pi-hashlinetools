/**
 *  — `/inspect-text` slash command (port of `/robust-edit` show,
 * validate, diff subcommands into the hashline extension).
 *
 * The three subcommands of `/robust-edit` that the model actually
 * uses (`show`, `validate`, `diff`) are ported to `/inspect-text` so
 * the user can invoke them from the TUI prompt. The new slash
 * command calls the same `inspect_text` tool that the model calls.
 *
 * The `/robust-edit` slash command stays untouched in
 * `pi-robust-edit` for now (deprecation handled separately by the
 * user). This test only covers the new command.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import register from "../../index";
import { makeFakePiRegistry, withTempFile } from "../support/fixtures";

type FakeCtx = { ui: { notify: (msg: string, level: string) => void } };

describe("/inspect-text slash command registration ( stage 5)", () => {
  it("registers a command named 'inspect-text'", () => {
    const commands: Array<{
      name: string;
      spec: { description: string; handler: Function };
    }> = [];
    const pi = {
      registerTool() {},
      registerCommand(
        name: string,
        spec: { description: string; handler: Function },
      ) {
        commands.push({ name, spec });
      },
      on() {},
    } as any;
    register(pi);
    const cmd = commands.find((c) => c.name === "inspect-text");
    expect(cmd).toBeDefined();
    expect(cmd?.spec.description).toBeTruthy();
    expect(typeof cmd?.spec.handler).toBe("function");
  });
});

describe("/inspect-text show ( stage 5)", () => {
  it("shows line-numbered content with hex preview", async () => {
    const content = "alpha\nbeta\ngamma\n";
    await withTempFile("test.txt", content, async ({ path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      // We don't have a getCommand helper, so we re-register to capture
      // the command. The simpler approach: extract the handler from
      // the tool result. But here we test the full roundtrip by calling
      // the inspect_text tool with the same args the slash command
      // would build. The slash command itself is just an args parser.
      const tool = getTool("inspect_text");
      const result = await tool.execute(
        "tc1",
        { op: "show", file: path },
        new AbortController().signal,
        () => {},
        { cwd: process.cwd() },
      );
      const text =
        result.content
          ?.filter((c: { type: string }) => c.type === "text")
          .map((c: { text?: string }) => c.text ?? "")
          .join("") ?? "";
      expect(text).toMatch(/1.*alpha/);
      expect(text).toMatch(/2.*beta/);
      expect(text).toMatch(/3.*gamma/);
      expect(text).toContain("61 6c 70 68 61"); // hex of "alpha"
    });
  });
});

describe("/inspect-text validate ( stage 5)", () => {
  it("shows 1 match for a unique substring", async () => {
    const content = "alpha\nbeta\ngamma\n";
    await withTempFile("test.txt", content, async ({ path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const tool = getTool("inspect_text");
      const result = await tool.execute(
        "tc1",
        { op: "validate", file: path, oldText: "beta" },
        new AbortController().signal,
        () => {},
        { cwd: process.cwd() },
      );
      const text =
        result.content
          ?.filter((c: { type: string }) => c.type === "text")
          .map((c: { text?: string }) => c.text ?? "")
          .join("") ?? "";
      expect(text).toMatch(/1 (match|occurrence|time)/i);
      expect(text).toMatch(/lines? 2/);
    });
  });
});

describe("/inspect-text diff ( stage 5)", () => {
  it("reports identical files as identical", async () => {
    const tempRoot = join(process.cwd(), ".tmp");
    await mkdir(tempRoot, { recursive: true });
    const cwd = await mkdtemp(join(tempRoot, "pi-hashline-test-"));
    const fileA = join(cwd, "a.txt");
    const fileB = join(cwd, "b.txt");
    await writeFile(fileA, "alpha\n", "utf-8");
    await writeFile(fileB, "alpha\n", "utf-8");
    try {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const tool = getTool("inspect_text");
      const result = await tool.execute(
        "tc1",
        { op: "diff", fileA, fileB },
        new AbortController().signal,
        () => {},
        { cwd: process.cwd() },
      );
      const text =
        result.content
          ?.filter((c: { type: string }) => c.type === "text")
          .map((c: { text?: string }) => c.text ?? "")
          .join("") ?? "";
      expect(text.toLowerCase()).toMatch(/identical/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("/inspect-text slash command handler ( stage 5)", () => {
  it("the registered handler parses show subcommand and calls the tool", async () => {
    const content = "alpha\nbeta\n";
    const tempRoot = join(process.cwd(), ".tmp");
    await mkdir(tempRoot, { recursive: true });
    const cwd = await mkdtemp(join(tempRoot, "pi-hashline-test-"));
    const file = join(cwd, "test.txt");
    await writeFile(file, content, "utf-8");

    const commands: Array<{
      name: string;
      spec: { description: string; handler: Function };
    }> = [];
    const toolCalls: Array<{ op: string; [k: string]: unknown }> = [];
    const pi = {
      cwd: process.cwd(),
      registerTool(tool: { name: string; execute: Function }) {
        // Wrap the inspect_text tool's execute so we can verify the
        // slash command dispatches into it.
        if (tool.name === "inspect_text") {
          const original = tool.execute;
          tool.execute = async (...args: unknown[]) => {
            const params = args[1] as { op: string; [k: string]: unknown };
            toolCalls.push(params);
            return original(...args);
          };
        }
      },
      registerCommand(
        name: string,
        spec: { description: string; handler: Function },
      ) {
        commands.push({ name, spec });
      },
      on() {},
    } as any;
    register(pi);
    const cmd = commands.find((c) => c.name === "inspect-text");
    expect(cmd).toBeDefined();

    let notified: string | undefined;
    const ctx: FakeCtx = {
      ui: {
        notify: (msg: string) => {
          notified = msg;
        },
      },
    };
    await cmd!.spec.handler(`show ${file}`, ctx);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.op).toBe("show");
    expect(toolCalls[0]?.file).toBe(file);
    expect(notified).toBeDefined();
    expect(notified).toContain("alpha");
    expect(notified).toContain("61 6c 70 68 61");

    await rm(cwd, { recursive: true, force: true });
  });

  it("the registered handler parses validate subcommand", async () => {
    const content = "alpha\nbeta\n";
    const tempRoot = join(process.cwd(), ".tmp");
    await mkdir(tempRoot, { recursive: true });
    const cwd = await mkdtemp(join(tempRoot, "pi-hashline-test-"));
    const file = join(cwd, "test.txt");
    await writeFile(file, content, "utf-8");

    const commands: Array<{ name: string; spec: { handler: Function } }> = [];
    const toolCalls: Array<{ op: string; [k: string]: unknown }> = [];
    const pi = {
      cwd: process.cwd(),
      registerTool(tool: { name: string; execute: Function }) {
        if (tool.name === "inspect_text") {
          const original = tool.execute;
          tool.execute = async (...args: unknown[]) => {
            const params = args[1] as { op: string; [k: string]: unknown };
            toolCalls.push(params);
            return original(...args);
          };
        }
      },
      registerCommand(name: string, spec: { handler: Function }) {
        commands.push({ name, spec });
      },
      on() {},
    } as any;
    register(pi);
    const cmd = commands.find((c) => c.name === "inspect-text");

    let notified: string | undefined;
    const ctx: FakeCtx = {
      ui: { notify: (m: string) => (notified = m) },
    };
    await cmd!.spec.handler(`validate ${file} beta`, ctx);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.op).toBe("validate");
    expect(toolCalls[0]?.oldText).toBe("beta");
    expect(notified).toMatch(/1 (match|occurrence|time)/i);

    // Whitespace preservation: consecutive spaces in oldText must NOT be collapsed.
    // The old `split(/\s+/)` parser turned `alpha   beta` into `alpha beta`. The new parser
    // splits only on the first whitespace after the subcommand and the first whitespace after
    // the file, taking the rest verbatim.
    const fileWithSpaces = join(cwd, "spaced.txt");
    await writeFile(fileWithSpaces, "alpha   beta\n", "utf-8");
    notified = undefined;
    toolCalls.length = 0;
    await cmd!.spec.handler(`validate ${fileWithSpaces} alpha   beta`, ctx);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.oldText).toBe("alpha   beta");
    expect(notified).toMatch(/1 (match|occurrence|time)/i);

    await rm(cwd, { recursive: true, force: true });
  });

  it("the registered handler parses diff subcommand", async () => {
    const tempRoot = join(process.cwd(), ".tmp");
    await mkdir(tempRoot, { recursive: true });
    const cwd = await mkdtemp(join(tempRoot, "pi-hashline-test-"));
    const fileA = join(cwd, "a.txt");
    const fileB = join(cwd, "b.txt");
    await writeFile(fileA, "alpha\n", "utf-8");
    await writeFile(fileB, "alpha\n", "utf-8");

    const commands: Array<{ name: string; spec: { handler: Function } }> = [];
    const toolCalls: Array<{ op: string; [k: string]: unknown }> = [];
    const pi = {
      cwd: process.cwd(),
      registerTool(tool: { name: string; execute: Function }) {
        if (tool.name === "inspect_text") {
          const original = tool.execute;
          tool.execute = async (...args: unknown[]) => {
            const params = args[1] as { op: string; [k: string]: unknown };
            toolCalls.push(params);
            return original(...args);
          };
        }
      },
      registerCommand(name: string, spec: { handler: Function }) {
        commands.push({ name, spec });
      },
      on() {},
    } as any;
    register(pi);
    const cmd = commands.find((c) => c.name === "inspect-text");

    let notified: string | undefined;
    const ctx: FakeCtx = {
      ui: { notify: (m: string) => (notified = m) },
    };
    await cmd!.spec.handler(`diff ${fileA} ${fileB}`, ctx);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.op).toBe("diff");
    expect(toolCalls[0]?.fileA).toBe(fileA);
    expect(toolCalls[0]?.fileB).toBe(fileB);
    expect(notified?.toLowerCase()).toMatch(/identical/);

    await rm(cwd, { recursive: true, force: true });
  });

  it("the registered handler shows help when no subcommand is given", async () => {
    const commands: Array<{ name: string; spec: { handler: Function } }> = [];
    const pi = {
      registerTool() {},
      registerCommand(name: string, spec: { handler: Function }) {
        commands.push({ name, spec });
      },
      on() {},
    } as any;
    register(pi);
    const cmd = commands.find((c) => c.name === "inspect-text");

    let notified: string | undefined;
    const ctx: FakeCtx = {
      ui: { notify: (m: string) => (notified = m) },
    };
    await cmd!.spec.handler("", ctx);

    expect(notified).toBeDefined();
    expect(notified).toMatch(/show|validate|diff/);
  });
});
