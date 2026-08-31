'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getComparisonIds } = require('../src/comparison');

test('comparison requires two photos and caps at four', () => {
  assert.deepEqual(getComparisonIds([], 4), { ok: false, reason: 'need-two', ids: [] });
  assert.deepEqual(getComparisonIds([1], 4), { ok: false, reason: 'need-two', ids: [1] });
  assert.deepEqual(getComparisonIds([1, 2, 3, 4, 5], 4), { ok: true, truncated: true, ids: [1, 2, 3, 4] });
});
