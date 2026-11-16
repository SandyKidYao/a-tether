// A read-only MCP catalog. The only supported operations are discovery and listing.
import {createInterface} from "node:readline";
import {readFile} from "node:fs/promises";
const tools = JSON.parse(await readFile(process.argv[2],"utf8"));
for await (const line of createInterface({input:process.stdin})) {
  const {id,method,params} = JSON.parse(line);
  if (id === undefined) continue;
  let result;
  if (method === "initialize") {
    result = {protocolVersion:params.protocolVersion,serverInfo:{name:"a-tether",version:"0.1.0"},capabilities:{tools:{}}};
  } else if (method === "tools/list") result = {tools};
  else if (method === "ping") result = {};
  const response = result ? {result} : {error:{code:-32601,message:"Tool execution belongs to Pi on A"}};
  process.stdout.write(JSON.stringify({jsonrpc:"2.0",id,...response})+"\n");
}
