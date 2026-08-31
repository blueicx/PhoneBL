// Global error catch - prevents one error from breaking everything
window.__mapErrors = [];
window.addEventListener('error', function(e) { window.__mapErrors.push(e.message + ' @ ' + e.lineno); });
window.addEventListener('unhandledrejection', function(e) { window.__mapErrors.push(String(e.reason)); });

const api = window.mapApi;

function showToast(msg, type, duration) {
  type = type || 'info';
  duration = duration || 3000;
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => { el.classList.add('fadeout'); setTimeout(() => el.remove(), 300); }, duration);
}

let currentView = 'library';
let photoMap = null;
let markerCluster = null;
let selectedIds = new Set();
let currentPhotoList = [];
let lightboxIndex = -1;
let lightboxLoadToken = 0;
let currentPage = 0;
let detailNavList = [];
let detailNavIndex = -1;
let photoPresets = [];
let currentEditPhoto = null;
let galleryOffset = 0;
const galleryPageSize = 160;
let galleryLoading = false;
let galleryDone = false;
// Generation counter: lets a fresh load supersede an in-flight page request
// instead of being swallowed by the loading lock.
let gallerySeq = 0;
let currentGalleryQuery = { filter: '', searchQuery: '', sortBy: 'date_taken', sortDir: 'DESC', dateFrom: '', dateTo: '' };
let allResultIds = [];
let allResultsSelected = false;
let savedSearches = [];
let galleryItems = [];
let galleryTotal = 0;
let galleryPageCache = new Map();
let galleryWindowToken = 0;
const galleryFetchSize = 160;

// --- View Switching ---
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

function switchView(viewName) {
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelector(`[data-view="${viewName}"]`).classList.add('active');
  document.getElementById(`view-${viewName}`).classList.add('active');
  currentView = viewName;

  if (viewName === 'map') initMap();
  if (viewName === 'timeline') loadTimeline();
  if (viewName === 'stats') loadStatistics();
}

// --- Window Controls ---
document.getElementById('btn-minimize').addEventListener('click', () => api.minimizeWindow());
document.getElementById('btn-maximize').addEventListener('click', () => api.maximizeWindow());
document.getElementById('btn-close').addEventListener('click', () => api.closeWindow());

// --- Photo Grid ---
async function loadPhotos(options = {}) {
  const seq = ++gallerySeq;
  const grid = document.getElementById('photo-grid');
  const empty = document.getElementById('empty-state');
  grid.innerHTML = '';
  empty.classList.add('hidden');
  for (let i = 0; i < 12; i++) {
    const sk = document.createElement('div');
    sk.className = 'skeleton-card';
    grid.appendChild(sk);
  }

  const searchQ = options.searchQuery ?? document.getElementById('search-input')?.value ?? '';
  const filter = options.filter || document.getElementById('filter-select')?.value || '';
  const sortBy = options.sortBy || document.getElementById('sort-select')?.value || 'date_taken';

  const dateFrom = document.getElementById('date-from')?.value || '';
  const dateTo = document.getElementById('date-to')?.value || '';
  clearSelection();
  currentGalleryQuery = { sortBy, sortDir: 'DESC', filter, searchQuery: searchQ, dateFrom, dateTo };
  galleryOffset = 0; galleryDone = false; galleryLoading = false; detailNavList = [];
  galleryItems = [];
  galleryPageCache = new Map();
  galleryWindowToken++;
  try {
    galleryTotal = await api.getPhotoCount(currentGalleryQuery);
    if (seq !== gallerySeq) return;
    galleryItems = new Array(galleryTotal).fill(null);
    await ensureGalleryRange(0, Math.min(galleryTotal, galleryFetchSize), seq);
    galleryOffset = Math.min(galleryTotal, galleryFetchSize);
    galleryDone = galleryOffset >= galleryTotal;
    await renderGalleryWindow(seq);
  } catch (err) {
    if (seq !== gallerySeq) return;
    grid.innerHTML = '';
    empty.innerHTML = '<div style="font-size:48px;margin-bottom:16px">⚠️</div><p>照片读取失败，请重试</p>';
    empty.classList.remove('hidden');
    showToast('读取照片失败：' + err.message, 'error', 6000);
  }
}

async function fetchGalleryPage(page, seq = gallerySeq) {
  if (galleryPageCache.has(page)) return;
  galleryPageCache.set(page, null);
  const photos = await api.getPhotos({ ...currentGalleryQuery, offset: page * galleryFetchSize, limit: galleryFetchSize });
  if (seq !== gallerySeq) return;
  photos.forEach((photo, index) => { galleryItems[page * galleryFetchSize + index] = photo; });
  galleryPageCache.set(page, true);
}

async function appendPhotos(query = currentGalleryQuery, seq = gallerySeq) {
  if (galleryDone || seq !== gallerySeq) return;
  const page = Math.floor(galleryOffset / galleryFetchSize);
  await fetchGalleryPage(page, seq);
  galleryOffset = Math.min(galleryTotal, galleryOffset + galleryFetchSize);
  galleryDone = galleryOffset >= galleryTotal;
  await renderGalleryWindow(seq);
  void query;
}

async function ensureGalleryRange(start, end, seq = gallerySeq) {
  const firstPage = Math.floor(Math.max(0, start) / galleryFetchSize);
  const lastPage = Math.floor(Math.max(0, end - 1) / galleryFetchSize);
  const pages = [];
  for (let page = firstPage; page <= lastPage; page++) {
    if (!galleryPageCache.has(page)) pages.push(fetchGalleryPage(page, seq));
  }
  await Promise.all(pages);
}

function calculateGalleryWindow(total, scrollTop, viewportHeight, rowHeight, overscanRows = 3, columns = 1) {
  if (!total) return { start: 0, end: 0 };
  const firstRow = Math.max(0, Math.floor(scrollTop / rowHeight) - overscanRows);
  const visibleRows = Math.ceil(viewportHeight / rowHeight) + overscanRows * 2;
  return { start: Math.min(total, firstRow * columns), end: Math.min(total, (firstRow + visibleRows) * columns) };
}

function galleryLayout() {
  const grid = document.getElementById('photo-grid');
  const minSize = zoomSizes[currentZoomLevel] || 260;
  const width = Math.max(320, grid.clientWidth || 1000);
  const columns = Math.max(1, Math.floor((width - 40 + 12) / (minSize + 12)));
  const cardWidth = (width - 40 - (columns - 1) * 12) / columns;
  return { columns, rowHeight: Math.max(160, cardWidth + 12), padding: 20 };
}

async function renderGalleryWindow(seq = gallerySeq) {
  const grid = document.getElementById('photo-grid');
  const empty = document.getElementById('empty-state');
  if (!galleryTotal) {
    grid.innerHTML = '';
    empty.innerHTML = '<div style="font-size:48px;margin-bottom:16px">📷</div><p>当前筛选没有匹配的照片</p>';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  const layout = galleryLayout();
  const scroller = document.getElementById('main-content');
  const windowRange = calculateGalleryWindow(galleryTotal, scroller.scrollTop, scroller.clientHeight, layout.rowHeight, 3, layout.columns);
  const token = ++galleryWindowToken;
  await ensureGalleryRange(windowRange.start, windowRange.end, seq);
  if (seq !== gallerySeq || token !== galleryWindowToken) return;
  const topRows = Math.floor(windowRange.start / layout.columns);
  const endRows = Math.ceil((galleryTotal - windowRange.end) / layout.columns);
  grid.innerHTML = '';
  const top = document.createElement('div');
  top.className = 'gallery-spacer';
  top.style.height = `${topRows * layout.rowHeight}px`;
  grid.appendChild(top);
  const fragment = document.createDocumentFragment();
  for (let index = windowRange.start; index < windowRange.end; index++) {
    const photo = galleryItems[index];
    if (photo) fragment.appendChild(createPhotoCard(photo));
    else {
      const placeholder = document.createElement('div');
      placeholder.className = 'photo-card skeleton-card';
      fragment.appendChild(placeholder);
    }
  }
  grid.appendChild(fragment);
  const bottom = document.createElement('div');
  bottom.className = 'gallery-spacer';
  bottom.style.height = `${Math.max(0, endRows) * layout.rowHeight}px`;
  grid.appendChild(bottom);
  grid.querySelectorAll('.lazy-thumb').forEach(img => {
    img.dataset.observed = '1';
    thumbObserver.observe(img);
  });
  detailNavList = galleryItems.filter(Boolean);
}

function createPhotoCard(photo) {
  const card = document.createElement('div');
  card.className = 'photo-card';
  card.dataset.id = photo.id;
  if (selectedIds.has(Number(photo.id))) card.classList.add('selected');

  let badges = '';
  if (photo.has_gps) badges += '<span class="badge-gps">📍</span>';
  if (photo.is_raw) badges += '<span class="badge-raw">RAW</span>';
  if (photo.starred) badges += '<span class="badge-star">⭐</span>';
  if (photo.rating > 0) badges += `<span class="badge-rating">${Number(photo.rating)}★</span>`;
  if (photo.color_label) badges += `<span class="badge-color ${escapeHtml(photo.color_label)}"></span>`;

  const thumbVersion = photo.edited_at ? encodeURIComponent(photo.edited_at) : '0';
  const thumbSrc = photo.thumb_path
    ? `file:///${photo.thumb_path.replace(/\\/g, '/')}?v=${thumbVersion}`
    : 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect fill="%2321262d" width="100" height="100"/><text x="50" y="55" text-anchor="middle" fill="%238b949e" font-size="12">?</text></svg>';

  card.innerHTML = `
    <img data-src="${thumbSrc}" src="" class="lazy-thumb" loading="lazy" alt="${escapeHtml(photo.filename)}" />
    ${badges}
    <div class="card-overlay">
      <div class="card-filename">${escapeHtml(photo.filename)}</div>
    </div>
  `;
  card.addEventListener('click', (e) => {
    if (e.ctrlKey || e.metaKey) {
      toggleSelect(photo.id, card);
    } else if (selectedIds.size > 0) {
      toggleSelect(photo.id, card);
    } else {
      console.log('[DEBUG] card clicked, opening detail');
      openPhotoDetail(photo.id);
    }
  });
  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e, photo);
  });
  return card;
}

function toggleSelect(id, cardEl) {
  if (selectedIds.has(id)) {
    selectedIds.delete(id);
    cardEl?.classList.remove('selected');
  } else {
    selectedIds.add(id);
    cardEl?.classList.add('selected');
  }
  allResultsSelected = false;
  updateBatchBar();
}

function updateBatchBar() {
  const bar = document.getElementById('batch-bar');
  const countEl = document.getElementById('batch-count');
  if (selectedIds.size > 0) {
    bar.classList.remove('hidden');
    countEl.textContent = `已选 ${selectedIds.size} 张`;
  } else {
    bar.classList.add('hidden');
  }
  const label = allResultsSelected && selectedIds.size === allResultIds.length ? '取消全选' : '全选';
  document.getElementById('btn-select-all')?.replaceChildren(document.createTextNode(label));
  document.getElementById('btn-batch-select-all')?.replaceChildren(document.createTextNode(label));
}

