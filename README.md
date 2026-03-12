# Codex Discord Bridge

把本机 `codex` CLI 挂到 Discord 文本频道和线程上，让你可以在手机上像使用 Codex 客户端一样控制本地 Codex，并实时看到过程反馈、计划状态、命令输出和最终结果。

> 当前版本：`0.3.0`
>
> 本项目采用 **PolyForm Noncommercial 1.0.0** 许可发布：允许个人和其他非商业用途免费使用、修改和再分发，但**不允许商业使用**。这属于 **source-available**，不是 OSI 定义的开源许可证。详见根目录 `LICENSE`。

## Features

- **频道映射项目**：一个 Discord 主频道绑定一个本地项目目录
- **线程式会话**：主频道下每个线程自动继承绑定，但拥有独立 Codex 会话
- **实时进度**：持续更新“Codex 实时进度”消息，展示分析摘要、计划状态、时间线、当前命令、输出预览和 stderr
- **运行中引导**：支持 `!guide <内容>`，把新引导即时插入当前工作
- **附件透传**：图片附件自动透传给 `codex -i`，普通文件自动下载到本地供 Codex 读取
- **Web 管理面板**：查看绑定、会话、运行状态，并在浏览器中管理频道绑定
- **macOS 服务化部署**：支持 `launchd`，可安装为 `LaunchDaemon` 开机启动或 `LaunchAgent` 登录后启动
- **本地高权限默认**：默认 `danger-full-access`，便于在 Discord 中直接读写项目文件
- **测试覆盖**：包含类型检查、单测、本地 smoke 和真实 Discord smoke

## 工作模型

- **一个 Discord 主频道 = 一个项目目录**
- **一个 Discord 线程 = 该项目里的一个独立 Codex 会话**

示例：

- `#proj-api` → `/path/to/workspaces/api`
- `#proj-app` → `/path/to/workspaces/app`
- `#proj-api` 下线程 `修登录` → `/path/to/workspaces/api` 中的一条独立 Codex 会话
- `#proj-api` 下线程 `写文档` → `/path/to/workspaces/api` 中的另一条独立 Codex 会话

这样可以在 Discord 里把“项目维度”和“任务维度”自然分层：主频道管项目，线程管任务。

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

`deploy` 会交互式提示你填写或确认：

- `CODEX_TUNNING_DISCORD_BOT_TOKEN`
- `ALLOWED_WORKSPACE_ROOTS`
- `DISCORD_ADMIN_USER_IDS`
- `WEB_PORT`
- `WEB_AUTH_TOKEN`
- `OPENCLAW_DISCORD_PROXY`（可选）

其中 Discord Bot Token 会单独保存到 `~/.codex-tunning/secrets.env`，不会写入项目 `.env`。

部署结束后，脚本会继续询问是否安装为 macOS 自启动服务：

- `daemon`：开机启动，适合长期在线
- `agent`：登录后启动，不需要 `sudo`

## 常用命令

```bash
./scripts/macos-bridge.sh doctor
./scripts/macos-bridge.sh configure
./scripts/macos-bridge.sh setup
./scripts/macos-bridge.sh start
./scripts/macos-bridge.sh stop
./scripts/macos-bridge.sh restart
./scripts/macos-bridge.sh status
./scripts/macos-bridge.sh service-status
./scripts/macos-bridge.sh logs
./scripts/macos-bridge.sh open
./scripts/macos-bridge.sh install-service --mode daemon
./scripts/macos-bridge.sh uninstall-service --mode daemon
```

也提供包装脚本：

```bash
./scripts/install-service.sh --mode daemon
./scripts/uninstall-service.sh --mode daemon
```

以及对应的 npm 命令：

```bash
npm run macos:deploy
npm run macos:start
npm run macos:stop
npm run macos:restart
npm run macos:status
npm run macos:service-status
npm run macos:install-service -- --mode daemon
npm run macos:uninstall-service -- --mode daemon
```

## 服务模式切换

如果你当前装的是登录启动，但希望改成真正开机启动：

```bash
./scripts/uninstall-service.sh --mode agent
sudo ./scripts/install-service.sh --mode daemon
```

如果你当前装的是开机启动，但想改回登录启动：

```bash
sudo ./scripts/uninstall-service.sh --mode daemon
./scripts/install-service.sh --mode agent
```

## Discord Setup

