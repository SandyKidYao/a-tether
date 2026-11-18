# 设计：Claude Code 常驻会话

状态：已在 0.2.0 实现（[live.ts](../../src/backends/claude-code/live.ts)、[claude-turn.ts](../../src/backends/claude-code/claude-turn.ts)、[transcript.ts](../../src/backends/claude-code/transcript.ts)）。

## 背景

C 现在每轮启动一个新的 `claude -p`，把 Pi 的整段历史序列化成 JSON 文本记录，放进一条 user 消息里（[claude-turn.ts](../../src/backends/claude-code/claude-turn.ts)）。模型看到的是“一份对话记录”：

- 自己之前的工具调用和结果只是文本，不是原生的 tool_use / tool_result 轮次；
- 两轮之间思考内容丢失，带签名的 thinking 块接不上；
- 模型会照着记录里的写法调用工具。0.1.2 修过的 “Unexpected Claude tool”，就是模型用了历史里的裸名。

**成本不是动机。** 历史只在末尾追加，前缀一直不变，提示缓存照常命中。一次 Leo 项目里的 Pi 会话，每轮缓存命中率在 77%–100% 之间，每轮新写入的缓存基本就是新增的内容。这个方案要解决的是模型表现：让 Claude 看到原生的多轮对话。

## 目标与不变的部分

- 一个 Pi 会话尽量对应 C 上一个**常驻的** Claude 进程，工具调用和结果以原生形式进入这个进程的历史。
- **A 和 C 之间的协议不变**：A 每轮仍然发送完整上下文，A 端插件不改。常驻进程是 Claude Code 后端内部的优化，任何对不上的情况都退回全量重建（也就是现在的做法）。
- **C 依然不落盘**：使用 `--no-session-persistence`。对话内容只保存在进程内存里，会话空闲 60 分钟后进程被回收，内容随之释放。README 的数据边界要相应修改。

## 方案依据：已验证的 CLI 行为

以下行为在 Claude Code 2.1.323 上用 haiku 模型实测（2026-11-18），实验脚本没有放进仓库。标“代码”的条目是从 CLI 代码里读出来的，没有实测。

| # | 行为 | 来源 |
|---|---|---|
| 1 | `--mcp-config '{"mcpServers":{"tether":{"type":"sdk","name":"tether"}}}'` 让 CLI 通过 stdout 的 `control_request`（`subtype: "mcp_message"`）把 `initialize`、`tools/list`、`tools/call` 交给宿主，宿主用 `control_response` 回复 `{mcp_response: <JSON-RPC>}`。不需要额外初始化，也不需要另起 MCP 进程 | 实测 |
| 2 | `tools/call` 可以一直不回复。挂起 15 秒、130 秒后再回复，CLI 都会接着生成 | 实测 |
| 3 | `tools/call` 的 `params._meta["claudecode/toolUseId"]` 等于模型输出里的 tool_use id | 实测 |
| 4 | 同一条消息里的多个工具调用默认**串行**发出：上一个 `tools/call` 返回后才发下一个。工具标了 `annotations.readOnlyHint` 才会并发发出 | 实测 |
| 5 | MCP 工具结果里的 `image` 块会以原生图片交给模型；`isError: true` 会变成 `is_error: true` | 实测 |
| 6 | stdin 保持打开时，一轮结束（`result`）后可以继续写入新的 user 消息，进程沿用之前的历史。stdin 空闲 200 秒后依然可用，缓存照常命中 | 实测 |
| 7 | 生成过程中发 `{"subtype":"interrupt"}`：进程不退出，历史里留下被截断的回复和一条 `[Request interrupted by user]`，`result` 为 `error_during_execution` | 实测 |
| 8 | `tools/call` 挂起时发 `interrupt`：CLI 向宿主发 `notifications/cancelled`，自动补一条“用户拒绝了这次调用”的工具结果；之后再回复这个调用会被忽略 | 实测 |
| 9 | 宿主发 `mcp_message`，内容是 `notifications/tools/list_changed`：CLI 立刻重新请求 `tools/list`，下一轮工具列表随之更新 | 实测 |
| 10 | `set_model` 可以中途换模型，但会往历史里插一条 `<local-command-stdout>Set model to …</local-command-stdout>` | 实测 |
| 11 | `--system-prompt-snapshot` 默认开启，会话期间系统提示沿用第一次请求时的记录；没有修改系统提示的控制请求 | 实测、帮助文本 |
| 12 | `sdk` 类型的 server 默认没有工具调用空闲超时（只有设置了 `CLAUDE_CODE_SDK_MCP_TOOL_IDLE_TIMEOUT` 才有）；每次调用的硬性上限默认 `1e8` 毫秒，可以用 `MCP_TOOL_TIMEOUT` 覆盖 | 代码 |
| 13 | `DISABLE_AUTO_COMPACT=1` 同时关闭自动压缩和空闲压缩（空闲压缩要求上下文至少 10 万 token）。用 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=1` 没能触发压缩，所以这一条没有实测 | 代码 |
| 14 | 空闲的常驻进程约占 50 MB 内存（macOS RSS） | 实测 |
| 15 | 即使用 `--system-prompt-file` 替换了系统提示，CLI 仍会附加一段 `# Environment`，内容是 C 的工作目录、平台、系统版本、日期 | 实测 |

