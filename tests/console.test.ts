// C's console: what the monitor records from real requests, and that the TUI screen
// fits the terminal and never shows conversation content or the token.
import assert from "node:assert/strict";
import test, {type TestContext} from "node:test";
import {randomUUID} from "node:crypto";
import {once} from "node:events";
import {createServer} from "node:net";
import {mkdtemp, rm} from "node:fs/promises";
import {hostname, tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {setTimeout as delay} from "node:timers/promises";
import {normalizeContext, type Message, type Model, type Tool} from "@earendil-works/pi-ai";
import type {Backend, ProcessInfo} from "../src/backends/backend.ts";
import {claudeCode} from "../src/backends/claude-code/index.ts";
import {remoteStream} from "../src/frontends/pi/extension.ts";
import {runServer} from "../src/server/http.ts";
import {Monitor} from "../src/server/monitor.ts";
import {keys, newUi, press, render, snapshot} from "../src/server/tui.ts";
import {safe, slice, truncate, width} from "../src/server/text.ts";
import {api, header, hostLabel, messages, protocol, providerId} from "../src/shared/protocol.ts";
import {useHome, writeSettings} from "./helpers.ts";

const fixture = fileURLToPath(new URL("./fixtures/console-claude.mjs", import.meta.url));
const model: Model<string> = {id: "claude-opus-5-5", name: "Opus", api, provider: providerId, baseUrl: "", reasoning: true,
  input: ["text"], contextWindow: 200000, maxTokens: 64000, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}};
const bash: Tool = {name: "bash", description: "Run a command", parameters: {type: "object"} as Tool["parameters"]};
const user = (content: string): Message => ({role: "user", content, timestamp: 0});
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const server = {maxSessions: 16, heartbeatInterval: 10, heartbeatTimeout: 30};

async function until(predicate: () => boolean) {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await delay(20); }
  assert.fail("Timed out waiting for condition");
}
async function freePort() {
  const socket = createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = (socket.address() as {port: number}).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  return port;
}

// A full C in this process, with the console hook handing out its monitor.
async function startC(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "tether-console-"));
  const port = await freePort();
  const token = randomUUID();
  const previous = process.env.TEST_LOG;
  process.env.TEST_LOG = join(dir, "log.jsonl");
  useHome(t, dir);
  await writeSettings(dir, {token, server: {port, claude: fixture}});
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  let monitor!: Monitor, stop!: () => void;
  let summary: {processes: number} | undefined;
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const running = runServer(claudeCode, {token, host: "127.0.0.1", port, console: (m, s) => {
    monitor = m; stop = s; ready();
    return sum => { summary = sum; };
  }});
  t.after(async () => {
    stop?.();
    await running.catch(() => {});
    if (previous === undefined) delete process.env.TEST_LOG; else process.env.TEST_LOG = previous;
    await rm(dir, {recursive: true, force: true});
  });
  await started;
  return {monitor, token, url: "http://127.0.0.1:" + port, stop: async () => { stop(); await running; return summary; }};
}

async function turn(messages: Message[], options: {reasoning?: "high"} = {}) {
  const stream = remoteStream(model, normalizeContext({systemPrompt: "Be brief.", tools: [bash], messages}), options);
  for await (const _ of stream);
  return stream.result();
}

