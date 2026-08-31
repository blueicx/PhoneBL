const { execFile } = require('child_process');
const { promisify } = require('util');
const { exiftool } = require('exiftool-vendored');

const run = promisify(execFile);
const POLICIES = new Set(['keep-all', 'remove-gps', 'minimal-safe']);
const COLOR_LABELS = new Set(['red', 'orange', 'yellow', 'green', 'blue', 'purple']);

function normalizePolicy(policy) {
  return POLICIES.has(policy) ? policy : 'keep-all';
}

async function applyMetadataPolicy(outputPath, sourcePath, policy = 'keep-all') {
  const normalized = normalizePolicy(policy);
  if (normalized === 'keep-all') {
    await run(exiftool.exiftoolPath, [
      '-overwrite_original', '-TagsFromFile', sourcePath,
      '-Exif:All', '-XMP:All', '-IPTC:All', outputPath
    ], { windowsHide: true });
    return normalized;
  }

  if (normalized === 'remove-gps') {
    await run(exiftool.exiftoolPath, [
      '-overwrite_original', '-TagsFromFile', sourcePath,
      '-Exif:All', '-XMP:All', '-IPTC:All',
      '-GPS:All=', '-XMP:GPSLatitude=', '-XMP:GPSLongitude=',
      outputPath
    ], { windowsHide: true });
    return normalized;
  }

  await run(exiftool.exiftoolPath, [
    '-overwrite_original', '-Exif:All=', '-XMP:All=', '-IPTC:All=',
    '-TagsFromFile', sourcePath,
    '-Exif:DateTimeOriginal', '-Exif:Make', '-Exif:Model',
    '-Exif:LensModel', '-Exif:ISO', '-Exif:FNumber',
    '-Exif:ExposureTime', '-Exif:FocalLength', outputPath
  ], { windowsHide: true });
  return normalized;
}

async function readMetadata(filePath) {
  const result = await run(exiftool.exiftoolPath, ['-j', '-n', filePath], {
    windowsHide: true, maxBuffer: 1024 * 1024
  });
  try { return JSON.parse(result.stdout)[0] || {}; } catch { return {}; }
}

function buildXmpWriteArgs(photo, sidecarPath) {
  const args = ['-charset', 'filename=utf8', '-o', String(sidecarPath)];
  const tags = String(photo.tags || '').split(/[,，;；\n]/).map(tag => tag.trim()).filter(Boolean);
  for (const tag of [...new Set(tags)]) args.push(`-XMP:Subject=${tag}`);
  const rating = Number(photo.rating);
  if (Number.isInteger(rating) && rating >= 0 && rating <= 5) args.push(`-XMP:Rating=${rating}`);
  const label = String(photo.color_label || '').trim().toLowerCase();
  if (COLOR_LABELS.has(label)) args.push(`-XMP:Label=${label}`);
  args.push(String(photo.path));
  return args;
}

async function writeXmpSidecar(photo, deps = {}) {
  const runner = deps.run || run;
  const sidecarPath = deps.sidecarPath || `${photo.path}.xmp`;
  try {
    await runner(exiftool.exiftoolPath, buildXmpWriteArgs(photo, sidecarPath), { windowsHide: true });
    return { ok: true, synced: true, sidecarPath };
  } catch (error) {
    return { ok: false, synced: false, error: error.message || String(error) };
  }
}

module.exports = { applyMetadataPolicy, readMetadata, normalizePolicy, buildXmpWriteArgs, writeXmpSidecar };
