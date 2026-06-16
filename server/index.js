'use strict';

const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const BinaryReader = require('./BinaryReader');
const { GameState, WORLD_HALF } = require('./GameState');
const {
  buildMsg0, buildMsg1, buildMsg2, buildMsg3, buildMsg4, buildMsg5
} = require('./PacketBuilder');

const PORT = process.env.PORT || 3000;
const WS_PORT = process.env.WS_PORT || 3001;
const CLIENT_DIR = path.resolve(__dirname, '../client');

// ─── In-memory user store ────────────────────────────────────────────────────
const users = new Map();  // token → user object
const credentials = new Map(); // google credential → token

function makeUser(username, credential = null) {
  const token = crypto.randomBytes(16).toString('hex');
  const user = {
    user_id: crypto.randomBytes(8).toString('hex'),
    username,
    token,
    texp: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
    coins: 0,
    level: 1,
    skin_id: 0, eyes_id: 0, mouth_id: 0, glasses_id: 0, hat_id: 0,
    best_survival: 0,
    headshots: 0,
    isConsentGiven: true,
    skins: [], eyes: [], mouths: [], glasses: [], hats: [],
    nameTokens: 1,
    kills: 0,
    max_score: 0,
    credential,
  };
  users.set(token, user);
  if (credential) credentials.set(credential, token);
  return user;
}

// Create a default guest user for easy testing
const guestToken = 'guesttoken123';
users.set(guestToken, {
  user_id: 'guest001',
  username: 'Guest',
  token: guestToken,
  texp: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
  coins: 999,
  level: 5,
  skin_id: 0, eyes_id: 0, mouth_id: 0, glasses_id: 0, hat_id: 0,
  best_survival: 0,
  headshots: 0,
  isConsentGiven: true,
  skins: [], eyes: [], mouths: [], glasses: [], hats: [],
  nameTokens: 5,
  kills: 0,
  max_score: 0,
});

// ─── Express HTTP server ─────────────────────────────────────────────────────
const app = express();
app.use(express.static(CLIENT_DIR));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

function userPublic(u) {
  return {
    user_id: u.user_id,
    username: u.username,
    token: u.token,
    texp: u.texp,
    coins: u.coins,
    level: u.level,
    skin_id: u.skin_id,
    eyes_id: u.eyes_id,
    mouth_id: u.mouth_id,
    glasses_id: u.glasses_id,
    hat_id: u.hat_id,
    best_survival: u.best_survival,
    headshots: u.headshots,
    isConsentGiven: u.isConsentGiven,
    skins: u.skins,
    eyes: u.eyes,
    mouths: u.mouths,
    glasses: u.glasses,
    hats: u.hats,
    nameTokens: u.nameTokens,
  };
}

// GET /api/login/:token
app.get('/api/login/:token', (req, res) => {
  const u = users.get(req.params.token);
  if (!u) return res.json({ code: 404 });
  res.json({ code: 200, data: userPublic(u) });
});

// POST /api/start_game/
app.post('/api/start_game/', (req, res) => {
  res.json({ code: 200, url: `ws://localhost:${WS_PORT}` });
});

// POST /api/register/:credential
app.post('/api/register/:credential', (req, res) => {
  const { username } = req.body;
  if (!username) return res.json({ code: 400 });
  // Check duplicate
  for (const u of users.values()) {
    if (u.username.toLowerCase() === username.toLowerCase()) {
      return res.json({ code: 201 });
    }
  }
  const u = makeUser(username, req.params.credential);
  credentials.set(req.params.credential, u.token);
  res.json({ code: 200, data: userPublic(u) });
});

// GET /api/google_login/:credential
app.get('/api/google_login/:credential', (req, res) => {
  const cred = req.params.credential;
  const token = credentials.get(cred);
  if (token) {
    const u = users.get(token);
    return res.json({ code: 200, data: userPublic(u) });
  }
  // New user: ask for nickname
  res.json({ code: 202 });
});

// POST /api/get_leaderboard/
app.post('/api/get_leaderboard/', (req, res) => {
  const list = [...users.values()].map(u => ({
    id: u.user_id,
    username: u.username,
    kills: u.kills || 0,
    headshots: u.headshots || 0,
    max_score: u.max_score || 0,
    level: u.level || 1,
  })).sort((a, b) => b.max_score - a.max_score).slice(0, 100);
  res.json({ list, me: req.body.a || '' });
});

// POST /api/buy-property/:token
app.post('/api/buy-property/:token', (req, res) => {
  const u = users.get(req.params.token);
  if (!u) return res.status(404).end();
  const { id, type } = req.query;
  const validTypes = ['skins', 'eyes', 'mouths', 'glasses', 'hats'];
  if (!validTypes.includes(type)) return res.status(400).end();
  if (!u[type].includes(Number(id))) u[type].push(Number(id));
  res.status(200).end();
});

// POST /api/nick-change/
app.post('/api/nick-change/', (req, res) => {
  const { token, username } = req.body;
  const u = users.get(token);
  if (!u) return res.json({ code: 404 });
  if ((u.nameTokens || 0) < 1) return res.json({ code: 202 });
  for (const other of users.values()) {
    if (other !== u && other.username.toLowerCase() === username.toLowerCase()) {
      return res.json({ code: 201 });
    }
  }
  u.username = username;
  u.nameTokens = (u.nameTokens || 1) - 1;
  res.json({ code: 200 });
});

