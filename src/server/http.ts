import { normalizeContext } from "@earendil-works/pi-ai";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { brotliCompressSync, brotliDecompress, constants as zlib, createBrotliCompress } from "node:zlib";
import type { Backend, BackendModel } from "../backends/backend.ts";
import { digest, generationOptions, header, protocol, uuid, wireEvent, type Code, type Ping, type Pong, type WireContext } from "../shared/protocol.ts";
import { isLoopback, loadSettings, validToken } from "../shared/settings.ts";
import { version } from "../shared/version.ts";
import { Contexts } from "./contexts.ts";
import { Monitor, clip, short, type ActiveRequest } from "./monitor.ts";
import { Turn, Turns } from "./turns.ts";

export class Failure extends Error {
  constructor(readonly status: number, readonly code: Code, readonly detail = "") { super(code); }
}
// Aborts carry a reason: A cancelled or quit ("cancelled"), or went silent ("lost").
function asFailure(error: unknown, reason: unknown) {
  return error instanceof Failure ? error
    : reason === "cancelled" || reason === "lost" ? new Failure(499, reason)
    : new Failure(502, "backend", describe(error));
}
function describe(error: unknown) {
  return error instanceof Failure ? error.detail : error instanceof Error ? error.message : typeof error === "string" ? error : "";
}

// Keeps the last good catalog when a refresh fails transiently, such as a slow
// `claude auth status`, and retries soon instead of failing the request.
export function catalogCache<T>(load: (signal: AbortSignal) => Promise<T[]>, onStale: (detail: string) => void,
    ttl = 60_000, retry = 10_000, now = Date.now) {
  let catalog: T[] = [];
  let refreshAt = 0;
  return async (signal: AbortSignal) => {
    if (now() < refreshAt) return catalog;
    try {
      catalog = await load(signal);
      refreshAt = now() + ttl;
    } catch (error) {
      const transient = error instanceof Failure && (error.code === "backend" || error.code === "discovery");
      if (signal.aborted || !transient || !catalog.length) throw error;
      onStale(error.detail);
      refreshAt = now() + retry;
    }
    return catalog;
  };
}

const maxBody = 32 * 1024 * 1024;
const maxProbe = 1024 * 1024;
// Frames that arrive within this many milliseconds travel in one write.
const batchMs = 40;
const inflate = promisify(brotliDecompress);
const acceptsBrotli = (req: IncomingMessage) => /\bbr\b/.test(String(req.headers["accept-encoding"] ?? ""));