function clearSelection() {
  selectedIds.clear();
  allResultIds = [];
  allResultsSelected = false;
  document.querySelectorAll('.photo-card.selected').forEach(card => card.classList.remove('selected'));
  updateBatchBar();
}

async function loadSavedSearches() {
  const select = document.getElementById('saved-search-select');
  if (!select) return;
  savedSearches = await api.listSavedSearches();
  select.innerHTML = '<option value="">保存的搜索</option>' + savedSearches
    .map(item => `<option value="${Number(item.id)}">${escapeHtml(item.name)}</option>`).join('');
}

function applySavedSearch(search) {
  const query = search?.query || {};
  document.getElementById('search-input').value = query.searchQuery || '';
  document.getElementById('filter-select').value = query.filter || '';
  document.getElementById('date-from').value = query.dateFrom || '';
  document.getElementById('date-to').value = query.dateTo || '';
  document.getElementById('sort-select').value = query.sortBy || 'date_taken';
  void loadPhotos(query);
}

async function openComparison() {
  const ids = [...selectedIds];
  if (ids.length < 2) { showToast('请至少选择两张照片进行对比'); return; }
  const visibleIds = ids.slice(0, 4);
  const grid = document.getElementById('compare-grid');
  grid.innerHTML = '<p>正在加载对比照片...</p>';
  document.getElementById('compare-modal').classList.remove('hidden');
  const details = await Promise.all(visibleIds.map(id => api.getPhotoDetail(id)));
  const images = await Promise.all(visibleIds.map(id => api.getDisplayPhoto(id, true)));
  grid.innerHTML = '';
  details.forEach((detail, index) => {
    if (!detail) return;
    const pane = document.createElement('article');
    pane.className = 'compare-pane';
    const gps = detail.has_gps ? `${Number(detail.gps_lat).toFixed(5)}, ${Number(detail.gps_lon).toFixed(5)}` : '无';
    pane.innerHTML = `<img src="${images[index] ? localFileUrl(images[index]) : ''}" alt="${escapeHtml(detail.filename)}" />
      <h4 title="${escapeHtml(detail.filename)}">${escapeHtml(detail.filename)}</h4>
      <dl class="compare-meta">
        <dt>日期</dt><dd>${escapeHtml(detail.date_taken || '未知')}</dd>
        <dt>尺寸</dt><dd>${Number(detail.width) || 0} × ${Number(detail.height) || 0}</dd>
        <dt>评分</dt><dd>${Number(detail.rating) || 0}★</dd>
        <dt>GPS</dt><dd>${escapeHtml(gps)}</dd>
        <dt>版本</dt><dd>${detail.edited_at ? '已编辑副本' : '原图'}</dd>
      </dl>`;
    grid.appendChild(pane);
  });
  if (ids.length > 4) showToast('已按当前选择顺序展示前 4 张照片');
}

async function selectAllCurrentResults() {
  const button = document.getElementById('btn-select-all');
  if (button) button.disabled = true;
  try {
    const ids = (await api.getPhotoIds(currentGalleryQuery)).map(Number).filter(Number.isInteger);
    const sameSelection = ids.length === selectedIds.size && ids.every(id => selectedIds.has(id));
    if (sameSelection) {
      clearSelection();
      return;
    }
    allResultIds = ids;
    selectedIds = new Set(ids);
    allResultsSelected = true;
    document.querySelectorAll('.photo-card').forEach(card => card.classList.add('selected'));
    updateBatchBar();
    showToast(ids.length ? `已选中当前结果 ${ids.length} 张照片` : '当前筛选结果为空', ids.length ? 'success' : 'info');
  } catch (err) {
    showToast('全选失败：' + err.message, 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function updateRatingControls(rating) {
  document.querySelectorAll('#detail-rating button').forEach(button => {
    button.classList.toggle('active', Number(button.dataset.rating) > 0 && Number(button.dataset.rating) <= Number(rating));
  });
}

function updateColorControls(color) {
  document.querySelectorAll('#detail-colors button').forEach(button => {
    button.classList.toggle('active', button.dataset.color === color);
  });
}

function syncCurrentPhotoCache(id, patch = {}) {
  const knownPhoto = detailNavList.find(photo => photo.id === Number(id));
  if (knownPhoto) Object.assign(knownPhoto, patch);
  const card = document.querySelector(`.photo-card[data-id="${Number(id)}"]`);
  if (!card) return;
  if (Object.hasOwn(patch, 'starred')) {
    let badge = card.querySelector('.badge-star');
    if (patch.starred && !badge) {
      badge = document.createElement('span');
      badge.className = 'badge-star';
      badge.textContent = '⭐';
      card.appendChild(badge);
    } else if (!patch.starred && badge) badge.remove();
  }
  if (Object.hasOwn(patch, 'rating')) {
    let badge = card.querySelector('.badge-rating');
    const value = Number(patch.rating || 0);
    if (value && !badge) {
      badge = document.createElement('span');
      badge.className = 'badge-rating';
      card.appendChild(badge);
    }
    if (badge) badge.textContent = value ? `${value}★` : '';
    if (!value && badge) badge.remove();
  }
  if (Object.hasOwn(patch, 'color_label')) {
    let badge = card.querySelector('.badge-color');
    if (patch.color_label && !badge) {
      badge = document.createElement('span');
      badge.className = `badge-color ${patch.color_label}`;
      card.appendChild(badge);
    } else if (!patch.color_label && badge) badge.remove();
    else if (badge) badge.className = `badge-color ${patch.color_label}`;
  }
}

async function loadVersionOptions(photoId) {
  const select = document.getElementById('version-select');
  if (!select) return;
  const versions = await api.getPhotoVersions(photoId);
  select.innerHTML = '';
  for (const version of versions) {
    const option = document.createElement('option');
    option.value = version.id;
    option.textContent = `${version.version_type === 'original' ? '原图' : version.version_type}${version.is_active ? '（当前）' : ''} · ${new Date(version.created_at).toLocaleString()}`;
    if (version.is_active) option.selected = true;
    select.appendChild(option);
  }
}

function bindDetailMetadataControls() {
  document.querySelectorAll('#detail-rating button').forEach(button => {
    button.addEventListener('click', async () => {
      const id = Number(currentEditPhoto);
      if (!id) return;
      const rating = await api.setRating(id, button.dataset.rating);
      updateRatingControls(rating);
      syncCurrentPhotoCache(id, { rating });
    });
  });

  document.querySelectorAll('#detail-colors button').forEach(button => {
    button.addEventListener('click', async () => {
      const id = Number(currentEditPhoto);
      if (!id) return;
      const colorLabel = await api.setColorLabel(id, button.dataset.color || '');
      updateColorControls(colorLabel);
      syncCurrentPhotoCache(id, { color_label: colorLabel });
    });
  });

  document.getElementById('version-select').addEventListener('change', async event => {
    const id = Number(currentEditPhoto);
    const versionId = Number(event.target.value);
    if (!id || !versionId) return;
    const result = await api.activatePhotoVersion(id, versionId);
    if (!result.ok) {
      showToast(result.error || '版本切换失败');
      return;
    }
    showToast('已切换显示版本', 'success');
    await _openDetail(id);
  });
}

// --- Task Center ---
const TASK_TYPE_NAMES = {
  scan: '扫描照片',
  thumbnails: '修复缩略图',
  watermark: '添加水印',
  compression: '压缩照片',
  'ai-tags': 'AI 标签'
};
const TASK_STATUS_NAMES = {
  queued: '排队中',
  running: '进行中',
  paused: '已暂停',
  done: '已完成',
  error: '失败',
  cancelled: '已取消'
};
let tasksRefreshing = false;

async function refreshTasks() {
  if (tasksRefreshing) return;
  tasksRefreshing = true;
  try {
    const jobs = await api.jobList();
    const list = document.getElementById('task-list');
    if (!list) return;
    if (!jobs.length) {
      list.innerHTML = '<div class="task-empty">暂无任务</div>';
      return;
    }
    list.innerHTML = '';
    for (const job of jobs) {
      const item = document.createElement('div');
      item.className = `task-item status-${job.status}`;
      const percent = Number(job.progress || 0);
      const total = Number(job.total || 0);
      const controls = [];
      if (['queued', 'running'].includes(job.status)) controls.push('<button data-action="pause">暂停</button>');
      if (job.status === 'paused') controls.push('<button data-action="resume">继续</button>');
      if (['queued', 'running', 'paused'].includes(job.status)) controls.push('<button data-action="cancel">取消</button>');
      if (['error', 'cancelled'].includes(job.status)) controls.push('<button data-action="retry">重试</button>');
      if (['done', 'error', 'cancelled'].includes(job.status)) controls.push('<button data-action="clear-one">移除</button>');

      item.innerHTML = `
        <div class="task-item-top">
          <strong>${escapeHtml(TASK_TYPE_NAMES[job.type] || job.type)} #${job.id}</strong>
          <span class="task-status ${job.status}">${TASK_STATUS_NAMES[job.status] || job.status}</span>
        </div>
        <div class="task-message">${escapeHtml(job.message || `${percent}%${total ? ` · 共 ${total} 项` : ''}`)}</div>
        <div class="task-progress"><div class="task-progress-bar" style="width:${percent}%"></div></div>
        ${job.errorText ? `<div class="task-error" title="${escapeHtml(job.errorText)}">${escapeHtml(job.errorText)}</div>` : ''}
        <div class="task-controls">${controls.join('')}</div>
      `;
      item.querySelectorAll('[data-action]').forEach(button => {
        button.addEventListener('click', async () => {
          const action = button.dataset.action;
          try {
            if (action === 'clear-one') await api.jobRemove(job.id);
            else await api[`job${action[0].toUpperCase()}${action.slice(1)}`](job.id);
            await refreshTasks();
          } catch (error) {
            showToast(`任务操作失败：${error.message}`);
          }
        });
      });
      list.appendChild(item);
    }
  } catch (error) {
    console.warn('Refresh tasks failed:', error);
  } finally {
    tasksRefreshing = false;
  }
}

document.getElementById('btn-task-clear').addEventListener('click', async () => {
  await api.jobClearFinished();
  refreshTasks();
});
document.getElementById('btn-task-toggle').addEventListener('click', () => {
  const panel = document.getElementById('task-center');
  const collapsed = panel.classList.toggle('collapsed');
  document.getElementById('btn-task-toggle').textContent = collapsed ? '▼' : '▲';
});
api.onJobsChanged(() => refreshTasks());
setInterval(refreshTasks, 5000);
refreshTasks();

// --- Scan with options ---
let scanFolderPath = null;

document.getElementById('btn-scan-folder').addEventListener('click', async () => {
  const folder = await api.pickFolder();
  if (!folder) return;
  scanFolderPath = folder;
  document.getElementById('scan-modal').classList.remove('hidden');
});

document.getElementById('btn-scan-cancel').addEventListener('click', () => {
  document.getElementById('scan-modal').classList.add('hidden');
});

document.getElementById('btn-scan-start').addEventListener('click', async () => {
  const includeRaw = document.getElementById('chk-include-raw').checked;
  document.getElementById('scan-modal').classList.add('hidden');
  if (!scanFolderPath) return;

  const statusEl = document.getElementById('scan-status');
  statusEl.classList.remove('hidden');
  statusEl.textContent = `正在扫描 ${scanFolderPath} ...${includeRaw ? '（含 RAW）' : ''}`;

  api.onScanProgress(data => {
    statusEl.textContent = `扫描中... ${data.processed}/${data.total}（新增 ${data.added}，跳过 ${data.skipped}）`;
  });

  const result = await api.scanFolder(scanFolderPath, includeRaw);
  if (result.ok) {
    statusEl.textContent = `完成！共发现 ${result.total} 张，新增 ${result.added} 张。`;
    setTimeout(() => statusEl.classList.add('hidden'), 5000);
    await updateStats();
    await loadPhotos();
    photoMap = null;
    markerCluster = null;
  } else {
    statusEl.textContent = `错误: ${result.error}`;
  }
});

// --- Search & Filter ---
let searchDebounce;
document.getElementById('search-input').addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => loadPhotos(), 400);
});
let filterDebounce;
document.getElementById('filter-select').addEventListener('change', () => {
  clearTimeout(filterDebounce);
  filterDebounce = setTimeout(() => loadPhotos(), 300);
});

