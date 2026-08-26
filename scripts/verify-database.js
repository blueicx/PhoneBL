const { openPhotoDatabase } = require('../src/database');

async function main() {
  const db = await openPhotoDatabase('E:/MAP/data/photos.db');
  for (const table of ['photos', 'photo_versions', 'albums', 'saved_searches', 'jobs', 'reverse_geocode_cache']) {
    const count = db.exec(`SELECT COUNT(*) FROM ${table}`)[0].values[0][0];
    console.log(`${table}: ${count}`);
  }
  console.log('versions:', db.exec('SELECT version_type, COUNT(*) FROM photo_versions GROUP BY version_type')[0]?.values || []);
  console.log('rating column:', Boolean(db.exec("SELECT rating FROM photos LIMIT 1").at(0)));
  db.close();
}

main().catch(error => { console.error(error); process.exitCode = 1; });
