import assert from "node:assert/strict";
import test from "node:test";
import {spawn, spawnSync} from "node:child_process";
import {once} from "node:events";
import {createServer as createHttpServer} from "node:http";
import {createServer} from "node:net";
import {mkdtemp, readFile, rm, stat, writeFile, mkdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {setTimeout as delay} from "node:timers/promises";
import {isLoopback, loadSettings, saveToken, SettingsError} from "../src/shared/settings.ts";
import {findPi, login} from "../src/frontends/pi/cli.ts";
import {request} from "../src/client/http.ts";
import {header, messages, protocol} from "../src/shared/protocol.ts";
import {useHome, writeSettings} from "./helpers.ts";

const claude = fileURLToPath(new URL("./fixtures/claude.mjs", import.meta.url));
const token = "a".repeat(64);

async function home(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "a-tether-settings-"));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return dir;
}
const file = (dir: string) => join(dir, ".a-tether", "settings.json");
const read = async (dir: string) => JSON.parse(await readFile(file(dir), "utf8"));
const mode = async (path: string) => (await stat(path)).mode & 0o777;

async function freePort() {
  const socket = createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = (socket.address() as {port: number}).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  return port;
}

// Runs the C entry point with HOME pointed at dir. Stops it once it is listening.
async function runServer(dir: string, args: string[] = [], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, ["--experimental-transform-types", "src/server.ts", ...args], {
    env: {PATH: process.env.PATH, HOME: dir, TMPDIR: dir, ...env}, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; });
  child.stderr.on("data", data => { stderr += data; });
  const exited = once(child, "exit");
  let code: number | null = null;
  void exited.then(([c]) => { code = c as number | null; });
  for (let i = 0; i < 300 && code === null && !stdout.includes("listening"); i++) await delay(30);
  if (code === null) { await delay(100); child.kill("SIGTERM"); await exited; } // let lines after "listening" arrive
  return {stdout, stderr, code};
}

test("settings fall back to defaults and client.url follows server.port", async t => {
  const dir = await home(t);
  assert.deepEqual(loadSettings(file(dir)), {token: undefined,
    server: {host: "127.0.0.1", port: 7310, claude: "claude", allowUsageCredits: false, maxSessions: 16, heartbeatInterval: 10, heartbeatTimeout: 120, exitGrace: 300},
    client: {url: "http://127.0.0.1:7310", pi: undefined}});
  await writeSettings(dir, {token, server: {host: "0.0.0.0", port: 7400, claude: "/x/claude", allowUsageCredits: true, maxSessions: 4, future: 1},
    client: {pi: "/x/pi"}, unknown: true});
  const s = loadSettings(file(dir));
  assert.deepEqual(s.server, {host: "0.0.0.0", port: 7400, claude: "/x/claude", allowUsageCredits: true, maxSessions: 4,
    heartbeatInterval: 10, heartbeatTimeout: 120, exitGrace: 300});
  await writeSettings(dir, {server: {heartbeatInterval: 50}});
  assert.equal(loadSettings(file(dir)).server.heartbeatTimeout, 150, "the default timeout follows a longer interval");
  await writeSettings(dir, {server: {exitGrace: 0}});
  assert.equal(loadSettings(file(dir)).server.exitGrace, 0, "0 reclaims the processes of an A that quit at once");
  assert.deepEqual(s.client, {url: "http://127.0.0.1:7400", pi: "/x/pi"});
  await writeSettings(dir, {client: {url: "http://192.168.1.20:7310/"}});
  assert.equal(loadSettings(file(dir)).client.url, "http://192.168.1.20:7310", "S11: LAN hosts are allowed");
});

