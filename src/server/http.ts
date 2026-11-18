import { normalizeContext } from "@earendil-works/pi-ai";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Backend, BackendModel } from "../backends/backend.ts";
import { generationOptions, header, protocol, uuid, wireEvent, type Code } from "../shared/protocol.ts";
import { isLoopback, loadSettings, validToken } from "../shared/settings.ts";

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {"content-type": "application/json", "cache-control": "no-store"}).end(JSON.stringify(data));
}
export class Failure extends Error {
  constructor(readonly status: number, readonly code: Code, readonly detail = "") { super(code); }
}
// C logs one line per failure: time, request ID prefix, code and a clipped
// diagnostic from Claude Code. Conversation content and tool data are never logged.
export function clip(text: string) { return text.replace(/\s+/g, " ").trim().slice(0, 500); }
function logError(id: string, code: string, detail = "") {
  const text = clip(detail);
  console.error(`${new Date().toISOString()} ${id ? id.slice(0, 8) : "--------"} ${code}${text ? ": " + text : ""}`);
}
// Aborts carry a reason: A cancelled or went away ("cancelled"), or stopped beating ("lost").
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

async function readRequest(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({destroyOnReturn: false})) {
    size += chunk.length;
    if (size > 32 * 1024 * 1024) throw new Failure(413, "large");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw new Failure(400, "invalid"); }
}

