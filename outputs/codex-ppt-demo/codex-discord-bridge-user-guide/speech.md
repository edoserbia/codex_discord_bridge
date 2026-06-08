## Slide 1: 封面 — Codex Discord Bridge 使用指南
这份 PPT 介绍 Codex Discord Bridge 的基本使用方式。核心思路很简单：你在 Discord 发需求，Bridge 把它映射到本机项目和 Codex 会话，Codex 完成后再把结果发回 Discord。
---
注意点：强调这是“Discord 作为入口，本机 Codex 作为执行端”。

## Slide 2: 先绑定项目
开始使用前，需要用 `!bind` 把 Discord 频道和本机项目目录绑定起来。现在默认示例使用 Codex 引擎，必要时可以指定沙箱、审批和联网搜索配置。
---
注意点：提醒用户默认用 Codex，不再默认 Claude。

## Slide 3: 日常提问与会话续接
绑定后，频道里的普通消息就会变成 Codex 任务。同一个频道会复用线程，因此 Codex 能延续上下文；如果临时需要切换引擎，可以用 `!codex` 或 `!claude`。
---
注意点：解释“频道等于一个长期工作会话”。

## Slide 4: 文件输入与附件
如果在 Discord 上传附件，Bridge 会把文件同步到工作区的 inbox。图片、文档和代码文件都可以作为任务输入，Codex 可以基于这些文件继续处理。
---
注意点：适合演示“上传截图后让 Codex 修 UI”。

## Slide 5: 结果回复与文件回传
Codex 完成后，Bridge 会把最终总结发回 Discord。长回复会自动拆分；如果 Codex 输出 `BRIDGE_SEND_FILE` 结构化块，Bridge 会上传指定文件。
---
注意点：这是解决“生成文件如何回到 Discord”的关键机制。

## Slide 6: 原生生图与编辑图
现在 Bridge 已支持 Codex 原生图片输出。你可以直接要求 GPT Image 2 生图，也可以上传图片要求编辑，生成或编辑后的 PNG 会自动作为 Discord 附件返回。
---
注意点：提醒不要用 `!claude` 覆盖这类请求。

## Slide 7: macOS 服务与可靠性
本机服务通过 LaunchAgent 运行，支持登录后启动、断线恢复和进程退出后重启。出现问题时，可以看日志和 Web 面板确认状态。
---
注意点：强调当前服务名是 codex-discord-bridge，并保持 Codex Discord Bridge 服务身份。

## Slide 8: 推荐工作流
推荐的日常流程是：先绑定项目，再发任务，看进度，最后收结果。复杂任务最好拆成阶段，涉及文件时明确文件名和用途。
---
注意点：最后落到可执行习惯，帮助用户稳定使用。
