# Git / Gitee

这份文档说明如何把当前项目纳入 Git 管理，并创建一个 Gitee 私有仓库作为远端。

## 1. 初始化本地 Git 仓库

```bash
./scripts/init-git.sh
```

脚本会：

- 如果仓库尚未初始化，则创建 `main` 分支
- 如果已经是 Git 仓库，则保留现状
- 输出当前 `git status --short`

## 2. 准备 Gitee Token

你需要一个可用的 `GITEE_TOKEN`，用于调用 Gitee OpenAPI 创建仓库。

同时建议设置：

```bash
export GITEE_OWNER=<your-gitee-username>
```

## 3. 创建 Gitee 私有仓库

```bash
export GITEE_TOKEN=<your-gitee-token>
./scripts/create-gitee-repo.sh codex-discord-bridge
```

默认行为：

- 请求创建私有仓库
- 仓库名默认为 `codex-discord-bridge`
- 自动把本地 `gitee` remote 指向新仓库的 `ssh_url`

如需自定义：

```bash
DESCRIPTION="Codex bridge for Discord"
PRIVATE=true
REMOTE_NAME=gitee
./scripts/create-gitee-repo.sh custom-repo-name
```

## 4. 首次推送

```bash
git add .
git commit -m "feat: initialize codex discord bridge"
git push -u gitee main
```

## 5. 后续更新

```bash
git add .
git commit -m "docs: update deployment guide"
git push
```

## 6. 注意事项

- `GITEE_TOKEN` 只用于创建仓库，不建议写进项目文件
- 建议使用 SSH 作为远端地址，避免重复输入账号密码
- `data/`、`logs/`、`.run/` 已被忽略，不应提交运行态数据
