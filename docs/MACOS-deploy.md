# macOS 部署与使用全流程

这份文档面向第一次部署的用户，覆盖：

- 需要准备什么
- Discord Bot 怎么创建
- Token、用户 ID、权限、代理怎么获得
- 如何在 macOS 上一键部署
- 如何安装开机启动服务
- 如何在 Discord 里把“频道 ↔ 项目目录”绑定起来
- 如何使用线程作为独立 Codex 会话
- 如何查看实时进度、传图片和普通附件
- 如何排查常见问题

## 一、你最终会得到什么

部署完成后，你将获得一套本机服务：

- 一个 Discord 主频道对应一个本地项目目录
- 主频道下每个线程对应该项目里的一个独立 Codex 会话
- 在 Discord 里发消息即可驱动本机 `codex`
- 运行中可以实时看到 reasoning、todo/plan、时间线、当前命令和输出预览
- 可以安装为 `launchd` 服务，实现开机启动或登录后启动
- 可通过 Web 面板查看绑定和会话状态

## 二、前置条件

请先确认：

1. 你使用的是 macOS
2. 已安装 Node.js `>= 20.11`
3. 已安装并登录 `codex` CLI
4. 你有权限在 Discord 服务器里添加 Bot
5. 你愿意把哪些本地目录暴露给 Discord 控制，已经想清楚

## 三、这些信息要怎么获得

### 1. Discord Bot Token

获取路径：

