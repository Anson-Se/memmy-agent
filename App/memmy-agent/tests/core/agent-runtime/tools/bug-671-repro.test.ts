import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApplyPatchTool } from "../../../../src/core/agent-runtime/tools/apply-patch.js";
import { EditFileTool, WriteFileTool } from "../../../../src/core/agent-runtime/tools/filesystem.js";

const roots: string[] = [];

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-bug671-"));
  roots.push(root);
  return root;
}

function input(...lines: string[]): { input: string } {
  return { input: ["*** Begin Patch", ...lines, "*** End Patch"].join("\n") };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Bug 671 reproduction", () => {
  it("accepts an in-workspace absolute path when adding", async () => {
    const root = workspace();
    const target = path.join(root, "added.txt");
    const result = await new ApplyPatchTool({ workspace: root }).execute(input(
      `*** Add File: ${target}`,
      "+added",
    ));

    expect(result).toContain("Patch applied:");
    expect(fs.readFileSync(target, "utf8")).toBe("added\n");
  });

  it("accepts an in-workspace absolute path when updating", async () => {
    const root = workspace();
    const target = path.join(root, "updated.txt");
    fs.writeFileSync(target, "before\n");
    const result = await new ApplyPatchTool({ workspace: root }).execute(input(
      `*** Update File: ${target}`,
      "@@",
      "-before",
      "+after",
    ));

    expect(result).toContain("Patch applied:");
    expect(fs.readFileSync(target, "utf8")).toBe("after\n");
  });

  it("accepts an in-workspace absolute path when deleting", async () => {
    const root = workspace();
    const target = path.join(root, "deleted.txt");
    fs.writeFileSync(target, "delete\n");
    const result = await new ApplyPatchTool({ workspace: root }).execute(input(
      `*** Delete File: ${target}`,
    ));

    expect(result).toContain("Patch applied:");
    expect(fs.existsSync(target)).toBe(false);
  });

  it("accepts an in-workspace absolute move source", async () => {
    const root = workspace();
    const source = path.join(root, "source.txt");
    fs.writeFileSync(source, "move\n");
    const result = await new ApplyPatchTool({ workspace: root }).execute(input(
      `*** Update File: ${source}`,
      "*** Move to: moved.txt",
    ));

    expect(result).toContain("Patch applied:");
    expect(fs.readFileSync(path.join(root, "moved.txt"), "utf8")).toBe("move\n");
  });

  it("accepts an in-workspace absolute move target", async () => {
    const root = workspace();
    const source = path.join(root, "source.txt");
    const target = path.join(root, "moved.txt");
    fs.writeFileSync(source, "move\n");
    const result = await new ApplyPatchTool({ workspace: root }).execute(input(
      "*** Update File: source.txt",
      `*** Move to: ${target}`,
    ));

    expect(result).toContain("Patch applied:");
    expect(fs.readFileSync(target, "utf8")).toBe("move\n");
  });

  it("continues accepting relative apply_patch paths", async () => {
    const root = workspace();
    const result = await new ApplyPatchTool({ workspace: root }).execute(input(
      "*** Add File: relative.txt",
      "+relative",
    ));

    expect(result).toContain("Patch applied:");
    expect(fs.readFileSync(path.join(root, "relative.txt"), "utf8")).toBe("relative\n");
  });

  it("matches write_file and edit_file absolute-path behavior", async () => {
    const root = workspace();
    const target = path.join(root, "other-tools.txt");
    const options = { workspace: root, allowedDir: root, postWriteValidation: false } as any;

    expect(await new WriteFileTool(options).execute({ path: target, content: "before\n" }))
      .toContain("Successfully wrote");
    expect(await new EditFileTool(options).execute({
      path: target,
      old_text: "before",
      new_text: "after",
    })).toContain("Successfully edited file");
    expect(fs.readFileSync(target, "utf8")).toBe("after\n");
  });

  it("still rejects traversal and symbolic links", async () => {
    const root = workspace();
    const outside = workspace();
    const outsideFile = path.join(outside, "outside.txt");
    const absoluteTraversal = `${root}${path.sep}nested${path.sep}..${path.sep}escaped.txt`;
    fs.writeFileSync(outsideFile, "outside\n");
    fs.symlinkSync(outsideFile, path.join(root, "outside-link.txt"));
    const tool = new ApplyPatchTool({ workspace: root });

    expect(await tool.execute(input("*** Add File: ../escaped.txt", "+escaped")))
      .toContain("must not contain '..'");
    expect(await tool.execute(input(`*** Add File: ${absoluteTraversal}`, "+escaped")))
      .toContain("must not contain '..'");
    expect(fs.existsSync(path.join(root, "escaped.txt"))).toBe(false);
    expect(await tool.execute(input(`*** Delete File: ${outsideFile}`)))
      .toContain("patch path escapes workspace");
    expect(await tool.execute(input("*** Delete File: outside-link.txt")))
      .toContain("symbolic links");
    expect(fs.readFileSync(outsideFile, "utf8")).toBe("outside\n");
  });

  it("detects conflicts after absolute and relative paths are canonicalized", async () => {
    const root = workspace();
    const absolute = path.join(root, "same.txt");
    const result = await new ApplyPatchTool({ workspace: root }).execute(input(
      `*** Add File: ${absolute}`,
      "+first",
      "*** Delete File: same.txt",
    ));

    expect(result).toContain("duplicate file operation path: same.txt");
    expect(fs.existsSync(absolute)).toBe(false);
  });
});
