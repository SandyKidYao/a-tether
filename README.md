# A-tether

在电脑 A 上用 [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 开发 A 的本地项目，模型借用电脑 C 上已登录的 Claude Code。Pi 在 A 管理会话、执行工具；C 为每个 Pi 会话保留一个 Claude 进程，让模型看到原生的多轮对话和工具调用，会话空闲 60 分钟后回收。A 和 C 也可以是同一台电脑。

**数据边界**　Pi 放入上下文的代码、工具定义、工具结果和对话会发送到 C，再进入模型服务。C 不把对话写入磁盘：内容只保存在内存里，一份在 Claude 进程中，一份在 C 的服务进程中（这样 A 每轮只需上传新增的内容）。会话空闲 60 分钟、进程数或内存超过上限、服务退出时释放。Claude 登录凭据只由 C 上的官方 CLI 使用。A 的每个请求带一个随机客户端 ID（每个 Pi 进程一个，不保存）和 A 的主机名，供 C 的监控界面区分不同的 A；Pi 开着时 A 每隔几秒向 C 发一次很小的心跳。C 端服务在终端里显示监控界面（见「C 端监控界面」），界面上只有请求 ID、模型、计数、工具名、错误码这类元数据；不在终端里运行时只打印启动状态和监听端口（第一次启动时另外打印一次新生成的令牌），请求失败时输出一行诊断（时间、请求 ID 前 8 位、错误码、Claude Code 报错末尾）。两种方式都不显示、不记录对话内容和工具参数；令牌只在第一次启动时显示一次，以后在监控界面里按 `t` 再按 `r` 才显示。

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

之后进入监控界面，能看到连进来的 A、C 上的 Claude 进程和正在进行的请求（见「C 端监控界面」）。第一次启动时界面会先弹出这行命令；以后按 `t` 再看。

服务默认监听 `127.0.0.1:7310`。保持这个终端运行，按 `q` 或 Ctrl+C 停止。长期使用可以全局安装：`npm install -g @a-tether/server`，之后直接运行 `a-tether-server`。

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

**成功标志**：Pi 底部状态栏显示「A-tether ● 已连接」和延迟；发送一句「只回复 OK」，能收到回复。按 Esc 可以取消当前请求。

状态栏一直显示 A 到 C 的链接状态：已连接、网络不稳、上传中、重连中、无法连接，或 C 拒绝的原因（令牌、版本、Claude 未登录）。运行 `/a-tether-status` 做一次链路体检：C 的登录状态、两端版本、延迟，以及不同大小请求的耗时和上下行速度。弱网下它要跑一分钟左右。

**网络不稳时**　连接断开不会让这一轮作废。模型在 C 上继续生成，A 自动重连后从断点接着显示，状态栏期间显示「重连中」。A 连续 2 分钟（`server.heartbeatTimeout`）连不上才报错，交给 Pi 自动重试；如果这时回复已经在 C 上生成完，重试会直接拿到它，不再生成一遍。

## A 和 C 是同一台电脑

跳过第 2、3 步：运行 `npx -y @a-tether/server` 后，另开一个终端直接运行 `pi` 或 `npx -y @a-tether/pi`。两端读的是同一个 settings.json，服务生成的令牌插件直接就能用。

## 配置文件

两端都只读 `~/.a-tether/settings.json`，所有字段都可以省略。服务生成令牌或运行 `login` 时，会把文件权限设为 600、目录设为 700，只有你自己能读；手动创建这个文件时请同样设置。

```json
{
  "token": "由服务生成，或由 login 写入",
  "server": { "host": "127.0.0.1", "port": 7310, "claude": "/usr/local/bin/claude", "allowUsageCredits": false, "maxSessions": 16, "heartbeatInterval": 10, "heartbeatTimeout": 120, "exitGrace": 300 },
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
| `server.heartbeatInterval` | C | 心跳间隔（秒，1–600）。Pi 开着时 A 每隔这么久向 C 发一次心跳；请求进行中 C 也每隔这么久向 A 发一次，与模型有没有输出无关。 | `10` |
| `server.heartbeatTimeout` | C | 失联时限（秒，不小于间隔的 2 倍，最多 3600）。连接断开后 A 会一直重连；累计这么久收不到 C 的数据，A 才放弃这次请求。C 这么久收不到 A 的心跳，就结束这次请求和它的 Claude 进程。调大能扛更久的断网，代价是 A 崩溃或断电时，C 会多生成这么久没人要的内容。 | `120`，或间隔的 3 倍（取较大者） |
| `server.exitGrace` | C | Pi 退出后，它的空闲 Claude 进程再保留多久（秒，0–3600）。期间重开 Pi 续同一个会话还能复用进程。`0` 表示立即结束。进程池满时，这些进程先于其他进程被回收。 | `300` |
| `client.url` | A | Pi 连接的地址，形如 `http://127.0.0.1:7310`。 | `http://127.0.0.1:` 加 `server.port` |
| `client.pi` | A | `npx -y @a-tether/pi` 使用的 Pi 路径，Pi 不在 PATH 里时填写绝对路径。 | 在 PATH 中查找 |

- `token`、`server.host`、`server.port` 改后需要重启服务；`server.claude`、`server.allowUsageCredits`、`server.maxSessions`、`server.heartbeatInterval`、`server.heartbeatTimeout`、`server.exitGrace` 在服务下一次处理请求时生效。两个心跳参数只在 C 上配置，C 随每个请求和每次心跳告诉 A。
- A 端的 `token`、`client.url` 在 Pi 的下一次请求时生效，不用重启 Pi；`client.pi` 在下次运行 `npx -y @a-tether/pi` 时生效。
- 文件写错（不是合法 JSON、字段类型不对）时，服务拒绝启动，Pi 报错，都会指出出错的字段。文件不会被自动覆盖。
- **监听局域网地址**：把 `server.host` 设成 `0.0.0.0` 或局域网 IP 后，A 可以不经端口转发，用 `client.url` 直接连接 C。但令牌会以明文 HTTP 在局域网里传输，同一网络中的设备都能尝试连接，服务启动时也会提醒这一点。只在可信网络里这样用。
- **一台电脑两种身份**：同一台电脑既用 `login` 连接别的 C，又在本机启动服务时，两端共用同一个 `token`，本机服务会沿用 `login` 写入的令牌。

**从 0.3.x 升级**：协议升到 4（请求可以断线续传，上下文只传新增部分），A 和 C 要一起升级，否则 Pi 提示版本不一致，并写出两端各自的版本。`server.heartbeatTimeout` 的默认值从 30 秒改为 120 秒，含义见上表。

**从 0.2.x 升级**：协议升到 3（A 的请求多了客户端 ID 和主机名），A 和 C 要一起升级，否则 Pi 提示「版本不一致」。

**从 0.1.0 升级**：`A_TETHER_TOKEN`、`A_TETHER_URL`、`A_TETHER_PORT`、`A_TETHER_CLAUDE`、`A_TETHER_PI` 这几个环境变量不再生效，旧的 `~/.config/a-tether/token` 也不再读取。在 C 上启动新版服务会生成新令牌，按提示在 A 上重新 `login` 一次即可。

## C 端监控界面

在终端里启动服务后进入全屏界面，每秒刷新：

- **状态**：进程池占用、今天的请求数和失败数、进程复用率、模型目录、心跳参数、Claude 进程占用的内存，以及「缓存」：C 的服务进程为各个 A 保留的上下文和还没被取走的回复。
- **A 端**：最近 30 分钟连过来的 A（按 Pi 进程区分，显示主机名），各自的状态、延迟、有几个请求在进行、占了几个进程。状态有四种：**请求中**；**空闲**（Pi 开着，心跳正常）；**失联**（连续 3 次心跳没到，网络断了或 Pi 被强行结束）；**已退出**（Pi 正常退出时通知了 C）。延迟是 A 测得的一次心跳往返。
- **Claude 进程**：每个进程的状态（生成中、等工具、空闲）、所属的 A、模型、持有的历史条数、在等哪些工具的结果、多久后被回收。
- **进行中的请求**：用的哪个进程、进程是复用的还是新启动的、已运行多久、模型多久没输出、A 的连接是否还在。A 的连接断开时显示「已断开，等待重连」，请求照常进行；A 失联快到时限时标红，并显示多久后放弃。
- **最近动作**：请求开始和结束、进程启动和回收、A 第一次连接和退出、重放已生成的回复、出错。出错行与不在终端里运行时的诊断行内容相同。

| 按键 | 作用 |
| --- | --- |
| Tab、1–4 | 切换面板 |
| ↑ ↓ | 选择行；在最近动作里向前翻 |
| Enter | 查看详情 |
| `x` | 结束选中的 Claude 进程（要确认）。它在处理的请求会失败，A 下次请求时从完整历史重建 |
| `c` | 取消选中的请求（要确认），A 会收到「请求已取消」 |
| `f`、空格 | 筛选最近动作、暂停滚动 |
| `t` | 显示 A 端的 login 命令，令牌打码，按 `r` 显示 |
| `?` | 帮助 |
| `q`、Ctrl+C | 停止服务。有请求在进行时先确认；停止卡住时再按一次 Ctrl+C 立即退出 |

退出后，这次运行中出现过的错误会留在终端里。用 nohup、systemd、`&` 后台运行或把输出重定向到文件时不进入界面，照旧逐行输出；也可以用 `a-tether-server --plain` 强制逐行输出。终端小于 80×24 时界面提示放大窗口。

## 查看版本

```sh
npx -y @a-tether/server --version   # C：显示服务版本
npx -y @a-tether/pi --version       # A：显示插件版本和本机 Pi 的版本
```

`-v` 与 `--version` 相同。npx 可能一直用缓存里的旧版本，显示的不是最新版时，在包名后加 `@latest` 运行一次，例如 `npx -y @a-tether/server@latest`。用 `pi install` 安装的插件，运行 `pi update npm:@a-tether/pi` 更新。

## 故障排查

先在 Pi 中运行 `/a-tether-status`，它会显示具体原因。

连接类错误的提示里带有 `connection error` 或 `connection lost` 字样，Pi 的自动重试会识别它们并按退避重发；其他错误不会自动重试。连接中途断开时插件先自己重连，重连期间不报错，只在状态栏显示。

| 现象 | 处理 |
| --- | --- |
| 「还没有配置令牌」 | 在 C 上运行 `npx -y @a-tether/server token`，把它打印的命令拿到 A 上运行。 |
| 「令牌与 C 端不一致」 | 同上，重新 `login`。C 的 settings.json 被删除或改过令牌后会出现这个提示。 |
| 「无法连接 C 的 A-tether 服务」 | 检查 C 的服务终端和 A 的端口转发是否还在运行；A 的 `client.url` 端口要等于转发在 A 上的端口。 |
| 「已 N 秒没有收到 C 的任何数据，重连也没有成功」 | 断网超过了失联时限：网络或端口转发断了，或 C 停止响应（例如 C 进入睡眠）。提示里附有最后一次心跳的情况：「C x 秒前收到过 A 的心跳」中的 x 较大，说明 A 到 C 方向已经不通。模型长时间思考不会触发这个提示。网络恢复后重发即可。 |
| 「C 上已经没有这次请求」 | A 重连上了，但 C 重启过，或 A 失联太久已被 C 放弃。重发即可。 |
| 「C 超过时限没有收到 A 的任何消息」 | C 端判定 A 失联并结束了 Claude 进程，C 日志中对应请求为 `lost: no heartbeat from A`。 |
| 「收到的不是 A-tether 服务的响应（HTTP nnn）」 | 回答请求的不是 C 的 A-tether 服务，而是端口转发、代理，或别的程序。检查 `client.url` 指向的地址和端口。 |
| 「版本不一致」 | 两端必须使用同一版本。提示里写了两端各自的版本，把旧的一端升级。 |
| 状态栏显示「网络不稳」，每轮开始都要等好几秒，或总在重连 | 运行 `/a-tether-status`。出现「链路很可能在丢弃大包」时见下面的「大包被丢弃」。 |
| 「心跳能到 C，但稍大的请求过不去」 | 链路在丢弃大包，而这台电脑不会自动改用小包。见下面的「大包被丢弃」。这个错误不会自动重试：不改 MTU，重发也过不去。 |
| `/model` 提示 `Could not refresh a-tether` | 同「无法连接」，用 `/a-tether-status` 查看具体原因。 |
| C 上找不到 Claude Code 或未登录 | 在运行服务的 C 账户里运行 `claude auth status`。PATH 不同时，在 C 的 settings.json 里设置 `server.claude` 为绝对路径，然后重启服务。 |
| 后端错误或无模型目录 | 看 C 服务终端里对应请求 ID 的诊断行。检查 C 能访问模型服务、`claude` 能正常运行，以及 C 是否设置了自定义后端地址或非 Claude 登录的认证变量。 |
| 模型服务繁忙 | 上游过载或返回 5xx，稍后重试。 |
| 额度、速率或计费限制 | 在 C 的 Claude Code 里查看账户用量。需要使用超额额度时，把 `server.allowUsageCredits` 设为 `true`。 |
| 超出上下文长度或请求超限 | 在 Pi 中压缩上下文，或减少图片和工具输出。单次请求上限 32 MiB。 |
| C 日志出现 `stale-catalog` | 刷新模型目录时 `claude auth status` 超时或失败，服务继续使用上次的目录，10 秒后重试。频繁出现时检查 C 的负载和 CLI。 |

### 大包被丢弃

经 ZeroTier 这类虚拟局域网连接 C 时，可能出现小请求正常、稍大的请求每次先卡几秒甚至失败的情况。原因是虚拟网卡的 MTU（一个包的最大字节数，ZeroTier 默认 2800）比实际链路能通过的大，大包在路上被丢弃，系统要重试几秒后才改用小包。两台电脑之间没有打通直连、流量经中继转发时尤其常见（`zerotier-cli peers` 里对端显示 `RELAY`）。

确认方法：`/a-tether-status` 提示「链路很可能在丢弃大包」；或者在 A 上对 C 的地址发不同大小的 ping，小的通、大的不通：

```sh
ping -c 3 -s 1000 <C 的地址>   # 通
ping -c 3 -s 1400 <C 的地址>   # 不通
```

有的系统发现大包不通后会自己改用小包（macOS 如此，表现为每个新连接先卡几秒）；有的不会（实测 Windows 如此，表现为心跳正常、状态栏显示上传没有回应，随后报「心跳能到 C，但稍大的请求过不去」），这时对话完全无法进行。

处理方法是把虚拟网卡的 MTU 调小到 1280，只在 A 或 C 一端改也有效。下面的命令重启后失效，ZeroTier 刷新配置时也可能把它改回去；要长期生效，需要在 ZeroTier 一侧调小这个网络的 MTU，做法见 ZeroTier 的文档。`<网卡>` 用 `ifconfig` 或 `ip addr` 查看，是带有 C 所在网段地址的那一个。

```sh
sudo ifconfig <网卡> mtu 1280         # macOS
sudo ip link set dev <网卡> mtu 1280  # Linux
```

Windows 用管理员终端，网卡名取第一条命令输出里 ZeroTier 的那一行：

```bat
netsh interface ipv4 show subinterfaces
netsh interface ipv4 set subinterface "<网卡名>" mtu=1280 store=persistent
```

改完再运行 `/a-tether-status`，提示消失就是生效了。调小之后，上面那条 1400 字节的 ping 在本机就会被拒绝，不能再用它验证。能让两台电脑打通直连的话，延迟和丢包也会一起改善。

## 已知限制

- 单次模型请求没有时长上限，模型可以长时间思考。连接是否存活由心跳判断（见「配置文件」中的 `server.heartbeatInterval`）。
- 断线续传覆盖的是回复的下行。第一次请求、Pi 压缩上下文之后、C 重启之后，A 要把完整上下文上传一次，这次上传中途断开只能从头重传。
- Claude 进程只能接着 Pi 的历史往下走。Pi 压缩上下文、切换分支、编辑或重试消息、换模型或推理强度、修改系统提示，以及按 Esc 取消之后，C 会用完整历史重新启动一个进程，这一轮会慢一些。
- 0.1.1 已在两台电脑之间按本文步骤完成端到端验证（初始化、login、真实对话）。断线、丢包、大包被丢弃等弱网情况用本机的故障代理验证（见 [开发说明](docs/dev/development.md)），没有在真实的跨网链路上逐项验证。Windows 不在支持范围内。
- 停止服务请用 `q`、Ctrl+C 或 SIGTERM，服务会清理正在运行的 Claude 进程和临时文件。

## 开发

参与开发 A-tether 本身，见 [开发说明](docs/dev/development.md)、[发布流程](docs/dev/release.md) 和 [协议说明](docs/protocol-v0.1.md)。

## 许可

[MIT](LICENSE)
