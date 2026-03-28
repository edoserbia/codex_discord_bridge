# Autopilot

这份文档专门说明 `codex-discord-bridge` 里的 Autopilot 自动迭代能力，包括：

- 用户如何使用
- 本机 CLI 如何控制
- 服务级和项目级的控制边界
- 定时任务状态怎么看
- Discord 中会出现哪些消息
- 当前实现如何调度和落盘

## 1. 目标

Autopilot 的目标不是“自由发挥”，而是让每个已绑定项目都能在 Discord 里获得一套可控的自动迭代机制：

- 服务级统一开关
- 项目级独立开关
- 项目级独立周期
- 项目级自然语言方向
- 实时进度同步
- 任务看板和下一步建议
- 项目目录里的真实看板持久化

## 2. 核心模型

Autopilot 现在分成两层。

### 服务级

服务级作用于**当前 bridge 进程里所有已绑定项目**。

它只负责：

- 开启服务级总开关
- 暂停服务级总开关
- 清空所有项目的 Autopilot 历史状态
- 查看当前 bridge 进程里所有项目的服务级状态

服务级命令不会覆盖项目自己的周期和方向配置。

### 项目级

项目级作用于**当前 Discord 频道绑定的那个项目**。

它负责：

- 开启当前项目的 Autopilot
- 暂停当前项目的 Autopilot
- 清空当前项目的 Autopilot 历史状态
- 设置当前项目的周期
- 设置当前项目的自然语言方向
- 查看当前项目的详细状态

只有当：

- 服务级已开启
- 项目级已开启

两个条件同时满足时，项目才会按周期运行。

## 3. Discord 里的对象

每个绑定项目频道会自动拥有两样东西。

### 主频道里的入口卡片

主频道会固定保留一条置顶的 `Autopilot 入口` 消息，显示：

- 服务开关
- 项目开关
- 调度周期
- 当前 Prompt
- 任务看板摘要
- 最近结果 / 下一步建议
- 对应的 Autopilot 线程

主频道不会被 Autopilot 过程刷屏。

### 项目 Autopilot 线程

绑定项目后会自动创建一个线程，命名类似：

```text
Autopilot · api
```

这个线程只做两类事情：

- 接收该项目的自然语言 Prompt
- 展示每一轮 Autopilot 的实时进度和总结

另外，Autopilot 会在项目目录里维护两份看板文件：

- `.codex/autopilot/board.json`：真实看板数据源
- `docs/AUTOPILOT_BOARD.md`：由看板脚本自动同步的可读文档

## 4. 最短上手

### 4.1 绑定项目

```text
!bind api "/path/to/workspaces/api"
```

### 4.2 开启服务级 Autopilot

```text
!autopilot server on
```

### 4.3 开启当前项目的项目级 Autopilot

```text
!autopilot project on
```

### 4.4 设置周期

```text
!autopilot project interval 30m
```

### 4.5 设置方向

两种方式都可以。

方式一：主频道命令

```text
!autopilot project prompt 优先补测试和稳定性，不要做大功能
```

方式二：直接在 Autopilot 线程里发自然语言

```text
优先补测试和稳定性，不要做大功能
```

### 4.6 查看状态

```text
!autopilot status
!autopilot project status
```

### 4.7 在本机 CLI 控制同一套 Autopilot

如果 bridge 服务已经在本机运行，也可以直接在终端里执行：

```bash
bridgectl autopilot status
bridgectl autopilot server on
bridgectl autopilot server concurrency 3
bridgectl autopilot project status --project api
bridgectl autopilot project interval 30m --project api
bridgectl autopilot project prompt "优先补测试和稳定性，不要做大功能" --project api
bridgectl autopilot project run --project api
```

项目定位规则：

- `--channel <频道ID>` 优先
- `--project <绑定项目名>` 次之
- 如果都不传，按当前工作目录匹配绑定项目
- 匹配不到或匹配多个时直接报错，不猜

CLI 复用的是运行中的 bridge 服务和同一套 Autopilot 状态，不会直接改 `state.json`。

## 5. 命令总表

### 帮助

```text
!autopilot
```

任何频道都可以使用。会返回完整的 Autopilot 使用说明。

权限边界：

- `!autopilot`、`!autopilot status`、`!autopilot server status`、`!autopilot project status` 只读查看，普通成员也可以用
- 所有会修改 Autopilot 状态的命令都要求管理员权限
- 管理员判定规则与主 README 一致：用户 ID 命中 `DISCORD_ADMIN_USER_IDS`，或当前 Discord 成员拥有 `Manage Guild` / `Manage Channels` 权限

### 服务级

```text
!autopilot status
!autopilot server status
!autopilot server on
!autopilot server off
!autopilot server clear
!autopilot server concurrency 5
```

说明：

- `!autopilot status` 是 `!autopilot server status` 的简写
- 服务级命令查看或修改的是当前 bridge 进程里的全部绑定项目
- 服务级默认并行度为 `5`
- `!autopilot server concurrency <N>` 可以随时调整并行数
- 本机 CLI 对应命令为 `bridgectl autopilot ...`

### 项目级

只能在：

- 已绑定项目的主频道
- 该项目自动创建的 Autopilot 线程

里使用。

```text
!autopilot project status
!autopilot project on
!autopilot project off
!autopilot project clear
!autopilot project run
!autopilot project interval 30m
!autopilot project prompt 优先补测试和稳定性，不要做大功能
```

补充说明：

