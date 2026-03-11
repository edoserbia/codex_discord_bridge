import { createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import type { AttachmentRef } from './types.js';

import { detectImageMime, ensureDirectory, sanitizeFilename } from './utils.js';

interface AttachmentLike {
  name?: string | null;
  url: string;
  contentType?: string | null;
  size?: number | null;
}

export interface DownloadedAttachments {
  attachmentDir?: string | undefined;
  attachments: AttachmentRef[];
}

export function extractMessageAttachments(message: { attachments?: unknown }): AttachmentLike[] {
  const raw = message.attachments;

  if (!raw) {
    return [];
  }

  if (typeof (raw as { values?: () => IterableIterator<AttachmentLike> }).values === 'function') {
    return [...(raw as { values: () => IterableIterator<AttachmentLike> }).values()];
  }

  if (Array.isArray(raw)) {
    return raw as AttachmentLike[];
  }

  return [];
}

export async function downloadAttachments(
  dataDir: string,
  conversationId: string,
  taskId: string,
  rawAttachments: AttachmentLike[],
): Promise<DownloadedAttachments> {
  if (rawAttachments.length === 0) {
    return { attachments: [] };
  }

  const attachmentDir = await ensureDirectory(path.join(dataDir, 'attachments', conversationId, taskId));
  const attachments: AttachmentRef[] = [];

  for (const [index, attachment] of rawAttachments.entries()) {
    const response = await fetch(attachment.url);

    if (!response.ok || !response.body) {
      throw new Error(`下载附件失败：${attachment.url} (${response.status})`);
    }

    const name = sanitizeFilename(attachment.name || `attachment-${index + 1}`);
    const localPath = path.join(attachmentDir, name);
    await pipeline(response.body, createWriteStream(localPath));

    attachments.push({
      name,
      localPath,
      sourceUrl: attachment.url,
      isImage: detectImageMime(name, attachment.contentType),
      contentType: attachment.contentType ?? undefined,
      size: attachment.size ?? undefined,
    });
  }

  return {
    attachmentDir,
    attachments,
  };
}

export function buildPromptWithAttachments(prompt: string, attachments: AttachmentRef[], attachmentDir?: string): string {
  if (attachments.length === 0) {
    return prompt;
  }

  const lines = [prompt, '', '[Bridge note] 已下载本条消息附件到本地，可直接读取这些文件：'];

  if (attachmentDir) {
    lines.push(`附件目录：${attachmentDir}`);
  }

  for (const attachment of attachments) {
    const label = attachment.isImage ? 'image' : 'file';
    lines.push(`- [${label}] ${attachment.name} -> ${attachment.localPath}`);
  }

  lines.push('如果图像附件有视觉内容，请结合已附加的图片输入一起分析。');
  return lines.join('\n');
}

export async function removeAttachmentDir(attachmentDir?: string): Promise<void> {
  if (!attachmentDir) {
    return;
  }

  await fs.rm(attachmentDir, { recursive: true, force: true });
}
