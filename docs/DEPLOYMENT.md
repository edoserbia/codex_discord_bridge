# Deployment & Operations

这份文档面向日常运维：部署、升级、launchd 自启动、日志排查和运行目录说明。

## 目录约定

假设项目位于：

```text
/path/to/codex-discord-bridge
```

默认会涉及这些位置：

- 项目环境变量：`/path/to/codex-discord-bridge/.env`
- Discord 密钥文件：`~/.codex-tunning/secrets.env`
- 运行日志：`/path/to/codex-discord-bridge/logs/codex-discord-bridge.log`
- PID 文件：`/path/to/codex-discord-bridge/.run/codex-discord-bridge.pid`
- 状态文件：`/path/to/codex-discord-bridge/data/state.json`
- Web 面板：`http://127.0.0.1:3769`
- LaunchAgent plist：`~/Library/LaunchAgents/<label>.plist`
- LaunchDaemon plist：`/Library/LaunchDaemons/<label>.plist`

服务标签会根据仓库路径自动生成，所以同一台 Mac 上可以安装多个不同仓库实例，不会互相冲突。

## 首次部署

```bash
cd /path/to/codex-discord-bridge
./scripts/macos-bridge.sh deploy
```

`deploy` 会执行：

1. `doctor`
2. `setup`
3. 交互式询问是否安装 launchd 自启动服务
4. 若未安装 launchd，则直接 `start`

## 日常管理命令

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

## launchd 自启动

### `LaunchDaemon` 和 `LaunchAgent` 的区别

- `daemon`：开机启动，适合你希望机器启动后就保持在线
- `agent`：登录后启动，不需要 `sudo`，适合个人桌面环境

安装开机启动服务：

```bash
./scripts/install-service.sh --mode daemon
```

安装登录后启动服务：

```bash
./scripts/install-service.sh --mode agent
```

模式切换示例：

```bash
./scripts/uninstall-service.sh --mode agent
sudo ./scripts/install-service.sh --mode daemon
```

查看服务状态：

```bash
./scripts/macos-bridge.sh service-status
```

卸载服务：

```bash
./scripts/uninstall-service.sh --mode daemon
./scripts/uninstall-service.sh --mode agent
```

### 自动恢复

安装为 launchd 服务后，plist 会带：

- `RunAtLoad=true`
- `KeepAlive=true`

这意味着：

- 机器启动或用户登录后会自动拉起
- 进程异常退出后 launchd 会自动重启

## 升级流程

如果你通过 Git / Gitee 管理这个仓库，推荐更新流程：

```bash
git pull
npm install
npm run check
npm test
npm run build
./scripts/macos-bridge.sh restart
```

如果只是文档或 Web 面板改动，也建议至少运行：

```bash
npm run check
npm run build
./scripts/macos-bridge.sh restart
```

## Web 面板

默认地址：

```text
http://127.0.0.1:3769
```

如果配置了 `WEB_AUTH_TOKEN`，推荐使用：

```text
http://127.0.0.1:3769/?token=<YOUR_WEB_AUTH_TOKEN>
```

浏览器会自动写入认证 Cookie，后续访问无需重复输入 Header。

## 代理配置

如果 Discord 或附件下载在你的网络环境下不稳定，可以配置：

```text
OPENCLAW_DISCORD_PROXY=http://127.0.0.1:7890
```

启动脚本和 launchd 前台入口都会自动注入：

- `HTTP_PROXY`
- `HTTPS_PROXY`
- `http_proxy`
- `https_proxy`

当检测到 `OPENCLAW_DISCORD_PROXY` 时，脚本还会自动为 Node 注入：

- `NODE_OPTIONS=... --use-system-ca`
- 若系统存在 `/etc/ssl/cert.pem`，额外注入 `NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem`

这可以兼容 macOS 已信任的本地代理根证书，避免启动时出现：

```text
Error: unable to get local issuer certificate
```

如果你使用 `LaunchDaemon`，且代理证书只在登录态或某个单独 PEM 中可用，可以进一步配置：

```text
OPENCLAW_DISCORD_CA_CERT=/path/to/proxy-ca.pem
```

脚本会把它注入为 `NODE_EXTRA_CA_CERTS`。

## 机器人离线排查

优先按下面顺序检查：

1. 查看运行状态

```bash
./scripts/macos-bridge.sh status
./scripts/macos-bridge.sh service-status
```

2. 如果未运行，直接启动

```bash
./scripts/macos-bridge.sh start
```

3. 查看日志

```bash
./scripts/macos-bridge.sh logs
```

4. 检查密钥文件是否存在

```bash
cat ~/.codex-tunning/secrets.env
```

5. 确认 Discord Developer Portal 中：

- Bot Token 未失效
- 已启用 **Message Content Intent**
- Bot 已加入目标服务器

如果日志里出现 `unable to get local issuer certificate`，优先检查：

- `.env` 里的 `OPENCLAW_DISCORD_PROXY` 是否正确
- 当前版本脚本启动时是否已打印 `已为 Node 启用系统证书信任（--use-system-ca）`
- 如仍失败，是否需要额外设置 `OPENCLAW_DISCORD_CA_CERT=/path/to/proxy-ca.pem`

## Discord 仍提示只读时

如果你已经绑定了 `danger-full-access`，但 Discord 里执行写文件仍然出现：

- `Operation not permitted`
- `touch ... permission denied`
- `python3 -m venv .venv` 失败

请执行：

```bash
./scripts/macos-bridge.sh restart
```

然后在 Discord 目标频道发送：

```text
!reset
```

必要时再重新绑定一次：

```text
!bind tmp "/path/to/project" --sandbox danger-full-access --approval never --search on
```

这通常说明：

- 当前 Discord 会话还复用了旧的低权限 Codex thread
- 或者旧版本服务进程继承了桌面版 Codex 的内部环境变量，导致子进程错误进入只读上下文

当前版本已经在 bridge 侧清理了这类环境变量，但旧进程必须重启后才会生效。

## 会话与状态

- 主频道：项目级入口
- 线程：独立任务会话
- 绑定、会话、消息状态：持久化到 `data/state.json`
- 附件缓存：位于 `data/attachments/`

如需清空本地会话状态，可以先停止服务，再删除 `data/state.json`。

## 权限说明

默认会把 `DEFAULT_CODEX_SANDBOX` 设为 `danger-full-access`，让 Discord 中的 Codex 可以直接读写项目文件。

当前文档按本机 `codex-cli 0.116.0` 验证。

如果你希望整个系统保持全权限，`~/.codex/config.toml` 应保留：

```toml
sandbox_mode = "danger-full-access"
approval_policy = "never"
approval_mode = "never"
```

不要继续保留旧权限 profile：

```toml
default_permissions = "full"

[permissions.full]
open_world_enabled = true
destructive_enabled = true
```

在 `codex-cli 0.116.0` 上，这组旧键会让 `codex app-server` 启动时报出 `Permissions profile \`full\` does not define any recognized filesystem entries...`，bridge 会因此 fallback 到 `legacy-exec`。删除这段旧 profile 不会降低你当前的全权限设置。

如果你希望收紧权限，可以把 `.env` 中的值改成：

- `workspace-write`
- `read-only`

同时重新 `!bind` 或发送 `!reset` 让旧会话失效。
