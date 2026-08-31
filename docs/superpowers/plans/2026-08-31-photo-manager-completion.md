# PhoneBL/MAP 功能补全实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 `executing-plans` 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 在保留现有 PhoneBL 核心功能的前提下，完成七项未完成功能，并实现当前筛选结果跨分页的“全选”和 Windows `Ctrl+A`。

**架构：** 将照片过滤条件抽成主进程和测试可复用的查询模块；渲染层维护与 DOM 无关的选择集合和虚拟图库窗口。XMP、旅程分析和 CLIP 分别放入独立模块，通过 preload 暴露窄接口，主进程负责数据库、文件和任务生命周期。

**技术栈：** Electron 41、Node.js 内置 `node:sqlite`、ExifTool、Sharp、Leaflet、Node 内置测试运行器；CLIP 使用可选的本地 Transformers/ONNX 适配器，未配置模型时保持普通搜索可用。

---

## 文件变更总览

**创建：**

- `src/photo-query.js`：统一构造照片查询条件、排序和参数。
- `src/selection-model.js`：独立于 DOM 的全选、取消、单项排除状态模型。
- `src/trip-analysis.js`：旅程切分、停留点聚合、GPS 网格聚合。
- `src/clip-search.js`：本地 CLIP 适配器、向量索引和状态管理。
- `tests/photo-query.test.js`：查询一致性与跨分页 ID 测试。
- `tests/selection-model.test.js`：全选、取消全选、单项排除和快捷键边界测试。
- `tests/trip-analysis.test.js`：旅程、停留点和热力网格的固定样例测试。
- `tests/xmp.test.js`：XMP 字段映射、sidecar 路径和失败状态测试。
- `tests/clip-search.test.js`：本地模型状态、索引和无网络调用测试。

**修改：**

- `src/database.js`：补充向量索引表及必要索引；保留已有迁移备份机制。
- `src/metadata.js`：增加 XMP sidecar 字段映射和可注入写入器。
- `main.js`：复用查询构造器，新增全选 ID、保存搜索、XMP、旅程、热力图、比较详情和 CLIP IPC。
- `preload.js`：暴露上述窄接口及任务进度监听。
- `renderer/index.html`：增加全选状态、保存搜索、比较、旅程/停留点、热力图和 CLIP 状态 UI。
- `renderer/style.css`：增加选择态、虚拟滚动占位、比较面板、旅程卡片和热力图控制样式。
- `renderer/app.js`：实现结果集选择、`Ctrl+A`、虚拟图库、保存搜索、XMP 操作、比较和地图/旅程视图。
- `scripts/smoke-ui.js`：增加真实窗口的跨分页全选、快捷键、虚拟 DOM 数量、比较和地图模式检查。
- `tests/run-all.js`：注册新增 Node 测试文件。
- `README.md`：更新功能、快捷键、XMP、旅程、热力图和 CLIP 配置说明。
- `package.json`、`package-lock.json`：加入本地 CLIP 运行依赖和验证脚本需要的文件。

---

### 任务 1：统一查询条件与结果集选择模型

**文件：**

- 创建：`src/photo-query.js`
- 创建：`src/selection-model.js`
- 创建：`tests/photo-query.test.js`
- 创建：`tests/selection-model.test.js`
- 修改：`main.js`
- 修改：`renderer/app.js`
- 修改：`preload.js`
- 修改：`renderer/index.html`
- 修改：`tests/run-all.js`

- [ ] **步骤 1：编写失败的查询测试**

测试 `normalizePhotoQuery()` 对空值、筛选、日期、搜索词和非法排序的归一化；测试 `buildPhotoWhere()` 对 GPS、RAW、评分、日期和关键词生成参数化 SQL 条件。测试 ID 查询和分页查询使用相同条件。

```js
const { normalizePhotoQuery, buildPhotoWhere } = require('../src/photo-query');

test('normalizes the library query and rejects unsafe sort names', () => {
  const query = normalizePhotoQuery({ filter: 'gps', searchQuery: '山', sortBy: 'drop table' });
  assert.deepEqual(query, {
    filter: 'gps', searchQuery: '山', sortBy: 'date_taken', sortDir: 'DESC',
    dateFrom: '', dateTo: ''
  });
});

test('builds identical predicates for paging and select-all', () => {
  const query = normalizePhotoQuery({ filter: '3', dateFrom: '2026-01-01', dateTo: '2026-01-31', searchQuery: '海' });
  const result = buildPhotoWhere(query);
  assert.match(result.sql, /deleted = 0/);
  assert.match(result.sql, /rating >= \?/);
  assert.equal(result.params.at(-1), '%海%');
});
```

