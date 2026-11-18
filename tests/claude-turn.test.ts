import test from "node:test";
import assert from "node:assert/strict";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {normalizeContext} from "@earendil-works/pi-ai";
import {streamClaudeCode} from "../src/backends/claude-code/claude-turn.ts";
import {api, defaultUrl, providerId} from "../src/shared/protocol.ts";
import {useHome, writeSettings} from "./helpers.ts";

test("final-only CLI output preserves text, original tool names and selected route",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"tether-final-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const command=join(dir,"cli.mjs");
  await writeFile(command,`#!/usr/bin/env node
import {createInterface} from "node:readline";
const arg = name => process.argv[process.argv.indexOf(name)+1];
if(arg("--model")!=="test[1m]") process.exit(2);
if(JSON.parse(arg("--mcp-config")).mcpServers.tether.type!=="sdk") process.exit(4);
console.log(JSON.stringify({type:"control_request",request_id:"list",request:{subtype:"mcp_message",server_name:"tether",message:{jsonrpc:"2.0",id:1,method:"tools/list"}}}));
let tools;
for await(const line of createInterface({input:process.stdin})) {
  const frame=JSON.parse(line);
  if(frame.type==="control_response"&&frame.response.request_id==="list") { tools=frame.response.response.mcp_response.result.tools; break; }
}
if(tools[0].name===tools[1].name) process.exit(3);
for(const item of [
  {type:"assistant", message:{id:"response",content:[
    {type:"text",text:"final text"},
    {type:"tool_use",name:"mcp__tether__"+tools[0].name,id:"call",input:{value:42}}
  ]}},
  {type:"result",subtype:"error_max_turns",is_error:true}
]) console.log(JSON.stringify(item));
`,{mode:0o700});
  useHome(t,dir);
  await writeSettings(dir,{server:{claude:command}});
  const context=normalizeContext({tools:["bad.name","tool_0"].map(name=>({name,description:name,parameters:{type:"object"}})),
    messages:[{role:"user",content:"test",timestamp:0}]});
  const stream=streamClaudeCode({id:"test",name:"test",api,provider:providerId,baseUrl:defaultUrl,
    maxTokens:256,contextWindow:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},reasoning:false,input:["text"]},
    context,{},"test[1m]");
  const events=[];
  for await(const event of stream) events.push(event.type);
  const message=await stream.result();
  assert.equal(message.stopReason,"toolUse",message.errorMessage);
  assert.deepEqual(events,["start","text_start","text_delta","text_end","toolcall_start","toolcall_end","done"]);
  assert.deepEqual(message.content,[{type:"text",text:"final text"},{type:"toolCall",name:"bad.name",id:"call",arguments:{value:42}}]);
});

test("usage credits stop a turn unless server.allowUsageCredits is true",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"tether-credits-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const command=join(dir,"cli.mjs");
  await writeFile(command,`#!/usr/bin/env node
for(const item of [
  {type:"rate_limit_event", rate_limit_info:{isUsingOverage:true}},
  {type:"assistant", message:{id:"response",content:[{type:"text",text:"paid answer"}]}},
  {type:"result",subtype:"success",is_error:false}
]) console.log(JSON.stringify(item));
`,{mode:0o700});
  useHome(t,dir);
  const model={id:"test",name:"test",api,provider:providerId,baseUrl:defaultUrl,
    maxTokens:256,contextWindow:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},reasoning:false,input:["text"] as ["text"]};
  const context=normalizeContext({messages:[{role:"user",content:"test",timestamp:0}]});
  const run=async()=>{ const stream=streamClaudeCode(model,context,{}); for await(const _ of stream); return stream.result(); };
  await writeSettings(dir,{server:{claude:command}});
  const stopped=await run();
  assert.equal(stopped.stopReason,"error");
  assert.match(stopped.errorMessage!,/billing limit/);
  await writeSettings(dir,{server:{claude:command,allowUsageCredits:true}});
  const allowed=await run();
  assert.equal(allowed.stopReason,"stop",allowed.errorMessage);
  assert.deepEqual(allowed.content,[{type:"text",text:"paid answer"}]);
});

