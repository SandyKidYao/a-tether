import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {fileURLToPath} from "node:url";
import {calculateCost, createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools,
  type AssistantMessage, type Model, type SimpleStreamOptions, type TranscriptContext} from "@earendil-works/pi-ai";
import {invoke, isolated, streaming} from "./claude-process.ts";

// Present the conversation in order, retaining call IDs and images. Do not forward
// provider diagnostics, local tool details, or session bookkeeping to Claude.
function userInput(context:TranscriptContext) {
  const blocks: unknown[] = [];
  for (const msg of context.messages) {
    if (msg.role === "system") continue;
    const parts = typeof msg.content === "string" ? [{type:"text" as const,text:msg.content}] : msg.content;
    const content = parts.flatMap((p):unknown[]=>{
      if (p.type === "image") return [{type:"image",attachment:true}];
      if (p.type === "thinking") return [];
      return [p];
    });
    const record = msg.role === "toolResult"
      ? {role:msg.role,toolCallId:msg.toolCallId,name:msg.toolName,isError:msg.isError,content}
      : {role:msg.role,content};
    blocks.push({type:"text",text:JSON.stringify(record)});
    for (const p of parts) if (p.type === "image") {
      blocks.push({type:"image",source:{type:"base64",media_type:p.mimeType,data:p.data}});
    }
  }
  return JSON.stringify({type:"user",message:{role:"user",content:blocks}})+"\n";
}

