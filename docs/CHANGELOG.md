# Changelog

本文档采用接近 Keep a Changelog 的维护方式。后续功能、修复和运维变更都应在这里追加记录。

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
- 修复 Discord 线程绑定识别与权限切换后残留旧只读状态的问题。

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
