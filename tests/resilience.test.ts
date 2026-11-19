// A weak link between A and C: a real C in this process, the real Pi stream on the A
// side, and a proxy between them that cuts connections, holds bytes back or stalls
// larger transfers. Scenario numbers refer to the 0.4.0 specification of the transport.
import assert from "node:assert/strict";
import test, {type TestContext} from "node:test";
import {randomBytes, randomUUID} from "node:crypto";
import {once} from "node:events";
import {existsSync, readFileSync} from "node:fs";
import {request as httpRequest} from "node:http";
import {connect, createServer} from "node:net";
import {brotliCompressSync} from "node:zlib";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {setTimeout as delay} from "node:timers/promises";
import {isRetryableAssistantError, normalizeContext, type AssistantMessage, type Message, type Model} from "@earendil-works/pi-ai";
import type {Backend} from "../src/backends/backend.ts";
import {claudeCode} from "../src/backends/claude-code/index.ts";
import {diagnose} from "../src/client/doctor.ts";
import {Link, link} from "../src/client/link.ts";
import {remoteStream} from "../src/frontends/pi/extension.ts";
import {Contexts} from "../src/server/contexts.ts";
import {runServer} from "../src/server/http.ts";
import {Monitor, presence, type ActiveRequest} from "../src/server/monitor.ts";
import {newUi, render, snapshot} from "../src/server/tui.ts";
import {Turn, Turns, retention} from "../src/server/turns.ts";
import {api, chainOf, digest, header, messages, protocol, providerId} from "../src/shared/protocol.ts";
import {chaos} from "./chaos.ts";
import {useHome, writeSettings} from "./helpers.ts";

const fixture = fileURLToPath(new URL("./fixtures/console-claude.mjs", import.meta.url));
const model: Model<string> = {id: "claude-opus-5-5", name: "Opus", api, provider: providerId, baseUrl: "", reasoning: true,
  input: ["text"], contextWindow: 200000, maxTokens: 64000, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}};
const user = (content: string): Message => ({role: "user", content, timestamp: 0});
const context = (list: Message[]) => normalizeContext({systemPrompt: "Be brief.", messages: list});
const dripped = (count: number) => Array.from({length: count}, (_, i) => `d${i} `).join("");
const textOf = (message: AssistantMessage) => message.content.map(block => block.type === "text" ? block.text : "").join("");
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

async function until(predicate: () => boolean, tries = 500) {
  for (let i = 0; i < tries; i++) { if (predicate()) return; await delay(20); }
  assert.fail("Timed out waiting for condition");
}
async function freePort() {
  const socket = createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = (socket.address() as {port: number}).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  return port;
}

