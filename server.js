/**
 * Minimal Node.js backend that:
 * - serves the static frontend in /public
 * - provides simple auth with sqlite3 and express-session
 * - serves video files from /videos with Range support (seeking)
 * - stores simple watch history
 *
 * NOTE: This is a demo. For production you must harden security, use HTTPS,
 * proper session/cookie configuration, input validation, rate-limiting, etc.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();
const session = require('express-session');

const VIDEO_DIR = path.join(__dirname, 'videos');
const DATA_FILE = path.join(__dirname, 'data', 'videos.json');
const DB_FILE = path.join(__dirname, 'data', 'app.db');

if (!fs.existsSync(path.join(__dirname, 'data'))) fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
if (!fs.existsSync(path.join(__dirname, 'public'))) fs.mkdirSync(path.join(__dirname, 'public'), { recursive: true });

const app = express();
app.use(express.json());
app.use('/static', express.static(path.join(__dirname, 'public')));
app.use('/thumbnails', express.static(path.join(__dirname, 'thumbnails')));

// Simple in-memory session (for demo). Replace secret in production.
app.use(session({
  secret: 'demo-secret-replace-me',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false } // set true when using HTTPS
}));

// Init DB
const db = new sqlite3.Database(DB_FILE);
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS watch_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    file TEXT,
    time INTEGER,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);
});

// Helper: read manifest of available videos (data/videos.json)
function readCatalog(){
  if (!fs.existsSync(DATA_FILE)){
    // fallback: list mp4 files in /videos
    if (!fs.existsSync(VIDEO_DIR)) fs.mkdirSync(VIDEO_DIR, { recursive: true });
    const files = fs.readdirSync(VIDEO_DIR).filter(f => /\.(mp4|m4v|webm|ogg)$/i.test(f));
    return files.map(f => ({ file: f, title: path.parse(f).name, thumbnail: null }));
  }
  try {
    const raw = fs.readFileSync(DATA_FILE,'utf8');
    const obj = JSON.parse(raw);
    return obj.files || [];
  } catch(e){
    console.error('Failed to read data/videos.json', e);
    return [];
  }
}

// ====== AUTH ROUTES ======
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'missing' });
  try {
    const hash = await bcrypt.hash(password, 10);
    db.run('INSERT INTO users (username, password_hash) VALUES (?,?)', [username, hash], function(err){
      if (err) return res.status(400).json({ error: 'user_exists_or_db_error' });
      res.status(201).json({ ok:true });
    });
  } catch (e) {
    res.status(500).json({ error: 'internal' });
  }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'missing' });
  db.get('SELECT id, password_hash FROM users WHERE username = ?', [username], async (err, row) => {
    if (err || !row) return res.status(401).json({ error: 'invalid' });
    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) return res.status(401).json({ error: 'invalid' });
    req.session.user = { id: row.id, username };
    res.json({ ok: true });
  });
});

app.get('/api/logout', (req,res) => {
  req.session.destroy(()=>res.json({ ok:true }));
});

app.get('/api/me', (req,res) => {
  if (!req.session.user) return res.status(401).json({ error: 'not_authenticated' });
  res.json({ user: req.session.user });
});

// ====== CATALOG & WATCH HISTORY ======
app.get('/api/videos', (req,res) => {
  if (!req.session.user) return res.status(401).json({ error: 'not_authenticated' });
  const catalog = readCatalog();
  // attach resume times from DB for this user (simple last known time)
  db.all('SELECT file, time FROM watch_history WHERE user_id = ? ORDER BY updated_at DESC', [req.session.user.id], (err, rows) => {
    const resumeMap = {};
    if (!err && rows) rows.forEach(r => resumeMap[r.file] = r.time);
    const out = catalog.map(c => ({ ...c, resumeTime: resumeMap[c.file] || 0 }));
    res.json(out);
  });
});

app.post('/api/watch', (req,res) => {
  if (!req.session.user) return res.status(401).json({ error: 'not_authenticated' });
  const { file, time } = req.body || {};
  if (!file) return res.status(400).json({ error: 'missing' });
  // upsert-like: insert a new row, or update existing one
  db.get('SELECT id FROM watch_history WHERE user_id = ? AND file = ?', [req.session.user.id, file], (err,row) => {
    if (row) {
      db.run('UPDATE watch_history SET time = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [time||0, row.id]);
      res.json({ ok:true });
    } else {
      db.run('INSERT INTO watch_history (user_id, file, time) VALUES (?,?,?)', [req.session.user.id, file, time||0], (err2) => {
        res.json({ ok: !err2 });
      });
    }
  });
});

// ====== VIDEO STREAMING (supports Range requests) ======
app.get('/video/:file', (req,res) => {
  if (!req.session.user) return res.status(401).send('Not authenticated');
  const file = path.basename(req.params.file); // sanitize
  const filePath = path.join(VIDEO_DIR, file);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');

  const stat = fs.statSync(filePath);
  const total = stat.size;
  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
    if (start >= total || end >= total) {
      res.status(416).set('Content-Range', `bytes */${total}`).end();
      return;
    }
    const chunksize = (end - start) + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': 'video/mp4',
      'Cache-Control': 'no-cache'
    });
    const stream = fs.createReadStream(filePath, { start, end });
    stream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': total,
      'Content-Type': 'video/mp4'
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// Serve the SPA entry
app.get('/', (req,res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MiniFlix server running on http://localhost:${PORT}`);
  console.log(`Place MP4 files in ${VIDEO_DIR} and edit data/videos.json for metadata.`);
});
