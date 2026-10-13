import { describe, expect, it, vi } from "vitest";
import { callExternalBrowserTool } from "../../../../src/core/agent-runtime/tools/external-browser-tools.js";
import type { ExternalBrowserBridge, ExternalBrowserClaim } from "../../../../src/core/agent-runtime/tools/external-browser-bridge.js";
import * as surfaces from '../../../../src/tools/computer-use/surface-preview.js';

const claim: ExternalBrowserClaim = {
  connectionId: "test", tabId: 4, browser: "chrome",
  title: "Local page", url: "https://example.test/", claimedAt: 1,
};
const scope = { sessionKey: "s", channel: "projected-session", chatId: "s" };

describe("external browser tool adapter", () => {
  it('keeps in-app text and DOM actions without requesting screenshots or publishing image previews', async () => {
    const embedded = { ...claim, browser: 'memmy' as const };
    const command = vi.fn(async (_claim, operation) => operation === 'snapshot'
      ? { nodes: [{ ref: 'ax-9', role: 'button', name: 'Continue' }] } : { clicked: true });
    const bridge = { command } as unknown as ExternalBrowserBridge;
    const publish = vi.spyOn(surfaces, 'emitComputerUseSurface');
    try {
      expect(await callExternalBrowserTool(bridge, embedded, scope, 'browser_snapshot', {}, async () => true))
        .toEqual([{ type: 'text', text: '[ax-9] button "Continue"' }]);
      expect(await callExternalBrowserTool(bridge, embedded, scope, 'browser_click', { target: 'ax-9' }, async () => true))
        .toEqual([{ type: 'text', text: '{"clicked":true}' }]);
      expect(command.mock.calls.map(call => call[1])).toEqual(['snapshot', 'click']);
      expect(publish).not.toHaveBeenCalled();
      command.mockClear();
      await expect(callExternalBrowserTool(bridge, embedded, scope, 'browser_take_screenshot', {}, async () => true))
        .rejects.toThrow(/not supported.*browser_snapshot/);
      expect(command).not.toHaveBeenCalled();
    } finally { publish.mockRestore(); }
  });

  it("formats AX references as model targets without exposing other tab metadata", async () => {
    const command = vi.fn(async () => ({ nodes: [
      { ref: "ax-9", role: "button", name: "Continue", value: "" },
    ], tab: { id: 99, url: "https://other.test/" } }));
    const result = await callExternalBrowserTool({ command } as unknown as ExternalBrowserBridge,
      claim, scope, "browser_snapshot", {}, async () => false);
    expect(result).toEqual([{ type: "text", text: '[ax-9] button "Continue"' }]);
    expect(command).toHaveBeenNthCalledWith(1, claim, "snapshot", {});
  });

  it("requires site approval before granting cross-origin navigation", async () => {
    const command = vi.fn(async (_claim, operation) => operation === "screenshot"
      ? { format: "jpeg", data: "AAA" } : {});
    const bridge = { command } as unknown as ExternalBrowserBridge;
    await expect(callExternalBrowserTool(bridge, claim, scope,
      "browser_navigate", { url: "https://other.test/" }, async () => false))
      .rejects.toThrow(/not approved/);
    expect(command).not.toHaveBeenCalled();
    const approve = vi.fn(async () => true);
    await callExternalBrowserTool(bridge, claim, scope,
      "browser_navigate", { url: "https://other.test/" }, approve);
    expect(approve).toHaveBeenCalledWith("https://other.test/");
    expect(command.mock.calls.slice(0, 2).map(call => call[1])).toEqual(["allowOrigin", "navigate"]);
  });

  it("returns a real image item for screenshot tool calls", async () => {
    const command = vi.fn(async () => ({ format: "png", data: "AAAA" }));
    const result = await callExternalBrowserTool({ command } as unknown as ExternalBrowserBridge,
      claim, scope, "browser_take_screenshot", { type: "png" }, async () => false);
    expect(result).toContainEqual({ type: "image", mimeType: "image/png", data: "AAAA" });
  });
});
