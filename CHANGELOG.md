# CHANGELOG

## v0.3.1 - 2026-03-14

### 变更概览
- 修复 Codex CLI 偶发异常退出被 bridge 直接判定为失败的问题。
- 过滤已知无害的 `failed to clean up stale arg0 temp dirs` stderr 噪声，避免误导用户。
- 为异常退出场景增加一次自动重试，并保留更清晰的 attempt 日志。
- 修复 macOS `launchd` 服务状态识别与 PID 管理，确保登录后可自动拉起、掉线后可自动重启。
- 补充针对异常退出重试的单元测试与端到端测试。

### 版本差异表

| 改动项 | 旧版本行为 | 新版本行为 | 改动原因 |
| --- | --- | --- | --- |
| Codex 异常退出处理 | `exitCode=1 signal=null` 且只有无害 warning 时，bridge 直接判定整轮失败并在 Discord 回复失败 | 对仅含已知无害 warning 的异常退出自动重试一次，成功则继续原会话并返回正常结果 | 减少将 Codex CLI 偶发抖动误判为任务失败 |
| stderr 展示 | 会把已知无害 warning 当成错误展示给用户 | 过滤已知无害 warning，仅保留可诊断 stderr | 避免噪声干扰真实问题排查 |
| 运行日志 | 难以区分某次失败是否可重试、是否已自动恢复 | 新增 attempt / retryable / ignoredStderr 等诊断日志 | 提高线上排障效率 |
| launchd PID 管理 | `service-run` 记录的是子进程 PID，导致 launchd KeepAlive / 状态识别容易失真 | `service-run` 直接 `exec node dist/index.js`，PID 与 launchd 托管进程一致 | 保证自启动与异常拉起链路稳定 |
| 自启动模式识别 | 同时存在旧 daemon 与新 agent 痕迹时，脚本优先命中 daemon，容易误判当前状态 | 优先识别并操作 LaunchAgent | 避免历史残留的 daemon plist 干扰当前运行 |

## v0.3.0 - 2026-03-12

### 变更概览
- 初始发布：支持 Discord 频道/线程绑定本地项目、实时进度、附件透传、Web 管理面板与 macOS 服务化部署。

### 版本差异表

| 改动项 | 旧版本行为 | 新版本行为 | 改动原因 |
| --- | --- | --- | --- |
| 首次发布 | 无 | 提供基础 Discord ↔ Codex bridge 能力 | 建立项目基线 |
