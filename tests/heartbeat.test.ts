import assert from "node:assert/strict";
import test from "node:test";
import {spawn} from "node:child_process";
import {randomUUID} from "node:crypto";
import {once} from "node:events";
import {existsSync} from "node:fs";
import {createServer as createHttpServer, type ServerResponse} from "node:http";
import {createServer} from "node:net";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {setTimeout as delay} from "node:timers/promises";
import {isRetryableAssistantError, normalizeContext, type AssistantMessage} from "@earendil-works/pi-ai";
import {remoteStream} from "../src/frontends/pi/extension.ts";
import {header, heartbeatLost, messages, protocol} from "../src/shared/protocol.ts";
import {useHome, writeSettings} from "./helpers.ts";

const token = "h".repeat(64);
const context = normalizeContext({messages: [{role: "user", content: "hi", timestamp: 0}]});
const model = {id: "default", api: "a-tether-v1", provider: "a-tether"} as any;
const failed = (errorMessage: string) => ({stopReason: "error", errorMessage} as AssistantMessage);

async function home(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "a-tether-heartbeat-"));
  t.after(() => rm(dir, {recursive: true, force: true}));
  useHome(t, dir);
  return dir;
}

// A stand-in C that speaks the protocol headers and lets each test script the stream.
async function fakeC(t: test.TestContext, dir: string, onStream: (res: ServerResponse, id: string) => void, withProtocol = true) {
  const seen: string[] = [];
  const server = createHttpServer(async (req, res) => {
    seen.push(req.method + " " + req.url);
    let body = "";
    for await (const chunk of req) body += chunk;
    const base = withProtocol ? {[header.protocol]: protocol} : {};
    if (req.method === "POST" && req.url === "/v1/requests") {
      res.writeHead(200, {...base, "content-type": "application/x-ndjson", [header.interval]: "200", [header.timeout]: "600"});
      res.flushHeaders();
      return onStream(res, JSON.parse(body).id);
    }
    res.writeHead(200, {...base, "content-type": "application/json"}).end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await writeSettings(dir, {token, client: {url: "http://127.0.0.1:" + (server.address() as {port: number}).port}});
  return seen;
}

test("transport failures are worded so Pi retries them, other failures are not", () => {
  for (const text of [messages.connection, messages.interrupted, messages.lost, heartbeatLost(31_000),
    heartbeatLost(31_000, {seq: 3, elapsed: 290_000, modelIdle: 280_000, clientIdle: 4_000})]) {
    assert.ok(isRetryableAssistantError(failed(text)), text);
  }
  for (const text of [messages.version, messages.malformed, messages.unauthorized, messages.cancelled, messages.invalid]) {
    assert.ok(!isRetryableAssistantError(failed(text)), text);
  }
  assert.match(heartbeatLost(31_000, {seq: 3, elapsed: 290_000, modelIdle: 280_000, clientIdle: 4_000}),
    /31 秒.*运行 290 秒.*模型 280 秒没有输出.*C 4 秒前/);
});

test("A refuses a C from another release", async t => {
  const dir = await home(t);
  await fakeC(t, dir, res => res.end(), false);
  const final = await remoteStream(model, context, {}).result();
  assert.equal(final.stopReason, "error");
  assert.equal(final.errorMessage, messages.version);
});

test("a silent model is fine while C beats, and A beats back", async t => {
  const dir = await home(t);
  const seen = await fakeC(t, dir, async (res, id) => {
    await delay(20);
    // Twice the timeout with no model output, only heartbeats.
    for (let seq = 1; seq <= 12; seq++) {
      res.write(JSON.stringify({id, type: "heartbeat", seq, elapsed: seq * 100, modelIdle: seq * 100, clientIdle: 0}) + "\n");
      await delay(100);
    }
    const message = {role: "assistant", api: "a-tether-v1", provider: "a-tether", model: "default", content: [{type: "text", text: "OK"}],
      stopReason: "stop", timestamp: 0, usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}};
    res.end(JSON.stringify({id, type: "done", event: {type: "done", reason: "stop", message}}) + "\n");
  });
  const final = await remoteStream(model, context, {}).result();
  assert.equal(final.stopReason, "stop", final.errorMessage);
  assert.ok(seen.filter(s => /^POST \/v1\/requests\/[0-9a-f-]+\/heartbeat$/.test(s)).length >= 3, seen.join("\n"));
});

test("A gives up when C goes quiet, quotes the last heartbeat and asks C to stop", async t => {
  const dir = await home(t);
  const seen = await fakeC(t, dir, async (res, id) => {
    await delay(20);
    res.write(JSON.stringify({id, type: "heartbeat", seq: 1, elapsed: 5000, modelIdle: 4000, clientIdle: 1000}) + "\n");
    // Then nothing, as when the network drops packets without closing the socket.
  });
  const started = Date.now();
  const final = await remoteStream(model, context, {}).result();
  assert.equal(final.stopReason, "error");
  assert.match(final.errorMessage!, /connection lost.*运行 5 秒.*模型 4 秒没有输出.*C 1 秒前/);
  assert.ok(Date.now() - started < 3000);
  for (let i = 0; i < 50 && !seen.some(s => s.startsWith("DELETE ")); i++) await delay(20);
  assert.ok(seen.some(s => /^DELETE \/v1\/requests\/[0-9a-f-]+$/.test(s)), seen.join("\n"));
});

test("A reports a stream that ends without a terminal frame as interrupted", async t => {
  const dir = await home(t);
  await fakeC(t, dir, res => res.end());
  const final = await remoteStream(model, context, {}).result();
  assert.equal(final.errorMessage, messages.interrupted);
});

test("C beats while the model is silent and stops Claude when A stops beating", {timeout: 30000}, async t => {
  const dir = await mkdtemp(join(tmpdir(), "tether-lost-"));
  const worker = join(dir, "worker");
  const socket = createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = (socket.address() as {port: number}).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const url = "http://127.0.0.1:" + port;
  await writeSettings(dir, {token, server: {port, heartbeatInterval: 1, heartbeatTimeout: 2,
    claude: fileURLToPath(new URL("./fixtures/claude.mjs", import.meta.url))}});
  const child = spawn(process.execPath, ["--experimental-transform-types", "src/server.ts"], {
    env: {PATH: process.env.PATH, HOME: dir, TMPDIR: dir, TEST_WORKER: worker}, stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let logs = "";
  for (const output of [child.stdout, child.stderr]) output.on("data", data => { logs += data; });
  t.after(async () => { child.kill("SIGTERM"); await exited; await rm(dir, {recursive: true, force: true}); });
  for (let i = 0; i < 200 && !logs.includes("listening"); i++) await delay(30);
  const headers = {authorization: "Bearer " + token, [header.protocol]: protocol};
  const id = randomUUID();
  // The fixture Claude never answers. This client reads the stream but never beats.
  const res = await fetch(url + "/v1/requests", {method: "POST", headers, body: JSON.stringify({id, model: "default", context})});
  assert.equal(res.headers.get(header.interval), "1000");
  assert.equal(res.headers.get(header.timeout), "2000");
  const frames = (await res.text()).trim().split("\n").map(line => JSON.parse(line));
  const beats = frames.filter(f => f.type === "heartbeat");
  assert.ok(beats.length >= 1, JSON.stringify(frames));
  assert.deepEqual(beats.map(b => b.seq), beats.map((_, i) => i + 1));
  assert.ok(beats[0].clientIdle >= 900 && beats[0].modelIdle > 0, JSON.stringify(beats));
  assert.deepEqual(frames.at(-1), {id, type: "error", code: "lost"});
  for (let i = 0; i < 100 && !logs.includes(id.slice(0, 8)); i++) await delay(30);
  assert.match(logs, new RegExp(id.slice(0, 8) + " lost: no heartbeat from A for \\d+s"));
  const info = JSON.parse(await readFile(worker, "utf8"));
  for (let i = 0; i < 100 && existsSync(info.temp); i++) await delay(30);
  assert.throws(() => process.kill(info.pid, 0), {code: "ESRCH"});
  await rm(worker);

  // The same request with A beating outlives the timeout.
  const id2 = randomUUID();
  const controller = new AbortController();
  const res2 = await fetch(url + "/v1/requests", {method: "POST", headers, signal: controller.signal,
    body: JSON.stringify({id: id2, model: "default", context})});
  const beating = setInterval(() => void fetch(url + "/v1/requests/" + id2 + "/heartbeat", {method: "POST", headers}).then(r => r.text()), 500);
  t.after(() => clearInterval(beating));
  const reader = res2.body!.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  const until = Date.now() + 3500;
  while (Date.now() < until) {
    const chunk = await Promise.race([reader.read(), delay(until - Date.now()).then(() => undefined)]);
    if (!chunk || chunk.done) break;
    text += chunk.value;
  }
  clearInterval(beating);
  assert.ok(!text.includes('"type":"error"'), text);
  assert.ok((text.match(/"type":"heartbeat"/g) ?? []).length >= 3, text);
  controller.abort();
  // A heartbeat that arrives after its request ended gets 404 but leaves no log line,
  // while a malformed request still logs one.
  const late = await fetch(url + "/v1/requests/" + randomUUID() + "/heartbeat", {method: "POST", headers});
  assert.equal(late.status, 404);
  assert.deepEqual(await late.json(), {code: "invalid"});
  await fetch(url + "/v1/requests", {method: "POST", headers, body: "not json"}).then(r => r.text());
  for (let i = 0; i < 100 && !/-------- invalid/.test(logs); i++) await delay(30);
  await delay(200);
  assert.equal((logs.match(/-------- invalid/g) ?? []).length, 1, logs);
});
