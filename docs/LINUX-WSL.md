# Linux / WSL 安装与使用全流程

这份文档面向两类环境：

- 原生 Linux
- Windows 上的 WSL

默认假设你使用的是 **Bash**，命令也都按 Bash 来写。

## 一、先说清楚：Linux / WSL 支持到什么程度

Linux / WSL 当前可以稳定使用这些能力：

- Discord 主频道绑定项目、线程拆分独立会话
- `!status` 返回 Resume ID，并在本机用 `bridgectl session resume <id>` 接回同一会话
- Web 管理面板
- `bridgectl` CLI
- 文件上传、文件回传、Autopilot、Transcript 同步

Linux / WSL 当前**不提供**这些 macOS 专用能力：

- `./scripts/macos-bridge.sh ...`
- `./scripts/install-service.sh --mode daemon|agent`
- `launchd` 自启动

所以在 Linux / WSL 上，推荐理解为：

- bridge 核心程序是支持的
- 但服务安装方式是“手动配置 + `npm run start` 或你自己的进程管理器”

如果你在 WSL 里使用，建议把工作区放在 Linux 文件系统里，例如：

```text
/home/<user>/workspaces
```

不要默认把项目放在 `/mnt/c/...`，否则文件监听、权限和性能体验通常都更差。

## 二、前置条件

先确认这些命令已经可用：

```bash
bash --version
git --version
node -v
npm -v
codex --version
```

要求如下：

- Bash
- Git
- Node.js `>= 20.11`
- 已安装并登录的 `codex` CLI
- 一个可用的 Discord Bot
- Bot 已加入目标 Discord 服务器
- Bot 已启用 **Message Content Intent**

如果你还没有创建 Bot，先看 [docs/MACOS-deploy.md](./MACOS-deploy.md) 里“Discord Bot 怎么创建”和“把 Bot 授权进你的 Discord 服务器”这两节。那部分步骤对 Linux / WSL 也是一样的。

## 三、部署前先准备这些值

下面这张表最重要。你可以把它理解成“安装前要先去哪里拿值，然后填到哪里”。

| 你需要的值 | 去哪里拿 | 填到哪里 | 用途 |
| --- | --- | --- | --- |
| Discord Bot Token | Discord Developer Portal → `Application` → `Bot` → `Reset Token` / `Copy` | `~/.codex-tunning/secrets.env` 里的 `CODEX_TUNNING_DISCORD_BOT_TOKEN=...` | 让 bridge 登录 Discord |
| Discord 用户 ID | Discord 打开 `Developer Mode` 后，右键你的头像或消息 → `Copy User ID` | 项目 `.env` 里的 `DISCORD_ADMIN_USER_IDS=...` | 让你拥有管理员命令权限 |
| 允许绑定的项目根目录 | 你自己本机或 WSL 中实际存在的目录 | 项目 `.env` 里的 `ALLOWED_WORKSPACE_ROOTS=...` | 限制 Discord 只能绑定这些目录 |
| Web 面板 token | 你自己生成一串随机字符串 | 项目 `.env` 里的 `WEB_AUTH_TOKEN=...` | 保护本机 Web 管理面板 |
| 代理地址（可选） | 你本机实际可用的代理地址，例如 Clash / VPN 暴露的 HTTP 代理 | 项目 `.env` 里的 `CODEX_DISCORD_BRIDGE_PROXY=...` | 让 bridge 能连 Discord 和下载附件 |
| Resume ID | 在 Discord 当前频道或线程发送 `!status` | 不写入配置；直接用于 `bridgectl session resume <Resume ID>` | 把当前会话接回本机 |
| 频道 ID / 线程 ID（可选） | Discord 打开 `Developer Mode` 后，右键频道或线程 → `Copy Channel ID` | 不写入配置；直接用于 `bridgectl ... --channel <频道ID>` | 从本机 CLI 精确指定项目 |
| 项目名（可选） | `!bind <project> ...` 的第一个参数，或发送 `!projects` 查看 | 不写入配置；直接用于 `bridgectl ... --project <项目名>` | 从本机 CLI 按项目名选择绑定 |

## 四、拉代码并安装依赖