- [ ] **步骤 2：运行查询测试确认正确失败**

运行：`node --test tests/photo-query.test.js`  
预期：FAIL，报错 `Cannot find module '../src/photo-query'`。

- [ ] **步骤 3：编写失败的选择模型测试**

测试结果集全选、再次全选清空、单项移除，以及选择集合不依赖已渲染卡片。

```js
const { SelectionModel } = require('../src/selection-model');

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
```

- [ ] **步骤 4：运行选择测试确认正确失败**

运行：`node --test tests/selection-model.test.js`  
预期：FAIL，报错 `Cannot find module '../src/selection-model'`。

- [ ] **步骤 5：实现最小查询和选择模块**

`src/photo-query.js` 导出 `normalizePhotoQuery(query)`、`buildPhotoWhere(query)` 和 `buildPhotoOrder(query)`；所有筛选值使用白名单，用户值通过 SQL 参数传入。`src/selection-model.js` 导出 `SelectionModel`，内部只保存整数 ID，提供 `selectAll(ids)`、`clear()`、`toggle(id)`、`has(id)`、`ids()`、`size()` 和 `isAllSelected()`。

- [ ] **步骤 6：运行查询和选择测试确认通过**

运行：`node --test tests/photo-query.test.js tests/selection-model.test.js`  
预期：全部测试 PASS。

- [ ] **步骤 7：接入主进程和渲染层全选**

在 `main.js` 用 `photo-query.js` 同时改造 `get-photos`、`get-photos-paged` 和新建的 `get-photo-ids`；在 `preload.js` 暴露 `getPhotoIds(query)`。在 `renderer/app.js` 保存 `currentGalleryQuery`，用 `SelectionModel` 替代直接操作卡片；全选按钮通过 ID IPC 获取所有匹配项，`updateBatchBar()` 根据模型状态更新文字和按钮。

在 `renderer/index.html` 的图库工具栏增加 `#btn-select-all`，保留批量栏按钮作为同一动作的第二入口；在 `app.js` 添加 `keydown` 监听，仅当 `currentView === 'library'` 且焦点不在 `input`、`select`、`textarea`、`button` 或 `[contenteditable]` 时处理 `Ctrl+A`。

- [ ] **步骤 8：运行现有测试与语法检查**

运行：`npm run lint; npm test`  
预期：语法检查通过，原有测试和新增查询/选择测试全部通过。

- [ ] **步骤 9：Commit**

```powershell
git add src/photo-query.js src/selection-model.js main.js preload.js renderer/app.js renderer/index.html tests/photo-query.test.js tests/selection-model.test.js tests/run-all.js
git commit -m "feat: select photo query results across pages"
```

### 任务 2：保存搜索

**文件：**

- 修改：`main.js`
- 修改：`preload.js`
- 修改：`renderer/index.html`
- 修改：`renderer/app.js`
- 修改：`renderer/style.css`
- 修改：`tests/database.test.js`

- [ ] **步骤 1：编写失败的数据库行为测试**

在临时数据库中插入保存搜索，验证名称唯一、JSON 查询可读回、删除后不存在。

```js
test('saved searches preserve query snapshots and enforce unique names', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'phonebl-search-'));
  const db = await openPhotoDatabase(path.join(root, 'photos.db'));
  db.run('INSERT INTO saved_searches (name, query_json) VALUES (?, ?)', ['海边', JSON.stringify({ searchQuery: '海', filter: 'gps' })]);
  assert.deepEqual(JSON.parse(db.exec('SELECT query_json FROM saved_searches WHERE name = ?', ['海边'])[0].values[0][0]), { searchQuery: '海', filter: 'gps' });
  assert.throws(() => db.run('INSERT INTO saved_searches (name, query_json) VALUES (?, ?)', ['海边', '{}']));
  db.close();
  await fs.rm(root, { recursive: true, force: true });
});
```

- [ ] **步骤 2：运行测试确认现有数据库行为缺少 API 级覆盖**

运行：`node --test tests/database.test.js`  
预期：新增测试先因重复名称的错误处理/API 未定义而失败。

