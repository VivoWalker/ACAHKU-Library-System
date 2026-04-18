/**
 * Book Cover Fetcher - Google Books API
 * Fetches covers by ISBN → title+author, saves to public/covers/
 * Run: node fetch-covers.js
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const COVERS_DIR = path.join(__dirname, 'public', 'covers');
const DB_PATH = path.join(__dirname, 'library.db');

if (!fs.existsSync(COVERS_DIR)) fs.mkdirSync(COVERS_DIR, { recursive: true });

let db;
function queryAll(sql, params = []) {
  const result = db.exec(sql, params);
  if (result.length === 0) return [];
  const cols = result[0].columns;
  return result[0].values.map(row => {
    const obj = {}; cols.forEach((c, i) => obj[c] = row[i]); return obj;
  });
}

function httpGet(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 10) { resolve(null); return; }
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        let loc = res.headers.location;
        if (!loc.startsWith('http')) {
          const proto = url.startsWith('https') ? 'https:' : 'http:';
          const host = url.split('/')[2];
          loc = proto + '//' + host + loc;
        }
        httpGet(loc, redirects + 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) { resolve(null); return; }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

async function fetchCoverUrl(query) {
  try {
    const encoded = encodeURIComponent(query);
    const url = `https://www.googleapis.com/books/v1/volumes?q=${encoded}&maxResults=3&langRestrict=ja,zh,en`;
    const data = await httpGet(url);
    if (!data) return null;
    const json = JSON.parse(data.toString());
    if (!json.items) return null;
    for (const item of json.items) {
      const links = item.volumeInfo && item.volumeInfo.imageLinks;
      if (!links) continue;
      // Prefer medium or thumbnail
      const coverUrl = links.medium || links.thumbnail || links.smallThumbnail;
      if (coverUrl) {
        const resolved = coverUrl.replace('http:', 'https:');
        return resolved;
      }
    }
  } catch (e) { }
  return null;
}

async function downloadImage(url) {
  return new Promise((resolve) => {
    try {
      const mod = url.startsWith('https') ? https : http;
      mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, r => {
        if (r.statusCode === 301 || r.statusCode === 302) {
          let loc = r.headers.location;
          if (!loc.startsWith('http')) {
            const proto = url.startsWith('https') ? 'https:' : 'http:';
            const host = url.split('/')[2];
            loc = proto + '//' + host + loc;
          }
          downloadImage(loc).then(resolve).catch(() => resolve(null)); return;
        }
        if (r.statusCode !== 200) { resolve(null); return; }
        const chunks = [];
        r.on('data', c => chunks.push(c));
        r.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve(buf.length > 1000 ? buf : null);
        });
      }).on('error', () => resolve(null));
    } catch { resolve(null); }
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  db = new SQL.Database(fs.readFileSync(DB_PATH));

  const books = queryAll('SELECT id, book_id, isbn, title, author_name FROM books');
  console.log(`Total books: ${books.length}`);

  let matched = 0, missed = 0, skipped = 0;

  for (const book of books) {
    const coverPath = path.join(COVERS_DIR, `${book.id}.jpg`);
    if (fs.existsSync(coverPath)) { skipped++; continue; }

    let coverUrl = null;

    // Try ISBN first
    if (book.isbn) {
      coverUrl = await fetchCoverUrl(`isbn:${String(book.isbn).replace(/-/g, '')}`);
    }

    // Try title + author
    if (!coverUrl) {
      coverUrl = await fetchCoverUrl(`"${book.title}" ${book.author_name || ''}`.trim());
    }

    if (coverUrl) {
      const imageData = await downloadImage(coverUrl);
      if (imageData && imageData.length > 5000) {
        fs.writeFileSync(coverPath, imageData);
        matched++;
      } else {
        missed++;
        console.log(`DL_FAIL: [${book.book_id}] ${book.title}`);
      }
    } else {
      missed++;
      console.log(`MISS:    [${book.book_id}] ${book.title} (ISBN: ${book.isbn})`);
    }

    if ((matched + missed + skipped) % 50 === 0) {
      console.log(`Progress: ${matched + missed + skipped}/${books.length} | Matched: ${matched} | Missed: ${missed}`);
    }

    await sleep(120);
  }

  console.log(`\nFinal: Matched: ${matched}, Missed: ${missed}, Skipped: ${skipped}`);
  process.exit(0);
}

main().catch(console.error);
