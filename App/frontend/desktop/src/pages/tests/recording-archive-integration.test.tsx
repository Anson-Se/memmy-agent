// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { InstalledPluginSchema } from "@memmy/local-api-contracts";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { PluginCapabilityHost } from "../plugin-capability-host.js";
import { RecordingEntryPage, useRecordingEntry, type RecordingEntryController } from "../recording-entry.js";
import { readRecordingArchive } from "../../lib/recording-archive.js";
import type { PluginUiCall } from "../../app/plugin-ui-context.js";
import type { RecordingPanelSession } from "../interview-recording-panel.js";

const mock = vi.hoisted(() => ({ status: "idle", isRecording: false, isStarting: false, isTranscribing: false,
  error: null, start: vi.fn(), pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(), finishAndTranscribe: vi.fn() }));
vi.mock("../asr-recorder.js", async (original) => ({ ...await original<typeof import("../asr-recorder.js")>(), useAsrRecorder: () => mock }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

it("archives a guidance recording before its card disappears, reopens it from the list and retains it across route remounts", async () => {
  const storage=new Map<string,string>();
  Object.defineProperty(window,"localStorage",{ configurable:true,value:{
    getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value),
    removeItem:(key:string)=>storage.delete(key),clear:()=>storage.clear()
  } });
  const container=document.createElement("div");document.body.append(container);const root=createRoot(container);
  let controller!: RecordingEntryController;let panel: RecordingPanelSession | null=null;
  const scope=`recording-integration-${crypto.randomUUID()}`;
  const upload=vi.fn(async () => [
    { kind: "audio" as const, path: "/media/interview.webm", name: "访谈录音.webm", mime: "audio/webm" as const, bytes: 10, url: "http://127.0.0.1/api/media/initial/audio" },
    { kind: "file" as const, path: "/media/interview.txt", name: "访谈转写.txt", mime: "text/plain" as const, bytes: 10, url: "http://127.0.0.1/api/media/initial/text" }
  ]);
  const resolveAudio=vi.fn(async () => "http://127.0.0.1/api/media/renewed/audio");
  const respond=vi.fn(async () => {});
  const plugin=InstalledPluginSchema.parse({ id:"legal-labor",version:"1.0.0",state:"active",config:{},approvedPermissions:[],lastError:null,
    createdAt:"2026-10-12T00:00:00.000Z",updatedAt:"2026-10-12T00:00:00.000Z",manifest:{apiVersion:"memmy/v1",id:"legal-labor",name:"法律",version:"1.0.0",
      runtime:{adapter:"http"},permissions:[],capabilities:[{id:"session-start",name:"诊断",description:"开始诊断",inputSchema:{},outputSchema:{},execution:"job"}],
      commands:[{command:"/legal-guide",name:"诊断指引",description:"诊断指引",capabilityId:"session-start",pinned:true}] } });
  const call: PluginUiCall={ pluginId: "legal-labor", capabilityId: "session-start", callId: "interview-call", conversationId: "chat-test", origin: "agent",
    events: [{ type: "interaction", request: { interactionId: "interview-question", type: "audio-record", payload: { title: "访谈录音" } } }] };
  function Page() {
    controller=useRecordingEntry({} as never,upload,undefined,{ scope,sessionKey:"websocket:chat-test",resolveAudio });
    const [calls,setCalls]=useState([call]);
    return <>
      <PluginCapabilityHost region="panel" calls={calls} plugins={[plugin]} client={{ respond: async () => {
        // Archive must already exist when the response removes the recorder.
        expect(readRecordingArchive(scope)).toHaveLength(1);
        await respond();setCalls([]);
      } } as never} asrClient={{} as never} uploadFiles={upload}
        onRecordingArchived={controller.archive} onRecordingSession={(value) => { panel=value; }} />
      <button data-testid="back" onClick={() => controller.toggle()}>返回</button>
      {controller.open ? <RecordingEntryPage session={controller.session} /> : null}
    </>;
  }
  mock.status="idle";mock.isRecording=false;
  mock.start.mockImplementation(async () => { mock.status="recording";mock.isRecording=true; });
  mock.finishAndTranscribe.mockImplementation(async () => { mock.status="idle";mock.isRecording=false;
    return { recording:new Blob(["audio"]),recordingMimeType:"audio/webm",durationMs:4000,text:"录音测试",segments:[],transcribedAt:"2026-10-12T06:58:14Z" }; });
  const render=async (shown=true) => act(async () => root.render(<I18nProvider language="zh-CN">{shown ? <Page /> : <span>设置</span>}</I18nProvider>));
  try {
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>(".recording-bar__button--primary")!.click());
    await act(async () => container.querySelector<HTMLButtonElement>(".recording-bar__button--primary")!.click());
    expect(respond).toHaveBeenCalledTimes(1);
    expect(panel!.audioUrl).toBe("http://127.0.0.1/api/media/initial/audio");
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="back"]')!.click());
    expect(container.querySelectorAll(".recording-page__list-row")).toHaveLength(1);
    await act(async () => container.querySelector<HTMLButtonElement>(".recording-page__list-open")!.click());
    expect(container.textContent).toContain("录音测试");
    expect(resolveAudio).toHaveBeenCalledWith(expect.objectContaining({ audioPath:"/media/interview.webm",sessionKey:"websocket:chat-test" }));
    expect(container.querySelector("audio")?.getAttribute("src")).toContain("renewed/audio");
    const player=container.querySelector("audio")!;
    Object.defineProperty(player,"duration",{configurable:true,value:Infinity});
    await act(async () => player.dispatchEvent(new Event("loadedmetadata")));
    expect(container.querySelectorAll(".recording-panel__player-time")[1]?.textContent).toBe("00:04");
    expect(container.querySelector<HTMLInputElement>('input[type="range"]')?.max).toBe("4000");
    await render(false);await render();
    expect(controller.session.recordings).toHaveLength(1);
    const saved=window.localStorage.getItem(`memmy.recordingArchive.v1:${scope}`)!;
    expect(saved).toContain("/media/interview.webm");
    expect(saved).not.toContain("/api/media/");expect(saved).not.toContain("blob:");
    expect(readRecordingArchive(`${scope}-other-account`)).toHaveLength(0);
    // A new renderer must read the persisted path, not reuse a previous URL.
    vi.resetModules();
    const restarted=await import("../../lib/recording-archive.js");
    const restored=restarted.readRecordingArchive(scope);
    expect(restored).toHaveLength(1);expect(restored[0]?.audioUrl).toBeNull();
    expect(restored[0]?.transcript.text).toBe("录音测试");
    expect(restored[0]?.files?.map((file)=>file.name)).toEqual(["访谈录音.webm","访谈转写.txt"]);
  } finally { await act(async () => root.unmount());window.localStorage.removeItem(`memmy.recordingArchive.v1:${scope}`); }
});
