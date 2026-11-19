# @a-tether/server

A-tether 的 C 端服务：把 C 上已登录的 Claude Code 借给另一台电脑（A）上的 Pi 使用。A 端请使用 [`@a-tether/pi`](https://www.npmjs.com/package/@a-tether/pi)。

```sh
npx -y @a-tether/server          # 全局安装后命令为 a-tether-server
npx -y @a-tether/server --plain  # 不进入监控界面，只逐行输出日志
npx -y @a-tether/server token    # 再次显示 A 端的配置命令
```

- 第一次启动会生成令牌，保存到 `~/.a-tether/settings.json`，并打印一行 `npx -y @a-tether/pi login <令牌>`，到 A 上运行一次即可。A 和 C 是同一台电脑时不需要这一步。
- 默认只监听 `127.0.0.1:7310`，A 通过 SSH 隧道等端口转发连接。端口、监听地址、`claude` 路径等都在 `~/.a-tether/settings.json` 中配置。
- 需要 C 上已登录的 `claude` CLI。
- 在终端里运行时显示监控界面：连进来的 A、C 上的 Claude 进程、进行中的请求和最近动作，可以结束进程、取消请求。不在终端里运行（或 `--plain`）时，请求失败只输出一行脱敏诊断。两种方式都不显示对话内容、工具参数；令牌只在第一次启动时显示一次，以后在界面里按 `t` 再按 `r` 才显示。
- A 和 C 必须使用同一版本。
- 完整说明见 [README](https://github.com/SandyKidYao/a-tether#readme)。
