import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { createProvider, createAssistantMessageEventStream, type AssistantMessage, type StreamFunction, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { api, chainOf, defaultUrl, digest, generationOptions, header, heartbeatLost, messages, providerId, type Heartbeat, type WireContext } from "../../shared/protocol.ts";
import { LinkError, request, errorMessage, type Reply } from "../../client/http.ts";
import { link } from "../../client/link.ts";
import { diagnose } from "../../client/doctor.ts";
import { displayPath, loadSettings } from "../../shared/settings.ts";

// Fire and forget: the reply does not matter. A's pings repeat what these say.
const discard = (path: string, method: string) =>
  void request(path, {method, signal: AbortSignal.timeout(5000)}).then(reply => reply.close(), () => {});

// What C holds, as far as A knows: histories by the chain of their digests, and the
// digests of C's own replies. A wrong guess costs one round trip: C answers `resync`.
const histories = new Set<string>(), replies = new Set<string>();
function remember(set: Set<string>, value: string, limit: number) {
  set.delete(value);
  set.add(value);
  while (set.size > limit) set.delete(set.values().next().value!);
}
// The context as the longest history C holds plus what was added since. C's own
// replies are named instead of sent back.
export function encodeContext(context: {messages: unknown[]}, full = false): {wire: WireContext; chain: string} {
  const digests = context.messages.map(message => digest(JSON.stringify(message)));
  let chain = "";
  const chains = digests.map(item => chain = chainOf(chain, item));
  let count = 0;
  if (!full) for (let i = chains.length; i > 0 && !count; i--) if (histories.has(chains[i - 1])) count = i;
  const add = context.messages.slice(count).map((message, i) => !full && replies.has(digests[count + i]) ? {$ref: digests[count + i]} : message);
  return {wire: {...(count ? {base: {count, chain: chains[count - 1]}} : {}), add}, chain};
}
// The turn itself failed, or C sent what A cannot read: no other connection will help.
class Failed extends Error {}
const backoff = (attempt: number) => Math.min(5000, 250 * 2 ** attempt) * (0.8 + 0.4 * Math.random());

export const remoteStream: StreamFunction<string, SimpleStreamOptions> = (model, context, options) => {
  const stream = createAssistantMessageEventStream();
  const id = randomUUID();
  const signal = options?.signal;
  const toolJson = new Map<number, string>();
  let partial: AssistantMessage = {
    role: "assistant", provider: providerId, api, model: model.id, content: [], timestamp: Date.now(), stopReason: "pending",
    usage: {input:0, output:0, cacheRead:0, cacheWrite:0, totalTokens:0, cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
  };
  // Frames of the turn applied so far. The turn lives on C apart from any connection:
  // when one breaks, A attaches again and continues after this frame.
  let n = 0;
  let last: Heartbeat | undefined;
  // The last time anything arrived from C for this turn.
  let heard = Date.now();
  let interval = link.interval, timeout = link.timeout;

  // Reads one connection. True when the turn is done; throws a transient LinkError when
  // the connection broke or went quiet, and anything else when the turn failed.
  async function consume(reply: Reply) {
    // C beats every interval, model output or not. A connection that stays quiet for
    // longer is dead or stuck, and another one will do better.
    const quiet = setTimeout(() => reply.close(), Math.round(2.5 * interval));
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of reply.body) {
        heard = Date.now();
        quiet.refresh();
        buffer += decoder.decode(chunk, {stream: true});
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          let frame;
          try { frame = JSON.parse(buffer.slice(0, newline)); } catch { throw new Failed(messages.malformed); }
          buffer = buffer.slice(newline + 1);
          if (frame?.type === "heartbeat") { last = frame; continue; }
          if (!Number.isInteger(frame?.n) || frame.n > n + 1) throw new Failed(messages.malformed);
          if (frame.n <= n) continue; // sent again after a reconnect
          n = frame.n;
          if (frame.type === "error") throw new Failed(errorMessage(frame.code));
          const event = frame.event;
          if (frame.type === "done" && event?.type === "done") {
            remember(replies, digest(JSON.stringify(event.message)), 256);
            stream.push(event);
            return true;
          }
          if (frame.type !== "event" || !event) throw new Failed(messages.malformed);
          const index = event.contentIndex;
          const block = partial.content[index];
          switch (event.type) {
            case "start": partial = event.partial; break;
            case "text_start":
            case "thinking_start":
            case "toolcall_start":
              partial.content[index] = event.block;
              break;
            case "text_delta": if (block.type === "text") block.text += event.delta; break;
            case "text_end": if (block.type === "text") block.text = event.content; break;
            case "thinking_delta": if (block.type === "thinking") block.thinking += event.delta; break;
            case "thinking_end":
              if (block.type === "thinking") {
                block.thinking = event.content;
                block.thinkingSignature = event.signature;
              }
              break;
            case "toolcall_delta": {
              const json = (toolJson.get(index) ?? "") + event.delta;
              toolJson.set(index, json);
              if (block.type === "toolCall") {
                try { block.arguments = JSON.parse(json); } catch { /* incomplete JSON */ }
              }
              break;
            }
            case "toolcall_end": partial.content[index] = event.toolCall; toolJson.delete(index); break;
            default: throw new Failed(messages.malformed);
          }
          stream.push({...event, partial});
        }
      }
    } catch (error) {
      // Anything else is the connection breaking under the reader.
      if (error instanceof Failed) throw error;
      throw new LinkError(messages.interrupted, true, "interrupted");
    } finally {
      clearTimeout(quiet);
      reply.close();
    }
    throw new LinkError(messages.interrupted, true, "interrupted");
  }

  void (async () => {
    let lost = "";
    // Whether C may drop the turn when A is through with it. Not when A merely gave up
    // waiting: the turn may still finish on C, and Pi's retry then gets it replayed.
    let release = true;
    link.track(id, () => n);
    try {
      let started = false, resynced = false, attempt = 0;
      let encoded = encodeContext(context);
      for (;;) {
        const body = started ? undefined : JSON.stringify({model: model.id, options: generationOptions(options), context: encoded.wire});
        // An upload shows no progress to watch, so a large one is given more time: the
        // timeout plus what the body takes at 4 KB/s.
        const patience = started ? timeout : timeout + (body!.length >> 2);
        try {
          if (body && body.length > 16 * 1024) link.busy({kind: resynced ? "syncing" : "uploading", bytes: body.length});
          const reply = body
            ? await request("/v1/turns/" + id, {method: "POST", body, compress: true, signal, timeout: patience})
            : await request(`/v1/turns/${id}/events?after=${n}`, {signal, timeout: Math.min(15_000, Math.max(1000, 2.5 * interval))});
          const beat = Number(reply.headers[header.interval]), limit = Number(reply.headers[header.timeout]);
          if (!(beat > 0) || !(limit > beat)) { reply.close(); throw new Failed(messages.malformed); }
          interval = beat;
          timeout = limit;
          link.tune(beat, limit);
          if (!started) {
            remember(histories, encoded.chain, 64);
            // C has the request. After that only data counts as hearing from C: a link
            // that passes the few bytes of a reply's head and nothing else is not working.
            heard = Date.now();
          }
          started = true;
          attempt = 0;
          link.busy();
          if (await consume(reply)) return;
        } catch (error) {
          if (signal?.aborted) throw error;
          if (error instanceof LinkError && error.code === "resync" && !resynced) {
            // C lacks the history A built on, after a restart or an eviction: send it all.
            resynced = true;
            histories.clear();
            replies.clear();
            encoded = encodeContext(context, true);
            continue;
          }
          if (!(error instanceof LinkError) || !error.transient) throw error;
          // C's service is not what answers there: it or the tunnel is down, or
          // client.url is wrong. Say so at once instead of trying for minutes. Once the
          // turn runs on C, a tunnel or proxy that is being restarted is worth waiting for.
          if (!started && error.absent) throw error;
          const silent = Date.now() - heard;
          if (silent > patience) {
            lost = heartbeatLost(silent, last);
            release = false;
            throw error;
          }
          link.busy({kind: "reconnecting", since: heard});
          await sleep(backoff(attempt++), undefined, {signal});
        }
      }
    } catch (error) {
      const reason = signal?.aborted ? "aborted" : "error";
      partial = {...partial, stopReason: reason, errorMessage: signal?.aborted ? messages.cancelled
        : lost || (error instanceof Error ? error.message : messages.interrupted)};
      stream.push({type:"error", reason, error:partial});
    } finally {
      // Delivered, cancelled or failed: C may drop the turn. The next pings repeat it in
      // case this request does not arrive.
      if (release || signal?.aborted) {
        link.release(id);
        discard("/v1/turns/" + id, "DELETE");
      } else link.untrack(id);
      link.busy();
      stream.end();
    }
  })();
  return stream;
};

