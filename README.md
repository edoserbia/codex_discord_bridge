# Codex Discord Bridge

把本机 `codex` CLI 接到 Discord 文本频道、线程和本机终端上，让你可以在手机、桌面端和 Terminal 之间共享同一条 Codex 会话，同时保留实时进度、任务队列、文件收发、Autopilot 自动迭代和 Web 管理面板。

> 当前版本：`0.3.3`
>
> 许可：本项目使用 **PolyForm Noncommercial 1.0.0**。这是一种 **source-available** 许可，不是 OSI 定义的开源许可证。个人和其他非商业用途可以免费使用、修改和再分发；商业使用需要另行获得授权。详见根目录 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。

## 为什么要用

原生 Codex CLI 很适合在本机连续工作，但很多人希望同时拥有：

- 在 Discord 里直接发消息驱动本机 Codex
- 一个项目对应一个频道，一个任务对应一个线程
- 在手机上看到中间过程，而不是只看到最终答案
- 遇到复杂任务时，随时从 Discord 切回本机 Terminal 接着同一个会话继续
- 让自动巡检、补测试、低风险修复这类工作按周期自己跑

`codex-discord-bridge` 就是把这些能力合到同一个控制面里。

## 功能概览

| 能力 | 说明 |
| --- | --- |
| 频道绑定项目 | 一个 Discord 主频道绑定一个本地工作目录 |
| 线程独立会话 | 主频道下的每个线程自动继承目录，但拥有自己的 Codex 会话 |
| `!status` 恢复入口 | 返回完整 Resume ID 和可直接复制的 `bridgectl session resume <id>` |
| 本机续聊 | 通过 `bridgectl session status/send/resume` 在 Terminal 接回同一会话 |
| Transcript 同步 | 本机续聊和 Discord 发起的消息都能同步回 Discord，保留完整记录；最终总结回复遇到瞬时写入失败也会补发 |
| 实时进度面板 | 持续更新回复草稿、分析摘要、计划、时间线、当前命令、输出预览和 stderr；长消息时优先保留最新状态 |
| 运行中引导 | 用 `!guide <内容>` 在任务执行途中插入额外要求，再继续原任务 |
| Goal Loop | 用 `!goal <目标>` 让当前 Codex 会话持续推进目标；`!goal status` 查看状态，`!goal stop` 停止，过程中不会 reset 或丢失上下文 |
| 文件双向传输 | Discord 上传文件自动落地到工作区 `inbox/`，也能把工作区文件直接回传到 Discord |
| Autopilot | 对绑定项目做周期性自动迭代，支持服务级和项目级开关、周期、并行度和自然语言方向 |
| Web 管理面板 | 查看绑定、会话、运行状态，并从浏览器管理 bridge |
| macOS 服务化 | 支持 `launchd` 的 `LaunchAgent` 和 `LaunchDaemon` |
| 恢复与重试 | Bridge 重启后优先恢复未完成任务；最终总结回复遇到 Discord 瞬时写入失败会延迟重试并补发 |
| 代理自动探测 | 启动脚本会优先直连，失败时自动尝试 `http://127.0.0.1:7890` |

## 工作模型

这个项目的核心模型很简单：

- 一个 Discord 主频道 = 一个项目目录
- 一个 Discord 线程 = 该项目下的一条独立 Codex 会话
- `!status` = 当前会话的恢复入口
- `bridgectl` = 本机控制同一 bridge 服务的 CLI

示例：

- `#proj-api` -> `/path/to/workspaces/api`
- `#proj-app` -> `/path/to/workspaces/app`
- `#proj-api` 里的线程 `修登录` -> `api` 项目下的一条独立 Codex 会话
- `#proj-api` 里的线程 `写文档` -> `api` 项目下的另一条独立 Codex 会话

这样做的结果是：

- 项目维度在频道里管理
- 任务维度在线程里管理
- 同一条会话既能在 Discord 里继续，也能在 Terminal 里继续

## 平台支持

