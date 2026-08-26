# PhoneBL

[中文](#中文) | [English](#english)

## 中文

PhoneBL 是一款面向旅行照片的本地照片管理工具，支持照片库浏览、地图定位、批量处理、AI 标签、水印、压缩、轻量修图与幻灯片放映。项目基于 Electron 构建，照片文件保留在本地，不会上传到云端。

### 主要功能

- 照片库：分页加载、筛选排序、缩略图缓存。
- 照片地图：GPS 坐标展示、位置分组、旅行路线可视化。
- 批量操作：标星、标签、重命名、回收站、水印、压缩。
- 编辑工具：LR 预设近似还原、非破坏性编辑副本、导出副本。
- AI 能力：Gemini 自动场景标签。
- 其他功能：相似照片检测、连拍识别、统计面板、幻灯片放映。

### 快速开始

```powershell
npm install
npm start
```

系统要求：

- Windows 10/11
- Node.js 20 或更高版本
- npm 10 或更高版本

首次启动后，选择包含 JPG、PNG、WebP 或 NEF 等 RAW 文件的照片文件夹进行扫描。扫描结果、缩略图和编辑副本会保存在本地 `data/` 目录中；该目录已被 Git 忽略。

### 隐私说明

照片本身始终保存在本地。只有当你主动配置 Gemini API Key 并使用 AI 标签时，相关照片信息才会发送到 Google Gemini API。地图底图数据由 OpenStreetMap 提供。

### 开发结构

```text
main.js            Electron 主进程：扫描、数据库、sharp 图像处理和 IPC
preload.js         渲染进程安全桥接 API
renderer/          界面、地图和交互逻辑
data/              本地运行时数据，不入库
```

### 许可证

本项目基于 [MIT License](LICENSE) 发布。

Copyright (c) 2026 吴家希（WJX）

### 作者

- **吴家希（WJX）** — [GitHub](https://github.com/blueicx)

### 贡献者

- [吴家希（WJX）](https://github.com/blueicx) — 项目作者
- 其他贡献者将通过 GitHub 提交记录自动展示。

## English

PhoneBL is a local-first photo manager for travel photography. It provides library browsing, map-based organization, batch tools, AI tagging, watermarks, compression, lightweight editing, and a slideshow mode. The app is built with Electron and keeps photo files on your machine.

### Features

- Photo library: paged browsing, filtering, sorting, and thumbnail caching.
- Photo map: GPS visualization, location groups, and travel routes.
- Batch operations: starring, tags, renaming, recycle bin, watermarks, compression.
- Editing: approximate Lightroom preset support, non-destructive edit copies, and export.
- AI features: automatic scene tagging with Gemini.
- Extras: similar-photo detection, burst detection, statistics, and slideshow playback.

### Quick Start

```powershell
npm install
npm start
```

Requirements:

- Windows 10/11
- Node.js 20 or later
- npm 10 or later

After the first launch, select a folder containing JPG, PNG, WebP, NEF, or other supported images. Scans, thumbnails, and edited copies are stored under local `data/`; that directory is ignored by Git.

### Privacy

Photos remain stored locally. If you configure a Gemini API key and explicitly run AI tagging, relevant photo information is sent to the Google Gemini API. Map tiles are provided by OpenStreetMap.

### Project Layout

```text
main.js            Electron main process: scanning, database, sharp processing, IPC
preload.js         Secure renderer bridge
renderer/          UI, map, and interaction logic
data/              Local runtime data, not committed
```

### License

Released under the [MIT License](LICENSE).

Copyright (c) 2026 吴家希（WJX）

### Author

- **吴家希（WJX）** — [GitHub](https://github.com/blueicx)

### Contributors

- [吴家希（WJX）](https://github.com/blueicx) — project author
- Additional contributors will be shown automatically from Git history.
