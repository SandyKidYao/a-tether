// Long-lived Claude processes (docs/dev/live-session.md), driven through the offline
// fixture tests/fixtures/live-claude.mjs.
import test, {type TestContext} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {setTimeout as delay} from "node:timers/promises";
import {normalizeContext, type AssistantMessage, type Message, type SimpleStreamOptions, type Tool} from "@earendil-works/pi-ai";
import {streamClaudeCode} from "../src/backends/claude-code/claude-turn.ts";
import {livePool, setIdleTimeout, shutdownLive} from "../src/backends/claude-code/live.ts";
import {normalizeMessages} from "../src/backends/claude-code/transcript.ts";
import {api, defaultUrl, providerId} from "../src/shared/protocol.ts";
import {useHome, writeSettings} from "./helpers.ts";

const fixture = fileURLToPath(new URL("./fixtures/live-claude.mjs", import.meta.url));
const model = {id: "test", name: "test", api, provider: providerId, baseUrl: defaultUrl, maxTokens: 256, contextWindow: 1000,
  cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, reasoning: true, input: ["text" as const, "image" as const]};
const bash: Tool = {name: "bash", description: "Run a command", parameters: {type: "object"} as Tool["parameters"]};
const read: Tool = {name: "read", description: "Read a file", parameters: {type: "object"} as Tool["parameters"]};
const user = (content: string): Message => ({role: "user", content, timestamp: 0});
const result = (toolCallId: string, text: string): Message =>
  ({role: "toolResult", toolCallId, toolName: "bash", content: [{type: "text", text}], isError: false, timestamp: 0});

async function setup(t: TestContext, server: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "tether-live-"));
  const log = join(dir, "log.jsonl");
  const previous = process.env.TEST_LOG;
  process.env.TEST_LOG = log;
  useHome(t, dir);
  await writeSettings(dir, {server: {claude: fixture, ...server}});
  t.after(async () => {
    await shutdownLive();
    setIdleTimeout(60 * 60_000);
    if (previous === undefined) delete process.env.TEST_LOG; else process.env.TEST_LOG = previous;
    await rm(dir, {recursive: true, force: true});
  });
  const entries = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).map(line => JSON.parse(line));
  return {entries, starts: async () => (await entries()).filter(e => e.event === "start")};
}
async function turn(tools: Tool[], messages: Message[], options: SimpleStreamOptions = {}) {
  const stream = streamClaudeCode(model, normalizeContext({systemPrompt: "Be brief.", tools, messages}), options);
  for await (const _ of stream);
  return stream.result();
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(predicate: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await delay(20); }
  assert.fail("Timed out waiting for condition");
}

test("one process carries a conversation through tool calls and later user messages", async t => {
  const {entries, starts} = await setup(t);
  const history: Message[] = [user("CALL something")];
  const m1 = await turn([bash], history);
  assert.equal(m1.stopReason, "toolUse", m1.errorMessage);
  const call = m1.content.find(b => b.type === "toolCall")!;
  assert.equal(call.type === "toolCall" && call.name, "bash");
  // Per-call usage from message_delta, not the turn total in `result`.
  assert.deepEqual([m1.usage.input, m1.usage.cacheWrite, m1.usage.output], [10, 3, 5]);
  assert.equal(livePool().length, 1);
  assert.equal(livePool()[0].state, "awaitingTools");

  // Pi's edit tool can rewrite a call's arguments in place; matching must not care.
  if (call.type === "toolCall") call.arguments = {command: "ls -la"};
  history.push(m1, result(call.id, "file.txt"));
  const m2 = await turn([bash], history);
  assert.equal(m2.stopReason, "stop", m2.errorMessage);
  assert.deepEqual(m2.content.filter(b => b.type === "text").map(b => b.type === "text" && b.text), ["tool said file.txt"]);

  history.push(m2, user("hello"));
  await until(() => livePool()[0]?.state === "idle");
  const m3 = await turn([bash], history);
  assert.equal(m3.stopReason, "stop", m3.errorMessage);

  const log = await entries();
  assert.equal((await starts()).length, 1);
  const [start] = await starts();
  assert.deepEqual([start.mcp.mcpServers.tether.type, start.allowed, start.compact], ["sdk", "mcp__tether", "1"]);
  const users = log.filter(e => e.event === "user");
  assert.equal(users.length, 2);
  assert.match(users[0].content[0].text, /"role":"user"/, "a new process gets the history as records");
  assert.deepEqual(users[1].content, [{type: "text", text: "hello"}], "later messages arrive as native content");
  assert.deepEqual(log.find(e => e.event === "result").result, {content: [{type: "text", text: "file.txt"}]});
});

