import {calculateCost, createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools,
  type AssistantMessage, type Model, type SimpleStreamOptions, type TranscriptContext} from "@earendil-works/pi-ai";
import {LiveClaude, admit, reuse, type End, type Input, type Segment} from "./live.ts";
import {messageKey, normalizeMessages, transcript} from "./transcript.ts";
import {loadSettings} from "../../shared/settings.ts";

// Claude Code adds an Environment section about C (its temporary directory, OS, date)
// even with a replaced system prompt; without this note the model mistakes it for A.
const instructions = "You are the assistant in a Pi conversation. Pi runs on computer A, executes the tether tools there and returns their results. " +
  "When a user message holds JSON records, they are the earlier conversation in chronological order: continue from the last record. " +
  "The Environment section of this prompt describes the machine that hosts this model process, not computer A. " +
  "For paths, the working directory and the platform, follow Pi's instructions, such as its <cwd>.";

export function streamClaudeCode(model:Model<string>, context:TranscriptContext, options:SimpleStreamOptions, route = model.id) {
  const stream = createAssistantMessageEventStream();
  const message:AssistantMessage = {role:"assistant",api:model.api,provider:model.provider,model:model.id,
    timestamp:Date.now(),content:[],stopReason:"pending",
    usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  async function generate() {
    const {allowUsageCredits, claude} = loadSettings().server;
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
    const claudeNames = new Map(tools.map((tool,i)=>[tool.name,"mcp__tether__"+catalog[i].name]));
    const known = new Map(catalog.map((tool,i)=>["mcp__tether__"+tool.name,tools[i].name]));
    // A model sometimes drops the MCP prefix. Map bare names back as well; any other
    // name goes to Pi unchanged, which answers it with a "not found" tool result.
    const names = new Map([...tools.flatMap((tool,i)=>[[tool.name,tool.name],[catalog[i].name,tool.name]] as const),...known]);
    const conversation = normalizeMessages(context.messages);
    const keys = conversation.map(messageKey);
    const spec = {command:claude, route, system:getCurrentSystemPrompt(context.messages)+"\n\n"+instructions,
      effort:options.reasoning ? (options.reasoning==="minimal" ? "low" : options.reasoning) : undefined,
      maxTokens:options.maxTokens, tools:catalog};
    options.signal?.throwIfAborted();
    let lease = reuse(spec,keys,conversation);
    if (lease?.toolsChanged) {
      try { await lease.live.setTools(catalog); }
      catch { lease.live.kill(); lease = undefined; }
    }
    const live = lease?.live ?? await LiveClaude.start(spec,admit());
    const input:Input = lease?.input ?? {kind:"user",content:transcript(conversation,name=>claudeNames.get(name) ?? name)};
    stream.push({type:"start",partial:message});
    try { await live.run(input,translate(),options.signal); }
    catch (error) { live.kill(error); throw error; }
    live.release([...keys,messageKey(message)]);

    // One request's share of the CLI output: a single model call, which ends at its
    // message_stop. Streams that bring only final messages end at the first tool call
    // or the turn's result.
    function translate():Segment {
      let stopReason = "";
      let cliError = "";
      let started = false;
      let hasAssistant = false;
      let usageFinal = false;
      let diverged = false;
      const callsSeen = new Set<string>();
      const positions = new Map<number,number>();
      const pendingFinal: number[] = [];
      const calls = () => message.content.flatMap(b=>b.type==="toolCall" ? [b.id] : []);
      function usage(u:any) {
        Object.assign(message.usage,{input:u.input_tokens ?? 0,output:u.output_tokens ?? 0,
          cacheRead:u.cache_read_input_tokens ?? 0,cacheWrite:u.cache_creation_input_tokens ?? 0});
        const {input,output,cacheRead,cacheWrite} = message.usage;
        message.usage.totalTokens = input+output+cacheRead+cacheWrite;
        calculateCost(model,message.usage);
      }
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
      // turnOver: the CLI already ended its turn, so it will not wait for tool results.
      function finish(turnOver:boolean):End {
        if (pendingFinal.length) throw new Error("Claude did not finish");
        if (cliError) throw new Error(cliError);
        if (stopReason === "refusal") throw new Error("Claude refused this request");
        const ids = calls();
        message.stopReason = stopReason === "max_tokens" ? "length" : ids.length ? "toolUse" : "stop";
        if (ids.length && message.stopReason === "toolUse" && !turnOver) return {state:"awaitingTools",pending:ids};
        if (ids.length) diverged = true;
        return turnOver ? {state:"idle"} : {state:"finishing"};
      }
      return {
        get diverged() { return diverged; },
        onToolCall() { return !started && calls().length ? finish(false) : undefined; },
        onEvent(envelope:any) {
          if (envelope.parent_tool_use_id) return;
          if (envelope.type === "stream_event") {
            const e = envelope.event;
            if (e.type === "message_start") {
              // Each request covers one model call; a second means the CLI went on alone.
              if (started) throw new Error("Claude continued without Pi");
              started = true;
              message.responseId = e.message?.id ?? message.responseId;
              return;
            }
            if (e.type === "message_delta") {
              stopReason = e.delta?.stop_reason || stopReason;
              if (e.usage) { usage(e.usage); usageFinal = true; }
              return;
            }
            if (e.type === "message_stop") return finish(false);
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
            message.responseId ??= envelope.message.id;
            stopReason = envelope.message.stop_reason || stopReason;
            if (!usageFinal && envelope.message.usage) usage(envelope.message.usage);
            for (const b of envelope.message.content) {
              if (b.type === "text") { finishText("text",b.text); continue; }
              if (b.type === "thinking") { finishText("thinking",b.thinking,b.signature); continue; }
              if (b.type === "redacted_thinking") { finishText("thinking","",b.data,true); continue; }
              if (b.type !== "tool_use") continue;
              if (typeof b.id !== "string" || typeof b.name !== "string") throw new Error("Invalid tool call");
              if (callsSeen.has(b.id)) continue;
              callsSeen.add(b.id);
              // The CLI answers a name it does not list by itself and carries on.
              if (!known.has(b.name)) diverged = true;
              // Pi owns the tools: it rejects unknown names and validates arguments,
              // and the model corrects itself on the next turn.
              const name = names.get(b.name) ?? b.name;
              const input = b.input && typeof b.input === "object" && !Array.isArray(b.input) ? b.input : {};
              const toolCall = {type:"toolCall" as const,id:b.id,name,arguments:input};
              const i = message.content.push(toolCall)-1;
              stream.push({type:"toolcall_start",contentIndex:i,partial:message});
              stream.push({type:"toolcall_end",contentIndex:i,toolCall,partial:message});
            }
          } else if (envelope.type === "result") {
            const completed = envelope.subtype==="success" && !envelope.is_error || calls().length && envelope.subtype==="error_max_turns";
            stopReason = envelope.stop_reason || stopReason;
            if (!completed) throw new Error([cliError, JSON.stringify(envelope.errors || envelope.result)].filter(Boolean).join("; "));
            if (!usageFinal && envelope.usage) usage(envelope.usage);
            if (!hasAssistant) throw new Error("Claude did not finish");
            return finish(true);
          } else if (envelope.type === "rate_limit_event" && envelope.rate_limit_info?.isUsingOverage && !allowUsageCredits) {
            throw new Error("Claude billing limit");
          }
        },
      };
    }
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