```bash
git clone https://<git-host>/<owner-or-namespace>/codex-discord-bridge.git
cd codex-discord-bridge
npm ci
cp .env.example .env
```

如果你已经用 SSH 配好了仓库，也可以换成 SSH clone。

## 五、把 Discord Bot Token 单独写到密钥文件

先创建密钥目录：

```bash
mkdir -p "$HOME/.codex-tunning"
chmod 700 "$HOME/.codex-tunning"
```

然后创建密钥文件：

```bash
cat > "$HOME/.codex-tunning/secrets.env" <<'EOF'
CODEX_TUNNING_DISCORD_BOT_TOKEN=在这里粘贴你的 Discord Bot Token
EOF
chmod 600 "$HOME/.codex-tunning/secrets.env"
```

这里有两个重点：

- Token 建议只放在 `~/.codex-tunning/secrets.env`
- 不要把它写进项目 `.env`

## 六、填写项目 `.env`

编辑项目根目录下的 `.env`：

```bash
$EDITOR .env
```

至少把下面这些值补清楚：

```dotenv
ALLOWED_WORKSPACE_ROOTS=/home/<user>/workspaces,/home/<user>/projects
DISCORD_ADMIN_USER_IDS=123456789012345678
WEB_PORT=3769
WEB_AUTH_TOKEN=replace-with-a-long-random-string

# 如不需要代理，可以留空
# CODEX_DISCORD_BRIDGE_PROXY=http://127.0.0.1:7890
```

几个关键说明：

- `ALLOWED_WORKSPACE_ROOTS` 一定要写 **Linux 路径**
- 如果你在 WSL，请写 `/home/<user>/...` 这种路径，不要写 `C:\\...`
- `.env.example` 里已经把默认权限设成了：
  - `DEFAULT_CODEX_SANDBOX=danger-full-access`
  - `DEFAULT_CODEX_APPROVAL=never`
  - `DEFAULT_CODEX_SEARCH=true`
- 如果你经常绑定非 Git 目录，保留：
  - `DEFAULT_CODEX_SKIP_GIT_REPO_CHECK=true`

## 七、把 `bridgectl` 安装到 Bash 的 PATH

Linux / WSL 不走 macOS 的自动安装脚本，所以这里需要手动做一次。

```bash
mkdir -p "$HOME/bin"
ln -sf "$(pwd)/scripts/bridgectl" "$HOME/bin/bridgectl"
grep -qxF 'export PATH="$HOME/bin:$PATH"' "$HOME/.bashrc" || printf '\nexport PATH="$HOME/bin:$PATH"\n' >> "$HOME/.bashrc"
source "$HOME/.bashrc"
which bridgectl
bridgectl --help
```

如果你不用 Bash，而是自己改用别的 shell，就把 `PATH` 那一行写到对应 shell 的配置文件里。

## 八、构建并启动 bridge

第一次建议先完整跑一遍检查和构建：

```bash
npm run check
npm run build
```

然后以前台方式启动：

```bash
npm run start
```

如果你正在调试，也可以用开发模式：

```bash
npm run dev
```

启动后，当前终端会持续占用。这是 Linux / WSL 下最简单、最直接的跑法。

如果你后面要长期挂着运行，可以再自己接入：

- `tmux`
- `screen`
- `systemd`
- `pm2`

这些都可以，但当前仓库没有内置 Linux 服务安装脚本。

## 九、怎么确认服务已经跑起来

bridge 成功启动后，你应该能看到类似日志，表示 Bot 已登录：

```text
Discord bot connected as <bot-name>#<discriminator>
```

如果你配置了：

```dotenv
WEB_PORT=3769
WEB_AUTH_TOKEN=...
```

那么本机 Web 面板地址通常就是：

```text
http://127.0.0.1:3769/?token=<YOUR_WEB_AUTH_TOKEN>
```

此时你也可以测试本机 CLI 是否能连上当前 bridge：

```bash
bridgectl autopilot status
```

如果 bridge 还没跑起来，这条命令会失败。

## 十、第一次在 Discord 里验证

先到一个普通文本频道，发送：

```text
!bind demo "/home/<user>/workspaces/demo" --sandbox danger-full-access --approval never --search off
```

如果你的目录不是 Git 仓库，建议直接加上：

```text
--skip-git-check on
```

