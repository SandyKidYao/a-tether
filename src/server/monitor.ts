// What C's console knows: the A ends that connected, the requests in flight, recent
// activity and a few counters. Only metadata: request IDs, model names, counts, tool
// names and error codes. Conversation content, tool arguments and the token never
// get here. In plain mode the console prints exactly what C printed before the TUI.
import type { IncomingMessage } from "node:http";
import type { Backend, Lease, ProcessExit } from "../backends/backend.ts";
import { clientId, header, hostLabel } from "../shared/protocol.ts";

export type Tag = "request" | "process" | "client" | "system" | "error";
export type Level = "info" | "ok" | "warn" | "error";
export type Entry = {at: number; tag: Tag; level: Level; text: string};

// pinged is A's last ping, rtt the round trip A measured for the one before, and left
// the time A said goodbye.
export type Client = {key: string; id?: string; host: string; addr: string; firstSeen: number; lastSeen: number; today: number;
  pinged?: number; rtt?: number; left?: number};
// What C shows for an A: it said goodbye, it has a request running, its pings arrive,
// or they stopped. An A that never pinged, such as a script calling the API, counts by
// its last request.
export type Presence = "left" | "busy" | "idle" | "lost";
export function presence(client: Client, busy: boolean, now: number, intervalMs: number): Presence {
  if (client.left !== undefined) return "left";
  if (now - (client.pinged ?? client.lastSeen) > 3 * intervalMs + 2000) return "lost";
  return busy ? "busy" : "idle";
}

// One turn while it generates. The HTTP layer owns the controller and `heard`, the last
// time A pinged for the turn or attached to it; the rest is for the console.
export type ActiveRequest = {
  id: string; controller: AbortController; heard: number;
  // Whether a connection of A's is reading the turn, and since when none is.
  attached?: boolean; detached?: number;
  client?: string; model: string; effort?: string; started: number;
  // Last model output, and the characters of text, thinking and tool input streamed so far.
  output: number; chars: number;
  lease?: Lease;
};

export type Health = {available: boolean; loggedIn: boolean; diagnostic: boolean; detail?: string};

const maxEntries = 500;
const maxClients = 64;
export const clip = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 500);
export const short = (id: string) => id ? id.slice(0, 8) : "--------";
export const seconds = (ms: number) => ms < 60_000 ? (ms / 1000).toFixed(1) + "s" : Math.round(ms / 1000) + "s";

const exits: Record<ProcessExit["why"], string> = {
  idle: "空闲 60 分钟，已回收",
  evicted: "进程池已满，回收最久没用的进程",
  oneshot: "一次性进程，请求结束后退出",
  diverged: "历史和 Pi 对不上，不再复用",
  cancelled: "请求取消，进程随之结束",
  lost: "A 失联，进程随之结束",
  left: "A 已退出，保留期过后回收",
  failed: "请求失败，不再复用",
  exited: "进程自己退出了",
  killed: "已在控制台手动结束",
  shutdown: "服务停止",
};

export class Monitor {
  readonly boot: number;
  readonly entries: Entry[] = [];
  readonly clients = new Map<string, Client>();
  readonly active = new Map<string, ActiveRequest>();
  readonly totals = {requests: 0, failed: 0};
  // The A whose request a process served last.
  readonly owners = new Map<number, string | undefined>();
  health?: Health & {at: number};
  catalog?: {count: number; at: number};
  // Bytes C holds for A: the histories behind incremental requests and the frames of
  // turns A has not released. Set by the HTTP layer.
  memory?: () => {contexts: number; turns: number};
  // Set by the TUI: it takes over the terminal, so nothing is printed directly.
  quiet = false;
  onChange?: () => void;
  private day: string;
  private stopWatch?: () => void;

  constructor(readonly backend: Backend, readonly now = Date.now) {
    this.boot = now();
    this.day = new Date(this.boot).toDateString();
    this.stopWatch = backend.watch?.(exit => this.exited(exit));
  }

  close() { this.stopWatch?.(); }

  private add(tag: Tag, level: Level, text: string) {
    this.entries.push({at: this.now(), tag, level, text});
    if (this.entries.length > maxEntries) this.entries.splice(0, this.entries.length - maxEntries);
    this.onChange?.();
  }

  // Startup lines, printed in plain mode as before.
  print(text: string, level: Level = "info") {
    if (!this.quiet) console.log(text);
    this.add("system", level, text);
  }
  // One line per failure: time, request ID prefix, code and a clipped diagnostic from
  // Claude Code. Conversation content and tool data are never logged.
  diagnostic(id: string, code: string, detail = "") {
    const clipped = clip(detail);
    const text = `${short(id)} ${code}${clipped ? ": " + clipped : ""}`;
    if (!this.quiet) console.error(`${new Date(this.now()).toISOString()} ${text}`);
    this.add(code === "stale-catalog" ? "system" : "error", code === "stale-catalog" ? "warn" : "error", text);
  }
  note(tag: Tag, level: Level, text: string) { this.add(tag, level, text); }

  private rollover() {
    const day = new Date(this.now()).toDateString();
    if (day === this.day) return;
    this.day = day;
    this.totals.requests = this.totals.failed = 0;
    for (const client of this.clients.values()) client.today = 0;
  }

