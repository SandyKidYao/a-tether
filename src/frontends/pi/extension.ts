import { randomUUID } from "node:crypto";
import { createProvider, createAssistantMessageEventStream, type AssistantMessage, type StreamFunction, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { api, defaultUrl, generationOptions, header, heartbeatLost, messages, providerId, type Heartbeat } from "../../shared/protocol.ts";
import { request, errorMessage } from "../../client/http.ts";
import { displayPath, loadSettings } from "../../shared/settings.ts";

// Fire and forget: the reply does not matter, and failures surface on the stream.
const discard = (path: string, init: RequestInit) => void request(path, init).then(r => r.body?.cancel()).catch(() => {});

export const remoteStream: StreamFunction<string, SimpleStreamOptions> = (model, context, options) => {
  const stream = createAssistantMessageEventStream();
  const id = randomUUID();
  const signal = options?.signal;
  const toolJson = new Map<number, string>();
  let partial: AssistantMessage = {
    role: "assistant", provider: providerId, api, model: model.id, content: [], timestamp: Date.now(), stopReason: "pending",
    usage: {input:0, output:0, cacheRead:0, cacheWrite:0, totalTokens:0, cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
  };
  // Heartbeats are independent of model output: a model may think for many minutes
  // without a token, while C still beats. Silence from C, heartbeats included, means
  // the connection or C itself is gone, and A gives the request up after the timeout.
  const watchdog = new AbortController();
  let lost = "";
  let silence: NodeJS.Timeout | undefined;
  let beating: NodeJS.Timeout | undefined;
  void (async () => {
    try {
      const res = await request("/v1/requests", {method: "POST", body: JSON.stringify({id, model: model.id, context, options: generationOptions(options)}),
        signal: signal ? AbortSignal.any([signal, watchdog.signal]) : watchdog.signal});
      const interval = Number(res.headers.get(header.interval));
      const timeout = Number(res.headers.get(header.timeout));
      if (!res.body || !(interval > 0) || !(timeout > interval)) throw new Error(messages.malformed);
      let heard = Date.now();
      let last: Heartbeat | undefined;
      silence = setTimeout(() => {
        lost = heartbeatLost(Date.now() - heard, last);
        watchdog.abort();
        // C may still be reachable over a fresh connection: ask it to stop at once.
        discard("/v1/requests/" + id, {method: "DELETE", signal: AbortSignal.timeout(5000)});
      }, timeout);
      // A's own heartbeat lets C notice when A is gone and stop Claude.
      beating = setInterval(() => {
        discard("/v1/requests/" + id + "/heartbeat", {method: "POST", signal: AbortSignal.timeout(interval)});
      }, interval);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      try {
        while (true) {
          const chunk = await reader.read().catch(() => { throw new Error(messages.interrupted); });
          if (chunk.done) throw new Error(messages.interrupted);
          heard = Date.now();
          silence.refresh();
          buffer += chunk.value;
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            let frame;
            try { frame = JSON.parse(buffer.slice(0, newline)); } catch { throw new Error(messages.malformed); }
            buffer = buffer.slice(newline + 1);
            if (frame?.id !== id) throw new Error(messages.malformed);
            if (frame.type === "heartbeat") { last = frame; continue; }
            if (frame.type === "error") throw new Error(errorMessage(frame.code));
            const event = frame.event;
            if (frame.type === "done" && event?.type === "done") { stream.push(event); return; }
            if (frame.type !== "event" || !event) throw new Error(messages.malformed);
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
              default: throw new Error(messages.malformed);
            }
            stream.push({...event, partial});
          }
        }
      } finally { await reader.cancel().catch(() => {}); }
    } catch (error) {
      const reason = signal?.aborted ? "aborted" : "error";
      partial = {...partial, stopReason: reason, errorMessage: signal?.aborted ? messages.cancelled
        : lost || (error instanceof Error ? error.message : messages.interrupted)};
      stream.push({type:"error", reason, error:partial});
    } finally {
      clearTimeout(silence);
      clearInterval(beating);
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
    async fetchModels({signal}) { return (await request("/v1/models", {signal})).json(); },
    api: {stream: remoteStream, streamSimple: remoteStream},
  }));
  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "startup") return;
    try { if (!loadSettings().token) ctx.ui.notify(messages.token, "warning"); }
    catch (error) { ctx.ui.notify((error as Error).message, "error"); }
  });
  pi.registerCommand("a-tether-status", {
    description: "Check the connection to C and Claude Code login on C",
    handler: async (_args, ctx) => {
      try {
        const health = await (await request("/v1/health", {signal:ctx.signal})).json();
        ctx.ui.notify(health.loggedIn ? "C 上的 Claude Code 已登录" : health.diagnostic ? messages.backend : health.available ? messages.login : messages.unavailable, health.loggedIn ? "info" : "error");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : messages.connection, "error"); }
    },
  });
}
