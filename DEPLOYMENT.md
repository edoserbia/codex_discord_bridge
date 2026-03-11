# Deployment

## 推荐部署方式

适合单机长期运行的方式：

- `npm start` + `tmux` / `screen`
- `pm2`
- `launchd`（macOS）
- `systemd`（Linux）

## 生产前建议

1. `DISCORD_BOT_TOKEN` 使用单独机器人
2. 限制 `ALLOWED_WORKSPACE_ROOTS`
3. 使用 `workspace-write` 而不是默认放大权限
4. 配置 `DISCORD_ADMIN_USER_IDS`
5. Web 面板只绑定 `127.0.0.1`，或配置 `WEB_AUTH_TOKEN`

## pm2 示例

```bash
npm run build
pm2 start npm --name codex-discord-bridge -- start
pm2 save
```

## launchd 示例（macOS）

将可执行命令写入一个 plist，核心命令如下：

```bash
cd /path/to/codex_tunning
npm run build
npm start
```

## systemd 示例（Linux）

`ExecStart` 可写为：

```bash
/usr/bin/env bash -lc 'cd /path/to/codex_tunning && npm start'
```

## 端口与路径

- Web 面板默认：`127.0.0.1:3769`
- 数据目录默认：`./data`
- 附件目录：`data/attachments/<conversationId>/<taskId>/`

## 回归检查

每次部署前建议执行：

```bash
npm run check
npm test
npm run build
npm run smoke:local
```

如果要验证真实 Discord 连接：

```bash
npm run smoke:discord
```
