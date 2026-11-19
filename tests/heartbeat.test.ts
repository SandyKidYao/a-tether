import assert from "node:assert/strict";
import test from "node:test";
import {spawn} from "node:child_process";
import {randomUUID} from "node:crypto";
import {once} from "node:events";
import {existsSync, readFileSync} from "node:fs";
import {createServer as createHttpServer, type ServerResponse} from "node:http";
import {brotliDecompressSync} from "node:zlib";
import {createServer} from "node:net";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {setTimeout as delay} from "node:timers/promises";
import {isRetryableAssistantError, normalizeContext, type AssistantMessage} from "@earendil-works/pi-ai";
import {remoteStream} from "../src/frontends/pi/extension.ts";
import {foreignReply, header, heartbeatLost, isRef, messages, protocol, versionMismatch} from "../src/shared/protocol.ts";
import {Link, link} from "../src/client/link.ts";
import {version} from "../src/shared/version.ts";
import {useHome, writeSettings} from "./helpers.ts";

const token = "h".repeat(64);
const context = normalizeContext({messages: [{role: "user", content: "hi", timestamp: 0}]});
const usage = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}};
const reply = (text: string) => ({role: "assistant", api: "a-tether-v1", provider: "a-tether", model: "default", content: [{type: "text", text}],
  stopReason: "stop", timestamp: 0, usage});
const line = (frame: object) => JSON.stringify(frame) + "\n";
const done = (n: number, text: string) => line({n, type: "done", event: {type: "done", reason: "stop", message: reply(text)}});
const model = {id: "default", api: "a-tether-v1", provider: "a-tether"} as any;
const failed = (errorMessage: string) => ({stopReason: "error", errorMessage} as AssistantMessage);

async function home(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "a-tether-heartbeat-"));
  t.after(() => rm(dir, {recursive: true, force: true}));
  useHome(t, dir);
  return dir;
}

