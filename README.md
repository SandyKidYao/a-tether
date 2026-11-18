# A-tether

在电脑 A 上用 [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 开发 A 的本地项目，模型借用电脑 C 上已登录的 Claude Code。Pi 在 A 管理会话、执行工具；C 为每个 Pi 会话保留一个 Claude 进程，让模型看到原生的多轮对话和工具调用，会话空闲 60 分钟后回收。A 和 C 也可以是同一台电脑。

**数据边界**　Pi 放入上下文的代码、工具定义、工具结果和对话会发送到 C，再进入模型服务。C 不把对话写入磁盘：内容只保存在 Claude 进程的内存里，会话空闲 60 分钟、进程数超过上限或服务退出时随进程释放。Claude 登录凭据只由 C 上的官方 CLI 使用。C 端服务只打印启动状态和监听端口（第一次启动时另外打印一次新生成的令牌）；请求失败时在终端输出一行诊断（时间、请求 ID 前 8 位、错误码、Claude Code 报错末尾），不记录对话内容、工具参数或令牌。

## 准备

- 两台电脑都装好 Node.js 22.19 或更高版本，系统为 macOS 或 Linux。
- C：已登录 Claude Code，`claude auth status` 显示已登录。
- A：已安装 Pi（A-tether 不会替你安装）：`npm install -g @earendil-works/pi-coding-agent`，确认 `pi --version` 可以运行。
- 一种把 A 的本机端口转发到 C 的方式。推荐 SSH 本地端口转发，这需要 C 开着 SSH 服务。

## 第 1 步：在 C 上启动服务

```sh
npx -y @a-tether/server
```

第一次启动时，服务会生成一个令牌，保存到 C 的 `~/.a-tether/settings.json`，并打印一行给 A 用的命令：

```text
已生成 A-tether 令牌，保存在 ~/.a-tether/settings.json。
在 A 端电脑上运行一次下面这行（同一台电脑上使用 Pi 无需运行）：

  npx -y @a-tether/pi login 3f9a…（64 位令牌）
```

复制这行命令，第 3 步要用。以后再启动会直接沿用这个令牌，不再显示。忘了令牌时，在 C 上运行 `npx -y @a-tether/server token` 再看一次。

服务默认监听 `127.0.0.1:7310`。保持这个终端运行，按 Ctrl+C 停止。长期使用可以全局安装：`npm install -g @a-tether/server`，之后直接运行 `a-tether-server`。

## 第 2 步：在 A 上建立到 C 的端口转发

把 `user@C` 换成你的 SSH 用户名和 C 的主机名或 IP。首次连接时核对主机密钥指纹。保持这个终端运行。

```sh
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
  -L 127.0.0.1:7310:127.0.0.1:7310 user@C
```

用其他端口转发工具时，把 A 的 `127.0.0.1:7310` 转发到 C 的 `127.0.0.1:7310` 即可。A 这边用的端口不是 7310 时，在 A 的 settings.json 里设置 `client.url`（见下文「配置文件」）。

## 第 3 步：在 A 上配置令牌（只需一次）

粘贴第 1 步打印的那行命令：

```sh
npx -y @a-tether/pi login <令牌>
```

令牌保存在 A 的 `~/.a-tether/settings.json`，以后换终端、重启电脑都不用再配。

## 第 4 步：在 A 上使用 Pi

把插件装进 Pi（只需一次），之后在项目目录里直接运行 `pi`：

```sh
pi install npm:@a-tether/pi
cd /path/to/your/project
pi
```

在 Pi 里用 `/model` 选择 A-tether 的模型。

也可以不安装插件，每次用 `npx -y @a-tether/pi` 启动带插件的 Pi，它默认选用 `a-tether/default`。其余参数原样传给 Pi，例如 `npx -y @a-tether/pi --model a-tether/claude-opus-5-5`。

**成功标志**：在 Pi 中运行 `/a-tether-status`，显示「C 上的 Claude Code 已登录」；再发送一句「只回复 OK」，能收到回复。按 Esc 可以取消当前请求。

## A 和 C 是同一台电脑

跳过第 2、3 步：运行 `npx -y @a-tether/server` 后，另开一个终端直接运行 `pi` 或 `npx -y @a-tether/pi`。两端读的是同一个 settings.json，服务生成的令牌插件直接就能用。

## 配置文件

两端都只读 `~/.a-tether/settings.json`，所有字段都可以省略。服务生成令牌或运行 `login` 时，会把文件权限设为 600、目录设为 700，只有你自己能读；手动创建这个文件时请同样设置。

```json
{
  "token": "由服务生成，或由 login 写入",
  "server": { "host": "127.0.0.1", "port": 7310, "claude": "/usr/local/bin/claude", "allowUsageCredits": false, "maxSessions": 16, "heartbeatInterval": 10, "heartbeatTimeout": 30 },
  "client": { "url": "http://127.0.0.1:7310", "pi": "/usr/local/bin/pi" }
}
```

| 字段 | 用在 | 说明 | 默认值 |
| --- | --- | --- | --- |
| `token` | 两端 | 两端必须相同。C 首次启动时生成，A 用 `login` 写入。 | 无 |
| `server.host` | C | 服务监听的地址。 | `127.0.0.1` |
| `server.port` | C | 服务监听的端口。 | `7310` |
| `server.claude` | C | Claude Code CLI 的路径，服务进程的 PATH 里找不到 `claude` 时填写绝对路径。 | `claude` |
| `server.allowUsageCredits` | C | Claude 账户开始使用超额计费额度时是否继续。为 `false` 时中止请求，避免产生额外费用。 | `false` |
| `server.maxSessions` | C | 同时保留的 Claude 进程数（0–256），每个约占 50 MB 内存。满了以后回收最久没用的会话，下次用到它时从完整历史重建。设为 `0` 时每次请求都用一次性进程。 | `16` |
| `server.heartbeatInterval` | C | 心跳间隔（秒，1–600）。请求进行中，C 和 A 每隔这么久互相发一次心跳，与模型有没有输出无关。 | `10` |
| `server.heartbeatTimeout` | C | 心跳时限（秒，不小于间隔的 2 倍，最多 3600）。A 这么久收不到 C 的任何数据，或 C 这么久收不到 A 的心跳，就判定连接中断并结束请求。网络抖动较多（如经中继的 VPN）时调大。 | `30`，或间隔的 3 倍（取较大者） |
| `client.url` | A | Pi 连接的地址，形如 `http://127.0.0.1:7310`。 | `http://127.0.0.1:` 加 `server.port` |
| `client.pi` | A | `npx -y @a-tether/pi` 使用的 Pi 路径，Pi 不在 PATH 里时填写绝对路径。 | 在 PATH 中查找 |

- `token`、`server.host`、`server.port` 改后需要重启服务；`server.claude`、`server.allowUsageCredits`、`server.maxSessions`、`server.heartbeatInterval`、`server.heartbeatTimeout` 在服务下一次处理请求时生效。两个心跳参数只在 C 上配置，C 随每个请求告诉 A。
- A 端的 `token`、`client.url` 在 Pi 的下一次请求时生效，不用重启 Pi；`client.pi` 在下次运行 `npx -y @a-tether/pi` 时生效。
- 文件写错（不是合法 JSON、字段类型不对）时，服务拒绝启动，Pi 报错，都会指出出错的字段。文件不会被自动覆盖。
- **监听局域网地址**：把 `server.host` 设成 `0.0.0.0` 或局域网 IP 后，A 可以不经端口转发，用 `client.url` 直接连接 C。但令牌会以明文 HTTP 在局域网里传输，同一网络中的设备都能尝试连接，服务启动时也会提醒这一点。只在可信网络里这样用。
- **一台电脑两种身份**：同一台电脑既用 `login` 连接别的 C，又在本机启动服务时，两端共用同一个 `token`，本机服务会沿用 `login` 写入的令牌。

**从 0.1.0 升级**：`A_TETHER_TOKEN`、`A_TETHER_URL`、`A_TETHER_PORT`、`A_TETHER_CLAUDE`、`A_TETHER_PI` 这几个环境变量不再生效，旧的 `~/.config/a-tether/token` 也不再读取。在 C 上启动新版服务会生成新令牌，按提示在 A 上重新 `login` 一次即可。

## 查看版本

```sh
npx -y @a-tether/server --version   # C：显示服务版本
npx -y @a-tether/pi --version       # A：显示插件版本和本机 Pi 的版本
```

`-v` 与 `--version` 相同。npx 可能一直用缓存里的旧版本，显示的不是最新版时，在包名后加 `@latest` 运行一次，例如 `npx -y @a-tether/server@latest`。用 `pi install` 安装的插件，运行 `pi update npm:@a-tether/pi` 更新。

## 故障排查

先在 Pi 中运行 `/a-tether-status`，它会显示具体原因。

连接类错误（无法连接、心跳中断、中途断开）的提示里带有 `connection error` 或 `connection lost` 字样，Pi 的自动重试会识别它们并按退避重发；其他错误不会自动重试。

| 现象 | 处理 |
| --- | --- |
| 「还没有配置令牌」 | 在 C 上运行 `npx -y @a-tether/server token`，把它打印的命令拿到 A 上运行。 |
| 「令牌与 C 端不一致」 | 同上，重新 `login`。C 的 settings.json 被删除或改过令牌后会出现这个提示。 |
| 「无法连接 C 的 A-tether 服务」 | 检查 C 的服务终端和 A 的端口转发是否还在运行；A 的 `client.url` 端口要等于转发在 A 上的端口。 |
| 「已 N 秒没有收到 C 的任何数据」 | 心跳中断：网络或端口转发断了，或 C 停止响应（例如 C 进入睡眠）。提示里附有最后一次心跳的情况：「C x 秒前收到过 A 的心跳」中的 x 较大，说明 A 到 C 方向已经不通。模型长时间思考不会触发这个提示。 |
| 「与 C 的连接在响应中途断开」 | 连接被关闭，通常是端口转发断开或 C 端服务退出。 |
| 「C 超过心跳时限没有收到 A 的心跳」 | C 端判定 A 失联并结束了 Claude 进程，C 日志中对应请求为 `lost: no heartbeat from A`。 |
| 「版本不一致」 | 两端必须使用同一版本，按「查看版本」一节检查并升级。 |
| `/model` 提示 `Could not refresh a-tether` | 同「无法连接」，用 `/a-tether-status` 查看具体原因。 |
| C 上找不到 Claude Code 或未登录 | 在运行服务的 C 账户里运行 `claude auth status`。PATH 不同时，在 C 的 settings.json 里设置 `server.claude` 为绝对路径，然后重启服务。 |
| 后端错误或无模型目录 | 看 C 服务终端里对应请求 ID 的诊断行。检查 C 能访问模型服务、`claude` 能正常运行，以及 C 是否设置了自定义后端地址或非 Claude 登录的认证变量。 |
| 模型服务繁忙 | 上游过载或返回 5xx，稍后重试。 |
| 额度、速率或计费限制 | 在 C 的 Claude Code 里查看账户用量。需要使用超额额度时，把 `server.allowUsageCredits` 设为 `true`。 |
| 超出上下文长度或请求超限 | 在 Pi 中压缩上下文，或减少图片和工具输出。单次请求上限 32 MiB。 |
| C 日志出现 `stale-catalog` | 刷新模型目录时 `claude auth status` 超时或失败，服务继续使用上次的目录，10 秒后重试。频繁出现时检查 C 的负载和 CLI。 |

## 已知限制

- 单次模型请求没有时长上限，模型可以长时间思考。连接是否存活由心跳判断（见「配置文件」中的 `server.heartbeatInterval`）。
- Claude 进程只能接着 Pi 的历史往下走。Pi 压缩上下文、切换分支、编辑或重试消息、换模型或推理强度、修改系统提示，以及按 Esc 取消之后，C 会用完整历史重新启动一个进程，这一轮会慢一些。
- 0.1.1 已在两台电脑之间按本文步骤完成端到端验证（初始化、login、真实对话）。SSH 隧道断线时的处理在同一台 Mac 上用独立进程验证过。Windows 不在支持范围内。
- 停止服务请用 Ctrl+C 或 SIGTERM，服务会清理正在运行的 Claude 进程和临时文件。

## 开发

参与开发 A-tether 本身，见 [开发说明](docs/dev/development.md)、[发布流程](docs/dev/release.md) 和 [协议说明](docs/protocol-v0.1.md)。

## 许可

[MIT](LICENSE)
