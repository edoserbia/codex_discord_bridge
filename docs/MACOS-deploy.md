# macOS 一键部署与使用说明

这份文档是给你这台 Mac 直接用的。

## 你会得到什么

部署后，这台 Mac 会运行一个本地服务，把：

- Discord 频道消息
- 转成
- 本机 `codex` CLI 在指定项目目录里的任务

推荐映射方式：

- **一个 Discord 文字频道 = 一个项目目录**
- **一个 Discord 线程 = 这个项目里的一个独立会话**

也就是说：

- `#proj-api` → `/Users/<user>/work/api`
- `#proj-app` → `/Users/<user>/work/app`
- `#proj-api` 里的线程 `修登录` → `/Users/<user>/work/api` 下的一条独立 Codex 会话
- `#proj-api` 里的线程 `重构权限` → `/Users/<user>/work/api` 下的另一条独立 Codex 会话

## 最快部署方式

在项目根目录执行：

```bash
cd /Users/<user>/work/su/codex_tunning
./scripts/macos-bridge.sh deploy
```

首次执行时，这条命令会自动做：

1. 检查 macOS / Node / npm / codex
2. 自动创建项目 `.env`
3. 如果检测到 `~/.openclaw/openclaw.json`，先读取里面可识别的 Discord Bot Token 和代理
4. 把 Discord Bot Token 单独写入 `/Users/<user>/.codex-tunning/secrets.env`
5. 在终端里逐项提示你确认/修改关键配置
6. 安装依赖
7. 跑 `npm run check`
8. 跑 `npm run build`
9. 后台启动服务

启动后你可以用：

```bash
./scripts/macos-bridge.sh status
./scripts/macos-bridge.sh logs
./scripts/macos-bridge.sh open
./scripts/macos-bridge.sh stop
```

