import {spawn} from "node:child_process";
import {createInterface} from "node:readline";
import {randomUUID} from "node:crypto";
import {getBuiltinModels} from "@earendil-works/pi-ai/providers/all";
import {api, providerId, defaultUrl} from "../../shared/protocol.ts";

export const isolated = ["-p", "--tools", "", "--setting-sources", "", "--strict-mcp-config",
  "--settings", JSON.stringify({disableAllHooks:true}), "--disable-slash-commands", "--no-session-persistence", "--permission-mode", "dontAsk"];
export const streaming = ["--verbose", "--input-format", "stream-json", "--output-format", "stream-json"];

type ProcessOptions = {signal?: AbortSignal; cwd?: string; env?: NodeJS.ProcessEnv; input?: string; onLine(line:string):void};
export async function invoke(args:string[], options:ProcessOptions) {
  const {signal} = options;
  signal?.throwIfAborted();
  const env = {...process.env, ...options.env};
  const command = env.A_TETHER_CLAUDE || env.PI_CLAUDE_CODE_COMMAND || "claude";
  delete env.ANTHROPIC_API_KEY;
  delete env.A_TETHER_TOKEN;
  if (env.ANTHROPIC_BASE_URL || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_FOUNDRY_API_KEY ||
      ["CLAUDE_CODE_USE_BEDROCK","CLAUDE_CODE_USE_VERTEX","CLAUDE_CODE_USE_FOUNDRY"].some(k=>env[k] && !["false","0"].includes(env[k]!))) {
    throw new Error("Conflicting backend configuration");
  }
  if (env.PI_CLAUDE_CODE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = env.PI_CLAUDE_CODE_CONFIG_DIR;
  Object.assign(env,{ENABLE_TOOL_SEARCH:"false", CLAUDE_CODE_DISABLE_FILE_MENTIONS:"1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY:"1", CLAUDE_CODE_DISABLE_CLAUDE_MDS:"1", DISABLE_AUTOUPDATER:"1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:"1", DISABLE_TELEMETRY:"1"});
  const child = spawn(command,args,{cwd:options.cwd,env,detached:process.platform!=="win32",windowsHide:true,
    stdio:["pipe","pipe","ignore"]});
  const closed = new Promise<number>((resolve,reject)=>{
    child.once("error",reject);
    child.once("close",code=>resolve(code ?? -1));
  });
  const stop = () => {
    if (!child.pid) return;
    if (process.platform === "win32") {
      if (child.exitCode !== null || child.signalCode !== null) return;
      spawn("taskkill",["/pid",String(child.pid),"/t","/f"],{stdio:"ignore",windowsHide:true}).on("error",()=>child.kill());
    } else {
      try { process.kill(-child.pid,"SIGKILL"); } catch { child.kill(); }
    }
  };
  // A CLI launcher can exit while an MCP descendant still owns its pipes.
  if (process.platform !== "win32") child.once("exit",stop);
  signal?.addEventListener("abort",stop,{once:true});
  const lines = createInterface({input:child.stdout,crlfDelay:Infinity});
  child.stdin.on("error",()=>{}); // A short-lived CLI can exit before consuming stdin.
  try {
    child.stdin.end(options.input);
    const output = (async () => { for await (const line of lines) options.onLine(line); })();
    const [code] = await Promise.all([closed,output]);
    signal?.throwIfAborted();
    return code;
  } finally {
    stop();
    await closed.catch(()=>{});
    lines.close();
    signal?.removeEventListener("abort",stop);
  }
}

function deadline(signal?:AbortSignal) {
  const timeout = AbortSignal.timeout(20000);
  return signal ? AbortSignal.any([signal,timeout]) : timeout;
}
export async function getClaudeStatus(env:NodeJS.ProcessEnv, signal?:AbortSignal) {
  let data = "";
  try {
    await invoke(["auth","status"],{env,signal:deadline(signal),onLine:line=>{data=(data+line).slice(-65536);}});
    const status = JSON.parse(data);
    return {available:true,loggedIn:status.loggedIn===true,diagnostic:typeof status.loggedIn!=="boolean"};
  } catch (error) {
    signal?.throwIfAborted();
    const available = (error as NodeJS.ErrnoException).code !== "ENOENT";
    return {available,loggedIn:false,diagnostic:available};
  }
}
export async function discoverClaudeModels(env:NodeJS.ProcessEnv, signal?:AbortSignal) {
  const request_id = randomUUID();
  const models = new Map<string,ReturnType<typeof modelEntry>>();
  const input = JSON.stringify({type:"control_request",request_id,request:{subtype:"initialize"}})+"\n";
  const code = await invoke([...isolated,...streaming,"--mcp-config",'{"mcpServers":{}}'],{
    env,signal:deadline(signal),input,onLine(line) {
      const event = JSON.parse(line);
      const reply = event.response;
      if (event.type !== "control_response" || reply?.request_id !== request_id || reply.subtype !== "success") return;
      for (const row of reply.response.models) {
        if (typeof row.value !== "string" || typeof row.displayName !== "string") continue;
        const model = modelEntry(row);
        models.set(model.id,model);
      }
    },
  });
  if (code || !models.size) throw new Error("Model discovery failed");
  return [...models.values()];
}
function modelEntry(row:{value:string; resolvedModel?:string; displayName:string; supportsEffort?:boolean}) {
  const resolved = (row.resolvedModel || row.value).replace(/\[1m\]$/i,"");
  const id = row.value === "default" ? "default" : resolved;
  const known = getBuiltinModels("anthropic").find(m=>m.id===resolved);
  return {id, route:row.value, name:row.displayName, api, provider:providerId, baseUrl:defaultUrl,
    cost:known?.cost ?? {input:0,output:0,cacheRead:0,cacheWrite:0}, reasoning:row.supportsEffort ?? known?.reasoning ?? false,
    contextWindow:row.resolvedModel?.endsWith("[1m]") ? 1000000 : known?.contextWindow ?? 200000,
    maxTokens:known?.maxTokens ?? 64000, input:["text","image"] as ("text"|"image")[]};
}
