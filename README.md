# A-tether v0.1

在 A 上用 Pi 开发 A 的本地项目，经 SSH 隧道借用 C 上已登录的 Claude Code。Pi 在 A 管理会话、执行工具；C 启动单轮 Claude 进程，并在每轮结束后清理资源。

**数据边界**　Pi 放入上下文的代码、工具定义、工具结果和对话会发送到 C，再进入模型服务。Claude 登录凭据由 C 上的官方 CLI 使用。A-tether 服务默认只打印启动状态和监听端口。

## 两台电脑如何配置

按 [A 和 C 配置速查](docs/setup.md) 操作：先在 C 启动服务，再在 A 建立 SSH 隧道，并从 A 的开发项目目录启动 Pi。

## 项目结构

| 路径 | 职责 |
| --- | --- |
| `src/frontends/pi/` | Pi 插件，注册模型并将流式事件交给 Pi。其他前端可放在同级目录。 |
| `src/client/` | A 端共用的 HTTP 请求、回环地址检查和服务认证。 |
| `src/server/` | C 端的 HTTP 路由、认证、取消及请求生命周期。 |
| `src/backends/claude-code/` | Claude Code 的模型发现、进程调用、流式转换与只读工具目录。 |
| `src/shared/` | 两端共用的 v0.1 协议、事件编码和错误码。 |

新后端实现 [Backend 接口](src/backends/backend.ts)，在 [C 端入口](src/server.ts) 选用。新前端可复用 HTTP 客户端并映射 v0.1 的消息和事件。当前协议沿用 Pi 的消息结构，服务每次启动加载一个后端。

## 复验

在 A-tether 源码目录运行。常规测试使用本地测试 CLI，不需要 Claude 账户。真实验收使用已配置的隧道和 C 的账户额度，在独立的临时 A 项目中运行。

```sh
npm run check
npm test
npm run test:live
```

真实验收先检查 Pi 收到文本增量，再随机生成一行内容，让模型调用 read 读取、edit 加前缀、bash 执行 pwd 与 cat。脚本核对工具顺序、文件内容、实际工作目录和模型最终回复。完成后删除临时项目。

本次开发验收在同一台 Mac 上用独立进程和目录模拟 A、C，使用 OpenSSH 客户端及服务端、真实 Pi 和真实 Claude 账户。三种工具调用及最终回复均通过。断开正在执行请求的 SSH 隧道后，Pi 显示连接中断，对应的 Claude 进程退出。另用离线测试覆盖取消、临时文件清理和日志脱敏。跨物理机器和 Windows 组合仍待验证。

## 故障排查

| 现象 | 检查方法 |
| --- | --- |
| Pi 连接中断 | 检查 C 服务和 SSH 终端；A 的 URL 端口要等于 `-L` 左侧端口。隧道重建后手动重发。 |
| 认证失败 | 在启动 Pi 的终端检查令牌变量已设置。若 C 更新了令牌，两端均需重新加载。 |
| 找不到 CLI 或未登录 | 在启动服务的 C 账户运行 `claude auth status`；若 PATH 不同，可设置 `A_TETHER_CLAUDE` 为 C 上的绝对路径后重启。 |
| 无模型目录或后端错误 | 检查 C 能访问模型服务、CLI 可正常运行。检查 C 是否设置了自定义后端地址或非 Claude 登录认证变量。 |
| 额度或速率限制 | 在 C 的 Claude Code 中查看账户用量。 |
| 请求超限 | 单次 JSON 请求上限 32 MiB。可在 Pi 中压缩上下文或减少图片和工具输出。 |

仅支持回环 HTTP 和 SSH 本地端口转发。模型请求最长五分钟，每轮重新创建 worker，工具密集的任务会产生额外启动开销。服务退出时用 Ctrl+C 或 SIGTERM 触发清理。Claude CLI 的调用方式见 [协议说明](docs/protocol-v0.1.md)。
