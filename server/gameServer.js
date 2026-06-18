'use strict';

const WebSocket = require('ws');
const cfg = require('./config');
const { BinaryReader, BinaryWriter } = require('./protocol');
const { WorldState, Player, calcSegmentCount, segmentSpacing, packPosToId } = require('./worldState');
const { checkFoodCollision, checkAbilityCollision, checkWormCollisions } = require('./collision');
const db = require('./database');

// ─── Global instances ──────────────────────────────────────────────────────

let wss = null;
const world = new WorldState();

// Wall-clock timestamp of the previous gameTick(), used to compute the real
// elapsed milliseconds between broadcasts for buildUpdatePacket()'s delta-time
// field (see NOTE there). Starts at Date.now() so the very first tick reports
// a sane ~TICK_RATE delta instead of a huge one-off spike.
let lastTickAt = Date.now();

// Pending session tokens: token -> { userId, expiresAt }
const pendingSessions = new Map();

// ─── Session management ────────────────────────────────────────────────────

function createSession(token, userId) {
  pendingSessions.set(token, {
    userId,
    expiresAt: Date.now() + 30000, // 30s to connect
  });
}

function consumeSession(token) {
  const session = pendingSessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    pendingSessions.delete(token);
    return null;
  }
  pendingSessions.delete(token);
  return session;
}

// ─── Server info ───────────────────────────────────────────────────────────

function getPlayerCount() {
  return world.players.size;
}

// ─── Start WebSocket Server ────────────────────────────────────────────────

function startGameServer(port) {
  wss = new WebSocket.Server({ port });

  wss.on('connection', (ws, req) => {
    ws.binaryType = 'nodebuffer';
    ws._player = null;
    ws._authenticated = false;
    ws._pendingToken = null;

    ws.on('message', (data) => {
      try {
        handleMessage(ws, data);
      } catch (err) {
        console.error('[WS] message error:', err.message);
      }
    });

    ws.on('close', () => {
      if (ws._player) {
        handlePlayerDisconnect(ws._player);
      }
    });

    ws.on('error', (err) => {
      console.error('[WS] socket error:', err.message);
    });

    // Kick if no join in 10s
    ws._joinTimeout = setTimeout(() => {
      if (!ws._authenticated) {
        ws.close(4001, 'Timeout');
      }
    }, 10000);
  });

  // ─── Game Loop ─────────────────────────────────────────────────────────

  setInterval(gameTick, cfg.TICK_RATE);

  console.log(`[GameServer] WebSocket listening on port ${port}`);
}

// ─── Message Handler ───────────────────────────────────────────────────────

function handleMessage(ws, data) {
  if (!Buffer.isBuffer(data) && !(data instanceof ArrayBuffer)) return;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length === 0) return;

  const reader = new BinaryReader(buf);
  const firstByte = reader.readUint8();

  if (!ws._authenticated) {
    // Expect join message with opcode 90
    if (firstByte === 90) {
      handleJoin(ws, reader);
    }
    return;
  }

  const player = ws._player;
  if (!player || player.dead) return;

  if (firstByte === 129) {
    // Spectator join – just track
    return;
  }

  // Direction update (3 bytes: angle, flags, boost_intensity)
  // But firstByte is already the angle
  const now = Date.now();
  if (now - player.lastInputAt < 15) return; // rate limit
  player.lastInputAt = now;

  const angleByte = firstByte;
  const flags = buf.length > 1 ? buf[1] : 0;
  player.inputAngle = (angleByte / 256) * 2 * Math.PI;
  player.inputBoosting = (flags & 0x01) !== 0;
}

// ─── Join Handler ──────────────────────────────────────────────────────────

