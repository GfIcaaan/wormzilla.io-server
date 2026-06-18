'use strict';

module.exports = {
  // Server
  HTTP_PORT: 3000,
  WS_PORT: 8080,
  
  // World
  // Client default: lh=500, ef=4000 (SCALE_THRESHOLD), Og=7000 (GROWTH_FACTOR)
  // All game coordinates must be in [-500, 500] range to match client.
  WORLD_SIZE: 1000,
  WORLD_HALF: 500,
  MAX_PLAYERS: 320,
  TICK_RATE: 95,       // MUST be 95ms -- client hardcodes 95 in Cl() and Ge() interpolation
  
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
  // The client has NO independent movement simulation -- it is a pure
  // authoritative-server renderer: it sends only angle+boost (see fr() in
  // 0tEwHoKWpm.js, called every 20ms from setInterval) and renders whatever
  // head/segment positions the server sends back (Section 11 "yl" parser ->
  // P.Ci(headX, headY, boost) directly on the local T.Le instance -- no
  // client-side speed formula exists to copy a number from).
  //
  // What the client DOES define is segment spacing "jb" (Ye.prototype.Ze in
  // T.Le): jb = 0.025 * (5 + 0.9 * segCount), matching calcSegmentCount()
  // above exactly. Every server tick unshifts exactly ONE new segment at the
  // new head position (see updatePlayerMovement below), so the distance the
  // head travels per tick IS the gap between consecutive segments. For that
  // gap to match the "jb" spacing the client expects between segments (the
  // same jb its own Rj()/Ge() smoothing assumes when interpolating segment
  // positions), per-tick speed must scale with jb -- a small ~10-segment worm
  // (jb≈0.35) and a max ~200-segment worm (jb≈4.625) need very different
  // absolute speeds to both look like "one segment-length per tick", which a
  // fixed BASE_SPEED constant could never satisfy for both sizes at once.
  // These are now multipliers on the worm's own current jb, not fixed units:
  BASE_SPEED_FACTOR: 2.5,   // 1.0x jb per tick = head advances exactly one segment-spacing
  BOOST_SPEED_FACTOR: 5,  // 2x jb per tick while boosting
  BOOST_COST: 0.003,
  
  // Worm
  // Initial kb chosen so worm spawns with score 12 (kb * 50 = 12 → kb = 0.24).
  // calcSegmentCount(0.24) returns 3 (minimum), giving a tiny starting worm.
  INITIAL_LENGTH: 0.24,
  MIN_LENGTH: 0.20,
  BOOST_MIN_LENGTH: 0.24,
  // ef and Og must match client defaults (from client source: lh=500, ef=4e3, Og=7e3)
  SCALE_THRESHOLD: 4000,
  GROWTH_FACTOR: 7000,
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