test("a changed tool set reloads the tools; changed history or effort starts a new process", async t => {
  const {entries, starts} = await setup(t);
  const history: Message[] = [user("hello")];
  const m1 = await turn([bash], history);
  history.push(m1, user("again"));
  await until(() => livePool()[0]?.state === "idle");
  await turn([bash, read], history);
  assert.equal((await starts()).length, 1);
  const log = await entries();
  assert(log.some(e => e.event === "notification" && e.method === "notifications/tools/list_changed"));
  assert.deepEqual(log.filter(e => e.event === "tools").at(-1).tools, ["bash", "read"]);

  await turn([bash, read], [user("edited"), m1, user("again")]);
  assert.equal((await starts()).length, 2, "a history that is not a continuation rebuilds");
  await turn([bash, read], [user("hello")], {reasoning: "high"});
  const all = await starts();
  assert.equal(all.length, 3, "a different effort rebuilds");
  assert.equal(all[2].effort, "high");
});

test("cancelling kills the process, and the next request skips the aborted reply and rebuilds", async t => {
  const {entries, starts} = await setup(t);
  const controller = new AbortController();
  const pending = turn([bash], [user("SLOW")], {signal: controller.signal});
  await until(async () => (await entries()).some(e => e.event === "user"));
  const [{pid}] = await starts();
  controller.abort();
  const aborted = await pending;
  assert.equal(aborted.stopReason, "aborted");
  await until(() => !alive(pid));
  assert.equal(livePool().length, 0);

  const partial: AssistantMessage = {...aborted, content: [{type: "text", text: "half-written"}]};
  const next = await turn([bash], [user("earlier"), partial, user("hello")]);
  assert.equal(next.stopReason, "stop", next.errorMessage);
  const users = (await entries()).filter(e => e.event === "user");
  assert.equal((await starts()).length, 2);
  assert(!JSON.stringify(users.at(-1).content).includes("half-written"));
});

test("server.maxSessions bounds the pool and idle processes expire", async t => {
  await setup(t, {maxSessions: 1});
  await turn([bash], [user("first")]);
  const [first] = livePool();
  await turn([bash], [user("second")]);
  assert.deepEqual(livePool().map(p => p.pid), [livePool()[0].pid]);
  assert.notEqual(livePool()[0].pid, first.pid);
  await until(() => !alive(first.pid!));

  setIdleTimeout(100);
  await turn([bash], [user("third")]);
  const [third] = livePool();
  await until(() => livePool().length === 0 && !alive(third.pid!));
});

test("with server.maxSessions 0 every request runs in a process of its own", async t => {
  const {starts} = await setup(t, {maxSessions: 0});
  const m1 = await turn([bash], [user("hello")]);
  assert.equal(livePool().length, 0);
  await turn([bash], [user("hello"), m1, user("again")]);
  assert.equal((await starts()).length, 2);
  for (const {pid} of await starts()) await until(() => !alive(pid));
});

test("history is normalized like Pi's own providers", () => {
  const call = (id: string): AssistantMessage => ({role: "assistant", api, provider: providerId, model: "m", timestamp: 0, stopReason: "toolUse",
    usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
    content: [{type: "toolCall", id, name: "bash", arguments: {}}]});
  const failed = {...call("x"), stopReason: "error" as const, content: [{type: "text" as const, text: "partial"}]};
  const out = normalizeMessages([{role: "system", content: "s", timestamp: 0}, user("a"), call("1"), user("b"), failed, call("2")]);
  assert.deepEqual(out.map(m => m.role === "toolResult" ? `result:${m.toolCallId}:${m.isError}` : m.role),
    ["user", "assistant", "result:1:true", "user", "assistant", "result:2:true"]);
});