## 脚本命令说明

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
./scripts/macos-bridge.sh deploy
```

### `doctor`
检查本机条件是否满足。

### `configure`
只做交互式配置，不安装不启动。

### `setup`
交互式确认配置后，安装依赖并构建，但不启动。

### `start`
后台启动服务。

### `stop`
停止服务。

### `restart`
重启服务。

### `status`
查看当前是否运行、PID、Web 地址。

### `logs`
实时查看日志。

### `open`
打开本地 Web 管理面板；如果配置了 `WEB_AUTH_TOKEN`，会自动带一次性登录参数。

### `deploy`
一键部署，等于 `setup + start`。

## 第一次部署时脚本会问你什么

脚本会在终端提示你填写或确认这些项：

### `CODEX_TUNNING_DISCORD_BOT_TOKEN`
必填。你的 Discord Bot Token。

注意：

- 这个值**不会**写进项目 `.env`
- 它会单独保存到 `/Users/<user>/.codex-tunning/secrets.env`
- 变量名带项目前缀，避免和其他 Discord Bot 项目混淆

### `ALLOWED_WORKSPACE_ROOTS`
推荐填写。允许绑定项目的根目录，多个路径用逗号分隔。

例如：

```env
ALLOWED_WORKSPACE_ROOTS=/Users/<user>/work,/Users/<user>/projects,/Users/<user>/Desktop/projects
```

### `DISCORD_ADMIN_USER_IDS`
可选。允许执行管理命令的 Discord 用户 ID，多个 ID 用逗号分隔。

如果你不填，也可以依赖 Discord 里的频道管理权限来执行管理员命令。

### `WEB_PORT`
本地 Web 管理面板端口，默认 `3769`。

### `WEB_AUTH_TOKEN`
本地 Web 管理面板鉴权 Token。脚本会自动生成一个；你直接回车保留就行。

### `OPENCLAW_DISCORD_PROXY`
可选。如果 Discord 或附件下载需要走代理，可以填：

```text
http://127.0.0.1:7890
```

## 这些信息怎么获得

### 1. `CODEX_TUNNING_DISCORD_BOT_TOKEN` 怎么拿

1. 打开 Discord Developer Portal：[Discord Developer Portal](https://discord.com/developers/applications)
2. 点击 **New Application**，创建一个新的 Application
3. 进入这个 Application 的 **Bot** 页面
4. 如果页面提示创建 Bot，就先点击 **Add Bot**
5. 在 **Token** 区域生成或重置 Token，然后复制
6. 把这个值在脚本交互里直接粘贴回车即可

注意：

- 这个 Token 等同于 Bot 密钥，不要发给别人
- 如果泄露，就去 Bot 页面重新生成
- 脚本会把它单独保存到 `/Users/<user>/.codex-tunning/secrets.env`

### 2. `DISCORD_ADMIN_USER_IDS` 怎么拿

1. 在 Discord 客户端打开 **Settings**
2. 打开 **Advanced**
3. 开启 **Developer Mode**
4. 回到你的头像、用户名或成员列表里自己的账号，右键
5. 选择 **Copy User ID**

多个管理员可以用逗号分隔写进项目 `.env`。

### 3. `ALLOWED_WORKSPACE_ROOTS` 怎么填

这里填的是你这台 Mac 上允许绑定的项目根目录。

推荐只填你真正会开发的几个父目录，例如：

```text
/Users/<user>/work,/Users/<user>/projects
```

这样 Discord 里就不能随便把 Codex 绑定到任意目录，安全性更高。

### 4. `WEB_AUTH_TOKEN` 怎么拿

这个值脚本会自动生成。

通常直接回车保留即可；如果你想自己手动生成，也可以用：

```bash
openssl rand -hex 16
```

### 5. `OPENCLAW_DISCORD_PROXY` 怎么填

如果你本机网络访问 Discord 受限，可填：

```text
http://127.0.0.1:7890
```

如果你的 `~/.openclaw/openclaw.json` 里已经有代理配置，脚本会先自动带入。

## 把 Bot 授权进你的 Discord 服务器

### 前提

你需要满足至少一个条件：

- 你自己就是这个 Discord 服务器的管理员
- 你拥有邀请应用 / 管理服务器的权限
- 或者让服务器管理员代你完成这一步

### 第一步：创建 Application 和 Bot

如果前面已经在 Developer Portal 创建过 Application 和 Bot，这一步就已经完成了。

### 第二步：开启 Bot 所需能力

在 Developer Portal 的 **Bot** 页面里，确认：

- Bot 已创建
- **MESSAGE CONTENT INTENT** 已开启

这个项目需要读取普通频道消息内容，否则 Bot 看得到消息事件，但拿不到你真正发给 Codex 的文本内容。

### 第三步：生成邀请链接

1. 打开 Application 的 **OAuth2** 页面
2. 再进入 **URL Generator**
3. 在 **Scopes** 里勾选：
   - `bot`
4. 在 **Bot Permissions** 里勾选：
   - `View Channels`
   - `Send Messages`
   - `Send Messages in Threads`
   - `Read Message History`

说明：

- 这套桥接服务不需要给 Bot `Administrator`
- 如果服务器或频道有更细的权限覆盖，仍要确保 Bot 对目标频道和线程可见、可发言

### 第四步：把 Bot 邀请进服务器

1. 复制 URL Generator 生成的邀请链接
2. 在浏览器打开
3. 选择你的目标 Discord 服务器
4. 确认授权

完成后，这个 Bot 就会出现在你的服务器成员列表里。

### 第五步：检查频道权限

如果 Bot 已经进了服务器，但在某个频道看不到消息或无法回复，通常是频道级权限覆盖导致的。

请确认这个 Bot 在目标频道至少具备：

- 查看频道
- 发送消息
- 在线程中发送消息
- 读取消息历史

## 重要文件

- 项目配置：`/Users/<user>/work/su/codex_tunning/.env`
- 独立密钥：`/Users/<user>/.codex-tunning/secrets.env`
- 运行日志：`/Users/<user>/work/su/codex_tunning/logs/codex-discord-bridge.log`
- PID 文件：`/Users/<user>/work/su/codex_tunning/.run/codex-discord-bridge.pid`
- Web 面板：默认 `http://127.0.0.1:3769`

## 第一次部署后要检查什么

打开项目配置：

```bash
cat /Users/<user>/work/su/codex_tunning/.env
```

重点确认这些字段：

```env
ALLOWED_WORKSPACE_ROOTS=
DISCORD_ADMIN_USER_IDS=
WEB_PORT=3769
WEB_AUTH_TOKEN=
OPENCLAW_DISCORD_PROXY=
```