  status(health: Health) {
    const changed = !this.health || this.health.loggedIn !== health.loggedIn || this.health.available !== health.available;
    this.health = {...health, at: this.now()};
    if (changed && this.entries.length) {
      this.note("system", health.loggedIn ? "ok" : "error", "Claude Code " + (health.loggedIn ? "已登录" : health.available ? "未登录或登录已失效" : "找不到"));
    }
    return health;
  }
  catalogLoaded(count: number) {
    const first = !this.catalog;
    this.catalog = {count, at: this.now()};
    if (first) this.note("system", "info", `模型目录已加载 · ${count} 个模型`);
  }

  // Records the A behind an authenticated request. A without the client headers is
  // grouped by its address.
  seen(req: IncomingMessage) {
    const raw = req.headers[header.client];
    const id = typeof raw === "string" && clientId.test(raw) ? raw : undefined;
    const hostHeader = req.headers[header.host];
    const addr = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    const key = id ?? "addr:" + addr;
    let client = this.clients.get(key);
    const now = this.now();
    if (!client) {
      const host = typeof hostHeader === "string" && hostLabel(hostHeader) || (id ? "A" : "未标识");
      client = {key, id, host, addr, firstSeen: now, lastSeen: now, today: 0};
      this.clients.set(key, client);
      if (this.clients.size > maxClients) {
        const oldest = [...this.clients.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
        this.clients.delete(oldest.key);
      }
      this.note("client", "info", `${client.host}${id ? " #" + id.slice(0, 4) : ""} 第一次连接 · 来自 ${addr}`);
    }
    client.lastSeen = now;
    client.addr = addr;
    this.onChange?.();
    return client.key;
  }

  pinged(key: string, rtt?: number) {
    const client = this.clients.get(key);
    if (!client) return;
    client.pinged = this.now();
    // An A that pings again has not left: Pi reloaded its extensions. Only a ping says
    // so: the last requests of a Pi that is quitting may arrive after its goodbye.
    client.left = undefined;
    if (typeof rtt === "number" && rtt >= 0 && rtt < 3_600_000) client.rtt = Math.round(rtt);
    this.onChange?.();
  }
  // A said goodbye: its idle processes go after the grace period, and first when the
  // pool needs room.
  bye(key: string, graceMs: number) {
    const client = this.clients.get(key);
    if (!client) return;
    client.left = this.now();
    const pids = [...this.owners].filter(([, owner]) => owner === key).map(([pid]) => pid);
    if (pids.length) this.backend.retire?.(pids, graceMs);
    this.note("client", "info", `${client.host}${client.id ? " #" + client.id.slice(0, 4) : ""} 已退出` +
      (pids.length ? ` · ${pids.length} 个进程${graceMs ? " " + Math.round(graceMs / 1000) + " 秒后回收" : "立即回收"}` : ""));
  }

  started(request: ActiveRequest) {
    this.rollover();
    this.totals.requests++;
    const client = request.client ? this.clients.get(request.client) : undefined;
    if (client) client.today++;
    this.active.set(request.id, request);
    this.onChange?.();
  }

  leased(request: ActiveRequest, lease: Lease) {
    request.lease = lease;
    if (lease.pid !== undefined) this.owners.set(lease.pid, request.client);
    const host = this.hostOf(request.client);
    const pid = lease.pid ?? "?";
    const how = lease.how === "reused"
      ? `复用进程 ${pid}（${lease.history} 条历史，补 ${lease.added && "results" in lease.added ? lease.added.results + " 条工具结果" : (lease.added?.messages ?? 1) + " 条用户消息"}）`
      : lease.how === "rebuilt" ? `启动进程 ${pid}，从 ${lease.history} 条历史重建`
      : lease.how === "oneshot" ? `进程池已满且都在忙，本次用一次性进程 ${pid}`
      : `启动进程 ${pid}`;
    this.note("request", "info", `${host} · 请求 ${short(request.id)} · ${request.model}${request.effort ? " " + request.effort : ""} · ${how}`);
  }

  // A finished request: the tool calls it ends with, or a turn over. Failures are logged
  // as diagnostics by the HTTP layer.
  finished(request: ActiveRequest, result: {tools: string[]; stopReason: string} | {failed: string}) {
    this.active.delete(request.id);
    const took = seconds(this.now() - request.started);
    if ("failed" in result) {
      this.rollover();
      // A cancelling (Esc in Pi, or the console) is no failure.
      if (result.failed !== "cancelled") this.totals.failed++;
      this.onChange?.();
      return;
    }
    const end = result.tools.length ? `等待 ${result.tools.length} 个工具结果（${result.tools.join(", ")}）`
      : result.stopReason === "length" ? "输出达到上限" : "回合结束";
    this.note("request", "ok", `${short(request.id)} 完成 · ${took} · ${end}`);
  }

  // Cancels a request from the console, as A's DELETE does.
  cancel(id: string) {
    const request = this.active.get(id);
    if (!request) return false;
    this.note("request", "warn", `${short(id)} 已在控制台取消`);
    request.controller.abort("cancelled");
    return true;
  }
  kill(pid: number) {
    return this.backend.kill?.(pid) ?? false;
  }

  hostOf(key?: string) { return (key && this.clients.get(key)?.host) || "未标识"; }

  private exited(exit: ProcessExit) {
    if (exit.pid !== undefined) this.owners.delete(exit.pid);
    if (exit.why === "shutdown") return;
    const level: Level = exit.why === "killed" || exit.why === "lost" ? "warn" : "info";
    this.note("process", level, `进程 ${exit.pid ?? "?"} 已结束 · ${exits[exit.why]}${exit.history ? `（释放 ${exit.history} 条历史）` : ""}`);
  }
}
