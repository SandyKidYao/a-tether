import { normalizeContext } from "@earendil-works/pi-ai";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Backend, BackendModel } from "../backends/backend.ts";
import { generationOptions, uuid, wireEvent, type Code } from "../shared/protocol.ts";

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {"content-type": "application/json", "cache-control": "no-store"}).end(JSON.stringify(data));
}
class Failure extends Error {
  constructor(readonly status: number, readonly code: Code) { super(code); }
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

export async function runServer(backend: Backend) {
  const token = process.env.A_TETHER_TOKEN;
  if (!token || token.length < 32 || /\s/.test(token)) throw new Error("Set A_TETHER_TOKEN to a random token of at least 32 characters");
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const expected = digest("Bearer " + token);
  delete process.env.A_TETHER_TOKEN;
  const port = Number(process.env.A_TETHER_PORT ?? 7310);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid A_TETHER_PORT");

  const directory = await mkdtemp(join(tmpdir(), "a-tether-"));
  process.chdir(directory);
  const active = new Map<string, AbortController>();
  const pending = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();
  let catalog: BackendModel[] = [];
  let refreshAt = 0;

  async function models(signal: AbortSignal) {
    if (Date.now() < refreshAt) return catalog;
    const health = await backend.status(signal);
    if (!health.available) throw new Failure(503, "unavailable");
    if (health.diagnostic) throw new Failure(502, "backend");
    if (!health.loggedIn) throw new Failure(503, "login");
    try {
      catalog = await backend.models(signal);
      refreshAt = Date.now() + 60_000;
      return catalog;
    } catch { throw new Failure(502, "discovery"); }
  }
  async function handle(req: IncomingMessage, res: ServerResponse, controller: AbortController) {
    if (!timingSafeEqual(digest(req.headers.authorization ?? ""), expected)) throw new Failure(401, "unauthorized");
    const signal = controller.signal;
    if (req.method === "GET" && req.url === "/v1/health") return json(res, 200, await backend.status(signal));
    if (req.method === "GET" && req.url === "/v1/models") return json(res, 200, (await models(signal)).map(({route, ...model}) => model));
    const cancelId = req.url?.slice("/v1/requests/".length) ?? "";
    if (req.method === "DELETE" && req.url?.startsWith("/v1/requests/") && uuid.test(cancelId)) {
      active.get(cancelId)?.abort("cancelled");
      return json(res, 200, {id: cancelId});
    }
    if (req.method !== "POST" || req.url !== "/v1/requests") throw new Failure(404, "invalid");
    const body = await readRequest(req);
    if (!body || typeof body.id !== "string" || !uuid.test(body.id) || !Array.isArray(body.context?.messages)) throw new Failure(400, "invalid");
    const id = body.id;
    if (active.has(id)) throw new Failure(409, "duplicate");
    active.set(id, controller);
    const timer = setTimeout(() => controller.abort("timeout"), 300_000);
    try {
      const model = (await models(signal)).find(m => m.id === body.model);
      signal.throwIfAborted();
      if (!model) throw new Failure(400, "invalid");
      res.writeHead(200, {"content-type": "application/x-ndjson", "cache-control": "no-store"});
      res.flushHeaders();
      const stream = backend.stream(model, normalizeContext({messages: body.context.messages}), {
        ...generationOptions(body.options), signal,
      });
      try {
        for await (const event of stream) {
          if (res.destroyed) continue;
          const frame = event.type === "error"
            ? {id, type: "error", code: signal.aborted ? signal.reason : backend.errorCode(event.error.errorMessage ?? "")}
            : {id, type: event.type === "done" ? "done" : "event", event: wireEvent(event)};
          if (!res.write(JSON.stringify(frame) + "\n") && !signal.aborted) await once(res, "drain", {signal});
        }
      } finally {
        controller.abort("cancelled");
        await stream.result();
      }
      res.end();
    } finally { clearTimeout(timer); active.delete(id); }
  }

  const server = createServer((req, res) => {
    const controller = new AbortController();
    controllers.add(controller);
    res.once("close", () => controller.abort("cancelled"));
    const task = handle(req, res, controller).catch(error => {
      if (res.destroyed) return;
      if (res.headersSent) return res.destroy();
      const failure = error instanceof Failure ? error : new Failure(502, "backend");
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
    console.log(backend.name + ":", health.available ? health.loggedIn ? "logged in" : "login unavailable" : "missing");
    server.listen(port, "127.0.0.1");
    await once(server, "listening", {signal:startup.signal});
    console.log("A-tether listening on 127.0.0.1:" + port);
    await once(server, "close");
  } catch (error) {
    if (!startup.signal.aborted) throw error;
  } finally {
    await Promise.allSettled(pending);
    process.chdir(tmpdir());
    await rm(directory, {recursive: true, force: true});
  }
}
