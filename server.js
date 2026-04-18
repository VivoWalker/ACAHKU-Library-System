const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const xlsx = require('xlsx');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'library-secret-key-2024';
const BORROW_DAYS = 14;
const MAX_BORROWS = 5;
const FINE_PER_DAY = 5; // HKD per day overdue
const MAX_RENEWALS = 1;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// sql.js setup
const initSqlJs = require('sql.js');
let db;
let validMemberUIDs = new Set(); // UIDs loaded from membership Excel files
let seriesAliases = {}; // series_id -> [alias1, alias2]

function loadSeriesAliases() {
  try {
    seriesAliases = JSON.parse(fs.readFileSync(path.join(__dirname, 'series-aliases.json'), 'utf8'));
    console.log('Loaded aliases for', Object.values(seriesAliases).filter(a => Array.isArray(a) && a.length > 0).length, 'series');
  } catch (e) { }
}

function loadMemberUIDs() {
  const sampleDir = path.join(__dirname, '..', 'examples');
  const files = [
    'Membership 2025-26.xlsx',
    '香港大學動漫聯盟會員登記表格 2025-26 ACA HKU Membership Registration Form (回應).xlsx'
  ];

  for (const file of files) {
    const filePath = path.join(sampleDir, file);
    if (!fs.existsSync(filePath)) {
      console.log('Member file not found:', filePath);
      continue;
    }
    try {
      const workbook = xlsx.readFile(filePath);
      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const data = xlsx.utils.sheet_to_json(sheet, { defval: null, header: 1 });
        for (const row of data) {
          // UID is column E (index 4) in both files
          const uid = row[4];
          if (uid) {
            const uidNum = Math.floor(Number(uid));
            if (!isNaN(uidNum)) {
              validMemberUIDs.add(uidNum);
            }
          }
        }
      }
      console.log(`Loaded members from ${file}: ${validMemberUIDs.size} total UIDs`);
    } catch (err) {
      console.error('Error loading member file', file, err.message);
    }
  }
  console.log(`Total valid member UIDs: ${validMemberUIDs.size}`);
}

async function initDB() {
  const SQL = await initSqlJs();

  const dbPath = path.join(__dirname, 'library.db');
  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'borrower')),
      display_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id TEXT UNIQUE NOT NULL,
      author_id INTEGER,
      series_id INTEGER,
      volume_no INTEGER,
      author_name TEXT,
      title TEXT,
      isbn REAL,
      location TEXT,
      book_type TEXT,
      status TEXT DEFAULT 'available',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS borrow_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      borrow_date DATETIME NOT NULL,
      due_date DATETIME NOT NULL,
      return_date DATETIME,
      returned BOOLEAN DEFAULT 0,
      renewed INTEGER DEFAULT 0,
      fine DECIMAL(10,2) DEFAULT 0,
      FOREIGN KEY (book_id) REFERENCES books(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // Migration: add renewed and fine columns if they don't exist
  try { db.run("ALTER TABLE borrow_records ADD COLUMN renewed INTEGER DEFAULT 0"); } catch (e) { }
  try { db.run("ALTER TABLE borrow_records ADD COLUMN fine DECIMAL(10,2) DEFAULT 0"); } catch (e) { }
  try { db.run("ALTER TABLE borrow_records ADD COLUMN renewal_count INTEGER DEFAULT 0"); } catch (e) { }
  try { db.run("ALTER TABLE books ADD COLUMN tags TEXT DEFAULT '[]'"); } catch (e) { }

  try {
    db.run(`CREATE INDEX IF NOT EXISTS idx_books_book_id ON books(book_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_books_title ON books(title)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_records_book_id ON borrow_records(book_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_records_user_id ON borrow_records(user_id)`);
  } catch (e) { }

  const adminExists = db.exec("SELECT id FROM users WHERE username = 'admin'");
  if (adminExists.length === 0 || adminExists[0].values.length === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.run("INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)",
      ['admin', hash, 'admin', '系统管理员']);
    console.log('Default admin created: admin / admin123');
  }

  saveDB();
  console.log('Database initialized');
}

function saveDB() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(path.join(__dirname, 'library.db'), buffer);
}

