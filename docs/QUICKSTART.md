# Quickstart

这份文档面向“先跑起来再说”的场景，默认你已经具备：

- 一台 macOS 机器
- 已安装并登录的 `codex` CLI
- Node.js `>= 20.11`
- 一个已经创建好的 Discord Bot

如果你还没有创建 Discord Bot，请先看 `docs/MACOS-deploy.md`。

## 1. 进入项目目录

```bash
cd /path/to/codex-discord-bridge
```

## 2. 一键部署

```bash
./scripts/macos-bridge.sh deploy
```

脚本会提示你填写或确认：

- `CODEX_TUNNING_DISCORD_BOT_TOKEN`
- `ALLOWED_WORKSPACE_ROOTS`
- `DISCORD_ADMIN_USER_IDS`
- `WEB_PORT`
- `WEB_AUTH_TOKEN`
- `CODEX_DISCORD_BRIDGE_PROXY`（自动探测，通常无需手填）

其中：

- Discord Bot Token 会单独写入 `~/.codex-tunning/secrets.env`
- 不会写入项目 `.env`
- 如果本机存在 `~/.openclaw/openclaw.json`，脚本会优先尝试自动导入其中可识别的 Discord Token
- 默认会把 `DEFAULT_CODEX_SANDBOX` 设为 `danger-full-access`

如果你希望立即安装为自启动服务，也可以直接执行：

```bash
./scripts/install-service.sh --mode daemon
```

如果你后面要从登录启动切到真正开机启动：

```bash
./scripts/uninstall-service.sh --mode agent
sudo ./scripts/install-service.sh --mode daemon
```

## 3. 确认服务已启动

```bash
./scripts/macos-bridge.sh status
```

查看日志：

```bash
./scripts/macos-bridge.sh logs
```

打开 Web 面板：

```bash
./scripts/macos-bridge.sh open
```

## 4. 在 Discord 主频道绑定项目

在一个普通文本频道发送：

```text
!bind api "/path/to/workspaces/api" --sandbox danger-full-access --approval never --search off
```

绑定成功后：

- 该主频道的普通消息会直接驱动 Codex
- 该主频道下创建的线程会自动继承同一个项目目录
- 每个线程会拥有独立 Codex 会话
- 如果目标目录本身不是 Git 仓库，建议改成 `!bind api "/path/to/workspaces/api" --sandbox danger-full-access --approval never --search off --skip-git-check on`

## 5. 直接开始对话

发送普通消息，例如：

```text
帮我检查一下这个项目的 README，并列出缺失的部署说明
```

你将看到：

- 一条持续更新的“Codex 实时进度”消息
- 一条最终结果消息
- 如果服务刚刚重启而上一个任务未完成，bridge 会优先自动恢复它，并在进度消息里标明这是恢复执行

## 6. 常用控制命令

```text
!help
!autopilot
!autopilot status
!autopilot server on
!autopilot server concurrency 5
!autopilot project on
!autopilot project run
!autopilot project interval 30m
!autopilot project status
!status
!queue
!queue insert 2
!web
!sendfile <文件名/相对路径/绝对路径/序号>
!guide <追加指令>
!cancel
!reset
!unbind
!projects
```

`!guide` 的语义是“插入中途引导，再继续原任务”，不是直接丢弃当前复杂任务。

管理员判定规则：

- 用户 ID 命中 `DISCORD_ADMIN_USER_IDS`
- 或当前 Discord 成员拥有 `Manage Guild` / `Manage Channels` 权限

管理员才能执行：

- `!bind`、`!unbind`
- `!cancel`、`!reset`
- `!queue insert <序号>`
- 所有会修改 Autopilot 状态的命令
- 显式绝对路径文件发送，例如 `!sendfile /absolute/path/to/report.pdf`

如果忘了命令，直接发 `!help`，返回内容里已经包含自然语言发文件和 `!sendfile` 的完整用法。

## 7. 最快开启 Autopilot

绑定成功后，发送：

