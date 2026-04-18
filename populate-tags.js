/**
 * Populate books.tags from series-tags.json
 * Run: node populate-tags.js
 */
const fs = require('fs');
const path = require('path');
const DB_PATH = path.join(__dirname, 'library.db');
const TAGS_FILE = path.join(__dirname, 'series-tags.json');

(async () => {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(DB_PATH));

  const seriesTags = JSON.parse(fs.readFileSync(TAGS_FILE, 'utf8'));
  console.log(`Loaded ${Object.keys(seriesTags).length} series tag entries`);

  let updated = 0;
  for (const [key, tags] of Object.entries(seriesTags)) {
    if (!tags || tags[0] === '未知') continue;
    const [author_id, series_id] = key.split('_').map(Number);
    if (isNaN(author_id) || isNaN(series_id)) continue;

    // Update all books in this series
    try {
      db.run(`UPDATE books SET tags = ? WHERE author_id = ? AND series_id = ?`,
        [JSON.stringify(tags), author_id, series_id]);
      updated++;
    } catch (e) { }
  }

  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
  console.log(`Updated ${updated} series, tags populated in books table`);

  // Print stats
  const r = db.exec("SELECT COUNT(*) as cnt FROM books WHERE tags != '[]' AND tags != '[\"未知\"]' AND tags IS NOT NULL");
  console.log(`Books with tags: ${r[0]?.values[0][0] || 0}`);
  process.exit(0);
})().catch(console.error);
