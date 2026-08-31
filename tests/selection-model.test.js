'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SelectionModel, resolveContextSelection } = require('../src/selection-model');

test('selects every result id and can remove one id without DOM state', () => {
  const model = new SelectionModel();
  model.selectAll([1, 2, 3]);
  assert.deepEqual(model.ids(), [1, 2, 3]);
  model.toggle(2);
  assert.deepEqual(model.ids(), [1, 3]);
  assert.equal(model.isAllSelected(), false);
});

test('select-all toggles off for the same result set', () => {
  const model = new SelectionModel();
  model.selectAll([1, 2]);
  model.selectAll([1, 2]);
  assert.equal(model.size(), 0);
});

test('context delete uses the selected set when the target is selected', () => {
  assert.deepEqual(resolveContextSelection(new Set([1, 2, 3]), 2), [1, 2, 3]);
  assert.deepEqual(resolveContextSelection(new Set([1, 2, 3]), 9), [9]);
});
