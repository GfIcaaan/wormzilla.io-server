'use strict';

const cfg = require('./config');

// ─── ID Generators ─────────────────────────────────────────────────────────

let nextPlayerId = 1;
let nextFoodId = 1;
let nextAbilityId = 1;

function genPlayerId() {
  const id = nextPlayerId++;
  if (nextPlayerId > 32767) nextPlayerId = 1;
  return id;
}
function genFoodId() { return nextFoodId++; }
function genAbilityId() { return nextAbilityId++; }

// ─── Math helpers ──────────────────────────────────────────────────────────

function randRange(min, max) { return min + Math.random() * (max - min); }

function randomWorldPos() {
  // Random point inside circle of radius WORLD_HALF
  const angle = Math.random() * 2 * Math.PI;
  const r = Math.sqrt(Math.random()) * (cfg.WORLD_HALF - 100);
  return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
}

// ─── Position packing for spawn IDs ────────────────────────────────────────
//
// The client never receives a separate x/y for food/ability spawns -- it
// decodes the position straight out of the same 32-bit value it uses as the
// dictionary key (T.Tn.h.zn/Gn in 0tEwHoKWpm.js):
//   x = ((id & 0xFFFF) / 32768 - 1) * (1.02 * WORLD_HALF)
//   y = (((id >>> 16) & 0xFFFF) / 32768 - 1) * (1.02 * WORLD_HALF)
// packPosToId() below is the exact inverse of that formula. This only
// affects the value written to the wire for new spawns -- the server's
// internal Map keys (food.id / ability.id from genFoodId/genAbilityId)
// are untouched, so collision lookups and the food/ability Maps keep
// working exactly as before.
function packPosToId(x, y) {
  const scale = 1.02 * cfg.WORLD_HALF; // matches client's Oi()
  let lowWord = Math.round((x / scale + 1) * 32768);
  let highWord = Math.round((y / scale + 1) * 32768);
  lowWord = Math.max(0, Math.min(65535, lowWord));
  highWord = Math.max(0, Math.min(65535, highWord));
  return ((highWord << 16) | lowWord) >>> 0;
}

// ─── Segment count from internal length ───────────────────────────────────

function calcSegmentCount(kb) {
  let p = kb;
  if (p > cfg.SCALE_THRESHOLD) {
    p = Math.atan((p - cfg.SCALE_THRESHOLD) / cfg.GROWTH_FACTOR) * cfg.GROWTH_FACTOR + cfg.SCALE_THRESHOLD;
  }
  const sqrtVal = Math.sqrt(4 * Math.pow(5 * p, 0.707106781186548) + 25);
  return Math.min(cfg.MAX_SEGMENTS, Math.max(3, Math.floor(5 * (sqrtVal - 5) + 1)));
}

// ─── Collision radius ──────────────────────────────────────────────────────

function collisionRadius(kb) {
  const segs = calcSegmentCount(kb);
  return 0.025 * (5 + 0.9 * segs);
}

// ─── Player / Worm ─────────────────────────────────────────────────────────

class Player {
  constructor({ userId, token, username, role, skin_id, eyes_id, mouth_id, hat_id, glasses_id, zoom, custom_color, ws }) {
    this.userId = userId;       // DB UUID
    this.token = token;
    this.id = genPlayerId();    // int16 game ID
    this.username = username;
    this.role = role || 0;
    this.skin_id = skin_id || 1;
    this.eyes_id = eyes_id || 0;
    this.mouth_id = mouth_id || 0;
    this.hat_id = hat_id || 0;
    this.glasses_id = glasses_id || 0;
    this.zoom = zoom || 0;
    this.custom_color = custom_color || 0;
    this.ws = ws;

    // Position
    const pos = randomWorldPos();
    this.headX = pos.x;
    this.headY = pos.y;
    this.angle = Math.random() * 2 * Math.PI;

    // Stats
    this.kb = cfg.INITIAL_LENGTH;      // internal length
    // Initial speed: same proportional-to-jb formula used every tick in
    // updatePlayerMovement() (gameServer.js) -- this is just the value before
    // the first tick runs, so it must match that formula instead of a fixed
    // constant (see BASE_SPEED_FACTOR comment in config.js).
    this.speed = cfg.BASE_SPEED_FACTOR * collisionRadius(this.kb);
    this.boosting = false;

    // Segments: start with enough to fill initial length
    this.segments = this._initSegments();

    // Session stats
    this.sessionKills = 0;
    this.sessionHeadshots = 0;
    this.coins = 0;

    // Abilities: slot -> { type, charge 0-100, expires }
    this.abilities = {};

    // Input queue
    this.inputAngle = this.angle;
    this.inputBoosting = false;
    this.inputBoostIntensity = 0;
    this.lastInputAt = 0;

    // State
    this.dead = false;
    this.spectating = false;
    this.joinedAt = Date.now();
    // Tracks whether this player's own worm has been sent at least once in
    // buildUpdatePacket's Section 6 (worm position array). The client's
    // parser for that section (nl() in 0tEwHoKWpm.js) is the ONLY place that
    // calls Aa(true) on a worm object, which is what actually creates that
    // worm's render sprite (Ye.prototype.jh -> Wj()) -- Section 11 (yl(),
    // "my player data") never does. So our own worm must appear in Section 6
    // at least once (right after join) or it never gets a sprite and stays
    // invisible forever, even though Section 11 keeps updating its position
    // correctly every tick after that.
    this.selfRendered = false;
  }