- `!autopilot project run` 会立刻触发当前项目执行 1 次
- 本轮完成后，下一次周期时间会按本轮完成时间重新计算
- 本机 CLI 里使用同样的命令形态，只是把 `!` 前缀改成 `bridgectl`
- 在终端里执行项目级命令时，推荐显式加 `--project <项目名>`；如果省略，会按当前工作目录匹配绑定项目

## 6. 周期格式

项目周期支持：

- `30m`
- `2h`
- `1d`
- `90m`
- `45`

解释：

- `m` = 分钟
- `h` = 小时
- `d` = 天
- 纯数字默认按分钟处理

当前实现**没有额外强加最大间隔限制**。项目级周期就是调度依据。

## 7. 状态查询会显示什么

### 服务级状态

`!autopilot status` / `!autopilot server status` 会显示：

- 服务级总开关状态
- 服务并行数
- 当前 bridge 进程里已绑定项目总数
- 项目级已开启数量
- 运行中 / 待命 / 暂停数量
- 每个项目的：
  - 频道
  - 服务开关
  - 项目开关
  - 当前状态
  - 当前并行槽占用
  - 周期
  - 下次运行时间

### 项目级状态

`!autopilot project status` 会显示：

- 当前项目频道
- 服务开关
- 服务并行数
- 当前 Autopilot 运行槽占用
- 项目开关
- 当前运行状态
- 调度周期
- 最近运行时间
- 下次运行时间
- 当前 Prompt
- 看板摘要
- 最近结果 / 下一步建议
- 对应的 Autopilot 线程

## 8. 实时进度与时间戳

Autopilot 每一轮启动后，会在对应项目线程里同步：

- 启动时间
- 当前 Prompt
- 计划变更
- 当前命令
- 输出预览
- 最终总结

这些消息都带时间戳。

每轮结束时，线程总结会优先回显“看板变化项”，而不是重复贴完整看板。

Codex 的计划项在实时进度里固定显示为：

- 未完成：`⬜️`
- 已完成：`✅`

当 Codex 的 todo 状态变化时，Bridge 会实时刷新这些勾选状态。

## 9. 当前调度语义

当前版本的调度语义是：

- 定时器按全局 tick 周期定时扫描项目
- 每个项目是否到期，完全由它自己的 `intervalMs` 决定
- 每个 Discord 服务器都有一个服务级并行数，默认是 `5`
- 同一服务器里，Autopilot 最多会同时运行到该并行数上限
- `!autopilot server concurrency <N>` 可以在运行期间随时调整并行数
- 已运行中的 Autopilot 不会因为并行数调整而被取消
- 主频道和普通线程里的手动 Codex 会话，与 Autopilot 调度彼此独立，不互相占用运行槽

## 10. 当前实现结构

### 状态存储

Autopilot 的状态落在 `state.json` 里，分成两块：

- `autopilotServices`
- `autopilotProjects`

其中服务状态会保存：

- 服务级开关
- 服务级并行数

其中项目状态会保存：

- 项目级开关
- 周期
- brief
- board 摘要缓存
- 最近运行结果
- 当前运行状态
- 入口卡片消息 ID
- Autopilot 线程 ID

注意：`state.json` 里的 `board` 不再是唯一事实源，只是 bridge 为了 Discord 卡片和状态查询保留的同步缓存。真实看板以项目目录里的 `.codex/autopilot/board.json` 为准。

### Prompt 生成

Autopilot 每一轮运行前会生成专用 prompt，其中包含：

- 项目名
- 工作目录
- 当前自然语言 Prompt
- 当前任务看板
- 治理规则 skill
- `boardctl` 看板脚本路径
- 看板 JSON / Markdown 路径
- 固定的 `AUTOPILOT_REPORT` JSON 输出要求

模型会被要求：

- 优先继续 `doing`
- 如果有合适的 `ready`，先转到 `doing` 再执行
- 如果没有合适的 `ready`，按当前 Prompt 新建一个 `ready`，再立刻继续执行它
- 所有看板增删改移都必须通过 skill 自带的 `boardctl` 命令完成

### 结果解析

模型最后一条消息必须带 `AUTOPILOT_REPORT` JSON。

Bridge 会从中解析：

- 本轮总结
- 下一步建议

但看板本身不再主要依赖最终 JSON 解析。当前实现会：

1. 让 Codex 用 `boardctl` 修改项目目录里的真实看板
2. 在轮次结束后重新读取 `.codex/autopilot/board.json`
3. 把看板差异同步到 Discord 线程总结

### Discord 展示

展示分为两层：

- 主频道：只保留一张入口卡片
- Autopilot 线程：承载实时过程、轮次总结，以及本轮看板变化项

## 11. 当前限制

当前版本有几个明确限制：

- 还没有 worktree 隔离
- 调度是“按项目周期检查”，不是 cron 表达式
- 服务级是“当前 bridge 进程级别”，不是跨多个 bridge 实例的全局控制平面
- 同一项目如果工作目录本身存在冲突风险，仍需要用户自己通过 Prompt 和并行数控制范围

## 12. 推荐使用方式

推荐你按下面的方式使用：

1. 在项目主频道 `!bind`
2. `!autopilot server on`
3. 视机器能力决定是否保留默认并行度 `5`，或改成 `!autopilot server concurrency <N>`
4. 在每个项目里分别执行 `!autopilot project on`
5. 给每个项目单独设置周期
6. 在各自 Autopilot 线程里持续用自然语言细化方向
7. 需要立即执行时，用 `!autopilot project run`
8. 用 `!autopilot status` 看全局，用 `!autopilot project status` 看单项目

这样最容易控制范围，也最容易排查问题。
