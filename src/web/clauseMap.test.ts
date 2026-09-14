/**
 * The browser's forward clause map must equal the server's (by1c.14).
 *
 * src/web/clauseMap.ts is a hand-copied mirror of `FORWARD` in
 * src/api/clause-map.ts, which is itself transcribed from `docs/clause-mapping.md`
 * (the server module's own test joins it against the §7 matrix, so a matrix row
 * with no mapping fails there). What THIS file protects is the copy: a row added
 * on the server and not here would leave a real contract failure unmarked in the
 * docked detail, silently and with nothing to notice.
 *
 * Importing the server module from a web test is the Setup.test.ts pattern; web
 * tests are excluded from `typecheck:web`, so nothing here reaches the bundle.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FORWARD as SERVER_FORWARD,
  forwardClause as serverForwardClause,
} from '../api/clause-map.js';
import { FORWARD, forwardClause } from './clauseMap.js';

test('the mirrored FORWARD map is the server map, row for row', () => {
  assert.deepEqual(FORWARD, SERVER_FORWARD);
});

test('forwardClause answers as the server does, including for ids off the map', () => {
  for (const req of Object.keys(SERVER_FORWARD)) {
    assert.equal(forwardClause(req), serverForwardClause(req), req);
  }
  for (const req of ['adv.null_padding', '9.9', '', 'toString']) {
    assert.equal(forwardClause(req), serverForwardClause(req), req);
    assert.equal(forwardClause(req), null, req);
  }
});
