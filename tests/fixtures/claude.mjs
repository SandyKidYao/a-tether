#!/usr/bin/env node
// Offline process fixture. Generation waits until the server terminates it.
import {createInterface} from "node:readline";
import {writeFileSync} from "node:fs";
import {dirname} from "node:path";

if (process.argv.includes("auth")) {
  console.log(JSON.stringify({loggedIn:true}));
  process.exit(0);
}
for await (const line of createInterface({input:process.stdin})) {
  const frame = JSON.parse(line);
  if (frame.type === "control_request") {
    console.log(JSON.stringify({type:"control_response", response:{
      subtype:"success", request_id:frame.request_id,
      response:{models:[{value:"default",displayName:"Default",description:"Test model"}]},
    }}));
  } else if (process.argv.includes("--system-prompt-file")) {
    setInterval(() => {}, 60_000);
    const arg = name => process.argv[process.argv.indexOf(name) + 1];
    writeFileSync(process.env.TEST_WORKER, JSON.stringify({
      pid:process.pid, cwd:process.cwd(), temp:dirname(arg("--system-prompt-file")),
      tools:arg("--tools"), serviceToken:!!process.env.A_TETHER_TOKEN,
    }));
  }
}
