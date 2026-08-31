'use strict';

function parseSavedSearch(value) {
  let parsed;
  try { parsed = JSON.parse(String(value)); } catch { throw new Error('保存搜索的查询 JSON 无效'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('保存搜索的查询必须是对象');
  return parsed;
}

function normalizeSavedSearch(name, query) {
  const normalizedName = String(name ?? '').trim();
  if (!normalizedName) throw new Error('保存搜索名称不能为空');
  if (!query || typeof query !== 'object' || Array.isArray(query)) throw new Error('保存搜索的查询必须是对象');
  return { name: normalizedName, query: { ...query } };
}

module.exports = { normalizeSavedSearch, parseSavedSearch };
