const { execFile } = require('child_process');
const { promisify } = require('util');
const { exiftool } = require('exiftool-vendored');

const run = promisify(execFile);
const POLICIES = new Set(['keep-all', 'remove-gps', 'minimal-safe']);

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

module.exports = { applyMetadataPolicy, readMetadata, normalizePolicy };
