import test from 'node:test';
import assert from 'node:assert/strict';

import { formatHelp } from '../src/formatters.js';

test('help text documents workspace inbox mirroring and file-send workflows', () => {
  const text = formatHelp('!');

  assert.match(text, /上传的附件会同步到绑定目录里的 `inbox\/` 子目录/);
  assert.match(text, /尽量保留原文件名/);
  assert.match(text, /把 report\.pdf 发给我/);
  assert.match(text, /!sendfile <文件名\/相对路径>/);
  assert.match(text, /!sendfile 2/);
  assert.match(text, /绝对路径/);
});