```text
!autopilot server on
!autopilot project on
!autopilot project interval 30m
```

说明：

- 服务级 Autopilot 默认并行度为 `5`
- 可以随时用 `!autopilot server concurrency <N>` 调整
- 主频道手动 Codex 与 Autopilot 定时任务彼此独立，不互相阻塞

然后去自动创建的 `Autopilot` 线程里直接发自然语言方向，例如：

```text
优先补测试和稳定性，不要做大功能
```

查看状态：

```text
!autopilot status
!autopilot project status
```

完整说明见 `docs/AUTOPILOT.md`。

## 8. 文件收发

- 图片附件会自动透传给 `codex -i`
- 所有上传文件都会镜像到当前绑定目录里的 `inbox/`
- 普通文件也会保留一份 bridge 本地缓存，路径仍位于 `data/attachments/...`
- 上传和发回文件时都会尽量保留原文件名；只有目标位置已存在同名文件时，才会在扩展名前追加一段随机后缀
- 发文件回 Discord 时，bridge 会优先在绑定目录的 `inbox/` 中查找，再扩展到其余工作区文件
- 你可以直接说 `把 report.pdf 发给我`
- 也可以直接说 `生成完 report.pdf 后直接发给我`
- 也可以使用 `!sendfile report.pdf`
- 如果命中多个文件，bridge 会返回编号列表；继续回复 `发第 2 个` 或 `!sendfile 2`
- 显式绝对路径只允许管理员使用
- 如果你要求 “生成 report.pdf 后直接发给我”，bridge 会把文件回传协议自动注入给 Codex，模型命中单个文件时会直接回传附件

## 9. 常见问题

### `!bind` 在线程里无效

`!bind` 只能在普通文本频道执行；线程会自动继承主频道绑定。

### 绑定的是非 Git 目录，结果掉到了 `legacy-exec`

优先重新绑定一次，并显式打开跳过仓库检查：

```text
!bind demo "/path/to/non-git-workspace" --sandbox danger-full-access --approval never --search off --skip-git-check on
```

当前 bridge 默认优先走 `app-server`；如果你把工作目录绑定到非 Git 目录，又关闭了仓库检查，才会看到“workspace is outside a Git repository”这类 fallback 提示。

### Bot 显示离线

依次检查：

```bash
./scripts/macos-bridge.sh status
./scripts/macos-bridge.sh start
./scripts/macos-bridge.sh logs
```

同时确认：

- `CODEX_TUNNING_DISCORD_BOT_TOKEN` 正确
- Discord Developer Portal 已启用 **Message Content Intent**
- Bot 已被邀请进入目标服务器和频道
- 如果已安装 launchd 服务，再执行 `./scripts/macos-bridge.sh service-status`

### 已绑定 `danger-full-access`，但还是不能写文件

依次执行：

```bash
./scripts/macos-bridge.sh restart
```

然后在 Discord 当前频道发送：

```text
!reset
```

如果仍不行，再重新执行一次：

```text
!bind tmp "/path/to/project" --sandbox danger-full-access --approval never --search on
```

这通常是旧会话或旧服务进程还保留了只读上下文；升级到当前版本后，重启服务即可清掉这类环境污染。

### 网络需要代理

脚本会先直连探测 Discord；如果失败，会自动回退到本地 `7890` 代理并把结果写入：

```text
CODEX_DISCORD_BRIDGE_PROXY=http://127.0.0.1:7890
```

脚本会在启动时自动注入 `HTTP_PROXY` / `HTTPS_PROXY`，并自动为 Node 启用 `--use-system-ca`；如果系统存在 `/etc/ssl/cert.pem`，也会自动把它作为额外 CA bundle 注入。

如果你仍然看到：

```text
Error: unable to get local issuer certificate
```

通常是 `daemon` 模式拿不到代理证书链。把代理根证书导出成 PEM 后，在 `.env` 里补一行：

```text
CODEX_DISCORD_BRIDGE_CA_CERT=/path/to/proxy-ca.pem
```
