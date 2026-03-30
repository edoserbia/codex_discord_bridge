import test from 'node:test';
import assert from 'node:assert/strict';

import { isWithinAllowedRoots } from '../src/utils.js';

test('isWithinAllowedRoots treats slash as the global root allowlist entry', () => {
  assert.equal(isWithinAllowedRoots('/', ['/']), true);
  assert.equal(isWithinAllowedRoots('/Users/mac/work', ['/']), true);
});
