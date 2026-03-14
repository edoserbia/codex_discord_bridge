# FILE.md

## 根目录文件

| 路径 | 功能 | 关键输入/输出 |
| --- | --- | --- |
| `package.json` | 项目元信息、脚本入口与版本号 | 输入：npm 命令；输出：构建/测试/服务管理脚本 |
| `README.md` | 项目使用说明与部署文档入口 | 输入：人工阅读；输出：部署与使用指引 |
| `CHANGELOG.md` | 版本迭代记录 | 输入：每次版本更新；输出：版本差异与原因 |
| `FILE.md` | 文件结构索引 | 输入：项目文件变化；输出：目录职责说明 |
| `scripts/macos-bridge.sh` | macOS 启动、部署、自启动与日志管理主脚本 | 输入：CLI 子命令；输出：服务启动/停止/安装/状态 |

## 核心源码

| 路径 | 功能 | 关键输入/输出 |
| --- | --- | --- |
| `src/index.ts` | 应用启动入口 | 输入：环境变量与配置；输出：Discord bridge + Web 服务启动 |
| `src/config.ts` | `.env` / secrets 配置装载 | 输入：环境变量、secrets 文件；输出：运行时配置对象 |
| `src/discordBot.ts` | Discord 消息处理、队列调度、进度面板、失败/重试逻辑 | 输入：Discord 消息、绑定配置、Codex 运行结果；输出：Discord 回复、状态刷新、重试控制 |
| `src/codexRunner.ts` | 拉起本机 Codex CLI、解析 JSON 事件流、封装运行结果 | 输入：prompt、会话线程 ID、Codex 参数；输出：结构化运行结果与 hooks 回调 |
| `src/codexDiagnostics.ts` | Codex stderr 诊断过滤与异常退出重试判定 | 输入：stderr、exitCode、signal、turn 状态；输出：可诊断 stderr 与 retryable 判定 |
| `src/formatters.ts` | Discord 消息格式化 | 输入：运行态/结果对象；输出：状态面板、进度消息、成功/失败回复 |
| `src/store.ts` | 绑定与会话状态持久化 | 输入：binding/session 更新；输出：`data/state.json` |
| `src/attachments.ts` | Discord 附件下载与清理 | 输入：Discord 附件 URL；输出：本地附件目录与附件描述 |

## 测试与夹具

| 路径 | 功能 | 关键输入/输出 |
| --- | --- | --- |
| `test/discordBridge.e2e.test.ts` | 端到端验证 bridge 行为，包括绑定、线程、引导、附件、队列、异常重试 | 输入：fake Discord + fake Codex；输出：行为断言 |
| `test/codexRunner.test.ts` | Codex runner 参数与进程行为测试 | 输入：fake Codex；输出：runner 断言 |
| `test/codexDiagnostics.test.ts` | 诊断过滤与自动重试规则测试 | 输入：模拟 stderr / result；输出：诊断逻辑断言 |
| `test/fixtures/fake-codex.mjs` | Codex CLI 模拟器 | 输入：测试 prompt 与参数；输出：模拟事件流/失败场景 |

## 运行时目录

| 路径 | 功能 | 关键输入/输出 |
| --- | --- | --- |
| `data/state.json` | 持久化绑定与会话状态 | 输入：bridge 状态变更；输出：下次启动恢复 |
| `data/attachments/` | 普通附件下载缓存目录 | 输入：Discord 附件；输出：供 Codex 读取的本地文件 |
| `logs/codex-discord-bridge.log` | 服务运行日志 | 输入：bridge/launchd 输出；输出：排障信息 |
| `.run/codex-discord-bridge.pid` | 当前服务 PID | 输入：服务启动；输出：状态查询与重启控制 |
