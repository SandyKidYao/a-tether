#!/usr/bin/env node
import { claudeCode } from "./backends/claude-code/index.ts";
import { runServer } from "./server/http.ts";
import { displayPath, generateToken, loadSettings, loginCommand, saveToken } from "./shared/settings.ts";

const showToken = "npx -y @a-tether/server token";

function main(args: string[]) {
  const settings = loadSettings();
  if (args[0] === "token" && args.length === 1) {
    if (!settings.token) throw new Error(`还没有令牌。运行 npx -y @a-tether/server 启动服务时会自动生成并保存到 ${displayPath}。`);
    console.log(["在 A 端电脑上运行下面这行（同一台电脑上使用 Pi 无需运行）：", "", "  " + loginCommand(settings.token), ""].join("\n"));
    return;
  }
  if (args.length) throw new Error("用法：a-tether-server        启动服务\n      a-tether-server token  显示 A 端的配置命令");
  let token = settings.token;
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
  return runServer(claudeCode, {token, host: settings.server.host, port: settings.server.port});
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
