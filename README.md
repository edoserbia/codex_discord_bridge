# Codex Discord Bridge

把本机 `codex` CLI 挂到 Discord 文本频道上，让你可以在手机上通过 Discord 像用 Codex 客户端一样控制本地 Codex。

当前版本已经支持：

- 一个 Discord 主频道绑定一个项目目录
- 主频道下的 Discord 线程自动继承该项目，但拥有独立的 Codex 会话上下文
- 频道普通消息直接驱动 `codex exec --json`
- 实时显示步骤、命令执行、命令输出预览、stderr 尾部、队列状态
- 图片附件自动透传给 `codex -i`
- 普通文件附件自动下载到本地附件目录，并通过 prompt 告知 Codex 读取
- Web 管理面板，可查看绑定、会话、状态，并创建/解绑绑定
- 状态、绑定、会话持久化到 `data/state.json`
- 自动化测试、本地 smoke、真实 Discord smoke

## 目录

- `src/index.ts` 入口
- `src/discordBot.ts` Discord 控制器、队列、会话、线程映射
- `src/codexRunner.ts` Codex CLI 桥接层
- `src/attachments.ts` Discord 附件下载与 prompt 注入
- `src/store.ts` JSON 持久化
- `src/webServer.ts` Web 管理面板与 API
- `scripts/smoke-local.ts` 本地假链路 smoke
- `scripts/smoke-discord.ts` 真实 Discord 连通与发消息 smoke

## 前置条件

1. 本机已安装并登录 `codex`
2. Node.js >= 20.11
3. 你有一个 Discord Bot Token
4. Bot 在目标服务器中拥有读取/发消息权限
5. 建议开启 Discord Developer Portal 里的 `MESSAGE CONTENT INTENT`

## 安装

```bash
npm install
cp .env.example .env
```

填写 `.env`：

```env
DISCORD_BOT_TOKEN=你的机器人 Token
COMMAND_PREFIX=!
DATA_DIR=./data
CODEX_COMMAND=codex
WEB_ENABLED=true
WEB_BIND=127.0.0.1
WEB_PORT=3769
```

## 启动

开发模式：

```bash
npm run dev
```

生产模式：

```bash
npm run build
npm start
```

启动后会同时拉起：

- Discord Bridge Bot
- Web 管理面板，默认在 `http://127.0.0.1:3769`

## Discord 使用方式

### 1. 绑定主频道到项目

在一个普通文本频道中发送：

```text
!bind api "/Users/<user>/work/api" --sandbox workspace-write --approval never --search off
```

常用参数：

- `--model <name>`
- `--profile <name>`
- `--sandbox read-only|workspace-write|danger-full-access`
- `--approval untrusted|on-request|on-failure|never`
- `--search on|off`
- `--skip-git-check on|off`
- `--add-dir "/another/path"`
- `--config key=value`

### 2. 直接发送消息给 Codex

绑定完成后，该主频道里的任何普通消息都会直接当作 prompt 发给 Codex。

### 3. 在 Discord 线程中继续

在已绑定主频道下创建线程并发送消息，该线程会：

- 继承主频道绑定的项目目录
- 获得自己的独立 Codex session
- 有自己的排队和状态面板

这让你能在同一项目下开多个并行上下文，更像 Codex 客户端里的多会话体验。

### 4. 附件支持

- 图片附件：自动走 `codex -i`
- 代码、文档、文本等普通附件：先下载到 `data/attachments/<conversation>/<task>/`，再把本地路径告诉 Codex

### 5. 控制命令

```text
!status
!queue
!cancel
!reset
!unbind
!projects
!help
```

## Web 管理面板

默认地址：

```text
http://127.0.0.1:3769
```

当前实现支持：

- 查看所有绑定项目
- 查看每个绑定下的会话与当前状态
- 通过表单创建绑定
- 调用 JSON API 解绑和重置会话

主要接口：

- `GET /api/dashboard`
- `POST /api/bindings`
- `DELETE /api/bindings/:channelId`
- `POST /api/conversations/:conversationId/reset`

如需简单鉴权，可配置 `WEB_AUTH_TOKEN`，然后在请求头里带：

```text
Authorization: Bearer <token>
```

## 测试

### 自动化测试

```bash
npm test
npm run test:coverage
```

### 本地全链路 smoke

```bash
npm run smoke:local
```

### 真实 Discord smoke

默认会读取：

```text
~/.openclaw/openclaw.json
```

然后使用其中的 Discord Bot Token 和绑定频道做一轮：

- 登录验证
- 频道访问验证
- 发送/删除 smoke 消息验证

执行：

```bash
npm run smoke:discord
```

也可以自定义配置路径：

```bash
OPENCLAW_CONFIG_PATH=/path/to/openclaw.json npm run smoke:discord
```

## Git / Gitee

本仓库附带两个脚本：

- `scripts/init-git.sh`：初始化本地 Git 仓库
- `scripts/create-gitee-repo.sh`：通过 `GITEE_TOKEN` 创建私有仓库并配置 `gitee` 远端

详见：

- `QUICKSTART.md`
- `DEPLOYMENT.md`
- `GITEE.md`

## 安全建议

- 优先使用 `workspace-write`，谨慎使用 `danger-full-access`
- 建议配置 `ALLOWED_WORKSPACE_ROOTS`
- 建议配置 `DISCORD_ADMIN_USER_IDS`
- Web 面板建议只监听 `127.0.0.1`，或配置 `WEB_AUTH_TOKEN`
- Discord Bot 建议只加入你自己的私有服务器/私有频道

## 当前已验证

我已经在当前机器上跑过：

- `npm run check`
- `npm test`
- `npm run test:coverage`
- `npm run smoke:local`
- `npm run smoke:discord`
- `npm run build`

其中真实 Discord smoke 使用了你本机 `openclaw` 配置中的 Discord Bot 设置。