- [ ] **步骤 3：实现保存搜索 IPC 和 UI**

在 `main.js` 增加 `list-saved-searches`、`save-saved-search`、`delete-saved-search`，保存前校验非空名称和合法 JSON。`preload.js` 暴露对应方法。`renderer/index.html` 在搜索工具栏加入保存按钮和保存搜索列表；`app.js` 保存当前规范查询、恢复时填入搜索/筛选/日期控件并调用 `loadPhotos()`，删除操作二次确认。

- [ ] **步骤 4：运行数据库测试和 lint**

运行：`node --test tests/database.test.js; npm run lint`  
预期：数据库测试 PASS，所有 JS 文件语法检查 PASS。

- [ ] **步骤 5：Commit**

```powershell
git add main.js preload.js renderer/index.html renderer/app.js renderer/style.css tests/database.test.js
git commit -m "feat: add saved photo searches"
```

### 任务 3：XMP sidecar 写回

**文件：**

- 修改：`src/metadata.js`
- 创建：`tests/xmp.test.js`
- 修改：`main.js`
- 修改：`preload.js`
- 修改：`renderer/index.html`
- 修改：`renderer/app.js`
- 修改：`src/job-manager.js`

- [ ] **步骤 1：编写失败的 XMP 映射测试**

测试 `buildXmpWriteArgs(photo, sidecarPath)` 生成标签、评分、色标和目标路径，且不包含覆盖原图的参数；测试失败写入返回 `xmp_synced=0`。

```js
const { buildXmpWriteArgs, writeXmpSidecar } = require('../src/metadata');

test('maps editable metadata to a neighboring XMP sidecar', () => {
  const args = buildXmpWriteArgs({ tags: '海边,日落', rating: 4, color_label: 'red' }, 'D:/photos/a.jpg.xmp');
  assert.ok(args.includes('-XMP:Subject=海边'));
  assert.ok(args.includes('-XMP:Subject=日落'));
  assert.ok(args.includes('-XMP:Rating=4'));
  assert.ok(args.includes('-XMP:Label=red'));
  assert.ok(args.includes('-o'));
  assert.equal(args.at(-1), 'D:/photos/a.jpg.xmp');
  assert.ok(!args.includes('-overwrite_original'));
});

test('reports an exiftool failure without claiming synchronization', async () => {
  const result = await writeXmpSidecar({ path: 'D:/photos/a.jpg', tags: '', rating: 0 }, { run: async () => { throw new Error('tool failed'); } });
  assert.deepEqual(result, { ok: false, synced: false, error: 'tool failed' });
});
```

- [ ] **步骤 2：运行 XMP 测试确认失败**

运行：`node --test tests/xmp.test.js`  
预期：FAIL，报错 `buildXmpWriteArgs is not a function`。

- [ ] **步骤 3：实现最小 XMP 模块**

在 `src/metadata.js` 增加 `buildXmpWriteArgs(photo, sidecarPath)` 和 `writeXmpSidecar(photo, deps)`；使用 `exiftool-vendored` 或注入的 `run` 执行 sidecar 写入，标签按逗号分隔并去重，评级限制为 0-5，色标限制为允许字符串。写入失败返回 `{ ok:false, synced:false, error }`。

- [ ] **步骤 4：运行 XMP 测试确认通过**

运行：`node --test tests/xmp.test.js`  
预期：XMP 映射和失败状态测试 PASS。

- [ ] **步骤 5：接入批量任务和同步标记**

在 `main.js` 增加 `sync-xmp` IPC，从数据库读取照片路径和元数据，调用 `writeXmpSidecar()`，成功/失败后更新 `photos.xmp_synced`，通过 JobManager 报告处理进度。`preload.js` 暴露 `syncXmp(ids)` 和进度监听；详情面板增加“写入 XMP”按钮，批量栏增加“写入 XMP”。

- [ ] **步骤 6：运行测试和 lint**

运行：`npm run lint; npm test`  
预期：全部通过。

- [ ] **步骤 7：Commit**

```powershell
git add src/metadata.js tests/xmp.test.js main.js preload.js renderer/index.html renderer/app.js src/job-manager.js
git commit -m "feat: write editable metadata to XMP sidecars"
```

### 任务 4：真正的图库虚拟滚动

**文件：**