| 平台 | 推荐安装方式 | 当前状态 |
| --- | --- | --- |
| macOS | `./scripts/macos-bridge.sh deploy` | 完整支持：交互式配置、`bridgectl` 安装、`launchd` 自启动 |
| Linux | 手动 `npm ci` + `.env` + `npm run start` | 支持核心 bridge、Web 面板、Discord 绑定、`!status` 续聊和 `bridgectl`；不提供 `macos-bridge.sh` / `launchd` |
| Windows（WSL） | 在 WSL 的 Bash 里按 Linux 步骤安装 | 推荐方案；工作区尽量放在 WSL Linux 文件系统内，例如 `/home/<user>/workspaces` |

## 运行要求

- macOS，或 Linux / WSL
- Node.js `>= 20.11`
- 已安装并登录的 `codex` CLI
- 一个可用的 Discord Bot
- Bot 已加入目标 Discord 服务器
- Bot 已启用 **Message Content Intent**

当前版本已经按 `codex-cli 0.116.0` 做过验证。

## Codex CLI 兼容性

如果你希望整个系统保持高权限，推荐在 Codex 顶层配置里使用：

```toml
sandbox_mode = "danger-full-access"
approval_policy = "never"
approval_mode = "never"

[features]
multi_agent = true
goals = true
```

这会保留全局高权限，不会把访问范围限制在当前项目目录。

Bridge 启动时会自动确保 `~/.codex/config.toml` 里存在上面的 `[features]` 开关；Bridge 启动 Codex 时也会显式传入 `features.multi_agent=true` 和 `features.goals=true`，除非单个项目的额外配置明确覆盖它们。

不要继续保留旧的权限 profile：

```toml
default_permissions = "full"

[permissions.full]
open_world_enabled = true
destructive_enabled = true
```

在 `codex-cli 0.116.0` 上，这组旧键会让 `codex app-server` 报权限配置不兼容，并导致 bridge 回退到 `legacy-exec`。

## 快速开始

先选安装路线：

- macOS：继续看下面这一节，或直接打开 [docs/MACOS-deploy.md](docs/MACOS-deploy.md)
- Linux / WSL：直接打开 [docs/LINUX-WSL.md](docs/LINUX-WSL.md)
- 如果你还没准备好 Discord Bot Token、用户 ID、Resume ID、频道 ID 这些值，先看 [docs/QUICKSTART.md](docs/QUICKSTART.md) 里的“先准备这些值”

### 1. 部署 bridge

如果你在 macOS：

```bash
cd /path/to/codex-discord-bridge
./scripts/macos-bridge.sh deploy
```

如果你在 Linux / WSL，推荐按这条路线走：

```bash
cd /path/to/codex-discord-bridge
npm ci
cp .env.example .env
npm run check
npm run build
npm run start
```

Linux / WSL 还需要手动创建 `~/.codex-tunning/secrets.env`、填写 `.env`、把 `bridgectl` 放进 Bash 的 `PATH`。完整步骤见 [docs/LINUX-WSL.md](docs/LINUX-WSL.md)。

脚本会交互式提示你填写或确认：

- `CODEX_TUNNING_DISCORD_BOT_TOKEN`
- `ALLOWED_WORKSPACE_ROOTS`
- `DISCORD_ADMIN_USER_IDS`
- `WEB_PORT`
- `WEB_AUTH_TOKEN`
- `CODEX_DISCORD_BRIDGE_PROXY`

其中：

- Discord Bot Token 会单独保存到 `~/.codex-tunning/secrets.env`
- 不会写入项目 `.env`
- 启动脚本会先测试 Discord 直连，失败后再自动尝试 `http://127.0.0.1:7890`
- 当检测到代理时，脚本会自动补充 Node 证书链参数，处理常见的本地代理 TLS 问题

### 2. 安装并确认 `bridgectl`

macOS 路线中，`setup`、`deploy`、`install-service` 会自动把 `bridgectl` 安装到用户 PATH 目录，默认优先使用 `~/bin`。如果当前终端还没刷新 PATH，执行一次：

```bash
rehash
```

