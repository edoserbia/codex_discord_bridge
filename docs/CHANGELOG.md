# Changelog

本文档采用接近 Keep a Changelog 的维护方式。后续功能、修复和运维变更都应在这里追加记录。

## [Unreleased]

### Added

- 新增 Discord 双向文件传输说明：上传附件镜像到绑定目录 `inbox/`，支持自然语言“把 report.pdf 发给我”、`!sendfile` 候选选择，以及 Codex 通过 `BRIDGE_SEND_FILE` 协议主动回传单个文件。
- 新增文档化说明 `!web`、`--skip-git-check`、启动自动恢复、`app-server` / `legacy-exec` 驱动切换和管理员权限边界。
- 新增 `!status` 的完整 Resume ID 恢复入口，以及 `bridgectl session status/send/resume` 的本机续聊文档说明。
- 新增 transcript 落盘与 Discord 同步说明：本机续聊产生的用户/助手消息会同步回 Discord transcript，并持久化到 `data/transcripts/*.jsonl`。

### Changed

- README、`docs/QUICKSTART.md`、`docs/DEPLOYMENT.md`、`docs/MACOS-deploy.md` 已统一到当前实际行为：文件收发、代理自动探测、LaunchAgent 原子重启、任务恢复、Web 链接和管理员判定都已补齐。
- Git 文档默认口径改为自建 GitLab；新增 `docs/GIT.md`，旧 `docs/GITEE.md` 改为兼容提示入口。
- `bridgectl` 的文档安装方式已统一更新为当前行为：`setup` / `deploy` / `install-service` 自动安装到 PATH，不再要求手动 `npm link`。
- 本机 `session resume` 的终端交互文档已补齐，包括多行粘贴整段发送、`/status` 和 `/exit` 的使用方式。

### Fixed

- 修复 `!guide` 在复杂任务中会把原任务整体替换掉的问题；现在会先处理中途引导，再继续原任务。
- 状态面板、实时进度和队列展示现在会区分“当前引导”和“原任务”。
- 文档中仍指向 Gitee、遗漏 `!web` / `!queue insert` / 管理员规则 / 非 Git 目录绑定说明的内容已补齐。
- 修复 Discord 最终总结回复在瞬时写入失败时被直接丢弃的问题；`EPIPE`、中止写入等短暂错误现在会进入延迟重试队列，恢复后自动补发。

## [0.3.0] - 2026-03-12

### Added

- 新增通用的 macOS `launchd` 安装、卸载、状态查看与前台服务运行能力。
- 新增 `scripts/install-service.sh` 和 `scripts/uninstall-service.sh` 包装脚本。
- README 与部署文档新增开机启动、登录自启、服务恢复和卸载流程说明。

### Changed

- 默认 `DEFAULT_CODEX_SANDBOX` 改为 `danger-full-access`，让 Discord 中的 Codex 会话默认具备本地读写能力。
- `scripts/macos-bridge.sh deploy` 现在可在部署阶段直接安装自启动服务。
- 项目版本提升到 `0.3.0`。

### Fixed

- 修复重新 `!bind` 修改执行模式后仍错误复用旧 Codex 会话的问题。
- 修复 Codex CLI 参数顺序不兼容导致实际执行目录和权限没有生效的问题。
- 修复 `exec resume` 在 `danger-full-access` 会话里未显式关闭沙箱，导致恢复会话重新变成只读的问题。
- 修复 Discord 线程绑定识别与权限切换后残留旧只读状态的问题。
- 修复 bridge 进程继承桌面版 Codex 内部环境变量后，导致 Discord 子进程错误落入只读上下文的问题。

## [0.2.0] - 2026-03-12

### Added

- 增加 Discord ↔ Codex 基础桥接能力。
- 支持频道绑定项目、线程独立会话、附件下载、图片透传到 `codex -i`。
- 支持 Web 管理面板与实时进度更新。
- 增加 `!guide` 运行中引导命令，可将新增引导即时插入当前工作。

### Changed

- Discord Bot Token 改为独立保存到 `~/.codex-tunning/secrets.env`。
- 公共文档结构调整为 `README` + `docs/`。

### Fixed

- 修复仅应把真实 Discord 线程识别为线程会话的问题。