- 修改：`renderer/app.js`
- 修改：`renderer/style.css`
- 修改：`renderer/index.html`
- 修改：`scripts/smoke-ui.js`

- [ ] **步骤 1：编写失败的虚拟窗口测试**

新增可测试纯函数 `calculateGalleryWindow(total, scrollTop, viewportHeight, rowHeight, overscanRows)`，验证 10 万项只返回窗口范围；验证窗口变化不改变 `SelectionModel`。

```js
test('virtual gallery window stays bounded for a large library', () => {
  const window = calculateGalleryWindow(100000, 250000, 900, 220, 3);
  assert.ok(window.end - window.start <= 20);
  assert.ok(window.start > 1000);
});
```

- [ ] **步骤 2：运行测试确认缺少实现**

运行：`node --test tests/selection-model.test.js`  
预期：FAIL，报错 `calculateGalleryWindow is not defined`；随后将该纯函数放入可测试模块并注册专门测试文件。

- [ ] **步骤 3：实现虚拟窗口与分页缓存**

在 `app.js` 保存 `galleryItems`、`galleryTotal`、`galleryQuery` 和窗口状态；用顶部/底部 spacer 保持总高度，滚动时计算窗口并只渲染窗口卡片。分页数据按查询缓存，接近窗口边缘时调用 `getPhotos`。卡片创建时根据选择模型设置 `.selected`，移除 DOM 卡片不清理选择集合。

- [ ] **步骤 4：运行真实 UI 冒烟验证**

运行：`npm run smoke`  
预期：图库卡片数量受视口和缓冲区限制，滚动后仍能显示缩略图，选择的卡片离开/回到视口后仍保持选中。

- [ ] **步骤 5：Commit**

```powershell
git add renderer/app.js renderer/style.css renderer/index.html scripts/smoke-ui.js tests/selection-model.test.js
git commit -m "feat: virtualize the photo gallery"
```

### 任务 5：多图对比

**文件：**

- 修改：`renderer/index.html`
- 修改：`renderer/style.css`
- 修改：`renderer/app.js`
- 修改：`preload.js`
- 修改：`main.js`
- 修改：`scripts/smoke-ui.js`

- [ ] **步骤 1：编写失败的比较选择边界测试**

测试 `getComparisonIds(ids, limit)` 对 0、1、2、4、5 个 ID 的结果和提示状态。

```js
test('comparison requires two photos and caps at four', () => {
  assert.deepEqual(getComparisonIds([], 4), { ok: false, reason: 'need-two', ids: [] });
  assert.deepEqual(getComparisonIds([1], 4), { ok: false, reason: 'need-two', ids: [1] });
  assert.deepEqual(getComparisonIds([1, 2, 3, 4, 5], 4), { ok: true, truncated: true, ids: [1, 2, 3, 4] });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test tests/selection-model.test.js`  
预期：FAIL，报错 `getComparisonIds is not defined`。

- [ ] **步骤 3：实现比较视图**

增加比较模态框和 `openComparison()`；使用选择 ID 获取详情和显示图片，最多四列，显示文件名、日期、尺寸、评分、GPS、版本状态。关闭时不清空图库选择；不足两张时显示提示，超过四张时只取当前选择顺序前四张并提示。

- [ ] **步骤 4：运行 smoke 和 lint**

运行：`npm run lint; npm run smoke`  
预期：比较按钮可发现，0/1 张提示正确，2-4 张面板可见，无 renderer 异常。

- [ ] **步骤 5：Commit**

```powershell
git add renderer/index.html renderer/style.css renderer/app.js preload.js main.js scripts/smoke-ui.js tests/selection-model.test.js
git commit -m "feat: compare selected photos side by side"
```

### 任务 6：旅程、停留点与 GPS 热力图

**文件：**

- 创建：`src/trip-analysis.js`
- 创建：`tests/trip-analysis.test.js`
- 修改：`main.js`
- 修改：`preload.js`
- 修改：`renderer/index.html`
- 修改：`renderer/style.css`
- 修改：`renderer/app.js`
- 修改：`scripts/smoke-ui.js`

- [ ] **步骤 1：编写失败的分析测试**

使用固定 GPS/时间数据测试 24 小时旅程切分、1 公里/6 小时停留点聚合和 0.01 度热力网格计数。

