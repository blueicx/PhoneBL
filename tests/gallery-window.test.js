'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateGalleryWindow } = require('../src/gallery-window');

test('virtual gallery window stays bounded for a large library', () => {
  const window = calculateGalleryWindow(100000, 250000, 900, 220, 3, 4);
  assert.ok(window.end - window.start <= 48);
  assert.ok(window.start > 1000);
  assert.equal(window.start % 4, 0);
});

test('empty galleries produce an empty window', () => {
  assert.deepEqual(calculateGalleryWindow(0, 0, 900, 220, 3, 4), { start: 0, end: 0 });
});