或者直接新开一个终端窗口。

Linux / WSL 路线中，需要手动把 `scripts/bridgectl` 链接到 `~/bin/bridgectl`，并把 `~/bin` 写入 Bash 的 `PATH`。完整步骤见 [docs/LINUX-WSL.md](docs/LINUX-WSL.md)。

你也可以随时验证：

```bash
which bridgectl
bridgectl --help
```

### 3. 启动和查看服务

macOS：

```bash
./scripts/macos-bridge.sh status
./scripts/macos-bridge.sh logs
./scripts/macos-bridge.sh open
```

Linux / WSL：

```bash
npm run start
```

Linux / WSL 默认就是在当前终端前台运行；日志直接看当前终端输出即可。Web 面板地址通常是：

```text
http://127.0.0.1:3769/?token=<YOUR_WEB_AUTH_TOKEN>
```

如果你想安装成开机或登录自启动服务，可以继续看：

- [docs/QUICKSTART.md](docs/QUICKSTART.md)
- [docs/MACOS-deploy.md](docs/MACOS-deploy.md)
- [docs/LINUX-WSL.md](docs/LINUX-WSL.md)
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)

## 日常使用

### 1. 绑定一个项目到 Discord 主频道

在普通文本频道发送：

```text
!bind api "/path/to/workspaces/api" --sandbox danger-full-access --approval never --search off
```

说明：

- `!bind` 必须在普通文本频道里执行
- 线程会自动继承主频道绑定，不需要重复绑定
- 如果目标目录不存在，bridge 会先自动创建再完成绑定
- 如果目标目录不是 Git 仓库，建议显式加上 `--skip-git-check on`，避免 `app-server` 因仓库检查回退到 `legacy-exec`

### 2. 像普通聊天一样驱动 Codex

绑定完成后，该主频道中的普通消息会直接变成 Codex prompt。你会同时看到：

- 一条持续更新的“Codex 实时进度”消息
- 一条本轮最终结果回复

如果最终结果回复在发送到 Discord 时碰到短暂网络抖动或连接中断，bridge 会先把这条回复加入待补发队列，恢复后自动重试，避免频道里只剩过程消息而丢掉总结性回复。

实时进度消息会展示：

- 最新回复草稿
- reasoning / 分析摘要
- todo / 计划状态
- 时间线
- 当前命令
- 输出预览
- stderr 预览

补充说明：

- Bridge 现在会同时兼容传统 `app-server` delta 事件和较新的 Codex live event 形态，所以真实运行中的计划、分析和回复草稿会持续刷新，而不是只在最后一次性出现。
- 当实时进度消息过长时，bridge 会优先保留“最新回复草稿”和“最新计划状态”，避免旧内容把最新状态挤到 `...` 之后看不见。

### 3. 在线程里拆分任务

在已绑定主频道下创建线程并继续发送消息后：

- 线程继承主频道的项目目录
- 每个线程都有自己的队列、状态和进度面板
- 每个线程都有独立的 Codex 会话

这意味着你可以把“修登录”“补测试”“改 README”拆成不同线程并行推进。

### 4. 用 `!status` 把会话接回本机

在 Discord 当前频道或线程发送：

```text
!status
```

返回内容会包含：

- 完整 Resume ID
- 一条可直接复制的命令：`bridgectl session resume <Resume ID>`
- 当前项目、目录、状态和队列信息

然后在本机终端执行：

```bash
bridgectl session resume <Resume ID>
```

进入本机续聊后这样使用：

- 普通单行输入：直接输入，按一次 `Enter`
- 多行粘贴：整段粘贴后不会立刻发送；再按一次 `Enter` 才会把整段作为一次输入发给 bridge
- 查看状态：输入 `/status`
- 退出本机会话：输入 `/exit`

如果你只想脚本化发一条消息，也可以用：

```bash
bridgectl session status <Resume ID>
bridgectl session send <Resume ID> "hello"
```

本机续聊产生的用户消息和助手回复会同步回 Discord transcript，所以 Discord 端记录仍然是完整的。

