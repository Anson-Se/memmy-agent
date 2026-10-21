// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { ThreadTabPreview } from "../agent-thread-panel-preview.js";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); document.body.replaceChildren(); });
async function mount(fetchFn: typeof fetch) {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); cleanup = () => act(() => root.unmount());
  await act(async () => {
    root.render(<I18nProvider language="zh-CN"><ThreadTabPreview tab={{id:"large-json",type:"file",name:"raw.json",url:"https://fixture.test/raw.json"}}
      context={{artifactClient:null,agentClient:null,sessionScope:null,environment:null,workspaceRoot:null,fetchFn}} /></I18nProvider>);
    await new Promise(resolve => setTimeout(resolve, 10));
  });
  return container;
}
describe("raw text side panel", () => {
  it("loads large files in bounded ranges and navigates to their raw tail", async () => {
    const raw = '{"n":9007199254740993,"body":"' + '中🙂'.repeat(450000) + '","tail":9007199254740993}';
    const bytes = new TextEncoder().encode(raw);
    const fetchFn = vi.fn(async (_url: any, init: any) => {
      const match = /bytes=(\d+)-(\d+)/.exec(init.headers.Range)!;
      const start = Number(match[1]); const end = Math.min(Number(match[2]), bytes.length-1);
      return new Response(bytes.slice(start,end+1).buffer, {status:206, headers:{"content-range":`bytes ${start}-${end}/${bytes.length}`}});
    });
    const container = await mount(fetchFn as typeof fetch);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('9007199254740993');
    expect(container.textContent).not.toContain('9007199254740992');
    const first = container.querySelector('pre')!.textContent!;
    expect(first).not.toContain('\uFFFD'); expect(first.length).toBeLessThan(262145);
    const last = [...container.querySelectorAll('button')].find(button => button.textContent === '末尾')!;
    await act(async () => { last.click(); await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(container.querySelector('pre')!.textContent).toContain('"tail":9007199254740993}');
    expect(container.querySelector('pre')!.textContent).not.toContain('\uFFFD');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
  it("keeps short raw JSON integers in the preview", async () => {
    const container = await mount(vi.fn(async () => new Response(' {"n":9007199254740993,  "x":1}  ')) as typeof fetch);
    expect(container.textContent).toContain('9007199254740993');
    expect(container.textContent).not.toContain('9007199254740992');
  });
  it("reports a removed file instead of rendering a fake preview", async () => {
    const container = await mount(vi.fn(async () => new Response('not found',{status:404})) as typeof fetch);
    expect(container.textContent).toContain('文件已移动、删除或无法访问');
    expect(container.querySelector('pre')).toBeNull();
  });
});