function handleJoin(ws, reader) {
  clearTimeout(ws._joinTimeout);

  if (world.players.size >= cfg.MAX_PLAYERS) {
    ws.close(4000, 'Server full');
    return;
  }

  const skin_id    = reader.readInt16();
  const eyes_id    = reader.readInt16();
  const mouth_id   = reader.readInt16();
  const hat_id     = reader.readInt16();
  const glasses_id = reader.readInt16();
  const zoom       = reader.readUint16();
  const custom_color = reader.readUint32();
  const role       = reader.readUint8();

  // The client sends its session token (D["1ak"]) as the string field in the
  // join packet -- NOT a display name.  Look it up in the DB to get the real
  // username.  Fall back to 'Guest' only if the token is unknown or absent.
  let tokenStr = '';
  while (reader.bytesLeft >= 2) {
    tokenStr += String.fromCharCode(reader.readUint16());
    if (tokenStr.length > 2048) break;
  }
  tokenStr = tokenStr.trim();

  let username = 'Guest';
  let userId = null;
  let resolvedRole = role;
  if (tokenStr) {
    try {
      const user = db.findByToken(tokenStr);
      if (user && !user.is_banned) {
        username = user.username || 'Guest';
        userId   = user.user_id;
        resolvedRole = user.role ?? role;
      }
    } catch {}
  }

  const player = new Player({
    userId,
    token: tokenStr || null,
    username,
    role: resolvedRole,
    skin_id, eyes_id, mouth_id, hat_id, glasses_id,
    zoom, custom_color,
    ws,
  });

  ws._player = player;
  ws._authenticated = true;

  world.addPlayer(player);

  const topPlayers = world.getTopPlayers(10);

  // Send init packet
  sendInit(ws, player);
  sendInventory(ws, player, topPlayers);

  // Let every already-connected client know the online count + scoreboard changed.
  // Each client gets a personalised packet (myRank differs per player).
  for (const p of world.players.values()) {
    if (p.id === player.id) continue; // already covered by sendInventory above
    if (!p.ws || p.ws.readyState !== WebSocket.OPEN) continue;
    try { p.ws.send(buildInventoryPacket(topPlayers, p)); } catch {}
  }

  console.log(`[Game] Player joined: ${username} (id=${player.id}, total=${world.players.size})`);
}

// ─── Player Disconnect ─────────────────────────────────────────────────────

function handlePlayerDisconnect(player) {
  if (!player.dead) {
    player.dead = true;
    world.spawnBodyFood(player);
    world.killEvents.push({ victim: player, killer: null, headshot: false });
  }
  world.removePlayer(player.id);
  console.log(`[Game] Player disconnected: ${player.username} (id=${player.id})`);

  // Same reasoning as in handleJoin: the remaining clients' xi and scoreboard
  // need to reflect this player leaving too.
  broadcastOnlineCount(world.getTopPlayers(10));
}

// ─── Game Tick ─────────────────────────────────────────────────────────────

function gameTick() {
  world.tickNumber++;
  world.worldTime += cfg.TICK_RATE;

  // Real elapsed time since the previous tick. setInterval's requested delay
  // (cfg.TICK_RATE) is only a target -- under load or timer drift the actual
  // gap can differ -- so this is measured directly rather than assumed, and
  // is what gets sent to clients as the interpolation delta (see
  // buildUpdatePacket's NOTE on this same value).
  const now = Date.now();
  const dt = now - lastTickAt;
  lastTickAt = now;

  // 1. Process inputs & update positions
  for (const player of world.players.values()) {
    if (player.dead || player.spectating) continue;
    updatePlayerMovement(player);
  }

  // 2. Check collisions
  const kills = checkWormCollisions(world);
  processKills(kills);

  // 3. Food & ability collisions for living players
  for (const player of world.players.values()) {
    if (player.dead || player.spectating) continue;
    checkFoodCollision(player, world);
    checkAbilityCollision(player, world);
    tickAbilities(player);
  }

  // 4. Maintain world
  world.maintainFood();
  world.maintainAbilities();

  // 5. Broadcast
  broadcastUpdate(dt);

  // 6. Clear events
  world.clearEvents();
}

// ─── Movement ──────────────────────────────────────────────────────────────

