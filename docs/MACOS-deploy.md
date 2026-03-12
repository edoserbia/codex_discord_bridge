# macOS 部署与使用全流程

这份文档面向第一次部署的用户，覆盖：

- 需要准备什么
- Discord Bot 怎么创建
- Token、用户 ID、权限、代理怎么获得
- 如何在 macOS 上一键部署
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
OPENCLAW_DISCORD_PROXY
```

并在启动时自动注入 `HTTP_PROXY` / `HTTPS_PROXY`。

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
./scripts/macos-bridge.sh logs
./scripts/macos-bridge.sh open
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
9. 后台启动服务

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

### `OPENCLAW_DISCORD_PROXY`

如果你访问 Discord 需要代理，这里填写：

```text
http://127.0.0.1:7890
```

## 八、部署后的文件在哪

默认情况下：

- 项目配置：`/path/to/codex-discord-bridge/.env`
- Discord 密钥：`~/.codex-tunning/secrets.env`
- 运行日志：`/path/to/codex-discord-bridge/logs/codex-discord-bridge.log`
- PID 文件：`/path/to/codex-discord-bridge/.run/codex-discord-bridge.pid`
- 运行状态：`/path/to/codex-discord-bridge/data/state.json`
- Web 面板：`http://127.0.0.1:3769`

## 九、怎么确认 Bot 已经上线

执行：

```bash
./scripts/macos-bridge.sh status
```

再看日志：

```bash
./scripts/macos-bridge.sh logs
```

正常情况下，你会看到类似：

```text
Discord bot connected as <bot-name>#<discriminator>
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
OPENCLAW_DISCORD_PROXY=http://127.0.0.1:7890
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
