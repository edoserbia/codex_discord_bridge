# Codex Discord Bridge

把本机 `codex` CLI 挂到 Discord 文本频道和线程上，让你可以在手机上像使用 Codex 客户端一样控制本地 Codex，并实时看到过程反馈、计划状态、命令输出和最终结果。

> 当前版本：`0.3.3`
>
> 本项目采用 **PolyForm Noncommercial 1.0.0** 许可发布：允许个人和其他非商业用途免费使用、修改和再分发，但**不允许商业使用**。这属于 **source-available**，不是 OSI 定义的开源许可证。详见根目录 `LICENSE`。

## Features

- **频道映射项目**：一个 Discord 主频道绑定一个本地项目目录
- **线程式会话**：主频道下每个线程自动继承绑定，但拥有独立 Codex 会话
- **Autopilot 自动迭代**：支持服务级和项目级双层开关、项目周期配置、自然语言方向、状态查询、skill 管理的任务看板，以及实时线程进度
- **本机 CLI 控制面**：支持通过 `bridgectl autopilot ...` 在终端里直接控制正在运行的 bridge 服务，不必手写状态文件
- **会话恢复入口**：`!status` 会显示完整 Resume ID 和可直接复制的 `bridgectl session resume <id>` 命令
- **本机续聊 + Transcript 同步**：支持 `bridgectl session status/send/resume`，并把本机续聊产生的用户/助手内容同步回 Discord transcript
- **实时进度**：持续更新“Codex 实时进度”消息，展示分析摘要、计划状态、时间线、当前命令、输出预览和 stderr
- **app-server 优先 + 可见 fallback**：默认优先走官方 `app-server`；如果工作区不是 Git 仓库且你关闭了跳过检查，或本机 Codex 配置不兼容，bridge 会明确提示已经切到 `legacy-exec`
- **运行中引导**：支持 `!guide <内容>`，先处理中途引导，再继续原任务
- **双向文件传输**：图片附件自动透传给 `codex -i`，所有上传文件会镜像到绑定目录的 `inbox/`，并支持把工作区文件直接发回 Discord
- **Web 管理面板**：查看绑定、会话、运行状态，并在浏览器中管理频道绑定
- **macOS 服务化部署**：支持 `launchd`，可安装为 `LaunchDaemon` 开机启动或 `LaunchAgent` 登录后启动
- **本地高权限默认**：默认 `danger-full-access`，便于在 Discord 中直接读写项目文件
- **测试覆盖**：包含类型检查、单测、本地 smoke 和真实 Discord smoke
- **启动自动恢复**：bridge 或 Discord 连接中断后重新起来时，会优先恢复上一次未完成任务，并在 Discord 里标明本轮是自动恢复
- **异常退出自愈**：对 Codex CLI 偶发的无害异常退出（例如仅出现 `failed to clean up stale arg0 temp dirs` warning）自动重试一次，减少任务被误判失败
- **脏会话自动切换**：若旧的 resume 会话本身已损坏，bridge 会自动丢弃旧 thread，并改用新会话重试一次
- **三段式恢复**：若“新会话首轮失败 → 恢复到新 thread 仍失败”，bridge 会第三次自动回退到全新会话，并在最终失败时清空坏 thread，避免后续继续踩坑

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
  - 已验证版本：`codex-cli 0.116.0`
- 一个可用的 Discord Bot
- Bot 已加入目标 Discord 服务器
- Bot 已启用 **Message Content Intent**

## Codex CLI 兼容性

当前 bridge 已按本机 `codex-cli 0.116.0` 验证。

如果你希望在整个系统里保持 **全权限**，当前版本应使用 Codex 顶层配置：

```toml
sandbox_mode = "danger-full-access"
approval_policy = "never"
approval_mode = "never"
```

这会保留全局高权限，不会把访问范围限制在当前项目目录。

注意：在 `codex-cli 0.116.0` 上，不要继续保留旧配置：

```toml
default_permissions = "full"

[permissions.full]
open_world_enabled = true
destructive_enabled = true
```

这组旧键会让 `codex app-server` 在启动时报告权限配置不兼容，并导致 bridge 回退到 `legacy-exec`。保留你原有的模型、provider、搜索等配置即可，只需要删掉这段过期权限 profile。

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
- `CODEX_DISCORD_BRIDGE_PROXY`（自动探测，可选保留为空）

其中 Discord Bot Token 会单独保存到 `~/.codex-tunning/secrets.env`，不会写入项目 `.env`。

启动脚本会先探测 Discord 直连；如果直连失败，会自动尝试 `http://127.0.0.1:7890`，并把结果写回 `CODEX_DISCORD_BRIDGE_PROXY`。当检测到代理时，脚本还会自动为 Node 注入 `--use-system-ca`；如果系统存在 `/etc/ssl/cert.pem`，也会一并作为额外 CA bundle 注入，处理代理环境下常见的证书链问题。

