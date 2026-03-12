# Deployment

## 当前推荐：macOS 本机后台运行

不做开机自启时，最推荐的方式就是用仓库内置脚本管理：

```bash
cd /Users/<user>/work/su/codex_tunning
./scripts/macos-bridge.sh deploy
```

首次执行 `deploy` / `setup` 时，脚本会在终端交互式提示你确认或填写关键配置；如果你已有 `~/.openclaw/openclaw.json`，脚本也会先自动导入可识别的 Discord Token / 代理。

后台运行后，你可以用：

```bash
./scripts/macos-bridge.sh status
./scripts/macos-bridge.sh logs
./scripts/macos-bridge.sh restart
./scripts/macos-bridge.sh stop
```

如果你只想先改配置，不安装不启动：

```bash
./scripts/macos-bridge.sh configure
```

## 部署脚本会做什么

`./scripts/macos-bridge.sh deploy` 会自动：

1. 检查 macOS / Node / npm / codex
2. 创建 `.env`
3. 尝试从 `~/.openclaw/openclaw.json` 读取 Discord Bot Token 和代理
4. 在终端里提示你确认/修改关键配置
5. 安装依赖
6. 运行 `npm run check`
7. 运行 `npm run build`
8. 后台启动服务
9. 写入运行日志和 PID 文件

## 运行文件位置

- 环境配置：`/Users/<user>/work/su/codex_tunning/.env`
- 运行日志：`/Users/<user>/work/su/codex_tunning/logs/codex-discord-bridge.log`
- PID 文件：`/Users/<user>/work/su/codex_tunning/.run/codex-discord-bridge.pid`
- Web 面板：`http://127.0.0.1:3769`

## 推荐生产配置

1. `DISCORD_BOT_TOKEN` 使用专用 Bot
2. 限制 `ALLOWED_WORKSPACE_ROOTS`
3. 使用 `workspace-write`
4. 配置 `DISCORD_ADMIN_USER_IDS`
5. Web 面板只绑定 `127.0.0.1`
6. 设置 `WEB_AUTH_TOKEN`
7. 如网络受限，可配置 `OPENCLAW_DISCORD_PROXY=http://127.0.0.1:7890`

## 部署后的使用模型

推荐：

- 一个 Discord 频道 = 一个项目目录
- 一个 Discord 线程 = 一个独立会话

这样既方便切项目，也方便在同一项目下并行推进多个任务。

## Web 鉴权说明

- 浏览器打开：`./scripts/macos-bridge.sh open`
- 浏览器手动打开：`http://127.0.0.1:3769/?token=<你的 WEB_AUTH_TOKEN>`
- API 调用：请求头加 `Authorization: Bearer <你的 WEB_AUTH_TOKEN>`

## Discord 申请与授权

完整的 Discord Application / Bot 创建、Token 获取、Message Content Intent、OAuth2 邀请和权限勾选流程，请看：

- `MACOS.md`

## 回归检查

每次部署前建议执行：

```bash
npm run check
npm test
npm run build
npm run smoke:local
```

如果要验证真实 Discord 连接：

```bash
npm run smoke:discord
```

## 后续如果你想开机自启

当前先不启用。

后续如果你需要，我可以再为你补：

- `launchd` plist
- 一键安装到 `~/Library/LaunchAgents`
- 开机自启 / 登录自启
