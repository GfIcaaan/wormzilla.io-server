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

const FOOD_EAT_RADIUS = 25; // units
const FOOD_EAT_R2 = FOOD_EAT_RADIUS * FOOD_EAT_RADIUS;

function checkFoodCollision(player, world) {
  const eaten = [];
  for (const [id, food] of world.food) {
    if (dist2(player.headX, player.headY, food.x, food.y) < FOOD_EAT_R2) {
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

const ABILITY_EAT_R2 = 30 * 30;

function checkAbilityCollision(player, world) {
  for (const [id, ability] of world.abilities) {
    if (dist2(player.headX, player.headY, ability.x, ability.y) < ABILITY_EAT_R2) {
      world.abilities.delete(id);
      // NOTE: push position + collector id, not just the raw internal id.
      // The wire protocol (buildUpdatePacket Section 3 in gameServer.js)
      // needs ability.x/ability.y to rebuild the same packed-position id the
      // client was given when this ability spawned (its dictionary key for
      // the orb is that packed id, not the server's internal counter id),
      // plus playerId so the client knows who picked it up. The previous
      // code pushed a bare number here while gameServer.js already read
      // c.id/c.playerId off it, which silently read undefined for both.
      world.collectedAbilities.push({ x: ability.x, y: ability.y, playerId: player.id });
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