如果你已经安装了 `LaunchAgent` / `LaunchDaemon`，当前版本的 `restart` 会优先走 `launchctl kickstart -k` 做原子重启，而不是先 `stop` 再 `start`。这样即使重启命令是从 bridge 自己承载的会话里发起，也不会因为先停掉当前服务而把后续 `start` 一并中断。

部署结束后，脚本会继续询问是否安装为 macOS 自启动服务：

- `daemon`：开机启动，适合长期在线
- `agent`：登录后启动，不需要 `sudo`

当前脚本在同时存在 daemon/agent 安装痕迹时，会优先识别并操作 **LaunchAgent**，避免因历史残留的 daemon plist 误判当前运行状态。

`setup` / `deploy` / `install-service` 现在会自动把 `bridgectl` 安装到用户 PATH 目录中，默认优先使用 `~/bin`，也可通过 `CODEX_TUNNING_INSTALL_BIN_DIR` 覆盖。安装脚本会同时把 PATH 片段写入 `~/.zprofile` 和 `~/.zshrc`；如果当前终端仍提示找不到命令，执行一次 `rehash` 或直接新开一个终端窗口即可。

## Documentation

- [快速上手](docs/QUICKSTART.md)
- [Autopilot 使用与实现](docs/AUTOPILOT.md)
- [macOS 部署说明](docs/MACOS-deploy.md)
- [部署与运维说明](docs/DEPLOYMENT.md)
- [Git / GitLab 使用说明](docs/GIT.md)
- [LaunchAgent 恢复记录](docs/ops/2026-03-26-launchagent-recovery.md)

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

## 本机 CLI

如果你希望在桌面端或项目目录里直接控制 bridge，可以使用本机 CLI。

只要你执行过下面任一命令：

- `./scripts/macos-bridge.sh setup`
- `./scripts/macos-bridge.sh deploy`
- `./scripts/macos-bridge.sh install-service --mode daemon`
- `./scripts/macos-bridge.sh install-service --mode agent`

脚本就会自动安装 `bridgectl`。之后可以在任意目录使用：

```bash
bridgectl autopilot status
bridgectl autopilot server on
bridgectl autopilot server concurrency 3
bridgectl autopilot project status --project api
bridgectl autopilot project interval 30m --project api
bridgectl autopilot project prompt "优先补测试和稳定性，不要做大功能" --project api
bridgectl autopilot project run --project api
bridgectl session status <Resume ID>
bridgectl session send <Resume ID> "hello"
bridgectl session resume <Resume ID>
```

如果你不想走 PATH，也可以直接运行：

```bash
./scripts/bridgectl autopilot status
./scripts/bridgectl session resume <Resume ID>
npm run cli -- autopilot project status --project api
```

项目定位规则：

- `--channel <频道ID>` 优先级最高
- `--project <绑定项目名>` 次之
- 如果两者都不传，CLI 会按当前工作目录匹配已绑定项目
- 匹配不到或匹配多个时会直接报错，不猜

CLI 通过本机 bridge Web API 控制运行中的服务，不会直接改 `data/state.json`。如果配置了 `WEB_AUTH_TOKEN`，CLI 会自动复用 bridge 仓库 `.env` 里的 token；也可以临时覆盖：

```bash
CODEX_DISCORD_BRIDGE_WEB_ORIGIN=http://127.0.0.1:3769 \
CODEX_DISCORD_BRIDGE_WEB_AUTH_TOKEN=your-token \
bridgectl autopilot status
```

`bridgectl session resume <Resume ID>` 的交互说明：

- 普通单行输入：直接输入，按一次 `Enter` 发送
- 多行粘贴：整段粘贴后不会立即发送；再按一次 `Enter` 才会整段发送
- 查看状态：输入 `/status`
- 退出本机会话：输入 `/exit`
- 通过本机续聊发出的内容，会同步回 Discord transcript，因此 Discord 侧记录仍然是完整的

## Autopilot 最短上手

如果你只想最快把自动迭代跑起来，最短流程如下：

### 1. 在 Discord 主频道绑定项目

```text
!bind api "/path/to/workspaces/api"
```

如果目标项目目录还不存在，bridge 会先自动创建这个目录，再完成绑定。

绑定后会自动创建：

- 主频道里的 `Autopilot 入口` 置顶卡片
- 一个 `Autopilot · api` 项目线程
- 项目目录里的 `.codex/autopilot/board.json` 和 `docs/AUTOPILOT_BOARD.md`

### 2. 开启服务级 Autopilot

```text
!autopilot server on
```

这会对当前 bridge 进程里所有已绑定项目打开服务级总开关。

### 3. 开启当前项目的项目级 Autopilot

在该项目频道或它的 Autopilot 线程里发送：

