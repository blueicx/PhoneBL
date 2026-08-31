'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
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
  assert.equal(buildPhotoOrder(query), 'ORDER BY date_taken DESC, id DESC');
});

test('filters photos that have a compression version', () => {
  const result = buildPhotoWhere({ filter: 'compressed' });
  assert.match(result.sql, /EXISTS \(SELECT 1 FROM photo_versions/);
  assert.match(result.sql, /version_type = 'compression'/);
  assert.deepEqual(result.params, []);
});

test('compressed filter keeps photos after a later edit becomes active', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE photos (id INTEGER PRIMARY KEY, deleted INTEGER DEFAULT 0);
    CREATE TABLE photo_versions (photo_id INTEGER, version_type TEXT, is_active INTEGER DEFAULT 0);
    INSERT INTO photos (id) VALUES (1), (2);
    INSERT INTO photo_versions (photo_id, version_type, is_active) VALUES
      (1, 'compression', 0), (1, 'edit', 1), (2, 'edit', 1);
  `);
  const where = buildPhotoWhere({ filter: 'compressed' });
  const rows = db.prepare(`SELECT id FROM photos ${where.sql} ORDER BY id`).all(...where.params);
  assert.deepEqual(rows.map(row => row.id), [1]);
  db.close();
});