// A stand-in C that speaks the protocol headers and lets each test script a turn: what
// the first connection gets, and what a connection that attaches again gets. Without
// `events` it has never heard of the turn.
type Script = {
  start(res: ServerResponse, id: string, body: any): void;
  events?(res: ServerResponse, id: string, after: number): void;
};
const pings: any[] = [];
async function fakeC(t: test.TestContext, dir: string, script: Script, base: Record<string, string> = {[header.protocol]: protocol}) {
  const seen: string[] = [];
  pings.length = 0;
  const stream = {...base, "content-type": "application/x-ndjson", [header.interval]: "200", [header.timeout]: "600"};
  const server = createHttpServer(async (req, res) => {
    seen.push(req.method + " " + req.url);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const text = (req.headers["content-encoding"] === "br" ? brotliDecompressSync(raw) : raw).toString();
    const [, id, events] = /^\/v1\/turns\/([^/?]+)(\/events)?/.exec(req.url ?? "") ?? [];
    if (req.method === "POST" && id && !events) {
      res.writeHead(200, stream);
      res.flushHeaders();
      return script.start(res, id, JSON.parse(text));
    }
    if (req.method === "GET" && events) {
      if (!script.events) return void res.writeHead(404, {...base, "content-type": "application/json"}).end('{"code":"gone"}');
      res.writeHead(200, stream);
      res.flushHeaders();
      return script.events(res, id, Number(new URL(req.url!, "http://c").searchParams.get("after")));
    }
    if (req.url === "/v1/ping") pings.push(JSON.parse(text));
    res.writeHead(200, {...base, "content-type": "application/json", [header.interval]: "200", [header.timeout]: "600"})
      .end(req.url === "/v1/ping" ? '{"loggedIn":true,"turns":{}}' : "{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await writeSettings(dir, {token, client: {url: "http://127.0.0.1:" + (server.address() as {port: number}).port}});
  // What A assumes before C has told it: a short timeout keeps the tests short.
  link.interval = 200;
  link.timeout = 600;
  return seen;
}

test("transport failures are worded so Pi retries them, other failures are not", () => {
  const beat = {n: 3, elapsed: 290_000, modelIdle: 280_000, clientIdle: 4_000};
  for (const text of [messages.connection, messages.interrupted, messages.lost, messages.gone, messages.stalled, foreignReply(408),
    heartbeatLost(31_000), heartbeatLost(31_000, beat)]) {
    assert.ok(isRetryableAssistantError(failed(text)), text);
  }
  for (const text of [versionMismatch("0.4.0", "0.3.0", "3"), messages.malformed, messages.unauthorized, messages.cancelled, messages.invalid]) {
    assert.ok(!isRetryableAssistantError(failed(text)), text);
  }
  assert.match(heartbeatLost(31_000, beat), /31 秒.*运行 290 秒.*模型 280 秒没有输出.*C 4 秒前/);
});

test("A refuses a C from another release and names both versions", async t => {
  const dir = await home(t);
  await fakeC(t, dir, {start: res => res.end()}, {[header.protocol]: "3", [header.version]: "0.3.0"});
  const final = await remoteStream(model, context, {}).result();
  assert.equal(final.stopReason, "error");
  assert.equal(final.errorMessage, versionMismatch(version, "0.3.0", "3"));
  assert.match(final.errorMessage!, new RegExp(`A 是 ${version.replaceAll(".", "\\.")}（协议 ${protocol}），C 是 0\\.3\\.0（协议 3）`));
});

test("S9: a reply without the protocol header is a transport failure, not a version mismatch", async t => {
  const dir = await home(t);
  // What Node sends by itself when a request times out, and what a tunnel may send.
  const server = createHttpServer((req, res) => { req.resume(); res.writeHead(408, {connection: "close"}).end(); }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await writeSettings(dir, {token, client: {url: "http://127.0.0.1:" + (server.address() as {port: number}).port}});
  const final = await remoteStream(model, context, {}).result();
  assert.equal(final.errorMessage, foreignReply(408));
  assert.doesNotMatch(final.errorMessage!, /版本/);
  assert.ok(isRetryableAssistantError(final));
});

test("a refused connection fails at once instead of being retried for minutes", async t => {
  const dir = await home(t);
  const socket = createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = (socket.address() as {port: number}).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  await writeSettings(dir, {token, client: {url: "http://127.0.0.1:" + port}});
  link.timeout = 60_000;
  const started = Date.now();
  const final = await remoteStream(model, context, {}).result();
  assert.equal(final.errorMessage, messages.connection);
  assert.ok(Date.now() - started < 2000);
});

test("a silent model is fine while C beats, and A pings", async t => {
  const dir = await home(t);
  const seen = await fakeC(t, dir, {async start(res) {
    await delay(20);
    // Twice the timeout with no model output, only heartbeats.
    for (let i = 1; i <= 12; i++) {
      res.write(line({type: "heartbeat", n: 0, elapsed: i * 100, modelIdle: i * 100, clientIdle: 0}));
      await delay(100);
    }
    res.end(done(1, "OK"));
  }});
  // As in Pi, where the plugin keeps the link's pings going between requests.
  const own = new Link();
  own.start();
  t.after(() => own.stop());
  link.start();
  t.after(() => link.stop());
  const final = await remoteStream(model, context, {}).result();
  assert.equal(final.stopReason, "stop", final.errorMessage);
  assert.ok(seen.filter(s => s === "POST /v1/ping").length >= 3, seen.join("\n"));
  const during = pings.filter(ping => Object.keys(ping.turns ?? {}).length === 1);
  assert.ok(during.length >= 3, "the pings name the turn in flight");
  // Delivered: A tells C it may drop the turn, at once and again with a later ping.
  for (let i = 0; i < 50 && !seen.some(s => s.startsWith("DELETE ")); i++) await delay(20);
  const released = seen.find(s => /^DELETE \/v1\/turns\/[0-9a-f-]+$/.test(s));
  assert.ok(released, seen.join("\n"));
  for (let i = 0; i < 50 && !pings.some(ping => ping.released?.length); i++) await delay(20);
  const id = released.split("/").at(-1);
  for (let i = 0; i < 50 && !pings.some(ping => ping.released?.includes(id)); i++) await delay(20);
  assert.ok(pings.some(ping => ping.released?.includes(id)), JSON.stringify(pings));
  await delay(450);
  assert.ok(!pings.at(-1).released?.includes(id), "once a ping has carried it, it is not sent again");

  // One ping loop per link, at C's interval: tuning it from the default 10 s to 200 ms,
  // or stopping and starting it mid-ping, must not leave a second loop running.
  own.stop();
  own.start();
  const before = seen.filter(s => s === "POST /v1/ping").length;
  link.stop();
  await delay(1050);
  own.stop();
  const count = seen.filter(s => s === "POST /v1/ping").length - before;
  // Two loops would make about ten. A busy machine may fit fewer than five.
  assert.ok(count >= 3 && count <= 7, `${count} pings in a second at one every 200 ms`);
});

test("A continues after a broken connection where it left off", async t => {
  const dir = await home(t);
  const text = (n: number, delta: string) => line({n, type: "event", event: {type: "text_delta", contentIndex: 0, delta}});
  const seen = await fakeC(t, dir, {
    start(res) {
      res.write(line({n: 1, type: "event", event: {type: "start", partial: {...reply(""), content: []}}}));
      res.write(line({n: 2, type: "event", event: {type: "text_start", contentIndex: 0, block: {type: "text", text: ""}}}));
      res.write(text(3, "Hel"));
      // The connection dies mid-reply, as when a tunnel or an overlay network drops.
      setTimeout(() => res.destroy(), 50);
    },
    events(res, _id, after) {
      assert.equal(after, 3);
      // C may repeat a frame A already has; A applies each once.
      res.write(text(3, "Hel") + text(4, "lo"));
      res.write(line({n: 5, type: "event", event: {type: "text_end", contentIndex: 0, content: "Hello"}}));
      res.end(done(6, "Hello"));
    },
  });
  const stream = remoteStream(model, context, {});
  let deltas = "";
  for await (const event of stream) if (event.type === "text_delta") deltas += event.delta;
  const final = await stream.result();
  assert.equal(final.stopReason, "stop", final.errorMessage);
  assert.equal(deltas, "Hello", "no delta is applied twice or skipped");
  assert.deepEqual(final.content, [{type: "text", text: "Hello"}]);
  assert.ok(seen.some(s => /^GET \/v1\/turns\/[0-9a-f-]+\/events\?after=3$/.test(s)), seen.join("\n"));
});

test("A moves to a new connection when one goes quiet", async t => {
  const dir = await home(t);
  const seen = await fakeC(t, dir, {
    // Open but silent, not even a heartbeat: packets are lost without the socket closing.
    start() {},
    events(res) { res.end(done(1, "OK")); },
  });
  const started = Date.now();
  const final = await remoteStream(model, context, {}).result();
  assert.equal(final.stopReason, "stop", final.errorMessage);
  assert.ok(Date.now() - started >= 450, "it waits for more than two missed beats first");
  assert.ok(seen.some(s => s.includes("/events?after=0")), seen.join("\n"));
});

test("A gives up when C stays unreachable, quotes the last heartbeat and leaves the turn for a retry", async t => {
  const dir = await home(t);
  const seen = await fakeC(t, dir, {
    async start(res) {
      await delay(20);
      res.write(line({type: "heartbeat", n: 0, elapsed: 5000, modelIdle: 4000, clientIdle: 1000}));
    },
    events() {}, // never answers
  });
  const started = Date.now();
  const final = await remoteStream(model, context, {}).result();
  assert.equal(final.stopReason, "error");
  assert.match(final.errorMessage!, /connection lost.*运行 5 秒.*模型 4 秒没有输出.*C 1 秒前/);
  assert.ok(isRetryableAssistantError(final));
  assert.ok(Date.now() - started < 4000);
  await delay(300);
  // The turn may still finish on C; Pi's retry then gets it instead of a second one.
  assert.ok(!seen.some(s => s.startsWith("DELETE ")), seen.join("\n"));
});

test("a turn C no longer has is reported as gone", async t => {
  const dir = await home(t);
  await fakeC(t, dir, {start: res => res.end()});
  const final = await remoteStream(model, context, {}).result();
  assert.equal(final.errorMessage, messages.gone);
  assert.ok(isRetryableAssistantError(final));
});

test("S4/S5: A sends only what is new, and everything when C lacks the history", async t => {
  const dir = await home(t);
  const bodies: any[] = [];
  let refuse = false;
  await fakeC(t, dir, {start(res, _id, body) {
    bodies.push(body);
    if (refuse) { refuse = false; return void res.destroy(); }
    res.end(done(1, "first answer"));
  }});
  const first = [{role: "user", content: "question " + randomUUID(), timestamp: 0}] as const;
  const one = await remoteStream(model, normalizeContext({messages: [...first]}), {}).result();
  assert.equal(one.stopReason, "stop", one.errorMessage);
  assert.equal(bodies[0].context.base, undefined);
  assert.equal(bodies[0].context.add.length, 1);

  // The next turn: C's own reply is named, the history before it is a digest.
  const second = normalizeContext({messages: [...first, one, {role: "user", content: "and then?", timestamp: 0}]});
  const two = await remoteStream(model, second, {}).result();
  assert.equal(two.stopReason, "stop", two.errorMessage);
  const wire = bodies[1].context;
  assert.equal(wire.base.count, 1);
  assert.equal(wire.add.length, 2);
  assert.ok(isRef(wire.add[0]), "C's reply is not sent back");
  assert.equal(wire.add[1].content, "and then?");
  assert.ok(!JSON.stringify(wire).includes(first[0].content), "the history is not sent again");
});

test("S5: A sends the whole context when C answers resync", async t => {
  const dir = await home(t);
  useHome(t, dir);
  const bodies: any[] = [];
  let known = true;
  const server = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const base = {[header.protocol]: protocol, [header.interval]: "200", [header.timeout]: "600"};
    if (req.method !== "POST" || !req.url!.startsWith("/v1/turns/")) return void res.writeHead(200, {...base, "content-type": "application/json"}).end('{"loggedIn":true,"turns":{}}');
    const body = JSON.parse((req.headers["content-encoding"] === "br" ? brotliDecompressSync(raw) : raw).toString());
    bodies.push(body);
    // A C that restarted holds no history.
    if (body.context.base && !known) return void res.writeHead(409, {...base, "content-type": "application/json"}).end('{"code":"resync"}');
    res.writeHead(200, {...base, "content-type": "application/x-ndjson"}).end(done(1, "answer"));
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await writeSettings(dir, {token, client: {url: "http://127.0.0.1:" + (server.address() as {port: number}).port}});
  const first = {role: "user", content: "resync " + randomUUID(), timestamp: 0} as const;
  const one = await remoteStream(model, normalizeContext({messages: [first]}), {}).result();
  known = false;
  const two = await remoteStream(model, normalizeContext({messages: [first, one, {role: "user", content: "more", timestamp: 0}]}), {}).result();
  assert.equal(two.stopReason, "stop", two.errorMessage);
  assert.equal(bodies.length, 3);
  assert.ok(bodies[1].context.base, "first A builds on what it believes C holds");
  assert.equal(bodies[2].context.base, undefined);
  assert.equal(bodies[2].context.add.length, 3);
  assert.ok(!bodies[2].context.add.some(isRef), "nothing is named that C might lack");
  assert.equal(bodies[2].context.add[0].content, first.content);
});

test("C beats while the model is silent, gives up an A it cannot hear, and keeps one that pings", {timeout: 30000}, async t => {
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
  const start = (id: string, signal?: AbortSignal) => fetch(url + "/v1/turns/" + id, {method: "POST", headers, signal,
    body: JSON.stringify({model: "default", context: {add: context.messages}})});
  const id = randomUUID();
  // The fixture Claude never answers. This client reads the stream but never pings.
  const res = await start(id);
  assert.equal(res.headers.get(header.interval), "1000");
  assert.equal(res.headers.get(header.timeout), "2000");
  const frames = (await res.text()).trim().split("\n").map(line => JSON.parse(line));
  const beats = frames.filter(f => f.type === "heartbeat");
  assert.ok(beats.length >= 1, JSON.stringify(frames));
  assert.ok(beats[0].clientIdle >= 900 && beats[0].modelIdle > 0, JSON.stringify(beats));
  // Frames are numbered from 1 without gaps; a heartbeat names the last one sent.
  const numbered = frames.filter(f => f.type !== "heartbeat");
  assert.deepEqual(numbered.map(f => f.n), numbered.map((_, i) => i + 1));
  assert.equal(beats.at(-1).n, numbered.length - 1);
  assert.deepEqual(frames.at(-1), {n: numbered.length, type: "error", code: "lost"});
  for (let i = 0; i < 100 && !logs.includes(id.slice(0, 8)); i++) await delay(30);
  assert.match(logs, new RegExp(id.slice(0, 8) + " lost: no heartbeat from A for \\d+s"));
  const info = JSON.parse(await readFile(worker, "utf8"));
  for (let i = 0; i < 100 && existsSync(info.temp); i++) await delay(30);
  assert.throws(() => process.kill(info.pid, 0), {code: "ESRCH"});
  await rm(worker);
  // A that comes back within a minute still learns why the turn ended.
  const late = await fetch(url + "/v1/turns/" + id + "/events?after=0", {headers});
  assert.match(await late.text(), /"code":"lost"/);

  // The same request from an A that pings outlives the timeout, even with no connection
  // reading it: a broken connection does not end a turn.
  const id2 = randomUUID();
  const controller = new AbortController();
  const res2 = await start(id2, controller.signal);
  await res2.body!.getReader().read();
  controller.abort();
  const ping = () => fetch(url + "/v1/ping", {method: "POST", headers, body: JSON.stringify({turns: {[id2]: 0}})}).then(r => r.json());
  for (let i = 0; i < 7; i++) { await delay(500); assert.equal((await ping()).turns[id2].state, "running"); }
  assert.doesNotThrow(() => process.kill(JSON.parse(readFileSync(worker, "utf8")).pid, 0), "Claude goes on without a connection");
  const again = await fetch(url + "/v1/turns/" + id2 + "/events?after=0", {headers});
  const reader = again.body!.pipeThrough(new TextDecoderStream()).getReader();
  // It is told the turn from the start, then C's beats.
  let replay = "";
  while (!replay.includes('"type":"heartbeat"')) replay += (await reader.read()).value ?? "";
  assert.match(replay, /^\{"n":1,"type":"event"/);
  await reader.cancel();
  assert.ok(!logs.includes(id2.slice(0, 8)), logs);
  // Released in a ping, the turn is cancelled and its process ends.
  assert.equal((await fetch(url + "/v1/ping", {method: "POST", headers, body: JSON.stringify({released: [id2]})})).status, 200);
  const info2 = JSON.parse(await readFile(worker, "utf8"));
  for (let i = 0; i < 100 && existsSync(info2.temp); i++) await delay(30);
  assert.throws(() => process.kill(info2.pid, 0), {code: "ESRCH"});
  // Asking for a turn C does not have gets 404 and leaves no log line, while a
  // malformed request still logs one.
  const gone = await fetch(url + "/v1/turns/" + randomUUID() + "/events", {headers});
  assert.equal(gone.status, 404);
  assert.deepEqual(await gone.json(), {code: "gone"});
  await fetch(url + "/v1/turns/" + randomUUID(), {method: "POST", headers, body: "not json"}).then(r => r.text());
  for (let i = 0; i < 100 && !/-------- invalid/.test(logs); i++) await delay(30);
  await delay(200);
  assert.equal((logs.match(/-------- invalid/g) ?? []).length, 1, logs);
});
