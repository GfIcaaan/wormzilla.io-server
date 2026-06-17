'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const cfg = require('./config');
const db = require('./database');
const { encodeResponse } = require('./protocol');
const { verifyGoogleJWT, verifyTurnstile, validateUsername } = require('./auth');
const { startGameServer, createSession, getPlayerCount } = require('./gameServer');

// ─── Init (async startup) ──────────────────────────────────────────────────
// db.init() is called in startServer() below

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// Serve static files from parent directory (client files)
const CLIENT_ROOT = path.join(__dirname, '..');
app.use(express.static(CLIENT_ROOT));

// ─── Helpers ───────────────────────────────────────────────────────────────

function getActiveServers() {
  return [
    {
      a: 'Local',
      b: `ws://localhost:${cfg.WS_PORT}`,
      c: getPlayerCount(),
      d: 'sg',
      e: 'as',
    },
  ];
}

function encodedResponse(res, obj) {
  res.type('text/plain').send(encodeResponse(JSON.stringify(obj)));
}

function getIP(req) {
  return (req.headers['cf-connecting-ip'] ||
    req.headers['x-forwarded-for'] ||
    req.socket.remoteAddress || '').split(',')[0].trim();
}

// ─── Rate limiting (simple in-memory) ─────────────────────────────────────

const ipRequestLog = new Map();
function rateLimit(req, res, next) {
  const ip = getIP(req);
  const now = Date.now();
  const log = ipRequestLog.get(ip) || [];
  const recent = log.filter(t => now - t < 1000);
  recent.push(now);
  ipRequestLog.set(ip, recent);
  if (recent.length > 10) return res.status(429).send('Too Many Requests');
  next();
}

// ─── Routes ────────────────────────────────────────────────────────────────

// Serve registry file directly (already XOR-encoded)
app.get('/media/registry.wormzilla', (req, res) => {
  res.sendFile(path.join(CLIENT_ROOT, 'media', 'registry.wormzilla'));
});

// Also serve the one in /js/
app.get('/js/registry.wormzilla', (req, res) => {
  res.sendFile(path.join(CLIENT_ROOT, 'js', 'registry.wormzilla'));
});

// ─── GET /api/login/:token ─────────────────────────────────────────────────

app.get('/api/login/:token', rateLimit, (req, res) => {
  try {
    const user = db.findByToken(req.params.token);
    if (!user) {
      return encodedResponse(res, { code: 404, a: 'Token not found.' });
    }
    if (user.is_banned) {
      return encodedResponse(res, { code: 201, a: user.ban_reason || 'You are banned.' });
    }
    const data = db.formatUserResponse(user, getActiveServers());
    return encodedResponse(res, { code: 200, data });
  } catch (err) {
    console.error('[/api/login]', err);
    res.status(500).send('Internal error');
  }
});

// ─── POST /api/google_login/:google_jwt ────────────────────────────────────

app.post('/api/google_login/:google_jwt', rateLimit, async (req, res) => {
  try {
    const payload = await verifyGoogleJWT(req.params.google_jwt);
    if (!payload) {
      return encodedResponse(res, { code: 400, a: 'Invalid Google token.' });
    }

    const user = db.findByGoogleId(payload.sub);
    if (!user) {
      return encodedResponse(res, { code: 202 }); // not registered
    }
    if (user.is_banned) {
      return encodedResponse(res, { code: 201, a: user.ban_reason || 'You are banned.' });
    }
    const data = db.formatUserResponse(user, getActiveServers());
    return encodedResponse(res, { code: 200, data });
  } catch (err) {
    console.error('[/api/google_login]', err);
    res.status(500).send('Internal error');
  }
});

// ─── POST /api/register/:google_jwt ───────────────────────────────────────

app.post('/api/register/:google_jwt', rateLimit, upload.none(), async (req, res) => {
  try {
    const { username, cf_turn } = req.body;

    const turnstileOk = await verifyTurnstile(cf_turn, getIP(req));
    if (!turnstileOk) {
      return encodedResponse(res, { code: 400, a: 'Captcha failed.' });
    }

    const validation = validateUsername(username);
    if (validation === 'flagged') return encodedResponse(res, { code: 203 });
    if (validation !== 'ok') return encodedResponse(res, { code: 400, a: 'Invalid username.' });

    const payload = await verifyGoogleJWT(req.params.google_jwt);
    if (!payload) return encodedResponse(res, { code: 400, a: 'Invalid Google token.' });

    const existing = db.findByUsername(username.trim());
    if (existing) return encodedResponse(res, { code: 201 });

    const user = db.createUser({
      google_id: payload.sub,
      username: username.trim(),
      mail: payload.email,
    });

    const data = db.formatUserResponse(user, getActiveServers());
    return encodedResponse(res, { code: 200, data });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return encodedResponse(res, { code: 201 }); // username taken
    }
    console.error('[/api/register]', err);
    res.status(500).send('Internal error');
  }
});

// ─── POST /api/key_login/ ──────────────────────────────────────────────────

app.post('/api/key_login/', rateLimit, upload.none(), (req, res) => {
  try {
    const key = (req.body.key || '').trim();
    if (!key) return encodedResponse(res, { code: 202 });

    const user = db.findByToken(key);
    if (!user || user.is_banned) {
      return encodedResponse(res, { code: 202 });
    }
    const data = db.formatUserResponse(user, getActiveServers());
    return encodedResponse(res, { code: 200, data });
  } catch (err) {
    console.error('[/api/key_login]', err);
    res.status(500).send('Internal error');
  }
});

