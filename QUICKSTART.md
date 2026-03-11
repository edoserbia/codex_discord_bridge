# Quickstart

## 1. 安装依赖

```bash
npm install
cp .env.example .env
```

## 2. 配置环境变量

至少填写：

```env
DISCORD_BOT_TOKEN=你的 Discord Bot Token
COMMAND_PREFIX=!
DATA_DIR=./data
CODEX_COMMAND=codex
WEB_ENABLED=true
WEB_BIND=127.0.0.1
WEB_PORT=3769
```

建议补充：

```env
ALLOWED_WORKSPACE_ROOTS=/Users/mac/work,/Users/mac/projects
DISCORD_ADMIN_USER_IDS=你的 Discord 用户 ID
WEB_AUTH_TOKEN=一个随机字符串
```

## 3. 启动

```bash
npm run dev
```

或：

```bash
npm run build
npm start
```

## 4. 在 Discord 中绑定项目

在目标主频道中发送：

```text
!bind api "/Users/mac/work/api" --sandbox workspace-write --approval never
```

## 5. 发送普通消息

例如：

```text
请检查当前仓库里的后端 API 设计并给出改进建议。
```

## 6. 在 Discord 线程里开分支上下文

在同一个主频道下创建线程，再发送消息。线程会自动继承主频道绑定目录，但使用独立的 Codex 会话。

## 7. 打开 Web 面板

浏览器打开：

```text
http://127.0.0.1:3769
```

## 8. 跑测试

```bash
npm test
npm run smoke:local
npm run smoke:discord
```