test("the console follows A, its processes and requests, without conversation content", {timeout: 30000}, async t => {
  const {monitor, token, url, stop} = await startC(t);
  const view = () => snapshot(monitor, {host: "127.0.0.1", port: 7310, token, server});
  const secret = "conversation-secret-" + randomUUID();

  // S2: A's client headers name it; S4: the process shows the tool it waits for.
  const first = [user("CALL " + secret)];
  const m1 = await turn(first, {reasoning: "high"});
  assert.equal(m1.stopReason, "toolUse", m1.errorMessage);
  assert.equal(monitor.clients.size, 1);
  const [client] = monitor.clients.values();
  assert.match(client.id!, /^[a-f0-9]{12}$/);
  assert.equal(client.host, hostLabel(hostname()) || "A");
  assert.equal(client.today, 1);
  await until(() => view().processes[0]?.state === "awaitingTools");
  const proc = view().processes[0];
  assert.deepEqual([proc.pending, proc.owner, proc.effort, proc.history], [["bash"], client.key, "high", 2]);
  assert(monitor.entries.some(e => /· claude-opus-5-5 high · 启动进程 \d+$/.test(e.text)));
  assert(monitor.entries.some(e => /完成 · .* · 等待 1 个工具结果（bash）/.test(e.text)));

  // The next request continues the same process with the tool's result.
  const call = m1.content.find(b => b.type === "toolCall")!;
  assert.equal(call.type, "toolCall");
  const m2 = await turn([...first, m1, {role: "toolResult", toolCallId: call.type === "toolCall" ? call.id : "",
    toolName: "bash", content: [{type: "text", text: "tool-output-" + secret}], isError: false, timestamp: 0}], {reasoning: "high"});
  assert.equal(m2.stopReason, "stop", m2.errorMessage);
  assert(monitor.entries.some(e => /复用进程 \d+（2 条历史，补 1 条工具结果）/.test(e.text)));

  const screen = render(view(), newUi(), 150, 45).join("\n");
  assert.match(plain(screen), /A 端 · 1 在线/);
  assert(!screen.includes(secret), "no conversation content on screen");
  assert(!screen.includes(token), "no token on screen");
  assert(!monitor.entries.some(e => e.text.includes(secret)));

  // S5: ending a busy process from the console fails its request as a backend error.
  const slow = turn([user("SLOW one")]);
  await until(() => [...monitor.active.values()].some(r => r.lease));
  const busy = [...monitor.active.values()][0];
  assert.equal(busy.lease!.how, "started");
  assert.equal(monitor.kill(busy.lease!.pid!), true);
  assert.equal((await slow).errorMessage, messages.backend);
  await until(() => monitor.entries.some(e => e.text.includes("已在控制台手动结束")));

  // S6: cancelling from the console works as A's DELETE.
  const slower = turn([user("SLOW two")]);
  await until(() => [...monitor.active.values()].some(r => r.lease));
  assert.equal(monitor.cancel([...monitor.active.keys()][0]), true);
  assert.equal((await slower).errorMessage, messages.cancelled);
  await until(() => monitor.active.size === 0);
  assert.equal(monitor.totals.failed, 1, "a cancel is no failure");

  // S3: an A on protocol 2 is refused. Without client headers, A is grouped by address;
  // without the token it is not recorded at all.
  const auth = {authorization: "Bearer " + token};
  const old = await fetch(url + "/v1/health", {headers: {...auth, [header.protocol]: "2"}});
  assert.deepEqual([old.status, await old.json()], [400, {code: "version"}]);
  assert.equal((await fetch(url + "/v1/health", {headers: {[header.protocol]: protocol, [header.client]: "abcdefabcdef"}})).status, 401);
  assert.equal(monitor.clients.size, 1);
  assert.equal((await fetch(url + "/v1/health", {headers: {...auth, [header.protocol]: protocol}})).status, 200);
  assert.equal(monitor.clients.get("addr:127.0.0.1")?.host, "未标识");

  assert.deepEqual(await stop(), {processes: 1});
});

// A monitor over a stand-in backend, filled with rows wide enough to need cutting.
function crowded() {
  const now = Date.now();
  const processes: ProcessInfo[] = Array.from({length: 9}, (_, i) => ({pid: 40000 + i,
    state: (["generating", "awaitingTools", "finishing", "idle"] as const)[i % 4], busy: i % 4 === 0, pooled: i !== 8,
    model: "claude-sonnet-5-5-with-a-very-long-model-name", effort: "xhigh", history: 120 + i,
    pending: i % 4 === 1 ? ["read", "bash", "edit_with_a_long_name"] : [], reuses: i, started: now - i * 60_000,
    lastUsed: now - i * 30_000, reclaimAt: i % 4 === 0 ? undefined : now + 50 * 60_000}));
  const backend = {name: "test", processes: () => processes, stats: () => ({processes: 9, started: 30, reused: 90}),
    kill: () => true} as unknown as Backend;
  const monitor = new Monitor(backend);
  monitor.quiet = true;
  monitor.status({available: true, loggedIn: false, diagnostic: false});
  monitor.catalogLoaded(4);
  for (let i = 0; i < 7; i++) {
    const key = monitor.seen({headers: {[header.client]: "0123456789a" + i, [header.host]: "workstation-number-" + i + "-with-long-name"},
      socket: {remoteAddress: "::ffff:192.168.1." + i}} as never);
    if (i < 5) monitor.started({id: randomUUID(), controller: new AbortController(), heard: now - i * 9000, client: key,
      model: "claude-opus-5-5", effort: "high", started: now - i * 1000, output: now, chars: i * 1500,
      lease: {pid: 40000 + i, how: (["reused", "started", "rebuilt", "oneshot"] as const)[i % 4], history: 10}});
  }
  for (let i = 0; i < 60; i++) monitor.note("request", "info", "中文和 English 混排的一条很长的动作记录，".repeat(4) + i);
  monitor.diagnostic(randomUUID(), "overloaded", "API Error: 529 \x1b[2J{\"type\":\"overloaded_error\"}");
  return monitor;
}

