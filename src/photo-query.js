'use strict';

const SORT_COLUMNS = new Set(['date_taken', 'filename', 'size', 'id']);
const FILTERS = new Set(['', 'gps', 'raw', 'jpg', 'starred', 'no-thumb']);

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePhotoQuery(options = {}) {
  const requestedFilter = cleanText(options.filter);
  const filter = FILTERS.has(requestedFilter) || /^[1-5]$/.test(requestedFilter) ? requestedFilter : '';
  const requestedSort = cleanText(options.sortBy);
  const sortBy = SORT_COLUMNS.has(requestedSort) ? requestedSort : 'date_taken';
  return {
    filter,
    searchQuery: cleanText(options.searchQuery),
    sortBy,
    sortDir: options.sortDir === 'ASC' ? 'ASC' : 'DESC',
    dateFrom: cleanText(options.dateFrom),
    dateTo: cleanText(options.dateTo)
  };
}

function buildPhotoWhere(options = {}) {
  const query = normalizePhotoQuery(options);
  const clauses = ['deleted = 0'];
  const params = [];

  if (query.filter === 'gps') clauses.push('has_gps = 1');
  if (query.filter === 'raw') clauses.push('is_raw = 1');
  if (query.filter === 'starred') clauses.push('starred = 1');
  if (/^[1-5]$/.test(query.filter)) {
    clauses.push('rating >= ?');
    params.push(Number(query.filter));
  }
  if (query.dateFrom) {
    clauses.push('date_taken >= ?');
    params.push(query.dateFrom);
  }
  if (query.dateTo) {
    clauses.push('date_taken <= ?');
    params.push(`${query.dateTo}T23:59:59`);
  }
  if (query.filter === 'jpg') clauses.push("ext NOT IN ('.nef','.cr2','.cr3','.arw','.dng','.orf','.raf','.rw2')");
  if (query.filter === 'no-thumb') clauses.push('thumb_path IS NULL');
  if (query.searchQuery) {
    clauses.push('(filename LIKE ? OR tags LIKE ? OR date_taken LIKE ?)');
    const search = `%${query.searchQuery}%`;
    params.push(search, search, search);
  }

  return { sql: `WHERE ${clauses.join(' AND ')}`, params };
}

function buildPhotoOrder(options = {}) {
  const query = normalizePhotoQuery(options);
  return `ORDER BY ${query.sortBy} ${query.sortDir}`;
}

module.exports = { normalizePhotoQuery, buildPhotoWhere, buildPhotoOrder };
