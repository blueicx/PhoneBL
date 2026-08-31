'use strict';

function normalizeIds(ids) {
  return [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger))];
}

class SelectionModel {
  constructor() {
    this.selected = new Set();
    this.lastAllIds = [];
  }

  selectAll(ids) {
    const normalized = normalizeIds(ids);
    const sameSelection = normalized.length === this.selected.size && normalized.every(id => this.selected.has(id));
    if (sameSelection) {
      this.clear();
      return false;
    }
    this.selected = new Set(normalized);
    this.lastAllIds = normalized;
    return true;
  }

  clear() {
    this.selected.clear();
    this.lastAllIds = [];
  }

  toggle(id) {
    const numericId = Number(id);
    if (!Number.isInteger(numericId)) return false;
    if (this.selected.has(numericId)) this.selected.delete(numericId);
    else this.selected.add(numericId);
    return this.selected.has(numericId);
  }

  has(id) { return this.selected.has(Number(id)); }
  ids() { return [...this.selected]; }
  size() { return this.selected.size; }

  isAllSelected() {
    return this.lastAllIds.length > 0 && this.lastAllIds.length === this.selected.size &&
      this.lastAllIds.every(id => this.selected.has(id));
  }
}

function resolveContextSelection(ids, targetId) {
  const selected = normalizeIds(Array.from(ids || []));
  const target = Number(targetId);
  if (Number.isInteger(target) && selected.includes(target)) return selected;
  return Number.isInteger(target) ? [target] : [];
}

module.exports = { SelectionModel, resolveContextSelection };
