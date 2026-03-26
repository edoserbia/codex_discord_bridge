# 2026-03-26 LaunchAgent 恢复记录

## 现象

用户反馈 `codex-discord-bridge` 更新并重启后，服务再次掉线，`macos-bridge.sh service-status` 显示：

- 已安装：LaunchAgent（登录后启动）
- `launchctl：未加载`
- `进程状态：未运行`

项目路径：

- `/path/to/codex-discord-bridge`

服务标签：

- `com.codex-tunning.codex-discord-bridge-.b1adc197d7`

## 排查过程

1. 检查最近提交与未提交修改：
   - 最近已存在修复提交：`644194b fix: self-heal launch agent plist permissions on macOS`
   - 工作区仍有若干未提交文档/脚本修改，但前台启动验证表明**业务代码本身可以正常运行**。
2. 前台运行同一启动命令验证：
   - `bash ./scripts/macos-bridge.sh service-run`
   - 结果：服务能够正常连接 Discord，并启动 Web 管理面板。
3. 结论：问题不在 `dist/index.js` 或 Discord bot 配置，而在 **macOS LaunchAgent / launchctl 加载层**。
4. 检查 LaunchAgent plist：
   - 路径：`~/Library/LaunchAgents/<launch-agent-label>.plist`
   - 发现此前出现过权限异常（曾为 `600`），会导致 launchctl 无法稳定加载。
5. 手动修复并验证：
   - 将 plist 权限修正为 `644`
   - 执行：
     - `launchctl bootout gui/$(id -u)/com.codex-tunning.codex-discord-bridge-.b1adc197d7`
     - `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.codex-tunning.codex-discord-bridge-.b1adc197d7.plist`
     - `launchctl kickstart -k gui/$(id -u)/com.codex-tunning.codex-discord-bridge-.b1adc197d7`
   - 结果：服务恢复为 `launchctl：已加载` / `进程状态：运行中`

## 根因判断

**根因不是业务代码崩溃，而是 LaunchAgent 未被 launchctl 正常加载。**

最主要的可见问题是：

- LaunchAgent plist 权限异常或 LaunchAgent 状态未正确 bootstrap；
- 用户“重启服务”后，进程退出，但 launchctl 没有把服务重新挂回去，于是表现为“掉线且启动不起来”。

## 已做修复

### 1. 当场恢复

执行标准启动流程：

```bash
cd /path/to/codex-discord-bridge
bash ./scripts/macos-bridge.sh start
bash ./scripts/macos-bridge.sh service-status
```

确认恢复结果：

- `launchctl：已加载`
- `进程状态：运行中`
- `Web 面板：http://127.0.0.1:3769`

### 2. 脚本级自愈修复

已在 `scripts/macos-bridge.sh` 中加入 LaunchAgent plist 权限自愈逻辑：

- 在 `install-service` 前会修正 agent plist 权限；
- 在 `start` 的 launchd 分支前会修正 agent plist 权限；
- 在 `service-status` 检查 agent 状态前也会修正 agent plist 权限。

对应提交：

- `644194b fix: self-heal launch agent plist permissions on macOS`

## 如何再次确认服务健康

```bash
cd /path/to/codex-discord-bridge
./scripts/macos-bridge.sh service-status
./scripts/macos-bridge.sh logs
```

期望看到：

- `launchctl：已加载`
- `进程状态：运行中`
- 日志中包含：
  - `Discord bot connected as ...`
  - `Web admin panel listening at http://127.0.0.1:3769`

## 后续建议

1. 若再次出现“已安装但未加载”，优先检查：
   - plist 权限是否仍为 `644`
   - `launchctl print gui/$(id -u)/com.codex-tunning.codex-discord-bridge-.b1adc197d7`
2. 尽量使用项目脚本启动/停止，不手工改 LaunchAgent 文件。
3. 如果未来要继续改动 macOS 启动逻辑，先回看本文档与提交 `644194b`。
