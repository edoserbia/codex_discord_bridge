# Git / Gitee

## 本地初始化

```bash
./scripts/init-git.sh
```

这会：

- 初始化本地 Git 仓库（如果尚未初始化）
- 保留当前工作区不提交
- 输出当前状态，方便你确认要提交的内容

## 创建 Gitee 私有仓库

需要一个可用的 `GITEE_TOKEN`。

```bash
export GITEE_TOKEN=你的_token
export GITEE_OWNER=你的_gitee_用户名
./scripts/create-gitee-repo.sh codex-discord-bridge
```

脚本会：

- 调用 Gitee OpenAPI 创建仓库
- 默认请求创建私有仓库
- 自动把本地 `gitee` remote 指向返回的 `ssh_url`

## 推送示例

创建完 remote 后：

```bash
git add .
git commit -m "feat: add discord codex bridge"
git push -u gitee main
```

## 当前状态说明

我已经验证：

- 本机 SSH 可以认证到 `gitee.com`
- 但当前环境里没有现成的 `GITEE_TOKEN`
- 因此“自动创建私有远端仓库”这一步需要你补一个 token 才能真正执行

如果你把 `GITEE_TOKEN` 配上，我就可以继续把远端实际创建并推送上去。
