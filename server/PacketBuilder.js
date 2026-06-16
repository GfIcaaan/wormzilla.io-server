'use strict';

const BinaryWriter = require('./BinaryWriter');
const { WORLD_HALF } = require('./GameState');

// Estimate size helpers
const varintSize = v => v < 128 ? 1 : v < 16384 ? 2 : v < 2097152 ? 3 : 4;

/**
 * MSG 0 — Init / Spawn Success
 */
function buildMsg0(gameMode, playerId, worldHalf, skins = []) {
  // Fixed: 1 + 1 + 2 + 4 + 4 + 4 + 1 = 17
  // Per skin entry: 1 + 2 + 1 + (name.len * 2)
  let size = 17;
  for (const sk of skins) {
    size += 4 + sk.name.length * 2;
  }
  const w = new BinaryWriter(size);
  w.writeUInt8(0);           // msg type
  w.writeInt8(gameMode);     // n()
  w.writeInt16(playerId);    // s()
  w.writeFloat32(worldHalf); // f()
  w.writeFloat32(worldHalf); // f() Ue
  w.writeFloat32(worldHalf); // f() Bg
  w.writeUInt8(skins.length);// n() skin count
  for (const sk of skins) {
    w.writeUInt8(sk.type);         // Fb()
    w.writeUInt16(sk.id);          // Zb()
    w.writeUInt8(sk.name.length);  // Fb()
    for (let i = 0; i < sk.name.length; i++) {
      w.writeUInt16(sk.name.charCodeAt(i)); // Zb()
    }
  }
  return w.toBuffer();
}

/**
 * MSG 1 — World Update
 * Sections: A(new food) B(eaten food no eater) C(eaten food+eater)
 *           D(new/updated worms) E(kills) F(score updates) G(removals)
 *           H(ability cooldowns) I(radar dots) J(team members) K(self update)
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
  // Pre-allocate generously
  const w = new BinaryWriter(65536);

  w.writeUInt8(1);         // msg type
  w.writeInt16(tickId);    // s()

  // --- Section A: new food ---
  w.writeVarint(newFoods.length);
  for (const f of newFoods) {
    w.writeInt32(f.id);    // Vf()
    if (gameMode === 16) w.writeUInt8(0); // skin (Fb)
    w.writeFloat32(f.x);   // f()
    w.writeUInt8(f.type);  // Fb()
  }

  // --- Section B: eaten food (no eater) ---
  w.writeVarint(eatenFoodsNoEater.length);
  for (const id of eatenFoodsNoEater) {
    w.writeInt32(id); // Vf()
  }

  // --- Section C: eaten food (with eater) ---
  w.writeVarint(eatenFoodsWithEater.length);
  for (const [foodId, eaterId] of eatenFoodsWithEater) {
    w.writeInt32(foodId);   // Vf()
    w.writeInt16(eaterId);  // s()
  }

  // --- Section D: new/updated worms (Tk) ---
  w.writeVarint(newWorms.length);
  for (const worm of newWorms) {
    w.writeInt16(worm.id);                        // s()
    if (gameMode === 16) w.writeUInt8(0);          // skin_idx n()
    w.writeInt16(worm.cosmetics.skin ?? 0);        // s() eb
    w.writeInt16(worm.cosmetics.eyes ?? 0);        // s() De
    w.writeInt16(worm.cosmetics.mouth ?? 0);       // s() de
    w.writeInt16(worm.cosmetics.glasses ?? 0);     // s() Fe
    w.writeInt16(worm.cosmetics.hat ?? 0);         // s() Sc
    w.writeUInt8(worm.level ?? 1);                 // Fb() Cf
    const nameChars = Math.min(255, worm.name.length);
    w.writeInt8(nameChars);                        // n() name_len
    for (let i = 0; i < nameChars; i++) {
      w.writeInt16(worm.name.charCodeAt(i));       // s()
    }
  }

  // --- Section E: kills (Yk) ---
  w.writeVarint(kills.length);
  for (const k of kills) {
    w.writeInt16(k.deadId);  // s()
    let flags = 0;
    if (k.killerId != null) flags |= 1;
    if (k.isHeadshot) flags |= 2;
    w.writeInt8(flags);      // n()
    if (k.killerId != null) w.writeInt16(k.killerId); // s()
  }

  // --- Section F: score/segment updates ($k) ---
  w.writeVarint(scoreUpdates.length);
  for (const su of scoreUpdates) {
    w.writeInt16(su.id);          // s()
    w.writeFloat32(su.score);     // f()
    const segs = su.segments || [];
    const segCount = Math.min(255, segs.length / 2);
    w.writeUInt8(segCount);       // Fb()
    for (let i = 0; i < segCount; i++) {
      w.writeFloat32(segs[i * 2]);     // f() x
      // Note: client reads float per seg (positions packed as floats)
      // Actually client only reads seg_count floats, not pairs
      // $k reads: id, score, seg_count, then seg_count floats
    }
  }

  // --- Section G: removals (cl) — uses Uint8, NOT varint ---
  w.writeUInt8(removals.length);
  for (const id of removals) {
    w.writeInt16(id); // s()
  }

  // --- Section H: ability cooldowns (hl) ---
  w.writeVarint(abilityUpdates.length);
  for (const au of abilityUpdates) {
    w.writeInt16(au.id);     // s()
    let flags = 0;
    if (au.alive) flags |= 1;
    if (au.score != null) flags |= 2;
    w.writeInt8(flags);      // n()
    if (au.score != null) w.writeFloat32(au.score); // f()
    w.writeFloat32(au.x);    // f()
    w.writeFloat32(au.y);    // f()
    const abilities = au.abilities || [];
    w.writeVarint(abilities.length);
    for (const ab of abilities) {
      w.writeUInt8(ab.id);    // n()
      w.writeUInt8(ab.charge);// n() 0-100
    }
  }

  // --- Section I: radar dots ---
  w.writeVarint(radarDots.length);
  for (const dot of radarDots) {
    w.writeUInt16(dot.id);     // Zb()
    w.writeUInt8(dot.isSos ? 1 : 0); // Fb()
    w.writeUInt32(dot.color);  // mn()
    w.writeFloat32(dot.x);     // f()
    w.writeFloat32(dot.y);     // f()
  }

  // --- Section J: team members — uses Uint8! ---
  w.writeUInt8(teamMembers.length);
  for (const tm of teamMembers) {
    w.writeUInt16(tm.id);    // Zb()
    w.writeUInt16(tm.isSos ? 1 : 0); // Zb()
    w.writeUInt8(tm.level);  // Fb()
  }

  // --- Section K: self update (only if tickId > 0) ---
  if (tickId > 0 && selfUpdate) {
    const su = selfUpdate;
    let flags = 0;
    if (su.alive) flags |= 1;
    if (su.score != null) flags |= 2;
    if (su.extra != null) flags |= 4;
    w.writeInt8(flags);              // n()
    if (su.score != null) w.writeFloat32(su.score); // f()
    if (su.extra != null) w.writeFloat32(su.extra); // f()
    w.writeFloat32(su.x);            // f()
    w.writeFloat32(su.y);            // f()
    w.writeFloat32(su.mouseX ?? su.x); // f()
    w.writeFloat32(su.mouseY ?? su.y); // f()
    const abs = su.abilities || [];
    w.writeVarint(abs.length);
    for (const ab of abs) {
      w.writeUInt8(ab.id);    // n()
      w.writeUInt8(ab.charge);// n()
    }
  }

  return w.toBuffer();
}

/**
 * MSG 2 — Minimap pixel data (628 bytes after type byte)
 */
