# @a-tether/server

A-tether 的 C 端服务。它把 C 上已登录的 Claude Code 通过 SSH 隧道借给另一台电脑上的 Pi 使用。A 端请使用 [`@a-tether/pi`](https://www.npmjs.com/package/@a-tether/pi)。

```sh
export A_TETHER_TOKEN="$(cat ~/.config/a-tether/token)"   # 至少 32 个字符的随机令牌
npx -y @a-tether/server                                   # 全局安装后命令为 a-tether-server
```

- 只监听 `127.0.0.1`，默认端口 7310，可用 `A_TETHER_PORT` 修改。
- 需要 C 上已登录的 `claude` CLI。若 PATH 不同，可设置 `A_TETHER_CLAUDE` 为其绝对路径。
- 请求失败时在 stderr 输出一行脱敏诊断，不记录对话内容或令牌。
- 完整配置见 [setup 文档](https://github.com/SandyKidYao/a-tether/blob/main/docs/setup.md)。
