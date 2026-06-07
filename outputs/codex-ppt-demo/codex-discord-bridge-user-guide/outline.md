# Codex Discord Bridge 整体使用方法

风格：手绘技术解释风，近白纸背景、轻量手绘线条、蓝绿强调色、少量中文短句，适合技术使用说明。
后端：Codex 内置图片生成工具 / GPT Image 2 路线。
输出形式：每页为 16:9 整页图片，最终组装为 PPTX。

Slide 1: 封面 — Codex Discord Bridge 使用指南
- 你在 Discord 发任务
- Bridge 绑定项目和工作目录
- Codex 在本机执行并回传结果
- 视觉：Discord、Bridge、Codex、macOS 四个节点连接

Slide 2: 先绑定项目
- 用 !bind 把频道绑定到项目目录
- 默认引擎使用 Codex
- 可指定 sandbox、approval、search
- 视觉：频道到工作区的绑定卡片

Slide 3: 日常提问与会话续接
- 普通消息就是任务
- 同一频道自动复用 Codex 线程
- !codex / !claude 可单次覆盖
- 视觉：连续消息进入同一线程

Slide 4: 文件输入与附件
- Discord 附件会同步到 workspace inbox
- 图片可作为 Codex 输入
- 文件路径可在任务里引用
- 视觉：附件进入 inbox 再进入 Codex

Slide 5: 结果回复与文件回传
- 最终总结自动发回 Discord
- 长回复会分段发送
- BRIDGE_SEND_FILE 可让 Bridge 上传文件
- 视觉：结果、文件、截图回到 Discord

Slide 6: 原生生图与编辑图
- 直接要求 Codex 使用 GPT Image 2 生图
- 上传图片后可要求编辑
- 生成图片会自动作为 Discord 附件返回
- 视觉：文本/图片输入到 image_generation，再回传 PNG

Slide 7: macOS 服务与可靠性
- LaunchAgent 开机自启动
- 断线和进程退出会自动重启
- 日志与 Web 面板可排查问题
- 视觉：LaunchAgent、service-run、日志、Web 面板

Slide 8: 推荐工作流
- 绑定项目 → 发任务 → 看进度 → 收结果
- 大任务用分步骤 prompt
- 需要文件就明确文件名和用途
- 视觉：四步流程和最佳实践清单
