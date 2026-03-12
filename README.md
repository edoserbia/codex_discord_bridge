# Codex Discord Bridge

把本机 `codex` CLI 挂到 Discord 文本频道和线程上，让你可以在手机上像使用 Codex 客户端一样控制本地 Codex，并实时看到过程反馈、计划状态和最终结果。

> 本项目采用 **PolyForm Noncommercial 1.0.0** 许可发布：允许个人和其他非商业用途免费使用、修改和再分发，但**不允许商业使用**。这属于 **source-available**，不是 OSI 定义的开源许可证。详见根目录 `LICENSE`。

## Features

- **项目映射**：一个 Discord 主频道绑定一个本地项目目录
- **线程会话**：主频道下每个 Discord 线程自动继承项目绑定，但拥有独立 Codex 会话上下文
- **实时反馈**：持续更新“Codex 实时进度”消息，展示 reasoning 摘要、计划清单、过程时间线、当前命令、输出预览和 stderr 预览
- **附件支持**：图片附件自动透传给 `codex -i`，普通文件附件自动下载到本地并提示 Codex 读取
- **Web 管理面板**：查看绑定、会话、运行状态，并在浏览器里管理频道绑定
- **持久化状态**：绑定关系和会话状态保存到 `data/state.json`
- **macOS 一键部署**：提供 `scripts/macos-bridge.sh` 进行部署、启停、查看日志和打开 Web 面板
- **测试覆盖**：包含类型检查、单测、本地 smoke 和真实 Discord smoke

## Session Model

推荐按下面的方式组织：

- **一个 Discord 主频道 = 一个项目目录**
- **一个 Discord 线程 = 该项目里的一个独立 Codex 会话**

示例：

- `#proj-api` → `/path/to/workspaces/api`
- `#proj-app` → `/path/to/workspaces/app`
- `#proj-api` 下线程 `修登录` → `/path/to/workspaces/api` 中的一条独立 Codex 会话
- `#proj-api` 下线程 `写文档` → `/path/to/workspaces/api` 中的另一条独立 Codex 会话

这样你可以在 Discord 里把“项目维度”和“任务维度”自然分层：主频道管项目，线程管具体任务。

## Requirements

- macOS
- Node.js `>= 20.11`
- 已安装并登录的 `codex` CLI
- 一个可用的 Discord Bot
- Bot 已加入目标 Discord 服务器
- Bot 已启用 **Message Content Intent**

## Quick Start

```bash
cd /path/to/codex-discord-bridge
./scripts/macos-bridge.sh deploy
```

脚本会交互式提示你填写或确认：

- `CODEX_TUNNING_DISCORD_BOT_TOKEN`
- `ALLOWED_WORKSPACE_ROOTS`
- `DISCORD_ADMIN_USER_IDS`
- `WEB_PORT`
- `WEB_AUTH_TOKEN`
- `OPENCLAW_DISCORD_PROXY`（可选）

其中 Discord Bot Token 会被单独保存到：

- `~/.codex-tunning/secrets.env`

不会写入项目 `.env`，避免和其他 Discord Bot 或项目配置混用。

完成后可用以下命令管理服务：

```bash
./scripts/macos-bridge.sh start
./scripts/macos-bridge.sh stop
./scripts/macos-bridge.sh restart
./scripts/macos-bridge.sh status
./scripts/macos-bridge.sh logs
./scripts/macos-bridge.sh open
```

也提供了对应的 npm 快捷命令：

```bash
npm run macos:deploy
npm run macos:start
npm run macos:stop
npm run macos:restart
npm run macos:status
npm run macos:logs
npm run macos:open
```

## Discord Setup

完整步骤见 `docs/MACOS-deploy.md`。最少需要完成以下操作：

1. 在 Discord Developer Portal 创建一个 Application
2. 为该 Application 添加 Bot
3. 复制 Bot Token
4. 在 Bot 页面启用 **Message Content Intent**
5. 使用 OAuth2 URL Generator 邀请 Bot 进入你的服务器
6. 确保 Bot 至少拥有以下权限：
   - `View Channels`
   - `Read Message History`
   - `Send Messages`
   - `Send Messages in Threads`
   - `Attach Files`
   - `Embed Links`

## How To Use

### 1. 在主频道绑定项目

在一个普通文本频道中发送：

