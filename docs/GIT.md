# Git Remote Workflow

这份文档面向通用 Git 托管场景，适用于 GitHub、GitLab、Gitea 或其他兼容 SSH / HTTPS 的远端。

这份文档说明：

- 如何把一个新的本地仓库接到远端平台
- 如何把旧的远端迁到新的标准远端
- 日常拉取、验证、提交和推送的推荐流程

## 1. 初始化本地 Git 仓库

如果当前目录还不是 Git 仓库：

```bash
./scripts/init-git.sh
```

脚本会：

- 如果仓库尚未初始化，则创建 `main` 分支
- 如果已经是 Git 仓库，则保留现状
- 输出当前 `git status --short`

## 2. 新仓库接入远端平台

先在目标平台上创建仓库，然后在本地设置 `origin`：

```bash
git remote add origin git@<git-host>:<owner-or-namespace>/<repo>.git
```

如果本地已经存在 `origin`，改成：

```bash
git remote set-url origin git@<git-host>:<owner-or-namespace>/<repo>.git
```

确认当前远端：

```bash
git remote -v
```

## 3. 把旧远端迁到新的标准远端

如果你拿到的是旧工作区，先看当前远端：

```bash
git remote -v
```

把 `origin` 改成新的标准远端：

```bash
git remote set-url origin git@<git-host>:<owner-or-namespace>/<repo>.git
git fetch origin --prune
git branch -u origin/main main
```

如果旧工作区把主远端放在别的远端名上，推荐统一回 `origin`：

```bash
git remote rename <old-remote> origin
git remote set-url origin git@<git-host>:<owner-or-namespace>/<repo>.git
```

## 4. 首次推送

```bash
git add .
git commit -m "初始化：建立 Codex Discord Bridge 项目"
git push -u origin main
```

## 5. 日常更新流程

推荐每次推送前按这个顺序执行：

```bash
git pull --ff-only
npm install
npm run check
npm test
npm run build
git add .
git commit -m "文档：更新使用说明"
git push origin main
```

如果这次只改了文档，也至少建议执行：

```bash
git pull --ff-only
git add .
git commit -m "docs: sync bridge documentation"
git push origin main
```

## 6. 注意事项

- 推荐统一使用 `origin` 作为主远端名
- 推荐使用 SSH 作为远端地址，减少凭据输入
- `data/`、`logs/`、`.run/` 已被忽略，不应提交运行态数据
- 如果你还保留旧远端名，迁移完成后建议删除或重命名，避免误推错仓库
