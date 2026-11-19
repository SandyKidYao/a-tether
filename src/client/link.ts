// What A knows about its link to C. A pings while Pi runs, with or without a request:
// that is how C tells an idle A from one that is gone, and how Pi's status line shows
// the link before a request finds out the hard way.
import { header, type Ping, type Pong } from "../shared/protocol.ts";
import { LinkError, request } from "./http.ts";

export type LinkState = "unknown" | "ok" | "unstable" | "down" | "token" | "version" | "login" | "error";
// What a request is doing, shown instead of the idle state.
export type Activity = {kind: "uploading" | "syncing"; bytes: number} | {kind: "reconnecting" | "stuck"; since: number};

const seconds = (ms: number) => Math.max(0, Math.round(ms / 1000));
const size = (bytes: number) => bytes < 1024 * 1024 ? Math.max(1, Math.round(bytes / 1024)) + " KB" : (bytes / 1024 / 1024).toFixed(1) + " MB";

export class Link {
  state: LinkState = "unknown";
  // Round trip of the last ping, in milliseconds.
  rtt?: number;
  // Since when no ping got through, and when the last one did.
  downSince?: number;
  lastPong?: number;
  detail = "";
  // From C: how often to ping, and how long C keeps a turn whose A it does not hear.
  interval = 10_000;
  timeout = 120_000;
  activity?: Activity;
  private recent: boolean[] = [];
  private pinging = false;
  private inFlight: Promise<void> = Promise.resolve();
  // Pi is quitting and has said goodbye.
  private closed = false;
  private timer?: NodeJS.Timeout;
  private users = 0;
  private listeners = new Set<() => void>();
  // The turns in flight, with the number of frames A has of each.
  private turns = new Map<string, () => number>();
  // Turns A no longer wants, until a ping has told C.
  private released = new Set<string>();

  constructor(private readonly now = Date.now) {}

  // One user per Pi session that loaded the extension. Pings also run while a turn is
  // in flight, whoever started it: without them C would take A for gone.
  start() {
    this.users++;
    this.closed = false;
    if (!this.timer && !this.pinging) this.schedule(0);
  }
  stop() {
    this.users = Math.max(0, this.users - 1);
    if (this.wanted) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
  private get wanted() { return this.users > 0 || this.turns.size > 0; }
  // C's timing, from a ping reply or a turn's stream.
  tune(interval: number, timeout: number) {
    if (!(interval > 0) || !(timeout > interval)) return;
    const sooner = interval < this.interval;
    this.interval = interval;
    this.timeout = timeout;
    // Only a waiting timer is moved. While a ping is in flight there is none, and the
    // ping arms the next one itself.
    if (sooner && this.timer) this.schedule(interval);
  }
  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private changed() { for (const listener of this.listeners) listener(); }

  track(id: string, position: () => number) {
    this.turns.set(id, position);
    this.closed = false;
    if (!this.timer && !this.pinging) this.schedule(0);
  }
  untrack(id: string) { this.turns.delete(id); }
  // The turn is over for A and C may drop it: delivered, cancelled or failed.
  release(id: string) {
    if (!this.turns.delete(id)) return;
    this.released.add(id);
    // Without pings to carry them, as when no session keeps the link going, the oldest go.
    while (this.released.size > 64) this.released.delete(this.released.values().next().value!);
  }
  busy(activity?: Activity) {
    this.activity = activity;
    this.changed();
  }
  get lost() { return this.recent.filter(ok => !ok).length; }

  private schedule(delay: number) {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.closed) return;
    this.timer = setTimeout(() => {
      // Cleared before the ping, so that exactly one of start, track, tune and the
      // ping's own end arms the next one.
      this.timer = undefined;
      this.pinging = true;
      this.inFlight = this.ping().finally(() => {
        this.pinging = false;
        if (this.wanted && !this.timer) this.schedule(this.interval);
      });
    }, delay);
    // Pings alone must not keep Pi from exiting.
    this.timer.unref();
  }

  async ping() {
    const sent = [...this.released];
    const body: Ping = {turns: Object.fromEntries([...this.turns].map(([id, position]) => [id, position()])), released: sent, rtt: this.rtt};
    const began = performance.now();
    try {
      const reply = await request("/v1/ping", {method: "POST", body: JSON.stringify(body), timeout: Math.min(this.interval, 10_000)});
      const pong = await reply.json() as Pong;
      this.rtt = Math.round(performance.now() - began);
      for (const id of sent) this.released.delete(id);
      this.tune(Number(reply.headers[header.interval]), Number(reply.headers[header.timeout]));
      this.record(true);
      this.lastPong = this.now();
      this.downSince = undefined;
      this.detail = "";
      this.state = !pong.loggedIn ? "login" : this.lost >= 2 || this.rtt > 1500 ? "unstable" : "ok";
    } catch (error) {
      this.record(false);
      const code = error instanceof LinkError ? error.code : undefined;
      this.detail = error instanceof Error ? error.message : "";
      if (code === "token" || code === "unauthorized") this.state = "token";
      else if (code === "version") this.state = "version";
      else if (error instanceof LinkError && error.transient) {
        this.downSince ??= this.now();
        this.state = "down";
      } else this.state = "error";
    }
    this.changed();
  }
  private record(ok: boolean) {
    this.recent.push(ok);
    if (this.recent.length > 10) this.recent.shift();
  }

  // Tells C that Pi is quitting, so C cancels its turns and marks it gone at once
  // instead of waiting for the pings to stop. Never delays the exit for long.
  async bye(timeout = 1500) {
    // No ping after the goodbye, and none overtaken by it: C would take it for A coming back.
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    const limit = new Promise<void>(resolve => setTimeout(resolve, timeout).unref());
    await Promise.race([this.inFlight, limit]);
    try { (await request("/v1/bye", {method: "POST", body: "{}", timeout})).close(); } catch {}
  }

  // One line for Pi's footer.
  text() {
    const a = this.activity;
    const head = "A-tether ";
    if (a?.kind === "reconnecting") return head + `◌ 重连中 · 已断开 ${seconds(this.now() - a.since)} 秒，已收到的内容保留`;
    if (a?.kind === "stuck") return head + `↑ 上传 ${seconds(this.now() - a.since)} 秒没有回应，心跳正常，正在检查链路`;
    if (a?.kind === "uploading") return head + `↑ 上传 ${size(a.bytes)}`;
    if (a?.kind === "syncing") return head + `↑ 同步上下文 ${size(a.bytes)}`;
    switch (this.state) {
      case "ok": return head + `● 已连接 ${this.rtt} ms`;
      case "unstable": return head + `◐ 网络不稳 ${this.rtt} ms` + (this.lost ? ` · 最近 ${this.recent.length} 次 ping 丢 ${this.lost} 次` : "");
      case "down": return head + `○ 无法连接 C · 已 ${seconds(this.now() - (this.downSince ?? this.now()))} 秒`;
      case "token": return head + "✕ 令牌未配置或与 C 不一致";
      case "version": return head + "✕ 与 C 版本不一致";
      case "login": return head + "✕ C 上的 Claude Code 未登录";
      case "error": return head + "✕ C 返回了错误";
      default: return head + "… 连接中";
    }
  }
}

// One link per Pi process, kept across extension reloads.
const slot = Symbol.for("a-tether.link");
export const link: Link = ((globalThis as Record<symbol, unknown>)[slot] as Link | undefined) ??
  ((globalThis as Record<symbol, unknown>)[slot] = new Link());