### 5. 运行中插入中途引导

如果当前任务还在执行，发送：

```text
!guide 先补 README 的使用说明，再继续原任务
```

Bridge 会中断当前步骤，在同一条 Codex 会话里先处理新增引导，然后继续原任务。只有当新引导明确要求停止或替换原任务时，bridge 才会转向新的目标。

### 6. 启动 Goal Loop

如果你希望 Codex 持续推进一个明确目标，而不是只完成一轮普通问答，可以在当前绑定频道或线程发送：

```text
!goal 把当前项目测试全部修到通过，并补齐必要文档
```

常用命令：

```text
!goal <目标>
!goal status
!goal stop
```

行为规则：

- `!goal <目标>` 会复用当前频道或线程的 Codex 会话，不会自动 `reset`，因此已有上下文会保留。
- 在 `app-server` 驱动下，bridge 会优先调用 Codex 原生 `thread/goal/set` API 设置目标，然后发送一条自然语言推进提示。
- `!goal status` 只查看当前 Goal Loop 状态，不会触发新任务。
- `!goal stop` 会清除 Codex 目标状态，并在当前运行任务是 goal 任务时请求取消；它不会删除会话，也不会清空上下文。
- Discord 侧只支持 `!goal` 命令；不要在 Discord 里使用 `/goal` slash command。

### 7. 文件上传和回传

文件收发支持两条方向：

- 从 Discord 到工作区
- 从工作区回 Discord

行为规则：

- 图片附件会自动透传给 `codex -i`
- 所有上传文件都会缓存到 `data/attachments/<conversation>/<task>/`
- 同时会镜像到当前绑定项目目录下的 `inbox/`
- 回传文件时会尽量保留原文件名；只有目标位置已存在同名文件时，才会追加随机后缀
- 默认先在工作区 `inbox/` 查找，再扩展到其余工作区文件
- 如果有多个匹配，bridge 会返回候选编号

常见用法：

```text
把 report.pdf 发给我
!sendfile report.pdf
!sendfile 2
```

显式绝对路径只允许管理员使用，例如：

```text
!sendfile /absolute/path/to/report.pdf
```

### 8. 开启 Autopilot

如果你希望 bridge 周期性处理“补测试、低风险修复、小范围清理”这类工作，最短流程如下：

```text
!autopilot server on
!autopilot project on
!autopilot project interval 30m
!autopilot project prompt 优先补测试和稳定性，不要做大功能
```

说明：

- 服务级 Autopilot 默认并行度为 `5`
- 可以随时执行 `!autopilot server concurrency <N>` 调整
- 手动会话和 Autopilot 定时任务彼此独立，不互相占用运行槽
- `!autopilot project run` 可以立刻触发当前项目执行一次

更完整的说明见 [docs/AUTOPILOT.md](docs/AUTOPILOT.md)。

## 命令参考

### Discord 命令

| 命令 | 用途 |
| --- | --- |
| `!help` | 显示帮助和常见操作 |
| `!bind <project> <path> [...]` | 把当前主频道绑定到本地目录 |
| `!status` | 查看当前会话状态、Resume ID 和本机续聊命令 |
| `!queue` | 查看当前会话排队情况 |
| `!queue insert <序号>` | 把队列里的任务插到指定位置 |
| `!queue remove <序号>` | 移除排队中的任务 |
| `!guide <内容>` | 在执行途中插入引导，再继续原任务 |
| `!goal <目标>` | 启动当前会话的 Goal Loop，不 reset 上下文 |
| `!goal status` | 查看当前 Goal Loop 状态 |
| `!goal stop` | 停止 Goal Loop，保留当前 Codex 会话 |
| `!sendfile <文件名/相对路径/绝对路径/序号>` | 把工作区文件发回 Discord |
| `!web` | 返回 Web 管理面板地址 |
| `!cancel` | 取消当前运行 |
| `!reset` | 重置当前会话 |
| `!unbind` | 解绑当前主频道 |
| `!projects` | 查看当前绑定的项目列表 |
| `!autopilot ...` | 管理服务级和项目级 Autopilot |