test("history uses MCP tool names, and bare or unknown tool calls reach Pi instead of failing the turn",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"tether-names-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const command=join(dir,"cli.mjs");
  await writeFile(command,`#!/usr/bin/env node
import {createInterface} from "node:readline";
let first;
for await(const line of createInterface({input:process.stdin})) { first=line; break; }
const history=JSON.parse(first).message.content.map(b=>b.text ? JSON.parse(b.text) : b);
const names=history.flatMap(r=>[r.name,...(Array.isArray(r.content) ? r.content.map(c=>c.name) : [])]).filter(Boolean);
if(names.join()!=="mcp__tether__bash,mcp__tether__bash") process.exit(4);
for(const item of [
  {type:"assistant", message:{id:"response",content:[
    {type:"tool_use",name:"bash",id:"bare",input:{command:"ls"}},
    {type:"tool_use",name:"Edit",id:"unknown",input:"not an object"}
  ]}},
  {type:"result",subtype:"error_max_turns",is_error:true}
]) console.log(JSON.stringify(item));
`,{mode:0o700});
  useHome(t,dir);
  await writeSettings(dir,{server:{claude:command}});
  const context=normalizeContext({tools:[{name:"bash",description:"bash",parameters:{type:"object"}}],messages:[
    {role:"user",content:"list",timestamp:0},
    {role:"assistant",content:[{type:"toolCall",id:"old",name:"bash",arguments:{command:"pwd"}}],api,provider:providerId,model:"test",
      usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:"toolUse",timestamp:0},
    {role:"toolResult",toolCallId:"old",toolName:"bash",content:[{type:"text",text:"/"}],isError:false,timestamp:0},
  ]});
  const stream=streamClaudeCode({id:"test",name:"test",api,provider:providerId,baseUrl:defaultUrl,
    maxTokens:256,contextWindow:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},reasoning:false,input:["text"]},context,{});
  for await(const _ of stream);
  const message=await stream.result();
  assert.equal(message.stopReason,"toolUse",message.errorMessage);
  assert.deepEqual(message.content,[
    {type:"toolCall",id:"bare",name:"bash",arguments:{command:"ls"}},
    {type:"toolCall",id:"unknown",name:"Edit",arguments:{}},
  ]);
});

test("a login token in Claude's own settings.json reaches the isolated CLI",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"tether-oauth-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  for(const key of ["CLAUDE_CODE_OAUTH_TOKEN","CLAUDE_CONFIG_DIR"]) {
    const previous=process.env[key];
    delete process.env[key];
    t.after(()=>{ if(previous!==undefined) process.env[key]=previous; });
  }
  const command=join(dir,"cli.mjs");
  await writeFile(command,`#!/usr/bin/env node
const text=process.env.CLAUDE_CODE_OAUTH_TOKEN==="from-settings" ? "token ok" : "Not logged in";
for(const item of [
  {type:"assistant", message:{id:"response",content:[{type:"text",text}]}},
  {type:"result",subtype:"success",is_error:false}
]) console.log(JSON.stringify(item));
`,{mode:0o700});
  useHome(t,dir);
  await writeSettings(dir,{server:{claude:command}});
  await mkdir(join(dir,".claude"));
  await writeFile(join(dir,".claude","settings.json"),JSON.stringify({env:{CLAUDE_CODE_OAUTH_TOKEN:"from-settings"}}));
  const stream=streamClaudeCode({id:"test",name:"test",api,provider:providerId,baseUrl:defaultUrl,
    maxTokens:256,contextWindow:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},reasoning:false,input:["text"]},
    normalizeContext({messages:[{role:"user",content:"test",timestamp:0}]}),{});
  for await(const _ of stream);
  const message=await stream.result();
  assert.deepEqual(message.content,[{type:"text",text:"token ok"}],message.errorMessage);
});