和 Pi 有关的行为（pi-ai / pi-agent-core 1.5.2）：

- Pi 自带的 provider 会先用 `transformMessages` 处理历史：跳过 `stopReason` 为 `error` 或 `aborted` 的 assistant 消息；遇到没有结果的工具调用，补一条 `No result provided`（`isError: true`）。这个函数没有从 pi-ai 的入口导出。
- Pi 自动重试时，历史里已经去掉了失败的那条回复，然后重新发起同样的请求。
- 工具的 `prepareArguments` 可能**原地修改** assistant 消息里的工具参数，比如 edit 会把字符串形式的 `edits` 解析成数组。所以 Pi 发回来的 assistant 消息，不能指望和 C 当初发出的内容逐字节相同。

## 设计

### 1. 历史规范化

收到请求后，先按 Pi 的规则整理历史：跳过出错和被中止的 assistant 消息，给没有结果的工具调用补上结果。常驻模式下的匹配和重建都基于整理后的历史。

现在的无状态模式也缺这一步，被中止回复里的半截内容会被发给 Claude。这一步可以先单独上线。

### 2. 进程配置

在现有隔离参数的基础上：

- 去掉 `--max-turns 1` 和 `--permission-mode dontAsk` 的“拒绝一切”用法，改为 `--permission-mode dontAsk --allowedTools mcp__tether`，让 tether 工具可以真正调用。
- `--mcp-config` 改用 `sdk` 类型，不再另起 MCP 进程（0.1 的 `tool-catalog.mjs` 已删除）。
- stdin 保持打开（`--input-format stream-json`），新的 user 消息逐行写入。
- 环境变量增加 `DISABLE_AUTO_COMPACT=1`，`MCP_TOOL_TIMEOUT` 设为大于空闲回收时间的值（例如 2 小时）。
- 保持 `--no-session-persistence`。

### 3. 会话条目

C 为每个常驻进程维护一个条目：

| 字段 | 说明 |
|---|---|
| `consumed` | 进程已经接收或产生的消息，每条存一个标识（见第 4 节） |
| `state` | `generating` / `awaitingTools` / `finishing`（回复已结束，等 CLI 发出这一轮的 `result`）/ `idle` / `dead` |
| `pending` | `awaitingTools` 时，正在等结果的 tool_use id 列表 |
| `held` | 已经到达、还没回复的 `tools/call`，按 toolUseId 索引 |
| `buffered` | Pi 已经发来、但对应的 `tools/call` 还没到的结果，按 toolUseId 索引（见第 2 节的串行行为） |
| `systemHash`、`toolsHash`、`route`、`effort`、`maxTokens` | 启动时的参数，用来判断能不能复用 |
| `lastUsed` | 用于空闲回收和淘汰 |
| `busy` | 有请求正在使用这个条目时为真 |

### 4. 消息标识

- user、toolResult、system 消息：对规范化后的内容做哈希。
- assistant 消息：用 `responseId` 加工具调用 id 列表做标识，不比较内容（见上面 `prepareArguments` 的问题）。

### 5. 匹配规则

新请求到来时，在空闲（`busy` 为假）的条目里找 `consumed` 正好是新请求历史前缀的那一个，然后按“多出来的部分”决定怎么处理：

