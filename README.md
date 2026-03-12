# Codex Discord Bridge

把本机 `codex` CLI 挂到 Discord 文本频道上，让你可以在手机上通过 Discord 像用 Codex 客户端一样控制本地 Codex。

## 当前能力

- 一个 Discord 主频道绑定一个项目目录
- 主频道下的 Discord 线程自动继承该项目，但拥有独立的 Codex 会话上下文
- 频道普通消息直接驱动 `codex exec --json`
- 实时显示步骤、命令执行、命令输出预览、stderr 尾部、队列状态
- 在频道里持续更新一条“实时进度”消息，展示分析摘要、计划清单和过程时间线
- 图片附件自动透传给 `codex -i`
- 普通文件附件自动下载到本地附件目录，并通过 prompt 告知 Codex 读取
- Web 管理面板，可查看绑定、会话、状态，并创建/解绑绑定
- 状态、绑定、会话持久化到 `data/state.json`
- 自动化测试、本地 smoke、真实 Discord smoke
- 提供一套面向 macOS 的一键部署/启停管理脚本

## 推荐映射方式

推荐你这样组织：

- **一个 Discord 文字频道 = 一个项目目录**
- **一个 Discord 线程 = 这个项目里的一个独立 Codex 会话**

例如：

- `#proj-api` → `/Users/mac/work/api`
- `#proj-app` → `/Users/mac/work/app`
- `#proj-api` 下线程 `修登录` → `/Users/mac/work/api` 里的独立会话
- `#proj-api` 下线程 `写文档` → `/Users/mac/work/api` 里的另一条会话

## macOS 一键部署

这是你当前最推荐的部署方式。

```bash
cd /Users/mac/work/su/codex_tunning
./scripts/macos-bridge.sh deploy
```

常用命令：

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

对应的 npm 快捷命令也已经配好：

```bash
npm run macos:doctor
npm run macos:configure
npm run macos:setup
npm run macos:start
npm run macos:stop
npm run macos:restart
npm run macos:status
npm run macos:logs
npm run macos:open
npm run macos:deploy
```

首次执行 `./scripts/macos-bridge.sh deploy` / `setup` 时，脚本会先在终端里提示你填写或确认关键配置，其中 Discord Bot Token 会以 `CODEX_TUNNING_DISCORD_BOT_TOKEN` 的名字单独保存到 `/Users/mac/.codex-tunning/secrets.env`，不会写进项目 `.env`。

如果你保留了 `WEB_AUTH_TOKEN`，`./scripts/macos-bridge.sh open` 会自动带上一次性登录参数，浏览器打开后会写入本地 Cookie。

详细说明请直接看：

- `docs/MACOS-deploy.md`
- `docs/QUICKSTART.md`
- `docs/DEPLOYMENT.md`

## 前置条件

1. 本机已安装并登录 `codex`
2. Node.js >= 20.11
3. 你有一个 Discord Bot Token
4. 你在目标 Discord 服务器里有邀请 Bot 的权限（通常需要 `Manage Server`）
5. Bot 在目标服务器和频道里具备查看/发消息/线程发言权限
6. 需要在 Discord Developer Portal 里为 Bot 开启 `MESSAGE CONTENT INTENT`

## Discord 使用方式

### 0. 先完成 Discord Bot 创建与授权

详细申请/授权流程请直接看 `docs/MACOS-deploy.md` 里的“这些信息怎么获得”和“把 Bot 授权进你的 Discord 服务器”。

### 1. 绑定主频道到项目

在一个普通文本频道中发送：

```text
!bind api "/Users/mac/work/api" --sandbox workspace-write --approval never --search off
```

### 2. 直接发消息给 Codex

绑定完成后，该主频道里的任何普通消息都会直接当作 prompt 发给 Codex。

你现在会看到两类反馈：

- 一条持续编辑的“实时进度”消息：显示分析摘要、计划状态、命令执行和输出预览
- 一条最终结果回复：Codex 本轮给出的最终答复

### 3. 在 Discord 线程中继续

在已绑定主频道下创建线程并发送消息，该线程会：

- 继承主频道绑定的项目目录
- 获得自己的独立 Codex session
- 有自己的排队和状态面板

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

主要接口：

- `GET /api/dashboard`
- `POST /api/bindings`
- `DELETE /api/bindings/:channelId`
- `POST /api/conversations/:conversationId/reset`

## 测试

```bash
npm test
npm run test:coverage
npm run smoke:local
npm run smoke:discord
```

## Git / Gitee

本仓库附带脚本：

- `scripts/init-git.sh`
- `scripts/create-gitee-repo.sh`

当前远端：

- [edoserbia/codex-discord-bridge](https://gitee.com/edoserbia/codex-discord-bridge)

## 关键文档

- `docs/MACOS-deploy.md`
- `docs/QUICKSTART.md`
- `docs/DEPLOYMENT.md`
- `docs/GITEE.md`

## 当前已验证

我已经在当前机器上跑过：

- `npm run check`
- `npm test`
- `npm run test:coverage`
- `npm run smoke:local`
- `npm run smoke:discord`
- `npm run build`