// ─── POST /api/start_game/ ────────────────────────────────────────────────

app.post('/api/start_game/', upload.none(), (req, res) => {
  try {
    const token = req.body.token || '';
    if (!token) return res.json({ code: 401 });

    const user = db.findByToken(token);
    if (!user || user.is_banned) {
      return res.json({ code: 401 });
    }

    // Create a session so game server knows this user
    createSession(token, user.user_id);

    return res.json({
      code: 200,
      url: `ws://localhost:${cfg.WS_PORT}`,
      v: 4,
      t: Date.now(),
    });
  } catch (err) {
    console.error('[/api/start_game]', err);
    res.status(500).send('Internal error');
  }
});

// ─── POST /api/get_leaderboard/ ───────────────────────────────────────────

app.post('/api/get_leaderboard/', upload.none(), (req, res) => {
  try {
    const token = req.body.a || '';
    const type = req.body.b || 'score';

    const user = db.findByToken(token);
    const list = db.getLeaderboard(type);

    return res.json({
      list: list.map(u => ({
        id: u.user_id,
        username: u.username,
        kills: u.kills,
        headshots: u.headshots,
        max_score: Math.floor(u.max_score * 50),
        level: u.level,
      })),
      me: user ? user.user_id : null,
    });
  } catch (err) {
    console.error('[/api/get_leaderboard]', err);
    res.status(500).send('Internal error');
  }
});

// ─── POST /api/nick-change/ ───────────────────────────────────────────────

app.post('/api/nick-change/', upload.none(), async (req, res) => {
  try {
    const { token, username, cf_turn } = req.body;

    const turnstileOk = await verifyTurnstile(cf_turn, getIP(req));
    if (!turnstileOk) return res.json({ code: 400 });

    const user = db.findByToken(token || '');
    if (!user) return res.json({ code: 201 });
    if (user.name_cards <= 0) return res.json({ code: 202 });

    const validation = validateUsername(username);
    if (validation === 'flagged') return res.json({ code: 203 });
    if (validation !== 'ok') return res.json({ code: 400 });

    const existing = db.findByUsername(username.trim());
    if (existing && existing.user_id !== user.user_id) return res.json({ code: 201 });

    const ok = db.updateUsername(user.user_id, username.trim());
    return res.json({ code: ok ? 200 : 202 });
  } catch (err) {
    console.error('[/api/nick-change]', err);
    res.status(500).send('Internal error');
  }
});

// ─── POST /api/gift_vip/ ──────────────────────────────────────────────────

app.post('/api/gift_vip/', upload.none(), (req, res) => {
  try {
    const tokenA = req.body.a || '';
    const usernameB = req.body.b || '';

    const giver = db.findByToken(tokenA);
    if (!giver) return res.json({ code: 201 });

    const receiver = db.findByUsername(usernameB);
    if (!receiver) return res.json({ code: 202 });

    return res.json({ code: 200, receiver_id: receiver.user_id });
  } catch (err) {
    console.error('[/api/gift_vip]', err);
    res.status(500).send('Internal error');
  }
});

// ─── POST /api/verify_purchase/ ───────────────────────────────────────────

app.post('/api/verify_purchase/', upload.none(), (req, res) => {
  try {
    const { token, product_token, product_id, gift_id } = req.body;
    const user = db.findByToken(token || '');
    if (!user) return res.json({ code: 201 });

    // Grant VIP based on product
    const targetUser = gift_id ? db.findByUserId(gift_id) : user;
    if (!targetUser) return res.json({ code: 202 });

    if (product_id && product_id.includes('vip')) {
      db.grantVip(targetUser.user_id, 1);
    }

    return res.json({ code: 200 });
  } catch (err) {
    console.error('[/api/verify_purchase]', err);
    res.status(500).send('Internal error');
  }
});

// ─── POST /api/buy-property/:token ────────────────────────────────────────

app.post('/api/buy-property/:token', upload.none(), (req, res) => {
  try {
    const user = db.findByToken(req.params.token);
    if (!user) return res.status(401).send('Unauthorized');

    const itemId = parseInt(req.query.id, 10);
    const itemType = req.query.type;

    // Simplified: allow purchase if coins >= price
    // In production, look up price from registry
    const price = 0; // TODO: parse from registry

    const ownedKey = `owned_${itemType}s`;
    const owned = db.safeJson(user[ownedKey] || '[]', []);
    if (!owned.includes(String(itemId))) owned.push(String(itemId));

    db.run(`UPDATE users SET ${ownedKey}=?, coins=coins-? WHERE user_id=? AND coins>=?`,
      [JSON.stringify(owned), price, user.user_id, price]);

    res.status(200).send('ok');
  } catch (err) {
    console.error('[/api/buy-property]', err);
    res.status(500).send('Internal error');
  }
});

// ─── GET /ads (anti-adblock) ──────────────────────────────────────────────

app.get('/ads', (req, res) => {
  res.status(200).send('');
});

// ─── Catch-all: serve index.html ──────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(CLIENT_ROOT, 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────

async function startServer() {
  const HTTP_PORT = process.env.PORT || cfg.HTTP_PORT;
  const WS_PORT = process.env.WS_PORT || cfg.WS_PORT;

  await db.init();
  console.log('[DB] Database initialized');

  app.listen(HTTP_PORT, () => {
    console.log(`[HTTP] Server listening on http://localhost:${HTTP_PORT}`);
  });

  startGameServer(Number(WS_PORT));
}

startServer().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
