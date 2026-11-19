#!/usr/bin/env node
import { claudeCode } from "./backends/claude-code/index.ts";
import { execFileSync } from "node:child_process";
import { runServer } from "./server/http.ts";
import { tuiConsole } from "./server/tui.ts";
import { displayPath, generateToken, loadSettings, loginCommand, saveToken } from "./shared/settings.ts";
import { isVersionFlag, version } from "./shared/version.ts";

const showToken = "npx -y @a-tether/server token";

// A job started in the background (`a-tether-server &`) must not take the terminal: the
// TUI's raw mode would stop it with SIGTTOU. Its process group is then not the
// terminal's foreground group. If ps cannot tell, assume the foreground.
function foreground() {
  try {
    const [group, terminal] = execFileSync("ps", ["-o", "pgid=,tpgid=", "-p", String(process.pid)], {encoding: "utf8", timeout: 3000})
      .trim().split(/\s+/).map(Number);
    return !(group > 0 && terminal > 0) || group === terminal;
  } catch { return true; }
}

function main(args: string[]) {
  // Before reading settings, so a broken settings.json still shows the version.
  if (isVersionFlag(args)) return console.log("a-tether-server " + version);
  const settings = loadSettings();
  if (args[0] === "token" && args.length === 1) {
    if (!settings.token) throw new Error(`还没有令牌。运行 npx -y @a-tether/server 启动服务时会自动生成并保存到 ${displayPath}。`);
    console.log(["在 A 端电脑上运行下面这行（同一台电脑上使用 Pi 无需运行）：", "", "  " + loginCommand(settings.token), ""].join("\n"));
    return;
  }
  const plain = args.length === 1 && args[0] === "--plain";
  if (args.length && !plain) throw new Error([
    "用法：a-tether-server            启动服务，在终端里显示监控界面",
    "      a-tether-server --plain    启动服务，只逐行输出日志",
    "      a-tether-server token      显示 A 端的配置命令",
    "      a-tether-server --version  显示版本"].join("\n"));
  // The monitoring TUI needs a terminal on both ends; under nohup, systemd or a pipe the
  // server prints its log lines as before.
  const tui = !plain && process.stdout.isTTY && process.stdin.isTTY && process.env.TERM !== "dumb" && foreground();
  let token = settings.token;
  const fresh = !token;
  if (token) console.log(`令牌：已配置（${displayPath}）。查看 A 端配置命令：${showToken}`);
  else {
    token = generateToken();
    saveToken(token);
    console.log([
      `已生成 A-tether 令牌，保存在 ${displayPath}。`,
      "在 A 端电脑上运行一次下面这行（同一台电脑上使用 Pi 无需运行）：",
      "",
      "  " + loginCommand(token),
      "",
      `以后可运行 ${showToken} 再次查看。`,
    ].join("\n"));
  }
  const {host, port} = settings.server;
  return runServer(claudeCode, {token, host, port, console: tui ? tuiConsole({token, fresh, host, port}) : undefined});
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
