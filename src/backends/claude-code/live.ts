// Long-lived Claude Code processes, one per Pi conversation. Each keeps its native
// transcript; tools reach Pi through an "sdk" MCP server whose calls stay open until
// Pi sends the results with its next request. See docs/dev/live-session.md.
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {randomUUID} from "node:crypto";
import type {ToolResultMessage, UserMessage} from "@earendil-works/pi-ai";
import {isolated, spawnClaude, streaming} from "./claude-process.ts";
import {mcpResult, userContent, type normalizeMessages} from "./transcript.ts";
import {loadSettings} from "../../shared/settings.ts";

type Conversation = ReturnType<typeof normalizeMessages>;
export type CatalogTool = {name: string; description: string; inputSchema: unknown};
// Everything fixed when the process starts. Tools may change later; the rest may not.
export type Spec = {command: string; route: string; system: string; effort?: string; maxTokens?: number; tools: CatalogTool[]};
export type Input = {kind: "user"; content: unknown[]} | {kind: "results"; results: Map<string, unknown>};
// Where a request leaves the process: waiting for Pi's tool results, about to emit its
// final `result`, or done with the turn.
export type End = {state: "awaitingTools"; pending: string[]} | {state: "finishing"} | {state: "idle"};
// Translates one request's share of the CLI output into Pi events.
export interface Segment {
  onEvent(event: any): End | undefined;
  // A tools/call arrived while this segment was active.
  onToolCall(): End | undefined;
  // The reply called a tool the CLI does not know, so the CLI answered it itself and
  // the process no longer matches Pi's history.
  readonly diverged: boolean;
}

const server = "tether";
const toolListTimeout = 5000;
let idleMs = 60 * 60_000; // Claude Code's prompt cache lives one hour
const pool = new Set<LiveClaude>();
// Counts for /v1/health: processes started and requests served by an existing one.
export const liveStats = {started: 0, reused: 0};

export class LiveClaude {
  state: "generating" | "awaitingTools" | "finishing" | "idle" | "dead" = "generating";
  consumed: string[] = [];
  pending: string[] = [];
  busy = true;
  lastUsed = Date.now();
  private diverged = false;
  private reason: unknown;
  private failing = false;
  private held = new Map<string, {requestId: string; rpcId: unknown}>();
  private buffered = new Map<string, unknown>();
  private active?: {segment: Segment; resolve(): void; reject(error: unknown): void};
  private toolsListed?: () => void;
  private timer?: NodeJS.Timeout;
  private constructor(readonly spec: Spec, readonly pooled: boolean,
    private readonly proc: ReturnType<typeof spawnClaude>, private readonly dir: string) {}

  static async start(spec: Spec, pooled: boolean) {
    const dir = await mkdtemp(join(tmpdir(), "a-tether-turn-"));
    try {
      const system = join(dir, "system.txt");
      await writeFile(system, spec.system, {mode: 0o600});
      const args = [...isolated, ...streaming, "--include-partial-messages", "--model", spec.route,
        "--allowedTools", "mcp__" + server, "--mcp-config", JSON.stringify({mcpServers: {[server]: {type: "sdk", name: server}}}),
        "--system-prompt-file", system, ...(spec.effort ? ["--effort", spec.effort] : [])];
      const env = {DISABLE_AUTO_COMPACT: "1", MCP_TOOL_TIMEOUT: String(2 * idleMs),
        ...(spec.maxTokens ? {CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(spec.maxTokens)} : {})};
      const live = new LiveClaude(spec, pooled, spawnClaude(args, {cwd: dir, env}), dir);
      liveStats.started++;
      if (pooled) pool.add(live);
      void live.read();
      return live;
    } catch (error) {
      await rm(dir, {recursive: true, force: true});
      throw error;
    }
  }

  get pid() { return this.proc.child.pid; }