```js
const { splitTrips, clusterStayPoints, aggregateGpsGrid } = require('../src/trip-analysis');

test('splits trips when the time gap exceeds 24 hours', () => {
  const trips = splitTrips([
    { id: 1, date_taken: '2026-01-01T10:00:00Z', gps_lat: 30, gps_lon: 104 },
    { id: 2, date_taken: '2026-01-01T12:00:00Z', gps_lat: 30.001, gps_lon: 104.001 },
    { id: 3, date_taken: '2026-01-03T12:00:00Z', gps_lat: 31, gps_lon: 105 }
  ]);
  assert.equal(trips.length, 2);
  assert.deepEqual(trips[0].photoIds, [1, 2]);
});

test('aggregates GPS points into deterministic heat cells', () => {
  assert.deepEqual(aggregateGpsGrid([{ gps_lat: 30.001, gps_lon: 104.001 }, { gps_lat: 30.004, gps_lon: 104.004 }], 0.01), [{ lat: 30, lon: 104, count: 2 }]);
});
```

- [ ] **步骤 2：运行测试确认缺少模块**

运行：`node --test tests/trip-analysis.test.js`  
预期：FAIL，报错 `Cannot find module '../src/trip-analysis'`。

- [ ] **步骤 3：实现纯分析模块**

实现 `splitTrips(photos, gapHours = 24)`、`clusterStayPoints(tripPhotos, radiusKm = 1, maxHours = 6)` 和 `aggregateGpsGrid(points, cellSize = 0.01)`。输入按时间稳定排序；缺失时间/GPS 的项被跳过并在结果中保留计数为零的规则不参与聚合。

- [ ] **步骤 4：运行分析测试确认通过**

运行：`node --test tests/trip-analysis.test.js`  
预期：全部 PASS。

- [ ] **步骤 5：接入 IPC 和地图 UI**

在 `main.js` 增加 `get-trips`、`get-stay-points` 和 `get-gps-heatmap`，从当前非删除照片读取 GPS/时间并调用纯模块。`preload.js` 暴露接口。`renderer/app.js` 新增旅程视图和停留点卡片；Leaflet 地图增加普通标记/热力网格切换，使用圆形图层表现强度并保留中心/缩放。

- [ ] **步骤 6：运行 smoke 和 lint**

运行：`npm run lint; npm run smoke`  
预期：有 GPS 数据时旅程/停留点/热力图可见，无 GPS 时显示空状态，原有瓦片和标记检查继续通过。

- [ ] **步骤 7：Commit**

```powershell
git add src/trip-analysis.js tests/trip-analysis.test.js main.js preload.js renderer/index.html renderer/style.css renderer/app.js scripts/smoke-ui.js
git commit -m "feat: add trip views and GPS heatmap"
```

### 任务 7：本地 CLIP 语义搜索

**文件：**

- 创建：`src/clip-search.js`
- 创建：`tests/clip-search.test.js`
- 修改：`src/database.js`
- 修改：`main.js`
- 修改：`preload.js`
- 修改：`renderer/index.html`
- 修改：`renderer/style.css`
- 修改：`renderer/app.js`
- 修改：`package.json`
- 修改：`package-lock.json`
- 修改：`tests/run-all.js`

- [ ] **步骤 1：编写失败的 CLIP 适配器测试**

使用注入的本地模型假实现测试未配置状态、索引进度、向量存储和最近邻排序，并断言索引和搜索不调用 `fetch`。

```js
const { ClipSearch } = require('../src/clip-search');

test('reports local model unavailable without network fallback', async () => {
  const clip = new ClipSearch({ modelPath: '', fetchImpl: () => { throw new Error('network used'); } });
  assert.deepEqual(await clip.status(), { configured: false, indexed: 0, total: 0 });
  assert.deepEqual(await clip.search('日落'), { ok: false, reason: 'model-not-configured', items: [] });
});

test('indexes local vectors and returns nearest images', async () => {
  const clip = new ClipSearch({ modelPath: 'local', adapter: {
    image: async photo => photo.vector,
    text: async () => [1, 0]
  }});
  await clip.index([{ id: 1, vector: [1, 0] }, { id: 2, vector: [0, 1] }]);
  assert.deepEqual((await clip.search('x')).items.map(item => item.id), [1, 2]);
});
```

- [ ] **步骤 2：运行测试确认缺少模块**