完整步骤见 `docs/MACOS-deploy.md`。至少需要完成：

1. 在 Discord Developer Portal 创建 Application
2. 为该 Application 添加 Bot
3. 复制 Bot Token
4. 在 Bot 页面启用 **Message Content Intent**
5. 用 OAuth2 URL Generator 邀请 Bot 进入你的服务器
6. 至少授予以下权限：
   - `View Channels`
   - `Read Message History`
   - `Send Messages`
   - `Send Messages in Threads`
   - `Attach Files`
   - `Embed Links`

## 使用方法

### 1. 在主频道绑定项目

在一个普通文本频道发送：

```text
!bind api "/path/to/workspaces/api" --sandbox danger-full-access --approval never --search off
```

说明：

- `!bind` 必须在普通文本频道中执行
- 线程会自动继承主频道绑定，所以不需要在线程里重复绑定
- 如果你已经把 `.env` 中 `DEFAULT_CODEX_SANDBOX` 设为 `danger-full-access`，也可以省略 `--sandbox`

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

### 4. 运行中插入引导

当当前任务还在跑时，发送：

```text
!guide 请停止当前步骤，改为先检查 README
```

Bridge 会中断当前步骤，并在**同一 Codex 会话**中按新引导继续执行。

### 5. 发送附件

- **图片附件**：自动走 `codex -i`
- **普通文件附件**：保存到 `data/attachments/<conversation>/<task>/`，并把本地路径告诉 Codex

### 6. 控制命令

```text
!help
!status
!queue
!guide <追加指令>
!cancel
!reset
!unbind
!projects
```

## 实时进度

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
| `DEFAULT_CODEX_SANDBOX` | 默认 sandbox 模式；默认值为 `danger-full-access` |
| `DEFAULT_CODEX_APPROVAL` | 默认 approval 策略 |
| `DEFAULT_CODEX_SEARCH` | 默认是否开启搜索 |
| `WEB_PORT` | Web 面板端口，默认 `3769` |
| `WEB_AUTH_TOKEN` | Web 面板鉴权 token |
| `OPENCLAW_DISCORD_PROXY` | Discord / 附件下载所用代理，例如 `http://127.0.0.1:7890` |
| `OPENCLAW_CONFIG_PATH` | OpenClaw 配置路径，默认 `~/.openclaw/openclaw.json` |

完整示例见 `.env.example`。

## 文档

- `docs/QUICKSTART.md`：5 分钟快速上手
- `docs/MACOS-deploy.md`：macOS 一键部署、Discord 授权、开机启动与使用全流程
- `docs/DEPLOYMENT.md`：运维、升级、日志、launchd 和运行目录说明
- `docs/CHANGELOG.md`：版本变更记录
- `docs/GITEE.md`：本地 Git / Gitee 私有仓库初始化与推送

## 开发

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
- 若你不希望 Discord 中的 Codex 默认拥有写权限，可将 `DEFAULT_CODEX_SANDBOX` 改回 `workspace-write` 或 `read-only`

## 故障排查

### Discord 里明明绑定了高权限，但仍提示只读

如果你在 Discord 中已经绑定了：

```text
!bind tmp "/path/to/project" --sandbox danger-full-access --approval never --search on
```

但 Codex 仍然回你：

- `Operation not permitted`
- `当前会话仍然是只读`
- `python3 -m venv .venv` 无法创建目录

优先按这个顺序处理：

1. 重启本地桥接服务

```bash
./scripts/macos-bridge.sh restart
```

2. 在 Discord 当前频道发送：

```text
!reset
```

3. 如有必要，重新绑定一次：

```text
!bind tmp "/path/to/project" --sandbox danger-full-access --approval never --search on
```

4. 再让它做一次最小写入验证，例如创建一个临时文件

原因通常有两类：

- 旧的 Codex 会话在线程恢复时还保留了之前的低权限上下文
- 旧版本服务进程继承了桌面版 Codex 的内部环境变量，导致 Discord 子进程错误落入只读上下文

当前版本已经对第二类问题做了隔离修复；升级后务必至少执行一次 `restart`，必要时再执行 `!reset`。

## License

本项目采用 **PolyForm Noncommercial 1.0.0**：

- 允许个人和其他非商业用途免费使用、修改和再分发
- 不允许商业使用
- 商业授权请联系版权持有人另行协商

详见：

- `LICENSE`
- `NOTICE`