  _initSegments() {
    const count = calcSegmentCount(this.kb);
    // jb = segment spacing, matches client Ze(): 0.025 * (5 + 0.9 * segCount)
    const jb = 0.025 * (5 + 0.9 * count);
    const segs = [];
    for (let i = 0; i < count; i++) {
      segs.push({
        x: this.headX - Math.cos(this.angle) * i * jb,
        y: this.headY - Math.sin(this.angle) * i * jb,
      });
    }
    return segs;
  }

  getRadius() { return collisionRadius(this.kb); }
  getScore()  { return Math.floor(this.kb * 50); }
}

// ─── Food ──────────────────────────────────────────────────────────────────

class Food {
  constructor(x, y, type, sizeTier) {
    this.id = genFoodId();
    this.x = x;
    this.y = y;
    this.type = type !== undefined ? type : Math.floor(Math.random() * cfg.FOOD_TYPES);
    this.sizeTier = sizeTier !== undefined ? sizeTier : 1;
    this.isBodyFood = false;
  }
}

function spawnFood() {
  const pos = randomWorldPos();
  return new Food(pos.x, pos.y, Math.floor(Math.random() * cfg.FOOD_TYPES), 1);
}

// ─── Ability Orb ───────────────────────────────────────────────────────────

class Ability {
  constructor() {
    this.id = genAbilityId();
    const pos = randomWorldPos();
    this.x = pos.x;
    this.y = pos.y;
    this.type = Math.floor(Math.random() * cfg.ABILITY_TYPES);
  }
}

// ─── World State ───────────────────────────────────────────────────────────

class WorldState {
  constructor() {
    this.players = new Map();     // id -> Player
    this.food = new Map();        // id -> Food
    this.abilities = new Map();   // id -> Ability
    this.tickNumber = 0;
    this.worldTime = 0;

    // Event buffers (cleared each tick after broadcast)
    this.newFood = [];
    this.eatenFood = [];
    this.newAbilities = [];
    this.collectedAbilities = [];
    this.newPlayers = [];
    this.killEvents = [];
    this.wormUpdates = [];
    this.invisibleWorms = [];

    this._initFood();
    this._initAbilities();
  }

  _initFood() {
    while (this.food.size < cfg.FOOD_COUNT_MAX) {
      const f = spawnFood();
      this.food.set(f.id, f);
    }
  }

  _initAbilities() {
    while (this.abilities.size < cfg.ABILITY_COUNT_MAX) {
      const a = new Ability();
      this.abilities.set(a.id, a);
    }
  }

  addPlayer(player) {
    this.players.set(player.id, player);
    this.newPlayers.push(player);
    // Add all existing food to newFood so new player gets all initial food
    this.newFood.push(...this.food.values());
    // Add all existing abilities to newAbilities
    this.newAbilities.push(...this.abilities.values());
  }

  removePlayer(id) {
    this.players.delete(id);
  }

  maintainFood() {
    while (this.food.size < cfg.FOOD_COUNT_MAX) {
      const f = spawnFood();
      this.food.set(f.id, f);
      this.newFood.push(f);
    }
  }

  maintainAbilities() {
    while (this.abilities.size < cfg.ABILITY_COUNT_MAX) {
      const a = new Ability();
      this.abilities.set(a.id, a);
      this.newAbilities.push(a);
    }
  }

  spawnBodyFood(player) {
    const segs = player.segments;
    const bodyFoods = [];
    const step = Math.max(1, Math.floor(segs.length / 50)); // limit body food count
    for (let i = 0; i < segs.length; i += step) {
      const f = new Food(segs[i].x, segs[i].y, cfg.FOOD_TYPES - 1, 3);
      f.isBodyFood = true;
      this.food.set(f.id, f);
      bodyFoods.push(f);
    }
    this.newFood.push(...bodyFoods);
    return bodyFoods;
  }

  // Sorted by kb (worm length) -- used for the main scoreboard panel (opcode 3 gd entries).
  getTopPlayers(n = 10) {
    return Array.from(this.players.values())
      .filter(p => !p.dead && !p.spectating)
      .sort((a, b) => b.kb - a.kb)
      .slice(0, n);
  }

  // Sorted by headshot count -- used for HS panel (Section 10 opcode 1) and
  // RECORD panel (opcode 0 init).
  getTopByHeadshots(n = 10) {
    return Array.from(this.players.values())
      .filter(p => !p.dead && !p.spectating)
      .sort((a, b) => b.sessionHeadshots - a.sessionHeadshots)
      .slice(0, n);
  }

  clearEvents() {
    this.newFood = [];
    this.eatenFood = [];
    this.newAbilities = [];
    this.collectedAbilities = [];
    this.newPlayers = [];
    this.killEvents = [];
    this.wormUpdates = [];
    this.invisibleWorms = [];
  }
}

module.exports = {
  WorldState,
  Player,
  Food,
  Ability,
  calcSegmentCount,
  collisionRadius,
  // Alias: collisionRadius(kb) computes the exact same value as the client's
  // "jb" segment spacing (Ye.prototype.Ze in 0tEwHoKWpm.js: 0.025*(5+0.9*segCount)).
  // Exported under this name too so movement code can use the name that
  // matches what it actually represents there (segment spacing, not a hitbox).
  segmentSpacing: collisionRadius,
  randomWorldPos,
  spawnFood,
  packPosToId,
};