打开独立密钥文件：

```bash
cat /Users/<user>/.codex-tunning/secrets.env
```

重点确认：

```env
CODEX_TUNNING_DISCORD_BOT_TOKEN=...
```

浏览器手动访问时，也可以先打开：

```text
http://127.0.0.1:3769/?token=<你的 WEB_AUTH_TOKEN>
```

脚本 `./scripts/macos-bridge.sh open` 已经自动帮你处理这一点。

## 怎么确认已经连上 Discord

先启动：

```bash
./scripts/macos-bridge.sh start
```

再看日志：

```bash
./scripts/macos-bridge.sh logs
```

如果看到类似：

```text
Discord bot connected as xxx
Web admin panel listening at http://127.0.0.1:3769
```

说明已经连上 Discord 了。

## 怎么绑定项目到 Discord

推荐结构：

- 一个 Discord 服务器
- 多个项目频道
- 每个项目频道下按任务开线程

例如：

- `#proj-api`
- `#proj-app`
- `#proj-ops`

然后在 `#proj-api` 频道里发送：

```text
!bind api "/Users/<user>/work/api" --sandbox workspace-write --approval never --search off
```

这表示：

- 当前频道绑定项目名 `api`
- 工作目录是 `/Users/<user>/work/api`
- 今后这个频道里的普通消息，都会在这个目录里交给 Codex 处理

## Codex 会话到底开到哪里

这个问题分两层：

### 1. 用哪个目录运行
由 **频道绑定的目录** 决定。

例如：

- 你把 `#proj-api` 绑定到了 `/Users/<user>/work/api`
- 那么这个频道和它下面线程里的所有会话，都会在 `/Users/<user>/work/api` 里运行

### 2. 用哪条上下文会话
由 **频道或线程本身** 决定。

也就是：

- 主频道 = 一条主会话
- 每个线程 = 一条独立会话
- 同一个线程里连续聊天 = 延续这个线程上下文
- 想重开会话 = `!reset`
- 想开一条新会话 = 新建一个线程

## 你在 Discord 里怎么用

### 在频道里直接发消息
绑定完成后，直接在频道里发送普通消息即可。

例如：

```text
请检查当前仓库里的鉴权实现，告诉我有没有安全问题。
```

它会直接进入这个项目目录，启动/续用这个频道自己的 Codex 会话。

### 在同一个项目下开线程分任务
推荐把一个具体任务放到一个线程里。

例如：

- 线程 `修复登录`
- 线程 `重构鉴权`
- 线程 `写部署文档`

每个线程都有独立上下文，这样互不干扰。

### 常用命令

```text
!status
!queue
!cancel
!reset
!unbind
!projects
!help
```

## Web 管理面板怎么用

打开：

```bash
./scripts/macos-bridge.sh open
```

如果你保留了 `WEB_AUTH_TOKEN`，这个命令会自动带上一次性登录参数，浏览器打开后会写入本地 Cookie。

你也可以手动访问：

```text
http://127.0.0.1:3769/?token=<你的 WEB_AUTH_TOKEN>
```

如果你想用脚本调用 API，请带：

```text
Authorization: Bearer <你的 WEB_AUTH_TOKEN>
```

面板里你可以：

- 看当前所有绑定
- 看每个绑定下的会话
- 调用 API 解绑 / 重置会话

## 推荐你的实际使用方式

推荐你按这个模式用：

- 一个项目一个频道
- 一个具体任务一个线程

比如：

- 频道 `#proj-api`：项目整体问题、需求讨论、统一入口
- 线程 `修复登录`：只处理登录 bug
- 线程 `重构鉴权`：只处理鉴权重构
- 线程 `写部署文档`：只处理文档

这样在手机上通过 Discord 用 Codex，会最接近桌面客户端的体验。

## 如果后面你改了配置

改完项目 `.env` 或独立密钥文件后，执行：

```bash
./scripts/macos-bridge.sh configure
./scripts/macos-bridge.sh restart
```

## 如果你要确认服务还活着

```bash
./scripts/macos-bridge.sh status
```

## 如果你要看错误日志

```bash
./scripts/macos-bridge.sh logs
```