Autopilot 常用子命令：

```text
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
```

### 本机 `bridgectl`

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

项目定位规则：

- `--channel <频道ID>` 优先级最高
- `--project <绑定项目名>` 次之
- 如果两者都不传，CLI 会按当前工作目录匹配已绑定项目
- 匹配不到或匹配多个时直接报错，不猜

如果你不想走 PATH，也可以直接运行：

```bash
./scripts/bridgectl session resume <Resume ID>
npm run cli -- session resume <Resume ID>
```

## 服务、Web 面板与运维

### Web 管理面板

默认地址：

```text
http://127.0.0.1:3769
```

如果配置了 `WEB_AUTH_TOKEN`，可以直接使用：

```text
http://127.0.0.1:3769/?token=<YOUR_WEB_AUTH_TOKEN>
```

### 常用脚本

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

也提供对应的 npm 脚本：

```bash
npm run macos:deploy
npm run macos:start
npm run macos:stop
npm run macos:restart
npm run macos:status
npm run macos:service-status
```

### 服务模式切换

登录启动改为真正开机启动：

```bash
./scripts/uninstall-service.sh --mode agent
sudo ./scripts/install-service.sh --mode daemon
```

开机启动改回登录启动：

```bash
sudo ./scripts/uninstall-service.sh --mode daemon
./scripts/install-service.sh --mode agent
```

当前版本的 `restart` 会优先用 `launchctl kickstart -k` 做原子重启，而不是简单的 `stop` 再 `start`。这样即使重启命令是从 bridge 自己承载的会话里发起，也不会因为先停掉当前服务而把后半段命令链一起切断。

## 配置

最常用的环境变量如下：

| 变量 | 说明 |
| --- | --- |
| `CODEX_TUNNING_DISCORD_BOT_TOKEN` | Discord Bot Token；建议只保存在 `~/.codex-tunning/secrets.env` |
| `ALLOWED_WORKSPACE_ROOTS` | 允许绑定的项目根目录，多个目录用逗号分隔 |
| `DISCORD_ADMIN_USER_IDS` | 允许执行管理命令的 Discord 用户 ID，多个 ID 用逗号分隔 |
| `DEFAULT_CODEX_SANDBOX` | 默认 sandbox 模式，默认 `danger-full-access` |
| `DEFAULT_CODEX_APPROVAL` | 默认 approval 策略 |
| `DEFAULT_CODEX_SEARCH` | 默认是否开启搜索 |
| `DEFAULT_CODEX_SKIP_GIT_REPO_CHECK` | 默认是否跳过 Git 仓库检查，默认 `true` |
| `WEB_PORT` | Web 面板端口，默认 `3769` |
| `WEB_AUTH_TOKEN` | Web 面板鉴权 token |
| `CODEX_DISCORD_BRIDGE_PROXY` | Bridge 连接 Discord 和下载附件时使用的代理 |
| `CODEX_DISCORD_BRIDGE_CA_CERT` | 代理 CA 证书 PEM 文件 |
| `CODEX_DISCORD_BRIDGE_WEB_ORIGIN` | 本机 CLI 使用的 Web API 地址覆盖值 |
| `CODEX_DISCORD_BRIDGE_WEB_AUTH_TOKEN` | 本机 CLI 使用的 Web 鉴权 token 覆盖值 |
| `OPENCLAW_CONFIG_PATH` | OpenClaw 配置路径，默认 `~/.openclaw/openclaw.json` |

完整示例见 [.env.example](.env.example)。

管理员判定规则：

- 用户 ID 命中 `DISCORD_ADMIN_USER_IDS`
- 或在 Discord 中拥有 `Manage Guild` / `Manage Channels` 权限

管理员命令包括：

- `!bind`、`!unbind`
- `!cancel`、`!reset`
- `!queue insert <序号>`
- `!queue remove <序号>`
- 会修改 Autopilot 状态的命令
- 显式绝对路径文件发送