const MINIMAP_CLIP = [34,29,26,24,22,20,18,17,15,14,13,12,11,10,9,8,8,7,6,6,
  5,5,4,4,3,3,2,2,2,1,1,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,
  1,1,1,1,1,2,2,2,3,3,4,4,5,5,6,6,7,8,8,9,10,11,12,13,
  14,15,17,18,20,22,24,26,29,34];

function buildMsg2(worms = []) {
  const w = new BinaryWriter(1 + 628);
  w.writeUInt8(2);
  // Build 80x80 pixel grid
  const grid = new Uint8Array(80 * 80);
  for (const worm of worms) {
    // Map world coords → minimap pixel
    const px = Math.floor((worm.x / WORLD_HALF + 1) / 2 * 80);
    const py = Math.floor((worm.y / WORLD_HALF + 1) / 2 * 80);
    if (px >= 0 && px < 80 && py >= 0 && py < 80) {
      grid[py * 80 + px] = 1;
    }
  }
  // Pack bits following clip mask
  let col = MINIMAP_CLIP[0];
  let endCol = 80 - col;
  let row = 0;
  let bitIdx = 0;
  let currentByte = 0;
  for (let i = 0; i < 628; i++) {
    let byte = 0;
    for (let bit = 0; bit < 8; bit++) {
      if (col < endCol && row < 80) {
        if (grid[row * 80 + col]) byte |= (1 << bit);
        col++;
        if (col >= endCol) {
          row++;
          if (row < 80) {
            col = MINIMAP_CLIP[row];
            endCol = 80 - MINIMAP_CLIP[row];
          }
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
  w.writeInt16(rank);   // s() ri
  w.writeInt16(total);  // s() af
  w.writeInt8(scoreItems.length); // n()
  for (const [type, value] of scoreItems) {
    w.writeInt16(type);   // s()
    w.writeFloat32(value);// f()
  }
  if (gameMode === 16) {
    w.writeUInt8(teamItems.length); // n()
    for (const [type, value] of teamItems) {
      w.writeUInt8(type);   // n()
      w.writeFloat32(value);// f()
    }
  }
  return w.toBuffer();
}

/**
 * MSG 4 — Announcement text
 * Client: ek handler reads Zb() for length then Zb() per char
 * Zb = getUint16 LE — but each char code fits in a byte, just stored as Uint16
 */
function buildMsg4(text) {
  const len = Math.min(text.length, 255);
  const w = new BinaryWriter(1 + 2 + len * 2);
  w.writeUInt8(4);
  w.writeUInt16(len);          // Zb() length
  for (let i = 0; i < len; i++) {
    w.writeUInt16(text.charCodeAt(i)); // Zb() each char
  }
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