new IntersectionObserver(entries => {
  if (!entries[0].isIntersecting || currentView !== 'library') return;
  appendPhotos({
    sortBy: document.getElementById('sort-select')?.value || 'date_taken',
    filter: document.getElementById('filter-select')?.value || '',
    searchQuery: document.getElementById('search-input')?.value || '',
    dateFrom: document.getElementById('date-from')?.value || '',
    dateTo: document.getElementById('date-to')?.value || ''
  });
}, { rootMargin: '600px' }).observe(document.getElementById('infinite-sentinel'));
let sortDebounce;
document.getElementById('sort-select').addEventListener('change', () => {
  clearTimeout(sortDebounce);
  sortDebounce = setTimeout(() => loadPhotos(), 300);
});

// --- Map ---
async function initMap() {
  if (photoMap) { photoMap.invalidateSize(); return; }

  photoMap = L.map('map-canvas').setView([30, 110], 4);
  L.tileLayer('maptile://tiles/{z}/{x}/{y}', {
    attribution: 'Esri, HERE, Garmin',
    maxZoom: 16,
    keepBuffer: 8,
    updateWhenIdle: false,
    updateWhenZooming: false,
    errorTileUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  }).addTo(photoMap);

  const points = await api.getMapPoints();
  markerCluster = L.markerClusterGroup({
    maxClusterRadius: 40,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false
  });

  for (const pt of points) {
    const thumbSrc = pt.thumb_path
      ? `file:///${pt.thumb_path.replace(/\\/g, '/')}?v=${encodeURIComponent(pt.edited_at || '0')}`
      : '';
    const popupHtml = `
      <div style="text-align:center">
        <img src="${thumbSrc}" width="120" style="border-radius:6px; margin-bottom:6px;" />
        <br><b>${escapeHtml(pt.filename)}</b>
        <br><small>${pt.date_taken ? new Date(pt.date_taken).toLocaleDateString() : ''}</small>
      </div>
    `;
    L.marker([pt.gps_lat, pt.gps_lon])
      .bindPopup(popupHtml, { maxWidth: 160 })
      .addTo(markerCluster);
  }

  photoMap.addLayer(markerCluster);

  if (points.length > 0) {
    photoMap.fitBounds(markerCluster.getBounds().pad(0.1));
  }
}

// --- Timeline: vertical line with day dots ---
async function loadTimeline() {
  const container = document.getElementById('timeline-container');
  container.innerHTML = '<p>加载时间线...</p>';

  const photos = await api.getPhotos({ offset: 0, limit: 5000, sortBy: 'date_taken', sortDir: 'DESC' });
  if (!photos.length) {
    container.innerHTML = '<p>暂无照片数据。</p>';
    return;
  }
  detailNavList = photos;

  const months = {};
  for (const p of photos) {
    const dt = p.date_taken ? new Date(p.date_taken) : null;
    const mk = dt ? `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}` : '未知';
    const dk = dt ? `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}` : '未知';
    if (!months[mk]) months[mk] = {};
    if (!months[mk][dk]) months[mk][dk] = [];
    months[mk][dk].push(p);
  }

  container.innerHTML = '';
  for (const [monthKey, days] of Object.entries(months)) {
    const groupDiv = document.createElement('div');
    groupDiv.className = 'tl-month collapsed';

    let label;
    if (monthKey === '未知') label = monthKey;
    else { const [y, m] = monthKey.split('-'); label = `${y}年${parseInt(m)}月`; }
    const totalInMonth = Object.values(days).reduce((s, a) => s + a.length, 0);

    const header = document.createElement('div');
    header.className = 'tl-header';
    header.innerHTML = `<span class="tl-title">${escapeHtml(label)}</span><span class="tl-meta">${totalInMonth} 张</span>`;
    groupDiv.appendChild(header);

    // Vertical line area with day dots
    const lineArea = document.createElement('div');
    lineArea.className = 'tl-line-area';

    // Sort days chronologically
    const sortedDays = Object.entries(days).sort((a, b) => a[0].localeCompare(b[0]));

    for (const [dayKey, photosInDay] of sortedDays) {
      const d = new Date(dayKey + 'T00:00:00');
      const weekday = ['日','一','二','三','四','五','六'][d.getDay()];
      const dayLabel = `${d.getDate()}日 周${weekday}`;

      const dayItem = document.createElement('div');
      dayItem.className = 'tl-day-item';

      const dot = document.createElement('div');
      dot.className = 'tl-dot';
      dot.innerHTML = `<span class="tl-dot-label">${escapeHtml(dayLabel)}</span><span class="tl-dot-count">${photosInDay.length}</span>`;

      const photoPanel = document.createElement('div');
      photoPanel.className = 'tl-photo-panel hidden';
      const grid = document.createElement('div');
      grid.className = 'photo-grid tl-grid';
      for (const p of photosInDay) grid.appendChild(createPhotoCard(p));
      photoPanel.appendChild(grid);

      dot.addEventListener('click', () => photoPanel.classList.toggle('hidden'));

      dayItem.appendChild(dot);
      dayItem.appendChild(photoPanel);
      lineArea.appendChild(dayItem);
    }

    groupDiv.appendChild(lineArea);
    header.addEventListener('click', () => groupDiv.classList.toggle('collapsed'));
    container.appendChild(groupDiv);
  }
}


// --- Photo Detail Modal ---
async function openPhotoDetail(id) {
  console.log('[DEBUG] openPhotoDetail called with id:', id);
  try {
    await _openDetail(id);
  } catch(e) { console.error('openPhotoDetail error:', e); showToast('打开失败: ' + e.message); }
}

let detailLoadToken = 0;

function localFileUrl(filePath) {
  if (!filePath) return '';
  return 'file:///' + String(filePath).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
}

function isDetailCurrent(token, id) {
  return detailLoadToken === token && currentEditPhoto === id;
}

function setDetailImageWhenReady(token, id, source) {
  if (!source) return;
  const image = new Image();
  image.src = source;
  const swap = () => {
    if (isDetailCurrent(token, id)) document.getElementById('detail-img').src = source;
  };
  if (image.decode) image.decode().then(swap).catch(() => { image.onload = swap; });
  else image.onload = swap;
}

