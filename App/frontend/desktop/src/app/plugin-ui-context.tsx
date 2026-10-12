import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type Dispatch,
  type SetStateAction
} from "react";
import type { CapabilityEvent, PluginCapabilityEventPayload, PluginInvocationOrigin } from "@memmy/local-api-contracts";

export interface PluginUiCall {
  pluginId: string;
  capabilityId: string;
  callId: string;
  conversationId: string;
  /** Who asked for this call; decides occlusion and what closing a card means. */
  origin: PluginInvocationOrigin;
  events: CapabilityEvent[];
}

export interface PluginInvocationContext {
  pluginId: string;
  capabilityId: string;
  conversationId: string;
  input: unknown;
}

export interface PluginChatFeedback {
  message: string;
  clientRequestId: string;
}

interface PluginUiContextValue {
  registerChatFeedback(conversationId: string, handler: (feedback: PluginChatFeedback) => boolean): () => void;
  routeChatFeedback(chatId: string, feedback: PluginChatFeedback): boolean;
  fileDrafts: Map<string, File[]>;
  /** Card decisions outlive route pages, just like the calls they belong to. */
  hiddenCallIds: Set<string>;
  setHiddenCallIds: Dispatch<SetStateAction<Set<string>>>;
  hiddenInteractionSteps: Map<string, string>;
  dismissedCallIds: Set<string>;
  setDismissedCallIds: Dispatch<SetStateAction<Set<string>>>;
  answeredInteractions: Set<string>;
  setAnsweredInteractions: Dispatch<SetStateAction<Set<string>>>;
  openingCommands: Set<string>;
  calls: PluginUiCall[];
  activeSurface: PluginInvocationContext | null;
  openSurface(context: PluginInvocationContext): void;
  closeSurface(): void;
  receive(payload: PluginCapabilityEventPayload): void;
}

const MAX_PLUGIN_CALLS = 50;
const PluginUiContext = createContext<PluginUiContextValue | null>(null);

export function PluginUiProvider(props: { children: ReactNode }) {
  const feedbackHandlers = useRef(new Map<symbol, { conversationId: string; handler: (feedback: PluginChatFeedback) => boolean }>());
  const fileDrafts = useRef(new Map<string, File[]>()).current;
  const [hiddenCallIds, setHiddenCallIds] = useState<Set<string>>(() => new Set());
  const hiddenInteractionSteps = useRef(new Map<string, string>()).current;
  const [dismissedCallIds, setDismissedCallIds] = useState<Set<string>>(() => new Set());
  const [answeredInteractions, setAnsweredInteractions] = useState<Set<string>>(() => new Set());
  const openingCommands = useRef(new Set<string>()).current;
  const registerChatFeedback = useCallback((conversationId: string, handler: (feedback: PluginChatFeedback) => boolean) => {
    const id = Symbol();
    feedbackHandlers.current.set(id, { conversationId, handler });
    return () => { feedbackHandlers.current.delete(id); };
  }, []);
  const routeChatFeedback = useCallback((chatId: string, feedback: PluginChatFeedback) => {
    const sessionKey = chatId.startsWith("websocket:") ? chatId : `websocket:${chatId}`;
    for (const entry of [...feedbackHandlers.current.values()].reverse()) {
      if (entry.conversationId === chatId || entry.conversationId === sessionKey) {
        if (entry.handler(feedback)) return true;
      }
    }
    return false;
  }, []);
  const [calls, setCalls] = useState<PluginUiCall[]>([]);
  const [activeSurface, setActiveSurface] = useState<PluginInvocationContext | null>(null);
  const receive = useCallback((payload: PluginCapabilityEventPayload) => {
    setCalls((current) => reducePluginUiCalls(current, payload));
  }, []);
  const openSurface = useCallback((context: PluginInvocationContext) => setActiveSurface(context), []);
  const closeSurface = useCallback(() => setActiveSurface(null), []);
  const value = useMemo(() => ({ calls, activeSurface, openSurface, closeSurface, receive, registerChatFeedback, routeChatFeedback, fileDrafts,
    hiddenCallIds, setHiddenCallIds, hiddenInteractionSteps, dismissedCallIds, setDismissedCallIds,
    answeredInteractions, setAnsweredInteractions, openingCommands
  }), [activeSurface, calls, closeSurface, openSurface, receive, registerChatFeedback, routeChatFeedback, fileDrafts,
    hiddenCallIds, hiddenInteractionSteps, dismissedCallIds, answeredInteractions, openingCommands]);
  return <PluginUiContext.Provider value={value}>{props.children}</PluginUiContext.Provider>;
}

export function usePluginUi(): PluginUiContextValue {
  const value = useContext(PluginUiContext);
  if (!value) throw new Error("usePluginUi must be used within PluginUiProvider");
  return value;
}

export function reducePluginUiCalls(
  calls: PluginUiCall[],
  payload: PluginCapabilityEventPayload
): PluginUiCall[] {
  const index = calls.findIndex((call) => call.pluginId === payload.pluginId && call.callId === payload.callId);
  if (index < 0) {
    return [...calls, {
      pluginId: payload.pluginId,
      capabilityId: payload.capabilityId,
      callId: payload.callId,
      conversationId: payload.conversationId,
      origin: payload.origin,
      events: [payload.event]
    }].filter((call, position, all) => {
      // Prune completed history, never the sole UI for a still waiting tool.
      if (!call.events.some((event) => event.type === "result" || event.type === "error")) return true;
      return position >= all.length - MAX_PLUGIN_CALLS;
    });
  }
  const current = calls[index]!;
  const next = [...calls];
  next[index] = { ...current, events: mergeCapabilityEvent(current.events, payload.event) };
  return next;
}

function mergeCapabilityEvent(events: CapabilityEvent[], event: CapabilityEvent): CapabilityEvent[] {
  const replaces = (candidate: CapabilityEvent): boolean => {
    if (event.type === "progress" || event.type === "task-list") return candidate.type === event.type;
    if (event.type === "result" || event.type === "error") return candidate.type === "result" || candidate.type === "error";
    if (event.type === "interaction") {
      return candidate.type === "interaction" && candidate.request.interactionId === event.request.interactionId;
    }
    return event.type === "artifact" && candidate.type === "artifact" && candidate.artifact.id === event.artifact.id;
  };
  const index = events.findIndex(replaces);
  if (index < 0) return [...events, event];
  const next = [...events];
  next[index] = event;
  return next;
}

/** Optional for standalone renderer previews; routes only messages from the same conversation. */
export function usePluginChatFeedback(conversationId: string | undefined, handler: (feedback: PluginChatFeedback) => boolean) {
  const context = useContext(PluginUiContext);
  const latest = useRef(handler);
  latest.current = handler;
  const register = context?.registerChatFeedback;
  useEffect(() => {
    if (register && conversationId) return register(conversationId, (feedback) => latest.current(feedback));
  }, [register, conversationId]);
  return context?.fileDrafts;
}
