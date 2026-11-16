import assert from "node:assert/strict";
import test from "node:test";
import {spawn} from "node:child_process";
import {randomUUID} from "node:crypto";
import {once} from "node:events";
import {createServer} from "node:net";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {normalizeContext} from "@earendil-works/pi-ai";
import {backendCode} from "../src/backends/claude-code/index.ts";
import {getClaudeStatus} from "../src/backends/claude-code/claude-process.ts";
import {catalogCache, Failure} from "../src/server/http.ts";

test("backend errors are classified into specific codes", () => {
  assert.equal(backendCode('API Error: 529 {"type":"overloaded_error"}'), "overloaded");
  assert.equal(backendCode("API Error: 500 Internal server error"), "overloaded");
  assert.equal(backendCode("Prompt is too long"), "context");
  assert.equal(backendCode("authentication_failed"), "login");
  assert.equal(backendCode("Claude AI usage limit reached"), "quota");
  assert.equal(backendCode("Claude refused this request"), "backend");
});

test("catalog cache serves the last good catalog when a refresh fails transiently", async () => {
  let clock = 0;
  let fail: Failure | undefined;
  const stale: string[] = [];
  const signal = new AbortController().signal;
  const models = catalogCache(async () => { if (fail) throw fail; return ["m"]; }, d => stale.push(d), 100, 10, () => clock);
  assert.deepEqual(await models(signal), ["m"]);
  fail = new Failure(502, "backend", "status check failed: timed out");
  clock = 200;
  assert.deepEqual(await models(signal), ["m"]);
  assert.deepEqual(stale, ["status check failed: timed out"]);
  fail = new Failure(503, "login");
  clock = 300;
  await assert.rejects(models(signal), /login/, "non-transient failures still surface");
  const empty = catalogCache(async () => { throw new Failure(502, "discovery"); }, () => {});
  await assert.rejects(empty(signal), /discovery/, "no cached catalog to fall back on");
});

test("status diagnostics include the CLI exit code and stderr tail", async t => {
  const dir = await mkdtemp(join(tmpdir(), "tether-status-"));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const command = join(dir, "claude");
  await writeFile(command, "#!/bin/sh\necho 'boom from stderr' >&2\nexit 3\n", {mode: 0o700});
  const status = await getClaudeStatus({A_TETHER_CLAUDE: command});
  assert.equal(status.diagnostic, true);
  assert.match(status.detail!, /exit 3/);
  assert.match(status.detail!, /boom from stderr/);
});

test("C logs a redacted line when Claude Code fails", {timeout: 30000}, async t => {
  const dir = await mkdtemp(join(tmpdir(), "tether-log-"));
  const command = join(dir, "claude.mjs");
  await writeFile(command, `#!/usr/bin/env node
import {createInterface} from "node:readline";
if (process.argv.includes("auth")) { console.log(JSON.stringify({loggedIn:true})); process.exit(0); }
for await (const line of createInterface({input:process.stdin})) {
  const frame = JSON.parse(line);
  if (frame.type === "control_request") {
    console.log(JSON.stringify({type:"control_response",response:{subtype:"success",request_id:frame.request_id,
      response:{models:[{value:"default",displayName:"Default"}]}}}));
  } else {
    console.log("not json noise");
    console.error('API Error: 529 {"type":"overloaded_error"}');
    console.log(JSON.stringify({type:"result",subtype:"error_during_execution",is_error:true,errors:["Overloaded"]}));
    process.exit(1);
  }
}
`, {mode: 0o700});
  const socket = createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = (socket.address() as {port: number}).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const token = randomUUID();
  const child = spawn(process.execPath, ["--experimental-transform-types", "src/server.ts"], {
    env: {PATH: process.env.PATH, HOME: dir, TMPDIR: dir, A_TETHER_TOKEN: token, A_TETHER_PORT: String(port), A_TETHER_CLAUDE: command},
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let logs = "";
  for (const output of [child.stdout, child.stderr]) output.on("data", data => { logs += data; });
  t.after(async () => { child.kill("SIGTERM"); await exited; await rm(dir, {recursive: true, force: true}); });
  for (let i = 0; i < 200 && !logs.includes("listening"); i++) await delay(30);
  const marker = "secret-content-" + randomUUID();
  const id = randomUUID();
  const res = await fetch(`http://127.0.0.1:${port}/v1/requests`, {
    method: "POST", headers: {authorization: "Bearer " + token},
    body: JSON.stringify({id, model: "default", context: normalizeContext({messages: [{role: "user", content: marker, timestamp: 0}]})}),
  });
  assert.match(await res.text(), /"code":"overloaded"/);
  for (let i = 0; i < 100 && !logs.includes(id.slice(0, 8)); i++) await delay(30);
  const line = logs.split("\n").find(l => l.includes(id.slice(0, 8)))!;
  assert.match(line, /overloaded: .*Overloaded.*exit 1.*overloaded_error/);
  assert(!logs.includes(marker));
  assert(!logs.includes(token));
});