async function _openDetail(id) {
  const token = ++detailLoadToken;
  currentEditPhoto = id;
  const knownPhoto = detailNavList.find(photo => photo.id === id);
  const modal = document.getElementById('photo-modal');

  if (knownPhoto) {
    detailNavIndex = detailNavList.findIndex(photo => photo.id === id);
    modal.classList.remove('hidden');
    document.getElementById('detail-filename').textContent = knownPhoto.filename;
    if (knownPhoto.thumb_path) {
      document.getElementById('detail-img').src = localFileUrl(knownPhoto.thumb_path);
    }
    detailZoom = 1; dPanX = 0; dPanY = 0;
    const dImg = document.getElementById('detail-img');
    dImg.style.transform = '';
    dImg.style.cursor = '';
  }

  const detail = await api.getPhotoDetail(id);
  if (!isDetailCurrent(token, id)) return;
  if (!detail) return;

  if (!knownPhoto) {
    if (!detailNavList.some(photo => photo.id === id)) {
      const photos = await api.getPhotos({ offset: 0, limit: 5000, sortBy: 'date_taken', sortDir: 'DESC' });
      if (!isDetailCurrent(token, id)) return;
      if (photos.some(photo => photo.id === id)) detailNavList = photos;
      else detailNavList = [...detailNavList, detail].filter(Boolean);
    }
    detailNavIndex = detailNavList.findIndex(photo => photo.id === id);
    modal.classList.remove('hidden');
    document.getElementById('detail-filename').textContent = detail.filename;
    if (detail.thumb_path) document.getElementById('detail-img').src = localFileUrl(detail.thumb_path);
    detailZoom = 1; dPanX = 0; dPanY = 0;
    const dImg = document.getElementById('detail-img');
    dImg.style.transform = '';
    dImg.style.cursor = '';
  }

  api.getDisplayPhoto(id, true).then(displayPath => {
    if (displayPath) setDetailImageWhenReady(token, id, localFileUrl(displayPath));
  });

  // Metadata
  const metaList = document.getElementById('detail-metadata');
  metaList.innerHTML = '';
  const fields = [
    ['拍摄日期', detail.date_taken ? new Date(detail.date_taken).toLocaleString() : null],
    ['相机', detail.camera_make && detail.camera_model ? `${detail.camera_make} ${detail.camera_model}` : null],
    ['ISO', detail.iso],
    ['光圈', detail.aperture ? `f/${detail.aperture}` : null],
    ['快门', detail.shutter],
    ['焦距', detail.focal_length ? `${detail.focal_length}mm` : null],
    ['尺寸', detail.width ? `${detail.width} × ${detail.height}` : null],
    ['大小', detail.size ? formatBytes(detail.size) : null],
    ['GPS', detail.has_gps ? `${detail.gps_lat.toFixed(6)}, ${detail.gps_lon.toFixed(6)}` : null],
    ['格式', detail.ext]
  ];
  for (const [label, value] of fields) {
    if (!value) continue;
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    metaList.appendChild(dt);
    metaList.appendChild(dd);
  }

  if (detail.has_gps) {
    const locationDt = document.createElement('dt');
    const locationDd = document.createElement('dd');
    locationDt.textContent = '位置';
    locationDd.textContent = '解析中...';
    metaList.append(locationDt, locationDd);
    api.reverseGeocode(detail.gps_lat, detail.gps_lon).then(location => {
      if (isDetailCurrent(token, id) && location.displayName) {
        locationDd.textContent = location.displayName;
      }
    }).catch(() => {
      if (isDetailCurrent(token, id)) locationDd.textContent = '无法获取位置名称';
    });
  }

  // Tags
  const tagsInput = document.getElementById('detail-tags-input');
  tagsInput.value = detail.tags || '';
  tagsInput.dataset.photoId = id;

  // Populate GPS inputs
  document.getElementById('gps-lat-input').value = detail.has_gps ? detail.gps_lat.toFixed(6) : '';
  document.getElementById('gps-lon-input').value = detail.has_gps ? detail.gps_lon.toFixed(6) : '';
  updateRatingControls(detail.rating || 0);
  updateColorControls(detail.color_label || '');
  loadVersionOptions(id);

  const savedEdit = (() => { try { return JSON.parse(detail.edit_settings || 'null'); } catch { return null; } })();
  const applySavedEdit = () => {
    if (!isDetailCurrent(token, id)) return;
    if (savedEdit?.presetId) document.getElementById('preset-select').value = String(savedEdit.presetId);
    const strengthInput = document.getElementById('preset-strength');
    strengthInput.value = savedEdit?.intensity || 100;
    document.getElementById('preset-strength-value').textContent = `${strengthInput.value}%`;
  };
  if (photoPresets.length) applySavedEdit();
  else refreshPhotoPresets().then(applySavedEdit);

  // Quick tag buttons
  const QUICK_TAGS = ['风景','日落','日出','海滩','山脉','城市','建筑','美食','夜景','街拍','花卉','动物'];
  const currentTags = (detail.tags || '').split(',').map(s => s.trim()).filter(Boolean);
  const qtContainer = document.getElementById('quick-tags');
  qtContainer.innerHTML = '';
  for (const tag of QUICK_TAGS) {
    const chip = document.createElement('span');
    chip.className = 'quick-tag' + (currentTags.includes(tag) ? ' active' : '');
    chip.textContent = tag;
    chip.addEventListener('click', () => {
      let tags = tagsInput.value.split(',').map(s => s.trim()).filter(Boolean);
      if (tags.includes(tag)) {
        tags = tags.filter(t => t !== tag);
        chip.classList.remove('active');
      } else {
        tags.push(tag);
        chip.classList.add('active');
      }
      tagsInput.value = tags.join(',');
    });
    qtContainer.appendChild(chip);
  }

  // Similar photos
  const similarGrid = document.getElementById('similar-grid');
  similarGrid.innerHTML = '';
  api.findSimilar(id).then(similar => {
    if (!isDetailCurrent(token, id)) return;
    similarGrid.innerHTML = '';
    for (const s of similar) {
      if (!s.thumb_path) continue;
      const img = document.createElement('img');
      img.src = localFileUrl(s.thumb_path);
      img.title = s.filename;
      img.addEventListener('click', () => openPhotoDetail(s.id));
      similarGrid.appendChild(img);
    }
  });

  setTimeout(() => {
    if (!isDetailCurrent(token, id)) return;
    const neighbors = [detailNavList[detailNavIndex + 1], detailNavList[detailNavIndex - 1]];
    neighbors.forEach(photo => {
      if (photo?.id) api.getDisplayPhoto(photo.id, true, 'low');
    });
  }, 750);

// Actions
document.getElementById('btn-open-file').onclick = () => api.openFile(detail.path);
document.getElementById('btn-show-folder').onclick = () => api.showInFolder(detail.path);
}

document.getElementById('preset-strength').addEventListener('input', (e) => {
  document.getElementById('preset-strength-value').textContent = `${e.target.value}%`;
});

document.getElementById('batch-edit-strength').addEventListener('input', (e) => {
  document.getElementById('batch-strength-value').textContent = `${e.target.value}%`;
});

document.getElementById('btn-import-preset').addEventListener('click', async () => {
  const result = await api.importPresetDialog();
  if (!result.ok) return;
  await refreshPhotoPresets();
  if (result.imported) showToast(`已导入 ${result.imported} 个预设`, 'success');
  else if (result.failed) showToast('导入失败：没有识别到 Lightroom 参数');
});

document.getElementById('btn-preset-preview').addEventListener('click', async () => {
  const presetId = selectedPresetId();
  const photoId = currentEditPhoto;
  if (!photoId || !presetId) { showToast('请先选择一个预设'); return; }
  const button = document.getElementById('btn-preset-preview');
  button.disabled = true;
  button.textContent = '生成中';
  const result = await api.previewPhotoEdit(photoId, presetId, Number(document.getElementById('preset-strength').value));
  button.disabled = false;
  button.textContent = '预览';
  if (!result.ok || currentEditPhoto !== photoId) {
    if (!result.ok) showToast(result.error || '预览失败');
    return;
  }
  showEditedFile(result.path);
});

document.getElementById('btn-preset-save').addEventListener('click', async () => {
  const presetId = selectedPresetId();
  const photoId = currentEditPhoto;
  if (!photoId || !presetId) { showToast('请先选择一个预设'); return; }
  const button = document.getElementById('btn-preset-save');
  button.disabled = true;
  button.textContent = '应用中';
  const result = await api.applyPhotoEdit(photoId, presetId, Number(document.getElementById('preset-strength').value));
  button.disabled = false;
  button.textContent = '应用';
  if (!result.ok) { showToast(result.error || '应用失败'); return; }
  showToast('已保存轻修图副本，原图未改动', 'success');
  showEditedFile(result.path);
  loadPhotos();
});

document.getElementById('btn-preset-reset').addEventListener('click', async () => {
  const photoId = currentEditPhoto;
  if (!photoId) return;
  const result = await api.resetPhotoEdit(photoId);
  if (!result.ok) { showToast(result.error || '还原失败'); return; }
  showToast('已还原为原图', 'success');
  await _openDetail(photoId);
  loadPhotos();
});

document.getElementById('btn-preset-export').addEventListener('click', async () => {
  const result = await api.exportPhotoEdit(currentEditPhoto);
  if (result.ok) showToast('修图副本已导出', 'success');
  else if (result.error) showToast(result.error);
});

document.getElementById('btn-compress-photo').addEventListener('click', async () => {
  const photoId = currentEditPhoto;
  if (!photoId) return;
  const result = await applyCompressions([photoId], 'single');
  if (result?.ok && result.paths?.length && currentEditPhoto === photoId) {
    showEditedFile(result.paths[0]);
  }
});

async function refreshPhotoPresets() {
  photoPresets = await api.listPresets();
  for (const selectId of ['preset-select', 'batch-preset-select']) {
    const select = document.getElementById(selectId);
    select.innerHTML = '';
    if (!photoPresets.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '先导入预设';
      select.appendChild(option);
      continue;
    }
    for (const preset of photoPresets) {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = `${preset.name}（${preset.supported_count} 项）`;
      select.appendChild(option);
    }
  }
}

function selectedPresetId() {
  return Number(document.getElementById('preset-select').value || 0);
}

function showEditedFile(path) {
  const img = document.getElementById('detail-img');
  img.src = `file:///${path.replace(/\\/g, '/')}?v=${Date.now()}`;
}

document.getElementById('btn-close-detail').addEventListener('click', () => {
  document.getElementById('photo-modal').classList.add('hidden');
});
document.getElementById('btn-save-tags').addEventListener('click', async () => {
  const input = document.getElementById('detail-tags-input');
  const id = parseInt(input.dataset.photoId);
  await api.updateTags(id, input.value.trim());
  input.style.borderColor = 'var(--success)';
  setTimeout(() => input.style.borderColor = '', 1500);
});

document.getElementById('photo-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.target.classList.add('hidden');
});


function navigateDetail(delta) {
  if (!detailNavList.length || detailNavIndex < 0) return;
  let next = detailNavIndex + delta;
  if (next < 0) next = detailNavList.length - 1;
  if (next >= detailNavList.length) next = 0;
  detailNavIndex = next;
  _openDetail(detailNavList[next].id);
}

document.querySelector('.detail-prev').addEventListener('click', () => navigateDetail(-1));
document.querySelector('.detail-next').addEventListener('click', () => navigateDetail(1));

// --- Advanced Search ---
let advSearchDebounce;
document.getElementById('adv-search-input').addEventListener('input', async () => {
  clearTimeout(advSearchDebounce);
  advSearchDebounce = setTimeout(async () => {
    const q = document.getElementById('adv-search-input').value.trim();
    const resultsGrid = document.getElementById('search-results');
    resultsGrid.innerHTML = '';
    if (!q) return;
    const results = await api.getPhotos({ offset: 0, limit: 300, searchQuery: q });
    if (!results.length) {
      resultsGrid.innerHTML = '<p style="padding:20px;color:var(--text-secondary)">没有找到匹配的照片。</p>';
      return;
    }
    for (const p of results) resultsGrid.appendChild(createPhotoCard(p));
    detailNavList = results;
  }, 400);
});

// --- Settings ---
async function refreshWatermark() {
  const preview = document.getElementById('watermark-preview');
  const removeButton = document.getElementById('btn-remove-watermark');
  const watermark = await api.getWatermark();
  if (!watermark) {
    preview.innerHTML = '<span>未导入水印</span>';
    removeButton.disabled = true;
    return;
  }
  preview.innerHTML = '';
  const image = document.createElement('img');
  image.src = localFileUrl(watermark.path);
  image.alt = watermark.filename;
  preview.appendChild(image);
  removeButton.disabled = false;
}

document.getElementById('btn-import-watermark').addEventListener('click', async () => {
  const button = document.getElementById('btn-import-watermark');
  button.disabled = true;
  button.textContent = '导入中...';
  const result = await api.importWatermarkDialog();
  button.disabled = false;
  button.textContent = '一键导入水印';
  if (!result.ok) { showToast(result.error || '导入失败'); return; }
  if (result.imported) {
    await refreshWatermark();
    showToast('水印已导入', 'success');
  }
});

document.getElementById('btn-remove-watermark').addEventListener('click', async () => {
  if (!confirm('确定移除当前水印？已经生成的照片副本不会被删除。')) return;
  await api.removeWatermark();
  await refreshWatermark();
  showToast('水印已移除', 'success');
});

// --- AI scene recognition settings ---
let aiProviderList = [];
let aiKeyStored = false;

function aiEl(id) {
  return document.getElementById(id);
}

function currentAiProvider() {
  const id = aiEl('ai-provider-select').value;
  return aiProviderList.find(item => item.id === id) || aiProviderList[0] || null;
}

