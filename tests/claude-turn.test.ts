import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {normalizeContext} from "@earendil-works/pi-ai";
import {streamClaudeCode} from "../src/backends/claude-code/claude-turn.ts";
import {api, defaultUrl, providerId} from "../src/shared/protocol.ts";

test("the MCP catalog can list a bash schema but cannot run it", async t=>{
  const dir=await mkdtemp(join(tmpdir(),"tether-schema-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,"tools.json");
  const schema={name:"bash",description:"A-local bash",inputSchema:{type:"object"}};
  await writeFile(file,JSON.stringify([schema]));
  const input=[
    {id:1,method:"tools/list"},
    {id:2,method:"tools/call",params:{name:"bash",arguments:{command:"pwd"}}},
  ].map(v=>JSON.stringify({jsonrpc:"2.0",...v})).join("\n")+"\n";
  const child=spawnSync(process.execPath,["src/backends/claude-code/tool-catalog.mjs",file],{input,encoding:"utf8"});
  assert.equal(child.status,0);
  const [listed,denied]=child.stdout.trim().split("\n").map(line=>JSON.parse(line));
  assert.deepEqual(listed.result.tools,[schema]);
  assert.equal(denied.error.code,-32601);
});

test("final-only CLI output preserves text, original tool names and selected route",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"tether-final-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const command=join(dir,"cli.mjs");
  await writeFile(command,`#!/usr/bin/env node
import {readFileSync} from "node:fs";
const arg = name => process.argv[process.argv.indexOf(name)+1];
if(arg("--model")!=="test[1m]") process.exit(2);
const config=JSON.parse(arg("--mcp-config"));
const tools=JSON.parse(readFileSync(config.mcpServers.tether.args[1],"utf8"));
if(tools[0].name===tools[1].name) process.exit(3);
for(const item of [
  {type:"assistant", message:{id:"response",content:[
    {type:"text",text:"final text"},
    {type:"tool_use",name:"mcp__tether__"+tools[0].name,id:"call",input:{value:42}}
  ]}},
  {type:"result",subtype:"error_max_turns",is_error:true}
]) console.log(JSON.stringify(item));
`,{mode:0o700});
  const previous=process.env.A_TETHER_CLAUDE;
  process.env.A_TETHER_CLAUDE=command;
  t.after(()=>{
    if(previous===undefined) delete process.env.A_TETHER_CLAUDE;
    else process.env.A_TETHER_CLAUDE=previous;
  });
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
