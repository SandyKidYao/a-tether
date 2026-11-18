import type { SimpleStreamOptions } from "@earendil-works/pi-ai";

export const providerId = "a-tether";
export const api = "a-tether-v1";
export const defaultUrl = "http://127.0.0.1:7310";
export const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
// Both ends send this header on every request and response and refuse any other
// value, so A and C must be upgraded together. Bump it on any wire change.
export const protocol = "2";
export const header = {
  protocol: "a-tether-protocol",
  // Sent by C with each stream, in milliseconds: how often both ends beat, and how long
  // either end waits without hearing from the other before it gives the request up.
  interval: "a-tether-heartbeat-interval",
  timeout: "a-tether-heartbeat-timeout",
};
// What C knows when it beats: the request's age, how long the model has been silent
// and how long ago A's last heartbeat arrived. A quotes the last one when C goes quiet.
export type Heartbeat = {seq: number; elapsed: number; modelIdle: number; clientIdle: number};
// Messages for transport failures carry an English phrase that Pi's auto-retry
// recognizes (see isRetryableAssistantError in pi-ai), so Pi retries them with backoff.
export const messages = {
  unauthorized: "A-tether 令牌与 C 端不一致。在 C 上运行 npx -y @a-tether/server token，再在本机运行它给出的 login 命令。",
  token: "A-tether 还没有配置令牌。在 C 上运行 npx -y @a-tether/server token，再在本机运行它给出的 login 命令。",
  unavailable: "C 上找不到 Claude Code，请检查服务进程的 PATH。",
  login: "C 上的 Claude Code 尚未登录或登录已失效。",
  quota: "Claude 额度、速率或计费限制，请在 C 上检查账户。",
  backend: "C 上的 Claude Code 调用失败，具体原因见 C 端服务控制台。",
  overloaded: "模型服务繁忙或暂时不可用，请稍后重试。",
  // Pi recognizes an overflow by English provider phrases and then compacts and retries.
  context: "请求超出模型的上下文长度（prompt is too long）。Pi 开启自动压缩时会压缩后重试，否则请运行 /compact 或减少输入。",
  discovery: "C 无法获取 Claude 模型目录，请检查 CLI 版本和连接。",
  cancelled: "请求已取消。",
  invalid: "请求格式或模型 ID 无效。",
  duplicate: "请求 ID 已在使用。",
  large: "请求超过 32 MiB 上限。",
  version: "A 和 C 的 A-tether 版本不一致，请把两端升级到同一版本（A 上运行 npx -y @a-tether/pi --version，C 上运行 npx -y @a-tether/server --version 查看）。",
  lost: "C 超过心跳时限没有收到 A 的心跳，已结束这次请求（connection lost）。请检查网络和端口转发。",
  connection: "无法连接 C 的 A-tether 服务，请检查网络、端口转发（如 SSH 隧道）和 C 端服务（connection error）。",
  interrupted: "与 C 的连接在响应中途断开，请检查网络、端口转发和 C 端服务（connection lost）。",
  malformed: "C 返回了无法识别的数据，请确认两端的 A-tether 版本一致。",
};
export type Code = keyof typeof messages;

const seconds = (ms: number) => Math.round(ms / 1000);
// A has heard nothing from C, not even a heartbeat, for longer than the timeout.
export function heartbeatLost(silentMs: number, last?: Heartbeat) {
  const seen = last
    ? `最后一次心跳时，请求已运行 ${seconds(last.elapsed)} 秒，模型 ${seconds(last.modelIdle)} 秒没有输出，C ${seconds(last.clientIdle)} 秒前收到过 A 的心跳。`
    : "这次请求还没有收到过心跳。";
  return `A-tether 已 ${seconds(silentMs)} 秒没有收到 C 的任何数据，连接可能已经中断（connection lost）。${seen}请检查网络、端口转发和 C 端服务。`;
}

// Runtime whitelist on BOTH ends. In particular, never forward env, headers,
// sessionId, filesystem paths, credentials, or callbacks from Pi.
export function generationOptions(options?: SimpleStreamOptions) {
  const reasoning = options?.reasoning;
  const maxTokens = options?.maxTokens;
  return {
    ...(reasoning && ["minimal", "low", "medium", "high", "xhigh", "max"].includes(reasoning) ? { reasoning } : {}),
    ...(Number.isSafeInteger(maxTokens) && maxTokens! > 0 ? { maxTokens } : {}),
  };
}

// Pi partials refer to a mutable, cumulative message. Only block boundaries
// need snapshots on the wire. Streaming deltas carry just the newly arrived data.
export function wireEvent(event: Exclude<import("@earendil-works/pi-ai").AssistantMessageEvent, {type:"error"}>) {
  if (event.type === "done") return event;
  const {partial, ...update} = event;
  if (event.type === "start") return {...update, partial:{...partial, content:[]}};
  const block = partial.content[event.contentIndex];
  switch (event.type) {
    case "toolcall_start":
      if (block.type === "toolCall") return {...update, block:{type:block.type, id:block.id, name:block.name, arguments:{}}};
      break;
    case "thinking_start":
      if (block.type === "thinking") return {...update, block:{type:block.type, thinking:block.redacted ? block.thinking : "", redacted:block.redacted}};
      break;
    case "text_start": return {...update, block:{type:"text", text:""}};
    case "thinking_end": return {...update, signature:block.type === "thinking" ? block.thinkingSignature : undefined};
  }
  return update;
}
