'use strict';

const BinaryWriter = require('./BinaryWriter');
const { WORLD_HALF } = require('./GameState');

/**
 * MSG 0 — Init / Spawn Success
 */
function buildMsg0(gameMode, playerId, worldHalf, skins = []) {
  let size = 17;
  for (const sk of skins) size += 4 + sk.name.length * 2;
  const w = new BinaryWriter(size);
  w.writeUInt8(0);
  w.writeInt8(gameMode);
  w.writeInt16(playerId);
  w.writeFloat32(worldHalf);
  w.writeFloat32(worldHalf); // Ue
  w.writeFloat32(worldHalf); // Bg
  w.writeUInt8(skins.length);
  for (const sk of skins) {
    w.writeUInt8(sk.type);
    w.writeUInt16(sk.id);
    w.writeUInt8(sk.name.length);
    for (let i = 0; i < sk.name.length; i++) w.writeUInt16(sk.name.charCodeAt(i));
  }
  return w.toBuffer();
}

/**
 * MSG 1 — World Update
 *
 * Section A food format (Ek handler):
 *   Int32  food_id  (Vf) — encodes x,y via jn/qn
 *   [Uint8 skin_idx if mode==16]
 *   Float32 wc      (f)  — food scale/radius
 *   Uint8   eb      (Fb) — food type (visual)
 *
 * Section F ($k handler):
 *   Int16   entity_id (s)
 *   Float32 score     (f)
 *   Uint8   seg_count (Fb)
 *   [Float32 x, Float32 y] * seg_count  ← Mm() calls h() TWICE per seg
 *
 * Section G (cl) uses plain Uint8 count, not varint
 */
function buildMsg1(tickId, gameMode, {
  newFoods = [],
  eatenFoodsNoEater = [],
  eatenFoodsWithEater = [],
  newWorms = [],
  kills = [],
  scoreUpdates = [],
  removals = [],
  abilityUpdates = [],
  radarDots = [],
  teamMembers = [],
  selfUpdate = null,
} = {}) {
  const w = new BinaryWriter(131072); // 128KB generous

  w.writeUInt8(1);
  w.writeInt16(tickId);

  // --- Section A: new food ---
  w.writeVarint(newFoods.length);
  for (const f of newFoods) {
    w.writeInt32(f.id);                        // Vf() — encodes x,y
    if (gameMode === 16) w.writeUInt8(0);       // skin_idx n()
    w.writeFloat32(f.scale != null ? f.scale : 1.0); // wc: Float32 scale
    w.writeUInt8(f.type & 0xFF);               // eb: Uint8 food type
  }

  // --- Section B: eaten food (no eater) ---
  w.writeVarint(eatenFoodsNoEater.length);
  for (const id of eatenFoodsNoEater) w.writeInt32(id);

  // --- Section C: eaten food (with eater) ---
  w.writeVarint(eatenFoodsWithEater.length);
  for (const [foodId, eaterId] of eatenFoodsWithEater) {
    w.writeInt32(foodId);
    w.writeInt16(eaterId);
  }

  // --- Section D: new/updated worms (Tk) ---
  w.writeVarint(newWorms.length);
  for (const worm of newWorms) {
    w.writeInt16(worm.id);
    if (gameMode === 16) w.writeUInt8(0);
    w.writeInt16(worm.cosmetics.skin ?? 0);
    w.writeInt16(worm.cosmetics.eyes ?? 0);
    w.writeInt16(worm.cosmetics.mouth ?? 0);
    w.writeInt16(worm.cosmetics.glasses ?? 0);
    w.writeInt16(worm.cosmetics.hat ?? 0);
    w.writeUInt8(worm.level ?? 1);
    const nameChars = Math.min(255, worm.name.length);
    w.writeInt8(nameChars);
    for (let i = 0; i < nameChars; i++) w.writeInt16(worm.name.charCodeAt(i));
  }

  // --- Section E: kills (Yk) ---
  w.writeVarint(kills.length);
  for (const k of kills) {
    w.writeInt16(k.deadId);
    let flags = 0;
    if (k.killerId != null) flags |= 1;
    if (k.isHeadshot) flags |= 2;
    w.writeInt8(flags);
    if (k.killerId != null) w.writeInt16(k.killerId);
  }

  // --- Section F: score/segment updates ($k) ---
  // Mm() calls h() (= f() = Float32) TWICE per segment: x then y
  w.writeVarint(scoreUpdates.length);
  for (const su of scoreUpdates) {
    w.writeInt16(su.id);
    w.writeFloat32(su.score);
    const segs = su.segments || [];
    const segCount = Math.min(255, Math.floor(segs.length / 2));
    w.writeUInt8(segCount);
    for (let i = 0; i < segCount; i++) {
      w.writeFloat32(segs[i * 2]);       // x
      w.writeFloat32(segs[i * 2 + 1]);   // y
    }
  }

  // --- Section G: removals (cl) — Uint8 count, NOT varint ---
  w.writeUInt8(Math.min(255, removals.length));
  for (let i = 0; i < Math.min(255, removals.length); i++) {
    w.writeInt16(removals[i]);
  }

  // --- Section H: ability cooldowns (hl) ---
  w.writeVarint(abilityUpdates.length);
  for (const au of abilityUpdates) {
    w.writeInt16(au.id);
    let flags = 0;
    if (au.alive) flags |= 1;
    if (au.score != null) flags |= 2;
    w.writeInt8(flags);
    if (au.score != null) w.writeFloat32(au.score);
    w.writeFloat32(au.x);
    w.writeFloat32(au.y);
    const abilities = au.abilities || [];
    w.writeVarint(abilities.length);
    for (const ab of abilities) {
      w.writeUInt8(ab.id);
      w.writeUInt8(ab.charge);
    }
  }

  // --- Section I: radar dots ---
  w.writeVarint(radarDots.length);
  for (const dot of radarDots) {
    w.writeUInt16(dot.id);
    w.writeUInt8(dot.isSos ? 1 : 0);
    w.writeUInt32(dot.color);
    w.writeFloat32(dot.x);
    w.writeFloat32(dot.y);
  }

  // --- Section J: team members — Uint8 count ---
  w.writeUInt8(Math.min(255, teamMembers.length));
  for (const tm of teamMembers) {
    w.writeUInt16(tm.id);
    w.writeUInt16(tm.isSos ? 1 : 0);
    w.writeUInt8(tm.level);
  }

  // --- Section K: self update (only if tickId > 0) ---
  if (tickId > 0 && selfUpdate) {
    const su = selfUpdate;
    let flags = 0;
    if (su.alive) flags |= 1;
    if (su.score != null) flags |= 2;
    if (su.extra != null) flags |= 4;
    w.writeInt8(flags);
    if (su.score != null) w.writeFloat32(su.score);
    if (su.extra != null) w.writeFloat32(su.extra);
    w.writeFloat32(su.x);
    w.writeFloat32(su.y);
    w.writeFloat32(su.mouseX ?? su.x);
    w.writeFloat32(su.mouseY ?? su.y);
    const abs = su.abilities || [];
    w.writeVarint(abs.length);
    for (const ab of abs) {
      w.writeUInt8(ab.id);
      w.writeUInt8(ab.charge);
    }
  }

  return w.toBuffer();
}

