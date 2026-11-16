import assert from "node:assert/strict";
import test from "node:test";
import {spawn} from "node:child_process";
import {randomUUID} from "node:crypto";
import {once} from "node:events";
import {createServer} from "node:net";
import {existsSync} from "node:fs";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {setTimeout as delay} from "node:timers/promises";
import {normalizeContext} from "@earendil-works/pi-ai";
import {remoteStream} from "../src/frontends/pi/extension.ts";
import {messages} from "../src/shared/protocol.ts";

async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await delay(30);
  }
  assert.fail("Timed out waiting for condition");
}

test("authenticated provider cancellation and disconnect reap C workers", {timeout:30000}, async t => {
  const dir = await mkdtemp(join(tmpdir(), "tether-test-"));
  const worker = join(dir, "worker");
  const socket = createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = (socket.address() as {port:number}).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const url = "http://127.0.0.1:" + port;
  const token = randomUUID();
  const marker = "project-content-" + randomUUID();
  const child = spawn(process.execPath, ["--experimental-transform-types", "src/server.ts"], {
    env:{PATH:process.env.PATH, HOME:dir, TMPDIR:dir, A_TETHER_TOKEN:token, A_TETHER_PORT:String(port),
      A_TETHER_CLAUDE:fileURLToPath(new URL("./fixtures/claude.mjs", import.meta.url)), TEST_WORKER:worker},
    stdio:["ignore","pipe","pipe"],
  });
  const exited = once(child,"exit");
  let logs = "";
  for (const output of [child.stdout,child.stderr]) output.on("data", data => {logs += data;});
  t.after(async () => {
    child.kill("SIGTERM");
    await exited;
    await rm(dir, {recursive:true,force:true});
  });
  const previous = [process.env.A_TETHER_URL, process.env.A_TETHER_TOKEN];
  process.env.A_TETHER_URL = url;
  process.env.A_TETHER_TOKEN = token;
  t.after(() => {
    for (const [i,key] of ["A_TETHER_URL","A_TETHER_TOKEN"].entries()) {
      if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i];
    }
  });
  await until(() => logs.includes("listening"));
  const headers = {authorization:"Bearer " + token};
  assert.equal((await fetch(url+"/v1/health")).status,401);
  const models = await (await fetch(url+"/v1/models",{headers})).json();
  const context = normalizeContext({messages:[{role:"user",content:marker,timestamp:Date.now()}]});
  let workingDir = "";
  for (const mode of ["cancel", "disconnect", "delete"]) {
    const controller = new AbortController();
    const id = randomUUID();
    const stream = mode === "cancel" ? remoteStream(models[0],context,{signal:controller.signal}) : undefined;
    const response = stream ? undefined : await fetch(url+"/v1/requests",{
      method:"POST", headers, body:JSON.stringify({id,model:"default",context}), signal:controller.signal,
    });
    await until(() => existsSync(worker));
    const info = JSON.parse(await readFile(worker,"utf8"));
    workingDir = info.cwd;
    assert.equal(info.tools,"");
    assert.equal(info.serviceToken,false);
    assert.notEqual(info.cwd,process.cwd());
    if (mode === "delete") {
      assert.equal((await fetch(url+"/v1/requests/"+id,{method:"DELETE",headers})).status,200);
      assert.match(await response!.text(),/"code":"cancelled"/);
    } else {
      controller.abort();
      if (stream) {
        const final = await stream.result();
        assert.equal(final.stopReason,"aborted");
        assert.equal(final.errorMessage,messages.cancelled);
      }
    }
    await until(() => !existsSync(info.temp));
    assert.throws(() => process.kill(info.pid,0),{code:"ESRCH"});
    await rm(worker);
  }
  child.kill("SIGTERM");
  await exited;
  assert.equal(existsSync(workingDir),false);
  assert(!logs.includes(token));
  assert(!logs.includes(marker));
});

test("broken CLI cannot crash model discovery", async t => {
  const {writeFile} = await import("node:fs/promises");
  const {discoverClaudeModels} = await import("../src/backends/claude-code/claude-process.ts");
  const dir = await mkdtemp(join(tmpdir(),"tether-invalid-"));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const command = join(dir,"claude");
  await writeFile(command,"#!/missing/a-tether-test-interpreter\n",{mode:0o700});
  await assert.rejects(discoverClaudeModels({A_TETHER_CLAUDE:command}), /ENOENT/);
});

test("stopping C during startup reaps the status process group and working directory", async t => {
  const {writeFile} = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(),"tether-startup-"));
  const command = join(dir,"slow-claude");
  await writeFile(command,'#!/bin/sh\nsleep 20 &\necho "$!" > "$TEST_PID"\npwd > "$TEST_CWD"\nwait\n',{mode:0o700});
  const child = spawn(process.execPath,["--experimental-transform-types","src/server.ts"],{
    env:{PATH:process.env.PATH,TMPDIR:dir,A_TETHER_TOKEN:randomUUID(),A_TETHER_CLAUDE:command,
      TEST_PID:join(dir,"pid"),TEST_CWD:join(dir,"cwd")},
    stdio:"ignore",
  });
  const exited = once(child,"exit");
  t.after(async () => {child.kill(); await exited; await rm(dir,{recursive:true,force:true});});
  await until(() => existsSync(join(dir,"cwd")));
  const pid = Number(await readFile(join(dir,"pid"),"utf8"));
  const cwd = (await readFile(join(dir,"cwd"),"utf8")).trim();
  child.kill();
  await exited;
  assert.throws(() => process.kill(pid,0),{code:"ESRCH"});
  assert.equal(existsSync(cwd),false);
});
