export interface BridgeFileSendDirective {
  cleanText: string;
  request?: string | undefined;
  caption?: string | undefined;
  error?: string | undefined;
}

const FILE_SEND_BLOCK_PATTERN = /(?:\n|^)BRIDGE_SEND_FILE\s*```json\s*([\s\S]*?)\s*```\s*$/m;
const FILE_SEND_SKILL_PROMPT = [
  '[Bridge file-send skill]',
  '如果用户要求把文件发回 Discord，并且你已经明确知道要发送的单个文件，请在最终回答末尾追加下面的结构化块，不要让用户手动输入命令：',
  'BRIDGE_SEND_FILE',
  '```json',
  '{"request":"相对路径或文件名","caption":"一句给用户看的短说明"}',
  '```',
  '规则：默认优先使用绑定工作目录里的相对路径或文件名；如果有歧义，不要猜，先让 bridge 返回候选列表；一次只请求发送 1 个文件。',
].join('\n');

export function extractBridgeFileSendDirective(message: string): BridgeFileSendDirective {
  const match = message.match(FILE_SEND_BLOCK_PATTERN);

  if (!match) {
    return {
      cleanText: message.trim(),
    };
  }

  const cleanText = message.replace(match[0], '').trim();

  try {
    const parsed = JSON.parse(match[1] ?? '{}') as {
      request?: unknown;
      caption?: unknown;
    };
    const request = typeof parsed.request === 'string' ? parsed.request.trim() : '';
    const caption = typeof parsed.caption === 'string' ? parsed.caption.trim() : undefined;

    if (!request) {
      return {
        cleanText,
        caption,
        error: 'BRIDGE_SEND_FILE 缺少 request 字段。',
      };
    }

    return {
      cleanText,
      request,
      caption,
    };
  } catch (error) {
    return {
      cleanText,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function appendBridgeFileSendInstructions(prompt: string): string {
  if (prompt.includes('BRIDGE_SEND_FILE')) {
    return prompt;
  }

  return [prompt, '', FILE_SEND_SKILL_PROMPT].join('\n');
}
