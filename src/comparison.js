'use strict';

function getComparisonIds(ids, limit = 4) {
  const normalized = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger))];
  if (normalized.length < 2) return { ok: false, reason: 'need-two', ids: normalized };
  const max = Math.max(2, Number(limit) || 4);
  return { ok: true, truncated: normalized.length > max, ids: normalized.slice(0, max) };
}

module.exports = { getComparisonIds };
