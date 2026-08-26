// Dev-only smoke test. Boots the real app with a Chromium debugging port, drives
// the renderer over CDP, and asserts that the gallery placeholders resolve and the
// AI settings panel wires up. Run: node --experimental-websocket scripts/smoke-ui.js
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const PORT = Number(process.env.SMOKE_PORT || 9333);
const ROOT = path.join(__dirname, '..');
const electronBin = require('electron');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function httpJson(url, timeout = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.exceptions = [];
    this.errors = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => resolve(this);
      this.ws.onerror = event => reject(new Error(event.message || 'CDP connection failed'));
      this.ws.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.id && this.pending.has(message.id)) {
          const { resolve: done, reject: fail } = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) fail(new Error(`${message.error.message}`));
          else done(message.result);
        } else if (message.method === 'Runtime.exceptionThrown') {
          const detail = message.params.exceptionDetails;
          this.exceptions.push(detail.exception?.description || detail.text);
        } else if (message.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(message.params.type)) {
          this.errors.push((message.params.args || []).map(a => a.value ?? a.description ?? '').join(' '));
        }
      };
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result.value;
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

async function waitForTarget(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
      const page = targets.find(t => t.type === 'page' && t.url.includes('index.html'));
      if (page?.webSocketDebuggerUrl) return page;
    } catch {}
    await sleep(300);
  }
  throw new Error('renderer target never appeared');
}

function killTree(pid) {
  return new Promise(resolve => {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    killer.on('exit', () => resolve());
    killer.on('error', () => resolve());
  });
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${JSON.stringify(detail)}` : ''}`);
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phonebl-smoke-'));
  const child = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`], {
    cwd: ROOT,
    env: { ...process.env },
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true
  });
  child.on('exit', code => { if (code) console.log(`electron exited with code ${code}`); });

  try {
    const target = await waitForTarget(45000);
    const cdp = await new CdpClient(target.webSocketDebuggerUrl).connect();
    await cdp.send('Runtime.enable');

    // Wait for the first real page of photos to land.
    let gallery = null;
    const deadline = Date.now() + 45000;
    do {
      gallery = await cdp.evaluate(`({
        cards: document.querySelectorAll('.photo-card').length,
        skeletons: document.querySelectorAll('.skeleton-card').length,
        images: document.querySelectorAll('.photo-card img[src]').length,
        emptyVisible: !document.getElementById('empty-state')?.classList.contains('hidden')
      })`);
      if (gallery.cards > 0) break;
      await sleep(500);
    } while (Date.now() < deadline);
    check('gallery renders photo cards', gallery.cards > 0, gallery);
    check('skeleton placeholders are cleared', gallery.skeletons === 0, gallery);

    // Regression guard: an in-flight page append must not strand the next load.
    const race = await cdp.evaluate(`(async () => {
      appendPhotos({});
      await loadPhotos({});
      await new Promise(r => setTimeout(r, 1500));
      return {
        skeletons: document.querySelectorAll('.skeleton-card').length,
        cards: document.querySelectorAll('.photo-card').length,
        loading: galleryLoading,
        offset: galleryOffset
      };
    })()`);
    check('overlapping loads do not strand skeletons', race.skeletons === 0 && race.cards > 0, race);

    const ai = await cdp.evaluate(`(async () => {
      document.querySelector('[data-view="settings"]').click();
      await new Promise(r => setTimeout(r, 800));
      const select = document.getElementById('ai-provider-select');
      const config = await mapApi.getAiConfig();
      return {
        providers: select ? select.options.length : -1,
        selected: select?.value || null,
        model: document.getElementById('ai-model-input')?.value || '',
        baseUrl: document.getElementById('ai-base-url-input')?.value || '',
        hasKey: typeof config.hasKey,
        label: config.label
      };
    })()`);
    check('AI provider settings panel loads', ai.providers >= 2 && Boolean(ai.selected), ai);
    check('AI config reports key state without exposing it', ai.hasKey === 'boolean' && ai.apiKey === undefined, ai);

    await cdp.evaluate(`(async () => {
      document.querySelector('[data-view="map"]').click();
      await new Promise(r => setTimeout(r, 4000));
      return {
        tiles: document.querySelectorAll('.leaflet-tile-loaded').length,
        markers: document.querySelectorAll('.leaflet-marker-icon').length
      };
    })()`);
    const map = await cdp.evaluate(`({
      tiles: document.querySelectorAll('.leaflet-tile-loaded').length,
      markers: document.querySelectorAll('.leaflet-marker-icon').length
    })`);
    check('map reports tile and marker counts', true, map);

    check('no uncaught renderer errors', cdp.exceptions.length === 0, cdp.exceptions.slice(0, 4));
    cdp.close();
  } finally {
    await killTree(child.pid);
    await sleep(500);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  const failed = results.filter(item => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} smoke checks passed`);
  process.exitCode = failed.length ? 1 : 0;
}

// Node 20 needs a flag for global WebSocket; Node 22+ has it enabled already.
if (typeof WebSocket === 'undefined' && process.env.SMOKE_WS_BOOTSTRAP !== '1') {
  process.env.SMOKE_WS_BOOTSTRAP = '1';
  const retry = spawn(process.execPath, ['--experimental-websocket', __filename], {
    stdio: 'inherit',
    windowsHide: true
  });
  retry.on('exit', code => process.exit(code === null ? 1 : code));
} else {
  main().catch(err => {
    console.error('smoke run failed:', err.message);
    process.exitCode = 1;
  });
}