function updateAiHint() {
  const hint = aiEl('ai-hint');
  const provider = currentAiProvider();
  if (!hint || !provider) return;
  const parts = [`${provider.label} · ${aiKeyStored ? '已保存密钥' : '尚未配置密钥'}`];
  if (provider.hint) parts.push(provider.hint);
  hint.textContent = parts.join(' — ');
}

function applyAiProviderDefaults() {
  const provider = currentAiProvider();
  if (!provider) return;
  aiEl('ai-model-input').value = provider.defaultModel || '';
  aiEl('ai-base-url-input').value = provider.baseUrl || '';
  aiEl('ai-key-input').placeholder = aiKeyStored ? '已保存，留空则保持不变' : '请输入 API Key';
  updateAiHint();
}

function collectAiConfig() {
  return {
    provider: aiEl('ai-provider-select').value,
    model: aiEl('ai-model-input').value.trim(),
    baseUrl: aiEl('ai-base-url-input').value.trim(),
    prompt: aiEl('ai-prompt-input').value.trim(),
    apiKey: aiEl('ai-key-input').value.trim()
  };
}

async function loadAiSettings(force = false) {
  if (!aiEl('ai-provider-select')) return;
  if (force || !aiProviderList.length) {
    aiProviderList = await api.getAiProviders();
    aiEl('ai-provider-select').innerHTML = aiProviderList
      .map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`)
      .join('');
  }
  const config = await api.getAiConfig();
  aiKeyStored = Boolean(config.hasKey);
  aiEl('ai-provider-select').value = config.provider || 'gemini';
  aiEl('ai-model-input').value = config.model || '';
  aiEl('ai-base-url-input').value = config.baseUrl || '';
  aiEl('ai-prompt-input').value = config.prompt || '';
  aiEl('ai-key-input').value = '';
  aiEl('ai-key-input').placeholder = aiKeyStored ? '已保存，留空则保持不变' : '请输入 API Key';
  updateAiHint();
}

aiEl('ai-provider-select')?.addEventListener('change', applyAiProviderDefaults);

aiEl('btn-save-ai')?.addEventListener('click', async () => {
  const config = collectAiConfig();
  if (!config.apiKey && !aiKeyStored) {
    showToast('请先填写 API Key', 'error');
    return;
  }
  if (!config.apiKey && aiKeyStored) config.apiKey = '********';
  const result = await api.saveAiConfig(config);
  if (result?.ok) {
    aiKeyStored = true;
    aiEl('ai-key-input').value = '';
    showToast('AI 设置已保存', 'success');
    updateAiHint();
  }
});

aiEl('btn-test-ai')?.addEventListener('click', async () => {
  const button = aiEl('btn-test-ai');
  button.disabled = true;
  button.textContent = '测试中…';
  try {
    const result = await api.testAiConfig();
    if (result?.ok) showToast('连接成功，返回：' + result.sample, 'success', 6000);
    else showToast('连接失败：' + (result?.error || '未知错误'), 'error', 8000);
  } catch (err) {
    showToast('连接失败：' + err.message, 'error', 8000);
  } finally {
    button.disabled = false;
    button.textContent = '测试连接';
  }
});

aiEl('btn-clear-ai-key')?.addEventListener('click', async () => {
  if (!aiKeyStored) { showToast('当前没有已保存的密钥', 'info'); return; }
  if (!confirm('确定清除已保存的 API Key？清除后需要重新填写才能识别。')) return;
  const config = collectAiConfig();
  config.apiKey = '';
  const result = await api.saveAiConfig(config);
  if (result?.ok) {
    aiKeyStored = false;
    aiEl('ai-key-input').value = '';
    showToast('密钥已清除', 'success');
    updateAiHint();
  }
});

// --- Stats ---
async function updateStats() {
  const stats = await api.getStats();
  document.getElementById('stat-total').textContent = `${stats.total} 张照片`;
}

// --- Utils ---
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 ** 3) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 ** 3)).toFixed(2) + ' GB';
}

// --- Batch Operations ---
document.getElementById('btn-batch-clear').addEventListener('click', () => {
  clearSelection();
});

document.getElementById('btn-select-all').addEventListener('click', selectAllCurrentResults);
document.getElementById('btn-batch-select-all').addEventListener('click', selectAllCurrentResults);
document.getElementById('btn-compare').addEventListener('click', openComparison);
document.getElementById('btn-close-compare').addEventListener('click', () => document.getElementById('compare-modal').classList.add('hidden'));
document.getElementById('compare-modal').addEventListener('click', event => {
  if (event.target === event.currentTarget) event.currentTarget.classList.add('hidden');
});
document.getElementById('btn-save-search').addEventListener('click', async () => {
  const name = prompt('为当前搜索输入名称：');
  if (name === null) return;
  const result = await api.saveSavedSearch(name, currentGalleryQuery);
  if (!result?.ok) { showToast('保存搜索失败：' + (result?.error || '未知错误'), 'error'); return; }
  await loadSavedSearches();
  document.getElementById('saved-search-select').value = String(result.id);
  showToast('搜索已保存', 'success');
});
document.getElementById('saved-search-select').addEventListener('change', (event) => {
  const search = savedSearches.find(item => String(item.id) === event.target.value);
  if (search) applySavedSearch(search);
});
document.getElementById('btn-delete-saved-search').addEventListener('click', async () => {
  const select = document.getElementById('saved-search-select');
  const id = Number(select.value);
  if (!id) { showToast('请先选择一个保存的搜索'); return; }
  const search = savedSearches.find(item => item.id === id);
  if (!confirm(`删除保存的搜索“${search?.name || ''}”？`)) return;
  const result = await api.deleteSavedSearch(id);
  if (result?.ok) { await loadSavedSearches(); showToast('保存的搜索已删除', 'success'); }
  else showToast('删除失败：找不到该保存搜索', 'error');
});

document.getElementById('btn-batch-ai-tag').addEventListener('click', async () => {
  const ids = [...selectedIds];
  if (!ids.length) return;
  const btn = document.getElementById('btn-batch-ai-tag');
  await api.jobStart('ai-tags', { ids });
  showToast(`已创建 AI 标签任务（${ids.length} 张）`);
  void btn;
});
document.getElementById('btn-batch-xmp').addEventListener('click', async () => {
  const ids = [...selectedIds];
  if (!ids.length) { showToast('请先选择照片'); return; }
  const result = await api.syncXmp(ids);
  if (result?.ok) showToast(`已创建 XMP 写入任务（${ids.length} 张）`, 'success');
  else showToast('XMP 写入失败：' + (result?.error || '未知错误'), 'error');
});

document.getElementById('btn-close-batch-edit').addEventListener('click', () => {
  document.getElementById('batch-edit-modal').classList.add('hidden');
});

document.getElementById('btn-apply-batch-edit').addEventListener('click', async () => {
  const ids = [...selectedIds];
  const presetId = Number(document.getElementById('batch-preset-select').value || 0);
  if (!ids.length) { showToast('请先选择照片'); return; }
  if (!presetId) { showToast('请先导入并选择预设'); return; }

  const button = document.getElementById('btn-apply-batch-edit');
  const progress = document.getElementById('batch-edit-progress');
  button.disabled = true;
  progress.classList.remove('hidden');
  let done = 0;
  let failed = 0;
  for (const id of ids) {
    progress.textContent = `正在处理 ${done + failed + 1} / ${ids.length}`;
    const result = await api.applyPhotoEdit(id, presetId, Number(document.getElementById('batch-edit-strength').value));
    if (result.ok) done++; else failed++;
  }
  button.disabled = false;
  progress.textContent = `完成：成功 ${done} 张${failed ? `，失败 ${failed} 张` : ''}`;
  showToast(`批量修图完成：成功 ${done} 张`, 'success');
  loadPhotos();
});

let watermarkBusy = false;
async function applyWatermarks(ids, source = 'batch') {
  if (watermarkBusy) return;
  const targets = Array.from(new Set((Array.isArray(ids) ? ids : [...ids]).map(Number).filter(Boolean)));
  if (!targets.length) { showToast(source === 'batch' ? '请先用 Ctrl+点击 选择照片' : '请先选择照片'); return; }

  const buttons = [
    document.getElementById('btn-apply-watermark'),
    document.getElementById('btn-batch-watermark')
  ].filter(Boolean);
  watermarkBusy = true;
  try {
    await api.jobStart('watermark', { ids: targets });
    showToast(`水印任务已加入队列（${targets.length} 张），原图不会修改`);
    if (source === 'batch') selectedIds.clear();
    updateBatchBar();
  } catch (error) {
    showToast('创建水印任务失败：' + error.message);
  } finally {
    watermarkBusy = false;
    buttons.forEach(button => { button.disabled = false; });
  }
}

api.onWatermarkProgress(data => {
  const text = `加水印 ${data.processed}/${data.total}`;
  ['btn-apply-watermark', 'btn-batch-watermark'].forEach(id => {
    const button = document.getElementById(id);
    if (button && watermarkBusy) button.textContent = text;
  });
});

document.getElementById('btn-apply-watermark').addEventListener('click', () => applyWatermarks([...selectedIds]));

// --- Compression ---
function compressionOptions() {
  const quality = Number(document.getElementById('compression-quality').value || 82);
  return {
    quality,
    maxEdge: Number(document.getElementById('compression-max-edge').value || 4096)
  };
}

let compressionBusy = false;
async function applyCompressions(ids, source = 'batch') {
  if (compressionBusy) return;
  const targets = Array.from(new Set((Array.isArray(ids) ? ids : [...ids]).map(Number).filter(Boolean)));
  if (!targets.length) { showToast(source === 'batch' ? '请先用 Ctrl+点击 选择照片' : '请先选择照片'); return; }

  const buttons = [
    document.getElementById('btn-apply-compression'),
    document.getElementById('btn-compress-photo')
  ].filter(Boolean);
  compressionBusy = true;
  try {
    await api.jobStart('compression', { ids: targets, options: compressionOptions() });
    api.saveAppSetting('compressionOptions', JSON.stringify(compressionOptions()));
    showToast(`压缩任务已加入队列（${targets.length} 张），原图不会修改`);
    if (source === 'batch') {
      selectedIds.clear();
      document.querySelectorAll('.photo-card.selected').forEach(card => card.classList.remove('selected'));
    }
    updateBatchBar();
    return { ok: true };
  } catch (error) {
    showToast('压缩失败：' + error.message);
    return { ok: false, error: error.message };
  } finally {
    compressionBusy = false;
    buttons.forEach(button => { button.disabled = false; });
  }
}

document.getElementById('compression-quality').addEventListener('input', (e) => {
  document.getElementById('compression-quality-value').textContent = `${e.target.value}%`;
});

document.getElementById('btn-apply-compression').addEventListener('click', () => applyCompressions([...selectedIds]));

api.onCompressionProgress(data => {
  const text = `压缩 ${data.processed}/${data.total}`;
  ['btn-apply-compression', 'btn-compress-photo'].forEach(id => {
    const button = document.getElementById(id);
    if (button && compressionBusy) button.textContent = text;
  });
});

// --- Lightbox ---
async function openLightbox(photoId) {
  if (!currentPhotoList.some(photo => photo.id === photoId)) {
    currentPhotoList = await api.getPhotos({ offset: 0, limit: 5000 });
  }
  lightboxIndex = currentPhotoList.findIndex(p => p.id === photoId);
  if (lightboxIndex < 0) return;
  showLightboxImage();
}

function showLightboxImage() {
  const token = ++lightboxLoadToken;
  const lb = document.getElementById('lightbox');
  const img = document.getElementById('lightbox-img');
  const photo = currentPhotoList[lightboxIndex];
  if (!photo) return;
  if (photo.thumb_path) img.src = localFileUrl(photo.thumb_path);
  api.getDisplayPhoto(photo.id, true).then(displayPath => {
    if (!displayPath || token !== lightboxLoadToken) return;
    const ready = new Image();
    ready.src = localFileUrl(displayPath);
    const swap = () => {
      if (token === lightboxLoadToken) img.src = localFileUrl(displayPath);
    };
    if (ready.decode) ready.decode().then(swap).catch(() => { ready.onload = swap; });
    else ready.onload = swap;
  });
  document.getElementById('lb-filename').textContent = photo.filename;
  document.getElementById('lb-counter').textContent = `${lightboxIndex + 1} / ${currentPhotoList.length}`;
  lb.classList.remove('hidden');
  if (typeof resetLbZoom === 'function') resetLbZoom();
  preloadAdjacent();
}

// Preload adjacent lightbox images
function preloadAdjacent() {
  if (!currentPhotoList.length) return;
  const next = currentPhotoList[(lightboxIndex + 1) % currentPhotoList.length];
  const prev = currentPhotoList[(lightboxIndex - 1 + currentPhotoList.length) % currentPhotoList.length];
  setTimeout(() => {
    [prev, next].forEach(photo => {
      if (photo?.id) api.getDisplayPhoto(photo.id, true, 'low');
    });
  }, 600);
}

function navigateLightbox(delta) {
  lightboxIndex += delta;
  if (lightboxIndex < 0) lightboxIndex = currentPhotoList.length - 1;
  if (lightboxIndex >= currentPhotoList.length) lightboxIndex = 0;
  showLightboxImage();
}

document.querySelector('.lb-close').addEventListener('click', () => {
  document.getElementById('lightbox').classList.add('hidden');
});
document.querySelector('.lb-prev').addEventListener('click', () => navigateLightbox(-1));
document.querySelector('.lb-next').addEventListener('click', () => navigateLightbox(1));
document.getElementById('lightbox').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.target.classList.add('hidden');
});

document.addEventListener('keydown', (e) => {
  const lb = document.getElementById('lightbox');
  const detailModal = document.getElementById('photo-modal');
  const slideOverlay = document.getElementById('slideshow-overlay');

  // Keep arrow keys usable inside form controls without hijacking them globally.
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.target.isContentEditable) return;

  if (e.key === 'Escape') {
    if (!detailModal.classList.contains('hidden')) {
      detailModal.classList.add('hidden');
    } else if (!lb.classList.contains('hidden')) {
      lb.classList.add('hidden');
      resetLbZoom();
    } else if (slideshowActive) {
      stopSlideshow();
    }
  }
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    if (!detailModal.classList.contains('hidden')) navigateDetail(-1);
    else if (!lb.classList.contains('hidden')) navigateLightbox(-1);
    else if (slideshowActive) {
      slideshowIndex = (slideshowIndex - 2 + currentPhotoList.length * 2) % currentPhotoList.length;
      nextSlide();
    }
  }
  if (e.key === 'ArrowRight') {
    e.preventDefault();
    if (!detailModal.classList.contains('hidden')) navigateDetail(1);
    else if (!lb.classList.contains('hidden')) navigateLightbox(1);
    else if (slideshowActive) nextSlide();
  }
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
      (!detailModal.classList.contains('hidden') || !lb.classList.contains('hidden'))) {
    e.preventDefault();
    const delta = e.key === 'ArrowUp' ? -1 : 1;
    if (!detailModal.classList.contains('hidden')) navigateDetail(delta);
    else navigateLightbox(delta);
  }
});

// --- Scroll Wheel Zoom (Lightbox + Detail Modal) ---
let lbZoom = 1;
let lbPanX = 0, lbPanY = 0;
let isDragging = false;
let dragStartX = 0, dragStartY = 0;

function resetLbZoom() {
  lbZoom = 1; lbPanX = 0; lbPanY = 0;
  applyLbTransform();
}

function applyLbTransform() {
  const img = document.getElementById('lightbox-img');
  if (!img) return;
  img.style.transform = `scale(${lbZoom}) translate(${lbPanX}px, ${lbPanY}px)`;
  img.style.cursor = lbZoom > 1 ? 'grab' : '';
}

document.getElementById('lightbox').addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = document.getElementById('lightbox-img').getBoundingClientRect();
  const cx = e.clientX - rect.left - rect.width / 2;
  const cy = e.clientY - rect.top - rect.height / 2;
  const oldZoom = lbZoom;
  lbZoom *= e.deltaY < 0 ? 1.15 : 0.87;
  lbZoom = Math.max(1, Math.min(lbZoom, 8));
  // Zoom toward cursor position
  if (lbZoom > 1 && oldZoom > 1) {
    const scaleChange = lbZoom / oldZoom;
    lbPanX = cx + (lbPanX - cx) * scaleChange;
    lbPanY = cy + (lbPanY - cy) * scaleChange;
  }
  if (lbZoom === 1) { lbPanX = 0; lbPanY = 0; }
  applyLbTransform();
}, { passive: false });

// Drag to pan when zoomed
const lightboxEl = document.getElementById('lightbox');
lightboxEl.addEventListener('mousedown', (e) => {
  if (lbZoom <= 1) return;
  if (e.target.closest('.lb-btn')) return;
  isDragging = true;
  dragStartX = e.clientX - lbPanX;
  dragStartY = e.clientY - lbPanY;
  document.getElementById('lightbox-img').style.cursor = 'grabbing';
});
document.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  lbPanX = e.clientX - dragStartX;
  lbPanY = e.clientY - dragStartY;
  applyLbTransform();
});
document.addEventListener('mouseup', () => {
  if (isDragging) {
    isDragging = false;
    document.getElementById('lightbox-img').style.cursor = lbZoom > 1 ? 'grab' : '';
  }
});

// Detail modal zoom (simpler)
let detailZoom = 1;
const detailPanel = document.querySelector('.modal-image-panel');
detailPanel.addEventListener('wheel', (e) => {
  e.preventDefault();
  detailZoom *= e.deltaY < 0 ? 1.15 : 0.87;
  detailZoom = Math.max(1, Math.min(detailZoom, 6));
  if (detailZoom === 1) detailZoom = 1;
  const img = document.getElementById('detail-img');
  if (img) img.style.transform = `scale(${detailZoom})`;
}, { passive: false });

// Detail modal drag-to-pan
let dPanX = 0, dPanY = 0;
let dDragging = false;
let dStartX = 0, dStartY = 0;

function applyDetailTransform() {
  const img = document.getElementById('detail-img');
  if (!img) return;
  img.style.transform = `scale(${detailZoom}) translate(${dPanX}px, ${dPanY}px)`;
  img.style.cursor = detailZoom > 1 ? 'grab' : '';
}

detailPanel.addEventListener('mousedown', (e) => {
  if (detailZoom <= 1) return;
  if (e.target.closest('button')) return;
  dDragging = true;
  dStartX = e.clientX - dPanX;
  dStartY = e.clientY - dPanY;
  document.getElementById('detail-img').style.cursor = 'grabbing';
});
document.addEventListener('mousemove', (e) => {
  if (!dDragging) return;
  dPanX = e.clientX - dStartX;
  dPanY = e.clientY - dStartY;
  applyDetailTransform();
});
document.addEventListener('mouseup', () => {
  if (dDragging) {
    dDragging = false;
    const img = document.getElementById('detail-img');
    if (img) img.style.cursor = detailZoom > 1 ? 'grab' : '';
  }
});

// --- AI Tag in Detail Modal ---
document.getElementById('btn-ai-tag').addEventListener('click', async function() {
  const tagsInput = document.getElementById('detail-tags-input');
  const photoId = parseInt(tagsInput.dataset.photoId);
  if (!photoId) return;

  const btn = this;
  btn.disabled = true;
  btn.textContent = '✨ AI 分析中...';
  const result = await api.aiTagSingle(photoId);
  btn.disabled = false;
  btn.textContent = '✨ AI 自动打标签';
  if (result.ok) {
    tagsInput.value = result.tags;
  } else {
    showToast(result.error);
  }
});

// --- Zoom Controls ---
let currentZoomLevel = 2; // 0=small 1=medium 2=large
const zoomSizes = [120, 180, 260];

function applyZoom() {
  const grid = document.getElementById('photo-grid');
  if (grid) grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${zoomSizes[currentZoomLevel]}px, 1fr))`;
}

document.getElementById('btn-zoom-in').addEventListener('click', () => {
  if (currentZoomLevel < zoomSizes.length - 1) { currentZoomLevel++; applyZoom(); }
});
document.getElementById('btn-zoom-out').addEventListener('click', () => {
  if (currentZoomLevel > 0) { currentZoomLevel--; applyZoom(); }
});

// --- Fix Missing Thumbnails ---
document.getElementById('btn-fix-thumbs').addEventListener('click', async function() {
  const btn = this;
  btn.disabled = true;
  btn.textContent = '修复中...';
  api.onFixProgress(data => {
    btn.textContent = `已修复 ${data.fixed} 张...`;
  });
  const result = await api.fixMissingThumbs();
  btn.disabled = false;
  btn.textContent = '修复缩略图';
  if (result.ok) {
    showToast(`完成！修复了 ${result.fixed}/${result.total} 张缺失缩略图。`);
    if (result.fixed > 0) loadPhotos();
  }
});
// --- Right-click Context Menu ---
let ctxTargetPhoto = null;

function showContextMenu(e, photo) {
  ctxTargetPhoto = photo;
  const menu = document.getElementById('ctx-menu');
  menu.classList.remove('hidden');
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let x = e.clientX, y = e.clientY;
  if (x + mw > window.innerWidth) x = window.innerWidth - mw - 8;
  if (y + mh > window.innerHeight) y = window.innerHeight - mh - 8;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
}

document.addEventListener('click', () => {
  document.getElementById('ctx-menu').classList.add('hidden');
});

document.querySelectorAll('#ctx-menu .ctx-item').forEach(item => {
  item.addEventListener('click', async (e) => {
    e.stopPropagation();
    document.getElementById('ctx-menu').classList.add('hidden');
    if (!ctxTargetPhoto) return;
    const action = item.dataset.action;
    const photo = ctxTargetPhoto;

    switch (action) {
      case 'open':
        openPhotoDetail(photo.id);
        break;
      case 'star': {
        await api.toggleStar(photo.id);
        loadPhotos();
        break;
      }
      case 'watermark':
        await applyWatermarks([photo.id], 'context');
        break;
      case 'compress':
        await applyCompressions([photo.id], 'context');
        break;
      case 'locate':
        api.showInFolder(photo.path);
        break;
      case 'delete-lib':
        if (confirm('确定从照片库中移除这张照片？（不会删除磁盘文件）')) {
          await api.deletePhoto(photo.id);
          loadPhotos();
          updateStats();
        }
        break;
      case 'delete-disk':
        if (confirm('⚠️ 确定从磁盘永久删除这张照片？\n此操作不可恢复！\n\n文件：' + photo.filename)) {
          await api.deletePhotoDisk(photo.id);
          loadPhotos();
          updateStats();
        }
        break;
    }
  });
});

// --- Travel Route Lines on Map ---
async function showTravelRoutes(dayKey) {
  if (!photoMap) return;
  const points = await api.getTravelRoutes(dayKey);
  if (points.length < 2) return;
  const latlngs = points.map(p => [p.gps_lat, p.gps_lon]);
  L.polyline(latlngs, { color: '#58a6ff', weight: 2, opacity: 0.7, dashArray: '5,5' }).addTo(photoMap);
}

// --- Location Groups ---
async function showLocationGroups() {
  const groups = await api.getLocationGroups();
  return groups;
}

// --- Slideshow Mode ---
let slideshowTimer = null;
let slideshowActive = false;
let slideshowIndex = 0;

async function startSlideshow() {
  const slideFilter = document.getElementById("filter-select")?.value || "";
const slideSearch = document.getElementById("search-input")?.value || "";
const dateFromEl = document.getElementById("date-from");
const dateToEl = document.getElementById("date-to");
currentPhotoList = await api.getPhotos({
  offset: 0, limit: 500,
  sortBy: document.getElementById("sort-select")?.value || "date_taken",
  sortDir: "DESC",
  filter: slideFilter, searchQuery: slideSearch,
  dateFrom: dateFromEl?.value || "", dateTo: dateToEl?.value || ""
});
  if (!currentPhotoList.length) { showToast("没有照片"); return; }
  slideshowActive = true;
  slideshowIndex = 0;
  document.getElementById('slideshow-overlay').classList.remove('hidden');
  nextSlide();
  slideshowTimer = setInterval(nextSlide, 4000);
}

function nextSlide() {
  const img = document.getElementById('slideshow-img');
  if (!img || !slideshowActive) return;
  const photo = currentPhotoList[slideshowIndex % currentPhotoList.length];
  const rawExts = ['.nef','.cr2','.cr3','.arw','.dng'];
  const isRaw = rawExts.includes((photo.ext||'').toLowerCase());
  if (isRaw && photo.thumb_path) img.src = 'file:///' + photo.thumb_path.replace(/\\/g, '/');
  else img.src = 'file:///' + photo.path.replace(/\\/g, '/');
  img.style.opacity = '1';
  slideshowIndex++;
}

function stopSlideshow() {
  slideshowActive = false;
  if (slideshowTimer) clearInterval(slideshowTimer);
  slideshowTimer = null;
  document.getElementById('slideshow-overlay').classList.add('hidden');
}

// --- Statistics View ---
async function loadStatistics() {
  let stats;
  try {
    stats = await api.getStatistics();
  } catch (error) {
    showToast('统计加载失败：' + error.message);
    return;
  }
  stats.monthly = stats.monthly || [];
  stats.cameras = stats.cameras || [];
  const summary = document.getElementById('stats-summary');
  summary.innerHTML = '';
  const cards = [
    { num: stats.total, label: '总照片数' },
    { num: stats.withGps, label: '有GPS' },
    { num: stats.starred, label: '已标星' },
    { num: stats.cameras.length, label: '相机设备' }
  ];
  for (const c of cards) {
    summary.innerHTML += '<div class="stat-card"><div class="num">' + c.num + '</div><div class="label">' + c.label + '</div></div>';
  }
  // Monthly bar chart
  const chart = document.getElementById('stats-monthly');
  chart.innerHTML = '';
  const monthly = stats.monthly.slice(0, 12).reverse();
  if (!monthly.length) {
    const empty = document.createElement('p');
    empty.className = 'stats-empty';
    empty.textContent = '没有可用的拍摄日期';
    chart.appendChild(empty);
  }
  const maxCount = Math.max(...monthly.map(m => m[1]), 1);
  for (const m of monthly) {
    const count = Number(m[1]) || 0;
    const height = Math.max(4, Math.round((count / maxCount) * 110));
    const col = document.createElement('div');
    col.className = 'bar-col';
    col.title = `${m[0]}：${count.toLocaleString()} 张`;

    const value = document.createElement('div');
    value.className = 'bar-value';
    value.textContent = count.toLocaleString();

    const bar = document.createElement('div');
    bar.className = 'bar-rect';
    bar.style.height = `${height}px`;

    const label = document.createElement('div');
    label.className = 'bar-label';
    label.textContent = m[0];

    col.append(value, bar, label);
    chart.appendChild(col);
  }
  renderStatRows('stats-cameras', stats.cameras, '暂无相机信息');
  renderStatRows('stats-lenses', stats.lenses, '暂无镜头信息');
  renderFocalChart(stats.focalLengths || []);
  renderStatRows('stats-apertures', stats.apertures, '暂无光圈信息');
  renderLocationRows(stats.locations || []);
}

function renderStatRows(containerId, rows, emptyText) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  if (!rows?.length) {
    container.innerHTML = `<p class="stats-empty">${escapeHtml(emptyText)}</p>`;
    return;
  }
  for (const [name, count] of rows) {
    container.innerHTML += `<div class="cam-row"><span>${escapeHtml(name || '未知')}</span><span>${Number(count).toLocaleString()} 张</span></div>`;
  }
}

