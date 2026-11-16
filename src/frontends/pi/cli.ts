#!/usr/bin/env node
// Starts the user's own Pi with the A-tether extension. Never installs Pi.
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { displayPath, loadSettings, saveToken } from "../../shared/settings.ts";

const extension = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./extension.ts" : "./extension.js", import.meta.url));
const subcommands = new Set(["install", "remove", "uninstall", "update", "list", "config", "auth", "mcp"]);
const windows = process.platform === "win32";

function executable(file: string) {
  try {
    if (!statSync(file).isFile()) return false;
    if (!windows) accessSync(file, constants.X_OK);
    return true;
  } catch { return false; }
}

export function findPi(env: NodeJS.ProcessEnv = process.env, configured = loadSettings().client.pi) {
  if (configured) return executable(configured) ? configured : undefined;
  const names = windows ? ["pi.cmd", "pi.exe", "pi"] : ["pi"];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const file = join(dir, name);
      if (executable(file)) return file;
    }
  }
}

export function piArgs(args: string[]) {
  if (args.length && subcommands.has(args[0])) return args;
  const hasModel = args.some(arg => arg === "--model" || arg.startsWith("--model="));
  return ["-e", extension, ...(hasModel ? [] : ["--model", "a-tether/default"]), ...args];
}

export function login(args: string[]) {
  if (args.length !== 1) throw new Error("用法：npx -y @a-tether/pi login <令牌>\n令牌在 C 上运行 npx -y @a-tether/server token 查看。");
  saveToken(args[0]);
  return [
    `令牌已保存到 ${displayPath}。`,
    "接下来在项目目录运行 pi（已用 pi install npm:@a-tether/pi 安装插件时）或 npx -y @a-tether/pi，",
    "在 Pi 中运行 /a-tether-status 检查连接。",
  ].join("\n");
}

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "login") {
    try { console.log(login(argv.slice(1))); }
    catch (error) { console.error((error as Error).message); process.exitCode = 1; }
    return;
  }
  let pi: string | undefined;
  try { pi = findPi(); }
  catch (error) { console.error((error as Error).message); process.exit(1); }
  if (!pi) {
    console.error([
      "a-tether-pi 需要本机已安装的 Pi，但找不到 pi 命令。",
      "请先自行安装 Pi，例如：",
      "  npm install -g @earendil-works/pi-coding-agent",
      "安装后确认 `pi --version` 可以运行，再重新执行 a-tether-pi。",
      `如果 pi 不在 PATH 中，可在 ${displayPath} 的 client.pi 填写它的绝对路径。`,
    ].join("\n"));
    process.exit(1);
  }
  const args = piArgs(argv);
  // Windows .cmd shims can only be started through a shell.
  const shell = windows && /\.cmd$/i.test(pi);
  const quote = (value: string) => shell ? `"${value.replace(/"/g, '""')}"` : value;
  const child = spawn(quote(pi), args.map(quote), {stdio: "inherit", shell});
  // The terminal already delivers Ctrl+C to Pi; forwarding it would count twice.
  process.on("SIGINT", () => {});
  for (const signal of ["SIGTERM", "SIGHUP"] as const) process.on(signal, () => child.kill(signal));
  child.on("error", error => { console.error("无法启动 Pi：" + error.message); process.exit(1); });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    } else process.exit(code ?? 1);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === (await import("node:fs")).realpathSync(process.argv[1])) main();
