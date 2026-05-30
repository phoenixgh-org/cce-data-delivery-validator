import { test } from 'node:test';
import assert from 'node:assert/strict';

import { version } from './index.js';

test('version returns the package version string', () => {
  assert.equal(version(), '0.0.0');
});