function renderFocalChart(rows) {
  const chart = document.getElementById('stats-focal-lengths');
  chart.innerHTML = '';
  if (!rows.length) {
    chart.innerHTML = '<p class="stats-empty">没有焦距数据</p>';
    return;
  }
  const maxCount = Math.max(...rows.map(([, count]) => Number(count)), 1);
  for (const [focal, count] of rows) {
    const col = document.createElement('div');
    col.className = 'bar-col';
    col.title = `${focal}mm：${count} 张`;
    col.innerHTML = `
      <div class="bar-value">${count}</div>
      <div class="bar-rect" style="height:${Math.max(4, Math.round(count / maxCount * 110))}px"></div>
      <div class="bar-label">${focal}mm</div>
    `;
    chart.appendChild(col);
  }
}

function renderLocationRows(rows) {
  const container = document.getElementById('stats-locations');
  container.innerHTML = '';
  if (!rows.length) {
    container.innerHTML = '<p class="stats-empty">没有 GPS 位置聚合</p>';
    return;
  }
  for (const [location, count] of rows) {
    const [lat, lon] = String(location).split(',');
    container.innerHTML += `<div class="cam-row"><span title="${lat}, ${lon}">${lat}°, ${lon}° 附近</span><span>${Number(count).toLocaleString()} 张</span></div>`;
  }
}