export async function runServer(backend: Backend, {token, host, port}: {token: string; host: string; port: number}) {
  if (!validToken(token)) throw new Error("A-tether token must be at least 32 characters without whitespace");
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const expected = digest("Bearer " + token);

  const directory = await mkdtemp(join(tmpdir(), "a-tether-"));
  process.chdir(directory);
  // Each streaming request, with the time A's last heartbeat for it arrived.
  const active = new Map<string, {controller: AbortController; heard: number}>();
  const pending = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();

  const models = catalogCache<BackendModel>(async signal => {
    const health = await backend.status(signal);
    if (!health.available) throw new Failure(503, "unavailable", health.detail);
    if (health.diagnostic) throw new Failure(502, "backend", "status check failed: " + (health.detail ?? "unknown"));
    if (!health.loggedIn) throw new Failure(503, "login");
    try { return await backend.models(signal); }
    catch (error) {
      signal.throwIfAborted();
      throw new Failure(502, "discovery", describe(error));
    }
  }, detail => logError("", "stale-catalog", detail));

  async function handle(req: IncomingMessage, res: ServerResponse, controller: AbortController) {
    if (!timingSafeEqual(digest(req.headers.authorization ?? ""), expected)) throw new Failure(401, "unauthorized");
    const version = req.headers[header.protocol];
    if (version !== protocol) throw new Failure(400, "version", "A speaks protocol " + (version ?? "(none)") + ", C speaks " + protocol);
    const signal = controller.signal;
    if (req.method === "GET" && req.url === "/v1/health") {
      const {available, loggedIn, diagnostic} = await backend.status(signal);
      return json(res, 200, {available, loggedIn, diagnostic, ...(backend.stats ? {sessions: backend.stats()} : {})});
    }
    if (req.method === "GET" && req.url === "/v1/models") return json(res, 200, (await models(signal)).map(({route, ...model}) => model));
    const [, target, action] = /^\/v1\/requests\/([^/]+)(?:\/(heartbeat))?$/.exec(req.url ?? "") ?? [];
    if (target && uuid.test(target)) {
      if (req.method === "DELETE" && !action) {
        active.get(target)?.controller.abort("cancelled");
        return json(res, 200, {id: target});
      }
      if (req.method === "POST" && action) {
        const entry = active.get(target);
        if (!entry) throw new Failure(404, "invalid");
        entry.heard = Date.now();
        return json(res, 200, {id: target});
      }
    }
    if (req.method !== "POST" || req.url !== "/v1/requests") throw new Failure(404, "invalid");
    const body = await readRequest(req);
    if (!body || typeof body.id !== "string" || !uuid.test(body.id) || !Array.isArray(body.context?.messages)) throw new Failure(400, "invalid");
    const id = body.id;
    if (active.has(id)) throw new Failure(409, "duplicate");
    const {heartbeatInterval, heartbeatTimeout} = loadSettings().server;
    const interval = heartbeatInterval * 1000, timeout = heartbeatTimeout * 1000;
    const entry = {controller, heard: Date.now()};
    active.set(id, entry);
    // From here on every outcome, failures included, is a frame on the stream. There
    // is no limit on the request's length: heartbeats tell a slow model from a dead peer.
    res.writeHead(200, {"content-type": "application/x-ndjson", "cache-control": "no-store",
      [header.interval]: String(interval), [header.timeout]: String(timeout)});
    res.flushHeaders();
    const send = (frame: object) => res.destroyed || res.write(JSON.stringify({id, ...frame}) + "\n");
    const started = Date.now();
    let output = started, seq = 0, ended = false;
    const detail = (code: string) => code === "lost" ? `no heartbeat from A for ${Math.round((Date.now() - entry.heard) / 1000)}s` : "";
    const beat = setInterval(() => {
      const now = Date.now();
      if (now - entry.heard > timeout) return controller.abort("lost");
      send({type: "heartbeat", seq: ++seq, elapsed: now - started, modelIdle: now - output, clientIdle: now - entry.heard});
    }, interval);
    try {
      const model = (await models(signal)).find(m => m.id === body.model);
      signal.throwIfAborted();
      if (!model) throw new Failure(400, "invalid", "unknown model");
      const stream = backend.stream(model, normalizeContext({messages: body.context.messages}), {
        ...generationOptions(body.options), signal,
      });
      try {
        for await (const event of stream) {
          output = Date.now();
          if (event.type === "error") {
            const code = signal.aborted ? signal.reason : backend.errorCode(event.error.errorMessage ?? "");
            logError(id, code, signal.aborted ? detail(code) : event.error.errorMessage);
            ended = true;
            send({type: "error", code});
            continue;
          }
          ended ||= event.type === "done";
          if (!send({type: event.type === "done" ? "done" : "event", event: wireEvent(event)}) && !signal.aborted) await once(res, "drain", {signal});
        }
      } finally {
        controller.abort("cancelled");
        await stream.result();
      }
    } catch (error) {
      const failure = asFailure(error, signal.reason);
      logError(id, failure.code, failure.detail || detail(failure.code));
      if (!ended) send({type: "error", code: failure.code});
    } finally { clearInterval(beat); active.delete(id); }
    res.end();
  }

  const server = createServer((req, res) => {
    const controller = new AbortController();
    controllers.add(controller);
    res.setHeader(header.protocol, protocol);
    res.once("close", () => controller.abort("cancelled"));
    const task = handle(req, res, controller).catch(error => {
      const failure = asFailure(error, controller.signal.reason);
      logError("", failure.code, failure.detail);
      if (res.destroyed) return;
      if (res.headersSent) return res.destroy();
      json(res, failure.status, {code: failure.code});
    }).then(() => {});
    pending.add(task);
    void task.finally(() => { pending.delete(task); controllers.delete(controller); });
  });
  const startup = new AbortController();
  const shutdown = () => {
    startup.abort("cancelled");
    for (const controller of controllers) controller.abort("cancelled");
    server.close();
    server.closeAllConnections();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    const health = await backend.status(startup.signal);
    startup.signal.throwIfAborted();
    const state = !health.available ? "missing"
      : health.diagnostic ? "status check failed" + (health.detail ? " (" + clip(health.detail) + ")" : "")
      : health.loggedIn ? "logged in" : "not logged in";
    console.log(backend.name + ":", state);
    server.listen(port, host);
    await once(server, "listening", {signal:startup.signal});
    console.log("A-tether listening on " + (host.includes(":") ? `[${host}]` : host) + ":" + port);
    if (!isLoopback(host)) console.log("注意：服务监听在非本机地址，令牌以明文 HTTP 传输，同一网络中的设备都能连接。");
    await once(server, "close");
  } catch (error) {
    if (!startup.signal.aborted) throw error;
  } finally {
    await Promise.allSettled(pending);
    await backend.close?.();
    process.chdir(tmpdir());
    await rm(directory, {recursive: true, force: true});
  }
}
