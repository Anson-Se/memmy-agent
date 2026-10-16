// @vitest-environment happy-dom

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCapability, ModelConfigInput, ModelConfigTestInput } from "@memmy/local-api-contracts";
import { createMemmyConfigWriter } from "../../../../../backend/src/infrastructure/memmy-config/index.js";
import { createAppConfigService, type CreateAppConfigServiceOptions } from "../../../../../backend/src/services/app-config-service.js";
import { createHttpConfigClient } from "../../api/config-client.js";
import type { AppClients } from "../../api/client-types.js";
import { createInitialAppState, type AppState } from "../../state/app-reducer.js";
import { assignedCatalogEndpointId, assignCatalogPreset, createModelWorkspace, modelConfigInput, upsertByokPreset } from "../../state/model-workspace.js";
import { ApiKeyPage } from "../api-key-page.js";
import { ApiKeyOptionalPage } from "../api-key-optional-page.js";
import { ModelPage } from "../model-page.js";

const mocks = vi.hoisted(() => ({ clients: null as AppClients | null, state: null as AppState | null, dispatch: vi.fn() }));
vi.mock("../../app/providers.js", () => ({ useApiClients: () => ({ clients: mocks.clients }) }));
vi.mock("../../state/app-state.js", () => ({ useAppState: () => ({ state: mocks.state, dispatch: mocks.dispatch }) }));
vi.mock("../../analytics/use-analytics.js", () => ({ useAnalytics: () => ({ track: vi.fn() }) }));
vi.mock("../../i18n/use-translation.js", () => ({ useTranslation: () => ({ t: (key: string) => key, language: "zh-CN" }) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Use the real HTTP client conversion, backend secret resolution and catalog file writer.
// Only transport and the external model provider are replaced; no real keys or network calls.
async function createServer(directory: string, independent = true) {
  const writer = createMemmyConfigWriter({ configPath: join(directory, "config.yaml") });
  const probe = vi.fn(async (_input: ModelConfigTestInput & { apiKey: string }) => ({
    ok: true, message: "ok", checkedAt: "2026-10-16T00:00:00.000Z"
  }));
  const service = createAppConfigService({
    bootstrapRepository: {} as CreateAppConfigServiceOptions["bootstrapRepository"],
    memmyConfigWriter: writer,
    modelConfigTester: { test: probe }
  });
  const write = vi.spyOn(service, "setModelConfig");
  vi.stubGlobal("fetch", vi.fn(async (url: URL, init: RequestInit) => {
    const path = new URL(url).pathname;
    let data: unknown;
    if (path.endsWith("/test")) data = await service.testModelConfig(JSON.parse(String(init.body)));
    else if (path === "/api/app/model-config") data = init.method === "GET"
      ? await service.getModelConfig() : await service.setModelConfig(JSON.parse(String(init.body)) as ModelConfigInput);
    else throw new Error(`Unexpected request: ${path}`);
    return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
  }));
  const client = createHttpConfigClient({ baseUrl: "http://test.invalid", localToken: "test-only" });
  client.updateSettings = vi.fn(async (input) => input) as typeof client.updateSettings;
  client.updateOnboarding = vi.fn(async (input) => input) as typeof client.updateOnboarding;
  let workspace = createModelWorkspace(await service.getModelConfig());
  for (const [capability, provider, protocol, model, key] of [
    ["agent", "openai", "openai-chat-completions", "same-model", "sk-personal-1111"],
    ["embedding", "openai", "openai-embeddings", "embed-model", "sk-embedding-2222"],
    ["asr", "qwen", "dashscope-input-audio-chat", "qwen3-asr-flash", "sk-asr-3333"],
    ["image_generation", "openai", "openai-images", "image-model", "sk-image-4444"],
    ...(independent ? [
      ["memory_evolution", "openai", "openai-chat-completions", "same-model", "sk-team-1111"],
      ["memory_summary", "openai", "openai-chat-completions", "same-model", "sk-summary-1111"]
    ] : [])
  ] as const) {
    const preset = upsertByokPreset(workspace, {
      provider, protocol, model, apiKey: key, endpoint: "https://provider.example/v1", capabilities: [capability]
    });
    workspace = assignCatalogPreset(preset.workspace, "byok", capability, preset.presetId);
  }
  // Same route/model/capabilities and same displayed mask, but a different secret.
  // Saving the primary key must never resolve to this unassigned alternative.
  workspace = upsertByokPreset(workspace, {
    provider: "openai", protocol: "openai-chat-completions", model: "same-model",
    apiKey: "sk-alternative-1111", endpoint: "https://provider.example/v1", capabilities: ["agent"]
  }).workspace;
  await client.saveModelCatalog(modelConfigInput(workspace));
  write.mockClear();
  return {
    client, probe, write, writer,
    read: () => client.getModelConfig(),
    async key(capability: ModelCapability) {
      const config = await client.getModelConfig();
      const workspace = createModelWorkspace(config);
      const id = assignedCatalogEndpointId(workspace, "byok", capability)!;
      const provider = config.catalog!.providers.find((provider) => provider.endpoints.some((endpoint) => endpoint.endpointId === id))!;
      return writer.readEndpointApiKey!(provider.provider, id);
    }
  };
}

type Scenario = { role: ModelCapability; page: () => ReactNode; endpoint: string; model: string; key: string; expected: string; index: number; fieldIndex?: number };
const scenarios: Scenario[] = [
  { role: "agent", page: () => <ApiKeyPage />, endpoint: "apiKey.endpoint", model: "apiKey.model", key: "apiKey.key", expected: "sk-personal-1111", index: 0 },
  { role: "embedding", page: () => <ApiKeyPage />, endpoint: "apiKey.embeddingEndpoint", model: "apiKey.embeddingModel", key: "apiKey.embeddingKey", expected: "sk-embedding-2222", index: 1 },
  { role: "asr", page: () => <ApiKeyOptionalPage />, endpoint: "apiKey.asrEndpoint", model: "apiKey.asrModel", key: "apiKey.asrKey", expected: "sk-asr-3333", index: 0 },
  { role: "image_generation", page: () => <ApiKeyOptionalPage />, endpoint: "apiKey.imageGenEndpoint", model: "apiKey.imageGenModel", key: "apiKey.imageGenKey", expected: "sk-image-4444", index: 1 },
  { role: "memory_evolution", page: () => <ModelPage />, endpoint: "apiKey.endpoint", model: "apiKey.model", key: "API Key", expected: "sk-team-1111", index: 1, fieldIndex: 1 },
  { role: "memory_summary", page: () => <ModelPage />, endpoint: "apiKey.endpoint", model: "apiKey.model", key: "API Key", expected: "sk-summary-1111", index: 0, fieldIndex: 0 }
];

describe("BYOK displayed, tested and saved credentials", () => {
  let directory: string;
  let container: HTMLDivElement;
  let root: Root;
  let server: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    directory = await mkdtemp(join(tmpdir(), "memmy-byok-review-"));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    server = await createServer(directory);
    mocks.state = { ...createInitialAppState(), modelConfig: await server.read() };
    mocks.clients = { config: server.client } as AppClients;
  });
  afterEach(async () => {
    act(() => root.unmount());
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  async function render(page: ReactNode) { await act(async () => root.render(page)); }
  async function click(button: HTMLButtonElement) { await act(async () => button.click()); }
  function next() { return [...container.querySelectorAll("button")].find((button) => button.textContent === "apiKey.next")!; }
  function test(index: number) { return [...container.querySelectorAll("button")].filter((button) => button.textContent?.startsWith("apiKey.test"))[index]!; }
  function field(label: string, index = 0) {
    return [...container.querySelectorAll("label")].filter((node) => node.textContent === label)[index]!.parentElement!.querySelector("input")!;
  }
  async function change(input: HTMLInputElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function testAndSave(scenario: Scenario) {
    const count = server.probe.mock.calls.length;
    await click(test(scenario.index));
    await vi.waitFor(() => expect(server.probe).toHaveBeenCalledTimes(count + 1));
    await vi.waitFor(() => expect(test(scenario.index).textContent).toBe("apiKey.testSuccess"));
    const tested = server.probe.mock.calls.at(-1)![0];
    const writes = server.write.mock.calls.length;
    await click(next());
    await vi.waitFor(() => expect(server.write.mock.calls.length).toBeGreaterThan(writes));
    await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "navigation/changed" })));
    expect(await server.key(scenario.role)).toBe(tested.apiKey);
    return tested;
  }

  it.each(scenarios)("$role: unchanged masked credential resolves and persists the same real key", async (scenario) => {
    await render(scenario.page());
    expect(field(scenario.key, scenario.fieldIndex).value).toBe("");
    expect(field(scenario.key, scenario.fieldIndex).placeholder).toContain(scenario.expected.slice(-4));
    expect((await testAndSave(scenario)).apiKey).toBe(scenario.expected);
  });

  it.each(scenarios)("$role: changed URL blocks old credentials; explicit key tests and saves a separate connection", async (scenario) => {
    const original = await server.read();
    const oldId = assignedCatalogEndpointId(createModelWorkspace(original), "byok", scenario.role)!;
    const oldProvider = original.catalog!.providers.find((provider) => provider.endpoints.some((endpoint) => endpoint.endpointId === oldId))!.provider;
    await render(scenario.page());
    await click(test(scenario.index));
    await vi.waitFor(() => expect(test(scenario.index).textContent).toBe("apiKey.testSuccess"));
    await change(field(scenario.endpoint, scenario.fieldIndex), "https://changed.example/v1");
    expect(field(scenario.key, scenario.fieldIndex).placeholder).toBe("sk-...");
    expect(container.textContent).toContain("apiKey.credentialsChanged");
    expect(test(scenario.index).textContent).not.toBe("apiKey.testSuccess");
    const calls = server.probe.mock.calls.length;
    await click(test(scenario.index));
    expect(server.probe).toHaveBeenCalledTimes(calls);
    await click(next());
    expect(server.write).not.toHaveBeenCalled();
    // The same key may be entered again; no new provider credential is required.
    await change(field(scenario.key, scenario.fieldIndex), scenario.expected);
    const result = await testAndSave(scenario);
    expect(result.apiBase).toBe("https://changed.example/v1");
    expect(result.apiKey).toBe(scenario.expected);
    const saved = await server.read();
    expect(assignedCatalogEndpointId(createModelWorkspace(saved), "byok", scenario.role)).not.toBe(oldId);
    expect(await server.writer.readEndpointApiKey!(oldProvider, oldId)).toBe(scenario.expected);
    expect(saved.catalog!.providers.find((provider) => provider.provider === oldProvider)!.endpoints.find((endpoint) => endpoint.endpointId === oldId)!.apiBase).toBe("https://provider.example/v1");
  });

  it.each(scenarios.filter((scenario) => scenario.role !== "asr"))("$role: model-only edits retain the key but invalidate the test", async (scenario) => {
    const oldId = assignedCatalogEndpointId(createModelWorkspace(await server.read()), "byok", scenario.role);
    await render(scenario.page());
    await change(field(scenario.model, scenario.fieldIndex), "changed-model");
    expect(container.textContent).toContain("apiKey.testStale");
    expect(field(scenario.key, scenario.fieldIndex).placeholder).toContain(scenario.expected.slice(-4));
    const tested = await testAndSave(scenario);
    expect(tested.apiKey).toBe(scenario.expected);
    expect(tested.modelId).toBe("changed-model");
    expect(assignedCatalogEndpointId(createModelWorkspace(await server.read()), "byok", scenario.role)).toBe(oldId);
  });

  it.each(scenarios)("$role: URL whitespace and trailing slash keep the saved credential usable", async (scenario) => {
    await render(scenario.page());
    await change(field(scenario.endpoint, scenario.fieldIndex), "  https://provider.example/v1///  ");
    expect(container.textContent).not.toContain("apiKey.credentialsChanged");
    expect((await testAndSave(scenario)).apiKey).toBe(scenario.expected);
  });

  it.each([0, 1])("role %i: same URL/model and identical masks do not imply reuse; toggling restores the independent key", async (index) => {
    await render(<ModelPage />);
    const checkbox = () => [...container.querySelectorAll<HTMLButtonElement>('button[role="checkbox"]')][index]!;
    expect(checkbox().getAttribute("aria-checked")).toBe("false");
    const scenario = scenarios[index === 0 ? 5 : 4]!;
    await click(test(index));
    await vi.waitFor(() => expect(server.probe).toHaveBeenCalledTimes(1));
    expect(server.probe.mock.calls[0]![0].apiKey).toBe(scenario.expected);
    await click(checkbox());
    await click(checkbox());
    expect(checkbox().getAttribute("aria-checked")).toBe("false");
    expect(test(index).textContent).not.toBe("apiKey.testSuccess");
    expect((await testAndSave(scenario)).apiKey).toBe(scenario.expected);
  });
  // Deduplication is verified against the real file writer, not a catalog stub.
  it.each(scenarios)("$role: reentering the same trimmed key reuses the canonical saved endpoint", async (scenario) => {
    const before = await server.read();
    const oldId = assignedCatalogEndpointId(createModelWorkspace(before), "byok", scenario.role);
    await render(scenario.page());
    await change(field(scenario.key, scenario.fieldIndex), `  ${scenario.expected}  `);
    expect((await testAndSave(scenario)).apiKey).toBe(scenario.expected);
    const saved = await server.read();
    expect(assignedCatalogEndpointId(createModelWorkspace(saved), "byok", scenario.role)).toBe(oldId);
    expect(saved.catalog!.providers.flatMap((provider) => provider.endpoints)).toHaveLength(
      before.catalog!.providers.flatMap((provider) => provider.endpoints).length
    );
  });

  it.each(scenarios)("$role: replacing a key with an identical mask tests and saves the new key without overwriting the old one", async (scenario) => {
    const before = await server.read();
    const oldId = assignedCatalogEndpointId(createModelWorkspace(before), "byok", scenario.role)!;
    const provider = before.catalog!.providers.find((item) => item.endpoints.some((endpoint) => endpoint.endpointId === oldId))!.provider;
    const replacement = `sk-replacement-${scenario.expected.slice(-4)}`;
    await render(scenario.page());
    await change(field(scenario.key, scenario.fieldIndex), replacement);
    expect((await testAndSave(scenario)).apiKey).toBe(replacement);
    expect(assignedCatalogEndpointId(createModelWorkspace(await server.read()), "byok", scenario.role)).not.toBe(oldId);
    expect(await server.writer.readEndpointApiKey!(provider, oldId)).toBe(scenario.expected);
  });

  it.each([0, 1])("role %i: enabling reuse saves the inherited credential instead of the independent credential", async (index) => {
    await render(<ModelPage />);
    await click([...container.querySelectorAll<HTMLButtonElement>('button[role="checkbox"]')][index]!);
    await click(next());
    await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "navigation/changed" })));
    expect(await server.key(index === 0 ? "memory_summary" : "memory_evolution")).toBe(index === 0 ? "sk-team-1111" : "sk-personal-1111");
  });

  it.each([0, 1])("role %i: disabling explicit follow copies the displayed inherited key and its actual source", async (index) => {
    server = await createServer(join(directory, "follow"), false);
    mocks.state = { ...createInitialAppState(), modelConfig: await server.read() };
    mocks.clients = { config: server.client } as AppClients;
    await render(<ModelPage />);
    const checkbox = [...container.querySelectorAll<HTMLButtonElement>('button[role="checkbox"]')][index]!;
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
    await click(checkbox);
    const scenario = { ...scenarios[index === 0 ? 5 : 4]!, index: 0, fieldIndex: 0 };
    expect(field("API Key").placeholder).toContain("1111");
    expect((await testAndSave(scenario)).apiKey).toBe("sk-personal-1111");
  });

  it.each(scenarios.filter((scenario) => ["agent", "image_generation", "memory_evolution", "memory_summary"].includes(scenario.role)))(
    "$role: changing provider and protocol requires an explicit key before testing and saving", async (scenario) => {
      await render(scenario.page());
      const comboIndex = scenario.fieldIndex ?? 0;
      await click([...container.querySelectorAll<HTMLButtonElement>('button[role="combobox"]')][comboIndex]!);
      // Select an actual different provider through the rendered control.
      const option = [...container.querySelectorAll<HTMLButtonElement>('button[role="option"]')].find((item) => item.getAttribute("aria-selected") === "false")!;
      await click(option);
      await change(field(scenario.model, scenario.fieldIndex), "changed-provider-model");
      // Same URL does not make credentials interchangeable across providers/protocols.
      await change(field(scenario.endpoint, scenario.fieldIndex), "https://provider.example/v1");
      expect(field(scenario.key, scenario.fieldIndex).placeholder).toBe("sk-...");
      expect(container.textContent).toContain("apiKey.credentialsChanged");
      await click(test(scenario.index));
      expect(server.probe).not.toHaveBeenCalled();
      await click(next());
      expect(server.write).not.toHaveBeenCalled();
      await change(field(scenario.key, scenario.fieldIndex), scenario.expected);
      expect((await testAndSave(scenario)).apiKey).toBe(scenario.expected);
    }
  );

  it("an explicitly fixed incomplete role is not silently changed to follow", async () => {
    mocks.state!.modelConfig.memmyMemory!.evolution = {
      mode: "fixed", provider: "openai", endpoint: "https://provider.example/v1",
      model: "", apiKey: "", apiKeyMasked: "", configured: false
    };
    await render(<ModelPage />);
    expect([...container.querySelectorAll<HTMLButtonElement>('button[role="checkbox"]')][1]!.getAttribute("aria-checked")).toBe("false");
    expect(next().disabled).toBe(true);
  });

  it("a rejected independent key cannot fall back to the valid primary key or be saved", async () => {
    await render(<ModelPage />);
    server.probe.mockResolvedValueOnce({ ok: false, message: "rejected team key", checkedAt: "2026-10-16T00:00:00.000Z" });
    await click(test(1));
    await vi.waitFor(() => expect(container.textContent).toContain("rejected team key"));
    expect(server.probe.mock.calls[0]![0].apiKey).toBe("sk-team-1111");
    expect(next().disabled).toBe(true);
    expect(server.write).not.toHaveBeenCalled();
  });

  it("returning after Next hydrates the saved mask and tests the same persisted key", async () => {
    await render(<ApiKeyPage />);
    await change(field("apiKey.key"), "sk-new-onboarding-1111");
    await testAndSave(scenarios[0]!);
    await render(null);
    mocks.state = { ...createInitialAppState(), modelConfig: await server.read() };
    mocks.dispatch.mockClear();
    await render(<ApiKeyPage />);
    expect(field("apiKey.key").value).toBe("");
    expect(field("apiKey.key").placeholder).toContain("1111");
    expect((await testAndSave(scenarios[0]!)).apiKey).toBe("sk-new-onboarding-1111");
  });

  it("an old in-flight success cannot validate a changed connection", async () => {
    let finish!: (result: Awaited<ReturnType<typeof server.probe>>) => void;
    server.probe.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await render(<ApiKeyPage />);
    await click(test(0));
    await vi.waitFor(() => expect(server.probe).toHaveBeenCalledTimes(1));
    await change(field("apiKey.endpoint"), "https://changed.example/v1");
    await act(async () => finish({ ok: true, message: "ok", checkedAt: "2026-10-16T00:00:00.000Z" }));
    expect(container.textContent).toContain("apiKey.credentialsChanged");
    expect(test(0).textContent).not.toBe("apiKey.testSuccess");
    expect(next().disabled).toBe(true);
    expect(server.write).not.toHaveBeenCalled();
  });

  it("retry after assignment-write failure reuses the newly saved key without duplicate connections", async () => {
    await render(<ApiKeyPage />);
    await change(field("apiKey.key"), "sk-retry-1111");
    await click(test(0));
    await vi.waitFor(() => expect(test(0).textContent).toBe("apiKey.testSuccess"));
    const persist = server.write.getMockImplementation()!;
    server.write.mockImplementationOnce(persist).mockRejectedValueOnce(new Error("assignment-write-failed"));
    await click(next());
    await vi.waitFor(() => expect(container.textContent).toContain("assignment-write-failed"));
    expect(mocks.dispatch).not.toHaveBeenCalled();
    const endpointsAfterCreate = (await server.read()).catalog!.providers.flatMap((provider) => provider.endpoints).length;
    await click(next());
    await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "navigation/changed" })));
    expect(await server.key("agent")).toBe("sk-retry-1111");
    expect((await server.read()).catalog!.providers.flatMap((provider) => provider.endpoints)).toHaveLength(endpointsAfterCreate);
  });

});
