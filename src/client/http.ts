import { randomBytes } from "node:crypto";
import { Agent, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { hostname } from "node:os";
import type { Readable } from "node:stream";
import { brotliCompressSync, constants as zlib, createBrotliDecompress } from "node:zlib";
import { foreignReply, header, hostLabel, messages, protocol, versionMismatch, type Code } from "../shared/protocol.ts";
import { loadSettings } from "../shared/settings.ts";
import { version } from "../shared/version.ts";

// One ID per Pi process, kept in memory only: C's console lists each Pi separately.
// Connections are kept open and reused: on a slow link a new one costs several round
// trips before the first byte. Both live on globalThis so that Pi reloading its
// extensions keeps the ID and the connections.
type Shared = {id: string; agent: Agent};
const slot = Symbol.for("a-tether.client");
const shared: Shared = ((globalThis as Record<symbol, unknown>)[slot] as Shared | undefined) ??
  ((globalThis as Record<symbol, unknown>)[slot] = {id: randomBytes(6).toString("hex"),
    agent: new Agent({keepAlive: true, keepAliveMsecs: 10_000, maxFreeSockets: 4})} satisfies Shared);
const identity = {[header.client]: shared.id, [header.host]: hostLabel(hostname())};

export function errorMessage(code: unknown) {
  return typeof code === "string" && Object.hasOwn(messages, code) ? messages[code as Code] : messages.backend;
}
// transient: the transport failed, and the same request may work on another connection.
// code names what C or the transport said, when it is one of the protocol's codes.
// absent: C's service is not what answers where client.url points. Nothing listens
// there, or a tunnel or proxy answers in its place.
export class LinkError extends Error {
  constructor(message: string, readonly transient: boolean, readonly code?: Code, readonly absent = false) { super(message); }
}

export type Reply = {status: number; headers: IncomingHttpHeaders; body: Readable; json(): Promise<any>; close(): void};
export type Options = {
  method?: string; body?: string | Buffer; signal?: AbortSignal;
  // Compress the body. Not for bodies whose size is the point, such as a probe's.
  compress?: boolean;
  // How long to wait for C's reply to begin.
  timeout?: number;
  // A connection of its own, closed afterwards, to time what a new connection costs.
  fresh?: boolean;
  contentType?: string;
};

// Settings are read on every request, so `login` takes effect without restarting Pi.
// Resolves once C's reply has begun and is neither an error nor from another release;
// the caller reads or closes the body.
export function request(path: string, options: Options = {}, retried = false): Promise<Reply> {
  let loaded;
  try { loaded = loadSettings(); } catch (error) { return Promise.reject(error); }
  const {token, client: settings} = loaded;
  if (!token) return Promise.reject(new LinkError(messages.token, false, "token"));
  const {signal} = options;
  if (signal?.aborted) return Promise.reject(signal.reason);
  let payload = options.body === undefined ? undefined : Buffer.from(options.body);
  const packed = !!payload && !!options.compress && payload.length > 512;
  if (packed) payload = brotliCompressSync(payload!, {params: {[zlib.BROTLI_PARAM_QUALITY]: 5, [zlib.BROTLI_PARAM_SIZE_HINT]: payload!.length}});
  return new Promise<Reply>((resolve, reject) => {
    const req = httpRequest(new URL(path, settings.url), {method: options.method ?? "GET", agent: options.fresh ? false : shared.agent,
      headers: {authorization: "Bearer " + token, "content-type": options.contentType ?? "application/json", "accept-encoding": "br",
        [header.protocol]: protocol, [header.version]: version, ...identity,
        ...(payload ? {"content-length": payload.length} : {}), ...(packed ? {"content-encoding": "br"} : {})}});
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const abort = () => { req.destroy(); settle(() => reject(signal!.reason)); };
    const settle = (act: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      act();
    };
    if (options.timeout) timer = setTimeout(() => {
      req.destroy();
      settle(() => { signal?.removeEventListener("abort", abort); reject(new LinkError(messages.connection, true, "connection")); });
    }, options.timeout);
    signal?.addEventListener("abort", abort, {once: true});
    req.on("error", (error: NodeJS.ErrnoException) => settle(() => {
      signal?.removeEventListener("abort", abort);
      // C may close an idle connection just as A reuses it. That says nothing about the
      // link, so the request goes out once more on a new one.
      if (req.reusedSocket && !retried && (error.code === "ECONNRESET" || error.code === "EPIPE")) return resolve(request(path, options, true));
      reject(new LinkError(messages.connection, true, "connection", error.code === "ECONNREFUSED"));
    }));
    req.on("response", res => settle(() => {
      const close = () => { signal?.removeEventListener("abort", onAbort); res.destroy(); };
      const onAbort = () => res.destroy();
      signal?.removeEventListener("abort", abort);
      signal?.addEventListener("abort", onAbort, {once: true});
      const status = res.statusCode ?? 0;
      const theirs = res.headers[header.protocol];
      // No protocol header: the reply is not from A-tether. Node answers a broken or
      // timed-out request by itself, and tunnels and proxies answer for a C they cannot reach.
      if (typeof theirs !== "string") { close(); return reject(new LinkError(foreignReply(status), true, "connection", true)); }
      if (theirs !== protocol) {
        close();
        const release = res.headers[header.version];
        return reject(new LinkError(versionMismatch(version, typeof release === "string" ? release : undefined, theirs), false, "version"));
      }
      const body: Readable = res.headers["content-encoding"] === "br" ? res.pipe(createBrotliDecompress()) : res;
      // pipe does not pass a broken connection on: the reader would wait forever.
      res.once("close", () => {
        signal?.removeEventListener("abort", onAbort);
        if (body !== res && !res.complete) body.destroy(new Error("connection closed"));
      });
      const json = async () => {
        const chunks: Buffer[] = [];
        try { for await (const chunk of body) chunks.push(chunk); }
        catch { throw signal?.aborted ? signal.reason : new LinkError(messages.interrupted, true, "interrupted"); }
        try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new LinkError(messages.malformed, false, "malformed"); }
      };
      if (status >= 400) {
        return void json().then(data => {
          const code = typeof data?.code === "string" && Object.hasOwn(messages, data.code) ? data.code as Code : undefined;
          reject(new LinkError(errorMessage(code), code === "stalled", code));
        }, reject);
      }
      resolve({status, headers: res.headers, body, json, close});
    }));
    req.end(payload);
  });
}