  // Feeds this request's input and resolves when its segment of output is over.
  run(input: Input, segment: Segment, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.state === "dead") throw this.reason;
    clearTimeout(this.timer);
    this.state = "generating";
    this.pending = [];
    const done = new Promise<void>((resolve, reject) => { this.active = {segment, resolve, reject}; });
    const abort = () => this.kill(signal?.reason);
    signal?.addEventListener("abort", abort, {once: true});
    if (input.kind === "user") this.send({type: "user", message: {role: "user", content: input.content}});
    else for (const [id, result] of input.results) {
      const call = this.held.get(id);
      if (call) { this.held.delete(id); this.answer(call, result); } else this.buffered.set(id, result);
    }
    return done.finally(() => signal?.removeEventListener("abort", abort));
  }

  // Replaces the tool catalog; the CLI refetches it before its next model call.
  async setTools(tools: CatalogTool[]) {
    this.spec.tools = tools;
    const listed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Claude did not reload the tools")), toolListTimeout);
      this.toolsListed = () => { clearTimeout(timer); resolve(); };
    });
    this.send({type: "control_request", request_id: randomUUID(), request: {subtype: "mcp_message", server_name: server,
      message: {jsonrpc: "2.0", method: "notifications/tools/list_changed"}}});
    try { await listed; } finally { this.toolsListed = undefined; }
  }

  // Called after a request succeeds, with the history the process now holds.
  release(consumed: string[]) {
    this.consumed = consumed;
    this.busy = false;
    this.lastUsed = Date.now();
    if (!this.pooled || this.diverged) return this.kill();
    this.timer = setTimeout(() => this.kill(), idleMs).unref();
  }

  kill(reason?: unknown) {
    if (this.state !== "dead") {
      this.state = "dead";
      this.reason = reason ?? new Error(["Claude process ended", this.proc.stderr()].filter(Boolean).join("; "));
      clearTimeout(this.timer);
      pool.delete(this);
      this.proc.stop();
      void this.proc.closed.catch(() => {}).finally(() => rm(this.dir, {recursive: true, force: true}));
    }
    const active = this.active;
    this.active = undefined;
    active?.reject(this.reason);
  }

  get closed() { return this.proc.closed.catch(() => -1); }

  private send(message: unknown) { this.proc.child.stdin.write(JSON.stringify(message) + "\n"); }
  private reply(requestId: string, response: unknown) {
    this.send({type: "control_response", response: {subtype: "success", request_id: requestId, response}});
  }
  private answer(call: {requestId: string; rpcId: unknown}, result: unknown) {
    this.reply(call.requestId, {mcp_response: {jsonrpc: "2.0", id: call.rpcId, result}});
  }

  private async read() {
    try {
      for await (const line of this.proc.lines) {
        let event;
        try { event = JSON.parse(line); } catch { continue; } // ignore non-JSON noise on stdout
        this.handle(event);
      }
      await this.proc.closed;
    } catch (error) {
      this.kill(error);
      return;
    }
    this.kill();
  }

  private handle(event: any) {
    if (event.type === "control_request") {
      if (event.request?.subtype === "mcp_message" && event.request.server_name === server) this.mcp(event.request_id, event.request.message);
      else this.send({type: "control_response", response: {subtype: "error", request_id: event.request_id, error: "Unsupported request"}});
      return;
    }
    if (event.type === "control_response" || this.failing) return;
    // The CLI must never compact on its own: Pi owns the history (DISABLE_AUTO_COMPACT).
    if (event.type === "system" && event.subtype === "compact_boundary") this.diverged = true;
    const active = this.active;
    if (!active) {
      if (event.type === "result" && this.state === "finishing") {
        if (event.subtype === "success" && !event.is_error) this.state = "idle"; else this.kill();
      } else if (["stream_event", "assistant", "result"].includes(event.type)) {
        this.kill(); // output nobody asked for: the CLI went on without Pi
      }
      return;
    }
    try { this.end(active.segment.onEvent(event)); } catch (error) { this.fail(error); }
  }

  // A failed reply ends the process. Give the CLI a moment to finish its stderr and
  // exit, so the C diagnostic line carries the exit code and the CLI's own error.
  private fail(error: unknown) {
    const active = this.active;
    this.active = undefined;
    this.failing = true;
    const exited = this.proc.closed.then(code => code, () => undefined);
    void Promise.race([exited, new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 1000).unref())]).then(code => {
      const detail = [error instanceof Error ? error.message : String(error), code === undefined ? "" : "exit " + code, this.proc.stderr()];
      this.kill();
      active?.reject(new Error(detail.filter(Boolean).join("; ")));
    });
  }

  private mcp(requestId: string, message: any) {
    if (message?.id === undefined) return this.reply(requestId, {mcp_response: {jsonrpc: "2.0", id: 0, result: {}}});
    const respond = (result: unknown) => this.answer({requestId, rpcId: message.id}, result);
    if (message.method === "initialize") {
      return respond({protocolVersion: message.params?.protocolVersion, serverInfo: {name: "a-tether", version: "0.2.0"}, capabilities: {tools: {listChanged: true}}});
    }
    if (message.method === "tools/list") { respond({tools: this.spec.tools}); this.toolsListed?.(); return; }
    if (message.method === "ping") return respond({});
    if (message.method !== "tools/call") {
      return this.reply(requestId, {mcp_response: {jsonrpc: "2.0", id: message.id, error: {code: -32601, message: "Method not found"}}});
    }
    const id = message.params?._meta?.["claudecode/toolUseId"];
    if (typeof id !== "string") {
      this.diverged = true;
      return respond({isError: true, content: [{type: "text", text: "Tool call without an ID"}]});
    }
    const result = this.buffered.get(id);
    if (result !== undefined) { this.buffered.delete(id); respond(result); }
    else this.held.set(id, {requestId, rpcId: message.id});
    const active = this.active;
    if (active) try { this.end(active.segment.onToolCall()); } catch (error) { this.fail(error); }
  }

  private end(end: End | undefined) {
    const active = this.active;
    if (!end || !active) return;
    if (active.segment.diverged) this.diverged = true;
    this.active = undefined;
    this.state = end.state;
    this.pending = end.state === "awaitingTools" ? end.pending : [];
    active.resolve();
  }
}