```text
!autopilot project on
```

### 4. 设置当前项目的运行周期

```text
!autopilot project interval 30m
```

支持格式：`30m`、`2h`、`1d`、`90m`。纯数字默认按分钟处理。

### 5. 给当前项目一个自然语言方向

你可以在项目主频道执行命令：

```text
!autopilot project prompt 优先补测试和稳定性，不要做大功能
```

也可以直接在 Autopilot 线程里发送自然语言：

```text
优先补测试和稳定性，不要做大功能
```

### 6. 查看当前状态

```text
!autopilot status
!autopilot project status
```

- `!autopilot status`：查看当前 bridge 进程里所有绑定项目的服务级定时任务情况
- `!autopilot project status`：查看当前项目的周期、开关、并行槽、最近运行和下次运行时间

补充：

- 服务级 Autopilot 默认并行度为 `5`
- 可以随时执行 `!autopilot server concurrency <N>` 调整
- 需要立即触发当前项目时，可执行 `!autopilot project run`
- Autopilot 的任务看板真实落在项目目录里；bridge 只读取并在 Discord 里同步变化，不会在服务重启时重置
- 如果你在本机终端操作，也可以直接执行 `bridgectl autopilot ...`；项目命令默认按当前工作目录匹配绑定项目

完整说明见 [docs/AUTOPILOT.md](docs/AUTOPILOT.md)。

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
- 如果目标目录本身不是 Git 仓库，建议显式带上 `--skip-git-check on`，避免 `app-server` 因仓库检查降级到 `legacy-exec`

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

如果你想从本机终端接回当前会话，可以先在 Discord 里发送：

```text
!status
```

返回里会包含：

- 完整 Resume ID
- 可直接复制的 `bridgectl session resume <Resume ID>` 命令
- 当前会话绑定的项目、目录、队列和状态

拿到 Resume ID 后，就可以在本机终端里继续同一条会话，而不是新开一条独立对话。

### 4. 运行中插入引导

当当前任务还在跑时，发送：

```text
!guide 现在先检查 README，然后继续完成原任务
```

Bridge 会中断当前步骤，并在**同一 Codex 会话**中先处理新引导，再继续原任务；只有当新引导明确要求停止或替换原任务时，才会转向新的目标。

### 5. 文件收发

- **图片附件**：自动走 `codex -i`
- **所有上传文件**：都会先缓存到 `data/attachments/<conversation>/<task>/`，同时镜像到当前绑定项目目录下的 `inbox/`
- **命名规则**：上传和发回文件时都会尽量保留原文件名；只有目标位置已存在同名文件时，才会在扩展名前追加一段随机后缀
- **默认查找范围**：发文件给 Discord 时，默认先在绑定目录里的 `inbox/` 查找，再扩展到其余工作区文件
- **自然语言发文件**：可以直接说 `把 report.pdf 发给我`
- **命令兜底**：也可以用 `!sendfile report.pdf`
- **多候选选择**：如果匹配到多个文件，bridge 会返回编号；你可以回复 `发第 2 个` 或 `!sendfile 2`
- **绝对路径规则**：显式绝对路径只允许管理员使用，例如 `!sendfile /absolute/path/to/report.pdf`
- **Codex 主动回传**：如果你要求 “生成完 report.pdf 后直接发给我”，bridge 会自动把文件回传协议注入给 Codex；当模型能明确定位单个文件时，会直接把附件发回当前频道/线程

### 6. 控制命令

```text
!help
!autopilot
!autopilot status
!autopilot server on
!autopilot server off
!autopilot server clear
!autopilot server status
!autopilot server concurrency 5
!autopilot project on
!autopilot project off
!autopilot project clear
!autopilot project status
!autopilot project run
!autopilot project interval 30m
!autopilot project prompt 优先补测试和稳定性，不要做大功能
!status
!queue
!queue insert <序号>
!queue remove <序号>
!web
!sendfile <文件名/相对路径/绝对路径/序号>
!guide <追加指令>
!cancel
!reset
!unbind
!projects
bridgectl autopilot status
bridgectl autopilot project status --project api
bridgectl autopilot project run --project api
bridgectl session status <Resume ID>
bridgectl session send <Resume ID> "hello"
bridgectl session resume <Resume ID>
```

其中 `!autopilot` 会直接返回完整使用说明。
`!status` 会返回完整 Resume ID 和本机恢复命令；`bridgectl session resume` 则会进入本地续聊模式。

## 实时进度

当 Codex 运行时，机器人会在频道中维护一条持续编辑的进度消息，包含：

- reasoning / 分析摘要
- todo / 计划项及完成状态
- 过程时间线
- 当前命令
- 最新输出预览
- 最新 stderr 预览

这意味着你在手机上也能看到类似客户端里的“中间过程”，而不只是最终答案。