function updatePlayerMovement(player) {
  // Smooth angle
  const target = player.inputAngle;
  let diff = target - player.angle;
  // Normalize to [-π, π]
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  const turnRate = 0.15;
  player.angle += diff * turnRate;

  // Speed scales with the worm's own current segment spacing (jb), not a
  // fixed constant -- see the long comment on BASE_SPEED_FACTOR in config.js
  // for why: every tick adds exactly one segment at the new head position
  // (below), so head-distance-per-tick IS the gap between segments, and that
  // gap must track jb for a 10-segment worm and a 200-segment worm to both
  // move at "one segment-length per tick" instead of one fixed distance.
  const jb = segmentSpacing(player.kb);

  // Boost
  if (player.inputBoosting && player.kb > cfg.BOOST_MIN_LENGTH) {
    player.speed = cfg.BOOST_SPEED_FACTOR * jb;
    player.kb -= cfg.BOOST_COST;
    if (player.kb < cfg.BOOST_MIN_LENGTH) {
      player.kb = cfg.BOOST_MIN_LENGTH;
      player.inputBoosting = false;
    }
  } else {
    player.speed = cfg.BASE_SPEED_FACTOR * jb;
  }

  // Ability: speed boost (type 0)
  if (player.abilities[0] && player.abilities[0].charge > 0) {
    player.speed *= 1.5;
  }

  // Move head
  player.headX += Math.cos(player.angle) * player.speed;
  player.headY += Math.sin(player.angle) * player.speed;

  // Update segments
  const targetCount = calcSegmentCount(player.kb);
  // Add segment at head
  player.segments.unshift({ x: player.headX, y: player.headY });
  // Trim or pad
  while (player.segments.length > targetCount) player.segments.pop();
  while (player.segments.length < targetCount) {
    const last = player.segments[player.segments.length - 1];
    player.segments.push({ x: last.x, y: last.y });
  }
}

// ─── Kill processing ───────────────────────────────────────────────────────

function processKills(kills) {
  for (const kill of kills) {
    const { victim, killer, headshot } = kill;
    if (!world.players.has(victim.id)) continue;

    // Spawn body food
    world.spawnBodyFood(victim);
    world.removePlayer(victim.id);

    // Track kill event
    world.killEvents.push({ victim, killer, headshot });

    // Update killer stats
    if (killer) {
      killer.sessionKills++;
      if (headshot) killer.sessionHeadshots++;
    }

    // Save victim stats to DB
    if (victim.userId) {
      try {
        const points = Math.floor(victim.kb * 50);
        db.updateStats(victim.userId, {
          kills: victim.sessionKills,
          headshots: victim.sessionHeadshots,
          max_score: victim.kb,
          points,
        });
      } catch {}
    }

    // Close WS
    try {
      victim.ws.close(1000, 'dead');
    } catch {}
  }
}

// ─── Abilities tick ────────────────────────────────────────────────────────

function tickAbilities(player) {
  const now = Date.now();
  for (const [type, ab] of Object.entries(player.abilities)) {
    if (ab.expires && now > ab.expires) {
      ab.charge = 0;
    } else {
      // Decay charge
      const remaining = (ab.expires - now) / cfg.ABILITY_DURATION_MS;
      ab.charge = Math.round(remaining * 100);
    }
  }
}

// ─── Broadcast ─────────────────────────────────────────────────────────────

function broadcastUpdate(dt) {
  const topPlayers = world.getTopPlayers(10);        // scoreboard: by kb
  const hsTop     = world.getTopByHeadshots(10);     // HS panel: by headshots

  for (const player of world.players.values()) {
    if (!player.ws || player.ws.readyState !== WebSocket.OPEN) continue;
    try {
      const packet = buildUpdatePacket(player, topPlayers, hsTop, dt);
      player.ws.send(packet);
    } catch {}
  }

  // Scoreboard (opcode 3) + minimap every 5 ticks.
  if (world.tickNumber % cfg.MINIMAP_TICK_INTERVAL === 0) {
    const minimapPacket = buildMinimapPacket();
    for (const player of world.players.values()) {
      if (!player.ws || player.ws.readyState !== WebSocket.OPEN) continue;
      try {
        player.ws.send(minimapPacket);
        player.ws.send(buildInventoryPacket(topPlayers, player));
      } catch {}
    }
  }
}

