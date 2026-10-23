// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRuntimeBridge } from "../../app/agent-runtime-bridge.js";
import { AppProviders } from "../../app/providers.js";
import { HomePage } from "../home-page.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("HomePage composer menus", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(window, "localStorage", { configurable: true, value: createMemoryStorage() });
    Object.defineProperty(window, "sessionStorage", { configurable: true, value: createMemoryStorage() });
    Reflect.deleteProperty(window, "memmy");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(<AppProviders><AgentRuntimeBridge><HomePage /></AgentRuntimeBridge></AppProviders>));
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  const menu = () => container.querySelector<HTMLDetailsElement>(".agent-composer-attach-menu")!;
  const menuItems = () => Array.from(menu().querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
  const fileInput = () => container.querySelector<HTMLInputElement>('input[type="file"]:not([webkitdirectory])')!;
  const folderInput = () => container.querySelector<HTMLInputElement>('input[type="file"][webkitdirectory]')!;
  const open = () => act(() => { menu().open = true; });

  it("uses native disclosure and button semantics for both upload actions", () => {
    expect(menu().querySelector("summary")?.getAttribute("aria-label")).toBe("添加资料");
    expect(menuItems().map((item) => [item.type, item.textContent])).toEqual([
      ["button", "上传文件"], ["button", "上传文件夹"]
    ]);
    expect(fileInput().hasAttribute("hidden")).toBe(true);
    expect(folderInput().hasAttribute("hidden")).toBe(true);
  });

  it("opens only the file picker and dismisses the menu when choosing files", () => {
    const files = vi.spyOn(fileInput(), "click").mockImplementation(() => undefined);
    const folders = vi.spyOn(folderInput(), "click").mockImplementation(() => undefined);
    open();
    act(() => menuItems()[0]!.click());
    expect(files).toHaveBeenCalledOnce();
    expect(folders).not.toHaveBeenCalled();
    expect(menu().open).toBe(false);
    expect(document.activeElement).toBe(menu().querySelector("summary"));
  });

  it("opens only the directory picker and dismisses the menu when choosing a folder", () => {
    const files = vi.spyOn(fileInput(), "click").mockImplementation(() => undefined);
    const folders = vi.spyOn(folderInput(), "click").mockImplementation(() => undefined);
    open();
    act(() => menuItems()[1]!.click());
    expect(folders).toHaveBeenCalledOnce();
    expect(files).not.toHaveBeenCalled();
    expect(menu().open).toBe(false);
    expect(document.activeElement).toBe(menu().querySelector("summary"));
  });

  it("dismisses uploads with Escape without opening a picker", () => {
    const files = vi.spyOn(fileInput(), "click").mockImplementation(() => undefined);
    open();
    menuItems()[0]!.focus();
    act(() => menuItems()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(menu().open).toBe(false);
    expect(files).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(menu().querySelector("summary"));
  });

  it("keeps inside pointer presses open and dismisses on click-away", () => {
    open();
    act(() => menuItems()[0]!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    expect(menu().open).toBe(true);
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    act(() => outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    expect(menu().open).toBe(false);
    expect(document.activeElement).toBe(outside);
  });

  it("opens the capability list and dismisses it with Escape", () => {
    const capability = container.querySelector<HTMLButtonElement>(".composer-quick-actions__anchor > button")!;
    act(() => capability.click());
    expect(capability.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[role="listbox"]')).not.toBeNull();
    const option = container.querySelector<HTMLButtonElement>('[role="option"]')!;
    option.focus();
    act(() => option.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(capability.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(capability);
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });
});

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value))
  };
}
