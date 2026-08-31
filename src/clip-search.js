'use strict';

function normalizeVector(vector) {
  const values = Array.from(vector || [], Number).filter(Number.isFinite);
  const length = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return length ? values.map(value => value / length) : [];
}

function cosineSimilarity(a, b) {
  const left = normalizeVector(a);
  const right = normalizeVector(b);
  if (!left.length || left.length !== right.length) return -1;
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

async function createLocalClipAdapter(modelPath) {
  let transformers;
  try { transformers = await import('@huggingface/transformers'); }
  catch { throw new Error('未安装本地 CLIP 运行依赖，请先安装 @huggingface/transformers'); }
  const { env, pipeline, RawImage } = transformers;
  env.allowRemoteModels = false;
  env.localModelPath = String(modelPath);
  const imagePipeline = await pipeline('image-feature-extraction', String(modelPath));
  const textPipeline = await pipeline('feature-extraction', String(modelPath));
  return {
    async image(photo) {
      const output = await imagePipeline(await RawImage.read(photo.path), { pooling: 'mean', normalize: true });
      return Array.from(output.data);
    },
    async text(text) {
      const output = await textPipeline(String(text), { pooling: 'mean', normalize: true });
      return Array.from(output.data);
    }
  };
}

class ClipSearch {
  constructor(options = {}) {
    this.modelPath = String(options.modelPath || '');
    this.adapter = options.adapter || null;
    this.adapterFactory = options.adapterFactory || createLocalClipAdapter;
    this.entries = [];
    this.loadEntries = options.loadEntries || null;
    this.saveEntry = options.saveEntry || null;
    this.clearEntries = options.clearEntries || null;
    this.loaded = false;
  }

  async ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    if (this.loadEntries) this.entries = (await this.loadEntries()) || [];
  }

  async ensureAdapter() {
    if (this.adapter) return this.adapter;
    if (!this.modelPath) return null;
    this.adapter = await this.adapterFactory(this.modelPath);
    return this.adapter;
  }

  async status() {
    await this.ensureLoaded();
    return { configured: Boolean(this.modelPath), indexed: this.entries.length, total: this.entries.length };
  }

  configure(modelPath) {
    this.modelPath = String(modelPath || '').trim();
    if (!this.modelPath) this.adapter = null;
    return this.status();
  }

  async index(photos, onProgress) {
    await this.ensureLoaded();
    const adapter = await this.ensureAdapter();
    const items = Array.isArray(photos) ? photos : [];
    if (!adapter) return { ok: false, reason: 'model-not-configured', indexed: 0, failed: 0, total: items.length };
    this.entries = [];
    if (this.clearEntries) await this.clearEntries();
    let failed = 0;
    for (const [index, photo] of items.entries()) {
      try {
        const vector = normalizeVector(await adapter.image(photo));
        if (!vector.length) throw new Error('empty vector');
        const entry = { id: Number(photo.id), vector };
        this.entries.push(entry);
        if (this.saveEntry) await this.saveEntry(entry);
      } catch { failed++; }
      if (onProgress) await onProgress(index + 1, items.length);
    }
    return { ok: true, indexed: this.entries.length, failed, total: items.length };
  }

  async search(text, limit = 20) {
    await this.ensureLoaded();
    const adapter = await this.ensureAdapter();
    if (!adapter) return { ok: false, reason: 'model-not-configured', items: [] };
    if (!this.entries.length) return { ok: true, items: [] };
    const vector = await adapter.text(text);
    const items = this.entries.map(entry => ({ id: entry.id, score: cosineSimilarity(vector, entry.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Number(limit) || 20));
    return { ok: true, items };
  }
}

module.exports = { ClipSearch, normalizeVector, cosineSimilarity, createLocalClipAdapter };