// --- Recycle Bin ---
async function openRecycleBin() {
  const modal = document.getElementById('recycle-modal');
  const list = document.getElementById('recycle-list');
  modal.classList.remove('hidden');
  const deleted = await api.getDeletedPhotos();
  if (!deleted.length) { list.innerHTML = '<p style="color:var(--text-secondary);margin-top:12px">回收站是空的</p>'; return; }
  list.innerHTML = '';
  for (const d of deleted) {
    const row = document.createElement('div');
    row.className = 'cam-row';
    row.innerHTML = '<span>' + escapeHtml(d.filename) + '</span>';
    const btn = document.createElement('button');
    btn.className = 'btn-secondary';
    btn.textContent = '恢复';
    btn.addEventListener('click', async () => {
      await api.restorePhoto(d.id);
      row.remove();
      loadPhotos();
    });
    row.appendChild(btn);
    list.appendChild(row);
  }
}

// --- Keyboard Shortcuts ---
document.addEventListener('keydown', (e) => {
  // Skip if typing in an input
  if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(e.target.tagName) || e.target.isContentEditable) return;

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && currentView === 'library') {
    e.preventDefault();
    void selectAllCurrentResults();
    return;
  }
  
  // Space in library view -> toggle star of selected/last photo
  if (e.key === ' ' && currentView === 'library') {
    e.preventDefault();
    if (selectedIds.size === 1) {
      api.toggleStar([...selectedIds][0]).then(() => loadPhotos());
    }
  }
  // Slideshow pause/resume with space
  if (e.key === ' ' && slideshowActive) {
    e.preventDefault();
    if (slideshowTimer) { clearInterval(slideshowTimer); slideshowTimer = null; }
    else { slideshowTimer = setInterval(nextSlide, 4000); }
  }

  // Delete key -> soft delete selected
  if (e.key === 'Delete' && selectedIds.size > 0) {
    if (confirm('将选中的 ' + selectedIds.size + ' 张照片移入回收站？')) {
      Promise.all([...selectedIds].map(id => api.softDeletePhoto(id))).then(() => {
        selectedIds.clear();
        loadPhotos();
        updateStats();
      });
    }
  }
});

document.getElementById('btn-slideshow').addEventListener('click', () => {
  if (selectedIds.size > 0) {
    const sel = new Set(selectedIds);
    currentPhotoList = currentPhotoList.filter(p => sel.has(p.id));
  }
  startSlideshow();
});
document.getElementById('btn-export').addEventListener('click', async () => {
  if (selectedIds.size === 0) { showToast('请先选中要导出的照片'); return; }
  const result = await api.exportHtml([...selectedIds]);
  if (result.ok) showToast('导出完成！' + result.filePath);
});
document.getElementById('btn-recycle').addEventListener('click', openRecycleBin);


// --- GPS Correction ---
document.getElementById('btn-save-gps').addEventListener('click', async () => {
  const lat = parseFloat(document.getElementById('gps-lat-input').value);
  const lon = parseFloat(document.getElementById('gps-lon-input').value);
  const tagsInput = document.getElementById('detail-tags-input');
  const photoId = parseInt(tagsInput.dataset.photoId);
  if (!photoId || isNaN(lat) || isNaN(lon)) { showToast('请填写有效的经纬度'); return; }
  await api.setGps(photoId, lat, lon);
  document.getElementById('btn-save-gps').textContent = '✅ 已保存';
  setTimeout(() => document.getElementById('btn-save-gps').textContent = '📍 保存坐标', 2000);
});

