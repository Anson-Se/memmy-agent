import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("standalone runtime packaging", () => {
  it("targets the Node 24 pkg runtime and keeps both Linux sqlite prebuilds", async () => {
    const source = await readFile(resolve(import.meta.dirname, "../src/cli/scripts/build-standalone.mjs"), "utf8");
    expect(source).toContain('const PKG_NODE_RANGE = "node24";');
    expect(source).toContain("linux-${arch}.node");
    expect(source).toContain("linuxmusl-${arch}.node");
    expect(source).toContain("better-sqlite3 has no ${name} prebuild");
  });
});