// ─── OPCODE 0: Init ────────────────────────────────────────────────────────

function sendInit(ws, player) {
  const hsTop = world.getTopByHeadshots(10);  // RECORD panel = ranked by headshots
  const w = new BinaryWriter(512);

  w.writeUint8(0);
  w.writeUint8(0);
  w.writeInt16(player.id);
  w.writeFloat32(cfg.WORLD_HALF);
  w.writeFloat32(cfg.SCALE_THRESHOLD);
  w.writeFloat32(cfg.GROWTH_FACTOR);
  w.writeUint8(hsTop.length);

  for (const p of hsTop) {
    w.writeUint8(p.role);
    w.writeInt16(p.sessionHeadshots);  // RECORD panel shows headshot count
    w.writeUint8(p.username.length);
    w.writeString(p.username);
  }

  ws.send(w.toBuffer());
}

// ─── OPCODE 3: Inventory ───────────────────────────────────────────────────
//
// Client parser jk() reads:
//   xi  = g.ia() = Int16  -- online count (HUD "(N online)" text)
//   mf  = g.ia() = Int16  -- my rank on the scoreboard (0 = not in top list)
//   P   = g.f()  = Int8   -- gd entry count (main scoreboard entries)
//   per entry:
//     Ki = g.ia() = Int16    -- player id (looked up in xb[] for name display)
//     Kb = g.n()  = Float32  -- score displayed (Math.floor(Kb) shown in panel)
//   Wd count + entries (VIP mode only, always 0 here)
//
// The main SCOREBOARD panel is driven entirely by gd entries here.  If count=0
// the scoreboard is always blank.  We send the current top-10 list so the
// panel shows live rankings.
//
// Score value: Ze() sets worm.Kb = 50 * h (h = raw kb float from nl/yl), so
// all score displays show 50*kb.  We mirror that here: Math.floor(kb * 50).
function buildInventoryPacket(topPlayers, me) {
  const entries = topPlayers || [];
  // my rank (1-based; 0 = not in the top list)
  let myRank = 0;
  if (me) {
    const idx = entries.findIndex(p => p.id === me.id);
    myRank = idx >= 0 ? idx + 1 : 0;
  }

  const w = new BinaryWriter(32 + entries.length * 8);
  w.writeUint8(3);
  w.writeInt16(world.players.size);   // xi -- online player count
  w.writeInt16(myRank);               // mf -- my rank (Int16)
  w.writeInt8(entries.length);        // gd count (Int8 signed, g.f() = getInt8)
  for (const p of entries) {
    w.writeInt16(p.id);                         // Ki -- player id (Int16)
    w.writeFloat32(Math.floor(p.kb * 50));      // Kb -- score (Float32)
  }
  w.writeUint8(0); // Wd count (VIP mode only, always 0)
  return w.toBuffer();
}

function sendInventory(ws, player, topPlayers) {
  ws.send(buildInventoryPacket(topPlayers, player));
}

// Broadcasts the current online count + scoreboard (opcode 3) to every client.
// xi and the gd scoreboard list are only ever pushed inside this opcode --
// not in the per-tick update packet -- so without a broadcast here every
// already-connected client would see stale data.
function broadcastOnlineCount(topPlayers) {
  for (const p of world.players.values()) {
    if (!p.ws || p.ws.readyState !== WebSocket.OPEN) continue;
    try { p.ws.send(buildInventoryPacket(topPlayers, p)); } catch {}
  }
}

// ─── OPCODE 1: Game State Update ───────────────────────────────────────────

