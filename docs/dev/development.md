# 开发说明

面向参与开发 A-tether 本身的人。使用方法见 [README](../../README.md)。

## 项目结构

| 路径 | 职责 |
| --- | --- |
| `src/frontends/pi/` | Pi 插件（`extension.ts`）和 `a-tether-pi` 启动器（`cli.ts`，含 `login` 子命令）。其他前端可放在同级目录。 |
| `src/client/` | A 端共用的 HTTP 请求与服务认证。 |
| `src/server/` | C 端的 HTTP 路由、认证、取消及请求生命周期。C 端入口 `src/server.ts` 负责令牌的生成与 `token` 子命令。 |
| `src/backends/claude-code/` | Claude Code 的模型发现、进程调用、流式转换，以及常驻会话（`live.ts`，设计见 [live-session.md](live-session.md)）。 |
| `src/shared/` | 两端共用的 v0.1 协议、事件编码、错误码，以及配置文件 `~/.a-tether/settings.json` 的读写（`settings.ts`）。 |
| `packages/` | 两个 npm 包的清单和说明：`server` 发布为 `@a-tether/server`（C 端，命令 `a-tether-server`），`pi` 发布为 `@a-tether/pi`（A 端，命令 `a-tether-pi`）。`dist/` 由构建生成。 |
| `scripts/build.mjs` | 用 `tsconfig.build.json` 把 `src` 编译成 JS，并组装两个包。 |

新后端实现 [Backend 接口](../../src/backends/backend.ts)，在 [C 端入口](../../src/server.ts) 选用。新前端可复用 HTTP 客户端并映射 v0.1 的消息和事件。当前协议沿用 Pi 的消息结构，服务每次启动加载一个后端。协议细节见 [协议说明](../protocol-v0.1.md)。

**配置**　两端只读 `~/.a-tether/settings.json`，不读任何环境变量。配置在用到时读取（C 每次调用 Claude、A 每次请求），所以 `login` 后不必重启 Pi。新增配置项时在 `settings.ts` 里加字段和校验，并同步 README 的「配置文件」一节。

## 从源码运行

在源码目录运行 `npm ci`，然后：

- C 端：`npm run server`。和 `npx` 启动一样读写 `~/.a-tether/settings.json`。
- A 端：在项目目录运行 `node --experimental-transform-types "$TETHER_ROOT/src/frontends/pi/cli.ts"`，或 `pi -e "$TETHER_ROOT/src/frontends/pi/extension.ts" --model a-tether/default`。其中 `TETHER_ROOT` 是 A-tether 源码目录。

## 测试与复验

```sh
npm run check      # 类型检查
npm test           # 离线测试，使用测试用的假 Claude CLI，不需要 Claude 账户
npm run test:live  # 真实验收，使用本机的 settings.json、端口转发和 C 的账户额度
```

离线测试把 `HOME` 指向临时目录并在里面写 settings.json 来注入配置（见 `tests/helpers.ts`），不会碰你自己的 `~/.a-tether`。新测试请沿用这个写法。

真实验收前，本机要先 `login` 过并连通 C。脚本把本机的 settings.json 复制到临时 HOME，在独立的临时 A 项目中运行真实的 Pi：先检查 Pi 收到文本增量，再随机生成一行内容，让模型调用 read 读取、edit 加前缀、bash 执行 pwd 与 cat。脚本核对工具顺序、文件内容、实际工作目录和模型最终回复，完成后删除临时项目。

0.1.0 的开发验收在同一台 Mac 上用独立进程和目录模拟 A、C，使用 OpenSSH 客户端及服务端、真实 Pi 和真实 Claude 账户，三种工具调用及最终回复均通过。断开正在执行请求的 SSH 隧道后，Pi 显示连接中断，对应的 Claude 进程退出。离线测试另覆盖取消、临时文件清理、日志脱敏和配置文件的各种情况。