| 条目状态 | 多出来的部分 | 处理 |
|---|---|---|
| `awaitingTools` | 正好是 `pending` 里每个 id 的工具结果，后面没有别的消息 | 交回结果，继续生成 |
| `idle` | 一条或多条 user 消息 | 写入 stdin，继续生成 |
| 任意 | 上面两种都不是 | 重建 |

另外，满足下面任一条件也要重建：

- 系统提示、模型、effort、`maxTokens` 和条目启动时不同（换模型直接重建，不用 `set_model`，避免历史里多出一条说明）；
- 找不到前缀匹配的条目。

工具集变了但其他都一致时，不重建：更新条目的工具目录，发 `tools/list_changed`，等 CLI 重新拉取 `tools/list` 后再继续。

`awaitingTools` 时，如果多出来的是“补出来的结果 + 新的 user 消息”（Pi 取消了工具执行，用户又发了新消息），也要重建。原因是：结果一交回，模型就会接着这一轮往下生成，新的 user 消息只能在生成过程中插进去，和 Pi 记录的顺序不一致。

**交回工具结果**：对每个 pending 的 id，如果 `held` 里已经有对应的 `tools/call`，就直接回复；否则先放进 `buffered`，等对应的 `tools/call` 到达时再回复。Pi 工具结果里的文本和图片块，直接转成 MCP 的 `content`，`isError` 照搬。

### 6. 一次请求的生命周期

```text
请求到达 ─ 匹配 ─┬─ 复用：交回结果或写入 user 消息 ─┐
                └─ 重建：启动进程，按现有文本格式传入整理后的完整历史 ─┤
                                                              ▼
                                            state = generating，转发流式输出
                                                              │
                    ┌─ message_stop，stop_reason = tool_use
                    │     → HTTP 响应以 toolUse 结束；state = awaitingTools；pending = 这条消息里的 tool_use id
                    ├─ message_stop，其他 stop_reason
                    │     → HTTP 响应以 stop / length 结束；state = finishing，收到 result 后变为 idle
                    └─ 出错、进程退出、拒绝回答
                          → HTTP 响应以 error 结束；杀掉进程，state = dead
```

- 一次 HTTP 响应只对应一次模型调用，在这次调用的 `message_stop` 处结束（实测同一次调用的所有 `assistant` 事件都在它之前到达），不等第一个 `tools/call`。之后到达的 `tools/call` 先放进 `held`。
- 只输出完整消息、没有流式事件的 CLI 输出，在第一个 `tools/call` 或这一轮的 `result` 处结束。
- 一次响应里出现第二个 `message_start`，或者没有请求在进行时 CLI 又产生了输出，说明 CLI 没等 Pi 就自己往下走了（比如模型调用了 CLI 不认识的工具名，CLI 自己回了错误），进程作废。
- 每次响应结束时，把这次请求带来的新消息和这次产生的 assistant 消息追加到 `consumed`。
- 重建出来的进程，第一轮输入仍然是现在的文本格式；之后的轮次就是原生的了。

### 7. 取消与错误

- **Pi 在生成过程中取消**（HTTP 连接断开或收到 DELETE）：直接杀掉进程。Pi 会跳过被中止的回复，下一轮的历史和进程里的对不上，本来就要重建，所以没必要用 `interrupt` 保住进程。
- **Pi 在执行工具时取消**：这时没有 HTTP 请求在进行中。Pi 的下一个请求要么带着工具结果（报错的那种），按正常流程交回；要么带着补出来的结果加新的 user 消息，按第 5 节重建。
- **C 端出错**：最多等 1 秒，让 CLI 写完 stderr 并退出，然后杀掉进程，把错误码交给 Pi，C 的诊断日志带上退出码和 stderr 末尾。Pi 重试时会触发重建。
- **单次 HTTP 请求的 300 秒上限不变**，只针对“生成中”这段时间。进程在 `awaitingTools` 和 `idle` 状态下等待，不计入。

### 8. 回收与容量

- **空闲回收**：条目连续 60 分钟没有被使用，就杀掉进程。60 分钟和 Claude Code 的提示缓存时长一致，超过之后保留进程的收益就小了。
- **最大进程数**：新增配置项 `server.maxSessions`（0–256），默认 16，在下一次请求时生效；设为 0 时每次请求都用一次性进程。需要新建进程而数量已满时，淘汰最久没用的那个**空闲**条目。如果所有条目都在使用中，这次请求按无状态模式执行（一次性进程，用完即杀），不进入进程池。
- **服务退出**：杀掉所有常驻进程。