const sameSpec = (a: Spec, b: Spec) => a.command === b.command && a.route === b.route && a.system === b.system &&
  a.effort === b.effort && a.maxTokens === b.maxTokens;

// Finds an idle process whose history is a prefix of this request's and whose next
// input is exactly what the request adds: the results it waits for, or new user messages.
export function reuse(spec: Spec, keys: string[], conversation: Conversation) {
  const candidates = [...pool].filter(p => !p.busy && sameSpec(p.spec, spec) &&
    p.consumed.length < keys.length && p.consumed.every((key, i) => key === keys[i]));
  for (const live of candidates.sort((a, b) => b.lastUsed - a.lastUsed)) {
    const delta = conversation.slice(live.consumed.length);
    let input: Input | undefined;
    if (live.state === "awaitingTools") {
      const results = delta.filter((m): m is ToolResultMessage => m.role === "toolResult");
      const ids = new Set(results.map(m => m.toolCallId));
      if (results.length === delta.length && results.length === live.pending.length && live.pending.every(id => ids.has(id))) {
        input = {kind: "results", results: new Map(results.map(m => [m.toolCallId, mcpResult(m)]))};
      }
    } else if (live.state === "idle" && delta.every(m => m.role === "user")) {
      input = {kind: "user", content: userContent(delta as UserMessage[])};
    }
    if (!input) continue;
    live.busy = true;
    liveStats.reused++;
    return {live, input, toolsChanged: JSON.stringify(live.spec.tools) !== JSON.stringify(spec.tools)};
  }
}

// Whether a new process may join the pool, evicting the least recently used idle one
// when full. With every slot busy the request runs in a process of its own.
export function admit() {
  const max = loadSettings().server.maxSessions;
  while (pool.size >= max) {
    const victim = [...pool].filter(p => !p.busy).sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!victim) return false;
    victim.kill();
  }
  return max > 0;
}

export async function shutdownLive() {
  const all = [...pool];
  for (const live of all) live.kill();
  await Promise.all(all.map(live => live.closed));
}

// Tests shorten the idle timeout instead of waiting an hour.
export function setIdleTimeout(ms: number) { idleMs = ms; }
export const livePool = () => [...pool];
