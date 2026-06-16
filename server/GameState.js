'use strict';

const WORLD_HALF = 500;
const FOOD_CAP = 75000;
const MAX_FOOD_ID = 0x7FFF; // 32767 per axis (15-bit signed)

// Encode x,y into food ID (Int32)
function encodeFoodId(x, y) {
  // jn inverse: ((id & 0xFFFF) / 32768 - 1) * lh = x
  // => (x/lh + 1) * 32768 = id & 0xFFFF
  const ix = Math.round((x / WORLD_HALF + 1) * 32768) & 0xFFFF;
  const iy = Math.round((y / WORLD_HALF + 1) * 32768) & 0xFFFF;
  // pack: low 16 = x, high 16 = y
  return (iy << 16) | ix;
}

// Decode food ID → {x, y}
function decodeFoodId(id) {
  const ix = (id & 0xFFFF);
  const iy = ((id >>> 16) & 0xFFFF);
  return {
    x: (ix / 32768 - 1) * WORLD_HALF,
    y: (iy / 32768 - 1) * WORLD_HALF,
  };
}

let _entityId = 1;
let _foodIdCounter = 1;

function nextEntityId() {
  const id = _entityId++;
  if (_entityId > 30000) _entityId = 1;
  return id;
}

function randFloat(min, max) {
  return Math.random() * (max - min) + min;
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Food types (0-based, client has multiple visual types)
const FOOD_TYPES = [0, 1, 2, 3, 4, 5];

class Food {
  constructor() {
    this.x = randFloat(-WORLD_HALF * 0.95, WORLD_HALF * 0.95);
    this.y = randFloat(-WORLD_HALF * 0.95, WORLD_HALF * 0.95);
    this.id = encodeFoodId(this.x, this.y);
    // fallback unique id if collision
    this.uid = _foodIdCounter++;
    this.type = FOOD_TYPES[randInt(0, FOOD_TYPES.length - 1)];
    this.value = 1;
  }
}

class Worm {
  constructor(ws, name, cosmetics) {
    this.ws = ws;
    this.id = nextEntityId();
    this.name = name || 'No nickname';
    this.cosmetics = cosmetics; // { skin, eyes, mouth, glasses, hat }
    this.level = 1;
    this.alive = false;

    // Position
    this.x = randFloat(-WORLD_HALF * 0.8, WORLD_HALF * 0.8);
    this.y = randFloat(-WORLD_HALF * 0.8, WORLD_HALF * 0.8);
    this.angle = Math.random() * Math.PI * 2;

    // Movement
    this.speed = 3;
    this.boosting = false;

    // Score / length
    this.score = 10;
    this.segCount = 5;
    this.segments = []; // [x0, y0, x1, y1, ...]
    this._initSegments();
  }

  _initSegments() {
    this.segments = [];
    for (let i = 0; i < this.segCount; i++) {
      this.segments.push(this.x - Math.cos(this.angle) * i * 5);
      this.segments.push(this.y - Math.sin(this.angle) * i * 5);
    }
  }

  setDirection(angleByte, flags) {
    // Convert angle byte → radians
    this.angle = (angleByte / 256) * Math.PI * 2;
    this.boosting = (flags & 1) !== 0;
  }

  update(dt) {
    if (!this.alive) return;
    const spd = this.boosting ? this.speed * 1.8 : this.speed;
    this.x += Math.cos(this.angle) * spd;
    this.y += Math.sin(this.angle) * spd;

    // Wrap at world boundary
    if (this.x > WORLD_HALF) this.x = -WORLD_HALF;
    if (this.x < -WORLD_HALF) this.x = WORLD_HALF;
    if (this.y > WORLD_HALF) this.y = -WORLD_HALF;
    if (this.y < -WORLD_HALF) this.y = WORLD_HALF;

    // Update segments (shift head in)
    this.segments.unshift(this.y);
    this.segments.unshift(this.x);
    // Trim to segCount
    while (this.segments.length > this.segCount * 2) {
      this.segments.pop();
      this.segments.pop();
    }
  }

  grow(amount) {
    this.score += amount;
    const newSegs = Math.floor(this.score / 10);
    if (newSegs > this.segCount) {
      const extra = newSegs - this.segCount;
      this.segCount = newSegs;
      // Append extra segments at tail
      const tx = this.segments[this.segments.length - 2] || this.x;
      const ty = this.segments[this.segments.length - 1] || this.y;
      for (let i = 0; i < extra; i++) {
        this.segments.push(tx);
        this.segments.push(ty);
      }
    }
  }
}

class GameState {
  constructor() {
    this.worms = new Map();   // id → Worm
    this.foods = new Map();   // id → Food
    this.gameMode = 0;
    this.worldHalf = WORLD_HALF;

    // Pre-populate food
    for (let i = 0; i < 5000; i++) {
      this._spawnFood();
    }
  }

  _spawnFood() {
    if (this.foods.size >= FOOD_CAP) return null;
    const f = new Food();
    this.foods.set(f.uid, f);
    return f;
  }

  spawnBatch(count) {
    const spawned = [];
    for (let i = 0; i < count; i++) {
      const f = this._spawnFood();
      if (f) spawned.push(f);
    }
    return spawned;
  }

  addWorm(ws, name, cosmetics) {
    const w = new Worm(ws, name, cosmetics);
    w.alive = true;
    this.worms.set(w.id, w);
    return w;
  }

  removeWorm(id) {
    // Drop food at death location
    const w = this.worms.get(id);
    if (w) {
      const foodDrop = Math.min(50, Math.floor(w.score / 5));
      for (let i = 0; i < foodDrop; i++) this._spawnFood();
    }
    this.worms.delete(id);
  }

  update() {
    for (const w of this.worms.values()) {
      if (!w.alive) continue;
      w.update(1);
      this._checkFoodCollision(w);
    }
    // Replenish food
    const deficit = Math.min(200, 5000 - this.foods.size);
    if (deficit > 0) this.spawnBatch(deficit);
  }

  _checkFoodCollision(worm) {
    const eaten = [];
    for (const [uid, food] of this.foods) {
      const dx = food.x - worm.x;
      const dy = food.y - worm.y;
      const dist2 = dx * dx + dy * dy;
      if (dist2 < 100) { // radius ~10
        eaten.push([uid, food]);
        this.foods.delete(uid);
        worm.grow(food.value);
      }
      if (eaten.length >= 20) break; // cap per tick
    }
    return eaten;
  }

  getLeaderboard() {
    return [...this.worms.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
  }
}

module.exports = { GameState, WORLD_HALF, encodeFoodId, decodeFoodId };
