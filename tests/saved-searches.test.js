'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSavedSearch, parseSavedSearch } = require('../src/saved-searches');

test('normalizes a saved search name and query snapshot', () => {
  assert.deepEqual(normalizeSavedSearch('  海边  ', { filter: 'gps', searchQuery: '日落' }), {
    name: '海边',
    query: { filter: 'gps', searchQuery: '日落' }
  });
});

test('rejects empty names and invalid query snapshots', () => {
  assert.throws(() => normalizeSavedSearch('   ', {}), /名称/);
  assert.throws(() => parseSavedSearch('{bad json}'), /JSON/);
});
