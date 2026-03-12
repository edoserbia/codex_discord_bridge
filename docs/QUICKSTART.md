# Quickstart

## 最快方式

```bash
cd /Users/<user>/work/su/codex_tunning
./scripts/macos-bridge.sh deploy
```

首次执行时，脚本会在终端依次提示你确认或填写：

- `CODEX_TUNNING_DISCORD_BOT_TOKEN`
- `ALLOWED_WORKSPACE_ROOTS`
- `DISCORD_ADMIN_USER_IDS`
- `WEB_PORT`
- `WEB_AUTH_TOKEN`
- `OPENCLAW_DISCORD_PROXY`（可选）

其中：

- `CODEX_TUNNING_DISCORD_BOT_TOKEN` 不会写进项目 `.env`
- 它会被单独保存到 `/Users/<user>/.codex-tunning/secrets.env`
- 这样你本机同时跑多个 Discord Bot 项目时，不容易把 Token 混掉

部署完成后常用：

```bash
./scripts/macos-bridge.sh status
./scripts/macos-bridge.sh logs
./scripts/macos-bridge.sh open
./scripts/macos-bridge.sh stop
```

## 如果你想先单独填写配置

```bash
./scripts/macos-bridge.sh configure
```

## 如果你想分步执行

### 1. 环境检查

```bash
./scripts/macos-bridge.sh doctor
```

### 2. 初始化并构建

```bash
./scripts/macos-bridge.sh setup
```

### 3. 后台启动

```bash
./scripts/macos-bridge.sh start
```

### 4. 打开 Web 面板

```bash
./scripts/macos-bridge.sh open
```

如果你保留了 `WEB_AUTH_TOKEN`，这个命令会自动带上一次性登录参数，浏览器打开后会写入本地 Cookie。

默认是：

```text
http://127.0.0.1:3769
```

## 第一次部署后要确认

打开项目配置：

```bash
open /Users/<user>/work/su/codex_tunning/.env
```

重点看：

```env
ALLOWED_WORKSPACE_ROOTS=
DISCORD_ADMIN_USER_IDS=
WEB_PORT=3769
WEB_AUTH_TOKEN=
OPENCLAW_DISCORD_PROXY=
```

打开独立密钥文件：

```bash
open /Users/<user>/.codex-tunning/secrets.env
```

里面应该有：

```env
CODEX_TUNNING_DISCORD_BOT_TOKEN=...
```

浏览器手动访问时，也可以先打开：

```text
http://127.0.0.1:3769/?token=<你的 WEB_AUTH_TOKEN>
```

脚本 `./scripts/macos-bridge.sh open` 已经自动帮你处理这一点。

## 这些值怎么拿

这些值的获取方式和 Discord Application / Bot 授权流程，已经完整写在：

- `MACOS-deploy.md`

## 绑定项目到 Discord

在目标频道发送：

```text
!bind api "/Users/<user>/work/api" --sandbox workspace-write --approval never
```

## 推荐使用方式

- 一个频道绑定一个项目目录
- 一个线程对应一个独立 Codex 会话
- 在频道主会话里做全局沟通
- 在线程里做具体任务推进

## 常用命令

```text
!status
!queue
!cancel
!reset
!unbind
!projects
!help
```

## 测试

```bash
npm test
npm run smoke:local
npm run smoke:discord
```

## 详细说明

请继续看：

- `MACOS-deploy.md`
- `DEPLOYMENT.md`
