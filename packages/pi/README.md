# @a-tether/pi

Pi 插件和启动器：通过端口转发，使用另一台电脑（C）上 [`@a-tether/server`](https://www.npmjs.com/package/@a-tether/server) 提供的 Claude Code。

**需要先自行安装 Pi**（`npm install -g @earendil-works/pi-coding-agent`），本包不会安装 Pi。

```sh
npx -y @a-tether/pi login <令牌>   # 只需一次；命令由 C 端服务首次启动时打印
pi install npm:@a-tether/pi       # 把插件装进 Pi，之后在项目目录直接运行 pi
```

也可以不安装插件，每次用 `npx -y @a-tether/pi` 启动带插件的 Pi；其余参数原样传给 Pi，例如 `npx -y @a-tether/pi --model a-tether/claude-opus-5-5`。

- 令牌和连接地址保存在 `~/.a-tether/settings.json`，默认连接 `http://127.0.0.1:7310`。A 和 C 是同一台电脑时无需 login。
- 在 Pi 中运行 `/a-tether-status` 检查连接。
- 完整说明见 [README](https://github.com/SandyKidYao/a-tether#readme)。
