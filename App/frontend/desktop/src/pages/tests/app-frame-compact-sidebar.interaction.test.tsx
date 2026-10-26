// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppProviders } from "../../app/providers.js";
import { agentActions, appActions } from "../../state/app-actions.js";
import { useAppState } from "../../state/app-state.js";
import { AppFrame } from "../app-frame.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("AppFrame compact sidebar", () => {
  let container: HTMLDivElement;
  let root: Root;
  let compact: boolean;
  let stylesheet: HTMLStyleElement;
  const initialViewport = { width: window.innerWidth, height: window.innerHeight };
  let selectionSnapshot: { path: string; session: string | null; chat: string | null; draft: number } | null;
  const viewport = (width: number, height = 1000) => {
    (window as unknown as { happyDOM: { setViewport: (size: { width: number; height: number }) => void } })
      .happyDOM.setViewport({ width, height });
  };
  let listeners: Set<(event: MediaQueryListEvent) => void>;

  beforeEach(() => {
    compact = true;
    selectionSnapshot = null;
    viewport(640);
    listeners = new Set();
    const query = {
      get matches() { return compact; },
      media: "(max-width: 720px)",
      onchange: null,
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: () => true
    } as unknown as MediaQueryList;
    vi.spyOn(window, "matchMedia").mockReturnValue(query);
    Object.defineProperty(window, "localStorage", { configurable: true, value: createMemoryStorage() });
    Object.defineProperty(window, "sessionStorage", { configurable: true, value: createMemoryStorage() });
    Reflect.deleteProperty(window, "memmy");
    stylesheet = document.createElement("style");
    stylesheet.textContent = readFileSync(resolve(process.cwd(), "src/theme/tokens.css"), "utf8")
      + readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8").replace(/^@import[^;]*;\s*/gm, "");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.restoreAllMocks();
    stylesheet.remove();
    document.body.replaceChildren();
    viewport(initialViewport.width, initialViewport.height);
  });

  const sidebar = () => container.querySelector<HTMLElement>(".app-frame-sidebar")!;
  const restore = () => container.querySelector<HTMLButtonElement>(".sidebar-restore-button")!;
  const backdrop = () => container.querySelector<HTMLButtonElement>(".app-frame-sidebar-backdrop");
  const render = (withSelectedTask = false) => {
    // CSS media queries use HappyDOM's browser viewport, not an innerWidth override.
    // Establish it before injecting the actual stylesheet or reading computed CSS.
    viewport(compact ? 640 : 1280);
    document.head.append(stylesheet);
    act(() => root.render(<AppProviders>
      {withSelectedTask ? <SelectedTaskSeeder /> : null}
      <AppFrame title="Workspace"><div>Content</div></AppFrame>
    </AppProviders>));
  };
  const resize = (matches: boolean) => act(() => {
    compact = matches;
    viewport(matches ? 640 : 1280);
    // Recreate unchanged rules to invalidate HappyDOM's cached media evaluation.
    const css = stylesheet.textContent;
    stylesheet.remove();
    stylesheet = document.createElement("style");
    stylesheet.textContent = css;
    document.head.append(stylesheet);
    window.dispatchEvent(new Event("resize"));
    for (const listener of listeners) listener({ matches } as MediaQueryListEvent);
  });

  it("starts closed and supports opening, Escape, and backdrop dismissal", () => {
    render();
    expect(sidebar().getAttribute("aria-hidden")).toBe("true");
    expect(sidebar().hasAttribute("inert")).toBe(true);
    expect(window.getComputedStyle(sidebar()).position).toBe("fixed");
    expect(window.getComputedStyle(sidebar()).transform).toBe("translateX(-100%)");
    expect(backdrop()).toBeNull();
    act(() => restore().click());
    expect(sidebar().getAttribute("aria-hidden")).toBeNull();
    expect(backdrop()).not.toBeNull();
    expect(window.getComputedStyle(backdrop()!).display).toBe("block");
    expect(window.getComputedStyle(sidebar()).transform).toBe("translateX(0)");
    expect(container.querySelector(".sidebar-resize-handle--disabled")).not.toBeNull();
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(sidebar().getAttribute("aria-hidden")).toBe("true");
    act(() => restore().click());
    act(() => backdrop()!.click());
    expect(sidebar().getAttribute("aria-hidden")).toBe("true");
  });

  it("closes after selecting a navigation destination", () => {
    render();
    act(() => restore().click());
    act(() => container.querySelector<HTMLButtonElement>('[data-tour-anchor="product-tour-tools-nav"]')!.click());
    expect(sidebar().getAttribute("aria-hidden")).toBe("true");
    expect(backdrop()).toBeNull();
  });

  it("closes when the already selected task is reopened without changing its route or session", () => {
    render(true);
    expect(selectionSnapshot).toMatchObject({ path: "/main", session: "websocket:selected-task", chat: "selected-task" });
    act(() => restore().click());
    const before = { ...selectionSnapshot! };
    const selectedTask = Array.from(container.querySelectorAll<HTMLButtonElement>("button.app-frame-task-row__main"))
      .find((button) => button.textContent?.includes("Current selected task"));
    expect(selectedTask).toBeDefined();
    act(() => selectedTask!.click());
    expect(selectionSnapshot).toEqual(before);
    expect(sidebar().getAttribute("aria-hidden")).toBe("true");
    expect(backdrop()).toBeNull();
  });

  it("preserves the desktop visibility preference across the compact breakpoint", () => {
    compact = false;
    render();
    expect(sidebar().getAttribute("aria-hidden")).toBeNull();
    act(() => sidebar().querySelector<HTMLButtonElement>(".sidebar-toolbar-button")!.click());
    expect(sidebar().style.width).toBe("0px");
    resize(true);
    act(() => restore().click());
    expect(sidebar().getAttribute("aria-hidden")).toBeNull();
    expect(sidebar().style.width).toBe("");
    resize(false);
    expect(sidebar().getAttribute("aria-hidden")).toBe("true");
    expect(sidebar().style.width).toBe("0px");
    act(() => restore().click());
    expect(sidebar().getAttribute("aria-hidden")).toBeNull();
  });
  function SelectedTaskSeeder() {
    const { state, dispatch } = useAppState();
    selectionSnapshot = {
      path: state.navigation.currentPath,
      session: state.agent.currentSessionKey,
      chat: state.agent.currentChatId,
      draft: state.agent.newChatRequestId
    };
    useEffect(() => {
      const key = "websocket:selected-task";
      const requestId = "selected-task-request";
      dispatch(appActions.navigate("/main"));
      dispatch(agentActions.sessionsLoaded([{
        key, title: "Current selected task", preview: "Current selected task", updatedAt: "2026-10-23T08:00:00.000Z",
        projectId: null, cwd: "/workspace"
      }]));
      dispatch(agentActions.historyLoading(key, "selected-task", requestId));
      dispatch(agentActions.historyLoaded({
        schemaVersion: 1, sessionKey: key, last_turn_closed: true,
        messages: [{ role: "user", content: "Current selected task" }, { role: "assistant", content: "Ready" }]
      }, requestId));
    }, [dispatch]);
    return null;
  }
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