const httpServer = http.createServer(app);
httpServer.listen(PORT, () => {
  console.log(`[HTTP] Serving on http://localhost:${PORT}`);
});

// ─── WebSocket game server ────────────────────────────────────────────────────
const game = new GameState();
const wss = new WebSocketServer({ port: WS_PORT });

// Map ws → worm
const wsToWorm = new Map();

wss.on('connection', (ws) => {
  console.log('[WS] New connection');
  let worm = null;
  let spawned = false;

  ws.on('message', (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);

    // Direction packet: exactly 2 bytes
    if (buf.byteLength === 2) {
      if (!worm || !worm.alive) return;
      const angleByte = buf[0];
      const flags = buf[1];
      worm.setDirection(angleByte, flags);
      return;
    }

    // Spawn packet: byte[0] === 99 and byteLength > 2
    if (buf.byteLength > 2 && buf[0] === 99) {
      if (spawned) return; // already spawned
      spawned = true;
      parseSpawnPacket(ws, buf);
      return;
    }

    console.log('[WS] Unknown packet, len=', buf.byteLength, 'byte0=', buf[0]);
  });

  ws.on('close', () => {
    if (worm) {
      console.log(`[WS] Disconnected worm id=${worm.id}`);
      wsToWorm.delete(ws);
      game.removeWorm(worm.id);
      // Broadcast removal to others
      const rem = buildMsg1(tickId, game.gameMode, { removals: [worm.id] });
      broadcast(rem, ws);
    }
  });

  ws.on('error', (e) => console.error('[WS] Error:', e.message));
});

function parseSpawnPacket(ws, buf) {
  const r = new BinaryReader(buf);
  r.readUInt8(); // 99 marker
  const skin    = r.readInt16();
  const eyes    = r.readInt16();
  const mouth   = r.readInt16();
  const glasses = r.readInt16();
  const hat     = r.readInt16();
  const serverPort = r.readUInt16();
  const teamColor  = r.readUInt32();

  // Read name (remaining bytes / 2 chars)
  const remaining = (buf.byteLength - r.pos) / 2;
  const nameLen = Math.min(2048, Math.floor(remaining));
  let name = '';
  for (let i = 0; i < nameLen; i++) {
    name += String.fromCharCode(r.readInt16());
  }
  if (!name.trim()) name = 'No nickname';

  const cosmetics = { skin, eyes, mouth, glasses, hat };
  const worm = game.addWorm(ws, name, cosmetics);
  wsToWorm.set(ws, worm);

  console.log(`[WS] Spawned "${name}" id=${worm.id}`);

  // Send MSG 0
  const msg0 = buildMsg0(game.gameMode, worm.id, game.worldHalf, []);
  send(ws, msg0);

  // Send initial food batch (MSG 1 tick 0, new foods only)
  const foodList = [...game.foods.values()].slice(0, 2000);
  const msg1init = buildMsg1(0, game.gameMode, {
    newFoods: foodList,
    newWorms: [...game.worms.values()].filter(w => w.id !== worm.id),
  });
  send(ws, msg1init);

  // Send announcement
  const ann = buildMsg4(`Welcome, ${name}! ${game.worms.size} players online.`);
  send(ws, ann);

  // Broadcast this new worm to everyone else
  const newWormPkt = buildMsg1(tickId, game.gameMode, { newWorms: [worm] });
  broadcast(newWormPkt, ws);
}

function send(ws, buf) {
  try {
    if (ws.readyState === ws.OPEN) ws.send(buf);
  } catch (e) { /* ignore */ }
}

function broadcast(buf, excludeWs = null) {
  for (const [ws] of wsToWorm) {
    if (ws !== excludeWs) send(ws, buf);
  }
}

// ─── Game loop ────────────────────────────────────────────────────────────────
let tickId = 0;
let minimapTick = 0;
const TICK_MS = 10;
const MINIMAP_INTERVAL = 500; // send minimap every 500ms

setInterval(() => {
  tickId++;
  const { eatenWithEater } = game.update();

  const scoreUpdates = [];
  for (const [ws, worm] of wsToWorm) {
    if (!worm.alive) continue;
    scoreUpdates.push({
      id: worm.id,
      score: worm.score,
      segments: worm.segments,
    });
  }

  // Self-update per client
  for (const [ws, worm] of wsToWorm) {
    if (!worm.alive) continue;
    const selfUpdate = {
      alive: true,
      score: worm.score,
      x: worm.x,
      y: worm.y,
      abilities: [],
    };
    const pkt = buildMsg1(tickId, game.gameMode, {
      eatenFoodsWithEater: eatenWithEater,
      scoreUpdates,
      selfUpdate,
    });
    send(ws, pkt);
  }

  // Minimap every 500ms
  minimapTick += TICK_MS;
  if (minimapTick >= MINIMAP_INTERVAL) {
    minimapTick = 0;
    const mm = buildMsg2([...game.worms.values()]);
    for (const [ws] of wsToWorm) send(ws, mm);
  }
}, TICK_MS);

// New food broadcast every 200ms
setInterval(() => {
  const spawned = game.spawnBatch(50);
  if (spawned.length === 0) return;
  const pkt = buildMsg1(tickId, game.gameMode, { newFoods: spawned });
  for (const [ws] of wsToWorm) send(ws, pkt);
}, 200);

console.log(`[WS] Game server on ws://localhost:${WS_PORT}`);