test("S4: invalid settings are rejected with the file and field named", async t => {
  const dir = await home(t);
  const cases: [unknown, RegExp][] = [
    [{token: "short"}, /token/],
    [{token: "a b".repeat(20)}, /token/],
    [{token: "令".repeat(40)}, /token/],
    [{server: {port: 0}}, /server\.port/],
    [{server: {port: "7310"}}, /server\.port/],
    [{server: {allowUsageCredits: "yes"}}, /server\.allowUsageCredits/],
    [{server: {maxSessions: 1.5}}, /server\.maxSessions/],
    [{server: {maxSessions: -1}}, /server\.maxSessions/],
    [{server: {claude: ""}}, /server\.claude/],
    [{server: {heartbeatInterval: 0}}, /server\.heartbeatInterval/],
    [{server: {heartbeatInterval: 2.5}}, /server\.heartbeatInterval/],
    [{server: {heartbeatInterval: 10, heartbeatTimeout: 15}}, /server\.heartbeatTimeout/],
    [{server: {heartbeatTimeout: "30"}}, /server\.heartbeatTimeout/],
    [{server: {exitGrace: -1}}, /server\.exitGrace/],
    [{server: {exitGrace: 3601}}, /server\.exitGrace/],
    [{server: {exitGrace: "300"}}, /server\.exitGrace/],
    [{server: []}, /server 必须是对象/],
    [{client: {url: "https://127.0.0.1:7310"}}, /client\.url/],
    [{client: {url: "http://u:p@127.0.0.1:7310"}}, /client\.url/],
    [{client: {url: "http://127.0.0.1:7310/v1"}}, /client\.url/],
    [[1], /JSON 对象/],
  ];
  for (const [data, pattern] of cases) {
    await writeSettings(dir, data);
    assert.throws(() => loadSettings(file(dir)), (e: Error) => e instanceof SettingsError && pattern.test(e.message) && e.message.includes(file(dir)), JSON.stringify(data));
  }
  await writeFile(file(dir), "{not json");
  assert.throws(() => loadSettings(file(dir)), /不是合法的 JSON/);
});

test("S3/S5: saving a token keeps other fields, creates private files and never writes a bad token", async t => {
  const dir = await home(t);
  await mkdir(join(dir, ".a-tether"), {mode: 0o755});
  saveToken(token, file(dir));
  assert.deepEqual(await read(dir), {token});
  assert.equal(await mode(join(dir, ".a-tether")), 0o700);
  assert.equal(await mode(file(dir)), 0o600);
  await writeSettings(dir, {token, server: {port: 7400}, client: {pi: "/x/pi"}});
  const next = "b".repeat(64);
  saveToken(next, file(dir));
  assert.deepEqual(await read(dir), {token: next, server: {port: 7400}, client: {pi: "/x/pi"}});
  assert.equal(await mode(file(dir)), 0o600);
  assert.throws(() => saveToken("short", file(dir)), /至少 32 个字符/);
  assert.equal((await read(dir)).token, next);
  await writeFile(file(dir), "{not json");
  assert.throws(() => saveToken(token, file(dir)), /不是合法的 JSON/);
  assert.equal(await readFile(file(dir), "utf8"), "{not json", "a broken file is never overwritten");
});

test("S5: a-tether-pi login stores the token and explains the next step", async t => {
  const dir = await home(t);
  useHome(t, dir);
  assert.match(login([token]), /已保存.*\n.*pi/s);
  assert.equal((await read(dir)).token, token);
  assert.throws(() => login([]), /用法/);
  assert.throws(() => login(["short"]), /至少 32 个字符/);
  assert.equal((await read(dir)).token, token);
});

test("S1/S2/S13: C generates a token once, prints the login command, then reuses it silently", {timeout: 30000}, async t => {
  const dir = await home(t);
  const port = await freePort();
  await mkdir(join(dir, ".a-tether"), {recursive: true});
  await writeFile(file(dir), JSON.stringify({server: {port, claude}}));
  const first = await runServer(dir);
  const saved = await read(dir);
  assert.match(saved.token, /^[0-9a-f]{64}$/);
  assert.deepEqual(saved.server, {port, claude}, "S3: other fields are kept");
  assert.equal(await mode(file(dir)), 0o600);
  assert.ok(first.stdout.includes("npx -y @a-tether/pi login " + saved.token), first.stdout);
  assert.match(first.stdout, /同一台电脑上使用 Pi 无需运行/);
  assert.match(first.stdout, /listening on 127\.0\.0\.1:/);
  assert.doesNotMatch(first.stdout, /明文/, "S14: no warning on loopback");
  const before = await readFile(file(dir), "utf8");

  const second = await runServer(dir);
  assert.equal(await readFile(file(dir), "utf8"), before, "S2: the file is not modified");
  assert.ok(!second.stdout.includes(saved.token), "S2: the token is not shown again");
  assert.match(second.stdout, /令牌：已配置/);
  assert.match(second.stdout, /npx -y @a-tether\/server token/);

  const shown = await runServer(dir, ["token"]);
  assert.equal(shown.code, 0);
  assert.ok(shown.stdout.includes("npx -y @a-tether/pi login " + saved.token));
  assert.ok(!shown.stdout.includes("listening"), "token only prints, it does not start the service");
});

