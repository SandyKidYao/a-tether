import type { SimpleStreamOptions } from "@earendil-works/pi-ai";

export const providerId = "a-tether";
export const api = "a-tether-v1";
export const defaultUrl = "http://127.0.0.1:7310";
export const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export const messages = {
  unauthorized: "A-tether 令牌与 C 端不一致。在 C 上运行 npx -y @a-tether/server token，再在本机运行它给出的 login 命令。",
  token: "A-tether 还没有配置令牌。在 C 上运行 npx -y @a-tether/server token，再在本机运行它给出的 login 命令。",
  unavailable: "C 上找不到 Claude Code，请检查服务进程的 PATH。",
  login: "C 上的 Claude Code 尚未登录或登录已失效。",
  quota: "Claude 额度、速率或计费限制，请在 C 上检查账户。",
  backend: "C 上的 Claude Code 调用失败，具体原因见 C 端服务控制台。",
  overloaded: "模型服务繁忙或暂时不可用，请稍后重试。",
  context: "请求超出模型的上下文长度，请在 Pi 中压缩上下文或减少输入。",
  discovery: "C 无法获取 Claude 模型目录，请检查 CLI 版本和连接。",
  cancelled: "请求已取消。",
  timeout: "C 上的请求超时。",
  invalid: "请求格式或模型 ID 无效。",
  duplicate: "请求 ID 已在使用。",
  large: "请求超过 32 MiB 上限。",
  connection: "A-tether 连接中断，请检查端口转发（如 SSH 隧道）和 C 端服务。",
};
export type Code = keyof typeof messages;

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
