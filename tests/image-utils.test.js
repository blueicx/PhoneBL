'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { orientationActions } = require('../src/image-utils');

test('EXIF orientations map to the expected transform operations', () => {
  assert.deepEqual(orientationActions(1), []);
  assert.deepEqual(orientationActions(2), ['flop']);
  assert.deepEqual(orientationActions(3), ['rotate']);
  assert.deepEqual(orientationActions(6), ['rotate']);
  assert.deepEqual(orientationActions(7), ['rotate', 'flop']);
  assert.deepEqual(orientationActions(8), ['rotate']);
});