test("C token subcommand without a token, bad arguments and broken settings exit without starting", {timeout: 30000}, async t => {
  const dir = await home(t);
  const none = await runServer(dir, ["token"]);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /还没有令牌/);
  const bad = await runServer(dir, ["--port", "1"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /用法/);
  await writeSettings(dir, {server: {port: 70000}});
  const before = await readFile(file(dir), "utf8");
  const broken = await runServer(dir);
  assert.equal(broken.code, 1);
  assert.match(broken.stderr, /server\.port/);
  assert.equal(await readFile(file(dir), "utf8"), before, "S4: the file is left untouched");
});

test("S12/S14: 0.1.0 variables are ignored silently and a non-loopback host is warned about", {timeout: 30000}, async t => {
  const dir = await home(t);
  const port = await freePort();
  await writeSettings(dir, {token, server: {host: "0.0.0.0", port, claude}});
  const run = await runServer(dir, [], {A_TETHER_TOKEN: "x".repeat(40), A_TETHER_PORT: "1", A_TETHER_CLAUDE: "/missing"});
  assert.match(run.stdout, new RegExp(`listening on 0\\.0\\.0\\.0:${port}`));
  assert.match(run.stdout, /令牌以明文 HTTP 传输/);
  assert.ok(!/A_TETHER/.test(run.stdout + run.stderr), "no notice about old variables");
  assert.equal((await read(dir)).token, token);
});

test("S7/S9/S10: Pi explains a missing or wrong token and picks up login without restarting", async t => {
  const dir = await home(t);
  useHome(t, dir);
  const good = "c".repeat(64);
  const server = createHttpServer((req, res) => {
    const ok = req.headers.authorization === "Bearer " + good;
    res.writeHead(ok ? 200 : 401, {"content-type": "application/json", [header.protocol]: protocol}).end(JSON.stringify(ok ? {loggedIn: true} : {code: "unauthorized"}));
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const url = "http://127.0.0.1:" + (server.address() as {port: number}).port;
  await writeSettings(dir, {client: {url}});
  await assert.rejects(request("/v1/health"), {message: messages.token});
  assert.match(messages.token, /npx -y @a-tether\/server token/);
  saveToken("d".repeat(64));
  await assert.rejects(request("/v1/health"), {message: messages.unauthorized});
  assert.match(messages.unauthorized, /不一致/);
  saveToken(good);
  assert.deepEqual(await (await request("/v1/health")).json(), {loggedIn: true});
  await writeFile(file(dir), "{not json");
  await assert.rejects(request("/v1/health"), /不是合法的 JSON/);
});

test("loopback detection decides the S14 warning", () => {
  for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1"]) assert.ok(isLoopback(host), host);
  for (const host of ["0.0.0.0", "192.168.1.20", "::", "127.foo.example", "example.com"]) assert.ok(!isLoopback(host), host);
});

test("S11: the launcher uses client.pi from settings.json", async t => {
  const dir = await home(t);
  useHome(t, dir);
  const pi = join(dir, "my-pi");
  await writeFile(pi, "#!/bin/sh\n", {mode: 0o755});
  await writeSettings(dir, {client: {pi}});
  assert.equal(findPi({PATH: ""}), pi);
  await writeSettings(dir, {client: {pi: join(dir, "missing")}});
  assert.equal(findPi({PATH: ""}), undefined);
});

test("a-tether-server --version works even with a broken settings.json", async t => {
  const dir = await mkdtemp(join(tmpdir(), "tether-version-"));
  t.after(() => rm(dir, {recursive: true, force: true}));
  await mkdir(join(dir, ".a-tether"));
  await writeFile(join(dir, ".a-tether", "settings.json"), "{broken");
  const expected = JSON.parse(await readFile("package.json", "utf8")).version;
  for (const flag of ["--version", "-v"]) {
    const run = spawnSync(process.execPath, ["--experimental-transform-types", "src/server.ts", flag],
      {env: {PATH: process.env.PATH, HOME: dir}, encoding: "utf8"});
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), "a-tether-server " + expected);
  }
});
