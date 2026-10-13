import { describe, expect, it, vi } from "vitest";
import { createHttpPluginRegistry } from "../http-plugin-registry.js";

const release = {
  manifest: {
    apiVersion: "memmy/v1",
    id: "com.example.review",
    name: "Review",
    version: "1.0.0",
    runtime: { adapter: "http", config: { baseUrl: "https://plugin.example" } },
    capabilities: [{
      id: "run",
      name: "Run",
      description: "Run review",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      execution: "request"
    }],
    permissions: [{ type: "network", hosts: ["plugin.example"] }]
  },
  artifact: {
    url: "https://registry.example/artifacts/review.zip",
    sha256: "a".repeat(64)
  }
};

describe("HttpPluginRegistry", () => {
  it("resolves a plugin by id and version without accepting a client URL", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(release), {
      headers: { "content-type": "application/json" }
    }));
    const registry = createHttpPluginRegistry({ baseUrl: "https://registry.example", fetchFn: fetchFn as typeof fetch });
    await expect(registry.resolve(release.manifest.id, "1.0.0")).resolves.toEqual(release);
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe(
      "https://registry.example/api/v1/plugins/com.example.review?version=1.0.0"
    );
  });

  it("rejects a mismatched manifest", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      ...release,
      manifest: { ...release.manifest, id: "com.example.other" }
    })));
    const registry = createHttpPluginRegistry({ baseUrl: "https://registry.example", fetchFn: fetchFn as typeof fetch });
    await expect(registry.resolve(release.manifest.id)).rejects.toThrow(/different release/);
  });

  it("keeps the catalog version when the default changes and rejects a server substitution", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/plugins") return new Response(JSON.stringify([release.manifest]));
      const selected = url.searchParams.get("version") ?? "2.0.0";
      return new Response(JSON.stringify({ ...release, manifest: { ...release.manifest, version: selected } }));
    });
    const registry = createHttpPluginRegistry({ baseUrl: "https://registry.example", fetchFn: fetchFn as typeof fetch });
    const [selected] = await registry.list!();
    expect((await registry.resolve(selected!.id, selected!.version)).manifest.version).toBe("1.0.0");
    fetchFn.mockImplementation(async () => new Response(JSON.stringify({
      ...release, manifest: { ...release.manifest, version: "2.0.0" }
    })));
    await expect(registry.resolve(selected!.id, selected!.version)).rejects.toThrow(/different release/);
  });

  it("rejects an insecure non-loopback registry", () => {
    expect(() => createHttpPluginRegistry({ baseUrl: "http://registry.example" })).toThrow(/HTTPS/);
  });
});
