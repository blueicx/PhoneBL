'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildXmpWriteArgs, writeXmpSidecar } = require('../src/metadata');

test('maps editable metadata to a neighboring XMP sidecar', () => {
  const args = buildXmpWriteArgs({ path: 'D:/photos/a.jpg', tags: '海边,日落', rating: 4, color_label: 'red' }, 'D:/photos/a.jpg.xmp');
  assert.ok(args.includes('-XMP:Subject=海边'));
  assert.ok(args.includes('-XMP:Subject=日落'));
  assert.ok(args.includes('-XMP:Rating=4'));
  assert.ok(args.includes('-XMP:Label=red'));
  assert.equal(args[args.indexOf('-o') + 1], 'D:/photos/a.jpg.xmp');
  assert.equal(args.at(-1), 'D:/photos/a.jpg');
  assert.ok(!args.includes('-overwrite_original'));
});

test('reports an exiftool failure without claiming synchronization', async () => {
  const result = await writeXmpSidecar({ path: 'D:/photos/a.jpg', tags: '', rating: 0 }, {
    run: async () => { throw new Error('tool failed'); }
  });
  assert.deepEqual(result, { ok: false, synced: false, error: 'tool failed' });
});
