export const MEMMY_MEMORY_CONTEXT_TAG = "memmy_memory_context";
export const MEMMY_MEMORY_STATUS_TAG = "memmy_memory_status";
export const CURRENT_USER_REQUEST_TAG = "current_user_request";

const MEMORY_CONTEXT_TAGS = [
  MEMMY_MEMORY_CONTEXT_TAG,
  MEMMY_MEMORY_STATUS_TAG,
  "memos_context",
  "memory_context",
] as const;

export type MemmyMemoryReplaySnapshot = { turnId: string; content: Record<string, any>[] };

/** Bound to one runner invocation, never persisted as conversation history. */
export type MemmyMemoryTurnContext = { turnId: string; requestOnlyContext?: string };

export function withMemmyMemoryTurnContext(
  messages: Record<string, any>[],
  context: MemmyMemoryTurnContext | null | undefined,
): Record<string, any>[] {
  if (!context) return messages;
  const declaration = `<memmy_runtime_context active_turn_id="${escapeAttribute(context.turnId)}" />`;
  const projected = [...messages];
  // Anthropic and Responses adapters use the last system message.
  const systemIndex = projected.findLastIndex((message) => message.role === "system");
  if (systemIndex < 0) {
    projected.unshift({ role: "system", content: declaration });
  } else {
    const system = projected[systemIndex];
    projected[systemIndex] = {
      ...system,
      content: Array.isArray(system.content)
        ? [...system.content, { type: "text", text: declaration }]
        : `${system.content ?? ""}\n\n${declaration}`,
    };
  }
  // Assistant-only notifications have no new user message to own a snapshot.
  // Deliver their recall/status as request-only data without retagging history.
  if (context.requestOnlyContext) {
    const last = projected.at(-1);
    if (last?.role === "user") {
      // Do not create adjacent user messages: provider normalization can discard
      // a multimodal follow-up when it merges that message with a text packet.
      projected[projected.length - 1] = {
        ...last,
        content: Array.isArray(last.content)
          ? [{ type: "text", text: context.requestOnlyContext }, ...last.content]
          : `${context.requestOnlyContext}\n\n${last.content ?? ""}`,
      };
    } else {
      projected.push({ role: "user", content: context.requestOnlyContext });
    }
  }
  return projected;
}

export function turnIdAttribute(turnId?: string | null): string {
  return turnId ? ` turn_id="${escapeAttribute(turnId)}"` : "";
}

export type MemmyMemoryContextSource = "turn_start" | "tool_search" | "tool_get" | string;

export function renderMemmyMemoryContext(markdown: string, source: MemmyMemoryContextSource, turnId?: string | null): string {
  const body = markdown.trim();
  if (!body) return "";
  return [
    `<${MEMMY_MEMORY_CONTEXT_TAG} source="${escapeAttribute(source)}"${turnIdAttribute(turnId)}>`,
    body,
    `</${MEMMY_MEMORY_CONTEXT_TAG}>`,
  ].join("\n");
}

export function renderCurrentUserRequest(userText: string, turnId?: string | null): string {
  const body = extractCurrentUserRequestText(userText).trim() || "(conversation continued)";
  return [
    `<${CURRENT_USER_REQUEST_TAG}${turnIdAttribute(turnId)}>`,
    body,
    `</${CURRENT_USER_REQUEST_TAG}>`,
  ].join("\n");
}

export function renderMemmyContextPacket(markdown: string, source: MemmyMemoryContextSource, currentUserRequest: string, turnId?: string | null): string {
  const context = renderMemmyMemoryContext(markdown, source, turnId);
  const request = renderCurrentUserRequest(currentUserRequest, turnId);
  return context ? `${context}\n\n${request}` : request;
}

export function renderMemmyMemoryUnavailableNotice(turnId?: string | null): string {
  return [
    `<${MEMMY_MEMORY_STATUS_TAG} status="unavailable"${turnIdAttribute(turnId)}>`,
    "IMPORTANT:",
    "- The Memmy long-term memory service is currently unreachable.",
    "- No memory recall or write was performed for this turn. This is NOT the same as \"memory was searched and nothing relevant was found\" — memory was simply not checked.",
    "- Never claim you searched memory and found nothing. If the user asks about previously saved information or long-term memory, tell them the memory service is temporarily unavailable, then continue helping with the current request using only what is visible in this conversation.",
    `</${MEMMY_MEMORY_STATUS_TAG}>`,
  ].join("\n");
}

export function extractCurrentUserRequestText(value: string): string {
  return normalizeProtocolWhitespace(unwrapCurrentUserRequestBlocks(stripMemoryContextBlocks(value)));
}

export function stripMemoryContextBlocks(value: string): string {
  let text = value;
  for (const tag of MEMORY_CONTEXT_TAGS) {
    text = replaceTaggedBlocks(text, tag, () => "", { removeUnclosedTail: true });
  }
  return text;
}

export function unwrapCurrentUserRequestBlocks(value: string): string {
  return replaceTaggedBlocks(value, CURRENT_USER_REQUEST_TAG, (inner) => inner);
}

function replaceTaggedBlocks(
  value: string,
  tag: string,
  replace: (inner: string, openTag: string, closeTag: string) => string,
  options: { removeUnclosedTail?: boolean } = {},
): string {
  let text = value;
  for (;;) {
    const openMatch = new RegExp(`<${escapeRegExp(tag)}(?:\\s[^>]*)?>`, "i").exec(text);
    if (!openMatch) return text;
    const openStart = openMatch.index;
    const openEnd = openStart + openMatch[0].length;
    const closeMatch = new RegExp(`</${escapeRegExp(tag)}>`, "i").exec(text.slice(openEnd));
    if (!closeMatch) {
      if (!options.removeUnclosedTail) return text;
      text = text.slice(0, openStart).trimEnd();
      continue;
    }
    const closeStart = openEnd + closeMatch.index;
    const closeEnd = closeStart + closeMatch[0].length;
    const inner = text.slice(openEnd, closeStart);
    text = `${text.slice(0, openStart)}${replace(inner, openMatch[0], closeMatch[0])}${text.slice(closeEnd)}`;
  }
}

function normalizeProtocolWhitespace(value: string): string {
  return value
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeAttribute(value: string): string {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}