// Reads a request body. There is no limit on how long an upload takes, only on how long
// it may stand still: a slow link is fine, a dead one is not.
async function readBody(req: IncomingMessage, idleMs: number, limit = maxBody) {
  const chunks: Buffer[] = [];
  let size = 0;
  const stalled = () => req.destroy(new Failure(408, "stalled"));
  req.socket.setTimeout(idleMs, stalled);
  try {
    for await (const chunk of req.iterator({destroyOnReturn: false})) {
      size += chunk.length;
      if (size > limit) throw new Failure(413, "large");
      chunks.push(chunk);
    }
  } finally {
    req.socket.setTimeout(0);
    req.socket.off("timeout", stalled);
  }
  return Buffer.concat(chunks);
}
async function readJson(req: IncomingMessage, idleMs: number) {
  let body = await readBody(req, idleMs);
  if (req.headers["content-encoding"] === "br") {
    try { body = await inflate(body, {maxOutputLength: maxBody}); }
    catch (error) {
      throw (error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" ? new Failure(413, "large") : new Failure(400, "invalid");
    }
  }
  try { return JSON.parse(body.toString()); }
  catch { throw new Failure(400, "invalid"); }
}

// console starts C's TUI once the server listens. It gets the monitor and a way to stop
// the server, and returns its own stop, called once the server has shut down.
export type Console = (monitor: Monitor, stop: () => void) => (summary: {processes: number}) => void;

export async function runServer(backend: Backend, {token, host, port, console: ui}: {token: string; host: string; port: number; console?: Console}) {
  if (!validToken(token)) throw new Error("A-tether token must be at least 32 characters without whitespace");
  const digestOf = (value: string) => createHash("sha256").update(value).digest();
  const expected = digestOf("Bearer " + token);

  const directory = await mkdtemp(join(tmpdir(), "a-tether-"));
  process.chdir(directory);
  const monitor = new Monitor(backend);
  const logError = (id: string, code: string, detail = "") => monitor.diagnostic(id, code, detail);
  const status = async (signal?: AbortSignal) => monitor.status(await backend.status(signal));
  const turns = new Turns();
  const contexts = new Contexts();
  monitor.memory = () => ({contexts: contexts.bytes, turns: [...turns.all()].reduce((sum, turn) => sum + turn.bytes, 0)});
  const pending = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();
  const track = (task: Promise<void>) => { pending.add(task); void task.finally(() => pending.delete(task)); };
  const sweeping = setInterval(() => turns.sweep(), 30_000).unref();
  let stopping = false;

  const models = catalogCache<BackendModel>(async signal => {
    const health = await status(signal);
    if (!health.available) throw new Failure(503, "unavailable", health.detail);
    if (health.diagnostic) throw new Failure(502, "backend", "status check failed: " + (health.detail ?? "unknown"));
    if (!health.loggedIn) throw new Failure(503, "login");
    try {
      const catalog = await backend.models(signal);
      monitor.catalogLoaded(catalog.length);
      return catalog;
    } catch (error) {
      signal.throwIfAborted();
      throw new Failure(502, "discovery", describe(error));
    }
  }, detail => logError("", "stale-catalog", detail));

  function json(req: IncomingMessage, res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}) {
    const text = JSON.stringify(data);
    // Above one packet, compression decides whether the reply fits a small one.
    const packed = text.length > 1000 && acceptsBrotli(req)
      ? brotliCompressSync(text, {params: {[zlib.BROTLI_PARAM_QUALITY]: 5}}) : undefined;
    res.writeHead(status, {"content-type": "application/json", "cache-control": "no-store", ...headers,
      ...(packed ? {"content-encoding": "br"} : {})}).end(packed ?? text);
  }
  const timing = () => {
    const {heartbeatInterval, heartbeatTimeout} = loadSettings().server;
    return {interval: heartbeatInterval * 1000, timeout: heartbeatTimeout * 1000};
  };
  const timingHeaders = ({interval, timeout}: {interval: number; timeout: number}) =>
    ({[header.interval]: String(interval), [header.timeout]: String(timeout)});

  // A no longer wants the turn it knows by this ID. Once no ID wants it, a finished
  // turn is forgotten, and a running one is cancelled and stays until that has been said
  // to whoever still reads it.
  function release(id: string, turn: Turn) {
    if (!turns.unlink(id, turn)) return;
    end(turn);
  }
  function end(turn: Turn) {
    turns.forget(turn);
    if (turn.state !== "running") return turns.drop(turn);
    turn.entry.controller.abort("cancelled");
    void turn.settled.finally(() => turns.drop(turn));
  }

  // Generates a turn into its buffer. No connection is involved: a slow or broken link
  // neither stalls the model nor ends the turn.
  async function generate(turn: Turn, body: {model: unknown}, messages: unknown[], options: ReturnType<typeof generationOptions>,
      {interval, timeout}: {interval: number; timeout: number}) {
    const entry = turn.entry, id = entry.id, signal = entry.controller.signal;
    let ended = false, failed = "";
    let done: {tools: string[]; stopReason: string} | undefined;
    const detail = (code: string) => code === "lost" ? `no heartbeat from A for ${Math.round((Date.now() - entry.heard) / 1000)}s` : "";
    // A that is gone for longer than the timeout loses the turn. Until then the beat
    // tells an attached A that C is alive while the model is silent.
    const beat = setInterval(() => {
      const now = Date.now();
      if (now - entry.heard > timeout) return entry.controller.abort("lost");
      turn.beat({type: "heartbeat", n: turn.frames.length, elapsed: now - entry.started, modelIdle: now - entry.output, clientIdle: now - entry.heard});
    }, interval);
    try {
      const model = (await models(signal)).find(m => m.id === body.model);
      signal.throwIfAborted();
      if (!model) throw new Failure(400, "invalid", "unknown model");
      const stream = backend.stream(model, normalizeContext({messages: messages as never}), {...options, signal},
        {lease: lease => monitor.leased(entry, lease)});
      try {
        for await (const event of stream) {
          entry.output = Date.now();
          if (event.type === "error") {
            const code = signal.aborted ? signal.reason : backend.errorCode(event.error.errorMessage ?? "");
            logError(id, code, signal.aborted ? detail(code) : event.error.errorMessage);
            ended = true;
            failed = code;
            turn.push({type: "error", code});
            continue;
          }
          if ("delta" in event) entry.chars += event.delta.length;
          if (event.type === "done") {
            ended = true;
            done = {stopReason: event.reason, tools: event.message.content.flatMap(b => b.type === "toolCall" ? [b.name] : [])};
            contexts.reply(event.message);
          }
          turn.push({type: event.type === "done" ? "done" : "event", event: wireEvent(event)});
        }
      } finally {
        entry.controller.abort("cancelled");
        await stream.result();
      }
    } catch (error) {
      const failure = asFailure(error, signal.reason);
      logError(id, failure.code, failure.detail || detail(failure.code));
      failed ||= failure.code;
      if (!ended) turn.push({type: "error", code: failure.code});
    } finally {
      clearInterval(beat);
      if (!done) turns.forget(turn);
      turn.end(done ? "done" : "failed");
      if (monitor.active.get(id) === entry) monitor.finished(entry, done ?? {failed: failed || "cancelled"});
    }
  }

  // Streams a turn to one connection from the frame after `after`, until the turn ends
  // or the connection goes. The turn itself does not care which.
  function attach(turn: Turn, req: IncomingMessage, res: ServerResponse, after: number) {
    // The connection may have gone while C read the request. Its "close" has been
    // emitted then and would never be heard here. The turn goes on without a reader.
    if (res.destroyed) return Promise.resolve();
    // S12: the console's log says when A comes back for a turn and when it loses it.
    if (after > 0 || turn.entry.detached !== undefined) {
      monitor.note("request", "info", `${short(turn.entry.id)} A 重新连上，从第 ${Math.min(after, turn.frames.length) + 1} 帧接着收`);
    }
    const packed = acceptsBrotli(req);
    res.writeHead(200, {"content-type": "application/x-ndjson", "cache-control": "no-store", ...timingHeaders(timing()),
      ...(packed ? {"content-encoding": "br"} : {})});
    res.flushHeaders();
    // One compression stream per connection, with a window large enough to fold the
    // final message, which repeats what was streamed, into references.
    const out = packed ? createBrotliCompress({params: {[zlib.BROTLI_PARAM_QUALITY]: 4, [zlib.BROTLI_PARAM_LGWIN]: 22}}) : undefined;
    out?.pipe(res);
    const sink = out ?? res;
    let cursor = Math.max(0, Math.min(after, turn.frames.length));
    let closed = false, waiting = false, kicked = false, last = 0;
    let timer: NodeJS.Timeout | undefined;
    const write = (text: string) => {
      const ok = sink.write(text);
      out?.flush(zlib.BROTLI_OPERATION_FLUSH);
      return ok;
    };
    return new Promise<void>(resolve => {
      const pump = () => {
        timer = undefined;
        if (closed || waiting) return;
        if (cursor < turn.frames.length) {
          const text = turn.frames.slice(cursor).join("\n") + "\n";
          cursor = turn.frames.length;
          last = Date.now();
          if (!write(text)) {
            waiting = true;
            sink.once("drain", () => { waiting = false; pump(); });
            return;
          }
        }
        if (turn.state !== "running" && cursor === turn.frames.length) { closed = true; sink.end(); }
      };
      const unsubscribe = turn.subscribe({
        wake() {
          if (closed || waiting || timer) return;
          const wait = batchMs - (Date.now() - last);
          if (wait <= 0) pump(); else timer = setTimeout(pump, wait);
        },
        beat(line) { if (!closed && !waiting) write(line + "\n"); },
        kick() { closed = true; kicked = true; res.destroy(); },
      });
      monitor.onChange?.();
      res.once("close", () => {
        const broken = !closed && !kicked && turn.state === "running";
        closed = true;
        clearTimeout(timer);
        unsubscribe();
        out?.destroy();
        if (broken) monitor.note("request", "warn", `${short(turn.entry.id)} A 的连接断开，请求继续，等 A 重连`);
        else monitor.onChange?.();
        resolve();
      });
      pump();
    });
  }

  async function handle(req: IncomingMessage, res: ServerResponse, controller: AbortController) {
    if (!timingSafeEqual(digestOf(req.headers.authorization ?? ""), expected)) throw new Failure(401, "unauthorized");
    const theirs = req.headers[header.protocol];
    if (theirs !== protocol) throw new Failure(400, "version", "A speaks protocol " + (theirs ?? "(none)") + ", C speaks " + protocol);
    const client = monitor.seen(req);
    const signal = controller.signal;
    const url = new URL(req.url ?? "/", "http://c");
    const path = url.pathname;
    if (req.method === "GET" && path === "/v1/health") {
      const {available, loggedIn, diagnostic} = await status(signal);
      return json(req, res, 200, {available, loggedIn, diagnostic, ...(backend.stats ? {sessions: backend.stats()} : {})});
    }
    if (req.method === "GET" && path === "/v1/models") return json(req, res, 200, (await models(signal)).map(({route, ...model}) => model));
    const clock = timing();
    if (req.method === "POST" && path === "/v1/ping") {
      const body = await readJson(req, clock.timeout) as Ping | null;
      const now = Date.now();
      const reply: Pong = {loggedIn: monitor.health?.loggedIn ?? false, turns: {}};
      for (const id of Array.isArray(body?.released) ? body.released.slice(0, 64) : []) {
        const turn = typeof id === "string" ? turns.get(id) : undefined;
        if (turn) release(id, turn);
      }
      for (const id of Object.keys(body?.turns ?? {}).slice(0, 64)) {
        const turn = turns.get(id);
        if (turn) turn.entry.heard = now;
        reply.turns[id] = turn ? {n: turn.frames.length, state: turn.state === "running" ? "running" : "done"} : {n: 0, state: "gone"};
      }
      monitor.pinged(client, body?.rtt);
      return json(req, res, 200, reply, timingHeaders(clock));
    }
    if (req.method === "POST" && path === "/v1/bye") {
      await readBody(req, clock.timeout, 1024);
      for (const turn of turns.all()) if (turn.entry.client === client && turn.state === "running") end(turn);
      monitor.bye(client, loadSettings().server.exitGrace * 1000);
      return json(req, res, 200, {});
    }
    // For A's link check: takes any bytes and answers with as many random ones as asked,
    // uncompressed, so both directions can be timed at a chosen size.
    if (req.method === "POST" && path === "/v1/probe") {
      const received = (await readBody(req, clock.timeout, maxProbe)).length;
      const size = Math.max(0, Math.min(maxProbe, Number(url.searchParams.get("reply")) || 0));
      return void res.writeHead(200, {"content-type": "application/octet-stream", "cache-control": "no-store",
        "a-tether-received": String(received)}).end(randomBytes(size));
    }
    const [, id, action] = /^\/v1\/turns\/([^/]+)(?:\/(events))?$/.exec(path) ?? [];
    if (!id || !uuid.test(id)) throw new Failure(404, "invalid");
    if (req.method === "DELETE" && !action) {
      const turn = turns.get(id);
      if (turn) release(id, turn);
      return json(req, res, 200, {id});
    }
    if (req.method === "GET" && action) {
      const turn = turns.get(id);
      // Not worth a log line: A asks again after C restarted or gave the turn up.
      if (!turn) return json(req, res, 404, {code: "gone"});
      return attach(turn, req, res, Number(url.searchParams.get("after")) || 0);
    }
    if (req.method !== "POST" || action) throw new Failure(404, "invalid");
    const body = await readJson(req, clock.timeout);
    const wire = body?.context as WireContext | undefined;
    if (!body || !wire || !Array.isArray(wire.add) || wire.add.some(item => typeof item !== "object" || item === null) ||
        (wire.base !== undefined && (typeof wire.base?.chain !== "string" || !Number.isInteger(wire.base.count))) ||
        (!wire.base && !wire.add.length)) throw new Failure(400, "invalid");
    // The same request again, after its reply was lost on the way: the turn is running.
    const same = turns.get(id);
    if (same) return attach(same, req, res, 0);
    const resolved = contexts.resolve(wire);
    if (!resolved) return json(req, res, 409, {code: "resync"});
    const options = generationOptions(body.options);
    const model = typeof body.model === "string" ? body.model.slice(0, 64) : "?";
    const key = digest(JSON.stringify([model, options, resolved.chain]));
    // The same context as a turn A never finished reading: hand over that turn instead of
    // generating again. A retry after a broken connection lands here.
    const earlier = turns.reusable(key);
    if (earlier) {
      turns.alias(id, earlier);
      monitor.note("request", "info", `${monitor.hostOf(client)} · 请求 ${short(id)} 与 ${short(earlier.entry.id)} 上下文相同，` +
        (earlier.state === "done" ? "重放已生成的结果" : "接到正在生成的回合"));
      return attach(earlier, req, res, 0);
    }
    // Nothing new once the server is stopping: its abort has already gone round.
    if (stopping) throw new Failure(503, "cancelled");
    const started = Date.now();
    const entry: ActiveRequest = {id, controller: new AbortController(), heard: started, client, model,
      effort: options.reasoning, started, output: started, chars: 0};
    const turn = new Turn(entry, key);
    turns.add(turn);
    controllers.add(entry.controller);
    monitor.started(entry);
    turn.settled = generate(turn, body, resolved.messages, options, clock).finally(() => controllers.delete(entry.controller));
    track(turn.settled);
    return attach(turn, req, res, 0);
  }

  const server = createServer((req, res) => {
    const controller = new AbortController();
    controllers.add(controller);
    res.setHeader(header.protocol, protocol);
    res.setHeader(header.version, version);
    // Ends what this connection asked for and was still waiting on. A turn is not among
    // it: it goes on without a connection.
    res.once("close", () => controller.abort("cancelled"));
    const task = handle(req, res, controller).catch(error => {
      const failure = asFailure(error, controller.signal.reason);
      logError("", failure.code, failure.detail);
      if (res.destroyed) return;
      if (res.headersSent) return res.destroy();
      json(req, res, failure.status, {code: failure.code});
    }).then(() => {});
    track(task.finally(() => { controllers.delete(controller); }));
  });
  // Node's own limit on a whole request would answer a slow upload with a bare 408.
  // readBody watches for a stalled one instead.
  server.requestTimeout = 0;
  // A's pings reuse one connection, so it must outlive the gap between two of them.
  server.keepAliveTimeout = 5 * 60_000;
  const startup = new AbortController();
  let stopConsole: ReturnType<Console> | undefined;
  let ending: number | undefined;
  const shutdown = () => {
    ending ??= backend.processes?.().length ?? 0;
    startup.abort("cancelled");
    stopping = true;
    clearInterval(sweeping);
    for (const controller of controllers) controller.abort("cancelled");
    for (const turn of turns.all()) turn.kick();
    server.close();
    server.closeAllConnections();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    const health = await status(startup.signal);
    startup.signal.throwIfAborted();
    const state = !health.available ? "missing"
      : health.diagnostic ? "status check failed" + (health.detail ? " (" + clip(health.detail) + ")" : "")
      : health.loggedIn ? "logged in" : "not logged in";
    monitor.print(backend.name + ": " + state, health.loggedIn ? "ok" : "error");
    server.listen(port, host);
    await once(server, "listening", {signal:startup.signal});
    monitor.print("A-tether listening on " + (host.includes(":") ? `[${host}]` : host) + ":" + port, "ok");
    if (!isLoopback(host)) monitor.print("注意：服务监听在非本机地址，令牌以明文 HTTP 传输，同一网络中的设备都能连接。", "warn");
    stopConsole = ui?.(monitor, shutdown);
    await once(server, "close");
  } catch (error) {
    if (!startup.signal.aborted) throw error;
  } finally {
    const processes = ending ?? backend.processes?.().length ?? 0;
    await Promise.allSettled(pending);
    await backend.close?.();
    monitor.close();
    stopConsole?.({processes});
    process.chdir(tmpdir());
    await rm(directory, {recursive: true, force: true});
  }
}
