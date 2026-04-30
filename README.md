# ACAHKU Library System

A full-stack library management system built for the ACA HKU (香港大學動漫聯盟) community library. Supports book browsing, borrowing, returning, and administrative management.

## Features

- **Book browsing** — Search by title, author, or ID; filter by type, status, tags, and author
- **Borrowing system** — 14-day loan period with renewal (1 renewal max), overdue fines (HK$5/day)
- **User roles** — Admin and Borrower roles with different permissions
- **Member registration** — Self-signup with student UID validation against membership Excel records
- **Admin panel** — Statistics dashboard, book management (CRUD), borrow records, batch delete, CSV export
- **Excel import** — Bulk import books from Excel spreadsheets
- **Cover images** — Auto-fetched from Google Books API (2,255 covers)
- **Series tags** — Genre tagging via Bangumi API and Moegirl Wiki
- **i18n** — Traditional Chinese and English UI
- **Mobile responsive** — Works on desktop, tablet, and phone

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express |
| Database | SQLite (via sql.js) |
| Auth | bcrypt + JWT |
| Frontend | Vanilla HTML/CSS/JS (no framework) |
| File parsing | xlsx (Excel import/export) |

## Quick Start

```bash
# Install dependencies
npm install

# Start server
npm start
```

Server runs at `http://localhost:3000`. Default admin: `admin` / `admin123`.

## Project Structure

```
├── server.js              # Express backend (all API routes)
├── public/
│   ├── index.html         # Full frontend SPA
│   ├── JongLogo.png       # Header logo
│   ├── SocLogo.png        # Fallback cover image
│   └── covers/            # 2,255 book cover images
├── library.db             # SQLite database
├── fetch-covers.js        # Script: fetch covers from Google Books
├── fetch-tags.js          # Script: fetch tags from Bangumi API
├── fetch-moegirl-tags.js  # Script: fetch tags from Moegirl Wiki
├── fetch-aliases.js       # Script: fetch series aliases from Moegirl
├── populate-tags.js       # Script: write tags into DB
├── series-list.json       # Extracted series data
├── series-tags.json       # Series → tags mapping
├── series-aliases.json    # Series → aliases mapping
├── SPEC.md                # Technical specification (Chinese)
└── package.json
```

## API Overview

### Auth
- `POST /api/auth/login` — Login, returns JWT
- `POST /api/auth/signup` — Self-registration (requires valid member UID)
- `POST /api/auth/change-password` — Change password
- `GET /api/auth/me` — Current user info

### Books
- `GET /api/books` — List/search books (query params: `q`, `status`, `book_type`, `author_name`, `tag`, `sort`, `page`, `limit`)
- `GET /api/books/:id` — Book detail with current borrow info
- `GET /api/books/search?q=` — Quick search with series alias matching
- `GET /api/books/tags` — Aggregated tag list with counts
- `POST /api/books` — Add book (admin)
- `PUT /api/books/:id` — Edit book (admin)
- `DELETE /api/books/:id` — Delete book (admin)

### Borrowing
- `POST /api/borrow` — Borrow a book
- `POST /api/return/:record_id` — Return a book
- `POST /api/renew/:record_id` — Renew a borrow
- `GET /api/records` — All borrow records (admin) or own records (borrower)
- `GET /api/my-borrows` — Current user's active borrows

### Admin
- `GET /api/admin/stats` — Dashboard statistics
- `GET /api/admin/users` — User list
- `DELETE /api/admin/users/:id` — Delete user
- `POST /api/admin/import` — Import books from Excel

## Configuration

Constants in `server.js`:

| Constant | Default | Description |
|---|---|---|
| `PORT` | 3000 | Server port |
| `BORROW_DAYS` | 14 | Loan period in days |
| `MAX_BORROWS` | 5 | Max concurrent borrows per user |
| `MAX_RENEWALS` | 1 | Max renewal count |
| `FINE_PER_DAY` | 5 | Overdue fine (HKD/day) |
| `JWT_SECRET` | (built-in) | JWT signing secret |

Set via environment variables: `PORT`, `JWT_SECRET`.

## License

MIT