完整示例：

```text
!bind demo "/home/<user>/workspaces/demo" --sandbox danger-full-access --approval never --search off --skip-git-check on
```

然后再发一条普通消息，例如：

```text
请告诉我当前项目目录下有哪些文件
```

如果你看到了：

- 一条持续更新的实时进度消息
- 一条最终答案消息

说明 Linux / WSL 这条链路已经打通。

## 十一、从 Discord 里拿到什么信息，以及它们填到哪里

这部分是日常使用最容易混淆的地方，所以单独写清楚。

### 1. 用 `!status` 拿 Resume ID，然后在本机继续

在 Discord 当前频道或线程发送：

```text
!status
```

返回里会包含一行：

```text
本机继续：bridgectl session resume <Resume ID>
```

这时你要做的不是把它写进 `.env`，而是直接在本机终端执行：

```bash
bridgectl session resume <Resume ID>
```

进入后：

- 普通单行输入：输入后按一次 `Enter`
- 多行长文本粘贴：整段粘贴完成后，再按一次 `Enter`，整段只会发送一次
- 查看状态：输入 `/status`
- 退出：输入 `/exit`

如果你不想进入交互模式，也可以直接：

```bash
bridgectl session status <Resume ID>
bridgectl session send <Resume ID> "hello"
```

### 2. 用 Discord 的频道 ID / 线程 ID 指定本机 CLI 要操作哪个项目

如果你要从本机 CLI 指定某个频道或线程对应的项目：

1. 打开 Discord `Developer Mode`
2. 右键目标频道或线程
3. 点击 `Copy Channel ID`

拿到这个值后，不是写进 `.env`，而是直接填到 CLI 参数里：

```bash
bridgectl autopilot project status --channel <频道ID>
```

### 3. 用项目名指定本机 CLI 要操作哪个绑定

你在 `!bind` 里写的第一个参数，就是项目名。例如：

```text
!bind demo "/home/<user>/workspaces/demo" ...
```

这里的项目名就是：

```text
demo
```

如果忘了，可以在 Discord 里发送：

```text
!projects
```

然后在本机 CLI 里这样用：

```bash
bridgectl autopilot project status --project demo
bridgectl autopilot project run --project demo
```

## 十二、WSL 额外注意事项

如果你在 Windows 的 WSL 里运行，再额外注意这几件事：

- 所有命令都在 WSL 的 Bash 里执行，不是在 PowerShell 里执行
- `ALLOWED_WORKSPACE_ROOTS` 和 `!bind` 里的路径，都尽量写 WSL Linux 路径
- 推荐把项目放在 `/home/<user>/...`，不要默认放在 `/mnt/c/...`
- bridge 是在 WSL 里启动 `codex` CLI，所以 `codex` 也必须安装并登录在 WSL 里

## 十三、常见问题

### 1. `bridgectl` 找不到

先执行：

```bash
source "$HOME/.bashrc"
which bridgectl
```

如果还找不到，再重新执行一次：

```bash
mkdir -p "$HOME/bin"
ln -sf "$(pwd)/scripts/bridgectl" "$HOME/bin/bridgectl"
```

### 2. Bot 显示离线

优先检查：

- `~/.codex-tunning/secrets.env` 里的 Token 是否正确
- Discord Developer Portal 是否启用了 **Message Content Intent**
- Bot 是否真的被邀请进目标服务器
- 当前 Linux / WSL 网络是否需要代理

### 3. 能回复，但不能写文件

优先检查你绑定时是否使用了高权限参数：

```text
!bind demo "/home/<user>/workspaces/demo" --sandbox danger-full-access --approval never --search off
```

如果这是旧会话，先在 Discord 当前频道发送：

```text
!reset
```

然后重新绑定一次再试。

### 4. 绑定非 Git 目录后回退到 `legacy-exec`

重新绑定时显式加上：

```text
!bind demo "/home/<user>/workspaces/non-git-demo" --sandbox danger-full-access --approval never --search off --skip-git-check on
```

### 5. Linux / WSL 需要代理

在 `.env` 中补上：

```dotenv
CODEX_DISCORD_BRIDGE_PROXY=http://127.0.0.1:7890
```

然后重启 bridge 进程。
