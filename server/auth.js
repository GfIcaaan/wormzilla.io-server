'use strict';

const { OAuth2Client } = require('google-auth-library');
const cfg = require('./config');

const googleClient = new OAuth2Client(cfg.GOOGLE_CLIENT_ID);

async function verifyGoogleJWT(credential) {
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: cfg.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    return { sub: payload.sub, email: payload.email, name: payload.name };
  } catch (err) {
    return null;
  }
}

async function verifyTurnstile(token, remoteip) {
  // Skip verification in dev mode if using test secret
  if (cfg.TURNSTILE_SECRET === '1x0000000000000000000000000000000AA') {
    return true;
  }
  try {
    const body = new URLSearchParams({
      secret: cfg.TURNSTILE_SECRET,
      response: token,
    });
    if (remoteip) body.append('remoteip', remoteip);

    const res = await fetch(cfg.TURNSTILE_VERIFY_URL, {
      method: 'POST',
      body,
    });
    const data = await res.json();
    return data.success === true;
  } catch {
    return false;
  }
}

// Simple word filter – extend as needed
const BANNED_WORDS = ['admin', 'moderator', 'staff', 'wormzilla'];

function filterUsername(name) {
  const lower = name.toLowerCase();
  for (const w of BANNED_WORDS) {
    if (lower.includes(w)) return false;
  }
  return true;
}

function validateUsername(name) {
  if (!name || typeof name !== 'string') return 'empty';
  const trimmed = name.trim();
  if (trimmed.length < 3) return 'short';
  if (trimmed.length > 20) return 'long';
  if (!filterUsername(trimmed)) return 'flagged';
  return 'ok';
}

module.exports = { verifyGoogleJWT, verifyTurnstile, validateUsername };
