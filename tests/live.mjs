// Opt-in: invokes the real remote Claude account through this machine's ~/.a-tether/settings.json
// (token and client.url) and the port forward to C.
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {spawn} from "node:child_process";
import {mkdtemp, mkdir, readFile, realpath, rm, writeFile} from "node:fs/promises";
import {homedir, tmpdir} from "node:os";
import {join} from "node:path";
import {createInterface} from "node:readline";
import {once} from "node:events";
import {fileURLToPath} from "node:url";

const settings = await readFile(join(homedir(),".a-tether","settings.json"),"utf8").catch(() => "{}");
if (!JSON.parse(settings).token) throw new Error("Run `npx -y @a-tether/pi login <token>` on this machine first");
const dir = await realpath(await mkdtemp(join(tmpdir(),"a-tether-live-")));
// Pi runs with HOME pointed at dir, so copy the settings there.
await mkdir(join(dir,".a-tether"),{mode:0o700});
await writeFile(join(dir,".a-tether","settings.json"),settings,{mode:0o600});
const project = join(dir,"project-A");
const root = fileURLToPath(new URL("../",import.meta.url));
await mkdir(project);
async function run(tools, prompt) {
  const args = [join(root,"node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
    "--offline","--no-session","--no-extensions","--no-skills","--no-context-files","--no-mcp","--no-approve",
    "-e",join(root,"src/frontends/pi/extension.ts"),"--model","a-tether/default","--mode","json","-p",
    ...(tools ? ["--tools",tools] : ["--no-tools"]),prompt];
  const child = spawn(process.execPath,args,{
    cwd:project,stdio:["ignore","pipe","inherit"],
    env:{PATH:process.env.PATH,HOME:dir,PI_CODING_AGENT_DIR:join(dir,"pi")},
  });
  const done = once(child,"close");
  const results = [];
  let final;
  let streamed = "";
  for await (const line of createInterface({input:child.stdout})) {
    const event = JSON.parse(line);
    if (event.type === "tool_execution_end") results.push(event);
    if (event.type === "message_end" && event.message.role === "assistant") final = event.message;
    if (event.assistantMessageEvent?.type === "text_delta") streamed += event.assistantMessageEvent.delta;
  }
  assert.equal((await done)[0],0,final?.errorMessage);
  assert.equal(final?.stopReason,"stop",final?.errorMessage);
  return {results,streamed,text:final.content.filter(b=>b.type==="text").map(b=>b.text).join("")};
}
try {
  const text = await run(null,"Reply with just these words: Tether stream ready.");
  assert(text.streamed.includes("Tether stream ready"));
  console.log("PASS Pi received Claude text_delta");
  const marker = randomBytes(12).toString("hex");
  const expected = "VERIFIED-" + marker;
  await writeFile(join(project,"marker.txt"),marker+"\n");
  const turn = await run("read,edit,bash",
    "Use the named tools exactly once each, sequentially. Use read on marker.txt. Use edit to prefix its exact random line with VERIFIED-. Use bash to run pwd and cat marker.txt. Reply with only the resulting line.");
  assert.deepEqual(turn.results.map(e=>e.toolName),["read","edit","bash"]);
  assert(turn.results.every(e=>!e.isError));
  assert(JSON.stringify(turn.results[0].result).includes(marker));
  assert.equal((await readFile(join(project,"marker.txt"),"utf8")).trim(),expected);
  const bash = JSON.stringify(turn.results[2].result);
  assert(bash.includes(project) && bash.includes(expected));
  assert(turn.text.includes(expected));
  console.log("PASS A read -> edit -> bash; cwd, edited file and final Claude answer match");
} finally {
  await rm(dir,{recursive:true,force:true});
}
