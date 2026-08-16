// Google Sign-In + session handling. When GOOGLE_CLIENT_ID isn't set the app
// runs in "open" mode (the simple name-picker) and none of this is used.
import crypto from 'node:crypto';
import { q, one } from './db.js';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const SESSION_DAYS = 30;
const COOKIE = 'hc_session';

export function authEnabled() { return Boolean(CLIENT_ID); }
export function googleClientId() { return CLIENT_ID; }

let oauthClient = null;
async function getOAuthClient() {
  if (!oauthClient) {
    const { OAuth2Client } = await import('google-auth-library');
    oauthClient = new OAuth2Client(CLIENT_ID);
  }
  return oauthClient;
}

// Verify a Google ID token; resolves to { sub, email, name, picture } or throws.
export async function verifyGoogleToken(idToken) {
  const client = await getOAuthClient();
  const ticket = await client.verifyIdToken({ idToken, audience: CLIENT_ID });
  const p = ticket.getPayload();
  if (!p || !p.sub) throw new Error('Invalid Google token.');
  if (p.email && p.email_verified === false) throw new Error('Your Google email is not verified.');
  return {
    sub: p.sub,
    email: p.email || null,
    name: p.name || p.email || 'Roommate',
    picture: p.picture || null,
  };
}

// ---- users ----------------------------------------------------------------
export async function upsertUser({ sub, email, name, picture }) {
  return one(
    `INSERT INTO users (google_sub, email, name, picture)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (google_sub) DO UPDATE SET email = $2, name = $3, picture = $4
     RETURNING *`,
    [sub, email, name, picture],
  );
}

// ---- sessions -------------------------------------------------------------
export async function createSession(userId) {
  const id = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await q('INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)', [id, userId, expires]);
  return id;
}

async function userFromSessionId(id) {
  if (!id) return null;
  const row = await one(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.expires_at > NOW()`,
    [id],
  );
  return row || null;
}

export async function destroySession(id) {
  if (id) await q('DELETE FROM sessions WHERE id = $1', [id]);
}

// ---- cookies --------------------------------------------------------------
function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function isSecure(req) {
  return req.secure || (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

export function sessionIdFromReq(req) { return parseCookies(req)[COOKIE] || null; }
export function userFromReq(req) { return userFromSessionId(sessionIdFromReq(req)); }

export function setSessionCookie(req, res, id) {
  const parts = [`${COOKIE}=${id}`, 'HttpOnly', 'Path=/', 'SameSite=Lax', `Max-Age=${SESSION_DAYS * 86400}`];
  if (isSecure(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}
export async function clearSessionCookie(req, res) {
  const parts = [`${COOKIE}=`, 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
  if (isSecure(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
  await destroySession(sessionIdFromReq(req));
}