### 9. 并发

条目被一个请求使用期间，`busy` 为真，其他请求不能匹配它，只能重建。比如 Pi 在同一个位置分叉出两个分支，后到的那个会重建，不会影响先到的。

### 10. 上下文压缩

Pi 和 Claude Code 都会压缩上下文。常驻模式下**只由 Pi 负责**：Pi 的历史是唯一的事实来源，每轮都发送完整上下文，到了阈值照样会压缩；如果 Claude Code 也在进程里压缩，两边的历史就会各自变化、互相对不上。（Leo 把压缩交给 CLI，是因为 Leo 只发送增量，这里不适用。）

- 关闭 Claude Code 的自动压缩和空闲压缩（`DISABLE_AUTO_COMPACT=1`，见第 13 条）。如果 stdout 仍然出现 `compact_boundary`，就把进程标为 `dead`。
- Pi 压缩后历史前缀变了，按第 5 节会自然重建，不需要特殊处理。
- **usage 按单次 API 调用上报**：Pi 用上一条回复的 usage 估算上下文大小，决定要不要压缩（超过“窗口大小 − 16384”就压缩）。常驻模式下，`result` 事件汇总的是整轮所有 API 调用的用量，照搬会让 Pi 严重高估、过早压缩。要改为从流式事件（`message_start` / `message_delta`）里，取产生当前这条 assistant 消息的那次调用的 usage。
- Pi 写摘要时也会调用模型，这次请求同样经过 C。它和任何常驻进程都对不上，会新建一个进程，用完后作为空闲进程占一个名额，直到被回收或被淘汰。

### 11. 日志与数据边界

- 日志规则不变：只在失败时输出一行诊断。`/v1/health` 新增 `sessions: {processes, started, reused}`，即当前常驻进程数、累计启动和复用次数，不包含任何对话内容。live 测试用它确认整段工具循环只启动了一个进程。
- README 的数据边界改为：对话内容不写入 C 的磁盘，只保存在 Claude 进程的内存里；会话空闲 60 分钟后进程退出，内容释放；服务退出时全部释放。

## 不在本方案范围内

- 中途修改系统提示：只能重建，见第 11 条。

同一版本一起修复的相关问题：C 附加的说明里写明 Environment 一节描述的是模型所在的机器，不是 A（第 15 条）；“超出上下文”的提示带上 `prompt is too long`，让 Pi 能识别为溢出并自动压缩重试。

## 风险

- 第 1、9 条用到的控制消息属于 Agent SDK 使用的 stream-json 控制协议，命令行帮助里没有完整的文档，CLI 升级后可能变化。应对办法：任何不符合预期的控制消息都按出错处理，进程标为 `dead`，下一轮重建。最坏的情况就是退回现在的效果。
- 第 13 条（关闭压缩）只读过代码，没有实测。如果 CLI 仍然自行压缩，进程里的历史和 Pi 的会不一致，但 C 不会察觉。需要在 live 测试里覆盖：观察 stdout 有没有 `compact_boundary`，出现了就把进程标为 `dead`。

## 测试计划

**单元测试**（扩展 [tests/fixtures/claude.mjs](../../tests/fixtures/claude.mjs)，让它模拟 sdk MCP 控制协议）：

- 匹配规则表里的每一行，包括“补出来的结果 + 新的 user 消息”这种情况；
- 串行的 `tools/call`：结果先到、调用后到时，`buffered` 能正确交回；
- 工具集变化时会发 `tools/list_changed`，系统提示、模型、effort 变化时会重建；
- 取消时杀进程，下一轮重建；
- 空闲回收和 `server.maxSessions` 淘汰（回收时间要能在测试里调短）；
- 所有条目都在使用时，按无状态模式执行；
- 历史规范化：跳过出错和被中止的回复，给没有结果的工具调用补结果；
- 一轮里有多次 API 调用时，每条 assistant 消息上报的是自己那次调用的 usage，而不是整轮的汇总。

**live 测试**（扩展 [tests/live.mjs](../../tests/live.mjs)）：

- 一个会话里先 read、再 edit、再 bash，确认整段只启动了一个 Claude 进程；
- 第二条 user 消息复用同一个进程，模型记得上一轮的内容；
- 生成过程中取消，下一轮能正常重建并完成；
- stdout 里没有出现 `compact_boundary`。
