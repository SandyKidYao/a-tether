# A 和 C 配置速查

连接路径为 `A 的 Pi → A 的 127.0.0.1:7311 → SSH → C 的 127.0.0.1:7310 → Claude Code`。两端使用同一版本的 A-tether。开发项目只需放在 A。进入 Pi 上下文的代码和工具结果会发送到 C 及模型服务。

以下命令适用于 macOS 的 zsh 或 Linux 的 bash。两端准备 Node.js 22.19+ 和本项目源码。已验证 Pi 1.5.0、Claude Code 2.1.323、Node.js 22.23.4。C 需要运行 SSH 服务并允许本地端口转发。

## 1. 在 C 启动服务

在 C 的 A-tether 源码目录运行。用自己的账号先完成 Claude Code 登录，确认同一终端中的 `claude auth status` 显示已登录。

```sh
npm ci --omit=dev
mkdir -p ~/.config/a-tether
if [ ! -e ~/.config/a-tether/token ]; then
  (umask 077; set -C; openssl rand -hex 32 > ~/.config/a-tether/token)
fi
export A_TETHER_TOKEN="$(cat ~/.config/a-tether/token)"
npm run server
```

下次启动 C 服务时，在同一终端重新导出令牌，再运行 `npm run server`。服务启动时显示 Claude 登录状态，并监听 `127.0.0.1:7310`。可通过 `A_TETHER_PORT` 修改 C 的端口。

## 2. 在 A 建立 SSH 隧道

将示例中的 `user@C` 换为你的 SSH 用户名和 C 的主机名或局域网地址。首次连接时核对主机密钥指纹。此终端保持运行。

```sh
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
  -L 127.0.0.1:7311:127.0.0.1:7310 user@C
```

## 3. 在 A 的项目里启动 Pi

在 A 另开终端，从 **A-tether 源码目录**运行。把 `user@C` 换成上一步的 SSH 目标，把 `/path/to/your/project` 换成 A 上要开发的项目目录。

```sh
npm ci
TETHER_ROOT="$PWD"
export A_TETHER_URL=http://127.0.0.1:7311
export A_TETHER_TOKEN="$(ssh user@C 'cat ~/.config/a-tether/token')"
cd /path/to/your/project
"$TETHER_ROOT/node_modules/.bin/pi" -e "$TETHER_ROOT/src/frontends/pi/extension.ts" --model a-tether/default
```

进入 Pi 后可用 `/model` 切换 A-tether 模型，按 Esc 取消当前请求。已有 Pi 1.5.0 的用户也可运行 `pi install /absolute/path/to/a-tether` 持久安装扩展。

**成功标志**　在 Pi 中运行 `/a-tether-status` 显示 C 已登录，再发送一句“只回复 OK”，能收到模型回复。若连接中断，先检查 C 服务和 A 的隧道终端是否仍在运行；认证失败时，重新从 C 读取令牌并重启 Pi。更多检查见 [README](../README.md#故障排查)。
