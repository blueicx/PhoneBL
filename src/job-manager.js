class JobCancelled extends Error {
  constructor() { super('Job cancelled'); this.name = 'JobCancelled'; }
}

class JobManager {
  constructor(database, mainWindow, handlers, options = {}) {
    this.db = database;
    this.win = mainWindow;
    this.handlers = handlers || {};
    this.concurrency = Number(options.concurrency || 1);
    this.pollMs = Number(options.pollMs || 500);
    this.controls = new Map();
    this.running = new Set();
    this.stopped = false;
    this.queue = [];
  }

  emit(channel, data) {
    if (!this.win?.isDestroyed()) this.win?.webContents.send(channel, data);
  }

  loadQueuedJobs() {
    const rows = this.db.exec("SELECT id FROM jobs WHERE status IN ('queued','running') ORDER BY id").at(0)?.values || [];
    for (const [id] of rows) {
      if (this.db.run('UPDATE jobs SET status = ? WHERE id = ?', ['queued', id])) this.enqueue(id);
    }
    this.drain();
  }

  submit(type, payload = {}, options = {}) {
    const result = this.db.run(
      `INSERT INTO jobs (type, payload_json, total, max_attempts, status)
       VALUES (?, ?, ?, ?, 'queued')`,
      [String(type), JSON.stringify(payload || {}), Number(options.total || 0), Number(options.maxAttempts || 3)]
    );
    const id = Number(result.lastInsertRowid);
    this.enqueue(id);
    setImmediate(() => this.drain());
    this.notifyChanged();
    return id;
  }

  enqueue(id) { if (!this.queue.includes(id)) this.queue.push(id); }

  row(id) {
    return this.db.exec('SELECT * FROM jobs WHERE id = ?', [Number(id)]).at(0)?.values?.[0] || null;
  }

  object(id) {
    const row = this.row(id);
    if (!row) return null;
    const names = ['id', 'type', 'payloadJson', 'status', 'progress', 'total', 'message', 'resultJson', 'errorText', 'attempts', 'maxAttempts', 'createdAt', 'startedAt', 'finishedAt'];
    const obj = Object.fromEntries(names.map((name, index) => [name, row[index]]));
    try { obj.payload = JSON.parse(obj.payloadJson || '{}'); } catch { obj.payload = {}; }
    return obj;
  }

  setStatus(id, status, patch = {}) {
    const fields = ['status = ?'];
    const params = [status];
    for (const key of ['progress', 'total', 'message', 'errorText']) {
      if (Object.hasOwn(patch, key)) { fields.push(`${key} = ?`); params.push(patch[key]); }
    }
    if (patch.result) { fields.push('result_json = ?'); params.push(JSON.stringify(patch.result)); }
    if (status === 'running') fields.push("started_at = COALESCE(started_at, datetime('now'))");
    if (['done','error','cancelled'].includes(status)) fields.push("finished_at = datetime('now')");
    params.push(Number(id));
    this.db.run(`UPDATE jobs SET ${fields.join(', ')} WHERE id = ?`, params);
    this.emit('jobs-changed', { id: Number(id), status });
  }

  progress(id, processed, total, message) {
    const percent = total ? Math.round((processed / total) * 100) : 0;
    this.setStatus(id, 'running', { progress: percent, total, message });
  }

  pause(id) {
    const control = this.controls.get(Number(id));
    if (control) control.paused = true;
    this.setStatus(id, 'paused');
  }

  resume(id) {
    const control = this.controls.get(Number(id));
    if (control) control.paused = false;
    this.setStatus(id, 'queued');
    this.enqueue(Number(id));
    setImmediate(() => this.drain());
  }

  cancel(id) {
    const numeric = Number(id);
    const control = this.controls.get(numeric);
    if (control) control.cancelled = true;
    else {
      const index = this.queue.indexOf(numeric);
      if (index >= 0) this.queue.splice(index, 1);
      this.setStatus(numeric, 'cancelled');
    }
  }

  retry(id) {
    const numeric = Number(id);
    this.db.run("UPDATE jobs SET attempts = 0, error_text = NULL WHERE id = ?", [numeric]);
    this.setStatus(numeric, 'queued');
    this.enqueue(numeric);
    setImmediate(() => this.drain());
  }

  list(limit = 50) {
    const rows = this.db.exec('SELECT id FROM jobs ORDER BY id DESC LIMIT ?', [limit]).at(0)?.values || [];
    return rows.map(([id]) => this.object(id)).filter(Boolean);
  }

  async drain() {
    while (!this.stopped && this.running.size < this.concurrency && this.queue.length) {
      const id = this.queue.shift();
      if (!id) continue;
      const job = this.object(id);
      if (!job || !['queued'].includes(job.status)) continue;
      this.runJob(job);
    }
  }

  async check(control, jobId) {
    if (control.cancelled) throw new JobCancelled();
    while (control.paused && !control.cancelled && !this.stopped) await new Promise(resolve => setTimeout(resolve, 200));
    if (control.cancelled) throw new JobCancelled();
    void jobId;
  }

  async runJob(job) {
    const control = { paused: false, cancelled: false };
    this.controls.set(job.id, control);
    this.running.add(job.id);
    const attempts = Number(job.attempts || 0) + 1;
    this.db.run('UPDATE jobs SET attempts = ? WHERE id = ?', [attempts, job.id]);
    this.setStatus(job.id, 'running');
    try {
      const handler = this.handlers[job.type];
      if (!handler) throw new Error(`Unknown job type: ${job.type}`);
      const context = {
        payload: job.payload,
        signal: control,
        shouldContinue: () => this.check(control, job.id),
        reportProgress: (processed, total, message) => this.progress(job.id, processed, total, message),
        sendMessage: (channel, data) => this.emit(channel, data),
        window: this.win
      };
      const result = await handler(context);
      if (control.cancelled) throw new JobCancelled();
      this.setStatus(job.id, 'done', { progress: 100, result: result || {} });
    } catch (error) {
      if (error instanceof JobCancelled || control.cancelled) {
        this.setStatus(job.id, 'cancelled', { errorText: '已取消' });
      } else {
        const canRetry = attempts < Number(job.maxAttempts || 3);
        this.setStatus(job.id, canRetry ? 'queued' : 'error', {
          errorText: error.message,
          ...(canRetry ? {} : {})
        });
        if (canRetry) {
          this.queue.push(job.id);
          setTimeout(() => this.drain(), Math.min(30000, 1000 * 2 ** attempts));
        }
      }
    } finally {
      this.controls.delete(job.id);
      this.running.delete(job.id);
      this.drain();
      this.notifyChanged();
    }
  }

  notifyChanged() { this.emit('jobs-changed', { reason: 'list' }); }

  clearFinished() {
    this.db.run("DELETE FROM jobs WHERE status IN ('done','cancelled','error')");
    this.notifyChanged();
  }

  dispose() {
    this.stopped = true;
    for (const control of this.controls.values()) control.cancelled = true;
  }
}

module.exports = { JobManager, JobCancelled };
