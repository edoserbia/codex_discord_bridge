# Deployment & Operations

这份文档面向日常运维：启动、停止、查看状态、升级、日志排查，以及运行目录说明。

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

## 首次部署

```bash
cd /path/to/codex-discord-bridge
./scripts/macos-bridge.sh deploy
```

`deploy` 等价于：

1. `doctor`
2. `setup`
3. `start`

其中 `setup` 会：

- 检查 Node.js / npm / codex
- 创建 `.env`（若不存在）
- 交互式填写配置
- 把 Discord Token 单独写入 `~/.codex-tunning/secrets.env`
- 安装依赖
- 运行类型检查
- 执行构建

## 日常管理命令

```bash
./scripts/macos-bridge.sh doctor
./scripts/macos-bridge.sh configure
./scripts/macos-bridge.sh setup
./scripts/macos-bridge.sh start
./scripts/macos-bridge.sh stop
./scripts/macos-bridge.sh restart
./scripts/macos-bridge.sh status
./scripts/macos-bridge.sh logs
./scripts/macos-bridge.sh open
```

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

如果只是文档或前端管理页面有改动，也建议至少运行：

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

启动脚本会在进程启动前自动注入：

- `HTTP_PROXY`
- `HTTPS_PROXY`
- `http_proxy`
- `https_proxy`

## 机器人离线排查

优先按下面顺序检查：

1. 进程是否在运行

```bash
./scripts/macos-bridge.sh status
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

## 会话与状态

- 主频道：项目级入口
- 线程：独立任务会话
- 绑定、会话、消息状态：持久化到 `data/state.json`
- 附件缓存：位于 `data/attachments/`

如需清空本地会话状态，可以先停止服务，再删除 `data/state.json`。

## 不做什么

当前部署脚本**不会**自动配置开机自启或 `launchd` 服务；它只负责本机手动部署与日常管理。

如果你后续需要，我可以再单独补一套 `launchd` 配置方案。
