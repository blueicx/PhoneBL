'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { splitTrips, clusterStayPoints, aggregateGpsGrid } = require('../src/trip-analysis');

test('splits trips when the time gap exceeds 24 hours', () => {
  const trips = splitTrips([
    { id: 1, date_taken: '2026-01-01T10:00:00Z', gps_lat: 30, gps_lon: 104 },
    { id: 2, date_taken: '2026-01-01T12:00:00Z', gps_lat: 30.001, gps_lon: 104.001 },
    { id: 3, date_taken: '2026-01-03T12:00:00Z', gps_lat: 31, gps_lon: 105 }
  ]);
  assert.equal(trips.length, 2);
  assert.deepEqual(trips[0].photoIds, [1, 2]);
});

test('clusters nearby photos into a stay point', () => {
  const stays = clusterStayPoints([
    { id: 1, date_taken: '2026-01-01T10:00:00Z', gps_lat: 30, gps_lon: 104 },
    { id: 2, date_taken: '2026-01-01T12:00:00Z', gps_lat: 30.001, gps_lon: 104.001 },
    { id: 3, date_taken: '2026-01-01T13:00:00Z', gps_lat: 31, gps_lon: 105 }
  ]);
  assert.equal(stays.length, 2);
  assert.deepEqual(stays[0].photoIds, [1, 2]);
});

test('aggregates GPS points into deterministic heat cells', () => {
  assert.deepEqual(aggregateGpsGrid([
    { gps_lat: 30.001, gps_lon: 104.001 },
    { gps_lat: 30.004, gps_lon: 104.004 }
  ], 0.01), [{ lat: 30, lon: 104, count: 2 }]);
});
