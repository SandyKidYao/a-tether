# @a-tether/pi

Pi 插件和启动器，经 SSH 隧道使用另一台电脑（C）上运行 [`@a-tether/server`](https://www.npmjs.com/package/@a-tether/server) 的 Claude Code。

**需要先自行安装 Pi**（`npm install -g @earendil-works/pi-coding-agent`）。本包不会安装 Pi。

```sh
export A_TETHER_URL=http://127.0.0.1:7311          # SSH 隧道在 A 上的端口
export A_TETHER_TOKEN="$(ssh user@C 'cat ~/.config/a-tether/token')"
cd /path/to/your/project
npx -y @a-tether/pi                                # 启动带插件的 Pi；全局安装后命令为 pi-tether
```

或者持久安装插件：`pi install npm:@a-tether/pi`，之后直接运行 `pi`。

- 其余参数原样传给 Pi，例如 `npx @a-tether/pi --model a-tether/claude-opus-5-5`。
- `pi` 不在 PATH 中时，可设置 `PI_TETHER_PI` 为它的绝对路径。
- 在 Pi 中运行 `/a-tether-status` 检查连接。完整配置见 [setup 文档](https://github.com/SandyKidYao/a-tether/blob/main/docs/setup.md)。
