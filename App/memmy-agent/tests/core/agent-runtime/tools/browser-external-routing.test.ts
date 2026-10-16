import { expect, it, vi } from "vitest";
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserSessionManager } from "../../../../src/core/agent-runtime/tools/browser.js";
import type { ExternalBrowserSessionRouter } from "../../../../src/core/agent-runtime/tools/external-browser-session-router.js";
import { OpenAICompatProvider } from "../../../../src/providers/openai-compat-provider.js";
import { findByName } from "../../../../src/providers/registry.js";
import { estimateMessageTokens } from "../../../../src/utils/helpers.js";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

it.each([
  { browser: 'chrome' as const, explicit: true },
  { browser: 'edge' as const, explicit: true },
  { browser: 'chrome' as const, explicit: false },
  { browser: 'edge' as const, explicit: false },
])('sends $browser screenshots as image inputs for explicit=$explicit targeting', async ({ browser, explicit }) => {
  const scope = { sessionKey: 'screenshots', channel: 'projected-session', chatId: 'screenshots' };
  const claim = { connectionId: 'browser', tabId: 5, browser,
    title: 'Product', url: 'https://example.test/', claimedAt: 1 };
  const raw = [
    { type: 'text', text: 'Screenshot saved to the browser output directory.' },
    { type: 'image', mimeType: 'image/png', data: PNG_BASE64 },
  ];
  const router = {
    select: vi.fn(() => claim), selectBrowser: vi.fn(() => claim),
    call: vi.fn(async () => raw), closeAll: vi.fn(),
  } as unknown as ExternalBrowserSessionRouter;
  const manager = new BrowserSessionManager({ enabled: true }, {
    desktopManaged: false, externalRouter: router, embeddedBridge: null,
    runtimeLoader: vi.fn(async () => { throw new Error('Playwright should not start'); }),
  });
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-screenshot-model-input-'));
  vi.stubEnv('MEMMY_AGENT_DATA_DIR', dataRoot);
  try {
    const messages: Record<string, any>[] = [{ role: 'user', content: 'B' }];
    for (let index = 0; index < 4; index += 1) {
      const content = await manager.callTool(scope, 'browser_take_screenshot',
        explicit ? { targetBrowser: browser, type: 'png' } : { type: 'png' });
      expect(content).toEqual([
        raw[0],
        { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_BASE64}`, detail: 'auto' },
          meta: { path: expect.any(String) } },
      ]);
      const image = (content as Record<string, any>[])[1];
      expect(fs.readFileSync(image.meta.path)).toEqual(Buffer.from(PNG_BASE64, 'base64'));
      const id = `screenshot-${index}`;
      messages.push({ role: 'assistant', content: '', tool_calls: [
        { id, type: 'function', function: { name: 'browser_take_screenshot', arguments: '{}' } },
      ] }, { role: 'tool', tool_call_id: id, name: 'browser_take_screenshot', content });
      expect(estimateMessageTokens(messages.at(-1)!)).toBeLessThan(5_000);
    }
    for (const provider of [
      new OpenAICompatProvider({ apiKey: 'test', defaultModel: 'agent_chat', spec: findByName('memmy_account') }),
      new OpenAICompatProvider({ apiKey: 'test', defaultModel: 'vision-model' }),
    ]) {
      const body = provider.buildKwargs({ messages });
      const toolMessages = body.messages.filter((message: any) => message.role === 'tool');
      expect(toolMessages).toHaveLength(4);
      expect(toolMessages.map((message: any) => message.content).join('\n')).not.toContain(PNG_BASE64);
      const images = body.messages.flatMap((message: any) =>
        Array.isArray(message.content) ? message.content.filter((block: any) => block.type === 'image_url') : []);
      expect(images).toHaveLength(4);
      expect(images.every((image: any) => image.image_url.url === `data:image/png;base64,${PNG_BASE64}`)).toBe(true);
    }
    expect(raw[1]).toEqual({ type: 'image', mimeType: 'image/png', data: PNG_BASE64 });
  } finally {
    await manager.close();
    vi.unstubAllEnvs();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

it.each([
  { data: 'invalid-base64-payload', mimeType: 'image/png' },
  { data: PNG_BASE64, mimeType: 'image/jpeg' },
])('does not forward malformed screenshot bytes as model text ($mimeType)', async (image) => {
  const scope = { sessionKey: 'invalid-image', channel: 'projected-session', chatId: 'invalid-image' };
  const claim = { connectionId: 'browser', tabId: 5, browser: 'edge' as const,
    title: 'Product', url: 'https://example.test/', claimedAt: 1 };
  const router = { select: () => claim,
    call: vi.fn(async () => [{ type: 'image', ...image }]), closeAll: vi.fn(),
  } as unknown as ExternalBrowserSessionRouter;
  const manager = new BrowserSessionManager({ enabled: true }, {
    desktopManaged: false, externalRouter: router, embeddedBridge: null,
  });
  try {
    const content = await manager.callTool(scope, 'browser_take_screenshot', {});
    expect(content).toEqual([{ type: 'text', text: expect.stringContaining('[image unavailable:') }]);
    expect(JSON.stringify(content)).not.toContain(image.data);
  } finally { await manager.close(); }
});

it("routes Agent tools and sidebar actions to the claimed external tab without launching Playwright", async () => {
  const scope = { sessionKey: "chat", channel: "projected-session", chatId: "chat" };
  const claim = { connectionId: "browser", tabId: 5, browser: "chrome" as const,
    title: "Test", url: "https://example.test/", claimedAt: 1 };
  const router = {
    select: vi.fn(() => claim),
    call: vi.fn(async () => [{ type: "text", text: "[ax-1] button" }]),
    handleSurfaceAction: vi.fn(async () => true),
    closeSession: vi.fn(), closeChat: vi.fn(), finishTurn: vi.fn(async () => undefined), closeAll: vi.fn(),
  } as unknown as ExternalBrowserSessionRouter;
  const manager = new BrowserSessionManager({ enabled: true }, {
    desktopManaged: false, externalRouter: router,
    runtimeLoader: vi.fn(async () => { throw new Error("Playwright should not start"); }),
  });
  expect(await manager.callTool(scope, "browser_snapshot", {})).toEqual([
    { type: "text", text: "[ax-1] button" },
  ]);
  expect(router.select).toHaveBeenCalledWith(scope, false);
  expect(router.call).toHaveBeenCalledWith(scope, claim, "browser_snapshot", {}, null);
  const action = { type: "memmy:computer-use-surface:action" as const,
    surface: "browser" as const, ...scope, targetId: "external:browser:5",
    action: "click" as const, x: 0.2, y: 0.3 };
  await (manager as any).handleSurfaceAction(action);
  expect(router.handleSurfaceAction).toHaveBeenCalledWith(action);
  await manager.closeSurfacesForTurn(scope);
  expect(router.finishTurn).toHaveBeenCalledWith(scope);
  await manager.closeSession(scope);
  expect(router.closeSession).toHaveBeenCalledWith(scope);
  await manager.close();
  expect(router.closeAll).toHaveBeenCalledOnce();
});

it('routes external uploads through workspace validation and the approval path', async () => {
  const scope = { sessionKey: 'upload', channel: 'projected-session', chatId: 'upload' };
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-external-upload-'));
  const source = path.join(workspace, 'document.txt');
  fs.writeFileSync(source, 'test');
  const claim = { connectionId: 'browser', tabId: 5, browser: 'chrome' as const,
    title: 'Form', url: 'https://example.test/form', claimedAt: 1 };
  const upload = vi.fn(async () => [{ type: 'text', text: '{"uploaded":1}' }]);
  const router = { select: () => claim, upload, closeAll: vi.fn() } as unknown as ExternalBrowserSessionRouter;
  const manager = new BrowserSessionManager({ enabled: true }, {
    desktopManaged: false, externalRouter: router, embeddedBridge: null,
    runtimeLoader: vi.fn(async () => { throw new Error('Playwright should not start'); }),
  });
  try {
    await expect(manager.callTool(scope, 'browser_file_upload', { target: 'ax-1', paths: ['/etc/passwd'] },
      null, { workspace, readonlyRoots: [] })).rejects.toThrow(/outside the trusted workspace/);
    expect(upload).not.toHaveBeenCalled();
    await manager.callTool(scope, 'browser_file_upload', { target: 'ax-1', paths: [source] },
      null, { workspace, readonlyRoots: [] });
    expect(upload).toHaveBeenCalledWith(scope, claim, { target: 'ax-1', paths: [source] },
      expect.any(Function), null);
  } finally { await manager.close(); fs.rmSync(workspace, { recursive: true, force: true }); }
});
