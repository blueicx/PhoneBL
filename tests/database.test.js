'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openPhotoDatabase } = require('../src/database');

test('legacy databases are backed up and migrated to version stacks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'phonebl-db-'));
  const dbPath = path.join(root, 'photos.db');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      filename TEXT NOT NULL,
      ext TEXT,
      size INTEGER DEFAULT 0,
      width INTEGER DEFAULT 0,
      height INTEGER DEFAULT 0,
      date_taken TEXT,
      camera_make TEXT,
      camera_model TEXT,
      iso INTEGER,
      aperture REAL,
      shutter TEXT,
      focal_length REAL,
      gps_lat REAL,
      gps_lon REAL,
      orientation INTEGER DEFAULT 1,
      tags TEXT DEFAULT '',
      faces TEXT DEFAULT '',
      thumb_path TEXT,
      is_raw INTEGER DEFAULT 0,
      has_gps INTEGER DEFAULT 0,
      color_hash TEXT,
      starred INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  `);
  legacy.exec("INSERT INTO photos (path, filename, ext) VALUES ('C:/travel/test.jpg', 'test.jpg', '.jpg')");
  legacy.close();

  const db = await openPhotoDatabase(dbPath);
  assert.equal(db.exec('SELECT COUNT(*) FROM photos')[0].values[0][0], 1);
  assert.equal(db.exec('SELECT rating FROM photos')[0].values[0][0], 0);
  const version = db.exec('SELECT version_type, is_active FROM photo_versions')[0].values[0];
  assert.deepEqual(version, ['original', 1]);

  db.run('UPDATE photos SET rating = ? WHERE id = ?', [4, 1]);
  assert.equal(db.exec('SELECT rating FROM photos')[0].values[0][0], 4);
  assert.equal(db.exec("SELECT COUNT(*) FROM albums WHERE kind = 'manual'")[0].values[0][0], 0);

  db.close();
  const backups = await fs.readdir(path.join(root, 'backups'));
  assert.equal(backups.length, 1);
  await fs.rm(root, { recursive: true, force: true });
});