export function streamClaudeCode(model:Model<string>, context:TranscriptContext, options:SimpleStreamOptions, route = model.id) {
  const stream = createAssistantMessageEventStream();
  const message:AssistantMessage = {role:"assistant",api:model.api,provider:model.provider,model:model.id,
    timestamp:Date.now(),content:[],stopReason:"pending",
    usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  async function generate() {
    const tools = getCurrentTools(context.messages);
    const reserved = new Set(tools.map(tool => tool.name));
    function transportName(name:string,index:number) {
      if (/^[a-zA-Z0-9_-]{1,48}$/.test(name)) return name;
      let replacement = "tool_" + index;
      while (reserved.has(replacement)) replacement += "_";
      reserved.add(replacement);
      return replacement;
    }
    const catalog = tools.map((tool,index)=>({
      name:transportName(tool.name,index),
      description:tool.description,inputSchema:tool.parameters,
    }));
    const names = new Map(catalog.map((tool,i)=>["mcp__tether__"+tool.name,tools[i].name]));
    const dir = await mkdtemp(join(tmpdir(),"a-tether-turn-"));
    try {
      const file = join(dir,"catalog.json");
      const system = join(dir,"system.txt");
      await writeFile(file,JSON.stringify(catalog),{mode:0o600});
      const instructions = "You are the assistant in a Pi conversation. The input records represent the conversation in chronological order. Continue from the last record. Use the available tether tools for actions on computer A; Pi supplies their results on subsequent turns.";
      await writeFile(system,getCurrentSystemPrompt(context.messages)+"\n\n"+instructions,{mode:0o600});
      const servers = tools.length ? {tether:{command:process.execPath,args:[fileURLToPath(new URL("./tool-catalog.mjs",import.meta.url)),file]}} : {};
      const args = [...isolated,...streaming,"--include-partial-messages","--max-turns","1","--model",route,
        "--mcp-config",JSON.stringify({mcpServers:servers}),"--system-prompt-file",system];
      if (options.reasoning) args.push("--effort",options.reasoning==="minimal" ? "low" : options.reasoning);
      let completed = false;
      let stopReason = "";
      let cliError = "";
      let hasAssistant = false;
      const callsSeen = new Set<string>();
      const positions = new Map<number,number>();
      const pendingFinal: number[] = [];
      function finishText(kind:"thinking"|"text", text:string, signature?:string, redacted=false) {
        let i = pendingFinal.shift();
        if (i === undefined) {
          i = message.content.length;
          if (kind === "text") {
            message.content.push({type:"text",text:""});
            stream.push({type:"text_start",contentIndex:i,partial:message});
          } else {
            message.content.push({type:"thinking",thinking:"",redacted});
            stream.push({type:"thinking_start",contentIndex:i,partial:message});
          }
        }
        const b = message.content[i];
        if (b.type === "text" && kind === "text" && text.startsWith(b.text)) {
          const delta = text.slice(b.text.length);
          b.text = text;
          if (delta) stream.push({type:"text_delta",delta,contentIndex:i,partial:message});
          stream.push({type:"text_end",content:text,contentIndex:i,partial:message});
        } else if (b.type === "thinking" && kind === "thinking" && text.startsWith(b.thinking)) {
          const delta = text.slice(b.thinking.length);
          b.thinking = text;
          b.thinkingSignature = signature;
          if (delta) stream.push({type:"thinking_delta",delta,contentIndex:i,partial:message});
          stream.push({type:"thinking_end",content:text,contentIndex:i,partial:message});
        } else throw new Error("Claude final content differs from stream");
      }
      stream.push({type:"start",partial:message});
      const code = await invoke(args,{signal:options.signal,cwd:dir,input:userInput(context),
        env:options.maxTokens ? {CLAUDE_CODE_MAX_OUTPUT_TOKENS:String(options.maxTokens)} : {},onLine(line) {
          const envelope = JSON.parse(line);
          if (envelope.parent_tool_use_id) return;
          if (envelope.type === "stream_event") {
            const e = envelope.event;
            if (e.type === "content_block_start") {
              const b = e.content_block;
              const i = message.content.length;
              if (b.type === "text") {
                positions.set(e.index,i);
                pendingFinal.push(i);
                message.content.push({type:"text",text:b.text || ""});
                stream.push({type:"text_start",partial:message,contentIndex:i});
              } else if (b.type === "thinking") {
                positions.set(e.index,i);
                pendingFinal.push(i);
                message.content.push({type:"thinking",thinking:b.thinking || ""});
                stream.push({type:"thinking_start",partial:message,contentIndex:i});
              }
            }
            const i = positions.get(e.index);
            if (i === undefined) return;
            const b = message.content[i];
            if (e.type === "content_block_delta") {
              if (b.type === "text" && e.delta.type === "text_delta") {
                b.text += e.delta.text;
                stream.push({type:"text_delta",partial:message,contentIndex:i,delta:e.delta.text});
              }
              if (b.type === "thinking" && e.delta.type === "thinking_delta") {
                b.thinking += e.delta.thinking;
                stream.push({type:"thinking_delta",partial:message,contentIndex:i,delta:e.delta.thinking});
              }
            } else if (e.type === "content_block_stop") {
              positions.delete(e.index);
            }
          } else if (envelope.type === "assistant") {
            if (envelope.error) { cliError = String(envelope.error); return; }
            hasAssistant = true;
            message.responseId = envelope.message.id;
            stopReason = envelope.message.stop_reason || stopReason;
            for (const b of envelope.message.content) {
              if (b.type === "text") { finishText("text",b.text); continue; }
              if (b.type === "thinking") { finishText("thinking",b.thinking,b.signature); continue; }
              if (b.type === "redacted_thinking") { finishText("thinking","",b.data,true); continue; }
              if (b.type !== "tool_use") continue;
              const name = names.get(b.name);
              if (!name) throw new Error("Unexpected Claude tool");
              if (typeof b.id !== "string" || !b.input || typeof b.input !== "object" || Array.isArray(b.input)) throw new Error("Invalid tool call");
              if (callsSeen.has(b.id)) continue;
              callsSeen.add(b.id);
              const toolCall = {type:"toolCall" as const,id:b.id,name,arguments:b.input};
              const i = message.content.push(toolCall)-1;
              stream.push({type:"toolcall_start",contentIndex:i,partial:message});
              stream.push({type:"toolcall_end",contentIndex:i,toolCall,partial:message});
            }
          } else if (envelope.type === "result") {
            const calls = message.content.some(b=>b.type==="toolCall");
            completed = envelope.subtype==="success" && !envelope.is_error || calls && envelope.subtype==="error_max_turns";
            stopReason = envelope.stop_reason || stopReason;
            if (!completed && !cliError) cliError = JSON.stringify(envelope.errors || envelope.result);
            const u = envelope.usage ?? {};
            Object.assign(message.usage,{input:u.input_tokens ?? 0,output:u.output_tokens ?? 0,
              cacheRead:u.cache_read_input_tokens ?? 0,cacheWrite:u.cache_creation_input_tokens ?? 0});
            const {input,output,cacheRead,cacheWrite} = message.usage;
            message.usage.totalTokens = input+output+cacheRead+cacheWrite;
            calculateCost(model,message.usage);
          } else if (envelope.type === "rate_limit_event" && envelope.rate_limit_info?.isUsingOverage &&
              process.env.PI_CLAUDE_CODE_ALLOW_USAGE_CREDITS !== "1") {
            throw new Error("Claude billing limit");
          }
        }});
      const calls = message.content.some(b=>b.type==="toolCall");
      if (pendingFinal.length || !hasAssistant || !completed || cliError || (code && !calls)) throw new Error(cliError || "Claude did not finish");
      if (stopReason === "refusal") throw new Error("Claude refused this request");
      message.stopReason = stopReason === "max_tokens" ? "length" : calls ? "toolUse" : "stop";
    } finally { await rm(dir,{recursive:true,force:true}); }
  }
  void generate().then(()=>{
    stream.push({type:"done",reason:message.stopReason as "toolUse"|"length"|"stop",message});
  }).catch(error=>{
    const reason = options.signal?.aborted ? "aborted" : "error";
    message.stopReason=reason;
    message.errorMessage=error instanceof Error ? error.message : "Claude request failed";
    stream.push({type:"error",reason,error:message});
  }).finally(()=>stream.end());
  return stream;
}
