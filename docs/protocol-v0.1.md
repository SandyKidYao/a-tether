# A-tether v0.1 内部协议

## Claude Code 适配层

C 直接启动官方 Claude Code CLI。登录检查使用 `claude auth status`。每轮请求不加载 Claude Code 的设置文件，但 `~/.claude/settings.json`（或 `CLAUDE_CONFIG_DIR` 下）`env` 中的 `CLAUDE_CODE_OAUTH_TOKEN` 会传给 CLI，使登录检查与实际请求一致；模型目录来自 stream-json 初始化响应。A 选择模型 ID 后，C 使用目录中对应的 Claude 路由发起请求。

C 为每个 Pi 会话保留一个 `claude -p` 进程，运行在私有临时目录中，stdin 保持打开，不写会话文件（设计见 [常驻会话](dev/live-session.md)）。系统提示写入权限为 0600 的文件。C 先按 Pi 的规则整理历史（跳过出错和被中止的回复，给没有结果的工具调用补结果）；新进程第一次收到的是按角色标记的完整历史文本，保留工具调用 ID，图片使用独立的图像内容块。之后请求的历史如果正好是进程已有历史的延续——补上它在等的工具结果，或在它空闲时追加新的 user 消息——就以原生形式交给同一个进程；否则用完整历史重启一个进程。进程空闲 60 分钟或超过 `server.maxSessions` 时回收。

C 关闭 CLI 内建工具、钩子、会话持久化和自动压缩（上下文由 Pi 压缩），并通过 `sdk` 类型的 MCP server 向 CLI 提供 Pi 声明的工具名称、说明和参数结构。CLI 调用工具时，C 把调用交给 A，挂起这次 MCP 调用，等 Pi 在下一轮请求中带来结果后再返回。Pi 中途修改工具集时，C 通知 CLI 重新拉取工具列表。历史记录中的工具调用和工具结果使用 Claude 实际调用的名称（`mcp__tether__` 前缀）。C 从 CLI 标准输出接收文本增量和原生工具调用，将其翻译为 Pi 事件：带前缀或不带前缀的已声明名称都还原为 Pi 名称，其他名称原样交给 Pi，由 Pi 返回“工具不存在”的结果，参数不是对象时传空对象由 Pi 校验，模型在下一轮自行纠正。A 的 Pi 执行工具后发起下一轮。

## 传输

v0.1 默认两端只使用回环地址，通过端口转发（推荐 SSH 本地端口转发）连接；C 可以用 `server.host` 改为监听局域网地址，此时令牌以明文 HTTP 传输。所有端点校验 A-tether 自身的 Bearer 令牌。Claude 登录状态仅在 C 检查。A 将上下文中的代码、命令输出及工具结果发送给 C，随后由 Claude Code 发送至模型服务。

| 接口 | 职责 |
| --- | --- |
| GET /v1/health | 报告服务状态、CLI 可用性和登录布尔值，以及常驻进程的数量和启动、复用次数 |
| GET /v1/models | 返回 C 发现的模型以及 Pi 注册模型所需的能力字段 |
| POST /v1/requests | 接受 A 生成的 UUID、模型 ID、上下文及白名单生成选项，逐行返回 JSON |
| DELETE /v1/requests/{id} | 幂等取消，触发与连接断开相同的清理 |
| POST /v1/requests/{id}/heartbeat | A 的心跳；请求不存在时返回 404 |

每行响应都带请求 ID。event 承载增量，done 承载权威的 Pi 最终消息，error 承载稳定错误码，heartbeat 是心跳。每轮恰有一个终态，提前 EOF 在 A 显示为连接中途断开。C 读完请求体就返回响应头，此后模型查找失败等所有结果都以 error 行返回。A 只将最终消息中的工具调用交给 Pi，工具结果随下一轮完整上下文提交。C 从本地目录选择模型定义和 CLI 配置，仅接受白名单字段。

### 版本与心跳

两端在每个请求和响应上都带 `a-tether-protocol` 头（当前为 `2`），值不一致时 C 返回错误码 `version`，A 显示版本不一致；两端须同时升级。

心跳独立于模型输出，用来区分「模型在长时间思考」和「连接或对端已失效」。请求没有总时长上限。C 在 POST /v1/requests 的响应头里给出 `a-tether-heartbeat-interval` 和 `a-tether-heartbeat-timeout`（毫秒，来自 C 的 `server.heartbeatInterval` 和 `server.heartbeatTimeout`），之后：

- C 每个间隔向流中写一行 `{"id","type":"heartbeat","seq","elapsed","modelIdle","clientIdle"}`：序号、请求已运行的时间、模型多久没有输出、多久前收到 A 的心跳（毫秒）。
- A 每个间隔向 POST /v1/requests/{id}/heartbeat 发一次心跳，每次最多等待一个间隔。
- A 在超过时限没有从流中收到任何字节时放弃请求，错误信息引用最后一次心跳的内容，并尽力发送 DELETE 让 C 立即清理。
- C 在超过时限没有收到 A 的心跳时以原因 `lost` 中止请求，结束 Claude 进程，日志记为 `lost: no heartbeat from A for Ns`。

连接类错误（无法连接、心跳中断、中途断开、`lost`）的提示包含 Pi 自动重试能识别的英文短语，由 Pi 按退避重发；格式错误、版本不一致等不会重试。

服务端为每个活跃请求维护 AbortController。生成过程中的取消、断连和心跳中断会结束这个会话的 Claude 进程；服务退出时结束所有进程，并等待进程组与临时目录清理。认证失败、Claude 未登录、额度耗尽和后端故障分别呈现。服务默认仅打印启动状态和监听端口。

## 联调判据

在 A 的临时项目写入随机标记，要求模型先读取标记，再基于读到的值编辑文件并用本地命令验证。核对 A 文件和命令结果、C 工作目录及子进程。分别在流式输出时取消、关闭 SSH 隧道，检查 Pi 的终态及 C 的资源清理。运行方法与验证环境见 [开发说明](dev/development.md)。