```text
!bind api "/path/to/workspaces/api" --sandbox workspace-write --approval never --search off
```

注意：

- `!bind` 必须在**普通文本频道**中执行
- 线程会自动继承主频道绑定，所以不需要在线程里重复绑定

### 2. 直接发消息给 Codex

绑定完成后，该主频道里的普通消息会直接作为 prompt 发给 Codex。

你会同时看到两类反馈：

- 一条持续更新的“Codex 实时进度”消息
- 一条本轮最终结果回复

### 3. 在线程里继续任务

在已绑定主频道下创建线程并发送消息后：

- 线程继承主频道的项目目录
- 线程拥有自己的独立 Codex session
- 线程有自己的排队、状态面板和实时进度消息

### 4. 发送附件

- **图片附件**：自动走 `codex -i`
- **普通文件附件**：保存到 `data/attachments/<conversation>/<task>/`，并把本地路径告诉 Codex

### 5. 使用控制命令

```text
!help
!status
!queue
!cancel
!reset
!unbind
!projects
```

## Real-Time Progress

当 Codex 运行时，机器人会在频道中维护一条持续编辑的进度消息，包含：

- reasoning / 分析摘要
- todo / 计划项及完成状态
- 过程时间线
- 当前命令
- 最新输出预览
- 最新 stderr 预览

这意味着你在手机上也能看到类似客户端里的“中间过程”，而不只是最终答案。

## Web Admin

默认地址：

```text
http://127.0.0.1:3769
```

如果设置了 `WEB_AUTH_TOKEN`，可以通过：

```text
http://127.0.0.1:3769/?token=<YOUR_WEB_AUTH_TOKEN>
```

在浏览器里一次性写入登录 Cookie。

## Configuration

最常用的环境变量如下：

| 变量 | 说明 |
| --- | --- |
| `CODEX_TUNNING_DISCORD_BOT_TOKEN` | Discord Bot Token；建议仅保存在 `~/.codex-tunning/secrets.env` |
| `ALLOWED_WORKSPACE_ROOTS` | 允许绑定的项目根目录，多个目录用逗号分隔 |
| `DISCORD_ADMIN_USER_IDS` | 允许执行管理命令的 Discord 用户 ID，多个 ID 用逗号分隔 |
| `DEFAULT_CODEX_SANDBOX` | 默认 sandbox 模式 |
| `DEFAULT_CODEX_APPROVAL` | 默认 approval 策略 |
| `DEFAULT_CODEX_SEARCH` | 默认是否开启搜索 |
| `WEB_PORT` | Web 面板端口，默认 `3769` |
| `WEB_AUTH_TOKEN` | Web 面板鉴权 token |
| `OPENCLAW_DISCORD_PROXY` | Discord / 附件下载所用代理，例如 `http://127.0.0.1:7890` |
| `OPENCLAW_CONFIG_PATH` | OpenClaw 配置路径，默认 `~/.openclaw/openclaw.json` |

完整示例见 `.env.example`。

## Docs

- `docs/QUICKSTART.md`：5 分钟快速上手
- `docs/MACOS-deploy.md`：macOS 一键部署、Discord 授权与使用全流程
- `docs/DEPLOYMENT.md`：运维、升级、日志和运行目录说明
- `docs/GITEE.md`：本地 Git / Gitee 私有仓库初始化与推送

## Development

```bash
npm install
npm run check
npm test
npm run build
npm run smoke:local
npm run smoke:discord
```

## Security & Privacy

- Discord Bot Token 默认单独保存在 `~/.codex-tunning/secrets.env`
- 项目 `.env` 不再保存 Discord Token
- 运行态日志、PID、状态和附件都在本地机器上
- 建议把 `ALLOWED_WORKSPACE_ROOTS` 收紧到你真正需要暴露给 Discord 的目录
- 建议为 Web 面板配置 `WEB_AUTH_TOKEN`
- `data/`、`logs/`、`.run/` 已在 `.gitignore` 中忽略，避免把运行态数据误提交

## License

本项目采用 **PolyForm Noncommercial 1.0.0**：

- 允许个人和其他非商业用途免费使用、修改和再分发
- 不允许商业使用
- 商业授权请联系版权持有人另行协商

详见：

- `LICENSE`
- `NOTICE`