type Place = {dir: string; port: number; token: string; proxy: Awaited<ReturnType<typeof chaos>>; log: string};
// Where C runs and how A reaches it: through the proxy. A and C share one settings.json.
async function place(t: TestContext, server: Record<string, unknown> = {}): Promise<Place> {
  const dir = await mkdtemp(join(tmpdir(), "tether-weak-"));
  const port = await freePort();
  const token = randomUUID();
  const proxy = await chaos(t, port);
  const log = join(dir, "log.jsonl");
  const previous = process.env.TEST_LOG;
  process.env.TEST_LOG = log;
  useHome(t, dir);
  await writeSettings(dir, {token, server: {port, claude: fixture, heartbeatInterval: 1, heartbeatTimeout: 4, ...server},
    client: {url: "http://127.0.0.1:" + proxy.port}});
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  t.after(async () => {
    if (previous === undefined) delete process.env.TEST_LOG; else process.env.TEST_LOG = previous;
    await rm(dir, {recursive: true, force: true});
  });
  return {dir, port, token, proxy, log};
}
// A full C in this process. Stopped when the test ends, or earlier through `stop`.
async function startC(t: TestContext, at: Place) {
  let monitor!: Monitor, halt!: () => void;
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const running = runServer(claudeCode, {token: at.token, host: "127.0.0.1", port: at.port, console: (m, s) => {
    monitor = m; halt = s; ready();
    return () => {};
  }});
  let stopped = false;
  const stop = async () => { if (stopped) return; stopped = true; halt(); await running.catch(() => {}); };
  t.after(stop);
  await started;
  return {monitor, stop};
}
const users = (at: Place) => !existsSync(at.log) ? 0
  : readFileSync(at.log, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(entry => entry.event === "user").length;
const ended = (monitor: Monitor) => monitor.entries.filter(e => e.tag === "process" && e.text.includes("已结束")).map(e => e.text);

// Runs a turn and collects its text deltas; `at` runs once when the text first contains it.
async function turn(list: Message[], mark?: string, onMark?: () => void) {
  const stream = remoteStream(model, context(list), {});
  let text = "", fired = false;
  for await (const event of stream) {
    if (event.type !== "text_delta") continue;
    text += event.delta;
    if (mark && !fired && text.includes(mark)) { fired = true; onMark!(); }
  }
  return {final: await stream.result(), text};
}

test("S1: a link that breaks or stalls mid-reply loses nothing and keeps the Claude process", {timeout: 60000}, async t => {
  const at = await place(t);
  const {monitor} = await startC(t, at);
  const shown = new Set<string>();
  t.after(link.onChange(() => shown.add(link.text())));

  // Connections die and none can be opened for a while, as when a tunnel restarts.
  const first = [user("DRIP 40 " + randomUUID())];
  const one = await turn(first, "d5 ", () => { at.proxy.down(); setTimeout(() => at.proxy.up(), 1500); });
  assert.equal(one.final.stopReason, "stop", one.final.errorMessage);
  assert.equal(one.text, dripped(40), "every delta arrives once, in order");
  assert.equal(textOf(one.final), dripped(40));
  assert.ok([...shown].some(text => text.includes("重连中")), [...shown].join("\n"));
  assert.ok(monitor.entries.some(e => /^.* · 请求 .* · 启动进程 \d+$/.test(e.text)));
  assert.deepEqual(ended(monitor), [], "the broken link ended no process");

  // Bytes stop without anything closing, as when packets are dropped. A waits for more
  // than two missed beats, then takes a new connection and continues.
  const second = [...first, one.final, user("DRIP 40 again")];
  const connections = at.proxy.state.connections;
  const two = await turn(second, "d5 ", () => { at.proxy.pause(); setTimeout(() => at.proxy.resume(), 3200); });
  assert.equal(two.final.stopReason, "stop", two.final.errorMessage);
  assert.equal(two.text, dripped(40));
  assert.ok(at.proxy.state.connections > connections, "A opened another connection");
  assert.ok(monitor.entries.some(e => /复用进程 \d+/.test(e.text)), "the same process served the next turn");
  assert.deepEqual(ended(monitor), []);
  assert.equal(users(at), 2, "each turn reached the model once");
});

test("S2/S6/S8: an A that stays away loses the turn after the timeout, and C shows it as lost", {timeout: 60000}, async t => {
  const at = await place(t);
  const {monitor} = await startC(t, at);
  link.start();
  t.after(() => link.stop());
  await until(() => [...monitor.clients.values()].some(c => c.pinged !== undefined));
  const [client] = monitor.clients.values();
  const state = () => presence(client, [...monitor.active.values()].some(r => r.client === client.key), Date.now(), 1000);
  // S6: Pi is open and sends nothing but pings.
  assert.equal(state(), "idle");
  // A reports the round trip of each ping with the next one.
  await until(() => client.rtt !== undefined);
  assert.ok(client.rtt! >= 0 && client.rtt! < 1000, String(client.rtt));

  const slow = turn([user("SLOW " + randomUUID())]);
  await until(() => [...monitor.active.values()].some(r => r.lease));
  assert.equal(state(), "busy");
  const started = Date.now();
  at.proxy.down();
  const {final} = await slow;
  assert.equal(final.stopReason, "error");
  assert.match(final.errorMessage!, /connection lost/);
  assert.ok(isRetryableAssistantError(final), "Pi retries it");
  assert.ok(Date.now() - started >= 3500, "A kept trying for the whole timeout");
  // S2: C gave the turn up as well, and says why.
  await until(() => monitor.active.size === 0);
  assert.ok(monitor.entries.some(e => /lost: no heartbeat from A for \d+s/.test(e.text)), monitor.entries.map(e => e.text).join("\n"));
  assert.ok(ended(monitor).some(text => text.includes("A 失联")));
  // S8: an A whose pings stopped is lost, not idle; once they arrive again it is back.
  await until(() => state() === "lost", 600);
  const screen = plain(render(snapshot(monitor, {host: "127.0.0.1", port: at.port, token: at.token,
    server: {maxSessions: 16, heartbeatInterval: 1, heartbeatTimeout: 4}}), newUi(), 150, 45).join("\n"));
  assert.match(screen, /! 失联/);
  assert.match(screen, /A 端 · 0 在线/);
  at.proxy.up();
  await link.ping();
  assert.equal(state(), "idle");
});

test("S3: a reply that finished while A was away is replayed, not generated again", {timeout: 60000}, async t => {
  const at = await place(t);
  const {monitor} = await startC(t, at);
  const list = [user("DRIP 5 " + randomUUID())];
  // The link goes right after the reply starts. C finishes it half a second later.
  const one = await turn(list, "d0 ", () => at.proxy.down());
  assert.match(one.final.errorMessage!, /connection lost/);
  await until(() => monitor.active.size === 0);
  assert.equal(users(at), 1);
  at.proxy.up();
  // What Pi's retry sends: the same context again.
  const two = await turn(list);
  assert.equal(two.final.stopReason, "stop", two.final.errorMessage);
  assert.equal(two.text, dripped(5));
  assert.equal(users(at), 1, "the model was not asked a second time");
  assert.ok(monitor.entries.some(e => e.text.includes("重放已生成的结果")));
  // The conversation goes on in the same process.
  const three = await turn([...list, two.final, user("next")]);
  assert.equal(three.final.stopReason, "stop", three.final.errorMessage);
  assert.ok(monitor.entries.some(e => /复用进程 \d+/.test(e.text)));
  assert.deepEqual(ended(monitor), []);
  // Delivered turns are released, so an identical request later is a new generation.
  await delay(300);
  const again = await turn(list);
  assert.equal(again.final.stopReason, "stop", again.final.errorMessage);
  assert.equal(users(at), 3);
});

test("S4/S5: uploads follow what a turn adds, and a restarted C gets the history again", {timeout: 60000}, async t => {
  const at = await place(t);
  const c1 = await startC(t, at);
  // 300 KB that compression cannot shrink away.
  const large = user("history " + randomBytes(150 * 1024).toString("hex"));
  const sent = async (run: () => Promise<{final: AssistantMessage}>) => {
    const before = at.proxy.state.up;
    const {final} = await run();
    assert.equal(final.stopReason, "stop", final.errorMessage);
    await delay(100);
    return {final, bytes: at.proxy.state.up - before};
  };
  const one = await sent(() => turn([large]));
  const two = await sent(() => turn([large, one.final, user("and then?")]));
  const three = await sent(() => turn([large, one.final, user("and then?"), two.final, user("DRIP 30")]));
  t.diagnostic(`request bytes on the wire: turn 1 ${one.bytes}, turn 2 ${two.bytes}, turn 3 ${three.bytes}`);
  assert.ok(one.bytes > 100 * 1024, String(one.bytes));
  // Pings and the release of the turn before are in these numbers too.
  assert.ok(two.bytes < 8192 && three.bytes < 8192, `${two.bytes} ${three.bytes}: the history is not sent again`);
  assert.ok(c1.monitor.entries.some(e => /复用进程 \d+（2 条历史/.test(e.text)), "C rebuilt the whole context for the backend");

  // What compression saves on a reply: the same turn read without and with it.
  const reply = (encoding?: string) => new Promise<number>((resolve, reject) => {
    const req = httpRequest(`http://127.0.0.1:${at.port}/v1/turns/${randomUUID()}`, {method: "POST",
      headers: {authorization: "Bearer " + at.token, [header.protocol]: protocol, ...(encoding ? {"accept-encoding": encoding} : {})}}, res => {
      let bytes = 0;
      res.on("data", chunk => { bytes += chunk.length; }).on("end", () => resolve(bytes)).on("error", reject);
    });
    req.on("error", reject).end(JSON.stringify({model: model.id, context: {add: context([user("DRIP 30 " + encoding)]).messages}}));
  });
  const [raw, packed] = [await reply(), await reply("br")];
  t.diagnostic(`reply bytes for 30 deltas: ${raw} plain, ${packed} compressed`);
  assert.ok(packed < raw * 0.6, `${packed} vs ${raw}`);

  // S5: C restarts and holds nothing. A builds on a history C lacks, is told so, and
  // sends everything; the user sees one more turn that works.
  await c1.stop();
  const c2 = await startC(t, at);
  const four = await sent(() => turn([large, one.final, user("and then?"), two.final, user("after the restart")]));
  assert.ok(four.bytes > 100 * 1024, "the whole history went up again");
  assert.equal(c2.monitor.totals.requests, 1);
  assert.equal(c2.monitor.totals.failed, 0);
});

test("a cancelled turn is not replayed, and a turn two requests share outlives one of them", {timeout: 60000}, async t => {
  const at = await place(t);
  const {monitor, stop} = await startC(t, at);
  const url = "http://127.0.0.1:" + at.port;
  const headers = {authorization: "Bearer " + at.token, [header.protocol]: protocol};
  const list = [user("SLOW " + randomUUID())];
  const post = (id: string, body: unknown = {model: model.id, context: {add: context(list).messages}}, more: Record<string, string> = {}) =>
    fetch(url + "/v1/turns/" + id, {method: "POST", headers: {...headers, ...more}, body: body instanceof Uint8Array ? body as never : JSON.stringify(body)});
  const remove = (id: string) => fetch(url + "/v1/turns/" + id, {method: "DELETE", headers}).then(r => r.status);
  const [id1, id2, id3] = [randomUUID(), randomUUID(), randomUUID()];
  const first = await post(id1);
  await until(() => users(at) === 1);
  // The same context again while the first request still reads its turn.
  const second = await post(id2);
  await first.body!.cancel().catch(() => {});
  assert.equal(monitor.active.size, 1, "both requests share one turn");
  assert.equal(users(at), 1);
  // The first request gives up. Its release, in a DELETE or a later ping, must not
  // end the turn the second one is reading.
  assert.equal(await remove(id1), 200);
  assert.equal((await fetch(url + "/v1/ping", {method: "POST", headers, body: JSON.stringify({released: [id1]})})).status, 200);
  await delay(400);
  assert.equal(monitor.active.size, 1);
  assert.equal(ended(monitor).length, 0);
  // The last one lets go: now it is cancelled, and whoever reads it is told.
  assert.equal(await remove(id2), 200);
  assert.match(await second.text(), /"type":"error","code":"cancelled"/);
  await until(() => monitor.active.size === 0);
  // 边界: the same context after a cancel is a new generation, not a replay.
  const third = await post(id3);
  await until(() => users(at) === 2);
  assert.equal(monitor.entries.filter(e => e.text.includes("上下文相同")).length, 1, "only the second request joined a turn; the third started one");
  assert.equal(await remove(id3), 200);
  await third.text();

  // 边界: a body that inflates beyond the limit is refused without being inflated whole.
  const bomb = brotliCompressSync(Buffer.alloc(33 * 1024 * 1024, 0x20));
  assert.ok(bomb.length < 4096);
  const refused = await post(randomUUID(), bomb, {"content-encoding": "br"});
  assert.deepEqual([refused.status, await refused.json()], [413, {code: "large"}]);

  // A connection that goes while C still reads the request leaves a turn without a
  // reader, and must not keep the server from stopping.
  const big = brotliCompressSync(JSON.stringify({model: model.id, context: {add: context([user("x".repeat(24 * 1024 * 1024))]).messages}}));
  const requests = monitor.totals.requests;
  await new Promise<void>((resolve, reject) => {
    const socket = connect(at.port, "127.0.0.1", () => {
      socket.write(`POST /v1/turns/${randomUUID()} HTTP/1.1\r\nHost: c\r\nAuthorization: Bearer ${at.token}\r\n${header.protocol}: ${protocol}\r\n` +
        `Content-Encoding: br\r\nContent-Length: ${big.length}\r\n\r\n`);
      socket.write(big, () => setTimeout(() => { socket.destroy(); resolve(); }, 3));
    });
    socket.on("error", reject);
  });
  await until(() => monitor.totals.requests === requests + 1);
  await until(() => monitor.active.size === 0);
  await stop();
});

test("S7: quitting Pi cancels its turns at once and retires its processes", {timeout: 60000}, async t => {
  const at = await place(t, {exitGrace: 1, maxSessions: 2});
  const {monitor} = await startC(t, at);
  link.start();
  t.after(() => link.stop());
  // An idle process from one conversation, and a turn running in another.
  const idle = await turn([user("hello " + randomUUID())]);
  assert.equal(idle.final.stopReason, "stop", idle.final.errorMessage);
  const running = turn([user("SLOW " + randomUUID())]);
  await until(() => [...monitor.active.values()].some(r => r.lease));
  const [client] = monitor.clients.values();
  const [kept] = claudeCode.processes!().filter(p => !p.busy);
  const began = Date.now();
  await link.bye();
  assert.ok(Date.now() - began < 1500, "saying goodbye does not hold Pi's exit");
  assert.equal((await running).final.errorMessage, messages.cancelled);
  assert.equal(presence(client, false, Date.now(), 1000), "left");
  assert.ok(monitor.entries.some(e => /已退出 · 1 个进程 1 秒后回收/.test(e.text)), monitor.entries.map(e => e.text).join("\n"));
  const info = claudeCode.processes!().find(p => p.pid === kept.pid)!;
  assert.ok(info.reclaimAt! - Date.now() <= 1000, "the idle process goes after the grace period, not after an hour");
  await until(() => !claudeCode.processes!().some(p => p.pid === kept.pid));
  assert.ok(ended(monitor).some(text => text.includes(`进程 ${kept.pid} 已结束 · A 已退出`)), ended(monitor).join("\n"));
  // A that is heard from again has not left.
  await link.ping();
  assert.equal(presence(client, false, Date.now(), 1000), "idle");

  // On a link that swallows the goodbye, Pi's exit waits no longer than the limit.
  at.proxy.pause();
  const stuck = Date.now();
  await link.bye(700);
  assert.ok(Date.now() - stuck < 2000, String(Date.now() - stuck));
  at.proxy.cut();
  at.proxy.resume();
  await link.ping();
  await until(() => presence(client, false, Date.now(), 1000) === "idle");

  // When the pool is full, a process whose A quit goes before the least recently used.
  const a = await turn([user("first " + randomUUID())]);
  const b = await turn([user("second " + randomUUID())]);
  assert.equal(a.final.stopReason, "stop");
  assert.equal(b.final.stopReason, "stop");
  const pool = claudeCode.processes!().sort((x, y) => x.lastUsed - y.lastUsed);
  assert.equal(pool.length, 2);
  claudeCode.retire!([pool[1].pid!], 60_000);
  const c = await turn([user("third " + randomUUID())]);
  assert.equal(c.final.stopReason, "stop");
  assert.ok(ended(monitor).some(text => text.includes(`进程 ${pool[1].pid} 已结束 · 进程池已满`)), ended(monitor).join("\n"));
  assert.ok(claudeCode.processes!().some(p => p.pid === pool[0].pid), "the older process of a present A stays");
});

test("S10: the link check tells a link that stalls larger requests from a healthy one", {timeout: 90000}, async t => {
  const at = await place(t);
  await startC(t, at);
  const healthy = await diagnose();
  assert.equal(healthy.ok, true);
  assert.match(healthy.lines[0], /C 上的 Claude Code 已登录 · A \d+\.\d+\.\d+，C \d+\.\d+\.\d+/);
  assert.match(healthy.lines.join("\n"), /延迟：平均 .*上行（A→C）：16 KB .*下行（C→A）：16 KB /s);
  assert.ok(!healthy.lines.join("\n").includes("⚠"), healthy.lines.join("\n"));
  // Every connection stops for a while once it carries more than a small packet.
  at.proxy.state.stall = {over: 1300, ms: 2700};
  const stalled = await diagnose();
  assert.match(stalled.lines.join("\n"), /⚠ 上行和下行的 16 KB 请求比小请求慢 .*丢弃大包/);
  // A sender that never falls back to small packets: larger requests do not arrive at all.
  at.proxy.state.stall = {over: 1300, ms: 60_000};
  const began = Date.now();
  const dead = await diagnose(undefined, 1200);
  assert.match(dead.lines.join("\n"), /延迟：平均 .*新连接上的小请求：/s);
  assert.match(dead.lines.join("\n"), /⚠ 上行（A→C）和下行（C→A）：小请求能通，16 KB 的请求 1\.2 秒没有回应。.*MTU 调到 1280/);
  assert.ok(!dead.lines.join("\n").includes("链路测量中断"));
  assert.ok(Date.now() - began < 6000, "it does not wait for transfers that cannot arrive");
});

test("S11: the status line says what the link is doing", () => {
  let now = 1_000_000;
  const l = new Link(() => now);
  assert.equal(l.text(), "A-tether … 连接中");
  l.state = "ok"; l.rtt = 45;
  assert.equal(l.text(), "A-tether ● 已连接 45 ms");
  l.state = "unstable"; l.rtt = 340;
  assert.match(l.text(), /^A-tether ◐ 网络不稳 340 ms/);
  l.state = "down"; l.downSince = now - 40_000;
  assert.equal(l.text(), "A-tether ○ 无法连接 C · 已 40 秒");
  l.state = "token";
  assert.match(l.text(), /✕ 令牌/);
  l.state = "version";
  assert.match(l.text(), /✕ 与 C 版本不一致/);
  l.state = "login";
  assert.match(l.text(), /✕ C 上的 Claude Code 未登录/);
  // A request in flight takes the line over.
  l.state = "ok";
  l.busy({kind: "reconnecting", since: now - 12_000});
  assert.equal(l.text(), "A-tether ◌ 重连中 · 已断开 12 秒，已收到的内容保留");
  l.busy({kind: "uploading", bytes: 300 * 1024});
  assert.equal(l.text(), "A-tether ↑ 上传 300 KB");
  l.busy({kind: "syncing", bytes: 3 * 1024 * 1024});
  assert.equal(l.text(), "A-tether ↑ 同步上下文 3.0 MB");
  l.busy();
  assert.equal(l.text(), "A-tether ● 已连接 45 ms".replace("45", "340"));
});

test("S12: the console tells idle, lost and departed A's apart and shows a broken connection", () => {
  const now = Date.now();
  const monitor = new Monitor({name: "test", processes: () => [], stats: () => ({processes: 0, started: 0, reused: 0})} as unknown as Backend, () => now);
  monitor.quiet = true;
  const add = (i: number) => monitor.seen({headers: {[header.client]: "0123456789a" + i, [header.host]: "host-" + i},
    socket: {remoteAddress: "10.0.0." + i}} as never);
  const [idle, lost, left, busy] = [0, 1, 2, 3].map(add);
  Object.assign(monitor.clients.get(idle)!, {pinged: now - 2000, rtt: 340});
  Object.assign(monitor.clients.get(lost)!, {pinged: now - 60_000, lastSeen: now - 60_000, rtt: 45});
  Object.assign(monitor.clients.get(left)!, {pinged: now - 90_000, left: now - 90_000});
  Object.assign(monitor.clients.get(busy)!, {pinged: now - 1000, rtt: 20});
  const request = (id: string, more: Partial<ActiveRequest>): ActiveRequest => ({id, controller: new AbortController(), heard: now - 1000, client: busy,
    model: "claude-opus-5-5", started: now - 30_000, output: now - 2000, chars: 10, attached: true, ...more});
  monitor.started(request(randomUUID(), {}));
  monitor.started(request(randomUUID(), {attached: false, detached: now - 12_000, heard: now - 3000}));
  monitor.started(request(randomUUID(), {attached: false, detached: now - 100_000, heard: now - 100_000}));
  monitor.memory = () => ({contexts: 3 * 1024 * 1024, turns: 20 * 1024});
  const server = {maxSessions: 16, heartbeatInterval: 10, heartbeatTimeout: 120};
  const view = snapshot(monitor, {host: "127.0.0.1", port: 7310, token: "x".repeat(40), server, now});
  const screen = plain(render(view, newUi(), 170, 45).join("\n"));
  assert.match(screen, /A 端 · 2 在线/);
  assert.match(screen, /host-0.*○ 空闲\s+340 ms/);
  assert.match(screen, /host-1.*! 失联/);
  assert.match(screen, /host-2.*× 已退出/);
  assert.match(screen, /host-3.*● 请求中\s+20 ms/);
  assert.match(screen, /已连接 · 1s 前/);
  assert.match(screen, /已断开 12s · 等待重连/);
  assert.match(screen, /失联 1m40s · 20s 后放弃/);
  assert.match(screen, /缓存 3\.0 MB/);
  assert.ok(!screen.includes("离开") && !/\d 分钟内有请求算在线/.test(screen));
  for (const [cols, rows] of [[80, 24], [120, 40], [220, 60]]) {
    for (const modal of [undefined, {type: "help"}, {type: "client", key: lost}, {type: "request", id: view.requests[1].id}] as const) {
      for (const line of render(view, {...newUi(modal), focus: 2}, cols, rows)) assert.ok(plain(line).length <= cols * 2);
    }
  }
});

test("C's stores: histories are resolved by digest, replies replayed, and both are bounded", () => {
  const contexts = new Contexts(1000, 3);
  const a = {role: "user", content: "a".repeat(100)}, b = {role: "user", content: "b".repeat(100)};
  const one = contexts.resolve({add: [a]})!;
  assert.equal(one.chain, chainOf("", digest(JSON.stringify(a))), "both ends compute the same chain");
  // C's reply is named by the digest of what A holds after a JSON round trip.
  const reply = {role: "assistant", content: [{type: "text", text: "r"}], extra: undefined};
  contexts.reply(reply);
  const ref = digest(JSON.stringify(JSON.parse(JSON.stringify(reply))));
  const two = contexts.resolve({base: {count: 1, chain: one.chain}, add: [{$ref: ref}, b]})!;
  assert.deepEqual(two.messages, [a, {role: "assistant", content: [{type: "text", text: "r"}]}, b]);
  assert.equal(contexts.resolve({base: {count: 1, chain: "unknown"}, add: [b]}), undefined);
  assert.equal(contexts.resolve({base: {count: 2, chain: one.chain}, add: [b]}), undefined, "a base of another length is not it");
  assert.equal(contexts.resolve({add: [{$ref: "unknown"}]}), undefined);
  // Snapshots of one conversation share their messages; the oldest go when over a limit.
  assert.ok(contexts.bytes < 400, String(contexts.bytes));
  for (let i = 0; i < 5; i++) contexts.resolve({add: [{role: "user", content: String(i).repeat(300)}]});
  assert.ok(contexts.count <= 3 && contexts.bytes <= 1000, `${contexts.count} ${contexts.bytes}`);
  assert.equal(contexts.resolve({base: {count: 1, chain: one.chain}, add: [b]}), undefined, "evicted: A will be told to resync");

  const turns = new Turns(1000);
  const make = (key: string) => new Turn({id: randomUUID(), controller: new AbortController(), heard: 0, model: "m", started: 0, output: 0, chars: 0}, key);
  const done = make("k1"), failed = make("k2"), running = make("k3");
  for (const turn of [done, failed, running]) { turns.add(turn); turn.push({type: "event"}); }
  done.end("done", 0);
  failed.end("failed", 0);
  assert.equal(turns.reusable("k1"), done);
  assert.equal(turns.reusable("k2"), undefined, "a failed turn is never replayed");
  // A turn shared by two IDs ends only when both have let go of it.
  running.entry.attached = true;
  turns.alias("second-id", running);
  assert.equal(turns.unlink(running.entry.id, running), false);
  assert.equal(turns.get("second-id"), running);
  turns.alias(running.entry.id, running);
  assert.equal(turns.unlink("second-id", running), false);
  // A cancelled turn is forgotten at once, while it still runs to its end.
  turns.forget(running);
  assert.equal(turns.reusable("k3"), undefined);
  turns.add(running);
  assert.equal(turns.reusable("k3"), running);
  // Nobody reads the finished turn: a new request for its context takes it over.
  turns.alias("other-id", done);
  assert.equal(turns.get(done.entry.id), undefined);
  assert.equal(turns.unlink("other-id", done), true);
  turns.alias("other-id", done);
  turns.sweep(retention.failed + 1);
  assert.equal(turns.get(failed.entry.id), undefined);
  assert.equal(turns.get("other-id"), done);
  turns.sweep(retention.done + 1);
  assert.equal(turns.get("other-id"), undefined);
  assert.equal(turns.get(done.entry.id), undefined);
  assert.equal(turns.get(running.entry.id), running, "a running turn is never swept");
});
