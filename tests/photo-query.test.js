'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePhotoQuery, buildPhotoWhere, buildPhotoOrder } = require('../src/photo-query');

test('normalizes the library query and rejects unsafe sort names', () => {
  const query = normalizePhotoQuery({ filter: 'gps', searchQuery: '山', sortBy: 'drop table' });
  assert.deepEqual(query, {
    filter: 'gps', searchQuery: '山', sortBy: 'date_taken', sortDir: 'DESC',
    dateFrom: '', dateTo: ''
  });
});

test('builds parameterized predicates shared by paging and select-all', () => {
  const query = normalizePhotoQuery({ filter: '3', dateFrom: '2026-01-01', dateTo: '2026-01-31', searchQuery: '海' });
  const result = buildPhotoWhere(query);
  assert.match(result.sql, /deleted = 0/);
  assert.match(result.sql, /rating >= \?/);
  assert.deepEqual(result.params, [3, '2026-01-01', '2026-01-31T23:59:59', '%海%', '%海%', '%海%']);
  assert.equal(buildPhotoOrder(query), 'ORDER BY date_taken DESC');
});