1. 打开 [Discord Developer Portal](https://discord.com/developers/applications)
2. 点击 `New Application`
3. 为应用起名，例如 `Codex Bridge`
4. 左侧进入 `Bot`
5. 点击 `Add Bot`
6. 在 `Token` 区域点击 `Reset Token` 或 `Copy`

这串 token 就是部署脚本会询问你的：

```text
CODEX_TUNNING_DISCORD_BOT_TOKEN
```

它不会写进项目 `.env`，而是单独写到：

```text
~/.codex-tunning/secrets.env
```

### 2. 你的 Discord 用户 ID

这个值用于可选的管理员白名单：

```text
DISCORD_ADMIN_USER_IDS
```

获取方法：

1. 打开 Discord 客户端
2. `User Settings` → `Advanced`
3. 打开 `Developer Mode`
4. 回到你的头像或任意消息右键菜单
5. 点击 `Copy User ID`

如果你不填，也可以依赖频道管理权限来执行管理员命令。

### 3. 允许绑定的项目根目录

这是为了安全，限制 Bot 只能把 Discord 频道绑定到你明确允许的目录中。

例如：

```text
/path/to/workspaces,/path/to/projects
```

建议只填写你真正需要让 Bot 访问的目录。

### 4. Web 面板鉴权 Token

这是本地 Web 管理面板的登录 token，建议保留。

你可以：

- 手动输入一串高强度随机字符串
- 或者在脚本提示时直接回车，让它保留现有值 / 自动生成值

### 5. 代理地址（可选）

如果你的网络环境访问 Discord 不稳定，可以设置：

```text
http://127.0.0.1:7890
```

部署脚本会把它写入：

```text
CODEX_DISCORD_BRIDGE_PROXY
```

并在启动时自动注入 `HTTP_PROXY` / `HTTPS_PROXY`。脚本现在会先直连探测 Discord；只有直连失败时，才会自动尝试 `http://127.0.0.1:7890` 并把结果写回这个变量。

如果你在代理环境下启动时看到：

```text
Error: unable to get local issuer certificate
```

当前脚本会在检测到 `CODEX_DISCORD_BRIDGE_PROXY` 时自动为 Node 注入 `--use-system-ca`；如果系统存在 `/etc/ssl/cert.pem`，也会把它作为额外 CA bundle 注入。这通常足够让服务信任 macOS 已信任的代理根证书。

如果你使用的是 `daemon` 模式，且证书只存在于登录用户上下文，仍可能需要把代理根证书导出成 PEM，并在 `.env` 中额外设置：

```text
CODEX_DISCORD_BRIDGE_CA_CERT=/path/to/proxy-ca.pem
```

### 6. OpenClaw 配置（可选）

如果你的机器上已存在：

```text
~/.openclaw/openclaw.json
```

脚本会先尝试从中读取可识别的：

- Discord Bot Token
- Discord 代理配置

你仍然可以在交互式配置里覆盖它。

## 四、把 Bot 授权进你的 Discord 服务器

### 1. 生成邀请链接

在 Discord Developer Portal 中：

1. 进入你的 Application
2. 打开 `OAuth2` → `URL Generator`
3. 勾选 `bot` scope
4. 勾选下列权限：
   - `View Channels`
   - `Read Message History`
   - `Send Messages`
   - `Send Messages in Threads`
   - `Attach Files`
   - `Embed Links`
5. 打开生成出的 URL，并把 Bot 邀请到目标服务器

### 2. 启用 Intent

在 `Bot` 页面中，至少打开：

- `MESSAGE CONTENT INTENT`

否则机器人无法读取频道中的普通消息内容，也就无法把它们转成 Codex prompt。

## 五、在 macOS 上一键部署

进入项目目录后执行：

```bash
cd /path/to/codex-discord-bridge
./scripts/macos-bridge.sh deploy
```

常用命令如下：

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
./scripts/macos-bridge.sh deploy
```

## 六、部署脚本会做什么

执行 `deploy` 时，会自动串起以下步骤：

1. 检查 `node`、`npm`、`codex`
2. 创建 `.env`（如果不存在）
3. 尝试导入 `~/.openclaw/openclaw.json` 中可识别的 Token / 代理
4. 交互式让你确认关键配置
5. 把 Discord Token 单独写入 `~/.codex-tunning/secrets.env`
6. 安装依赖
7. 运行类型检查
8. 执行构建
9. 询问是否安装为 `launchd` 服务
10. 若未安装 `launchd`，则后台启动服务

## 七、部署时你会被问到什么

### `Discord Bot Token`

直接粘贴刚才从 Discord Developer Portal 复制的 token 即可。

### `ALLOWED_WORKSPACE_ROOTS`

建议填绝对路径，多个目录逗号分隔，例如：

```text
/path/to/workspaces,/path/to/projects
```

### `DISCORD_ADMIN_USER_IDS`

可选。填你的 Discord 用户 ID；多个 ID 用逗号分隔。

### `WEB_PORT`

本地 Web 面板端口，默认：

```text
3769
```

### `WEB_AUTH_TOKEN`

建议保留，避免本机 Web 面板裸奔。

### `CODEX_DISCORD_BRIDGE_PROXY`

如果你访问 Discord 需要代理，这里填写：

```text
http://127.0.0.1:7890
```

## 八、在一台新 Mac 上，从 Gitee 拉下来之后怎么完整部署

这部分就是“换一台全新的 macOS 机器”时，最推荐照着走的一条龙流程。

### 1. 先准备这台 Mac

至少确保这台机器已经具备：

- `git`
- Node.js `>= 20.11`
- 已安装并登录的 `codex` CLI
- 能正常访问 Discord；如果不能，请提前准备好代理 `http://127.0.0.1:7890`

可以先执行：

```bash
git --version
node -v
npm -v
codex --version
```

### 2. 从 Gitee 拉代码

如果你已经给这台 Mac 配好了 Gitee SSH Key，推荐直接用 SSH：

```bash
git clone git@gitee.com:<你的 Gitee 用户名>/<你的仓库名>.git
cd <你的仓库目录名>
```

如果你还没有配 SSH Key，也可以先用 HTTPS：

```bash
git clone https://gitee.com/<你的 Gitee 用户名>/<你的仓库名>.git
cd <你的仓库目录名>
```

如果这是一个私有仓库：

- 使用 SSH 时，要先把这台 Mac 的公钥加到 Gitee 账号
- 使用 HTTPS 时，拉取时需要输入 Gitee 账号凭据

### 3. 直接执行一键部署

进入仓库目录后，直接运行：

```bash
./scripts/macos-bridge.sh deploy
```

这个命令会自动：

1. 检查 `node`、`npm`、`codex`
2. 创建或更新项目 `.env`
3. 交互式询问关键配置
4. 把 Discord Bot Token 单独写入 `~/.codex-tunning/secrets.env`
5. 安装依赖
6. 执行类型检查
7. 执行构建
8. 询问你是否安装为 macOS 自启动服务

### 4. 部署过程中你需要准备并填写的信息

部署脚本会提示你输入或确认这些值：

- `CODEX_TUNNING_DISCORD_BOT_TOKEN`
- `ALLOWED_WORKSPACE_ROOTS`
- `DISCORD_ADMIN_USER_IDS`
- `WEB_PORT`
- `WEB_AUTH_TOKEN`
- `CODEX_DISCORD_BRIDGE_PROXY`（自动探测，通常无需手填）

建议这样理解：

- `CODEX_TUNNING_DISCORD_BOT_TOKEN`：Discord Developer Portal 里复制出来的 Bot Token
- `ALLOWED_WORKSPACE_ROOTS`：这台新 Mac 上允许被 Discord 控制的项目根目录
- `DISCORD_ADMIN_USER_IDS`：你的 Discord 用户 ID，可选但建议填写
- `WEB_PORT`：本地管理面板端口，默认 `3769`
- `WEB_AUTH_TOKEN`：本机 Web 管理面板鉴权 token，建议保留
- `CODEX_DISCORD_BRIDGE_PROXY`：脚本会自动探测并在需要时写成 `http://127.0.0.1:7890`

### 5. 选择是否安装成自启动服务

部署脚本跑完后，会继续问你要不要安装成 `launchd` 服务。

通常建议：

- 这台机器是长期在线的桥接机：选 `daemon`
- 这台机器只是你日常登录使用的个人电脑：选 `agent`

如果你想手动安装：

```bash
./scripts/install-service.sh --mode daemon
```

或者：

```bash
./scripts/install-service.sh --mode agent
```

### 6. 确认服务已经真的跑起来

部署完成后，执行：

```bash
./scripts/macos-bridge.sh status
./scripts/macos-bridge.sh service-status
./scripts/macos-bridge.sh logs
```

正常情况下，你应该能在日志里看到：

```text
Discord bot connected as <bot-name>#<discriminator>
```

如果你配置了 Web 面板，也可以打开：

```bash
./scripts/macos-bridge.sh open
```

### 7. 第一次在 Discord 里验证

先到你的 Discord 服务器里，找一个普通文本频道发送：

```text
!bind demo "/这台新 Mac 上的某个项目目录" --sandbox danger-full-access --approval never --search off
```

绑定成功后，再发一条普通消息，例如：

```text
请告诉我当前项目目录有哪些文件
```

如果机器人开始回复实时进度，并且最终返回结果，说明这台新 Mac 上的整套链路已经打通。

### 8. 新 Mac 上推荐的日常管理命令

以后你主要会用到这些：

```bash
./scripts/macos-bridge.sh restart
./scripts/macos-bridge.sh status
./scripts/macos-bridge.sh service-status
./scripts/macos-bridge.sh logs
./scripts/macos-bridge.sh configure
```

如果你从 Gitee 拉了新版本，推荐更新流程：

```bash
git pull
npm install
npm run check
npm test
npm run build
./scripts/macos-bridge.sh restart
```

### 9. 新 Mac 常见问题

#### 拉仓库失败

优先检查：

- 这台 Mac 是否已经配置 Gitee SSH Key
- 私有仓库是否有访问权限
- 是否需要改用 HTTPS 克隆

#### Discord 连不上

优先检查：

- `CODEX_TUNNING_DISCORD_BOT_TOKEN` 是否正确
- Discord Developer Portal 是否启用了 `MESSAGE CONTENT INTENT`
- 这台新机器是否需要代理

如果需要代理，请重新执行：

```bash
./scripts/macos-bridge.sh configure
./scripts/macos-bridge.sh restart
```

然后确认 `CODEX_DISCORD_BRIDGE_PROXY` 已自动写成：

```text
http://127.0.0.1:7890
```

#### 绑定成功但写文件仍提示只读

先执行：

```bash
./scripts/macos-bridge.sh restart
```

然后在 Discord 目标频道发送：

```text
!reset
```

必要时重新绑定：

```text
!bind demo "/这台新 Mac 上的项目目录" --sandbox danger-full-access --approval never --search on
```

## 九、开机启动 / 登录启动怎么选

部署结束后，脚本会继续询问是否安装自启动服务，并让你选择模式：

### 方案 A：`daemon` 开机启动

特点：

- 机器开机后就自动拉起
- 适合把这台 Mac 当作长期在线的桥接主机
- 首次安装需要 `sudo`

安装命令：

```bash
./scripts/install-service.sh --mode daemon
```

### 方案 B：`agent` 登录后启动

特点：

- 只有登录用户会话建立后才启动
- 不需要 `sudo`
- 更适合个人日常桌面环境

安装命令：

```bash
./scripts/install-service.sh --mode agent
```

### 查看和卸载服务

查看：

```bash
./scripts/macos-bridge.sh service-status
```

卸载：

```bash
./scripts/uninstall-service.sh --mode daemon
./scripts/uninstall-service.sh --mode agent
```

### 从登录启动切换到开机启动

```bash
./scripts/uninstall-service.sh --mode agent
sudo ./scripts/install-service.sh --mode daemon
```

## 十、部署后的文件在哪

默认情况下：

- 项目配置：`/path/to/codex-discord-bridge/.env`
- Discord 密钥：`~/.codex-tunning/secrets.env`
- 运行日志：`/path/to/codex-discord-bridge/logs/codex-discord-bridge.log`
- PID 文件：`/path/to/codex-discord-bridge/.run/codex-discord-bridge.pid`
- 运行状态：`/path/to/codex-discord-bridge/data/state.json`
- Web 面板：`http://127.0.0.1:3769`
- LaunchAgent：`~/Library/LaunchAgents/<label>.plist`
- LaunchDaemon：`/Library/LaunchDaemons/<label>.plist`

## 十一、怎么确认 Bot 已经上线

执行：

```bash
./scripts/macos-bridge.sh status
./scripts/macos-bridge.sh service-status
```

再看日志：

```bash
./scripts/macos-bridge.sh logs
```

正常情况下，你会看到类似：

```text
Discord bot connected as <bot-name>#<discriminator>
```

## 十二、在 Discord 里怎么绑定和使用

### 1. 在主频道绑定项目

在普通文本频道发送：

```text
!bind api "/path/to/workspaces/api" --sandbox danger-full-access --approval never --search off
```

说明：

- `!bind` 必须在主频道执行
- 该主频道下创建的线程会自动继承此绑定
- 默认 `.env` 已把 `DEFAULT_CODEX_SANDBOX` 设为 `danger-full-access`

### 2. 线程会自动变成独立会话

绑定完成后：

- 主频道继续承担“项目入口”
- 每个线程会成为该项目下的一条独立 Codex 会话

### 3. 运行中插入新的引导

如果 Codex 正在运行，而你希望临时改方向，直接发送：

```text
!guide 现在先创建部署文档，然后继续完成当前项目任务
```

Bridge 会中断当前步骤，并在**同一会话**中先处理这条引导，再继续原任务；只有当引导明确要求停止或替换原任务时，才会改成新目标。

### 4. 图片和文件怎么传

- 图片附件会自动透传给 `codex -i`
- 普通文件会下载到本地附件目录，并提示 Codex 读取

## 十三、权限和写文件说明

为了让 Discord 中的 Codex 能像本地 CLI 一样写文件，当前默认策略是：

- `DEFAULT_CODEX_SANDBOX=danger-full-access`
- `DEFAULT_CODEX_APPROVAL=never`

如果你已经绑定过旧频道，但之前是低权限模式，重新发送一次新的 `!bind` 即可切换到高权限会话。

如果你不希望默认就是高权限，可以把 `.env` 中的 `DEFAULT_CODEX_SANDBOX` 改回：

- `workspace-write`
- `read-only`

## 十四、如果 Discord 里仍然显示只读怎么办

如果你已经绑定了高权限：

```text
!bind tmp "/path/to/project" --sandbox danger-full-access --approval never --search on
```

但它仍回你：

- `Operation not permitted`
- `touch ...` 失败
- `python3 -m venv .venv` 失败

按下面顺序处理：

1. 在本机重启 bridge

```bash
./scripts/macos-bridge.sh restart
```

2. 在 Discord 当前频道发送

```text
!reset
```

3. 如有必要，再重新发送一次高权限 `!bind`

根因通常是：

- 旧 Codex 会话还没被刷新
- 或者旧版本 bridge 进程继承了桌面版 Codex 的内部环境变量，导致子进程错误进入只读上下文
- 或者 `~/.codex/config.toml` 里还保留了旧的 `default_permissions = "full"` / `[permissions.full]` 配置，导致 `codex-cli 0.116.0` 的 `app-server` 启动时直接报权限 profile 不兼容

当前版本已经修复第二类问题，但旧进程必须重启后才会生效。

如果是第三类问题，请保留顶层全权限配置：

```toml
sandbox_mode = "danger-full-access"
approval_policy = "never"
approval_mode = "never"
```

并删除旧的：

```toml
default_permissions = "full"

[permissions.full]
open_world_enabled = true
destructive_enabled = true
```

如果 Discord 客户端里仍显示离线，重点检查：

- Token 是否正确
- `MESSAGE CONTENT INTENT` 是否开启
- Bot 是否已加入目标服务器
- 网络是否需要代理

## 十、在 Discord 里如何使用

### 1. 主频道绑定项目

在一个普通文本频道中执行：

```text
!bind api "/path/to/workspaces/api" --sandbox workspace-write --approval never --search off
```

绑定后，这个主频道就对应：

```text
/path/to/workspaces/api
```

### 2. 为什么不能在线程里 `!bind`

线程会自动继承主频道绑定，所以：

- **主频道负责绑定项目**
- **线程负责承载独立任务会话**

因此 `!bind` 应在普通文本频道执行，而不是在线程中执行。

### 3. 怎么控制不同项目

推荐：

- `#proj-api` 绑定 `/path/to/workspaces/api`
- `#proj-app` 绑定 `/path/to/workspaces/app`
- 每个频道下再开多个线程处理不同任务

### 4. 线程里的会话开到哪里

线程会运行在其主频道所绑定的项目目录里。

也就是说：

- 主频道决定“在哪个项目目录运行”
- 线程决定“这次任务使用哪个独立 Codex 会话上下文”

### 5. 实时反馈是什么样

在你发送任务后，机器人会维护一条持续编辑的消息，显示：

- 分析摘要
- 计划项及完成状态
- 过程时间线
- 当前命令
- 输出预览
- stderr 预览

最终结果仍会单独回复一条消息，方便你直接阅读答案。

### 6. 图片和普通附件怎么处理

- 图片附件：直接透传给 `codex -i`
- 普通文件：先下载到本地附件目录，再把路径告知 Codex

适合：

- 截图让 Codex 看 UI / 报错
- 发送日志、配置文件、Markdown、代码片段等

## 十一、Web 管理面板怎么用

默认打开方式：

```bash
./scripts/macos-bridge.sh open
```

默认地址：

```text
http://127.0.0.1:3769
```

如果配置了 `WEB_AUTH_TOKEN`，脚本会自动带上一次性登录参数。

Web 面板可以用来：

- 查看绑定列表
- 查看会话状态
- 创建 / 删除绑定
- 重置会话

## 十二、常用命令说明

```text
!help      查看帮助
!status    查看当前会话状态
!queue     查看当前会话队列
!cancel    取消当前任务
!reset     重置当前会话上下文
!unbind    解绑当前主频道
!projects  查看当前服务器中的项目绑定
```

## 十三、常见问题

如果你遇到“LaunchAgent 已安装，但 `launchctl：未加载` / 服务重启后起不来”的情况，优先参考：

- `docs/ops/2026-03-26-launchagent-recovery.md`


### 1. 机器人离线

```bash
./scripts/macos-bridge.sh status
./scripts/macos-bridge.sh start
./scripts/macos-bridge.sh logs
```

同时检查：

- Discord Token 是否正确
- Intent 是否开启
- Bot 是否已被邀请到服务器
- 是否需要设置代理

### 2. `!bind` 后提示路径不允许

说明该路径不在 `ALLOWED_WORKSPACE_ROOTS` 内。执行：

```bash
./scripts/macos-bridge.sh configure
```

把允许目录加进去，然后重启服务。

### 3. 我只看到了最终结果，看不到过程

现在机器人会实时更新一条“Codex 实时进度”消息。

如果没有出现，先看日志排查，并确认当前运行的是最新构建版本：

```bash
npm run check
npm test
npm run build
./scripts/macos-bridge.sh restart
```

### 4. 附件下载失败

优先检查网络和代理。必要时配置：

```text
CODEX_DISCORD_BRIDGE_PROXY=http://127.0.0.1:7890
```

### 5. 想改配置怎么办

重新执行：

```bash
./scripts/macos-bridge.sh configure
```

## 十四、推荐的日常使用方式

推荐你长期这样组织：

- 一个主频道代表一个项目
- 一个线程代表一个具体任务
- 主频道更适合短平快问题
- 线程更适合长任务、连续迭代和附件密集型任务

这样在手机上使用时，会非常接近“轻量版 Codex 客户端”的体验。
