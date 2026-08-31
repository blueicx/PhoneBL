'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePolicy, resolveExiftoolPath } = require('../src/metadata');

test('metadata privacy policies have safe defaults', () => {
  assert.equal(normalizePolicy('remove-gps'), 'remove-gps');
  assert.equal(normalizePolicy('minimal-safe'), 'minimal-safe');
  assert.equal(normalizePolicy('unknown'), 'keep-all');
});

test('resolves the exiftool executable path before spawning it', async () => {
  const executablePath = await resolveExiftoolPath();
  assert.equal(typeof executablePath, 'string');
  assert.match(executablePath, /exiftool(?:\.exe)?$/i);
});