test("every screen line fits the terminal, with and without dialogs", () => {
  const monitor = crowded();
  const token = "f".repeat(64);
  const v = snapshot(monitor, {host: "0.0.0.0", port: 7310, token, server: {...server, maxSessions: 8}});
  const modals = [undefined, {type: "help"}, {type: "token"}, {type: "quit"}, {type: "process", pid: 40001},
    {type: "request", id: v.requests[0].id}, {type: "client", key: v.clients[0].key}, {type: "kill", pid: 40000}] as const;
  for (const [cols, rows] of [[80, 24], [100, 30], [120, 40], [150, 45], [220, 60]]) {
    for (const modal of modals) {
      const lines = render(v, {...newUi(modal), focus: 2}, cols, rows);
      assert.equal(lines.length, rows);
      for (const line of lines) assert.equal(width(line), cols, `${cols}×${rows} ${modal?.type}: ${plain(line)}`);
      const screen = lines.join("\n");
      assert(!screen.includes(token), "the token stays masked until r");
      assert(!screen.includes("\x1b[2J"), "control characters from Claude Code are neutralised");
    }
  }
  const narrow = render(v, newUi(), 79, 30).map(plain).join("\n");
  assert.match(narrow, /终端窗口太小/);
  // r shows the whole command, wrapped if it has to be.
  const revealed = snapshot(monitor, {host: "127.0.0.1", port: 7310, token: "0123456789abcdef".repeat(4), server});
  const shown = render(revealed, newUi({type: "token"}, true), 80, 24).map(plain).join("\n");
  assert.match(shown, /npx -y @a-tether\/pi login/);
  assert(shown.match(/[0-9a-f]{8,}/g)!.join("").includes(revealed.token));
  // Banners: Claude Code not logged in, and a non-loopback address.
  const top = render(v, newUi(), 150, 45).slice(0, 3).map(plain).join("\n");
  assert.match(top, /尚未登录/);
  assert.match(top, /非本机地址/);
});

test("keys move focus, open dialogs and act only after confirmation", () => {
  const monitor = crowded();
  const v = snapshot(monitor, {host: "127.0.0.1", port: 7310, token: "x".repeat(40), server});
  const calls: string[] = [];
  const act = {stop: () => calls.push("stop"), cancel: (id: string) => calls.push("cancel " + id), kill: (pid: number) => calls.push("kill " + pid)};
  const ui = newUi();
  assert.deepEqual(keys("\x1b[A\x1b[B"), ["\x1b[A", "\x1b[B"], "held arrow keys arrive together");
  press("\t", v, ui, act);
  assert.equal(ui.focus, 2);
  press("\x1b[Z", v, ui, act);
  assert.equal(ui.focus, 1);

  render(v, ui, 150, 45); // selects the first row of each list
  press("x", v, ui, act);
  assert.deepEqual(ui.modal, {type: "kill", pid: v.processes[0].pid});
  press("\x1b", v, ui, act);
  assert.equal(ui.modal, undefined);
  press("x", v, ui, act);
  press("y", v, ui, act);
  assert.deepEqual(calls, ["kill " + v.processes[0].pid]);

  press("3", v, ui, act);
  render(v, ui, 150, 45);
  press("j", v, ui, act);
  render(v, ui, 150, 45);
  press("\r", v, ui, act);
  assert.deepEqual(ui.modal, {type: "request", id: v.requests[1].id});
  press("c", v, ui, act);
  press("y", v, ui, act);
  assert.equal(calls.at(-1), "cancel " + v.requests[1].id);

  // With requests in flight, q asks first; Ctrl+C confirms.
  press("q", v, ui, act);
  assert.deepEqual(ui.modal, {type: "quit"});
  assert.equal(calls.at(-1), "cancel " + v.requests[1].id);
  press("\x03", v, ui, act);
  assert.equal(calls.at(-1), "stop");
  // With none, Ctrl+C stops at once.
  const idle = {...v, requests: []};
  const calm = newUi();
  press("\x03", idle, calm, act);
  assert.deepEqual([calls.filter(c => c === "stop").length, calm.modal], [2, {type: "stopping"}]);
  // While stopping, Ctrl+C gives up waiting; other keys do nothing.
  press("q", idle, calm, {...act, force: () => calls.push("force")});
  press("\x03", idle, calm, {...act, force: () => calls.push("force")});
  assert.deepEqual(calls.slice(-1), ["force"]);
  assert.equal(calls.filter(c => c === "stop").length, 2);

  // Pasted text, such as the login command, is not a run of commands.
  assert.deepEqual(keys("npx -y @a-tether/pi login abc"), []);
  assert.deepEqual(keys("\x1b[200~xyq\x1b[201~"), []);
  assert.deepEqual(keys("\x1b[200~x\x1b[201~"), []);
  assert.deepEqual(keys("q"), ["q"]);
});

test("text helpers count wide characters as two columns and keep colors", () => {
  assert.equal(width("中a\x1b[31mb\x1b[0m"), 4);
  assert.equal(width("✅ ok 🚀"), 8);
  assert.equal(width(safe("⚠\ufe0f done")), 6);
  for (const max of [0, 1, 2, 3, 5, 8]) assert(width(truncate("进程 48213 等工具 \x1b[33mread\x1b[0m", max)) <= max);
  const line = "ab中文\x1b[32mgreen\x1b[0mz";
  for (const [a, b] of [[0, 3], [2, 4], [3, 5], [3, 9], [5, 20]]) assert.equal(width(slice(line, a, b)), b - a);
  assert.equal(plain(slice(line, 3, 9)), " 文gre");
});
