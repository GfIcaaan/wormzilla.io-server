'use strict';

const cfg = require('./config');
const { collisionRadius } = require('./worldState');

// ─── Distance helpers ──────────────────────────────────────────────────────

function dist2(ax, ay, bx, by) {
  const dx = ax - bx, dy = ay - by;
  return dx * dx + dy * dy;
}

// ─── Wall collision ────────────────────────────────────────────────────────

function checkWall(player) {
  const d2 = player.headX * player.headX + player.headY * player.headY;
  return d2 > cfg.WORLD_HALF * cfg.WORLD_HALF;
}

// ─── Food collision ────────────────────────────────────────────────────────

// NOTE: eat radius is derived from the worm's own head radius (getRadius(),
// the same "jb" segment-spacing formula the client uses to size the worm --
// see collisionRadius() in worldState.js), not a flat constant. The client
// has NO independent eat-distance logic of its own to copy: eating is fully
// server-authoritative (T.Tn.h.prototype.dl in 0tEwHoKWpm.js just plays a
// "food flies to this head position" animation for whatever food id the
// server's update packet says was eaten -- it never decides this itself).
// So a flat number here (the old value was a fixed 25 units) has no
// client-side ground truth to match and was wildly out of scale: a starting
// worm's actual body radius is ~0.33 units, so 25 units let it eat food from
// ~76x its own body size away, while a max-size worm (radius ~4.6) could
// only reach ~5x its size -- backwards, and disconnected from how big the
// worm visually is. Scaling to the worm's real head radius is the only
// definition of "near the mouth" that's actually grounded in client-shared
// geometry instead of a guess. The 2x multiplier (vs. exactly 1x) is a
// deliberate gameplay-feel choice to give noticeably more pickup tolerance
// than the literal edge of the head sprite -- still scales with the worm's
// real size, just more forgiving than touching it exactly.
const FOOD_EAT_RADIUS_MULT = 2.5;

function checkFoodCollision(player, world) {
  const eatRadius = player.getRadius() * FOOD_EAT_RADIUS_MULT;
  const eatR2 = eatRadius * eatRadius;
  const eaten = [];
  for (const [id, food] of world.food) {
    if (dist2(player.headX, player.headY, food.x, food.y) < eatR2) {
      eaten.push(food);
    }
  }
  for (const food of eaten) {
    world.food.delete(food.id);
    // NOTE: push the full food object, not just food.id. The wire protocol
    // (buildUpdatePacket Section 2 in gameServer.js) needs food.x/food.y to
    // rebuild the same packed-position id the client was given when this
    // food spawned -- the client's dictionary key for this food is that
    // packed id, not the server's internal counter id.
    //
    // eaterPlayerId is also required by that same wire protocol: the
    // client's eaten-food handler (dl() in 0tEwHoKWpm.js) reads food id
    // THEN a separate player id, and uses that player id to look up the
    // eating worm's current head position so it can fly the food sprite
    // there for the "eaten" animation (x.Yi(headX, headY, false)) -- without
    // it the client has no target position and the food just vanishes with
    // no animation instead of flying into the mouth.
    food.eaterPlayerId = player.id;
    world.eatenFood.push(food);
    // Grow player
    const value = food.isBodyFood
      ? Math.max(0.002, food.sizeTier * 0.008)
      : cfg.FOOD_VALUE;
    player.kb += value;
  }
  return eaten.length;
}

// ─── Ability collision ─────────────────────────────────────────────────────

// Same eat-radius reasoning as checkFoodCollision above: scaled to the
// worm's actual head radius instead of a flat constant (old value was a
// fixed 30 units, equally out of scale with the worm's real ~0.33-4.6 unit
// body radius).
//
// Also: ability orbs are pushed into world.eatenFood (NOT a separate
// "collected abilities" list) on purpose. Traced the client's spawn/eat
// handlers (Sk/$k/dl in T.Tn.h.prototype, 0tEwHoKWpm.js) and confirmed food
// and ability orbs are the exact same entity type on the client (T.Pi),
// spawned into the same id-keyed dictionary (this.h.Wb) by the same Sk()
// reader, and removed/animated by the same dl() reader -- there is no
// separate opcode, section, or dictionary for "ability collected" anywhere
// in the client's packet parser (Yj()). The previous code sent a
// hand-invented extra section for this that the client never reads, which
// silently shifted every later section (kills, worm positions, leaderboard)
// onto the wrong bytes for any tick where an ability orb was eaten.
function checkAbilityCollision(player, world) {
  const eatRadius = player.getRadius() * FOOD_EAT_RADIUS_MULT;
  const abilityEatR2 = eatRadius * eatRadius;
  for (const [id, ability] of world.abilities) {
    if (dist2(player.headX, player.headY, ability.x, ability.y) < abilityEatR2) {
      world.abilities.delete(id);
      // Same eaterPlayerId requirement as food -- see checkFoodCollision's
      // comment: the client's dl() handler needs it to fly the orb sprite
      // to this player's current head position for the eat animation.
      ability.eaterPlayerId = player.id;
      world.eatenFood.push(ability);
      // Grant ability to player (slot = ability.type)
      player.abilities[ability.type] = {
        type: ability.type,
        charge: 100,
        expires: Date.now() + cfg.ABILITY_DURATION_MS,
      };
      return ability;
    }
  }
  return null;
}

// ─── Worm-to-worm collision ────────────────────────────────────────────────

/**
 * Returns array of kill events: { victim: Player, killer: Player|null, headshot: boolean }
 */
function checkWormCollisions(world) {
  const players = Array.from(world.players.values()).filter(p => !p.dead && !p.spectating);
  const kills = [];

  for (let i = 0; i < players.length; i++) {
    const A = players[i];
    if (A.dead) continue;

    // Wall check
    if (checkWall(A)) {
      kills.push({ victim: A, killer: null, headshot: false });
      A.dead = true;
      continue;
    }

    for (let j = 0; j < players.length; j++) {
      if (i === j) continue;
      const B = players[j];
      if (B.dead) continue;

      // A's head vs B's head (head-on collision)
      const headR2 = (A.getRadius() + B.getRadius()) * 0.5;
      const headD2 = dist2(A.headX, A.headY, B.headX, B.headY);

      if (headD2 < headR2 * headR2) {
        // Both die (head-to-head), but we process only once
        if (!A.dead && !B.dead) {
          kills.push({ victim: A, killer: B, headshot: true });
          kills.push({ victim: B, killer: A, headshot: true });
          A.dead = true;
          B.dead = true;
        }
        continue;
      }

      // A's head vs B's body segments (skip first 5 segments of B near head)
      const bodyR = B.getRadius();
      const bodyR2 = bodyR * bodyR;
      const skipSegs = Math.min(5, B.segments.length);

      for (let s = skipSegs; s < B.segments.length; s++) {
        const seg = B.segments[s];
        if (dist2(A.headX, A.headY, seg.x, seg.y) < bodyR2) {
          if (!A.dead) {
            kills.push({ victim: A, killer: B, headshot: false });
            A.dead = true;
          }
          break;
        }
      }
    }
  }

  return kills;
}

module.exports = { checkWall, checkFoodCollision, checkAbilityCollision, checkWormCollisions };