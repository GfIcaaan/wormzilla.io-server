'use strict';

module.exports = {
  // Server
  HTTP_PORT: 3000,
  WS_PORT: 8080,
  
  // World
  WORLD_SIZE: 10000,
  WORLD_HALF: 5000,
  MAX_PLAYERS: 320,
  TICK_RATE: 60,
  
  // Food
  FOOD_COUNT_MAX: 5000,
  // NOTE: must match the client's actual portionDict food-id range, decoded
  // from media/registry.wormzilla -- the real registry only defines food
  // texture ids 0-33 (34 entries: "food_0".."food_33"). Ability orb textures
  // live at a SEPARATE, non-contiguous id range (200-207, "ability_0a".."
  // ability_7a") in that same dict -- they are not "food ids 34-41" as a
  // contiguous range might suggest. Sending any id outside 0-33 for food (the
  // old value of 42 produced ids up to 41, landing in the 34-41 gap that
  // doesn't exist in the registry) makes the client's texture lookup
  // (T.La.prototype.tl -> this.Um[gb]) return undefined, which crashes with
  // "Cannot read properties of undefined (reading 'Ja')" the next render
  // frame (T.ol.De.prototype.rc reading that undefined value's .Ja field).
  FOOD_TYPES: 34,
  FOOD_VALUE: 0.005,
  
  // Ability
  ABILITY_COUNT_MAX: 50,
  ABILITY_TYPES: 8,
  ABILITY_DURATION_MS: 10000,
  
  // Movement
  BASE_SPEED: 0.3,
  BOOST_SPEED: 0.6,
  BOOST_COST: 0.003,
  
  // Worm
  INITIAL_LENGTH: 0.25,
  MIN_LENGTH: 0.25,
  BOOST_MIN_LENGTH: 0.35,
  SCALE_THRESHOLD: 35,
  GROWTH_FACTOR: 35,
  MAX_SEGMENTS: 200,
  
  // Auth
  GOOGLE_CLIENT_ID: '189957581422-476kf5r5i2kili987fbjhgtkosnr7ujd.apps.googleusercontent.com',
  TURNSTILE_SECRET: '1x0000000000000000000000000000000AA', // Replace with real secret
  TURNSTILE_VERIFY_URL: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
  
  // Token
  TOKEN_EXPIRE_DAYS: 30,
  
  // Minimap
  MINIMAP_SIZE: 500,
  MINIMAP_TICK_INTERVAL: 5, // every N ticks
};