// --- Burst Detection ---
document.getElementById('btn-bursts').addEventListener('click', async () => {
  const bursts = await api.findBursts();
  if (!bursts.length) { showToast('未检测到连拍照片'); return; }
  let msg = '发现 ' + bursts.length + ' 组疑似连拍：\n\n';
  bursts.slice(0, 10).forEach(b => {
    msg += b.aName + ' ↔ ' + b.bName + '\n';
  });
  msg += '\n在图库中按 Ctrl+点击选中要删除的，然后右键删除。';
  showToast(msg);
});

// --- Load AI + watermark settings when the Settings view opens ---
document.querySelector('[data-view="settings"]').addEventListener('click', async () => {
  setTimeout(async () => {
    await loadAiSettings();
    await refreshWatermark();
  }, 100);
});
document.getElementById('btn-batch-star').addEventListener('click', async () => {
  for (const id of selectedIds) { await api.toggleStar(id); }
  showToast('\u2b50 \u5df2\u6807\u661f ' + selectedIds.size + ' \u5f20', 'success');
  loadPhotos();
});
document.getElementById('btn-batch-soft-del').addEventListener('click', async () => {
  if (!confirm('\u5c06\u9009\u4e2d\u7684 ' + selectedIds.size + ' \u5f20\u79fb\u5165\u56de\u6536\u7ad9\uff1f')) return;
  for (const id of selectedIds) { await api.softDeletePhoto(id); }
  showToast('\u2713 \u5df2\u79fb\u5165\u56de\u6536\u7ad9', 'success');
  selectedIds.clear();
  document.querySelectorAll('.photo-card.selected').forEach(c => c.classList.remove('selected'));
  updateBatchBar();
  loadPhotos();
});

// --- Infinite Scroll ---
let isLoadingMore = false;
document.getElementById('main-content').addEventListener('scroll', async (e) => {
  if (currentView !== 'library' || isLoadingMore) return;
  isLoadingMore = true;
  try { await renderGalleryWindow(); } finally { isLoadingMore = false; }
});

// --- Drag & Drop Folder Scan ---
let dragCounter = 0;
document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragCounter++;
  document.getElementById('drop-overlay').classList.remove('hidden');
});
document.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    document.getElementById('drop-overlay').classList.add('hidden');
  }
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragCounter = 0;
  document.getElementById('drop-overlay').classList.add('hidden');
  const files = e.dataTransfer.files;
  if (!files.length) return;
  const folderPath = files[0].path;
  if (!folderPath) return;
  scanFolderPath = folderPath;
  document.getElementById('scan-modal').classList.remove('hidden');
});



// Lazy thumbnail observer
const thumbObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const img = entry.target;
      if (img.dataset.src) {
        img.src = img.dataset.src;
        delete img.dataset.src;
        thumbObserver.unobserve(img);
      }
    }
  });
}, { rootMargin: '200px' });


// --- More Dropdown Menu ---
document.getElementById('btn-more-menu').addEventListener('click', (e) => {
  e.stopPropagation();
  const dd = document.getElementById('more-dropdown');
  dd.classList.toggle('hidden');
});
document.addEventListener('click', () => {
  document.getElementById('more-dropdown').classList.add('hidden');
});

// --- Settings Persistence ---
async function restoreSettings() {
  const s = await api.getAppSettings();
  if (s.lastView) switchView(s.lastView);
  if (s.sortOrder) { const el = document.getElementById('sort-select'); if (el) el.value = s.sortOrder; }
  if (s.zoomLevel) { currentZoomLevel = parseInt(s.zoomLevel); applyZoom(); }
  try {
    const compression = JSON.parse(s.compressionOptions || 'null');
    if (compression) {
      document.getElementById('compression-quality').value = compression.quality || 82;
      document.getElementById('compression-quality-value').textContent = `${compression.quality || 82}%`;
      document.getElementById('compression-max-edge').value = String(compression.maxEdge ?? 4096);
    }
  } catch {}
  await loadPhotos({ sortBy: s.sortOrder });
  await loadSavedSearches();
  await loadAiSettings().catch(err => console.warn('AI 设置读取失败', err));
}

function saveSettings() {
  api.saveAppSetting('lastView', currentView);
  api.saveAppSetting('sortOrder', document.getElementById('sort-select')?.value || 'date_taken');
  api.saveAppSetting('zoomLevel', String(currentZoomLevel));
}


let renamePreviewTimer = null;
let renameRunning = false;

function renameOptions() {
  const autoSuffix = document.getElementById('rename-conflict-suffix').checked;
  return {
    template: document.getElementById('rename-template').value || '{date}_{seq}',
    sort: document.getElementById('rename-sort').value,
    dateSource: document.getElementById('rename-date-source').value,
    start: parseInt(document.getElementById('rename-start').value || '1', 10),
    padding: parseInt(document.getElementById('rename-padding').value || '4', 10),
    nameCase: document.getElementById('rename-case').value,
    extCase: document.getElementById('rename-ext-case').value,
    spacesToUnderscores: document.getElementById('rename-spaces').checked,
    conflict: autoSuffix ? 'suffix' : 'skip'
  };
}

function renderRenamePreview(data) {
  const list = document.getElementById('rename-preview-list');
  list.innerHTML = data.items.map(item => {
    const statusText = item.status === 'ready' ? '可改名'
      : item.status === 'skipped' ? '同名跳过' : '未变化';
    return `<div class="rename-item">
      <span title="${escapeHtml(item.oldName)}">${escapeHtml(item.oldName)}</span>
      <span>→</span>
      <span title="${escapeHtml(item.newName)}">${escapeHtml(item.newName)}</span>
      <span class="rename-status ${item.status}">${statusText}</span>
    </div>`;
  }).join('');
  document.getElementById('rename-preview-summary').textContent =
    `${data.ready} 张将改名，${data.unchanged} 张不变，${data.skipped} 张跳过`;
}

async function refreshRenamePreview() {
  if (!selectedIds.size || renameRunning) return;
  try {
    const data = await api.previewBatchRename([...selectedIds], renameOptions());
    if (data.ok) renderRenamePreview(data);
  } catch (error) {
    showToast('重命名预览失败：' + error.message);
  }
}

function scheduleRenamePreview() {
  clearTimeout(renamePreviewTimer);
  renamePreviewTimer = setTimeout(refreshRenamePreview, 180);
}

function openBatchRenameModal() {
  if (selectedIds.size === 0) {
    showToast('请先用 Ctrl+点击 选择照片');
    return;
  }
  document.getElementById('rename-count').textContent = `已选 ${selectedIds.size} 张`;
  document.getElementById('rename-modal').classList.remove('hidden');
  refreshRenamePreview();
}

async function executeBatchRename() {
  if (renameRunning || selectedIds.size === 0) return;
  const preview = await api.previewBatchRename([...selectedIds], renameOptions());
  if (!preview.ready) {
    showToast('没有需要修改的文件名');
    return;
  }
  if (!confirm(`准备重命名 ${preview.ready} 张照片，继续执行？`)) return;

  const button = document.getElementById('btn-apply-rename');
  renameRunning = true;
  button.disabled = true;
  button.textContent = '正在重命名...';
  try {
    const result = await api.batchRename([...selectedIds], renameOptions());
    if (result.renamed) showToast(`已重命名 ${result.renamed} 张`, 'success');
    if (result.skipped) showToast(`${result.skipped} 张跳过或失败`);
    if (result.errors?.length) console.warn('批量重命名错误', result.errors);
    document.getElementById('rename-modal').classList.add('hidden');
    selectedIds.clear();
    updateBatchBar();
    await loadPhotos();
    updateStats();
  } catch (error) {
    showToast('批量重命名失败：' + error.message);
  } finally {
    renameRunning = false;
    button.disabled = false;
    button.textContent = '执行重命名';
  }
}

document.getElementById('rename-preset').addEventListener('change', (event) => {
  if (event.target.value !== 'custom') {
    document.getElementById('rename-template').value = event.target.value;
  }
  scheduleRenamePreview();
});
['rename-template', 'rename-start'].forEach(id => {
  document.getElementById(id).addEventListener('input', scheduleRenamePreview);
});
['rename-sort', 'rename-date-source', 'rename-padding', 'rename-case', 'rename-ext-case']
  .forEach(id => document.getElementById(id).addEventListener('change', scheduleRenamePreview));
['rename-spaces', 'rename-conflict-suffix'].forEach(id => {
  document.getElementById(id).addEventListener('change', scheduleRenamePreview);
});

function handleBurstDetection() {
  api.findBursts().then(function(bursts) {
    if (!bursts.length) { showToast("\u672a\u68c0\u6d4b\u5230\u8fde\u62cd"); return; }
    showToast("\u53d1\u73b0 " + bursts.length + " \u7ec4\u8fde\u62cd");
  });
}

function handleFixThumbs() {
  showToast("\u4fee\u590d\u4e2d...");
  api.fixMissingThumbs().then(function(r) {
    if (r.ok) { showToast("\u4fee\u590d\u4e86 " + r.fixed + " \u5f20", "success"); loadPhotos(); }
  });
}

// GLOBAL_BUTTON_DELEGATION
// Fallback: handles all btn-* clicks via delegation
document.addEventListener("click", function(e) {
  var el = e.target.closest("[id]");
  if (!el || !el.id) return;
  var id = el.id;
  switch(id) {
    case 'btn-slideshow':
      if (typeof startSlideshow === "function") startSlideshow();
      break;
    case 'btn-export':
      if (selectedIds.size === 0) { showToast("\u8bf7\u5148\u9009\u4e2d\u8981\u5bfc\u51fa\u7684\u7167\u7247"); break; }
      api.exportHtml(Array.from(selectedIds)).then(function(r) {
        if (r.ok) showToast("\u5bfc\u51fa\u5b8c\u6210", "success");
      });
      break;
    case 'btn-batch-edit':
      if (selectedIds.size === 0) { showToast("请先用 Ctrl+点击 选择照片"); break; }
      refreshPhotoPresets().then(() => {
        document.getElementById('batch-edit-modal').classList.remove('hidden');
      });
      break;
    case 'btn-recycle':
      if (typeof openRecycleBin === "function") openRecycleBin();
      break;
    case 'btn-rename':
      openBatchRenameModal();
      break;
    case 'btn-close-rename':
      document.getElementById('rename-modal').classList.add('hidden');
      break;
    case 'btn-apply-rename':
      executeBatchRename();
      break;
    case 'btn-bursts':
      handleBurstDetection();
      break;
    case 'btn-fix-thumbs':
      handleFixThumbs();
      break;
  }
});


// --- Init ---
bindDetailMetadataControls();
restoreSettings().then(() => {
  updateStats();
});
