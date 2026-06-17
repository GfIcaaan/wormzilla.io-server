'use strict';

const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const cfg = require('./config');

const DB_PATH = path.join(__dirname, 'db', 'game.db.bin');

let db = null;
let SQL = null;

function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

function saveDb() {
  try {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch (e) {
    console.error('[DB] save error:', e.message);
  }
}

async function init() {
  if (db) return db;
  SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const data = fs.readFileSync(DB_PATH);
    db = new SQL.Database(data);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT UNIQUE NOT NULL,
      token TEXT UNIQUE NOT NULL,
      google_id TEXT UNIQUE,
      username TEXT UNIQUE NOT NULL,
      mail TEXT,
      level INTEGER DEFAULT 1,
      kills INTEGER DEFAULT 0,
      headshots INTEGER DEFAULT 0,
      max_score REAL DEFAULT 0,
      points INTEGER DEFAULT 0,
      coins INTEGER DEFAULT 0,
      skin_id INTEGER DEFAULT 1,
      eyes_id INTEGER DEFAULT 0,
      mouth_id INTEGER DEFAULT 0,
      glasses_id INTEGER DEFAULT 0,
      hat_id INTEGER DEFAULT 0,
      best_survival REAL DEFAULT 0,
      name_cards INTEGER DEFAULT 0,
      vip_expires TEXT,
      zoom_expires TEXT,
      role INTEGER DEFAULT 0,
      is_banned INTEGER DEFAULT 0,
      ban_reason TEXT,
      owned_skins TEXT DEFAULT '["1"]',
      owned_hats TEXT DEFAULT '[]',
      owned_eyes TEXT DEFAULT '[]',
      owned_mouths TEXT DEFAULT '[]',
      owned_glasses TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      token_expires TEXT,
      texp TEXT
    );
  `);
  saveDb();

  // Auto-save every 30s
  setInterval(saveDb, 30000).unref();

  // Save on exit
  process.on('exit', saveDb);

  return db;
}

// ─── Query helpers ─────────────────────────────────────────────────────────

function rowsToObjects(results) {
  if (!results || results.length === 0) return [];
  const { columns, values } = results[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => obj[col] = row[i]);
    return obj;
  });
}

function queryAll(sql, params = []) {
  const results = db.exec(sql, params);
  return rowsToObjects(results);
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

function run(sql, params = []) {
  db.run(sql, params);
  saveDb();
}

// ─── User finders ──────────────────────────────────────────────────────────

function findByToken(token) {
  return queryOne('SELECT * FROM users WHERE token = ?', [token]);
}

function findByGoogleId(gid) {
  return queryOne('SELECT * FROM users WHERE google_id = ?', [gid]);
}

function findByUsername(name) {
  return queryOne('SELECT * FROM users WHERE username = ?', [name]);
}

function findByUserId(uid) {
  return queryOne('SELECT * FROM users WHERE user_id = ?', [uid]);
}

// ─── User creation ─────────────────────────────────────────────────────────

function createUser({ google_id, username, mail }) {
  const user_id = uuidv4();
  const token = uuidv4();
  const now = new Date();
  const expires = new Date(now.getTime() + cfg.TOKEN_EXPIRE_DAYS * 86400000);
  const texp = expires.toISOString();

  run(`
    INSERT INTO users (user_id, token, google_id, username, mail, token_expires, texp, owned_skins)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [user_id, token, google_id || null, username, mail || null, expires.toISOString(), texp, JSON.stringify(['1'])]);

  return findByToken(token);
}

// ─── Stats update ──────────────────────────────────────────────────────────

function updateStats(user_id, { kills, headshots, max_score, points }) {
  const user = findByUserId(user_id);
  if (!user) return;
  const newPoints = (user.points || 0) + points;
  const level = calculateLevel(newPoints);
  run(`
    UPDATE users SET
      kills = kills + ?,
      headshots = headshots + ?,
      max_score = MAX(max_score, ?),
      points = points + ?,
      level = ?
    WHERE user_id = ?
  `, [kills, headshots, max_score, points, level, user_id]);
}

// ─── Leaderboard ───────────────────────────────────────────────────────────

function getLeaderboard(type) {
  const orderMap = {
    kills:     'kills',
    score:     'max_score',
    headshots: 'headshots',
    level:     'level',
  };
  const col = orderMap[type] || 'max_score';
  return queryAll(
    `SELECT user_id, username, kills, headshots, max_score, level FROM users WHERE is_banned=0 ORDER BY ${col} DESC LIMIT 100`
  );
}

// ─── Username update ───────────────────────────────────────────────────────

function updateUsername(user_id, username) {
  const user = findByUserId(user_id);
  if (!user || user.name_cards <= 0) return false;
  run('UPDATE users SET username=?, name_cards=name_cards-1 WHERE user_id=?', [username, user_id]);
  return true;
}

// ─── VIP grant ─────────────────────────────────────────────────────────────

function grantVip(user_id, months = 1) {
  const user = findByUserId(user_id);
  if (!user) return false;
  const now = new Date();
  const base = (user.vip_expires && new Date(user.vip_expires) > now)
    ? new Date(user.vip_expires) : now;
  base.setMonth(base.getMonth() + months);
  run('UPDATE users SET vip_expires=?, role=MAX(role,1) WHERE user_id=?', [base.toISOString(), user_id]);
  return true;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function calculateLevel(totalPoints) {
  return Math.max(1, Math.floor(1 + Math.sqrt(totalPoints / 1000)));
}

function safeJson(str, def) {
  try { return JSON.parse(str); } catch { return def; }
}

function formatUserResponse(user, servers = []) {
  const now = new Date();
  const premium = (user.vip_expires && new Date(user.vip_expires) > now)
    ? new Date(user.vip_expires).toISOString() : null;
  const zoom = (user.zoom_expires && new Date(user.zoom_expires) > now)
    ? new Date(user.zoom_expires).toISOString() : null;

  return {
    user_id: user.user_id,
    token: user.token,
    mail: user.mail,
    username: user.username,
    level: user.level,
    kills: user.kills,
    headshots: user.headshots,
    max_score: user.max_score,
    points: user.points,
    coins: user.coins,
    skin_id: user.skin_id,
    eyes_id: user.eyes_id,
    mouth_id: user.mouth_id,
    glasses_id: user.glasses_id,
    hat_id: user.hat_id,
    best_survival: user.best_survival,
    name_cards: user.name_cards,
    premium,
    zoom,
    role: user.role,
    isConsentGiven: true,
    texp: user.texp,
    servers,
    skins: safeJson(user.owned_skins, ['1']),
    hats: safeJson(user.owned_hats, []),
    eyes: safeJson(user.owned_eyes, []),
    mouths: safeJson(user.owned_mouths, []),
    glasses: safeJson(user.owned_glasses, []),
  };
}

module.exports = {
  init,
  getDb,
  run,
  queryAll,
  queryOne,
  findByToken,
  findByGoogleId,
  findByUsername,
  findByUserId,
  createUser,
  updateStats,
  getLeaderboard,
  updateUsername,
  grantVip,
  calculateLevel,
  formatUserResponse,
  safeJson,
};