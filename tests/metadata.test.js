'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePolicy } = require('../src/metadata');

test('metadata privacy policies have safe defaults', () => {
  assert.equal(normalizePolicy('remove-gps'), 'remove-gps');
  assert.equal(normalizePolicy('minimal-safe'), 'minimal-safe');
  assert.equal(normalizePolicy('unknown'), 'keep-all');
});
