const { app, BrowserWindow, ipcMain, dialog, shell, protocol, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { openPhotoDatabase } = require('./src/database');
const { JobManager } = require('./src/job-manager');
const { applyMetadataPolicy, writeXmpSidecar } = require('./src/metadata');
const { normalizePhotoQuery, buildPhotoWhere, buildPhotoOrder } = require('./src/photo-query');
const { normalizeSavedSearch, parseSavedSearch } = require('./src/saved-searches');
const { splitTrips, clusterStayPoints, aggregateGpsGrid } = require('./src/trip-analysis');
const { ClipSearch, createLocalClipAdapter } = require('./src/clip-search');
const { orientationTransform } = require('./src/image-utils');
const { createLogger } = require('./src/logger');
const {
  AI_PROVIDERS,
  DEFAULT_AI_PROMPT,
  PROVIDER_GEMINI,
  providerById,
  requestVision,
  parseTags
} = require('./src/ai-vision');
const exifr = require('exifr');
const sharp = require('sharp');
const crypto = require('crypto');

let db = null;
let mainWindow = null;
let jobManager = null;
let clipSearch = null;
const logger = createLogger(path.join(__dirname, 'data', 'logs', 'main.log'));

const DB_PATH = path.join(__dirname, 'data', 'photos.db');
const THUMB_DIR = path.join(__dirname, 'data', 'thumbs');
const PREVIEW_DIR = path.join(__dirname, 'data', 'previews');
const EDIT_DIR = path.join(__dirname, 'data', 'edited');
const DISPLAY_DIR = path.join(__dirname, 'data', 'displays');
const WATERMARK_ASSET_DIR = path.join(__dirname, 'data', 'watermark');
const MAP_TILE_DIR = path.join(__dirname, 'data', 'map-tiles-v2');

const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif',
  '.heic', '.heif', '.avif',
  '.cr2', '.cr3', '.nef', '.arw', '.dng', '.orf', '.raf', '.rw2'
]);
const RAW_EXTENSIONS = new Set(['.cr2', '.cr3', '.nef', '.arw', '.dng', '.orf', '.raf', '.rw2']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm']);
const ALL_MEDIA = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]);

protocol.registerSchemesAsPrivileged([
  { scheme: 'maptile', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

async function ensureDirs() {
  await fsp.mkdir(path.dirname(DB_PATH), { recursive: true });
  await fsp.mkdir(THUMB_DIR, { recursive: true });
    await fsp.mkdir(PREVIEW_DIR, { recursive: true });
    await fsp.mkdir(EDIT_DIR, { recursive: true });
    await fsp.mkdir(DISPLAY_DIR, { recursive: true });
  await fsp.mkdir(WATERMARK_ASSET_DIR, { recursive: true });
  await fsp.mkdir(MAP_TILE_DIR, { recursive: true });
}

async function savePhotoVersion(photoId, versionType, versionPath, settings = {}, engine = 'phonebl') {
  let size = 0;
  try { size = (await fsp.stat(versionPath)).size; } catch {}
  db.run(`
    INSERT OR IGNORE INTO photo_versions
      (photo_id, version_type, path, settings_json, engine, size, is_active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `, [Number(photoId), String(versionType), String(versionPath), JSON.stringify(settings), String(engine), size]);
}

async function activatePhotoVersion(photoId, versionPath) {
  db.run('UPDATE photo_versions SET is_active = CASE WHEN path = ? THEN 1 ELSE 0 END WHERE photo_id = ?', [
    String(versionPath), Number(photoId)
  ]);
}

async function setPhotoEdit(photoId, versionPath, settings, versionType = 'edit', engine = 'phonebl') {
  await savePhotoVersion(photoId, versionType, versionPath, settings, engine);
  await activatePhotoVersion(photoId, versionPath);
}

async function initDb() {
  db = await openPhotoDatabase(DB_PATH);
  const modelPath = db.exec("SELECT value FROM settings WHERE key = 'clip_model_path'").at(0)?.values?.[0]?.[0] || '';
  clipSearch = new ClipSearch({
    modelPath,
    adapterFactory: createLocalClipAdapter,
    loadEntries: async () => {
      const rows = db.exec('SELECT photo_id, vector_json FROM clip_embeddings ORDER BY photo_id').at(0)?.values || [];
      return rows.flatMap(([id, vectorJson]) => {
        try { return [{ id: Number(id), vector: JSON.parse(vectorJson) }]; } catch { return []; }
      });
    },
    clearEntries: async () => { db.run('DELETE FROM clip_embeddings'); saveDb(); },
    saveEntry: async entry => {
      db.run('INSERT OR REPLACE INTO clip_embeddings (photo_id, vector_json, model_id, updated_at) VALUES (?, ?, ?, datetime(\'now\'))', [entry.id, JSON.stringify(entry.vector), clipSearch.modelPath]);
    }
  });
}

function saveDb() {
  if (!db) return;
  db.checkpoint();
}

function scanFolderRecursive(folderPath, includeRaw = true) {
  const results = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!includeRaw && RAW_EXTENSIONS.has(ext)) continue;
        if (ALL_MEDIA.has(ext)) {
          results.push({ path: full, filename: entry.name, ext });
        }
      }
    }
  }
  walk(folderPath);
  return results;
}

function extractEmbeddedJpeg(buffer) {
  // Scan for JPEG SOI marker (FFD8) and EOI marker (FFD9)
  // Find the LARGEST valid JPEG segment (usually the preview)
  const candidates = [];
  let searchStart = 0;
  while (candidates.length < 5) {
    const soi = buffer.indexOf(Buffer.from([0xFF, 0xD8, 0xFF]), searchStart);
    if (soi === -1) break;
    const eoi = buffer.indexOf(Buffer.from([0xFF, 0xD9]), soi + 2);
    if (eoi === -1) break;
    const size = eoi + 2 - soi;
    if (size > 5000) { // Only meaningful images
      candidates.push({ start: soi, end: eoi + 2, size });
    }
    searchStart = soi + 2;
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.size - a.size);
  const best = candidates[0];
  return buffer.slice(best.start, best.end);
}

async function generateThumb(filePath, photoId, isRaw) {
  const thumbName = `${photoId}.webp`;
  const thumbPath = path.join(THUMB_DIR, thumbName);
  try {
    if (isRaw) {
      const rawBuffer = await fsp.readFile(filePath);
      // Read EXIF orientation BEFORE extracting JPEG (extraction strips metadata)
      let exifOrientation = null;
      try {
        const meta = await exifr.parse(rawBuffer, { tiff: true, ifd0: true, translateValues: false });
        if (meta && meta.Orientation) exifOrientation = Number(meta.Orientation);
      } catch {}
      // Try exifr thumbnail first
      let jpegData = null;
      try { jpegData = await exifr.thumbnail(rawBuffer); } catch {}
      if (!jpegData || jpegData.length < 10000) {
        jpegData = extractEmbeddedJpeg(rawBuffer);
      }
      if (!jpegData) return null;

      const sharpPipeline = sharp(jpegData);
      orientationTransform(sharpPipeline, exifOrientation);
      await sharpPipeline.resize(400, 400, { fit: 'inside' }).webp({ quality: 80 }).toFile(thumbPath);
      return thumbPath;
    } else {
      await sharp(filePath).rotate().resize(400, 400, { fit: 'inside' }).webp({ quality: 80 }).toFile(thumbPath);
      return thumbPath;
    }
  } catch (err) {
    console.error(`Thumbnail failed for ${filePath}:`, err.message);
    return null;
  }
}

function computeColorHash(thumbPath) {
  // Simple average color hash from thumbnail - used for similar photo detection
  try {
    const buf = fs.readFileSync(thumbPath);
    let r = 0, g = 0, b = 0, count = 0;
    // Sample every Nth byte from the webp buffer as a rough hash
    const step = Math.max(1, Math.floor(buf.length / 1000));
    for (let i = 0; i < buf.length; i += step) {
      r += buf[i]; g += buf[(i + 1) % buf.length]; b += buf[(i + 2) % buf.length];
      count++;
    }
    if (count === 0) return null;
    return [Math.round(r / count), Math.round(g / count), Math.round(b / count)].join(',');
  } catch {
    return null;
  }
}

const PRESET_KEYS = new Set([
  'Exposure2012', 'Contrast2012', 'Highlights2012', 'Shadows2012', 'Whites2012',
  'Blacks2012', 'Clarity2012', 'Texture', 'Dehaze', 'Vibrance', 'Saturation',
  'Temperature', 'Tint', 'Sharpness', 'SharpenRadius', 'SharpenDetail',
  'SharpenEdgeMasking', 'LuminanceSmoothing', 'GrainAmount', 'GrainSize',
  'GrainFrequency', 'PostCropVignetteAmount', 'PostCropVignetteMidpoint',
  'PostCropVignetteFeather', 'PostCropVignetteRoundness', 'CropAngle',
  'ConvertToGrayscale', 'ParametricShadows', 'ParametricDarks', 'ParametricLights',
  'ParametricHighlights', 'ParametricShadowSplit', 'ParametricDarkSplit',
  'ParametricLightSplit', 'ParametricHighlightSplit', 'SplitToningHighlightHue',
  'SplitToningHighlightSaturation', 'SplitToningShadowHue',
  'SplitToningShadowSaturation', 'SplitToningBalance', 'ColorGradeShadowHue',
  'ColorGradeShadowSat', 'ColorGradeShadowLum', 'ColorGradeMidtoneHue',
  'ColorGradeMidtoneSat', 'ColorGradeMidtoneLum', 'ColorGradeHighlightHue',
  'ColorGradeHighlightSat', 'ColorGradeHighlightLum', 'ColorGradeBlending',
  'ColorGradeGlobalHue', 'ColorGradeGlobalSat', 'ColorGradeGlobalLum',
  'GrayMixerRed', 'GrayMixerOrange', 'GrayMixerYellow', 'GrayMixerGreen',
  'GrayMixerAqua', 'GrayMixerBlue', 'GrayMixerPurple', 'GrayMixerMagenta',
  'Exposure', 'Brightness', 'Contrast', 'Highlights', 'Shadows'
]);

for (const color of ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta']) {
  PRESET_KEYS.add(`HueAdjustment${color}`);
  PRESET_KEYS.add(`SaturationAdjustment${color}`);
  PRESET_KEYS.add(`LuminanceAdjustment${color}`);
}

const CURVE_KEYS = new Set([
  'ToneCurvePV2012', 'ToneCurvePV2012Red', 'ToneCurvePV2012Green', 'ToneCurvePV2012Blue'
]);

function extractPresetName(content, fallback) {
  const patterns = [
    /crs:Name\s*=\s*"([^"]+)"/i,
    /presetName\s*=\s*["']([^"']+)["']/i,
    /<dc:title>[\s\S]*?<rdf:li[^>]*>([^<]+)<\/rdf:li>/i,
    /name\s*=\s*["']([^"']+)["']/i
  ];
  for (const re of patterns) {
    const match = content.match(re);
    if (match && match[1].trim()) return match[1].trim();
  }
  return path.basename(fallback, path.extname(fallback));
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&');
}

function collectPresetValues(value, output = {}) {
  if (Array.isArray(value)) {
    return output;
  }
  if (!value || typeof value !== 'object') return output;
  for (const [key, child] of Object.entries(value)) {
    if (PRESET_KEYS.has(key)) output[key] = child;
    else if (CURVE_KEYS.has(key)) output[key] = child;
    else collectPresetValues(child, output);
  }
  return output;
}

function parseLuaTemplate(content) {
  let pos = 0;
  function skipSpace() {
    while (pos < content.length && /[\s,;]/.test(content[pos])) pos++;
  }
  function value() {
    skipSpace();
    if (pos >= content.length) throw new Error('Unexpected end');
    const ch = content[pos];
    if (ch === '{') {
      pos++;
      const table = {};
      let arrayIndex = 0;
      while (pos < content.length) {
        skipSpace();
        if (content[pos] === '}') { pos++; return table; }
        let key;
        if (content[pos] === '[') {
          pos++; key = String(value()); skipSpace();
          if (content[pos] === ']') pos++;
          skipSpace();
          if (content[pos] === '=') pos++;
        } else if (/["']/.test(content[pos])) {
          key = String(value());
          skipSpace();
          if (content[pos] === '=') pos++;
        } else {
          const match = content.slice(pos).match(/^[A-Za-z_][A-Za-z0-9_]*/);
          if (!match) break;
          key = match[0]; pos += key.length; skipSpace();
          if (content[pos] === '=') pos++;
          else key = String(++arrayIndex);
        }
        table[key] = value();
      }
      return table;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch; pos++;
      let out = '';
      while (pos < content.length && content[pos] !== quote) {
        if (content[pos] === '\\') { pos++; out += content[pos++] || ''; }
        else out += content[pos++];
      }
      if (content[pos] === quote) pos++;
      return out;
    }
    const number = content.slice(pos).match(/^[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?/i);
    if (number) { pos += number[0].length; return Number(number[0]); }
    const word = content.slice(pos).match(/^(true|false|nil)/i);
    if (word) {
      pos += word[0].length;
      return /^true/i.test(word[0]) ? true : (/^false/i.test(word[0]) ? false : null);
    }
    // Unknown expression: consume a conservative token so parsing can continue.
    const token = content.slice(pos).match(/^[^\s,;}]+/);
    if (token) pos += token[0].length;
    return null;
  }
  return value();
}

function parseLightroomPreset(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const settings = {};
  const setSetting = (key, value) => {
    if (PRESET_KEYS.has(key) || CURVE_KEYS.has(key)) settings[key] = value;
  };

  const add = (key, value) => {
    key = key.replace(/^(crs:|pred:)/i, '');
    if (value === undefined || value === null || value === '') return;
    setSetting(key, decodeXml(value));
  };

  // Modern Lightroom presets are XMP; values may be attributes or elements.
  for (const match of content.matchAll(/(?:crs|pred):([A-Za-z0-9_]+)\s*=\s*"([^"]*)"/g)) {
    add(match[1], match[2]);
  }
  for (const match of content.matchAll(/<(?:crs|pred):([A-Za-z0-9_]+)(?:\s[^>]*)?>([^<]*)<\/(?:crs|pred):\1>/g)) {
    add(match[1], match[2]);
  }

  // Curve and legacy array settings are RDF sequences.
  for (const key of [...CURVE_KEYS, 'GrayMixer']) {
    const blockRe = new RegExp(`<(?:crs|pred):(${key})[^>]*>([\\s\\S]*?)<\\/(?:crs|pred):\\1>`, 'ig');
    for (const block of content.matchAll(blockRe)) {
      const items = [...block[2].matchAll(/<rdf:li[^>]*>([^<]*)<\/rdf:li>/g)].map(m => decodeXml(m[1]));
      if (items.length) setSetting(block[1], items);
    }
  }

  // Some exporters put sequence data directly in an attribute.
  for (const match of content.matchAll(/(?:crs|pred):(ToneCurvePV2012[A-Za-z]*)\s*=\s*"([^"]+)"/g)) {
    if (CURVE_KEYS.has(match[1])) setSetting(match[1], decodeXml(match[2]).split(/[\s;]+/).filter(Boolean));
  }

  // Older .lrtemplate files are Lua-like text.
  try {
    collectPresetValues(parseLuaTemplate(content), settings);
  } catch {}

  return {
    name: extractPresetName(content, filePath),
    settings,
    supportedCount: Object.keys(settings).length
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function normalizeCurvePoints(input) {
  const flat = Array.isArray(input) ? input.flat(Infinity) : [];
  const numbers = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    let x = Number(flat[i]); let y = Number(flat[i + 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (Math.max(x, y) <= 1.001) { x *= 255; y *= 255; }
    numbers.push([clamp(x, 0, 255), clamp(y, 0, 255)]);
  }
  numbers.sort((a, b) => a[0] - b[0]);
  const points = numbers.filter((p, i) => i === 0 || p[0] > numbers[i - 1][0]);
  if (points.length < 2) return [[0, 0], [255, 255]];
  return points;
}

function interpolatePoints(points, x) {
  if (x <= points[0][0]) return points[0][1];
  if (x >= points[points.length - 1][0]) return points[points.length - 1][1];
  for (let i = 1; i < points.length; i++) {
    if (x <= points[i][0]) {
      const [x0, y0] = points[i - 1]; const [x1, y1] = points[i];
      const ratio = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
      return y0 + ratio * (y1 - y0);
    }
  }
  return x;
}

function scaleCurve(points, scale) {
  if (!scale || Math.abs(scale - 1) < .001) return normalizeCurvePoints(points);
  const normalized = normalizeCurvePoints(points);
  return normalized.map(([x, y]) => [x, clamp(x + (y - x) * scale, 0, 255)]);
}

function buildCurveLut(points) {
  return Array.from({ length: 256 }, (_, i) => clamp(interpolatePoints(points, i), 0, 255));
}

function srgbToLinear(value) {
  value /= 255;
  return value <= .04045 ? value / 12.92 : Math.pow((value + .055) / 1.055, 2.4);
}

function linearToSrgb(value) {
  value = clamp(value, 0, 1);
  return 255 * (value <= .0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - .055);
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b); const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > .5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s, l };
}

function hueToRgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < .5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hueToRgb(p, q, h + 1 / 3) * 255, hueToRgb(p, q, h) * 255, hueToRgb(p, q, h - 1 / 3) * 255];
}

function hueDistance(a, b) {
  let d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function smoothstep(edge0, edge1, value) {
  const t = clamp((value - edge0) / (edge1 - edge0 || 1), 0, 1);
  return t * t * (3 - 2 * t);
}

function normalizeEditSettings(presetSettings = {}, intensity = 1) {
  const n = {};
  const arrays = {};
  for (const [key, rawValue] of Object.entries(presetSettings)) {
    if (Array.isArray(rawValue)) arrays[key] = rawValue;
    else if (typeof rawValue === 'boolean') n[key] = rawValue;
    else {
      const value = Number(rawValue);
      if (Number.isFinite(value)) n[key] = value;
    }
  }

  const scale = clamp(intensity, 0, 2);
  const slider = (key, limit = 100) => clamp((Number(n[key]) || 0) * scale, -limit, limit);
  const positive = (key, limit = 150) => clamp((Number(n[key]) || 0) * scale, 0, limit);
  const color = (prefix) => ({
    hue: slider(`${prefix}Hue`),
    sat: slider(`${prefix}Sat`) || slider(`${prefix}Saturation`),
    lum: slider(`${prefix}Lum`)
  });

  let warmth = slider('Temperature', 150) / 100;
  // Absolute Kelvin values need conversion; LR's relative slider is usually within +/-150.
  const temperature = Number(n.Temperature);
  if (Math.abs(temperature) > 500) {
    warmth = clamp(((6500 - temperature) / 3500) * scale, -1.5, 1.5);
  }

  return {
    exposure: clamp(slider(n.Exposure2012 !== undefined ? 'Exposure2012' : 'Exposure', 5), -4, 4),
    contrast: slider(n.Contrast2012 !== undefined ? 'Contrast2012' : 'Contrast'),
    highlights: slider('Highlights2012') || slider('Highlights'),
    shadows: slider('Shadows2012') || slider('Shadows'),
    whites: slider('Whites2012'),
    blacks: slider('Blacks2012'),
    clarity: slider('Clarity2012'),
    texture: slider('Texture'),
    dehaze: slider('Dehaze'),
    vibrance: slider('Vibrance'),
    saturation: slider('Saturation'),
    warmth,
    tint: slider('Tint') / 100,
    sharpen: clamp(Number(n.Sharpness) * scale, 0, 150),
    denoise: clamp(Number(n.LuminanceSmoothing) * scale, 0, 100),
    parametric: {
      shadows: slider('ParametricShadows'), darks: slider('ParametricDarks'),
      lights: slider('ParametricLights'), highlights: slider('ParametricHighlights')
    },
    curves: {
      master: scaleCurve(arrays.ToneCurvePV2012 || [[0, 0], [255, 255]], scale),
      red: arrays.ToneCurvePV2012Red ? scaleCurve(arrays.ToneCurvePV2012Red, scale) : null,
      green: arrays.ToneCurvePV2012Green ? scaleCurve(arrays.ToneCurvePV2012Green, scale) : null,
      blue: arrays.ToneCurvePV2012Blue ? scaleCurve(arrays.ToneCurvePV2012Blue, scale) : null
    },
    hsl: {
      red: { hue: slider('HueAdjustmentRed'), sat: slider('SaturationAdjustmentRed'), lum: slider('LuminanceAdjustmentRed') },
      orange: { hue: slider('HueAdjustmentOrange'), sat: slider('SaturationAdjustmentOrange'), lum: slider('LuminanceAdjustmentOrange') },
      yellow: { hue: slider('HueAdjustmentYellow'), sat: slider('SaturationAdjustmentYellow'), lum: slider('LuminanceAdjustmentYellow') },
      green: { hue: slider('HueAdjustmentGreen'), sat: slider('SaturationAdjustmentGreen'), lum: slider('LuminanceAdjustmentGreen') },
      aqua: { hue: slider('HueAdjustmentAqua'), sat: slider('SaturationAdjustmentAqua'), lum: slider('LuminanceAdjustmentAqua') },
      blue: { hue: slider('HueAdjustmentBlue'), sat: slider('SaturationAdjustmentBlue'), lum: slider('LuminanceAdjustmentBlue') },
      purple: { hue: slider('HueAdjustmentPurple'), sat: slider('SaturationAdjustmentPurple'), lum: slider('LuminanceAdjustmentPurple') },
      magenta: { hue: slider('HueAdjustmentMagenta'), sat: slider('SaturationAdjustmentMagenta'), lum: slider('LuminanceAdjustmentMagenta') }
    },
    grayMix: {
      red: slider('GrayMixerRed'), orange: slider('GrayMixerOrange'), yellow: slider('GrayMixerYellow'),
      green: slider('GrayMixerGreen'), aqua: slider('GrayMixerAqua'), blue: slider('GrayMixerBlue'),
      purple: slider('GrayMixerPurple'), magenta: slider('GrayMixerMagenta')
    },
    grade: {
      shadow: color('ColorGradeShadow'),
      midtone: color('ColorGradeMidtone'),
      highlight: color('ColorGradeHighlight')
    },
    split: {
      shadowHue: Number(n.SplitToningShadowHue ?? n.ColorGradeShadowHue ?? 0),
      shadowSat: slider('SplitToningShadowSaturation'),
      highlightHue: Number(n.SplitToningHighlightHue ?? n.ColorGradeHighlightHue ?? 0),
      highlightSat: slider('SplitToningHighlightSaturation'),
      balance: slider('SplitToningBalance')
    },
    vignette: {
      amount: slider('PostCropVignetteAmount'),
      midpoint: clamp(Number(n.PostCropVignetteMidpoint ?? 50), 0, 100),
      feather: clamp(Number(n.PostCropVignetteFeather ?? 50), 0, 100),
      roundness: clamp(Number(n.PostCropVignetteRoundness ?? 50), 0, 100)
    },
    grain: {
      amount: positive('GrainAmount', 100),
      size: clamp(Number(n.GrainSize ?? 25) * (.5 + scale * .5), 10, 80),
      frequency: clamp(Number(n.GrainFrequency ?? 50) * (.5 + scale * .5), 0, 100)
    },
    rotate: clamp(Number(n.CropAngle) * (scale > 0 ? 1 : 0), -45, 45),
    grayscale: scale > 0 && (n.ConvertToGrayscale === true || String(n.ConvertToGrayscale).toLowerCase() === 'true')
  };
}

const EDIT_ENGINE_VERSION = 'lr-engine-v2';

function buildToneLuts(settings) {
  const masterCurve = buildCurveLut(settings.curves.master);
  const redCurve = settings.curves.red ? buildCurveLut(settings.curves.red) : null;
  const greenCurve = settings.curves.green ? buildCurveLut(settings.curves.green) : null;
  const blueCurve = settings.curves.blue ? buildCurveLut(settings.curves.blue) : null;

  return [0, 1, 2].map(channel => Array.from({ length: 256 }, (_, value) => {
    let v = srgbToLinear(value) * Math.pow(2, settings.exposure);
    v = linearToSrgb(v) / 255;

    const warmth = settings.warmth;
    const tint = settings.tint;
    v *= channel === 0 ? clamp(1 + warmth * .14, .55, 1.6)
      : channel === 1 ? clamp(1 + tint * .07, .70, 1.35)
      : clamp(1 - warmth * .14, .55, 1.6);

    let x = clamp(v, 0, 1);
    const contrast = settings.contrast / 100;
    if (contrast >= 0) x = .5 + (x - .5) * (1 + contrast * .65);
    else x = .5 + (x - .5) / (1 - contrast * .65);

    const highlightMask = smoothstep(.58, .98, x);
    const shadowMask = smoothstep(.42, .02, x);
    x -= (settings.highlights / 100) * .24 * highlightMask;
    x += (settings.shadows / 100) * .22 * shadowMask;
    x += (settings.whites / 100) * .20 * Math.pow(x, 2);
    x += (settings.blacks / 100) * .12 * (1 - smoothstep(0, .38, x));

    const p = settings.parametric;
    x += (p.shadows / 100) * .12 * smoothstep(.40, .05, x);
    x += (p.darks / 100) * .10 * (1 - Math.abs(x - .28) / .28);
    x += (p.lights / 100) * .10 * (1 - Math.abs(x - .72) / .28);
    x += (p.highlights / 100) * .12 * smoothstep(.60, .95, x);

    v = clamp(masterCurve[clamp(Math.round(x * 255), 0, 255)], 0, 255);
    const channelCurve = channel === 0 ? redCurve : channel === 1 ? greenCurve : blueCurve;
    return channelCurve ? channelCurve[clamp(Math.round(v), 0, 255)] : v;
  }));
}

function colorGradeRgb(hue, saturation, luminance) {
  if (!saturation && !luminance) return [0, 0, 0];
  const rgb = hslToRgb(((hue % 360) + 360) % 360, clamp(saturation / 100, 0, 1), .5);
  const gain = 1 + (luminance / 100) * .25;
  return rgb.map(v => v * gain);
}

function hslWeight(hue, center) {
  return smoothstep(62, 22, hueDistance(hue, center));
}

function deterministicNoise(x, y, seed) {
  let n = (x | 0) * 374761393 + (y | 0) * 668265263 + (seed | 0) * 1274126177;
  n = (n ^ (n >>> 13)) * 1103515245;
  n ^= n >>> 16;
  return ((n >>> 0) / 4294967295) - .5;
}

let displayRunning = false;
let displaySequence = 0;
const displayPending = [];
const displayJobs = new Map();

function enqueueDisplayTask(task, priority = 0) {
  return new Promise((resolve, reject) => {
    displayPending.push({ task, priority, sequence: ++displaySequence, resolve, reject });
    // A newly requested photo should overtake older neighbour-prefetch jobs.
    displayPending.sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
    runDisplayQueue();
  });
}

async function runDisplayQueue() {
  if (displayRunning) return;
  const next = displayPending.shift();
  if (!next) return;

  displayRunning = true;
  try {
    next.resolve(await next.task());
  } catch (error) {
    next.reject(error);
  } finally {
    displayRunning = false;
    runDisplayQueue();
  }
}

async function getDisplayImage(id, preferEdited = true, priority = 0) {
  const jobKey = `${Number(id)}:${preferEdited ? 1 : 0}`;
  if (displayJobs.has(jobKey)) return displayJobs.get(jobKey);

  const job = enqueueDisplayTask(async () => {
  const row = db.exec("SELECT path, ext, edit_path FROM photos WHERE id = ?", [id]);
  if (!row.length || !row[0].values.length) throw new Error('照片不存在');
  const [originalPath, ext, editPath] = row[0].values[0];
  let source = preferEdited && editPath && fs.existsSync(editPath) ? editPath : null;
  if (!source) source = await sourceImageForPhoto(id);
  const stat = await fsp.stat(source);
  const signature = `${id}|${source}|${stat.size}|${stat.mtimeMs}|display-v1`;
  const hash = crypto.createHash('sha256').update(signature).digest('hex').slice(0, 20);
  const outputPath = path.join(DISPLAY_DIR, `${id}-${hash}.jpg`);

  if (!fs.existsSync(outputPath)) {
    await fsp.mkdir(DISPLAY_DIR, { recursive: true });
    const tempPath = `${outputPath}.${process.pid}.tmp.jpg`;
    try {
      await sharp(source, { failOn: 'none', limitInputPixels: 268402689 })
        .rotate()
        .resize(2560, 2560, { fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#000000' })
        .removeAlpha()
        .jpeg({ quality: 86, mozjpeg: true })
        .toFile(tempPath);
      await fsp.rename(tempPath, outputPath);
    } finally {
      fs.promises.unlink(tempPath).catch(() => {});
    }
  }
  return outputPath;
  });

  displayJobs.set(jobKey, job);
  try {
    return await job;
  } finally {
    displayJobs.delete(jobKey);
  }
}

async function sourceImageForPhoto(id) {
  const r = db.exec("SELECT path FROM photos WHERE id = ?", [id]);
  if (!r.length || !r[0].values.length) throw new Error('照片不存在');
  const originalPath = r[0].values[0][0];
  if (RAW_EXTENSIONS.has(path.extname(originalPath).toLowerCase())) {
    const previewPath = await getRawPreviewFile(id);
    if (previewPath) return previewPath;
  }
  return originalPath;
}

async function getRawPreviewFile(id) {
  const cachePath = path.join(PREVIEW_DIR, `${id}.jpg`);
  if (fs.existsSync(cachePath)) return cachePath;
  const r = db.exec("SELECT path FROM photos WHERE id = ?", [id]);
  if (!r.length || !r[0].values.length) return null;
  const filePath = r[0].values[0][0];
  try {
    const rawBuf = await fsp.readFile(filePath);

    // The embedded JPEG usually has no usable orientation metadata, so carry it over explicitly.
    let orientation = 1;
    try {
      const meta = await exifr.parse(rawBuf, { tiff: true, ifd0: true, translateValues: false });
      if (meta?.Orientation) orientation = Number(meta.Orientation) || 1;
    } catch {}
    let jpegData = null;
    try { jpegData = await exifr.thumbnail(rawBuf); } catch {}
    if (!jpegData || jpegData.length < 10000) jpegData = extractEmbeddedJpeg(rawBuf);
    if (!jpegData) return null;

    await fsp.mkdir(PREVIEW_DIR, { recursive: true });
    const pipeline = sharp(jpegData, { failOn: 'none' });
    orientationTransform(pipeline, orientation);
    await pipeline.jpeg({ quality: 95 }).toFile(cachePath);
    return cachePath;
  } catch {
    return null;
  }
}

const WATERMARK_ENGINE_VERSION = 'watermark-v1';
const COMPRESSION_ENGINE_VERSION = 'compression-v1';
const WATERMARK_POSITIONS = new Set([
  'top-left', 'top-center', 'top-right',
  'middle-left', 'center', 'middle-right',
  'bottom-left', 'bottom-center', 'bottom-right'
]);
const METADATA_POLICIES = new Set(['keep-all', 'remove-gps', 'minimal-safe']);

function normalizeWatermarkOptions(options = {}) {
  const position = WATERMARK_POSITIONS.has(options.position) ? options.position : 'bottom-right';
  return {
    engine: WATERMARK_ENGINE_VERSION,
    scale: clamp(Number(options.scale ?? 22), 4, 60) / 100,
    opacity: clamp(Number(options.opacity ?? 90), 10, 100) / 100,
    margin: clamp(Number(options.margin ?? 4), 1, 15) / 100,
    position,
    metadataPolicy: METADATA_POLICIES.has(options.metadataPolicy) ? options.metadataPolicy : 'keep-all'
  };
}

function normalizeCompressionOptions(options = {}) {
  const maxEdge = [0, 6144, 4096, 2560, 1920].includes(Number(options.maxEdge))
    ? Number(options.maxEdge) : 4096;
  return {
    engine: COMPRESSION_ENGINE_VERSION,
    quality: Math.round(clamp(Number(options.quality ?? 82), 45, 95)),
    maxEdge,
    metadataPolicy: METADATA_POLICIES.has(options.metadataPolicy) ? options.metadataPolicy : 'keep-all'
  };
}

async function getWatermarkSetting() {
  const result = db.exec("SELECT value FROM settings WHERE key = 'watermark_path'");
  return result.length && result[0].values.length ? String(result[0].values[0][0] || '') : '';
}

function placeWatermark(baseWidth, baseHeight, markWidth, markHeight, margin, position) {
  switch (position) {
    case 'top-left': return { left: margin, top: margin };
    case 'top-center': return { left: Math.round((baseWidth - markWidth) / 2), top: margin };
    case 'top-right': return { left: baseWidth - markWidth - margin, top: margin };
    case 'middle-left': return { left: margin, top: Math.round((baseHeight - markHeight) / 2) };
    case 'center': return {
      left: Math.round((baseWidth - markWidth) / 2),
      top: Math.round((baseHeight - markHeight) / 2)
    };
    case 'middle-right': return {
      left: baseWidth - markWidth - margin,
      top: Math.round((baseHeight - markHeight) / 2)
    };
    case 'bottom-left': return { left: margin, top: baseHeight - markHeight - margin };
    case 'bottom-center': return {
      left: Math.round((baseWidth - markWidth) / 2),
      top: baseHeight - markHeight - margin
    };
    default: return {
      left: baseWidth - markWidth - margin,
      top: baseHeight - markHeight - margin
    };
  }
}

async function applyWatermarkToPhoto(id, watermarkPath, options = {}) {
  const rows = db.exec("SELECT path, edit_path, edit_settings FROM photos WHERE id = ? AND deleted = 0", [Number(id)]);
  if (!rows.length || !rows[0].values.length) throw new Error('照片不存在');

  const normalized = normalizeWatermarkOptions(options);
  let source;
  try {
    const previousEdit = JSON.parse(rows[0].values[0][2] || 'null');
    // Reapplying replaces the old mark instead of stacking watermarks.
    source = previousEdit?.type === 'watermark'
      ? (previousEdit.base_edit_path && fs.existsSync(previousEdit.base_edit_path)
        ? previousEdit.base_edit_path
        : await sourceImageForPhoto(id))
      : rows[0].values[0][1];
  } catch {
    source = rows[0].values[0][1];
  }
  if (!source || !fs.existsSync(source)) source = await sourceImageForPhoto(id);

  const [sourceStat, markStat] = await Promise.all([
    fsp.stat(source), fsp.stat(watermarkPath)
  ]);
  const signature = JSON.stringify({
    id: Number(id), source, sourceMtime: sourceStat.mtimeMs, sourceSize: sourceStat.size,
    watermarkPath, markMtime: markStat.mtimeMs, markSize: markStat.size, ...normalized
  });
  const hash = crypto.createHash('sha256').update(signature).digest('hex').slice(0, 20);
  const outputPath = path.join(EDIT_DIR, `${id}-watermark-${hash}.jpg`);

  if (!fs.existsSync(outputPath)) {
    const base = await sharp(source, { failOn: 'none', limitInputPixels: 268402689 })
      .rotate()
      .resize(6144, 6144, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 95, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });

    const targetWidth = Math.max(1, Math.round(base.info.width * normalized.scale));
    const resizedMark = await sharp(watermarkPath, { failOn: 'none' })
      .resize(targetWidth, null, { fit: 'inside', withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    let markBuffer;
    if (normalized.opacity < 1) {
      for (let i = 3; i < resizedMark.data.length; i += 4) {
        resizedMark.data[i] = Math.round(resizedMark.data[i] * normalized.opacity);
      }
    }
    markBuffer = await sharp(resizedMark.data, { raw: resizedMark.info }).png().toBuffer();

    const margin = Math.round(Math.min(base.info.width, base.info.height) * normalized.margin);
    const markMetadata = await sharp(markBuffer).metadata();
    const markWidth = Math.max(1, markMetadata.width || targetWidth);
    const markHeight = Math.max(1, markMetadata.height || 1);
    const positioned = placeWatermark(
      base.info.width, base.info.height, markWidth, markHeight, margin, normalized.position
    );
    const left = clamp(positioned.left, 0, Math.max(0, base.info.width - markWidth));
    const top = clamp(positioned.top, 0, Math.max(0, base.info.height - markHeight));

    await sharp(base.data).composite([{ input: markBuffer, left, top }])
      .jpeg({ quality: 93, mozjpeg: true })
      .toFile(outputPath);
    await applyMetadataPolicy(outputPath, source, normalized.metadataPolicy);
  }

  await setPhotoEdit(id, outputPath, {
    type: 'watermark', base_edit_path: source === rows[0].values[0][1] ? source : null, watermarkPath, ...normalized
  }, 'watermark', WATERMARK_ENGINE_VERSION);
  await regenerateThumbnailFromImage(id, outputPath);
  return outputPath;
}

async function compressPhotoToPhoto(id, options = {}) {
  const rows = db.exec("SELECT path, edit_path, edit_settings FROM photos WHERE id = ? AND deleted = 0", [Number(id)]);
  if (!rows.length || !rows[0].values.length) throw new Error('照片不存在');

  const normalized = normalizeCompressionOptions(options);
  let source;
  try {
    const previousEdit = JSON.parse(rows[0].values[0][2] || 'null');
    // Compressing twice starts from the previous base so JPEG artifacts do not accumulate.
    source = previousEdit?.type === 'compression'
      ? (previousEdit.base_edit_path && fs.existsSync(previousEdit.base_edit_path)
        ? previousEdit.base_edit_path
        : await sourceImageForPhoto(id))
      : rows[0].values[0][1];
  } catch {
    source = rows[0].values[0][1];
  }
  if (!source || !fs.existsSync(source)) source = await sourceImageForPhoto(id);

  const sourceStat = await fsp.stat(source);
  const signature = JSON.stringify({
    id: Number(id), source, sourceMtime: sourceStat.mtimeMs, sourceSize: sourceStat.size,
    ...normalized
  });
  const hash = crypto.createHash('sha256').update(signature).digest('hex').slice(0, 20);
  const outputPath = path.join(EDIT_DIR, `${id}-compressed-${hash}.jpg`);
  let outputSize = 0;

  if (!fs.existsSync(outputPath)) {
    let pipeline = sharp(source, { failOn: 'none', limitInputPixels: 268402689 })
      .rotate();
    if (normalized.maxEdge > 0) {
      pipeline = pipeline.resize(normalized.maxEdge, normalized.maxEdge, {
        fit: 'inside', withoutEnlargement: true
      });
    }
    const info = await pipeline.flatten({ background: '#ffffff' }).removeAlpha()
      .jpeg({ quality: normalized.quality, mozjpeg: true })
      .toFile(outputPath);
    await applyMetadataPolicy(outputPath, source, normalized.metadataPolicy);
    outputSize = info.size || (await fsp.stat(outputPath)).size;
  } else {
    outputSize = (await fsp.stat(outputPath)).size;
    await applyMetadataPolicy(outputPath, source, normalized.metadataPolicy);
  }

  await setPhotoEdit(id, outputPath, {
    type: 'compression', base_edit_path: source === rows[0].values[0][1] ? source : null, ...normalized
  }, 'compression', COMPRESSION_ENGINE_VERSION);
  await regenerateThumbnailFromImage(id, outputPath);
  return { path: outputPath, inputBytes: sourceStat.size, outputBytes: outputSize };
}

async function renderEditedImage(id, presetId, intensity, mode = 'preview') {
  const presetRow = db.exec("SELECT name, settings_json FROM presets WHERE id = ?", [presetId]);
  if (!presetRow.length || !presetRow[0].values.length) throw new Error('预设不存在');
  const [presetName, settingsJson] = presetRow[0].values[0];
  let parsed;
  try { parsed = JSON.parse(settingsJson); } catch { parsed = {}; }
  const normalized = normalizeEditSettings(parsed, intensity / 100);
  const source = await sourceImageForPhoto(id);
  const stat = await fsp.stat(source);
  const signature = JSON.stringify({ engine: EDIT_ENGINE_VERSION, id, mtime: stat.mtimeMs, size: stat.size, presetId, normalized, mode });
  const hash = crypto.createHash('sha256').update(signature).digest('hex').slice(0, 20);
  const outputPath = path.join(EDIT_DIR, `${id}-${mode}-${hash}.jpg`);

  if (!fs.existsSync(outputPath)) {
    const input = await fsp.readFile(source);
    let pipeline = sharp(input, { failOn: 'none', limitInputPixels: 268402689 }).rotate();
    if (normalized.rotate) pipeline.rotate(normalized.rotate, { background: '#000000' });

    const maxEdge = mode === 'preview' ? 1600 : 6144;
    const { data, info } = await pipeline.resize(maxEdge, maxEdge, {
      fit: 'inside', withoutEnlargement: true
    }).flatten({ background: '#000000' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });

    let blurred = null;
    if (normalized.clarity || normalized.texture || normalized.dehaze) {
      blurred = await sharp(data, { raw: info }).blur(clamp(info.width / 900, .4, 2)).raw().toBuffer();
    }

    const luts = buildToneLuts(normalized);
    const hslColors = [
      ['red', 0], ['orange', 30], ['yellow', 60], ['green', 120],
      ['aqua', 180], ['blue', 240], ['purple', 280], ['magenta', 320]
    ].map(([name, center]) => ({ center, ...normalized.hsl[name] }));
    const grayMix = [
      normalized.grayMix.red, normalized.grayMix.orange, normalized.grayMix.yellow, normalized.grayMix.green,
      normalized.grayMix.aqua, normalized.grayMix.blue, normalized.grayMix.purple, normalized.grayMix.magenta
    ];
    const hasGrade = normalized.grade.shadow.sat + normalized.grade.midtone.sat + normalized.grade.highlight.sat;
    const gradeSeed = Number(String(hash).slice(0, 8).replace(/\D/g, '').padEnd(8, '7')) || 1234567;
    const pixels = info.width * info.height;

    for (let i = 0; i < pixels; i++) {
      const p = i * 3;
      let r = luts[0][data[p]];
      let g = luts[1][data[p + 1]];
      let b = luts[2][data[p + 2]];
      const x = i % info.width;
      const y = Math.floor(i / info.width);

      if (blurred) {
        const lum = .2126 * r + .7152 * g + .0722 * b;
        const blurLum = .2126 * blurred[p] + .7152 * blurred[p + 1] + .0722 * blurred[p + 2];
        const local = lum - blurLum;
        const clarityGain = (normalized.clarity / 100) * 1.35;
        const textureGain = (normalized.texture / 100) * 1.75;
        const add = local * (clarityGain + textureGain);
        r += add; g += add; b += add;
      }

      if (normalized.dehaze) {
        const minimum = Math.min(r, g, b) / 255;
        const strength = (normalized.dehaze / 100) * smoothstep(.08, .55, minimum);
        const lift = (r + g + b) / 3 - 24;
        r += lift * strength * .72; g += lift * strength * .72; b += lift * strength * .72;
      }

      let maxRgb = Math.max(r, g, b), minRgb = Math.min(r, g, b);
      let lightness = (maxRgb + minRgb) / 510;
      let saturationValue = maxRgb === minRgb ? 0 : (maxRgb - minRgb) / 255 / (1 - Math.abs(2 * lightness - 1));
      let hue = 0;
      if (maxRgb !== minRgb) {
        const range = maxRgb - minRgb;
        if (maxRgb === r) hue = ((g - b) / range) % 6;
        else if (maxRgb === g) hue = (b - r) / range + 2;
        else hue = (r - g) / range + 4;
        hue *= 60;
      }

      if (!normalized.grayscale && (normalized.vibrance || normalized.saturation)) {
        const vibranceMask = clamp(1 - clamp(saturationValue, 0, 1), 0, 1);
        const satChange = (normalized.saturation / 100) * .65 + (normalized.vibrance / 100) * .45 * vibranceMask;
        saturationValue = clamp(saturationValue * (1 + satChange), 0, 1);
      }

      if (!normalized.grayscale) {
        let hueShift = 0, satAdd = 0, lumAdd = 0;
        for (const color of hslColors) {
          const weight = hslWeight(hue, color.center);
          if (!weight) continue;
          hueShift += (color.hue / 360) * weight;
          satAdd += (color.sat / 100) * weight;
          lumAdd += (color.lum / 100) * weight * .18;
        }
        hue += hueShift * 90;
        saturationValue = clamp(saturationValue + satAdd * .28, 0, 1);
        lightness = clamp(lightness + lumAdd, 0, 1);
      } else {
        let luminance = .30 * r + .59 * g + .11 * b;
        for (let ci = 0; ci < hslColors.length; ci++) {
          luminance += grayMix[ci] * hslWeight(hue, hslColors[ci].center) * .42;
        }
        [r, g, b] = [luminance, luminance, luminance];
      }

      if (!normalized.grayscale && saturationValue > 0) {
        const converted = hslToRgb(hue, saturationValue, lightness);
        r = converted[0]; g = converted[1]; b = converted[2];
      } else if (!normalized.grayscale) {
        // Preserve highlights when saturation reaches zero but lightness still changed.
        const chroma = 0;
        const second = lightness * 255;
        r = second; g = second; b = second;
        void chroma;
      }

      if (!normalized.grayscale) {
        const shadowWeight = smoothstep(.48, .12, lightness);
        const highlightWeight = smoothstep(.52, .88, lightness);
        const midtoneWeight = clamp(1 - shadowWeight - highlightWeight, 0, 1);
        if (hasGrade > 0) {
          const gradeParts = [normalized.grade.shadow, normalized.grade.midtone, normalized.grade.highlight];
          const weights = [shadowWeight, midtoneWeight, highlightWeight];
          for (let gi = 0; gi < 3; gi++) {
            const part = gradeParts[gi];
            if (!part.sat && !part.lum) continue;
            const tint = colorGradeRgb(part.hue, part.sat, part.lum);
            const amount = (part.sat / 100) * weights[gi] * .38;
            r += tint[0] * amount; g += tint[1] * amount; b += tint[2] * amount;
          }
        } else {
          const balance = normalized.split.balance / 100;
          const splitShadow = clamp(shadowWeight + balance * .25, 0, 1);
          const splitHighlight = clamp(highlightWeight - balance * .25, 0, 1);
          const shadowTint = colorGradeRgb(normalized.split.shadowHue, normalized.split.shadowSat, 0);
          const highlightTint = colorGradeRgb(normalized.split.highlightHue, normalized.split.highlightSat, 0);
          r += shadowTint[0] * splitShadow * .32 + highlightTint[0] * splitHighlight * .32;
          g += shadowTint[1] * splitShadow * .32 + highlightTint[1] * splitHighlight * .32;
          b += shadowTint[2] * splitShadow * .32 + highlightTint[2] * splitHighlight * .32;
        }
      }

      if (normalized.grain.amount > 0) {
        const coarse = Math.max(1, Math.round(normalized.grain.size / 12));
        const noise = deterministicNoise(Math.floor(x / coarse), Math.floor(y / coarse), gradeSeed)
          * (normalized.grain.amount / 100) * 24;
        r += noise; g += noise; b += noise;
      }

      if (normalized.vignette.amount) {
        const roundness = normalized.vignette.roundness / 100;
        const dx = (x / info.width - .5) * (2 - roundness);
        const dy = y / info.height - .5;
        const distance = Math.sqrt(dx * dx + dy * dy) / .72;
        const start = .22 + (normalized.vignette.midpoint / 100) * .68;
        const feather = .06 + (normalized.vignette.feather / 100) * .94;
        const mask = smoothstep(start, start + feather, distance);
        const target = normalized.vignette.amount > 0 ? 255 : 0;
        const mixAmount = Math.abs(normalized.vignette.amount) / 100 * mask;
        r += (target - r) * mixAmount;
        g += (target - g) * mixAmount;
        b += (target - b) * mixAmount;
      }

      data[p] = clamp(Math.round(r), 0, 255);
      data[p + 1] = clamp(Math.round(g), 0, 255);
      data[p + 2] = clamp(Math.round(b), 0, 255);
    }

    let outputPipeline = sharp(data, { raw: info });
    if (normalized.denoise > 1) outputPipeline.blur(clamp(normalized.denoise / 110, .3, 1.3));
    if (normalized.sharpen > 0 || normalized.clarity > 0) {
      outputPipeline.sharpen({
        sigma: 1, m1: 0,
        m2: clamp(normalized.sharpen / 55 + Math.max(0, normalized.clarity) / 120, 0, 2),
        x1: 2, y2: 10, y3: 18
      });
    }
    await outputPipeline.jpeg({ quality: mode === 'preview' ? 87 : 93, mozjpeg: true }).toFile(outputPath);
  }

  if (mode !== 'preview') await applyMetadataPolicy(outputPath, source, 'keep-all');
  return { path: outputPath, name: presetName, normalized };
}

async function indexPhotos(folderPath, event, includeRaw = true) {
  const files = scanFolderRecursive(folderPath, includeRaw);
  const total = files.length;
  let processed = 0;
  let added = 0;
  let skipped = 0;
  const pendingThumbs = [];
  db.run("BEGIN TRANSACTION");

  for (const file of files) {
    const existing = db.exec("SELECT id FROM photos WHERE path = ?", [file.path]);
    if (existing.length > 0 && existing[0].values.length > 0) {
      skipped++;
      processed++;
      continue;
    }

    let meta = {};
    try {
      meta = await exifr.parse(file.path, {
        tiff: true, exif: true, gps: true, ifd0: true,
        translateValues: true, reviveValues: true, sanitize: false
      }) || {};
    } catch {}

    let width = meta.ExifImageWidth || meta.ImageWidth || 0;
    let height = meta.ExifImageHeight || meta.ImageHeight || 0;

    const isRaw = RAW_EXTENSIONS.has(file.ext) ? 1 : 0;
    function formatDateLocal(d) {
      if (!d) return null;
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
    }
    const dateTaken = formatDateLocal(meta.DateTimeOriginal) || formatDateLocal(meta.CreateDate);

    const stmt = db.prepare(`
      INSERT INTO photos (path, filename, ext, size, width, height, date_taken,
        camera_make, camera_model, lens_model, iso, aperture, shutter, focal_length,
        gps_lat, gps_lon, orientation, is_raw, has_gps)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run([
      file.path, file.filename, file.ext,
      (() => { try { return fs.statSync(file.path).size; } catch { return 0; } })(),
      width, height, dateTaken,
      meta.Make || null, meta.Model || null, meta.LensModel || null,
      meta.ISO || meta.ISOSpeedRatings || null,
      meta.FNumber || null,
      meta.ExposureTime ? `1/${Math.round(1 / meta.ExposureTime)}` : null,
      meta.FocalLength || null,
      meta.latitude || null, meta.longitude || null,
      meta.Orientation || 1,
      isRaw, (meta.latitude && meta.longitude) ? 1 : 0
    ]);

    const lastId = db.exec("SELECT last_insert_rowid()")[0].values[0][0];
    pendingThumbs.push({ id: lastId, path: file.path, isRaw });

    added++;
    processed++;
    if (processed % 100 === 0) {
      saveDb();
      event.sender.send('scan-progress', {
        processed, total, added, skipped,
        current: file.filename
      });
    }
  }

  db.run("COMMIT");

  // Process thumbnails in parallel batches of 4
  const BATCH_SIZE = 4;
  for (let i = 0; i < pendingThumbs.length; i += BATCH_SIZE) {
    const batch = pendingThumbs.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (item) => {
      try {
        const thumbPath = await generateThumb(item.path, item.id, item.isRaw);
        if (thumbPath) {
          const colorHash = computeColorHash(thumbPath);
          db.run("UPDATE photos SET thumb_path = ?, color_hash = ? WHERE id = ?", [thumbPath, colorHash, item.id]);
        }
      } catch {}
    }));
    if ((i + BATCH_SIZE) % 100 === 0) {
      event.sender.send('scan-progress', { processed: i + BATCH_SIZE, total: pendingThumbs.length, added, skipped, current: 'thumbnails' });
    }
  }

  saveDb();
  return { total, added, skipped };
}

function jobHandlers() {
  return {
    scan: async ({ payload, window }) => indexPhotos(
      payload.folderPath,
      { sender: window.webContents },
      payload.includeRaw !== false
    ),
    thumbnails: async ({ shouldContinue, reportProgress }) => {
      const rows = db.exec('SELECT id, path, ext FROM photos WHERE thumb_path IS NULL').at(0)?.values || [];
      let fixed = 0;
      for (const [index, row] of rows.entries()) {
        await shouldContinue();
        const [id, photoPath, ext] = row;
        const thumbPath = await generateThumb(photoPath, id, RAW_EXTENSIONS.has(ext));
        if (thumbPath) {
          db.run('UPDATE photos SET thumb_path = ?, color_hash = ? WHERE id = ?', [thumbPath, computeColorHash(thumbPath), id]);
          fixed++;
        }
        reportProgress(index + 1, rows.length, `已修复 ${fixed} 张`);
      }
      return { fixed, total: rows.length };
    },
    watermark: async ({ payload, shouldContinue, reportProgress }) => {
      const watermarkPath = await getWatermarkSetting();
      if (!watermarkPath || !fs.existsSync(watermarkPath)) throw new Error('请先导入水印');
      let done = 0, failed = 0;
      for (const [index, id] of payload.ids.entries()) {
        await shouldContinue();
        try { await applyWatermarkToPhoto(id, watermarkPath, payload.options || {}); done++; }
        catch (error) { failed++; console.error(`Watermark job failed for ${id}:`, error.message); }
        reportProgress(index + 1, payload.ids.length, `${done} 成功 / ${failed} 失败`);
      }
      saveDb();
      return { done, failed, total: payload.ids.length };
    },
    compression: async ({ payload, shouldContinue, reportProgress }) => {
      let done = 0, failed = 0;
      for (const [index, id] of payload.ids.entries()) {
        await shouldContinue();
        try { await compressPhotoToPhoto(id, payload.options || {}); done++; }
        catch { failed++; }
        reportProgress(index + 1, payload.ids.length, `${done} 成功 / ${failed} 失败`);
      }
      saveDb();
      return { done, failed, total: payload.ids.length };
    },
    xmp: async ({ payload, shouldContinue, reportProgress }) => {
      let synced = 0, failed = 0;
      const ids = Array.isArray(payload.ids) ? payload.ids.map(Number).filter(Number.isInteger) : [];
      for (const [index, id] of ids.entries()) {
        await shouldContinue();
        const row = db.exec('SELECT path, tags, rating, color_label FROM photos WHERE id = ?', [id]).at(0)?.values?.[0];
        if (!row) { failed++; reportProgress(index + 1, ids.length, `${synced} 成功 / ${failed} 失败`); continue; }
        const [photoPath, tags, rating, colorLabel] = row;
        const result = await writeXmpSidecar({ path: photoPath, tags, rating, color_label: colorLabel });
        db.run('UPDATE photos SET xmp_synced = ? WHERE id = ?', [result.ok ? 1 : 0, id]);
        if (result.ok) synced++; else failed++;
        reportProgress(index + 1, ids.length, `${synced} 成功 / ${failed} 失败`);
      }
      saveDb();
      return { synced, failed, total: ids.length };
    },
    'clip-index': async ({ shouldContinue, reportProgress }) => {
      await shouldContinue();
      const result = db.exec('SELECT id, path FROM photos WHERE deleted = 0 ORDER BY id').at(0);
      const photos = result?.values?.map(([id, photoPath]) => ({ id: Number(id), path: photoPath })) || [];
      const indexed = await clipSearch.index(photos, (processed, total) => {
        reportProgress(processed, total, `已建立 ${processed}/${total} 张向量`);
      });
      return indexed;
    },
    'ai-tags': async ({ payload, shouldContinue, reportProgress }) => {
      const aiConfig = getAiConfig();
      if (!aiConfig.hasKey) throw new Error(`请先在设置中配置 ${aiConfig.label} API Key`);
      let success = 0, failed = 0;
      for (const [index, id] of payload.ids.entries()) {
        await shouldContinue();
        try {
          const photoPath = db.exec('SELECT path FROM photos WHERE id = ?', [id]).at(0)?.values?.[0]?.[0];
          if (!photoPath) throw new Error('照片不存在');
          const imageBuffer = await fsp.readFile(photoPath);
          const resized = await sharp(imageBuffer, { failOn: 'none' }).resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
          const text = await requestVision(aiConfig, resized.toString('base64'), 'image/jpeg');
          const existing = db.exec('SELECT tags FROM photos WHERE id = ?', [id]).at(0)?.values?.[0]?.[0] || '';
          const tags = [...new Set([...existing.split(',').map(v => v.trim()).filter(Boolean), ...parseTags(text)])].join(',');
          db.run('UPDATE photos SET tags = ?, xmp_synced = 0 WHERE id = ?', [tags, id]);
          success++;
        } catch (err) {
          failed++;
          logger.warn(`ai-tags 失败 id=${id}: ${err.message}`);
        }
        reportProgress(index + 1, payload.ids.length, `${success} 成功 / ${failed} 失败`);
      }
      saveDb();
      return { success, failed, total: payload.ids.length };
    }
  };
}

async function handleMapTile(request) {
  const url = new URL(request.url);
  const [zoom, x, yWithQuery] = url.pathname.replace(/^\/+/, '').split('/');
  const y = yWithQuery.split('.')[0];
  if (![zoom, x, y].every(value => /^\d+$/.test(value))) return new Response('Bad tile', { status: 400 });
  const tilePath = path.join(MAP_TILE_DIR, String(zoom), String(x), `${y}.tile`);
  async function responseForFile(filePath) {
    const data = await fsp.readFile(filePath);
    const type = data[0] === 0xFF && data[1] === 0xD8 ? 'image/jpeg' : 'image/png';
    return new Response(data, { headers: { 'content-type': type, 'cache-control': 'public, max-age=31536000' } });
  }
  if (fs.existsSync(tilePath)) {
    try { return await responseForFile(tilePath); } catch {}
  }

  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const remote = `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/${zoom}/${y}/${x}`;
      const upstream = await fetch(remote, { signal: AbortSignal.timeout(10000) });
      if (!upstream.ok) throw new Error(`Tile HTTP ${upstream.status}`);
      const buffer = Buffer.from(await upstream.arrayBuffer());
      await fsp.mkdir(path.dirname(tilePath), { recursive: true });
      await fsp.writeFile(tilePath, buffer, { flag: 'wx' }).catch(async error => {
        if (error.code !== 'EEXIST') throw error;
      });
      return await responseForFile(tilePath);
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  console.error('Map tile failed:', lastError?.message);
  return new Response('Tile unavailable', { status: 502 });
}

function registerProtocolHandlers() {
  protocol.handle('maptile', handleMapTile);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    backgroundColor: '#0d1117',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.webContents.on('console-message', (e) => {
    const { level, message, lineNumber, sourceId } = e;
    if (level >= 1) console.log(`[R${level}] ${message} @${sourceId}:${lineNumber}`);
    if (level === 3) logger.error(message, { sourceId, lineNumber });
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  process.on('uncaughtException', error => logger.error('uncaughtException', { stack: error.stack }));
  process.on('unhandledRejection', reason => logger.error('unhandledRejection', { stack: reason?.stack || String(reason) }));
  await ensureDirs();
  await initDb();
  registerProtocolHandlers();
  createWindow();
  // JobManager keeps a reference to the window to push progress events, so it
  // has to be created after the BrowserWindow exists.
  jobManager = new JobManager(db, mainWindow, jobHandlers());
  jobManager.loadQueuedJobs();
}).catch(error => {
  logger.error('Application startup failed', { stack: error.stack });
  dialog.showErrorBox('PhoneBL 启动失败', error.message);
  app.exit(1);
});

app.on('window-all-closed', async () => {
  if (jobManager) await jobManager.dispose();
  if (db) db.close();
  app.quit();
});

// --- IPC Handlers ---

ipcMain.handle('pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '选择照片文件夹'
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('scan-folder', async (event, folderPath, includeRaw = true) => {
  try {
    const result = await indexPhotos(folderPath, event, includeRaw);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('get-photos', (event, options = {}) => {
  const { offset = 0, limit = 200 } = options;
  const query = normalizePhotoQuery(options);
  const where = buildPhotoWhere(query);

  const sql = `
    SELECT id, path, filename, ext, size, width, height, date_taken, starred,
           camera_make, camera_model, iso, aperture, shutter, focal_length,
           gps_lat, gps_lon, tags, faces, thumb_path, is_raw, has_gps,
           color_hash, rating, color_label, edited_at
    FROM photos ${where.sql}
    ${buildPhotoOrder(query)}
    LIMIT ? OFFSET ?
  `;
  const params = [...where.params, Number(limit), Number(offset)];

  const results = db.exec(sql, params);
  if (results.length === 0) return [];
  const columns = results[0].columns;
  return results[0].values.map(row => {
    const obj = {};
    columns.forEach((col, i) => obj[col] = row[i]);
    return obj;
  });
});

ipcMain.handle('get-photo-ids', (event, options = {}) => {
  const query = normalizePhotoQuery(options);
  const where = buildPhotoWhere(query);
  const rows = db.exec(`SELECT id FROM photos ${where.sql} ${buildPhotoOrder(query)}`, where.params);
  return rows[0]?.values?.map(row => Number(row[0])) || [];
});

ipcMain.handle('list-saved-searches', () => {
  const result = db.exec('SELECT id, name, query_json, created_at FROM saved_searches ORDER BY name COLLATE NOCASE');
  return result[0]?.values?.map(([id, name, queryJson, createdAt]) => ({
    id: Number(id), name, query: parseSavedSearch(queryJson), createdAt
  })) || [];
});

ipcMain.handle('save-saved-search', (event, name, query) => {
  try {
    const normalized = normalizeSavedSearch(name, query);
    db.run('INSERT INTO saved_searches (name, query_json) VALUES (?, ?)', [
      normalized.name, JSON.stringify(normalized.query)
    ]);
    saveDb();
    const row = db.exec('SELECT id, created_at FROM saved_searches WHERE name = ?', [normalized.name])[0]?.values?.[0];
    return { ok: true, id: Number(row?.[0]), name: normalized.name, query: normalized.query, createdAt: row?.[1] || null };
  } catch (error) {
    const message = /UNIQUE/i.test(error.message) ? '已存在同名保存搜索' : error.message;
    return { ok: false, error: message };
  }
});

ipcMain.handle('delete-saved-search', (event, id) => {
  const result = db.run('DELETE FROM saved_searches WHERE id = ?', [Number(id)]);
  saveDb();
  return { ok: result.changes > 0 };
});

ipcMain.handle('get-photo-count', (event, options = {}) => {
  const where = buildPhotoWhere(normalizePhotoQuery(options));
  const result = db.exec(`SELECT COUNT(*) FROM photos ${where.sql}`, where.params);
  return result[0].values[0][0];
});

ipcMain.handle('get-map-points', () => {
  const results = db.exec(
    "SELECT id, gps_lat, gps_lon, filename, thumb_path, date_taken, edited_at FROM photos WHERE has_gps = 1"
  );
  if (results.length === 0) return [];
  const columns = results[0].columns;
  return results[0].values.map(row => {
    const obj = {};
    columns.forEach((col, i) => obj[col] = row[i]);
    return obj;
  });
});

ipcMain.handle('get-photo-detail', (event, id) => {
  const results = db.exec("SELECT * FROM photos WHERE id = ?", [id]);
  if (results.length === 0 || results[0].values.length === 0) return null;
  const columns = results[0].columns;
  const obj = {};
  columns.forEach((col, i) => obj[col] = results[0].values[0][i]);
  return obj;
});

ipcMain.handle('update-tags', (event, id, tagsStr) => {
  db.run("UPDATE photos SET tags = ? WHERE id = ?", [tagsStr, id]);
  saveDb();
  return true;
});

ipcMain.handle('batch-update-tags', (event, ids, action, value) => {
  for (const id of ids) {
    const cur = db.exec("SELECT tags FROM photos WHERE id = ?", [id]);
    if (!cur.length || !cur[0].values.length) continue;
    const existing = (cur[0].values[0][0] || '').split(',').filter(Boolean).map(s => s.trim());
    let updated;
    if (action === 'add') {
      if (!existing.includes(value)) existing.push(value);
      updated = existing.join(',');
    } else if (action === 'remove') {
      updated = existing.filter(t => t !== value).join(',');
    }
    db.run("UPDATE photos SET tags = ? WHERE id = ?", [updated, id]);
  }
  saveDb();
  return true;
});

ipcMain.handle('find-similar', (event, id) => {
  const self = db.exec("SELECT color_hash FROM photos WHERE id = ?", [id]);
  if (!self.length || !self[0].values.length || !self[0].values[0][0]) return [];
  const myHash = self[0].values[0][0].split(',').map(Number);
  const all = db.exec("SELECT id, filename, thumb_path, color_hash FROM photos WHERE id != ? AND color_hash IS NOT NULL", [id]);
  if (!all.length) return [];

  const scored = all[0].values.map(row => {
    const theirHash = row[3].split(',').map(Number);
    const dist = Math.sqrt(
      (myHash[0] - theirHash[0]) ** 2 +
      (myHash[1] - theirHash[1]) ** 2 +
      (myHash[2] - theirHash[2]) ** 2
    );
    return { id: row[0], filename: row[1], thumb_path: row[2], distance: dist };
  }).sort((a, b) => a.distance - b.distance).slice(0, 12);

  return scored.filter(s => s.distance < 60);
});

ipcMain.handle('get-stats', () => {
  const total = db.exec("SELECT COUNT(*) FROM photos")[0].values[0][0];
  const withGps = db.exec("SELECT COUNT(*) FROM photos WHERE has_gps = 1")[0].values[0][0];
  const rawCount = db.exec("SELECT COUNT(*) FROM photos WHERE is_raw = 1")[0].values[0][0];
  let dateRange = { min: null, max: null };
  const dates = db.exec("SELECT MIN(date_taken), MAX(date_taken) FROM photos WHERE date_taken IS NOT NULL");
  if (dates.length > 0 && dates[0].values.length > 0) {
    dateRange = { min: dates[0].values[0][0], max: dates[0].values[0][1] };
  }
  const cameras = db.exec("SELECT camera_model, COUNT(*) FROM photos WHERE camera_model IS NOT NULL GROUP BY camera_model ORDER BY COUNT(*) DESC LIMIT 5");
  return { total, withGps, rawCount, dateRange,
    cameras: cameras.length ? cameras[0].values : [] };
});

ipcMain.handle('open-file', (event, filePath) => shell.openPath(filePath));
ipcMain.handle('show-in-folder', (event, filePath) => shell.showItemInFolder(filePath));

// --- AI scene recognition settings (provider agnostic) ---
const AI_SETTING_KEYS = {
  provider: 'ai_provider',
  model: 'ai_model',
  baseUrl: 'ai_base_url',
  prompt: 'ai_prompt'
};
// The renderer never reads back a stored key; it echoes this token to mean "keep".
const KEEP_STORED_SECRET = '********';

function getSettingValue(key) {
  const result = db.exec('SELECT value FROM settings WHERE key = ?', [key]);
  return result.at(0)?.values?.[0]?.[0] ?? null;
}

function setSettingValue(key, value) {
  if (value === null || value === undefined || value === '') {
    db.run('DELETE FROM settings WHERE key = ?', [key]);
    return;
  }
  db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, String(value)]);
}

function readSecretKey(settingKey) {
  const encrypted = getSettingValue(`${settingKey}_encrypted`);
  if (encrypted && safeStorage.isEncryptionAvailable()) {
    try { return safeStorage.decryptString(Buffer.from(encrypted, 'base64')); } catch {}
  }
  return getSettingValue(settingKey) || null;
}

function storeSecretKey(settingKey, secret) {
  db.run(`DELETE FROM settings WHERE key IN ('${settingKey}', '${settingKey}_encrypted')`);
  if (!secret) return;
  if (safeStorage.isEncryptionAvailable()) {
    db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
      `${settingKey}_encrypted`, safeStorage.encryptString(String(secret)).toString('base64')
    ]);
  } else {
    db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [settingKey, String(secret)]);
  }
}

function getAiConfig() {
  const provider = providerById(getSettingValue(AI_SETTING_KEYS.provider) || PROVIDER_GEMINI);
  let apiKey = readSecretKey('ai_key');
  if (!apiKey && provider.id === PROVIDER_GEMINI) apiKey = readSecretKey('gemini_key');
  return {
    provider: provider.id,
    label: provider.label,
    model: getSettingValue(AI_SETTING_KEYS.model) || provider.defaultModel,
    baseUrl: getSettingValue(AI_SETTING_KEYS.baseUrl) || provider.baseUrl,
    prompt: getSettingValue(AI_SETTING_KEYS.prompt) || DEFAULT_AI_PROMPT,
    apiKey: apiKey || '',
    hasKey: Boolean(apiKey)
  };
}

ipcMain.handle('save-gemini-key', (event, key) => {
  storeSecretKey('gemini_key', key);
  saveDb();
  return true;
});

ipcMain.handle('get-gemini-key', () => readSecretKey('gemini_key'));

ipcMain.handle('get-ai-providers', () => AI_PROVIDERS);

ipcMain.handle('get-ai-config', () => getAiConfig());

ipcMain.handle('save-ai-config', (event, config = {}) => {
  const provider = providerById(config.provider);
  setSettingValue(AI_SETTING_KEYS.provider, provider.id);
  setSettingValue(AI_SETTING_KEYS.model, String(config.model || '').trim() || provider.defaultModel);
  setSettingValue(AI_SETTING_KEYS.baseUrl, String(config.baseUrl || '').trim() || provider.baseUrl);
  setSettingValue(AI_SETTING_KEYS.prompt, String(config.prompt || '').trim() || DEFAULT_AI_PROMPT);

  const secret = String(config.apiKey || '').trim();
  const current = getAiConfig();
  if (secret === KEEP_STORED_SECRET) {
    // Keep the stored key, but move a legacy Gemini key into the new slot.
    if (current.apiKey) storeSecretKey('ai_key', current.apiKey);
  } else if (secret) {
    storeSecretKey('ai_key', secret);
  } else {
    storeSecretKey('ai_key', '');
  }
  db.run("DELETE FROM settings WHERE key IN ('gemini_key', 'gemini_key_encrypted')");
  saveDb();
  const saved = getAiConfig();
  return { ok: true, config: { ...saved, apiKey: saved.hasKey ? KEEP_STORED_SECRET : '' } };
});

// Small blank image used by the "test connection" button; keeps the probe cheap.
async function probeAiConfig() {
  const config = getAiConfig();
  if (!config.hasKey) throw new Error('请先填写 API Key');
  const pixelPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64'
  ).toString('base64');
  const text = await requestVision(config, pixelPng, 'image/png');
  return { ok: true, sample: String(text).slice(0, 120) };
}

ipcMain.handle('test-ai-config', async () => {
  try {
    return await probeAiConfig();
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('ai-tag-single', async (event, id) => {
  const aiConfig = getAiConfig();
  if (!aiConfig.hasKey) return { ok: false, error: `请先在设置中配置 ${aiConfig.label} API Key` };

  const photoResult = db.exec("SELECT path, ext FROM photos WHERE id = ?", [id]);
  if (!photoResult.length || !photoResult[0].values.length) return { ok: false, error: 'Photo not found' };
  const [photoPath, ext] = photoResult[0].values[0];

  try {
    const imageBuffer = await fsp.readFile(photoPath);
    // Resize large images to reduce API payload
    const resized = await sharp(imageBuffer, { failOn: 'none' })
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    const base64 = resized.toString('base64');

    const tagsText = await requestVision(aiConfig, base64, 'image/jpeg');

    // Merge with existing tags
    const existing = db.exec("SELECT tags FROM photos WHERE id = ?", [id]);
    const currentTags = (existing[0]?.values[0]?.[0] || '').split(',').map(s => s.trim()).filter(Boolean);
    const newTags = parseTags(tagsText);
    const merged = [...new Set([...currentTags, ...newTags])].join(',');

    db.run("UPDATE photos SET tags = ?, xmp_synced = 0 WHERE id = ?", [merged, id]);
    saveDb();
    return { ok: true, tags: merged };
  } catch (err) {
    logger.warn(`AI 识别失败 id=${id}: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('ai-tag-batch', async (event, ids) => {
  const aiConfig = getAiConfig();
  if (!aiConfig.hasKey) return { ok: false, error: `请先在设置中配置 ${aiConfig.label} API Key` };

  let success = 0;
  let failed = 0;
  let processed = 0;
  let lastError = '';

  for (const id of ids) {
    try {
      const photoResult = db.exec("SELECT path FROM photos WHERE id = ?", [id]);
      if (!photoResult.length || !photoResult[0].values.length) { failed++; continue; }
      const photoPath = photoResult[0].values[0][0];

      const imageBuffer = await fsp.readFile(photoPath);
      const resized = await sharp(imageBuffer, { failOn: 'none' })
        .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
      const base64 = resized.toString('base64');

      const tagsText = await requestVision(aiConfig, base64, 'image/jpeg');

      const existing = db.exec("SELECT tags FROM photos WHERE id = ?", [id]);
      const currentTags = (existing[0]?.values[0]?.[0] || '').split(',').map(s => s.trim()).filter(Boolean);
      const newTags = parseTags(tagsText);
      const merged = [...new Set([...currentTags, ...newTags])].join(',');
      db.run("UPDATE photos SET tags = ?, xmp_synced = 0 WHERE id = ?", [merged, id]);
      success++;
    } catch (err) {
      lastError = err.message;
      failed++;
    }
    processed++;
    event.sender.send('ai-tag-progress', { processed, total: ids.length, success, failed, lastError });
  }
  saveDb();
  return { ok: true, success, failed, lastError };
});

ipcMain.handle('fix-missing-thumbs', async (event) => {
  const results = db.exec("SELECT id, path, ext FROM photos WHERE thumb_path IS NULL");
  if (!results.length || !results[0].values.length) return { ok: true, fixed: 0, total: 0 };

  const columns = results[0].columns;
  const rows = results[0].values;
  let fixed = 0;

  for (const row of rows) {
    const obj = {};
    columns.forEach((col, i) => obj[col] = row[i]);
    const isRaw = RAW_EXTENSIONS.has(obj.ext) ? 1 : 0;
    const thumbPath = await generateThumb(obj.path, obj.id, isRaw);
    if (thumbPath) {
      const colorHash = computeColorHash(thumbPath);
      db.run("UPDATE photos SET thumb_path = ?, color_hash = ? WHERE id = ?", [thumbPath, colorHash, obj.id]);
      fixed++;
    }
    if (fixed % 10 === 0 && fixed > 0) {
      event.sender.send('fix-progress', { fixed });
    }
  }
  saveDb();
  return { ok: true, fixed, total: rows.length };
});
// --- Pagination support ---
ipcMain.handle('get-photos-paged', (event, options = {}) => {
  const { page = 0, perPage = 100, sortBy = 'date_taken', sortDir = 'DESC',
          filter = '', searchQuery = '' } = options;

  let where = ['deleted = 0'];
  let params = [];
  if (filter === 'gps') where.push('has_gps = 1');
  if (filter === 'raw') where.push('is_raw = 1');
  if (filter === 'starred') where.push('starred = 1');
  if (/^[1-5]$/.test(filter)) { where.push('rating >= ?'); params.push(Number(filter)); }
  if (options.dateFrom) { where.push('date_taken >= ?'); params.push(options.dateFrom); }
  if (options.dateTo) { where.push('date_taken <= ?'); params.push(options.dateTo + 'T23:59:59'); }
  if (filter === 'jpg') where.push("ext NOT IN ('.nef','.cr2','.cr3','.arw','.dng','.orf','.raf','.rw2')");
  if (searchQuery) {
    where.push('(filename LIKE ? OR tags LIKE ? OR date_taken LIKE ?)');
    const q = `%${searchQuery}%`;
    params.push(q, q, q);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const validSorts = ['date_taken', 'filename', 'size', 'id'];
  const sort = validSorts.includes(sortBy) ? sortBy : 'date_taken';
  const dir = sortDir === 'ASC' ? 'ASC' : 'DESC';
  const offset = page * perPage;

  const sql = `
    SELECT id, path, filename, ext, size, width, height, date_taken, starred,
           camera_make, camera_model, iso, aperture, shutter, focal_length,
           gps_lat, gps_lon, tags, faces, thumb_path, is_raw, has_gps,
           rating, color_label, edited_at
    FROM photos ${whereClause}
    ORDER BY ${sort} ${dir}
    LIMIT ? OFFSET ?
  `;
  params.push(perPage, offset);

  const results = db.exec(sql, params);
  if (results.length === 0) return [];
  const columns = results[0].columns;
  return results[0].values.map(row => {
    const obj = {};
    columns.forEach((col, i) => obj[col] = row[i]);
    return obj;
  });
});

ipcMain.handle('delete-photo', (event, id) => {
  const r = db.exec("SELECT path FROM photos WHERE id = ?", [id]);
  if (!r.length || !r[0].values.length) return false;
  db.run("DELETE FROM photos WHERE id = ?", [id]);
  saveDb();
  return true;
});

ipcMain.handle('delete-photo-disk', async (event, id) => {
  const r = db.exec("SELECT path, thumb_path FROM photos WHERE id = ?", [id]);
  if (!r.length || !r[0].values.length) return false;
  const [filePath, thumbPath] = r[0].values[0];
  if (filePath) await shell.trashItem(filePath);
  if (thumbPath) { try { await fsp.unlink(thumbPath); } catch {} }
  const prevPath = filePath ? path.join(__dirname, 'data', 'previews', path.basename(filePath, path.extname(filePath)) + '.webp') : null;
  if (prevPath) { try { await fsp.unlink(prevPath); } catch {} }
  db.run("DELETE FROM photos WHERE id = ?", [id]);
  saveDb();
  return true;
});

ipcMain.handle('delete-photo-permanent', async (event, id) => {
  const row = db.exec('SELECT id FROM photos WHERE id = ?', [id]).at(0)?.values?.[0];
  if (!row) return false;
  db.run('DELETE FROM photo_versions WHERE photo_id = ?', [Number(id)]);
  db.run('DELETE FROM album_photos WHERE photo_id = ?', [Number(id)]);
  db.run('DELETE FROM photos WHERE id = ?', [Number(id)]);
  saveDb();
  return true;
});

ipcMain.handle('toggle-star', (event, id) => {
  db.run("UPDATE photos SET starred = CASE WHEN starred = 1 THEN 0 ELSE 1 END WHERE id = ?", [id]);
  saveDb();
  const r = db.exec("SELECT starred FROM photos WHERE id = ?", [id]);
  return r.length && r[0].values.length ? r[0].values[0][0] : 0;
});

// --- Recycle Bin ---
ipcMain.handle('soft-delete-photo', (event, id) => {
  db.run("UPDATE photos SET deleted = 1 WHERE id = ?", [id]);
  saveDb();
  return true;
});

ipcMain.handle('restore-photo', (event, id) => {
  db.run("UPDATE photos SET deleted = 0 WHERE id = ?", [id]);
  saveDb();
  return true;
});

ipcMain.handle('get-deleted-photos', () => {
  const r = db.exec("SELECT id, filename, path, date_taken, thumb_path FROM photos WHERE deleted = 1 ORDER BY id DESC");
  if (!r.length) return [];
  const cols = r[0].columns;
  return r[0].values.map(row => { const o = {}; cols.forEach((c,i)=>o[c]=row[i]); return o; });
});

// --- Travel route lines ---
ipcMain.handle('get-travel-routes', (event, dayKey) => {
  let sql = "SELECT id, gps_lat, gps_lon, date_taken FROM photos WHERE has_gps = 1 AND deleted = 0";
  let params = [];
  if (dayKey) {
    sql += " AND date_taken LIKE ?";
    params.push(dayKey + '%');
  }
  sql += " ORDER BY date_taken ASC";
  const r = db.exec(sql, params);
  if (!r.length) return [];
  const cols = r[0].columns;
  return r[0].values.map(row => { const o = {}; cols.forEach((c,i)=>o[c]=row[i]); return o; });
});

// --- Location auto-grouping ---
ipcMain.handle('get-location-groups', () => {
  // Simple grid-based clustering: group by ~0.1 degree cells
  const r = db.exec(`
    SELECT CAST(gps_lat * 10 AS INTEGER) / 10.0 as lat_cell,
           CAST(gps_lon * 10 AS INTEGER) / 10.0 as lon_cell,
           COUNT(*) as count,
           MIN(date_taken) as first_date,
           MAX(date_taken) as last_date,
           AVG(gps_lat) as avg_lat,
           AVG(gps_lon) as avg_lon
    FROM photos WHERE has_gps = 1 AND deleted = 0
    GROUP BY lat_cell, lon_cell
    HAVING COUNT(*) >= 3
    ORDER BY COUNT(*) DESC LIMIT 50
  `);
  if (!r.length) return [];
  const cols = r[0].columns;
  return r[0].values.map(row => { const o = {}; cols.forEach((c,i)=>o[c]=row[i]); return o; });
});

// --- GPS correction ---
ipcMain.handle('set-gps', (event, id, lat, lon) => {
  db.run("UPDATE photos SET gps_lat = ?, gps_lon = ?, has_gps = 1 WHERE id = ?", [lat, lon, id]);
  saveDb();
  return true;
});

// --- Batch rename planning and execution ---
const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)
]);

function safeFilenameStem(value) {
  let stem = String(value || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  stem = stem.replace(/[.\s]+$/g, '') || 'photo';
  const display = stem.replace(/\.+$/, '');
  if (WINDOWS_RESERVED_NAMES.has(display.toUpperCase())) stem = `${stem}_`;
  return stem;
}

async function buildRenamePlan(ids, options = {}) {
  const opts = {
    template: '{date}_{seq}',
    sort: 'selection',
    dateSource: 'taken',
    start: 1,
    padding: 4,
    nameCase: 'original',
    spacesToUnderscores: false,
    extCase: 'original',
    conflict: 'suffix',
    ...options
  };
  opts.template = String(opts.template || '{date}_{seq}').slice(0, 180);
  opts.start = Math.max(0, parseInt(opts.start, 10) || 0);
  opts.padding = clamp(parseInt(opts.padding, 10) || 0, 0, 8);

  const wanted = new Set((Array.isArray(ids) ? ids : []).map(Number));
  const rows = db.exec(`
    SELECT id, path, filename, date_taken, camera_model
    FROM photos WHERE deleted = 0
  `);
  const selected = [];
  if (rows.length && rows[0].values.length) {
    const cols = rows[0].columns;
    for (const values of rows[0].values) {
      const row = Object.fromEntries(cols.map((key, index) => [key, values[index]]));
      if (!wanted.has(row.id)) continue;
      selected.push({
        id: row.id,
        path: row.path,
        oldName: row.filename || path.basename(row.path),
        dateTaken: row.date_taken,
        camera: row.camera_model || ''
      });
    }
  }

  const sorters = {
    selection: null,
    date_asc: (a, b) => (safeTime(a.dateTaken) || Infinity) - (safeTime(b.dateTaken) || Infinity),
    date_desc: (a, b) => (safeTime(b.dateTaken) || -Infinity) - (safeTime(a.dateTaken) || -Infinity),
    filename: (a, b) => a.oldName.localeCompare(b.oldName, 'zh-Hans-CN', { numeric: true })
  };
  if (sorters[opts.sort]) selected.sort(sorters[opts.sort]);

  const usedNames = new Map();
  for (const item of selected) {
    item.date = await renameDateFor(item, opts.dateSource);
    const originalExt = path.extname(item.path || item.oldName);
    const stemInput = opts.template.replace(/\{(Y|M|D|YYYY|MM|DD|HH|mm|ss|datetime|date|time|orig|camera|folder|id)\}/g, (token) => {
      switch (token) {
        case '{Y}': case '{YYYY}': return String(item.date.getFullYear());
        case '{M}': case '{MM}': return String(item.date.getMonth() + 1).padStart(token === '{M}' ? 1 : 2, '0');
        case '{D}': case '{DD}': return String(item.date.getDate()).padStart(token === '{D}' ? 1 : 2, '0');
        case '{HH}': return String(item.date.getHours()).padStart(2, '0');
        case '{mm}': return String(item.date.getMinutes()).padStart(2, '0');
        case '{ss}': return String(item.date.getSeconds()).padStart(2, '0');
        case '{datetime}': return `${isoDate(item.date)}_${isoTime(item.date)}`;
        case '{date}': return isoDate(item.date);
        case '{time}': return isoTime(item.date);
        case '{orig}': return path.basename(item.oldName, path.extname(item.oldName));
        case '{camera}': return item.camera;
        case '{folder}': return path.basename(path.dirname(item.path));
        case '{id}': return String(item.id);
        default: return '';
      }
    });

    // Sequence needs the final sorted order, so assign it in a second pass below.
    item.stemBase = safeFilenameStem(stemInput);
    item.ext = opts.extCase === 'lower' ? originalExt.toLowerCase()
      : opts.extCase === 'upper' ? originalExt.toUpperCase()
      : originalExt;
  }

  selected.forEach((item, index) => {
    const seq = opts.start + index;
    let stem = item.stemBase.replace(/\{seq\}/g, String(seq).padStart(opts.padding, '0'))
      .replace(/\{n\}/g, String(seq));
    if (opts.spacesToUnderscores) stem = stem.replace(/\s+/g, '_');
    stem = safeFilenameStem(stem);
    if (opts.nameCase === 'lower') stem = stem.toLowerCase();
    if (opts.nameCase === 'upper') stem = stem.toUpperCase();

    const dir = path.dirname(item.path);
    let newName = `${stem}${item.ext}`;
    let newPath = path.join(dir, newName);
    let conflict = false;
    const key = newPath.toLowerCase();

    if (usedNames.has(key)) {
      conflict = true;
    } else if (item.oldName.toLowerCase() !== newName.toLowerCase() && fs.existsSync(newPath)) {
      conflict = true;
    }

    if (conflict && opts.conflict === 'suffix') {
      let suffix = 1;
      do {
        newName = `${stem}-${suffix}${item.ext}`;
        newPath = path.join(dir, newName);
        suffix++;
      } while ((usedNames.has(newPath.toLowerCase()) ||
               (item.oldName.toLowerCase() !== newName.toLowerCase() && fs.existsSync(newPath))) && suffix < 10000);
      conflict = false;
    }

    usedNames.set(newPath.toLowerCase(), item.id);
    item.newName = newName;
    item.newPath = newPath;
    item.status = item.oldName === newName ? 'unchanged'
      : conflict && opts.conflict !== 'suffix' ? 'skipped' : 'ready';
  });

  return { options: opts, items: selected };
}

function safeTime(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function isoDate(date) {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
}

function isoTime(date) {
  return `${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}${String(date.getSeconds()).padStart(2, '0')}`;
}

async function renameDateFor(item, source) {
  if (source === 'today') return new Date();
  if (source === 'modified') {
    try { return (await fsp.stat(item.path)).mtime; } catch {}
  }
  const time = safeTime(item.dateTaken);
  if (time) return new Date(time);
  try { return (await fsp.stat(item.path)).mtime; } catch {}
  return new Date(0);
}

ipcMain.handle('preview-batch-rename', async (event, ids, options) => {
  const plan = await buildRenamePlan(ids, options);
  return {
    ok: true,
    total: plan.items.length,
    ready: plan.items.filter(i => i.status === 'ready').length,
    unchanged: plan.items.filter(i => i.status === 'unchanged').length,
    skipped: plan.items.filter(i => i.status === 'skipped').length,
    items: plan.items.slice(0, 200).map(({ id, oldName, newName, path: oldPath, newPath, status }) => ({
      id, oldName, newName, oldPath, newPath, status
    }))
  };
});

ipcMain.handle('batch-rename', async (event, ids, patternOrOptions) => {
  const options = typeof patternOrOptions === 'string'
    ? { template: patternOrOptions }
    : (patternOrOptions || {});
  const plan = await buildRenamePlan(ids, options);
  let renamed = 0, skipped = 0;
  const errors = [];
  const total = plan.items.length;

  for (const [index, item] of plan.items.entries()) {
    event.sender.send('rename-progress', { current: index + 1, total, name: item.newName });
    if (item.status === 'unchanged') { skipped++; continue; }
    if (item.status === 'skipped') { skipped++; continue; }
    try {
      if (fs.existsSync(item.newPath)) throw new Error('目标文件已存在');
      await fsp.rename(item.path, item.newPath);
      db.run("UPDATE photos SET path = ?, filename = ? WHERE id = ?", [item.newPath, item.newName, item.id]);
      renamed++;
    } catch (error) {
      skipped++;
      errors.push({ id: item.id, name: item.oldName, message: error.message });
    }
  }
  saveDb();
  return { ok: errors.length === 0, renamed, skipped, total, errors };
});

// --- Export selected as HTML gallery ---
ipcMain.handle('export-html', async (event, ids) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出相册',
    defaultPath: path.join(app.getPath('desktop'), 'gallery.html'),
    filters: [{ name: 'HTML', extensions: ['html'] }]
  });
  if (result.canceled || !result.filePath) return { ok: false };
  let html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Photo Gallery</title><style>body{background:#111;color:#eee;font-family:sans-serif;display:flex;flex-wrap:wrap;gap:8px;padding:20px}img{max-width:400px;border-radius:8px}</style></head><body>\n';
  let copied = 0;
  const exportDir = path.dirname(result.filePath);
  const assetsDir = path.join(exportDir, 'photos');
  await fsp.mkdir(assetsDir, { recursive: true });
  for (const id of ids) {
    const r = db.exec("SELECT path, filename FROM photos WHERE id = ?", [id]);
    if (!r.length || !r[0].values.length) continue;
    const [p, fn] = r[0].values[0];
    try { await fsp.copyFile(p, path.join(assetsDir, fn)); } catch { continue; }
    html += '<img src="photos/' + fn + '" alt="' + fn + '">\n';
    copied++;
  }
  html += '</body></html>';
  await fsp.writeFile(result.filePath, html, 'utf8');
  return { ok: true, copied, filePath: result.filePath };
});

// --- Statistics ---
ipcMain.handle('get-statistics', () => {
  const monthly = db.exec(`
    SELECT substr(date_taken, 1, 7) as month, COUNT(*) as count
    FROM photos WHERE date_taken IS NOT NULL AND deleted = 0
    GROUP BY month ORDER BY month DESC LIMIT 24
  `);
  const cameras = db.exec(`
    SELECT camera_model, COUNT(*) FROM photos
    WHERE camera_model IS NOT NULL AND deleted = 0
    GROUP BY camera_model ORDER BY COUNT(*) DESC LIMIT 5
  `);
  const lenses = db.exec(`
    SELECT lens_model, COUNT(*) FROM photos
    WHERE lens_model IS NOT NULL AND deleted = 0 GROUP BY lens_model ORDER BY COUNT(*) DESC LIMIT 8
  `);
  const focalLengths = db.exec(`
    SELECT ROUND(focal_length), COUNT(*) FROM photos
    WHERE focal_length IS NOT NULL AND deleted = 0 GROUP BY ROUND(focal_length) ORDER BY ROUND(focal_length)
  `);
  const apertures = db.exec(`
    SELECT ROUND(aperture,1), COUNT(*) FROM photos
    WHERE aperture IS NOT NULL AND deleted = 0 GROUP BY ROUND(aperture,1) ORDER BY 1
  `);
  const locations = db.exec(`
    SELECT CAST(gps_lat * 10 AS INT)/10.0 || ',' || CAST(gps_lon * 10 AS INT)/10.0 as loc, COUNT(*)
    FROM photos WHERE has_gps = 1 AND deleted = 0
    GROUP BY loc ORDER BY COUNT(*) DESC LIMIT 10
  `);
  const starred = db.exec("SELECT COUNT(*) FROM photos WHERE starred = 1 AND deleted = 0")[0].values[0][0];
  const total = db.exec("SELECT COUNT(*) FROM photos WHERE deleted = 0")[0].values[0][0];
  const withGps = db.exec("SELECT COUNT(*) FROM photos WHERE has_gps = 1 AND deleted = 0")[0].values[0][0];

  function rows(q) { return q && q.length ? q[0].values : []; }
  return {
    monthly: rows(monthly),
    cameras: rows(cameras),
    lenses: rows(lenses),
    focalLengths: rows(focalLengths),
    apertures: rows(apertures),
    locations: rows(locations),
    starred, total, withGps
  };
});

// --- Burst detection ---
ipcMain.handle('find-bursts', () => {
  const r = db.exec(`
    SELECT p1.id, p1.filename, p2.id, p2.filename, p1.date_taken
    FROM photos p1 JOIN photos p2
      ON abs(julianday(p1.date_taken) - julianday(p2.date_taken)) < 0.00001
      AND p1.id < p2.id AND p1.has_gps = p2.has_gps AND p1.deleted = 0
    LIMIT 200
  `);
  if (!r.length) return [];
  return r[0].values.map(v => ({ a: v[0], aName: v[1], b: v[2], bName: v[3], time: v[4] }));
});

ipcMain.handle('save-app-setting', (event, key, value) => {
  if (HIDDEN_SETTING_KEYS.has(String(key))) return false;
  db.run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [key, String(value)]);
  saveDb();
  return true;
});

const HIDDEN_SETTING_KEYS = new Set([
  'gemini_key', 'gemini_key_encrypted', 'ai_key', 'ai_key_encrypted'
]);

ipcMain.handle('get-app-settings', () => {
  const r = db.exec("SELECT key, value FROM settings");
  if (!r.length) return {};
  const obj = {};
  r[0].values.forEach(v => { if (!HIDDEN_SETTING_KEYS.has(v[0])) obj[v[0]] = v[1]; });
  return obj;
});

ipcMain.handle('import-watermark-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '导入水印',
    filters: [{ name: 'Watermark Image', extensions: ['png', 'webp', 'jpg', 'jpeg'] }],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return { ok: true, imported: false };

  try {
    const sourcePath = result.filePaths[0];
    const ext = path.extname(sourcePath).toLowerCase();
    if (!['.png', '.webp', '.jpg', '.jpeg'].includes(ext)) throw new Error('请选择 PNG、WebP 或 JPG 水印图片');
    const metadata = await sharp(sourcePath, { failOn: 'none' }).metadata();
    if (!metadata.width || !metadata.height) throw new Error('无法读取水印尺寸');

    await fsp.mkdir(WATERMARK_ASSET_DIR, { recursive: true });
    const watermarkPath = path.join(WATERMARK_ASSET_DIR, `watermark${ext}`);
    await fsp.copyFile(sourcePath, watermarkPath);
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('watermark_path', ?)", [watermarkPath]);
    saveDb();
    return { ok: true, imported: true, path: watermarkPath };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('get-watermark', async () => {
  try {
    const watermarkPath = await getWatermarkSetting();
    if (!watermarkPath || !fs.existsSync(watermarkPath)) return null;
    const metadata = await sharp(watermarkPath, { failOn: 'none' }).metadata();
    return {
      path: watermarkPath,
      filename: path.basename(watermarkPath),
      width: metadata.width || 0,
      height: metadata.height || 0,
      hasAlpha: Boolean(metadata.hasAlpha)
    };
  } catch {
    return null;
  }
});

ipcMain.handle('remove-watermark', () => {
  db.run("DELETE FROM settings WHERE key = 'watermark_path'");
  saveDb();
  return true;
});

ipcMain.handle('apply-watermark', async (event, ids, options = {}) => {
  const targets = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isFinite);
  if (!targets.length) return { ok: false, error: '请先选择照片' };
  const watermarkPath = await getWatermarkSetting();
  if (!watermarkPath || !fs.existsSync(watermarkPath)) {
    return { ok: false, error: '请先在设置中导入水印' };
  }

  let done = 0;
  let failed = 0;
  for (const [index, id] of targets.entries()) {
    mainWindow?.webContents.send('watermark-progress', { processed: index + 1, total: targets.length });
    try {
      await applyWatermarkToPhoto(id, watermarkPath, options);
      done++;
    } catch (error) {
      console.error(`Watermark failed for ${id}:`, error.message);
      failed++;
    }
  }
  saveDb();
  return { ok: failed === 0, done, failed, total: targets.length };
});

ipcMain.handle('apply-compression', async (event, ids, options = {}) => {
  const targets = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isFinite);
  if (!targets.length) return { ok: false, error: '请先选择照片' };

  let done = 0;
  let failed = 0;
  const paths = [];
  for (const [index, id] of targets.entries()) {
    mainWindow?.webContents.send('compression-progress', { processed: index + 1, total: targets.length });
    try {
      const result = await compressPhotoToPhoto(id, options);
      paths.push(result.path);
      done++;
    } catch (error) {
      console.error(`Compression failed for ${id}:`, error.message);
      failed++;
    }
  }
  saveDb();
  return { ok: failed === 0, done, failed, total: targets.length, paths };
});

ipcMain.handle('get-raw-preview', async (event, id) => {
  return await getRawPreviewFile(id);
});

ipcMain.handle('get-display-photo', async (event, id, preferEdited = true, priority = 0) => {
  try {
    return await getDisplayImage(Number(id), preferEdited !== false, Number(priority) || 0);
  } catch (error) {
    console.error(`Display preview failed for ${id}:`, error.message);
    return null;
  }
});

// --- Lightroom preset editing ---
ipcMain.handle('import-preset-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '导入 Lightroom 预设',
    filters: [{ name: 'Lightroom Presets', extensions: ['xmp', 'lrtemplate'] }],
    properties: ['openFile', 'multiSelections']
  });
  if (result.canceled || !result.filePaths.length) return { ok: true, imported: 0, failed: 0 };

  let imported = 0;
  let failed = 0;
  for (const filePath of result.filePaths) {
    try {
      const parsed = parseLightroomPreset(filePath);
      if (!parsed.supportedCount) throw new Error('没有找到可识别的参数');
      db.run("INSERT OR REPLACE INTO presets (name, source_path, settings_json) VALUES (?, ?, ?)", [
        parsed.name, filePath, JSON.stringify(parsed.settings)
      ]);
      imported++;
    } catch {
      failed++;
    }
  }
  saveDb();
  return { ok: true, imported, failed };
});

ipcMain.handle('list-presets', () => {
  const r = db.exec("SELECT id, name, source_path, settings_json, created_at FROM presets ORDER BY name COLLATE NOCASE");
  if (!r.length) return [];
  return r[0].values.map(([id, name, sourcePath, json, createdAt]) => ({
    id, name, source_path: sourcePath,
    supported_count: Object.keys((() => { try { return JSON.parse(json); } catch { return {}; } })()).length,
    created_at: createdAt
  }));
});

ipcMain.handle('delete-preset', (event, id) => {
  db.run("DELETE FROM presets WHERE id = ?", [id]);
  saveDb();
  return true;
});

ipcMain.handle('preview-photo-edit', async (event, id, presetId, intensity = 100) => {
  try {
    const result = await renderEditedImage(id, presetId, intensity, 'preview');
    return { ok: true, path: result.path, approximated: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

async function regenerateThumbnailFromImage(photoId, imagePath) {
  await sharp(imagePath, { failOn: 'none' }).rotate()
    .resize(400, 400, { fit: 'inside' })
    .webp({ quality: 82 })
    .toFile(path.join(THUMB_DIR, `${photoId}.webp`));
}

ipcMain.handle('apply-photo-edit', async (event, id, presetId, intensity = 100) => {
  try {
    const result = await renderEditedImage(id, presetId, intensity, 'final');
    await regenerateThumbnailFromImage(id, result.path);
    await setPhotoEdit(id, result.path, { presetId, intensity, name: result.name }, 'edit', EDIT_ENGINE_VERSION);
    saveDb();
    return { ok: true, path: result.path, name: result.name };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('reset-photo-edit', async (event, id) => {
  try {
    const r = db.exec("SELECT path, ext, is_raw FROM photos WHERE id = ?", [id]);
    if (!r.length || !r[0].values.length) return { ok: false, error: '照片不存在' };
    const [originalPath, ext, isRaw] = r[0].values[0];

    if (isRaw) {
      const thumb = await generateThumb(originalPath, id, Boolean(isRaw));
      if (!thumb && fs.existsSync(path.join(THUMB_DIR, `${id}.webp`))) {
        // Keep the existing thumbnail when the RAW contains no usable preview.
      }
    } else {
      await generateThumb(originalPath, id, false);
    }

    for (const file of await fsp.readdir(EDIT_DIR)) {
      if (file.startsWith(`${id}-`) && ['.jpg', '.jpeg'].includes(path.extname(file).toLowerCase())) {
        const target = path.join(EDIT_DIR, file);
        // Windows can hold a just-written JPEG briefly; a stale cache is harmless.
        if (path.resolve(target).startsWith(path.resolve(EDIT_DIR))) {
          try { await fsp.unlink(target); } catch {}
        }
      }
    }
    db.run("UPDATE photo_versions SET is_active = 0 WHERE photo_id = ?", [Number(id)]);
    db.run("UPDATE photos SET edit_path = NULL, edit_settings = NULL, edited_at = NULL WHERE id = ?", [id]);
    saveDb();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('export-photo-edit', async (event, id) => {
  const r = db.exec("SELECT filename, edit_path FROM photos WHERE id = ?", [id]);
  if (!r.length || !r[0].values.length || !r[0].values[0][1]) {
    return { ok: false, error: '请先保存修图结果' };
  }
  const [filename, editPath] = r[0].values[0];
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出修图副本',
    defaultPath: path.join(app.getPath('desktop'), path.parse(filename).name + '-edited.jpg'),
    filters: [{ name: 'JPEG', extensions: ['jpg'] }]
  });
  if (result.canceled || !result.filePath) return { ok: false };
  await fsp.copyFile(editPath, result.filePath);
  return { ok: true, path: result.filePath };
});

ipcMain.handle('set-rating', (event, id, rating) => {
  const value = Math.max(0, Math.min(5, Number(rating) || 0));
  db.run('UPDATE photos SET rating = ?, xmp_synced = 0 WHERE id = ?', [value, Number(id)]);
  saveDb();
  return value;
});

ipcMain.handle('set-color-label', (event, id, color) => {
  const allowed = new Set(['', 'red', 'yellow', 'green', 'blue']);
  const value = allowed.has(color) ? color : '';
  db.run('UPDATE photos SET color_label = ?, xmp_synced = 0 WHERE id = ?', [value, Number(id)]);
  saveDb();
  return value;
});

ipcMain.handle('get-photo-versions', (event, id) => {
  const result = db.exec(`
    SELECT v.id, v.photo_id, v.version_type, v.path, v.settings_json, v.engine,
           v.metadata_policy, v.size, v.is_active, v.created_at
    FROM photo_versions v WHERE v.photo_id = ? ORDER BY v.created_at DESC, v.id DESC
  `, [Number(id)]);
  if (!result.length) return [];
  const cols = result[0].columns;
  return result[0].values.map(values => Object.fromEntries(cols.map((col, index) => [col, values[index]])));
});

ipcMain.handle('activate-photo-version', async (event, id, versionId) => {
  const row = db.exec('SELECT path FROM photo_versions WHERE id = ? AND photo_id = ?', [
    Number(versionId), Number(id)
  ]).at(0)?.values?.[0];
  const original = db.exec('SELECT version_type FROM photo_versions WHERE id = ? AND photo_id = ?', [
    Number(versionId), Number(id)
  ]).at(0)?.values?.[0]?.[0] === 'original';
  if (!row) return { ok: false, error: '版本不存在' };
  const versionPath = row[0];
  await activatePhotoVersion(id, versionPath);
  if (original) {
    db.run("UPDATE photos SET edit_path = NULL, edit_settings = NULL, edited_at = NULL WHERE id = ?", [Number(id)]);
    const source = db.exec('SELECT path, ext, is_raw FROM photos WHERE id = ?', [Number(id)]).at(0)?.values?.[0];
    if (source) await generateThumb(source[0], Number(id), Boolean(source[2]));
  } else {
    db.run("UPDATE photos SET edit_path = ?, edited_at = datetime('now') WHERE id = ?", [versionPath, Number(id)]);
    await regenerateThumbnailFromImage(Number(id), versionPath);
  }
  saveDb();
  return { ok: true };
});

ipcMain.handle('list-albums', () => {
  const result = db.exec('SELECT id, name, kind, query_json, sort_order FROM albums ORDER BY sort_order, name').at(0);
  return result?.values.map(([id, name, kind, queryJson, sortOrder]) => ({
    id, name, kind, sort_order: sortOrder,
    query: (() => { try { return JSON.parse(queryJson || 'null'); } catch { return null; } })()
  })) || [];
});

ipcMain.handle('create-album', (event, name, kind = 'manual', query = null) => {
  if (!String(name || '').trim()) throw new Error('相册名称不能为空');
  const result = db.run('INSERT OR IGNORE INTO albums (name, kind, query_json) VALUES (?, ?, ?)', [
    String(name).trim(), ['manual','smart'].includes(kind) ? kind : 'manual', JSON.stringify(query || null)
  ]);
  saveDb();
  return { ok: Number(result.changes) > 0 };
});

ipcMain.handle('delete-album', (event, id) => {
  db.run('DELETE FROM albums WHERE id = ?', [Number(id)]);
  saveDb();
  return true;
});

ipcMain.handle('add-photos-to-album', (event, albumId, ids) => {
  for (const id of ids || []) {
    db.run('INSERT OR IGNORE INTO album_photos (album_id, photo_id) VALUES (?, ?)', [Number(albumId), Number(id)]);
  }
  saveDb();
  return true;
});

ipcMain.handle('remove-photo-from-album', (event, albumId, photoId) => {
  db.run('DELETE FROM album_photos WHERE album_id = ? AND photo_id = ?', [Number(albumId), Number(photoId)]);
  saveDb();
  return true;
});

ipcMain.handle('get-album-photos', (event, albumId, options = {}) => {
  const album = db.exec('SELECT kind, query_json FROM albums WHERE id = ?', [Number(albumId)]).at(0)?.values?.[0];
  if (!album) return [];
  const [kind, queryJson] = album;
  if (kind === 'smart') {
    let query = {};
    try { query = JSON.parse(queryJson || '{}'); } catch {}
    return runPhotoQuery({ ...options, ...query });
  }
  const result = db.exec(`
    SELECT p.* FROM photos p JOIN album_photos ap ON ap.photo_id = p.id
    WHERE ap.album_id = ? AND p.deleted = 0 ORDER BY p.date_taken DESC
  `, [Number(albumId)]);
  if (!result.length) return [];
  const cols = result[0].columns;
  return result[0].values.map(values => Object.fromEntries(cols.map((col,index)=>[col,values[index]])));
});

function runPhotoQuery(options = {}) {
  const where = ['deleted = 0']; const params = [];
  if (options.filter === 'gps') where.push('has_gps = 1');
  if (options.filter === 'raw') where.push('is_raw = 1');
  if (options.filter === 'jpg') where.push("ext IN ('.jpg','.jpeg')");
  if (/^[1-5]$/.test(String(options.minRating))) { where.push('rating >= ?'); params.push(Number(options.minRating)); }
  if (options.colorLabel) { where.push('color_label = ?'); params.push(options.colorLabel); }
  if (options.searchQuery) { where.push('(filename LIKE ? OR tags LIKE ?)'); const q=`%${options.searchQuery}%`; params.push(q,q); }
  const rows = db.exec(`SELECT * FROM photos WHERE ${where.join(' AND ')} ORDER BY date_taken DESC LIMIT ? OFFSET ?`, [...params, Number(options.limit||500), Number(options.offset||0)]);
  if (!rows.length) return [];
  const cols=rows[0].columns;
  return rows[0].values.map(values=>Object.fromEntries(cols.map((c,i)=>[c,values[i]])));
}

ipcMain.handle('job-start', (event, type, payload, options) => jobManager.submit(type, payload, options));
ipcMain.handle('sync-xmp', (event, ids) => {
  const targets = Array.from(new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger)));
  if (!targets.length) return { ok: false, error: '请先选择照片' };
  return { ok: true, jobId: jobManager.submit('xmp', { ids: targets }, { total: targets.length }) };
});
ipcMain.handle('get-clip-status', async () => ({
  ...(await clipSearch?.status() || { configured: false, indexed: 0, total: 0 }),
  modelPath: clipSearch?.modelPath || ''
}));
ipcMain.handle('configure-clip', async (event, modelPath) => {
  const normalized = String(modelPath || '').trim();
  if (normalized && !fs.existsSync(normalized)) return { ok: false, error: '本地模型路径不存在' };
  clipSearch.configure(normalized);
  db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['clip_model_path', normalized]);
  saveDb();
  return { ok: true, status: { ...(await clipSearch.status()), modelPath: clipSearch.modelPath } };
});
ipcMain.handle('start-clip-index', () => {
  if (!clipSearch?.modelPath) return { ok: false, error: '请先配置本地模型路径' };
  const total = db.exec('SELECT COUNT(*) FROM photos WHERE deleted = 0')[0].values[0][0];
  return { ok: true, jobId: jobManager.submit('clip-index', {}, { total }) };
});
ipcMain.handle('clip-search', (event, text, limit) => clipSearch?.search(text, limit) || { ok: false, reason: 'model-not-configured', items: [] });

ipcMain.handle('get-trips', () => {
  const result = db.exec(`
    SELECT id, gps_lat, gps_lon, date_taken, filename, thumb_path
    FROM photos WHERE has_gps = 1 AND deleted = 0 AND gps_lat IS NOT NULL AND gps_lon IS NOT NULL
    ORDER BY date_taken ASC, id ASC
  `);
  const cols = result[0]?.columns || [];
  const photos = result[0]?.values?.map(row => Object.fromEntries(cols.map((col, index) => [col, row[index]]))) || [];
  return splitTrips(photos).map(trip => ({
    ...trip,
    stays: clusterStayPoints(trip.photos)
  }));
});

ipcMain.handle('get-stay-points', () => {
  const trips = db.exec(`
    SELECT id, gps_lat, gps_lon, date_taken, filename, thumb_path
    FROM photos WHERE has_gps = 1 AND deleted = 0 AND gps_lat IS NOT NULL AND gps_lon IS NOT NULL
    ORDER BY date_taken ASC, id ASC
  `);
  const cols = trips[0]?.columns || [];
  const photos = trips[0]?.values?.map(row => Object.fromEntries(cols.map((col, index) => [col, row[index]]))) || [];
  return splitTrips(photos).flatMap((trip, tripIndex) => clusterStayPoints(trip.photos).map(stay => ({ ...stay, tripIndex })));
});

ipcMain.handle('get-gps-heatmap', () => {
  const result = db.exec('SELECT gps_lat, gps_lon FROM photos WHERE has_gps = 1 AND deleted = 0');
  return aggregateGpsGrid(result[0]?.values?.map(([gps_lat, gps_lon]) => ({ gps_lat, gps_lon })) || []);
});
ipcMain.handle('job-list', () => jobManager.list());
ipcMain.handle('job-pause', (event,id) => jobManager.pause(id));
ipcMain.handle('job-resume', (event,id) => jobManager.resume(id));
ipcMain.handle('job-cancel', (event,id) => jobManager.cancel(id));
ipcMain.handle('job-retry', (event,id) => jobManager.retry(id));
ipcMain.handle('job-clear-finished', () => jobManager.clearFinished());
ipcMain.handle('job-remove', (event, id) => {
  db.run("DELETE FROM jobs WHERE id = ? AND status IN ('done','cancelled','error')", [Number(id)]);
  return true;
});

let lastGeocodeAt = 0;
ipcMain.handle('reverse-geocode', async (event, lat, lon) => {
  const roundedLat = Math.round(Number(lat) * 10000) / 10000;
  const roundedLon = Math.round(Number(lon) * 10000) / 10000;
  if (!Number.isFinite(roundedLat) || !Number.isFinite(roundedLon)) throw new Error('坐标无效');
  const cacheKey = `${roundedLat.toFixed(4)},${roundedLon.toFixed(4)}`;
  const cached = db.exec('SELECT display_name, address_json FROM reverse_geocode_cache WHERE cache_key = ?', [cacheKey]).at(0)?.values?.[0];
  if (cached) return { displayName: cached[0], address: (()=>{try{return JSON.parse(cached[1]||'{}')}catch{return{}}})(), cached:true };
  const wait = Math.max(0, 1100 - (Date.now() - lastGeocodeAt));
  if (wait) await new Promise(resolve => setTimeout(resolve, wait));
  lastGeocodeAt = Date.now();
  const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${roundedLat}&lon=${roundedLon}&accept-language=zh-CN`, {
    headers: { 'User-Agent': 'PhoneBL/1.0 (https://github.com/blueicx/PhoneBL)' },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error(`Nominatim HTTP ${response.status}`);
  const data = await response.json();
  db.run(`INSERT INTO reverse_geocode_cache (cache_key,lat,lon,display_name,address_json) VALUES (?,?,?,?,?)
    ON CONFLICT(cache_key) DO UPDATE SET display_name=excluded.display_name, address_json=excluded.address_json`, [
    cacheKey, roundedLat, roundedLon, data.display_name || '', JSON.stringify(data.address || {})
  ]);
  saveDb();
  return { displayName: data.display_name || '', address: data.address || {}, cached:false };
});
ipcMain.handle('window-minimize', () => mainWindow.minimize());
ipcMain.handle('window-maximize', () => {
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle('window-close', () => mainWindow.close());














