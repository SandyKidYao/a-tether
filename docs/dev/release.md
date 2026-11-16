# 打包与发布

两个包 `@a-tether/server` 和 `@a-tether/pi` 同版本发布，版本号取根目录 `package.json`。

## 本地打包

```sh
npm run build        # 编译并生成 packages/*/dist，版本号取根 package.json
npm run pack:dry     # 构建并列出两个包将发布的文件
```

## 发布新版本

发布由 GitHub Actions 的 `publish.yml` 完成，使用 npm Trusted Publishing（OIDC），仓库里不保存 npm 令牌，npm 会为每个版本自动生成 provenance。

1. 本地先跑 `npm run test:live`。CI 没有 Claude 账户，不跑真实验收。
2. `npm version patch`（或 `minor`）：更新根 `package.json`，提交并打 `vX.Y.Z` tag。
3. `git push --follow-tags`。
4. `publish.yml` 校验 tag 与版本一致，运行检查、测试和构建，再发布两个包。npm 上已有的版本会跳过，失败后可以直接重跑。如果 `npm` Environment 设置了人工审批，要先在 Actions 页面批准。
5. 工作流成功后，npm 还要处理几分钟（日志里有 "Your package is being processed"），之后 `npm view @a-tether/server version` 才能看到新版本。

`ci.yml` 在推送到 main 和 PR 时，在 Ubuntu 与 macOS 上运行检查、测试和打包预览。

## 一次性配置

Trusted Publishing 需要两个包已经存在于 npm 上，所以首次发布要手动完成：`npm login` 后运行 `npm run build`、`npm publish ./packages/server --access public`、`npm publish ./packages/pi --access public`。

然后：

- 在 npmjs.com 上为两个包分别配置 Trusted Publisher：包页面 → Settings → Trusted Publisher → GitHub Actions，仓库 `SandyKidYao/a-tether`，workflow 文件名 `publish.yml`，environment `npm`。Allowed actions 勾选 **Allow npm publish**（工作流用的是 `npm publish`；不勾时只允许 `npm stage publish`），**Allow npm dist-tag** 不用勾。
- 在 GitHub 仓库的 Settings → Environments 中创建名为 `npm` 的 Environment，可以设置人工审批（Required reviewers）。
- 确认可以用 CI 发布后，可在 npm 包设置里把发布权限改为要求 2FA 并禁止令牌发布，只允许 Trusted Publishing。
