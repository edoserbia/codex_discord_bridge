# CHANGELOG

## v0.3.3 - 2026-03-14

### 变更概览
- 修复 `patent_platform` 这类场景中：即使 `!reset` 后，新会话首轮仍异常退出，第二次恢复到新 thread 也再次失败的问题。
- 将 bridge 的异常恢复从两段扩展为三段：**正常尝试 → 恢复 thread 重试 → 放弃当前 thread 改为全新会话重试**。
- 对最终仍失败但属于可重试型异常退出的场景，自动清空 session 中残留的坏 `codexThreadId`，避免下条消息继续复用坏会话。
- 新增 E2E 回归测试覆盖“fresh fail → resumed fail → fresh success”链路。

### 版本差异表

| 改动项 | 旧版本行为 | 新版本行为 | 改动原因 |
| --- | --- | --- | --- |
| 新会话恢复失败场景 | 第一次 fresh 失败、第二次 resume 新 thread 再失败后直接终止 | 第三次自动丢弃当前 thread，改用全新会话再次尝试 | 修复 `!reset` 后仍可能失败的问题 |
| 最终失败后的 session 清理 | 失败后可能仍把坏 `codexThreadId` 留在 session 里 | 对可重试型最终失败自动清空坏 thread | 避免后续消息继续踩坏会话 |
| 恢复策略覆盖 | 只覆盖“旧 resume 会话损坏” | 额外覆盖“fresh fail + resumed fail + fresh recover” | 贴近 `patent_platform` 的真实故障链路 |

## v0.3.2 - 2026-03-14

### 变更概览
- 修复已存在 Codex resume 会话损坏时，bridge 连续两次都复用坏会话、导致简单任务也失败的问题。
- 当重试命中“旧会话疑似损坏”场景时，自动清空旧 `codexThreadId`，第二次改为新会话执行。
- 新增端到端测试覆盖“resume 会话损坏 → 丢弃旧会话 → 新会话恢复成功”链路。

### 版本差异表

| 改动项 | 旧版本行为 | 新版本行为 | 改动原因 |
| --- | --- | --- | --- |
| 脏 resume 会话恢复 | 第二次重试仍复用同一个坏 thread，导致两次都 `exitCode=1 signal=null` | 检测到可重试且当前为旧 resume 会话时，先清空旧 thread，再以新会话重试 | 修复“简单任务也连续失败，`!reset` 后才恢复”的问题 |
| 恢复策略可测性 | 没有专门覆盖旧会话损坏的回归测试 | 新增 E2E 场景，确保坏会话能自动切换到新会话 | 防止后续回归 |

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
