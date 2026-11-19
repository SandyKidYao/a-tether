import { createHash } from "node:crypto";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";

export const providerId = "a-tether";
export const api = "a-tether-v1";
export const defaultUrl = "http://127.0.0.1:7310";
export const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
// Both ends send this header on every request and response and refuse any other
// value, so A and C must be upgraded together. Bump it on any wire change.
export const protocol = "4";
export const header = {
  protocol: "a-tether-protocol",
  // The package version of the sender, quoted when the protocols differ.
  version: "a-tether-version",
  // Sent by A on every request so C's console can tell one Pi from another: a random
  // ID per Pi process and A's host name. Neither identifies the user's account.
  client: "a-tether-client",
  host: "a-tether-host",
  // Sent by C with each stream and each ping reply, in milliseconds: how often A pings
  // and C beats, and how long C keeps a turn whose A it no longer hears from.
  interval: "a-tether-heartbeat-interval",
  timeout: "a-tether-heartbeat-timeout",
};
export const clientId = /^[a-f0-9]{12}$/;
// Printable ASCII only, as it travels in a header.
export const hostLabel = (name: string) => name.replace(/[^\x21-\x7e]/g, "").replace(/\.local$/i, "").slice(0, 64);

// What C knows when it beats: the last frame of the turn, the turn's age, how long the
// model has been silent and how long ago C last heard from A. A quotes the last one
// when it gives the turn up.
export type Heartbeat = {n: number; elapsed: number; modelIdle: number; clientIdle: number};

// A turn's context travels as a base C already holds plus what was added since. Messages
// are named by the digest of their JSON, and a history by the chain of its digests, so
// neither end needs a session ID. C answers `resync` when it lacks the base or a reply
// named by `$ref`, and A sends everything.
export type WireContext = {base?: {count: number; chain: string}; add: unknown[]};
export const digest = (text: string) => createHash("sha256").update(text).digest("base64url");
export const chainOf = (previous: string, item: string) => digest(previous + ":" + item);
export const isRef = (item: unknown): item is {$ref: string} =>
  typeof item === "object" && item !== null && typeof (item as {$ref?: unknown}).$ref === "string";
// What A sends with each ping: the frames it has of its turns, the turns it no longer
// wants, and the round trip of its previous ping.
export type Ping = {turns?: Record<string, number>; released?: string[]; rtt?: number};
export type Pong = {loggedIn: boolean; turns: Record<string, {n: number; state: "running" | "done" | "gone"}>};
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
  lost: "C 超过时限没有收到 A 的任何消息，已结束这次请求（connection lost）。请检查网络和端口转发。",
  gone: "C 上已经没有这次请求：C 重启过，或 A 失联太久被 C 放弃（connection lost）。",
  stalled: "向 C 上传请求时长时间没有进展（connection lost）。请检查网络和端口转发。",
  // Not worded for Pi's retry: the link will drop the next attempt the same way.
  blocked: "心跳能到 C，但稍大的请求过不去：这次上传一直没有回应，4 KB 的测试请求也没有回应。链路在丢弃大包（虚拟网卡的 MTU 比实际链路能通过的大），重发没有用。把 ZeroTier 这类虚拟网卡的 MTU 调到 1280，A 或 C 改一端即可，做法见 README「大包被丢弃」。",
  // Never shown: A answers it by sending the whole context.
  resync: "C 缺少这次请求引用的历史，A 会改发完整上下文。",
  connection: "无法连接 C 的 A-tether 服务，请检查网络、端口转发（如 SSH 隧道）和 C 端服务（connection error）。",
  interrupted: "与 C 的连接在响应中途断开，请检查网络、端口转发和 C 端服务（connection lost）。",
  malformed: "C 返回了无法识别的数据，请确认两端的 A-tether 版本一致。",
};
export type Code = keyof typeof messages;

// A reply without the protocol header did not come from A-tether: a proxy, a tunnel,
// or Node answering a broken request by itself. That is a transport failure, not a
// version mismatch, and Pi retries it.
export const foreignReply = (status: number) =>
  `收到的不是 A-tether 服务的响应（HTTP ${status}），可能来自端口转发、代理或超时的连接（connection error）。请检查 client.url 和网络。`;
export const versionMismatch = (mine: string, theirs: string | undefined, theirProtocol: string) =>
  `A 和 C 的 A-tether 版本不一致：A 是 ${mine}（协议 ${protocol}），C 是 ${theirs ?? "更早的版本"}（协议 ${theirProtocol}）。请把两端升级到同一版本。`;

const seconds = (ms: number) => Math.round(ms / 1000);
// A has heard nothing from C for longer than the timeout, across every reconnection.
export function heartbeatLost(silentMs: number, last?: Heartbeat) {
  const seen = last
    ? `最后一次心跳时，请求已运行 ${seconds(last.elapsed)} 秒，模型 ${seconds(last.modelIdle)} 秒没有输出，C ${seconds(last.clientIdle)} 秒前收到过 A 的心跳。`
    : "这次请求还没有收到过心跳。";
  return `A-tether 已 ${seconds(silentMs)} 秒没有收到 C 的任何数据，重连也没有成功（connection lost）。${seen}请检查网络、端口转发和 C 端服务。`;
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