运行：`node --test tests/clip-search.test.js`  
预期：FAIL，报错 `Cannot find module '../src/clip-search'`。

- [ ] **步骤 3：实现索引模块和数据库存储**

在 `src/database.js` 增加 `clip_embeddings(photo_id PRIMARY KEY, vector_json, model_id, updated_at)` 和索引。`src/clip-search.js` 提供 `status()`、`configure(modelPath)`、`index(photos, onProgress)`、`search(text, limit)`；向量使用归一化余弦相似度，适配器通过构造参数注入，默认适配器动态加载本地 Transformers/ONNX 模型，不启用远程下载。

- [ ] **步骤 4：安装并锁定本地运行依赖**

运行：`npm install @huggingface/transformers`  
预期：`package.json` 和 `package-lock.json` 出现依赖；安装失败时记录实际错误并改为本地配置的 ONNX 适配器，不删除已经可用的普通搜索。

- [ ] **步骤 5：接入任务和 UI**

在 `main.js` 增加 `get-clip-status`、`configure-clip`、`start-clip-index`、`clip-search`；索引任务显示进度，单张失败可继续并在结果中报告。`renderer/index.html` 在搜索视图增加本地模型路径、状态、建立索引和语义搜索控件；`app.js` 在模型未配置时显示明确提示，普通关键词搜索仍走原有 SQL。

- [ ] **步骤 6：运行 CLIP 测试、完整测试和 lint**

运行：`node --test tests/clip-search.test.js; npm run lint; npm test`  
预期：CLIP 注入测试、现有测试和语法检查全部通过；测试期间不访问网络。

- [ ] **步骤 7：Commit**

```powershell
git add src/clip-search.js tests/clip-search.test.js src/database.js main.js preload.js renderer/index.html renderer/style.css renderer/app.js package.json package-lock.json tests/run-all.js
git commit -m "feat: add optional local CLIP search"
```

### 任务 8：集成冒烟、文档、打包和最终验收

**文件：**

- 修改：`scripts/smoke-ui.js`
- 修改：`README.md`
- 修改：`package.json`
- 修改：计划文件和实现代码中的跟踪复选框

- [ ] **步骤 1：扩展真实 Electron 冒烟脚本**

使用临时用户数据目录启动真实 Electron，验证图库初始卡片、选择全部当前查询 ID、`Ctrl+A` 不破坏输入框、滚动窗口数量、保存搜索、比较入口、地图热力切换和 CLIP 未配置状态；保留原有 AI 和地图检查。

- [ ] **步骤 2：运行完整质量门**

依次运行：

```powershell
npm run lint
npm test
npm run smoke
npm run verify
npm run package
```

预期：每条命令退出码为 0；测试输出无失败；smoke 输出所有检查 PASS；`release/` 产生新的 Windows 安装包或便携版。

- [ ] **步骤 3：检查 Git diff 和运行产物**

运行：`git status --short; git diff --check; Get-ChildItem release -File | Select-Object Name,Length,LastWriteTime`  
预期：只包含本次需求相关变更；无空白错误；安装包存在且大小非零。

- [ ] **步骤 4：更新 README 和最终功能矩阵**

在中文和英文说明中记录 `Ctrl+A`、保存搜索、XMP sidecar、虚拟滚动、比较、旅程/停留点、热力图和本地 CLIP 的配置与限制；明确 CLIP 模型未配置时的状态。

- [ ] **步骤 5：Commit**

```powershell
git add scripts/smoke-ui.js README.md package.json docs/superpowers/plans/2026-08-31-photo-manager-completion.md
git commit -m "test: verify completed photo manager workflows"
```

---

## 计划自检

- 规格中的七项未完成能力均有独立任务：XMP（任务 3）、保存搜索（任务 2）、虚拟滚动（任务 4）、多图对比（任务 5）、旅程/停留点（任务 6）、GPS 热力图（任务 6）、CLIP（任务 7）。
- “全选/Ctrl+A”有独立任务 1，并在任务 8 做真实窗口验收。
- 查询、选择、旅程和 CLIP 都先定义纯函数测试，再写实现；XMP 使用注入依赖以测试失败路径。
- 没有使用未定义的数据库表、IPC 名称或 renderer 状态；所有新增接口在任务中同时定义主进程、preload 和调用方。
- 没有把 CLIP 模型未配置误报为索引完成；打包和冒烟属于最终交付门槛。
