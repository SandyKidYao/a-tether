import { randomUUID } from "node:crypto";
import { createProvider, createAssistantMessageEventStream, type AssistantMessage, type StreamFunction, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { api, defaultUrl, generationOptions, messages, providerId } from "../../shared/protocol.ts";
import { request, errorMessage } from "../../client/http.ts";

export const remoteStream: StreamFunction<string, SimpleStreamOptions> = (model, context, options) => {
  const stream = createAssistantMessageEventStream();
  const id = randomUUID();
  const signal = options?.signal;
  const toolJson = new Map<number, string>();
  let partial: AssistantMessage = {
    role: "assistant", provider: providerId, api, model: model.id, content: [], timestamp: Date.now(), stopReason: "pending",
    usage: {input:0, output:0, cacheRead:0, cacheWrite:0, totalTokens:0, cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
  };
  void (async () => {
    try {
      const res = await request("/v1/requests", {method: "POST", body: JSON.stringify({id, model: model.id, context, options: generationOptions(options)}), signal});
      if (!res.body) throw new Error(messages.connection);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      try {
        while (true) {
          const chunk = await reader.read().catch(() => { throw new Error(messages.connection); });
          if (chunk.done) throw new Error(messages.connection);
          buffer += chunk.value;
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const frame = JSON.parse(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
            if (frame.id !== id) throw new Error(messages.connection);
            if (frame.type === "error") throw new Error(errorMessage(frame.code));
            const event = frame.event;
            if (frame.type === "done" && event?.type === "done") { stream.push(event); return; }
            if (frame.type !== "event" || !event) throw new Error(messages.connection);
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
              default: throw new Error(messages.connection);
            }
            stream.push({...event, partial});
          }
        }
      } finally { await reader.cancel().catch(() => {}); }
    } catch (error) {
      const reason = signal?.aborted ? "aborted" : "error";
      partial = {...partial, stopReason: reason, errorMessage: signal?.aborted ? messages.cancelled : error instanceof Error ? error.message : messages.connection};
      stream.push({type:"error", reason, error:partial});
    } finally { stream.end(); }
  })();
  return stream;
};

export default function extension(pi: ExtensionAPI) {
  pi.registerProvider(createProvider({
    id: providerId, name: "A-tether · Remote Claude", baseUrl: defaultUrl,
    auth: {apiKey: {
      name: "A-tether token",
      async check() { return process.env.A_TETHER_TOKEN ? {type:"api_key", source:"A_TETHER_TOKEN"} : undefined; },
      async resolve() { return {auth:{apiKey:"a-tether"}, source:"A_TETHER_TOKEN"}; },
    }},
    models: [{ id:"default", name:"Default (C)", api, provider:providerId, baseUrl:defaultUrl, reasoning:true,
      input:["text","image"], contextWindow:200000, maxTokens:64000, cost:{input:0,output:0,cacheRead:0,cacheWrite:0} }],
    async fetchModels({signal}) { return (await request("/v1/models", {signal})).json(); },
    api: {stream: remoteStream, streamSimple: remoteStream},
  }));
  pi.registerCommand("a-tether-status", {
    description: "Check the SSH tunnel and Claude Code login on C",
    handler: async (_args, ctx) => {
      try {
        const health = await (await request("/v1/health", {signal:ctx.signal})).json();
        ctx.ui.notify(health.loggedIn ? "C 上的 Claude Code 已登录" : health.diagnostic ? messages.backend : health.available ? messages.login : messages.unavailable, health.loggedIn ? "info" : "error");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : messages.connection, "error"); }
    },
  });
}