/**
 * MSG 2 — Minimap pixel data
 */
const MINIMAP_CLIP = [34,29,26,24,22,20,18,17,15,14,13,12,11,10,9,8,8,7,6,6,
  5,5,4,4,3,3,2,2,2,1,1,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,
  1,1,1,1,1,2,2,2,3,3,4,4,5,5,6,6,7,8,8,9,10,11,12,13,
  14,15,17,18,20,22,24,26,29,34];

function buildMsg2(worms = []) {
  const w = new BinaryWriter(1 + 628);
  w.writeUInt8(2);
  const grid = new Uint8Array(80 * 80);
  for (const worm of worms) {
    const px = Math.floor((worm.x / WORLD_HALF + 1) / 2 * 80);
    const py = Math.floor((worm.y / WORLD_HALF + 1) / 2 * 80);
    if (px >= 0 && px < 80 && py >= 0 && py < 80) grid[py * 80 + px] = 1;
  }
  let col = MINIMAP_CLIP[0], endCol = 80 - col, row = 0;
  for (let i = 0; i < 628; i++) {
    let byte = 0;
    for (let bit = 0; bit < 8; bit++) {
      if (col < endCol && row < 80) {
        if (grid[row * 80 + col]) byte |= (1 << bit);
        col++;
        if (col >= endCol) {
          row++;
          if (row < 80) { col = MINIMAP_CLIP[row]; endCol = 80 - MINIMAP_CLIP[row]; }
        }
      }
    }
    w.writeUInt8(byte);
  }
  return w.toBuffer();
}

/**
 * MSG 3 — Death / Game Over
 */
function buildMsg3(gameMode, rank, total, scoreItems = [], teamItems = []) {
  const w = new BinaryWriter(512);
  w.writeUInt8(3);
  w.writeInt16(rank);
  w.writeInt16(total);
  w.writeInt8(scoreItems.length);
  for (const [type, value] of scoreItems) {
    w.writeInt16(type);
    w.writeFloat32(value);
  }
  if (gameMode === 16) {
    w.writeUInt8(teamItems.length);
    for (const [type, value] of teamItems) {
      w.writeUInt8(type);
      w.writeFloat32(value);
    }
  }
  return w.toBuffer();
}

/**
 * MSG 4 — Announcement text
 * ek handler: Zb() length, then Zb() per char
 */
function buildMsg4(text) {
  const len = Math.min(text.length, 255);
  const w = new BinaryWriter(1 + 2 + len * 2);
  w.writeUInt8(4);
  w.writeUInt16(len);
  for (let i = 0; i < len; i++) w.writeUInt16(text.charCodeAt(i));
  return w.toBuffer();
}

/**
 * MSG 5 — Force disconnect
 */
function buildMsg5() {
  const w = new BinaryWriter(1);
  w.writeUInt8(5);
  return w.toBuffer();
}

module.exports = { buildMsg0, buildMsg1, buildMsg2, buildMsg3, buildMsg4, buildMsg5 };