export default function extension(pi: ExtensionAPI) {
  pi.registerProvider(createProvider({
    id: providerId, name: "A-tether · Remote Claude", baseUrl: defaultUrl,
    // Always report the provider as configured so its models stay listed. A missing
    // or wrong token is explained when Pi starts and on each request instead.
    auth: {apiKey: {
      name: "A-tether token",
      async check() { return {type:"api_key", source:displayPath}; },
      async resolve() { return {auth:{apiKey:"a-tether"}, source:displayPath}; },
    }},
    models: [{ id:"default", name:"Default (C)", api, provider:providerId, baseUrl:defaultUrl, reasoning:true,
      input:["text","image"], contextWindow:200000, maxTokens:64000, cost:{input:0,output:0,cacheRead:0,cacheWrite:0} }],
    async fetchModels({signal}) { return (await request("/v1/models", {signal, timeout: 60_000})).json(); },
    api: {stream: remoteStream, streamSimple: remoteStream},
  }));
  // The link's state stays in Pi's footer: connected with its delay, unstable,
  // reconnecting, unreachable, or why C refuses.
  let unwatch: (() => void) | undefined;
  pi.on("session_start", (event, ctx) => {
    unwatch?.();
    const show = () => { if (ctx.hasUI) ctx.ui.setStatus(providerId, link.text()); };
    unwatch = link.onChange(show);
    link.start();
    show();
    if (event.reason !== "startup") return;
    try { if (!loadSettings().token) ctx.ui.notify(messages.token, "warning"); }
    catch (error) { ctx.ui.notify((error as Error).message, "error"); }
  });
  pi.on("session_shutdown", async event => {
    unwatch?.();
    unwatch = undefined;
    link.stop();
    // Only when Pi itself quits: a reload or a new session keeps the same Pi process.
    if (event.reason === "quit") await link.bye();
  });
  pi.registerCommand("a-tether-status", {
    description: "Check Claude Code login on C and measure the link to C",
    handler: async (_args, ctx) => {
      try {
        ctx.ui.notify("正在检查 C 并测量链路，弱网下可能要一分钟…", "info");
        const report = await diagnose(ctx.signal);
        ctx.ui.notify(report.lines.join("\n"), report.ok ? "info" : "error");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : messages.connection, "error"); }
    },
  });
}
