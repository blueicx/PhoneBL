'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ClipSearch } = require('../src/clip-search');

test('reports local model unavailable without network fallback', async () => {
  let networkCalls = 0;
  const clip = new ClipSearch({ modelPath: '', fetchImpl: () => { networkCalls++; throw new Error('network used'); } });
  assert.deepEqual(await clip.status(), { configured: false, indexed: 0, total: 0 });
  assert.deepEqual(await clip.search('日落'), { ok: false, reason: 'model-not-configured', items: [] });
  assert.equal(networkCalls, 0);
});

test('indexes local vectors and returns nearest images', async () => {
  const clip = new ClipSearch({ modelPath: 'local', adapter: {
    image: async photo => photo.vector,
    text: async () => [1, 0]
  }});
  const result = await clip.index([{ id: 1, vector: [1, 0] }, { id: 2, vector: [0, 1] }]);
  assert.deepEqual(result, { ok: true, indexed: 2, failed: 0, total: 2 });
  assert.deepEqual((await clip.search('日落')).items.map(item => item.id), [1, 2]);
});

test('continues indexing after one local image failure', async () => {
  const clip = new ClipSearch({ modelPath: 'local', adapter: {
    image: async photo => { if (photo.id === 2) throw new Error('bad image'); return [1, 0]; },
    text: async () => [1, 0]
  }});
  const result = await clip.index([{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.deepEqual(result, { ok: true, indexed: 2, failed: 1, total: 3 });
});

test('changing the local model clears the old adapter and persisted index', async () => {
  let cleared = 0;
  const oldAdapter = { image: async () => [1, 0], text: async () => [1, 0] };
  const clip = new ClipSearch({ modelPath: 'old-model', adapter: oldAdapter, clearEntries: async () => { cleared++; } });
  clip.loaded = true;
  clip.entries = [{ id: 1, vector: [1, 0] }];

  await clip.configure('new-model');

  assert.equal(clip.modelPath, 'new-model');
  assert.equal(clip.adapter, null);
  assert.deepEqual(clip.entries, []);
  assert.equal(cleared, 1);
});
