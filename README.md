# PhoneBL

[中文](#中文) | [English](#english)

## 中文

PhoneBL 是一款面向旅行照片的本地优先照片管理工具，支持照片库浏览、地图定位、批量处理、AI 标签、水印、压缩、轻量修图与幻灯片放映。项目基于 Electron 构建，原图不会被编辑操作覆盖；照片文件保留在本地，不会上传到云端。

### 主要功能

- 照片库：增量分页加载、JPG/RAW 筛选、排序、评分与色标。
- 版本栈：修图、水印和压缩都生成可切换副本，原图始终保留；首次升级前会自动备份数据库。
- 任务中心：扫描、AI 标签、水印、压缩等任务支持进度、暂停、继续、取消和失败重试。
- 照片地图：本地瓦片缓存、透明蓝灰底图、GPS 坐标展示、位置分组和旅行路线可视化。
- 批量操作：标签、重命名、回收站删除、永久删除确认、水印、压缩。
- 编辑工具：LR 预设近似还原、非破坏性编辑副本、导出副本。
- AI 能力：自动场景标签，支持 Google Gemini 或任意 OpenAI 兼容接口（可自定义模型、接口地址、提示词）；API Key 使用 Electron SafeStorage 加密保存在本机。
- 其他功能：相似照片检测、连拍识别、统计面板、幻灯片放映。

### 快速开始

```powershell
npm install
npm start
```

系统要求：

- Windows 10/11
- Node.js 22 或更高版本
- npm 10 或更高版本

### AI 场景识别配置

打开「设置 → AI 场景识别」，选择服务商后填写模型、接口地址和 API Key：

- Google Gemini：默认接口 `https://generativelanguage.googleapis.com/v1beta`，模型如 `gemini-1.5-flash`。
- OpenAI 兼容接口：适用于 OpenAI 官方、DeepSeek、通义千问兼容模式、硅基流动、OpenRouter、one-api 等任何提供 `/chat/completions` 的网关，只需改接口地址和模型名。

识别提示词可自定义，留空则使用默认提示词（输出不超过 8 个中文标签）。「测试连接」会用一张 1×1 图片发起最小请求验证配置是否可用。API Key 只加密保存在本机，不会写入仓库，界面也不会回显明文。

### 快捷键

| 按键 | 功能 |
| --- | --- |
| `←` / `→` | 上一张 / 下一张 |
| `↑` / `↓` | 在详情或灯箱中切换照片 |
| `Esc` | 关闭当前预览 |
| `Delete` | 将选中照片移入回收站 |
| `Ctrl+点击` | 选择或取消选择照片 |

首次启动后，选择包含 JPG、PNG、WebP 或 NEF 等 RAW 文件的照片文件夹进行扫描。扫描结果、缩略图和编辑副本会保存在本地 `data/` 目录中；该目录已被 Git 忽略。

### 隐私说明

照片本身始终保存在本地。只有当你主动配置 AI 接口的 API Key 并运行 AI 标签时，压缩后的图片才会发送给你设置的服务商接口（默认为 Google Gemini）。地图底图会缓存到本机；反向地理编码仅在查看位置信息时请求 Nominatim，并遵守其频率限制。

生成副本默认保留 EXIF / IPTC / XMP 元数据。导出和处理流程可选择“保留全部”“移除 GPS”或“仅保留最小安全元数据”。

### 构建安装包

```powershell
npm run verify
npm run package
```

构建结果输出到 `release/`。当前项目未购买代码签名证书，Windows 可能会在首次运行时显示发布者未知提示。

### 开发结构

```text
main.js            Electron 主进程：扫描、数据库、sharp 图像处理和 IPC
preload.js         渲染进程安全桥接 API
src/               数据库迁移、任务队列、元数据和日志模块
renderer/          界面、地图和交互逻辑
scripts/           测试与界面冒烟检查脚本
data/              本地运行时数据，不入库
```

本地检查：`npm run lint` 语法检查，`npm test` 单元与迁移测试，`npm run smoke` 会启动真实界面，验证图库分页加载与 AI 设置面板。

### 许可证

本项目基于 [MIT License](LICENSE) 发布。

Copyright (c) 2026 吴家希（WJX）

### 作者

- **吴家希（WJX）** — [GitHub](https://github.com/blueicx)

### 贡献者

- [吴家希（WJX）](https://github.com/blueicx) — 项目作者
- 其他贡献者将通过 GitHub 提交记录自动展示。

## English

PhoneBL is a local-first photo manager for travel photography. It provides library browsing, map-based organization, batch tools, AI tagging, watermarks, compression, lightweight editing, and a slideshow mode. The app is built with Electron and keeps original photos untouched by edits.

### Features

- Photo library: incremental paging, JPG/RAW filters, sorting, ratings, and color labels.
- Version stack: edits, watermarks, and compression create switchable copies while preserving originals; the database is backed up before first upgrade.
- Job center: scan, AI-tagging, watermark, and compression jobs support progress, pause/resume, cancellation, and retry.
- Photo map: cached tiles, a transparent blue-grey basemap, GPS visualization, location groups, and travel routes.
- Batch operations: tags, renaming, recycle-bin deletion, permanent-delete confirmation, watermarks, and compression.
- Editing: approximate Lightroom preset support, non-destructive edit copies, and export.
- AI features: automatic scene tagging with Google Gemini or any OpenAI-compatible endpoint (custom model, base URL, and prompt); the API key is encrypted on disk with Electron SafeStorage.
- Extras: similar-photo detection, burst detection, statistics, and slideshow playback.

### Quick Start

```powershell
npm install
npm start
```

Requirements:

- Windows 10/11
- Node.js 22 or later
- npm 10 or later

### AI Provider Setup

Open “Settings → AI scene recognition”, pick a provider, then fill in the model, base URL and API key:

- Google Gemini: default base URL `https://generativelanguage.googleapis.com/v1beta`, model such as `gemini-1.5-flash`.
- OpenAI-compatible: works with OpenAI, DeepSeek, Qwen compatible mode, SiliconFlow, OpenRouter, one-api and any other gateway exposing `/chat/completions`; change the base URL and model name.

The recognition prompt is editable and falls back to a default that asks for up to 8 short Chinese tags. “Test connection” sends one 1x1 image to verify the configuration. Keys stay encrypted on this machine and are never shown in plain text or committed.

### Keyboard Shortcuts

| Key | Action |
| --- | --- |
| `←` / `→` | Previous / next photo |
| `↑` / `↓` | Navigate in detail view or lightbox |
| `Esc` | Close the active preview |
| `Delete` | Move selected photos to the Recycle Bin |
| `Ctrl+Click` | Select or deselect a photo |

After the first launch, select a folder containing JPG, PNG, WebP, NEF, or other supported images. Scans, thumbnails, and edited copies are stored under local `data/`; that directory is ignored by Git.

### Privacy

Photos remain stored locally. Only when you configure an AI API key and explicitly run AI tagging is a downscaled image sent to the provider endpoint you configured (Google Gemini by default). Map tiles are cached locally; reverse geocoding uses Nominatim only when location details are requested and respects its rate limits.

Generated copies keep EXIF / IPTC / XMP metadata by default. Processing can choose “keep all”, “remove GPS”, or “minimal safe metadata”.

### Build Installers

```powershell
npm run verify
npm run package
```

Artifacts are written to `release/`. No code-signing certificate is bundled yet, so Windows may show an unknown-publisher prompt on first launch.

### Project Layout

```text
main.js            Electron main process: scanning, database, sharp processing, IPC
preload.js         Secure renderer bridge
src/               Database migration, jobs, metadata, and logging modules
renderer/          UI, map, and interaction logic
scripts/           Test and UI smoke-check harnesses
data/              Local runtime data, not committed
```

Local checks: `npm run lint` for syntax, `npm test` for unit and migration tests, and `npm run smoke` to boot the real UI and verify gallery paging plus the AI settings panel.

### License

Released under the [MIT License](LICENSE).

Copyright (c) 2026 吴家希（WJX）

### Author

- **吴家希（WJX）** — [GitHub](https://github.com/blueicx)

### Contributors

- [吴家希（WJX）](https://github.com/blueicx) — project author
- Additional contributors will be shown automatically from Git history.