function queryOne(sql, params = []) {
  const result = db.exec(sql, params);
  if (result.length === 0 || result[0].values.length === 0) return null;
  const cols = result[0].columns;
  const row = result[0].values[0];
  const obj = {};
  cols.forEach((c, i) => obj[c] = row[i]);
  return obj;
}

function queryAll(sql, params = []) {
  const result = db.exec(sql, params);
  if (result.length === 0) return [];
  const cols = result[0].columns;
  return result[0].values.map(row => {
    const obj = {};
    cols.forEach((c, i) => obj[c] = row[i]);
    return obj;
  });
}

function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = auth.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// Auth routes
app.post('/api/auth/register', authenticate, requireAdmin, async (req, res) => {
  try {
    const { username, password, role, display_name } = req.body;
    if (!username || !password || !role) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!['admin', 'borrower'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    const hash = await bcrypt.hash(password, 10);
    try {
      db.run("INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)",
        [username, hash, role, display_name || username]);
      saveDB();
      res.json({ success: true, message: 'User created' });
    } catch (err) {
      if (err.message.includes('UNIQUE')) {
        return res.status(400).json({ error: 'Username already exists' });
      }
      throw err;
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Missing credentials' });
    }
    const user = queryOne("SELECT * FROM users WHERE username = ?", [username]);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      token,
      user: { id: user.id, username: user.username, role: user.role, display_name: user.display_name }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/auth/me', authenticate, (req, res) => {
  const user = queryOne("SELECT id, username, role, display_name FROM users WHERE id = ?", [req.user.id]);
  const activeBorrows = queryOne('SELECT COUNT(*) as count FROM borrow_records WHERE user_id = ? AND returned = 0', [req.user.id]);
  res.json({ ...user, activeBorrows: activeBorrows ? activeBorrows.count : 0, maxBorrows: MAX_BORROWS });
});

app.post('/api/auth/change-password', authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password are required' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }
    const user = queryOne("SELECT * FROM users WHERE id = ?", [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) return res.status(400).json({ error: 'Current password is incorrect' });
    const hash = await bcrypt.hash(newPassword, 10);
    db.run("UPDATE users SET password_hash = ? WHERE id = ?", [hash, req.user.id]);
    saveDB();
    res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Self-registration (no auth required)
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { username, password, uid } = req.body;
    if (!username || !password || !uid) {
      return res.status(400).json({ error: 'Missing username, password, or student ID' });
    }
    if (username.length < 3 || password.length < 6) {
      return res.status(400).json({ error: 'Username must be 3+ chars, password must be 6+ chars' });
    }
    const uidNum = Math.floor(Number(uid));
    if (!validMemberUIDs.has(uidNum)) {
      return res.status(403).json({ error: 'Not a registered member' });
    }
    const hash = await bcrypt.hash(password, 10);
    try {
      db.run("INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)",
        [username, hash, 'borrower', username]);
      saveDB();
      res.json({ success: true, message: 'Account created' });
    } catch (err) {
      if (err.message.includes('UNIQUE')) {
        return res.status(400).json({ error: 'Username already exists' });
      }
      throw err;
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Books routes
app.get('/api/books', authenticate, (req, res) => {
  try {
    const { q, page = 1, limit = 50, status, book_type, author_name, tag, sort = 'book_id', order = 'asc' } = req.query;
    const offset = (page - 1) * limit;

    let sql = 'SELECT * FROM books WHERE 1=1';
    let countSql = 'SELECT COUNT(*) as total FROM books WHERE 1=1';
    const params = [];
    const countParams = [];

    if (q) {
      sql += ' AND (title LIKE ? OR author_name LIKE ? OR book_id LIKE ?)';
      countSql += ' AND (title LIKE ? OR author_name LIKE ? OR book_id LIKE ?)';
      const likeQ = `%${q}%`;
      params.push(likeQ, likeQ, likeQ);
      countParams.push(likeQ, likeQ, likeQ);
    }

    if (status) {
      sql += ' AND status = ?';
      countSql += ' AND status = ?';
      params.push(status);
      countParams.push(status);
    }

    if (book_type) {
      sql += ' AND book_type = ?';
      countSql += ' AND book_type = ?';
      params.push(book_type);
      countParams.push(book_type);
    }

    if (author_name) {
      sql += ' AND author_name = ?';
      countSql += ' AND author_name = ?';
      params.push(author_name);
      countParams.push(author_name);
    }

    if (tag) {
      sql += ' AND tags LIKE ?';
      countSql += ' AND tags LIKE ?';
      params.push(`%${tag}%`);
      countParams.push(`%${tag}%`);
    }

    const countResult = db.exec(countSql, countParams);
    const total = countResult.length > 0 ? countResult[0].values[0][0] : 0;

    const validSorts = ['book_id', 'title', 'author_name', 'status', 'created_at'];
    const sortCol = validSorts.includes(sort) ? sort : 'book_id';
    const sortOrder = order.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    sql += ` ORDER BY ${sortCol} ${sortOrder} LIMIT ? OFFSET ?`;
    const books = queryAll(sql, [...params, Number(limit), Number(offset)]);




    res.json({ books, total, page: Number(page), totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/books/tags', authenticate, (req, res) => {
  try {
    const books = queryAll("SELECT tags FROM books WHERE tags IS NOT NULL AND tags != '[]' AND tags != '[\"未知\"]'");
    const tagCount = {};
    for (const b of books) {
      try {
        const tags = JSON.parse(b.tags);
        for (const t of tags) {
          if (t && t !== '未知') tagCount[t] = (tagCount[t] || 0) + 1;
        }
      } catch (e) { }
    }
    const sorted = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count }));
    res.json(sorted);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/books/search', authenticate, (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.json([]);

    const likeQ = `%${q}%`;

    // Find series matching alias
    const matchedSeriesKeys = [];
    for (const [key, aliases] of Object.entries(seriesAliases)) {
      if (Array.isArray(aliases) && aliases.some(a => a.includes(q) || q.includes(a))) {
        matchedSeriesKeys.push(key);
      }
    }

    let books;
    if (matchedSeriesKeys.length > 0) {
      // Build OR conditions for each series key
      const conditions = matchedSeriesKeys.map(() => '(author_id = ? AND series_id = ?)').join(' OR ');
      const params = matchedSeriesKeys.flatMap(k => k.split('_').map(Number));
      books = queryAll(`
        SELECT * FROM books
        WHERE (title LIKE ? OR author_name LIKE ? OR book_id LIKE ?)
           OR (${conditions})
        LIMIT 20
      `, [likeQ, likeQ, likeQ, ...params]);
    } else {
      books = queryAll(`
        SELECT * FROM books
        WHERE title LIKE ? OR author_name LIKE ? OR book_id LIKE ?
        LIMIT 20
      `, [likeQ, likeQ, likeQ]);
    }


res.json(books);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/books', authenticate, requireAdmin, (req, res) => {
  try {
    const { book_id, title, author_name, isbn, location, book_type } = req.body;
    if (!book_id || !title) {
      return res.status(400).json({ error: 'book_id and title are required' });
    }
    try {
      db.run(`
        INSERT INTO books (book_id, title, author_name, isbn, location, book_type)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [book_id, title, author_name || '', isbn || null, location || '', book_type || '']);
      saveDB();
      res.json({ success: true });
    } catch (err) {
      if (err.message.includes('UNIQUE')) {
        return res.status(400).json({ error: 'Book ID already exists' });
      }
      throw err;
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/books/:id', authenticate, requireAdmin, (req, res) => {
  try {
    db.run('DELETE FROM books WHERE id = ?', [req.params.id]);
    saveDB();
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/books/:id', authenticate, requireAdmin, (req, res) => {
  try {
    const { book_id, title, author_name, isbn, location, book_type, status } = req.body;
    if (!book_id || !title) {
      return res.status(400).json({ error: 'book_id and title are required' });
    }
    db.run(`
      UPDATE books SET book_id = ?, title = ?, author_name = ?, isbn = ?, location = ?, book_type = ?, status = ?
      WHERE id = ?
    `, [book_id, title, author_name || '', isbn || null, location || '', book_type || '', status || 'available', req.params.id]);
    saveDB();
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/books/:id', authenticate, (req, res) => {
  try {
    const book = queryOne('SELECT * FROM books WHERE id = ?', [req.params.id]);
    if (!book) return res.status(404).json({ error: 'Book not found' });

    const currentBorrow = queryOne(`
      SELECT br.*, u.display_name FROM borrow_records br
      JOIN users u ON br.user_id = u.id
      WHERE br.book_id = ? AND br.returned = 0
    `, [book.id]);

    if (req.user.role === 'borrower') {
      book.location = book.status === 'available' ? '可在馆借阅' : (book.status === 'borrowed' ? '已被借出' : book.location);
    }

    res.json({ ...book, currentBorrow });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Borrow routes
app.post('/api/borrow', authenticate, (req, res) => {
  try {
    const { book_id } = req.body;
    if (!book_id) return res.status(400).json({ error: 'Missing book_id' });

    const book = queryOne('SELECT * FROM books WHERE id = ?', [book_id]);
    if (!book) return res.status(404).json({ error: 'Book not found' });

    if (book.status === 'borrowed') {
      return res.status(400).json({ error: 'Book is already borrowed' });
    }

    // Check borrow limit
    const activeBorrows = queryOne('SELECT COUNT(*) as count FROM borrow_records WHERE user_id = ? AND returned = 0', [req.user.id]);
    if (activeBorrows && activeBorrows.count >= MAX_BORROWS) {
      return res.status(400).json({ error: `You have reached the maximum borrow limit of ${MAX_BORROWS} books` });
    }

    const now = new Date();
    const due = new Date(now.getTime() + BORROW_DAYS * 24 * 60 * 60 * 1000);

    db.run('UPDATE books SET status = ? WHERE id = ?', ['borrowed', book_id]);
    db.run(`
      INSERT INTO borrow_records (book_id, user_id, borrow_date, due_date)
      VALUES (?, ?, ?, ?)
    `, [book_id, req.user.id, now.toISOString(), due.toISOString()]);

    saveDB();
    res.json({ success: true, message: 'Book borrowed successfully', due_date: due.toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/return/:record_id', authenticate, (req, res) => {
  try {
    const record = queryOne('SELECT * FROM borrow_records WHERE id = ?', [req.params.record_id]);
    if (!record) return res.status(404).json({ error: 'Record not found' });

    if (req.user.role !== 'admin' && record.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    if (record.returned) {
      return res.status(400).json({ error: 'Already returned' });
    }

    const now = new Date();
    const due = new Date(record.due_date);
    let fine = 0;
    if (now > due) {
      const overdueDays = Math.ceil((now - due) / (1000 * 60 * 60 * 24));
      fine = overdueDays * FINE_PER_DAY;
    }

    db.run('UPDATE borrow_records SET returned = 1, return_date = ?, fine = ? WHERE id = ?', [now.toISOString(), fine, record.id]);
    db.run('UPDATE books SET status = ? WHERE id = ?', ['available', record.book_id]);

    saveDB();
    res.json({ success: true, message: 'Book returned successfully', fine });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Renew a borrow
app.post('/api/renew/:record_id', authenticate, (req, res) => {
  try {
    const record = queryOne('SELECT * FROM borrow_records WHERE id = ?', [req.params.record_id]);
    if (!record) return res.status(404).json({ error: 'Record not found' });

    if (req.user.role !== 'admin' && record.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    if (record.returned) {
      return res.status(400).json({ error: 'Already returned, cannot renew' });
    }

    const renewalCount = record.renewal_count || 0;
    if (renewalCount >= MAX_RENEWALS) {
      return res.status(400).json({ error: `Cannot renew more than ${MAX_RENEWALS} time(s)` });
    }

    const newDue = new Date(new Date(record.due_date).getTime() + BORROW_DAYS * 24 * 60 * 60 * 1000);
    db.run('UPDATE borrow_records SET due_date = ?, renewed = 1, renewal_count = ? WHERE id = ?',
      [newDue.toISOString(), renewalCount + 1, record.id]);

    saveDB();
    res.json({ success: true, message: 'Book renewed successfully', new_due_date: newDue.toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/records', authenticate, (req, res) => {
  try {
    let records;
    if (req.user.role === 'admin') {
      records = queryAll(`
        SELECT br.*, b.title, b.book_id as code, u.display_name as borrower_name, u.username
        FROM borrow_records br
        JOIN books b ON br.book_id = b.id
        JOIN users u ON br.user_id = u.id
        ORDER BY br.borrow_date DESC
      `);
    } else {
      records = queryAll(`
        SELECT br.*, b.title, b.book_id as code, b.author_name
        FROM borrow_records br
        JOIN books b ON br.book_id = b.id
        WHERE br.user_id = ?
        ORDER BY br.borrow_date DESC
      `, [req.user.id]);
    }
    res.json(records);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/my-borrows', authenticate, (req, res) => {
  try {
    const records = queryAll(`
      SELECT br.*, b.title, b.book_id as code, b.author_name
      FROM borrow_records br
      JOIN books b ON br.book_id = b.id
      WHERE br.user_id = ? AND br.returned = 0
      ORDER BY br.due_date ASC
    `, [req.user.id]);
    res.json(records);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin routes
app.get('/api/admin/users', authenticate, requireAdmin, (req, res) => {
  try {
    const users = queryAll('SELECT id, username, role, display_name, created_at FROM users');
    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/admin/users/:id', authenticate, requireAdmin, (req, res) => {
  try {
    if (req.params.id == req.user.id) {
      return res.status(400).json({ error: 'Cannot delete yourself' });
    }
    db.run('DELETE FROM users WHERE id = ?', [req.params.id]);
    saveDB();
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/stats', authenticate, requireAdmin, (req, res) => {
  try {
    const totalBooks = queryOne('SELECT COUNT(*) as count FROM books');
    const availableBooks = queryOne("SELECT COUNT(*) as count FROM books WHERE status = 'available'");
    const borrowedBooks = queryOne("SELECT COUNT(*) as count FROM books WHERE status = 'borrowed'");
    const totalUsers = queryOne('SELECT COUNT(*) as count FROM users');
    const activeBorrows = queryOne('SELECT COUNT(*) as count FROM borrow_records WHERE returned = 0');
    const now = new Date().toISOString();
    const overdueBorrows = queryOne('SELECT COUNT(*) as count FROM borrow_records WHERE returned = 0 AND due_date < ?', [now]);

    res.json({
      totalBooks: totalBooks ? totalBooks.count : 0,
      availableBooks: availableBooks ? availableBooks.count : 0,
      borrowedBooks: borrowedBooks ? borrowedBooks.count : 0,
      totalUsers: totalUsers ? totalUsers.count : 0,
      activeBorrows: activeBorrows ? activeBorrows.count : 0,
      overdueBorrows: overdueBorrows ? overdueBorrows.count : 0
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Excel import
const upload = multer({ dest: path.join(__dirname, 'uploads') });
if (!fs.existsSync(path.join(__dirname, 'uploads'))) {
  fs.mkdirSync(path.join(__dirname, 'uploads'));
}

app.post('/api/admin/import', authenticate, requireAdmin, upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const workbook = xlsx.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(sheet, { defval: null });

    let imported = 0;
    let skipped = 0;

    for (const row of data) {
      const bookId = row.BookID ? String(row.BookID).trim() : null;
      if (!bookId) {
        skipped++;
        continue;
      }

      try {
        db.run(`
          INSERT OR IGNORE INTO books (book_id, author_id, series_id, volume_no, author_name, title, isbn, location, book_type)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          bookId,
          row.AuthorID || null,
          row.SeriesID || null,
          row.VolumeNo || null,
          row.Author || '',
          row.Title || '',
          row['ISBN/Reference Number'] || null,
          row['λ��'] || row['location'] || null,
          row['Type (С�f/����)'] || row['Type (N/C)'] || null
        ]);
        imported++;
      } catch (e) {
        skipped++;
      }
    }

    saveDB();
    fs.unlinkSync(req.file.path);

    res.json({ success: true, imported, skipped, total: data.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Import failed: ' + err.message });
  }
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
initDB().then(() => {
  loadMemberUIDs();
  loadSeriesAliases();
  app.listen(PORT, () => {
    console.log(`Library System running on http://localhost:${PORT}`);
    console.log(`Admin login: admin / admin123`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
