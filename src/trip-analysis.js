'use strict';

const EARTH_RADIUS_KM = 6371;

function validPoint(photo) {
  return Number.isFinite(Number(photo?.gps_lat)) && Number.isFinite(Number(photo?.gps_lon));
}

function datedPhotos(photos) {
  return (Array.isArray(photos) ? photos : [])
    .filter(validPoint)
    .map((photo, index) => ({ ...photo, _index: index, _time: Date.parse(photo.date_taken || '') }))
    .filter(photo => Number.isFinite(photo._time))
    .sort((a, b) => a._time - b._time || Number(a.id) - Number(b.id) || a._index - b._index);
}

function distanceKm(a, b) {
  const lat1 = Number(a.gps_lat) * Math.PI / 180;
  const lat2 = Number(b.gps_lat) * Math.PI / 180;
  const dLat = lat2 - lat1;
  const dLon = (Number(b.gps_lon) - Number(a.gps_lon)) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

function summarize(items, extra = {}) {
  return {
    ...extra,
    photoIds: items.map(item => Number(item.id)),
    count: items.length,
    start: items[0]?.date_taken || null,
    end: items.at(-1)?.date_taken || null,
    photos: items.map(({ _index, _time, ...photo }) => photo)
  };
}

function splitTrips(photos, gapHours = 24) {
  const sorted = datedPhotos(photos);
  const groups = [];
  for (const photo of sorted) {
    const current = groups.at(-1);
    if (!current || (photo._time - current.at(-1)._time) > Number(gapHours) * 3600000) groups.push([photo]);
    else current.push(photo);
  }
  return groups.map((items, index) => summarize(items, { tripIndex: index }));
}

function clusterStayPoints(photos, radiusKm = 1, maxHours = 6) {
  const sorted = datedPhotos(photos);
  const groups = [];
  for (const photo of sorted) {
    const current = groups.at(-1);
    const anchor = current?.[0];
    if (!anchor || distanceKm(anchor, photo) > Number(radiusKm) || (photo._time - anchor._time) > Number(maxHours) * 3600000) groups.push([photo]);
    else current.push(photo);
  }
  return groups.map((items, index) => {
    const lat = items.reduce((sum, item) => sum + Number(item.gps_lat), 0) / items.length;
    const lon = items.reduce((sum, item) => sum + Number(item.gps_lon), 0) / items.length;
    return summarize(items, { stayIndex: index, lat, lon });
  });
}

function aggregateGpsGrid(points, cellSize = 0.01) {
  const size = Number(cellSize) > 0 ? Number(cellSize) : 0.01;
  const cells = new Map();
  for (const point of Array.isArray(points) ? points : []) {
    if (!validPoint(point)) continue;
    const lat = Math.floor(Number(point.gps_lat) / size) * size;
    const lon = Math.floor(Number(point.gps_lon) / size) * size;
    const key = `${lat.toFixed(6)},${lon.toFixed(6)}`;
    const cell = cells.get(key) || { lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)), count: 0 };
    cell.count++;
    cells.set(key, cell);
  }
  return [...cells.values()].sort((a, b) => a.lat - b.lat || a.lon - b.lon);
}

module.exports = { splitTrips, clusterStayPoints, aggregateGpsGrid, distanceKm };
