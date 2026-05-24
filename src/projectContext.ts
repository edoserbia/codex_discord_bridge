import type { ChannelBinding } from './types.js';

export const DEFAULT_SELF_HOSTED_GITLAB_URL = 'https://mytokens.live';

export function getSelfHostedGitLabUrl(): string {
  return process.env.SELF_HOSTED_GITLAB_URL?.trim() || DEFAULT_SELF_HOSTED_GITLAB_URL;
}

export function buildBridgeProjectContext(binding: ChannelBinding): string {
  const gitlabUrl = getSelfHostedGitLabUrl();

  return [
    'Bridge 项目上下文：',
    `- 当前项目名：${binding.projectName}`,
    `- 当前项目目录：${binding.workspacePath}`,
    `- 用户的自建 GitLab Web/API 入口：${gitlabUrl}`,
    '- 当任务涉及 GitLab、自建 GitLab、远端仓库、创建仓库、迁移远端或推送策略时，默认优先使用这个自建 GitLab 入口；不要再默认假设旧 IP、Gitee 或其他自建 GitLab 域名。',
  ].join('\n');
}

export function appendBridgeProjectContext(prompt: string, binding: ChannelBinding): string {
  return [
    prompt,
    '',
    buildBridgeProjectContext(binding),
  ].join('\n');
}