计划项在实时进度里固定使用两种状态：

- 未完成：`⬜️`
- 已完成：`✅`

当 Codex 的 todo/plan 状态变化时，进度消息会实时刷新对应勾选状态。

## 驱动与恢复

- 普通文本任务默认优先使用 `app-server`
- 如果工作区不是 Git 仓库，保持 `--skip-git-check on` 可以继续走 `app-server`；如果关闭它且目录确实不在 Git 仓库里，bridge 会提示当前请求已切到 `legacy-exec`
- 如果 `~/.codex/config.toml` 里还保留旧的 `default_permissions = "full"` / `[permissions.full]` 配置，`app-server` 也会因权限 profile 不兼容回退到 `legacy-exec`
- bridge 重启后，未完成任务会优先按“基于当前工作区继续”或“重新执行原始提示”的方式自动恢复；进度消息会标出这是恢复执行
- `!web` 会返回当前 Web 面板的本地地址和局域网地址；如果配置了 `WEB_AUTH_TOKEN`，返回的链接会自动带上登录 token

## Autopilot 并行语义

- 服务级 Autopilot 默认并行度是 `5`
- 可以随时用 `!autopilot server concurrency <N>` 调整并行数
- 已运行中的 Autopilot 不会因为调整并行数而被中断
- 主频道和普通线程里的手动 Codex 会话，与 Autopilot 调度彼此独立，不互相占用运行槽
- `!autopilot project run` 可以立刻手动触发当前项目执行 1 次，并按本轮完成时间刷新下一次周期

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
| `DEFAULT_CODEX_SKIP_GIT_REPO_CHECK` | 默认是否跳过 Git 仓库检查；默认值为 `true`，适合把 bridge 绑定到尚未初始化 Git 的目录 |
| `WEB_PORT` | Web 面板端口，默认 `3769` |
| `WEB_AUTH_TOKEN` | Web 面板鉴权 token |
| `CODEX_DISCORD_BRIDGE_PROXY` | Bridge 自己的 Discord / 附件下载代理。`setup` / `start` / `service-run` 会自动在直连和 `http://127.0.0.1:7890` 之间探测并回写这个值 |
| `CODEX_DISCORD_BRIDGE_CA_CERT` | 代理 CA 证书 PEM 文件；当代理导致 TLS 报错时可显式指定 |
| `CODEX_DISCORD_BRIDGE_WEB_ORIGIN` | 本机 CLI 的 bridge Web API 地址覆盖值；默认推导为 `http://127.0.0.1:${WEB_PORT}` |
| `CODEX_DISCORD_BRIDGE_WEB_AUTH_TOKEN` | 本机 CLI 的 Web 鉴权 token 覆盖值；默认复用 `WEB_AUTH_TOKEN` |
| `OPENCLAW_CONFIG_PATH` | OpenClaw 配置路径，默认 `~/.openclaw/openclaw.json` |

完整示例见 `.env.example`。

管理员判定规则：

- 用户 ID 命中 `DISCORD_ADMIN_USER_IDS`
- 或在 Discord 中拥有 `Manage Guild` / `Manage Channels` 权限

管理员命令包括：

- `!bind`、`!unbind`
- `!cancel`、`!reset`
- `!queue insert <序号>`
- `!queue remove <序号>`
- 所有会修改 Autopilot 状态的命令，例如 `!autopilot server on`、`!autopilot project interval 30m`

文件发送时，只有管理员可以显式指定绝对路径；普通用户默认只在绑定工作区内搜索。

如果设置了 `CODEX_DISCORD_BRIDGE_PROXY`，启动脚本会自动为 Node 注入 `--use-system-ca`，并在系统存在 `/etc/ssl/cert.pem` 时把它作为额外 CA bundle 注入，以兼容 macOS 上已信任的本地代理根证书。

如果仍然出现 `unable to get local issuer certificate`，通常是 `LaunchDaemon` 拿不到登录会话里的证书链。此时请把代理根证书导出为 PEM，并设置：

```text
CODEX_DISCORD_BRIDGE_CA_CERT=/path/to/proxy-ca.pem
```

## 文档

- `docs/QUICKSTART.md`：5 分钟快速上手
- `docs/MACOS-deploy.md`：macOS 一键部署、Discord 授权、开机启动与使用全流程
- `docs/DEPLOYMENT.md`：运维、升级、日志、launchd 和运行目录说明
- `docs/CHANGELOG.md`：版本变更记录
- `docs/GIT.md`：当前 GitLab 远端、克隆、迁移与推送流程
- `docs/GITEE.md`：旧 Gitee 文档入口，现仅保留兼容提示

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

如果你遇到“服务已安装但 launchctl 未加载 / 进程未运行”的情况，先看：

- `docs/ops/2026-03-26-launchagent-recovery.md`


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