## 文档索引

目前公开可用的主要功能都已经在 README 或下列文档中覆盖：

| 主题 | 文档 |
| --- | --- |
| 5 分钟快速上手 | [docs/QUICKSTART.md](docs/QUICKSTART.md) |
| macOS 部署、Bot 创建、自启动 | [docs/MACOS-deploy.md](docs/MACOS-deploy.md) |
| Linux / WSL 安装、配置、运行 | [docs/LINUX-WSL.md](docs/LINUX-WSL.md) |
| 运维、升级、日志、launchd、运行目录 | [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) |
| Autopilot 使用与设计 | [docs/AUTOPILOT.md](docs/AUTOPILOT.md) |
| Git 远端与推送说明 | [docs/GIT.md](docs/GIT.md) |
| 版本变更记录 | [docs/CHANGELOG.md](docs/CHANGELOG.md) |
| 运维故障记录 | [docs/ops/2026-03-26-launchagent-recovery.md](docs/ops/2026-03-26-launchagent-recovery.md) |
| 历史设计与实施记录 | [docs/plans](docs/plans) |

如果你只关心“怎么安装、怎么绑定、怎么恢复会话、怎么开启 Autopilot”，按这个顺序阅读即可：

1. [README.md](README.md)
2. [docs/QUICKSTART.md](docs/QUICKSTART.md)
3. macOS 用户继续看 [docs/MACOS-deploy.md](docs/MACOS-deploy.md)
4. Linux / WSL 用户继续看 [docs/LINUX-WSL.md](docs/LINUX-WSL.md)
5. [docs/AUTOPILOT.md](docs/AUTOPILOT.md)
6. [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)

## 开发

```bash
npm install
npm run check
npm test
npm run build
npm run smoke:local
npm run smoke:discord
```

## 安全与隐私

- Discord Bot Token 默认单独保存在 `~/.codex-tunning/secrets.env`
- 项目 `.env` 默认不保存 Discord Token
- 运行态日志、PID、状态、附件和 transcript 都保存在本地机器
- `data/`、`logs/`、`.run/` 已在 `.gitignore` 中忽略，避免把运行态数据误提交
- 建议把 `ALLOWED_WORKSPACE_ROOTS` 收紧到你真正愿意暴露给 Discord 的目录
- 建议为 Web 面板配置 `WEB_AUTH_TOKEN`
- 如果你不希望 Discord 中的 Codex 默认拥有写权限，可以把 `DEFAULT_CODEX_SANDBOX` 改回 `workspace-write` 或 `read-only`
- 本仓库文档中的路径、Resume ID、服务标签和主机地址已尽量使用占位示例，避免泄露真实个人环境信息

## 故障排查

### 服务已安装但没有跑起来

优先查看：

- [docs/ops/2026-03-26-launchagent-recovery.md](docs/ops/2026-03-26-launchagent-recovery.md)

常用检查命令：

```bash
./scripts/macos-bridge.sh service-status
./scripts/macos-bridge.sh logs
```

### Discord 里明明绑定了高权限，但仍提示只读

优先按这个顺序处理：

1. 重启本地 bridge 服务
2. 在 Discord 当前频道发送 `!reset`
3. 必要时重新执行一次 `!bind ... --sandbox danger-full-access --approval never`
4. 再做一次最小写入验证

常见原因：

- 旧的 Codex 会话恢复后仍保留了之前的低权限上下文
- 旧版本服务进程继承了错误的外部环境变量，导致 Discord 子进程落入只读上下文

### `bridgectl` 找不到

先执行：

```bash
rehash
which bridgectl
```

如果仍然找不到，重新运行：

```bash
./scripts/macos-bridge.sh setup
```

然后重新打开一个终端窗口再试。

## License

本项目采用 **PolyForm Noncommercial 1.0.0**：

- 允许个人和其他非商业用途免费使用、修改和再分发
- 不允许商业使用
- 商业授权请联系版权持有人另行协商

详见：

- [LICENSE](LICENSE)
- [NOTICE](NOTICE)
