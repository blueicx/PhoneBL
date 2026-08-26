const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function columnExists(database, table, column) {
  return database.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);
}

function addColumn(database, table, column, definition) {
  if (!columnExists(database, table, column)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

async function backupBeforeMigration(dbPath) {
  const backupDir = path.join(path.dirname(dbPath), 'backups');
  await fsp.mkdir(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(backupDir, `photos-pre-full-upgrade-${stamp}.db`);
  await fsp.copyFile(dbPath, target);
  await fsp.writeFile(path.join(path.dirname(dbPath), '.full-upgrade-backed-up'), target, 'utf8');
  return target;
}

function migrateSchema(rawDb) {
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT UNIQUE NOT NULL, filename TEXT NOT NULL,
      ext TEXT, size INTEGER DEFAULT 0, width INTEGER DEFAULT 0, height INTEGER DEFAULT 0,
      date_taken TEXT, camera_make TEXT, camera_model TEXT, iso INTEGER, aperture REAL,
      shutter TEXT, focal_length REAL, gps_lat REAL, gps_lon REAL, orientation INTEGER DEFAULT 1,
      tags TEXT DEFAULT '', faces TEXT DEFAULT '', thumb_path TEXT, is_raw INTEGER DEFAULT 0,
      has_gps INTEGER DEFAULT 0, color_hash TEXT, starred INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS presets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, source_path TEXT,
      settings_json TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS photo_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
      version_type TEXT NOT NULL DEFAULT 'edit', path TEXT NOT NULL, source_version_id INTEGER,
      settings_json TEXT, engine TEXT, metadata_policy TEXT NOT NULL DEFAULT 'keep-all',
      width INTEGER DEFAULT 0, height INTEGER DEFAULT 0, size INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 0, xmp_synced INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')), UNIQUE(photo_id, path)
    );
    CREATE TABLE IF NOT EXISTS albums (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'manual',
      query_json TEXT, sort_order INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), UNIQUE(name)
    );
    CREATE TABLE IF NOT EXISTS album_photos (
      album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
      photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
      added_at TEXT DEFAULT (datetime('now')), PRIMARY KEY(album_id, photo_id)
    );
    CREATE TABLE IF NOT EXISTS saved_searches (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, query_json TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')), UNIQUE(name)
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'queued', progress INTEGER DEFAULT 0, total INTEGER DEFAULT 0,
      message TEXT, result_json TEXT, error_text TEXT, attempts INTEGER DEFAULT 0,
      max_attempts INTEGER DEFAULT 3, created_at TEXT DEFAULT (datetime('now')),
      started_at TEXT, finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS reverse_geocode_cache (
      cache_key TEXT PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL, display_name TEXT,
      address_json TEXT, fetched_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_photos_date ON photos(date_taken);
    CREATE INDEX IF NOT EXISTS idx_photos_gps ON photos(has_gps);
    CREATE INDEX IF NOT EXISTS idx_photos_ext ON photos(ext);
    CREATE INDEX IF NOT EXISTS idx_photos_starred ON photos(starred);
    CREATE INDEX IF NOT EXISTS idx_versions_photo ON photo_versions(photo_id);
    CREATE INDEX IF NOT EXISTS idx_album_photos_photo ON album_photos(photo_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);
  `);

  addColumn(rawDb, 'photos', 'starred', 'INTEGER DEFAULT 0');
  addColumn(rawDb, 'photos', 'deleted', 'INTEGER DEFAULT 0');
  addColumn(rawDb, 'photos', 'edit_path', 'TEXT');
  addColumn(rawDb, 'photos', 'edit_settings', 'TEXT');
  addColumn(rawDb, 'photos', 'edited_at', 'TEXT');
  addColumn(rawDb, 'photos', 'rating', 'INTEGER DEFAULT 0');
  addColumn(rawDb, 'photos', 'color_label', 'TEXT');
  addColumn(rawDb, 'photos', 'perceptual_hash', 'TEXT');
  addColumn(rawDb, 'photos', 'xmp_synced', 'INTEGER DEFAULT 0');
  addColumn(rawDb, 'photos', 'lens_model', 'TEXT');
  rawDb.exec(`
    CREATE INDEX IF NOT EXISTS idx_photos_rating ON photos(rating);
    CREATE INDEX IF NOT EXISTS idx_photos_hash ON photos(perceptual_hash);
    CREATE INDEX IF NOT EXISTS idx_photos_deleted ON photos(deleted);
  `);
  rawDb.exec(`
    INSERT OR IGNORE INTO photo_versions (photo_id, version_type, path, settings_json, is_active)
    SELECT id, 'original', path, NULL, CASE WHEN edit_path IS NULL THEN 1 ELSE 0 END FROM photos WHERE path IS NOT NULL;
    INSERT OR IGNORE INTO photo_versions (photo_id, version_type, path, settings_json, engine, is_active)
    SELECT id, LOWER(COALESCE(json_extract(edit_settings, '$.type'), 'edit')), edit_path, edit_settings,
      COALESCE(json_extract(edit_settings, '$.engine'), 'legacy'), 1
    FROM photos WHERE edit_path IS NOT NULL AND edit_path != '';
  `);
}

function toArrayParams(params) {
  if (params == null) return [];
  return Array.isArray(params) ? params : [params];
}

function rowsToSqlJsResult(rows) {
  const columns = rows.length ? Object.keys(rows[0]) : [];
  return [{ columns, values: rows.map(row => columns.map(column => row[column])) }];
}

function createCompatibilityApi(rawDb, dbPath) {
  const db = {
    rawDb,
    dbPath,
    exec(sql, params = []) {
      return rowsToSqlJsResult(rawDb.prepare(sql).all(...toArrayParams(params)));
    },
    run(sql, params = []) {
      return rawDb.prepare(sql).run(...toArrayParams(params));
    },
    prepare(sql) {
      const statement = rawDb.prepare(sql);
      return {
        run(params = []) { return statement.run(...toArrayParams(params)); },
        get(params = []) { return statement.get(...toArrayParams(params)); },
        all(params = []) { return statement.all(...toArrayParams(params)); }
      };
    },
    checkpoint() {
      try { rawDb.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch {}
    },
    close() {
      this.checkpoint();
      rawDb.close();
    }
  };
  return db;
}

async function openPhotoDatabase(dbPath) {
  await fsp.mkdir(path.dirname(dbPath), { recursive: true });
  const marker = path.join(path.dirname(dbPath), '.full-upgrade-backed-up');
  if (fs.existsSync(dbPath) && !fs.existsSync(marker)) await backupBeforeMigration(dbPath);
  const rawDb = new DatabaseSync(dbPath);
  rawDb.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  migrateSchema(rawDb);
  rawDb.exec('PRAGMA synchronous=NORMAL;');
  return createCompatibilityApi(rawDb, dbPath);
}

module.exports = { openPhotoDatabase };
