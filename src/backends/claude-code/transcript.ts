// Pi history as Claude Code receives it: normalized like Pi's own providers, keyed for
// matching a live process, and rendered either as text records or as native content.
import {createHash} from "node:crypto";
import type {Message, ToolResultMessage, UserMessage} from "@earendil-works/pi-ai";

type Conversation = Exclude<Message, {role: "system"}>;

// Pi's providers skip failed or aborted replies, whose partial content must not be
// replayed, and answer tool calls that never got a result. pi-ai does not export the
// helper that does this, so the same rule lives here.
export function normalizeMessages(messages: readonly Message[]): Conversation[] {
  const out: Conversation[] = [];
  let pending: {id: string; name: string}[] = [];
  const answered = new Set<string>();
  const close = () => {
    for (const call of pending) if (!answered.has(call.id)) out.push({role: "toolResult", toolCallId: call.id,
      toolName: call.name, content: [{type: "text", text: "No result provided"}], isError: true, timestamp: Date.now()});
    pending = [];
    answered.clear();
  };
  for (const msg of messages) {
    if (msg.role === "system") continue;
    if (msg.role === "assistant") {
      close();
      if (msg.stopReason === "error" || msg.stopReason === "aborted") continue;
      pending = msg.content.flatMap(b => b.type === "toolCall" ? [{id: b.id, name: b.name}] : []);
      out.push(msg);
    } else if (msg.role === "toolResult") {
      answered.add(msg.toolCallId);
      out.push(msg);
    } else {
      close();
      out.push(msg);
    }
  }
  close();
  return out;
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("base64url");

// A live process matches a request when its keys are a prefix of the request's keys.
// Replies are keyed by response and call IDs only: a Pi tool may rewrite its call's
// arguments in place (edit parses a JSON-string `edits`), so their content can differ.
export function messageKey(msg: Conversation) {
  if (msg.role === "assistant") {
    const calls = msg.content.flatMap(b => b.type === "toolCall" ? [b.id] : []).join(",");
    return msg.responseId ? `a:${msg.responseId}:${calls}` : "a#" + digest(msg.content);
  }
  if (msg.role === "toolResult") return `r:${msg.toolCallId}:` + digest([msg.content, msg.isError]);
  return "u:" + digest(msg.content);
}

// A new or rebuilt process gets the whole history as text records in one user message,
// retaining call IDs and images. History names tools the way Claude must call them,
// so the model does not copy Pi's bare names into new calls.
export function transcript(messages: readonly Conversation[], toolName: (name: string) => string) {
  const blocks: unknown[] = [];
  for (const msg of messages) {
    const parts = typeof msg.content === "string" ? [{type: "text" as const, text: msg.content}] : msg.content;
    const content = parts.flatMap((p): unknown[] => {
      if (p.type === "image") return [{type: "image", attachment: true}];
      if (p.type === "thinking") return [];
      if (p.type === "toolCall") return [{...p, name: toolName(p.name)}];
      return [p];
    });
    const record = msg.role === "toolResult"
      ? {role: msg.role, toolCallId: msg.toolCallId, name: toolName(msg.toolName), isError: msg.isError, content}
      : {role: msg.role, content};
    blocks.push({type: "text", text: JSON.stringify(record)});
    for (const p of parts) if (p.type === "image") blocks.push({type: "image", source: {type: "base64", media_type: p.mimeType, data: p.data}});
  }
  return blocks;
}

// Later user messages reach a live process as ordinary content.
export function userContent(messages: readonly UserMessage[]) {
  return messages.flatMap(msg => typeof msg.content === "string" ? [{type: "text", text: msg.content}]
    : msg.content.map(p => p.type === "image" ? {type: "image", source: {type: "base64", media_type: p.mimeType, data: p.data}} : {type: "text", text: p.text}));
}

// A Pi tool result as the MCP result of the call Claude Code is waiting on.
export function mcpResult(msg: ToolResultMessage) {
  return {
    content: msg.content.map(p => p.type === "image" ? {type: "image", data: p.data, mimeType: p.mimeType} : {type: "text", text: p.text}),
    ...(msg.isError ? {isError: true} : {}),
  };
}