function buildUpdatePacket(me, topPlayers, hsTop, dt) {
  const w = new BinaryWriter(8192);

  w.writeUint8(1);
  // Client Yj: g.ia() = getInt16 (2 bytes) = delta time in ms.
  // Must be exactly Int16/Uint16 (2 bytes). Previous writeUint16 was already
  // the right size -- the smoothing issue is elsewhere. writeInt32 (4 bytes)
  // was wrong and offset every subsequent byte by 2.
  w.writeInt16(Math.min(32767, dt));

  // Section 1: New spawns (food + abilities combined).
  // Client has a single spawn-reader (Sk) that both food and ability orbs flow
  // through and share the same id-keyed dictionary -- there is no separate
  // "new abilities" reader, so they must be sent together here, in this order.
  // (See the per-spawn "gb" comment below for the confirmed texture-id ranges.)
  const newSpawns = [...world.newFood, ...world.newAbilities];
  w.writeVarInt(newSpawns.length);
  for (const s of newSpawns) {
    // NOTE: the client never receives a separate x/y for spawns -- it decodes
    // the position straight out of this same id via zn()/Gn() (see packPosToId
    // in worldState.js for the exact inverse formula). Sending the raw internal
    // counter id here (as before) made every food/ability render at a essentially
    // random position derived from its spawn order instead of its real location,
    // which is part of why the world looked chaotic / worms looked desynced from
    // what was actually nearby. The internal Map key (s.id) is untouched -- only
    // the wire value changes -- so collision lookups elsewhere are unaffected.
    w.writeUint32(packPosToId(s.x, s.y));
    // NOTE: no per-spawn "qi" byte here -- client only reads that byte when
    // game_mode (vc) === T.Sb.ad (16); our server always runs normal mode (vc=0),
    // where the client skips this field entirely and uses a default internally.
    const isAbility = s.type !== undefined && s.sizeTier === undefined;
    w.writeFloat32(isAbility ? 1 : s.sizeTier); // Ac -- scale factor
    // gb -- texture/skin registry index. Decoded the client's real registry
    // (media/registry.wormzilla, portionDict) to confirm the valid ids: food
    // textures are 0-33, ability orb textures are a SEPARATE block at
    // 200-207 ("ability_0a".."ability_7a"). The client's be() ctor also uses
    // "80 <= gb" as an internal flag to render the orb at flat scale instead
    // of using the spawn's Ac/sizeTier -- 200+ already satisfies that, so no
    // separate flag byte is needed. Using a food id for abilities (as before)
    // both showed the wrong icon and could crash the client's texture lookup
    // (this.Um[gb] undefined) whenever the food/ability ranges didn't line up.
    w.writeUint8(isAbility ? (200 + (s.type % cfg.ABILITY_TYPES)) : (s.type % cfg.FOOD_TYPES));
  }

  // Section 2: Food "grow pulse" animation ($k in client -- T.Tn.h.prototype.$k).
  // Reads ONLY a food id (Int32 via Rf()) per entry: g.Wb[id].md *= 1.5, a
  // brief "pulse bigger" visual with no eating and no player involved. There
  // is currently no server-side game event that corresponds to this (it's
  // distinct from a food being eaten -- see dl()/Section 3 below, which is
  // the actual eat animation), so nothing is invented here: an empty count
  // keeps the byte stream correctly aligned for every section that follows,
  // which is required regardless of whether this feature itself is ever used,
  // since the client's Yj() parser unconditionally reads this section's count
  // before moving on to dl().
  w.writeVarInt(0);

  // Section 3: Eaten food (dl in client -- T.Tn.h.prototype.dl).
  // Per entry the client reads: food id (Int32 via Rf()), THEN a separate
  // player id (Int16 via ia()). It uses the player id to look up that
  // worm's CURRENT head position (g.Ad() -> {lb, mb}) and sets the food
  // sprite's flight target there (x.Yi(lb, mb, false)) -- this is what
  // actually plays the "food flies into the mouth" animation. The previous
  // code only wrote the 4-byte food id and nothing else, so the client was
  // reading the next packet's bytes as if they were this player id, corrupting
  // every section after this one. Must send the SAME packed-position id the
  // client received when this food was spawned (Section 1), since the client
  // looks the food up in its dictionary by that exact id (this.h.Wb[x.G]).
  w.writeVarInt(world.eatenFood.length);
  for (const f of world.eatenFood) {
    w.writeUint32(packPosToId(f.x, f.y));
    w.writeInt16(f.eaterPlayerId);
  }

  // NOTE: there is no separate "collected abilities" section here. Traced
  // the client's Yj() packet parser fully -- ability orbs share the exact
  // same spawn dictionary and eat handler as food (Sk/dl in
  // T.Tn.h.prototype), so collected ability orbs are already included in
  // world.eatenFood above and sent through Section 3. A previous version of
  // this code sent an extra invented section here with its own count field,
  // which the client's parser never reads -- it would shift every section
  // after it (new players, kills, worm positions, leaderboard) onto the
  // wrong bytes for any tick where an ability orb was picked up.

  // Section 4: New players
  w.writeVarInt(world.newPlayers.length);
  for (const p of world.newPlayers) {
    w.writeInt16(p.id);
    w.writeInt16(p.skin_id);
    w.writeInt16(p.eyes_id);
    w.writeInt16(p.mouth_id);
    w.writeInt16(p.hat_id);
    w.writeInt16(p.glasses_id);
    w.writeUint8(p.role);
    w.writeUint8(p.username.length);
    w.writeString(p.username);
  }

  // Section 5: Kill events
  w.writeVarInt(world.killEvents.length);
  for (const evt of world.killEvents) {
    w.writeInt16(evt.victim.id);
    let flags = 0;
    if (evt.killer) flags |= 0x01;
    if (evt.headshot) flags |= 0x02;
    if (evt.killer) flags |= 0x04;
    w.writeUint8(flags);
    if (evt.killer) w.writeInt16(evt.killer.id);
  }

  // Section 6: Worm position updates.
  // Our own worm (me) needs to appear here EXACTLY ONCE -- on the very first
  // packet after join -- and be excluded on every packet after that.
  //
  // Why once is required: the client's parser for this section (nl() in
  // 0tEwHoKWpm.js) resolves the worm by id via sc(id), which returns
  // this.h.T (the local player's own worm object) whenever id === own
  // player id, then calls x.Aa(!0) on it. Aa(true) is the ONLY place in the
  // client that creates that worm's render sprite (Ye.prototype.jh -> Wj(),
  // which builds this.qa/this.ba) -- Section 11 (yl(), "my player data")
  // never calls Aa() at all, it only ever calls Ci() to move an already-
  // existing sprite. Excluding our own worm from this section unconditionally
  // (as a previous fix did, to stop tick-by-tick jitter) meant Aa(true) was
  // never called for it, so it never got a sprite and stayed invisible.
  //
  // Why every packet AFTER the first must still exclude it: nl() also does
  // x.Ze(P) + x.an(...), which hard-resets the worm's entire segment array
  // straight from this section's values with no interpolation. Section 11
  // ALSO runs on that same this.h.T object every tick via Ci(headX, headY),
  // which does delta-based IK redistribution of the whole body from the
  // previous frame's position. If both sections keep including our own worm
  // every tick, they fight over the same object every frame -- nl() snapping
  // it to one set of coordinates, then yl()/Ci() immediately recomputing the
  // chain from a different delta -- producing back-and-forth jitter. So the
  // one-time appearance is purely to fire Aa(true)/create the sprite; after
  // that, Section 11 alone is the correct (and only) path for moving it.
  //
  // Other worms are unaffected either way: sc() routes them to
  // this.h.xb[id] (separate T.Le instances that only ever get updated via
  // this section, never via yl()), so they keep receiving full segment
  // arrays every tick as before.
  const sendSelf = !me.selfRendered;
  const livePlayers = Array.from(world.players.values()).filter(p => !p.dead && !p.spectating && (sendSelf || p.id !== me.id));
  if (sendSelf) me.selfRendered = true;
  w.writeVarInt(livePlayers.length);
  for (const p of livePlayers) {
    w.writeInt16(p.id);
    w.writeFloat32(p.kb);
    const segCount = Math.min(p.segments.length, 200);
    w.writeUint8(segCount);
    for (let i = 0; i < segCount; i++) {
      w.writeFloat32(p.segments[i].x);
      w.writeFloat32(p.segments[i].y);
    }
  }

  // Section 7: Invisible worms
  w.writeUint8(0);

  // Section 8: Worm ability-charge indicator updates (vl in client).
  // Client reads this as a per-worm update with a VarInt-counted sub-list of
  // ability charge percentages; we don't have a confirmed server-side source
  // for this data yet, so we send an empty list (count=0) to stay correctly
  // positioned for the sections that follow without guessing its contents.
  w.writeVarInt(0);

  // Section 9: Server dots (minimap dots - simplified)
  w.writeVarInt(0);

  // Section 10: Top 10 leaderboard -- HS panel shows headshot count per player.
  w.writeUint8(hsTop.length);
  for (const p of hsTop) {
    w.writeUint16(p.id & 0xFFFF);
    w.writeUint16(Math.min(65535, p.sessionHeadshots));
    w.writeUint8(p.role);
  }

  // Section 11: My player data (yl() in client).
  // yl() read order (verified from 0tEwHoKWpm.js):
  //   I = g.f()          -- Int8 flags
  //   if (2 & I):
  //     P.Ze(g.n())      -- Float32 new worm length (kb); Ze() stores: this.Kb = 50*h
  //   if (4 & I):
  //     this.h.Hi = g.n() -- Float32 (zoom/scale hint, unused server-side)
  //   R = g.n()          -- Float32 headX
  //   I = g.n()          -- Float32 headY
  //   P.Ci(R, I, w)      -- move worm (w = boosting flag from bit0)
  //   k.cf[0] = g.n()    -- Float32 food_nearby_x
  //   k.cf[1] = g.n()    -- Float32 food_nearby_y
  //   w = this.kb(g)     -- VarInt active ability count
  //   per ability: type (Int8), charge (Int8)
  //
  // BIT 1 (0x02) MUST always be set so Ze() is called every tick with the
  // current kb value.  Without it the client never updates worm.Kb, which
  // means the score HUD always shows 0 and the worm never visually grows.
  // When bit1 is set, kb is read BEFORE headX -- order matters.
  let myFlags = 0x02; // bit1: send kb; always on so score updates every tick
  if (me.inputBoosting) myFlags |= 0x01; // bit0: boosting flag for Ci()
  w.writeInt8(myFlags);
  w.writeFloat32(me.kb);   // kb -- sent first because bit1 is set (Ze reads it here)
  w.writeFloat32(me.headX);
  w.writeFloat32(me.headY);
  w.writeFloat32(0); // food_nearby_x
  w.writeFloat32(0); // food_nearby_y

  // Active abilities
  const activeAbilities = Object.values(me.abilities).filter(a => a.charge > 0);
  w.writeVarInt(activeAbilities.length);
  for (const ab of activeAbilities) {
    w.writeInt8(ab.type);
    w.writeInt8(ab.charge);
  }

  // Section 12: trailing VarInt(0) -- never consumed by client's Yj parser
  // (nothing is read after yl()), harmless.
  w.writeVarInt(0);

  return w.toBuffer();
}

// ─── OPCODE 2: Minimap ─────────────────────────────────────────────────────

function buildMinimapPacket() {
  const w = new BinaryWriter(640);
  w.writeUint8(2);
  // 628 bytes of bitmap
  const bitmap = new Uint8Array(628);
  const players = Array.from(world.players.values()).filter(p => !p.dead);
  for (const p of players) {
    const mx = Math.floor((p.headX / cfg.WORLD_SIZE + 0.5) * 80);
    const my = Math.floor((p.headY / cfg.WORLD_SIZE + 0.5) * 80);
    if (mx >= 0 && mx < 80 && my >= 0 && my < 80) {
      const bitIndex = my * 80 + mx;
      const byteIndex = Math.floor(bitIndex / 8);
      if (byteIndex < 628) bitmap[byteIndex] |= (1 << (bitIndex % 8));
    }
  }
  for (let i = 0; i < 628; i++) w.writeUint8(bitmap[i]);
  return w.toBuffer();
}

module.exports = { startGameServer, createSession, consumeSession, getPlayerCount };
