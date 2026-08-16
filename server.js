import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { q, one, initDb } from './db.js';
import { parseReceipt, parsingEnabled } from './receipt-parser.js';
import { putReceiptImage, deleteReceiptImage, blobEnabled } from './storage.js';
import {
  authEnabled, googleClientId, verifyGoogleToken, upsertUser,
  createSession, setSessionCookie, clearSessionCookie, userFromReq,
} from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const DEFAULT_CURRENCY = process.env.HOUSECART_CURRENCY || '$';

app.use(express.json({ limit: '15mb' }));
app.use(express.static(join(__dirname, 'public')));

// Ensure the schema exists before any request touches the database.
app.use(async (_req, res, next) => {
  try { await initDb(); next(); }
  catch (err) {
    console.error('DB init failed:', err);
    res.status(500).json({ error: 'Database unavailable. Check POSTGRES_URL.' });
  }
});

const PALETTE = [
  '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4',
  '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#f43f5e',
];
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no easily-confused chars

function asHttpError(res, code, message) { return res.status(code).json({ error: message }); }

// Wrap an async handler so rejections become 500s instead of hanging.
const h = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(`${req.method} ${req.path} failed:`, err);
  if (!res.headersSent) asHttpError(res, 500, 'Something went wrong.');
});

// ---- house / roommate helpers --------------------------------------------
function genCode() {
  let code = '';
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return code;
}
async function uniqueCode() {
  for (let i = 0; i < 20; i++) {
    const c = genCode();
    if (!await one('SELECT id FROM houses WHERE join_code = $1', [c])) return c;
  }
  return genCode() + crypto.randomInt(9);
}

const roommatesInHouse = (houseId) =>
  q('SELECT * FROM roommates WHERE house_id = $1 ORDER BY created_at, id', [houseId]);

// Give a roommate a unique-per-house name and a palette colour, then insert.
async function addRoommate(houseId, userId, wantedName) {
  const existing = await roommatesInHouse(houseId);
  const color = PALETTE[existing.length % PALETTE.length];
  let base = (wantedName || 'Roommate').trim().slice(0, 40) || 'Roommate';
  let name = base;
  const taken = new Set(existing.map((r) => r.name.toLowerCase()));
  let n = 2;
  while (taken.has(name.toLowerCase())) { name = `${base} ${n}`; n++; }
  return one(
    'INSERT INTO roommates (house_id, user_id, name, color) VALUES ($1, $2, $3, $4) RETURNING *',
    [houseId, userId, name, color],
  );
}

let cachedDefaultHouseId = null;
async function defaultHouseId() {
  if (cachedDefaultHouseId) return cachedDefaultHouseId;
  const existing = await one('SELECT * FROM houses WHERE join_code = $1', ['LOCAL']);
  if (existing) { cachedDefaultHouseId = existing.id; return cachedDefaultHouseId; }
  const created = await one(
    `INSERT INTO houses (name, join_code) VALUES ($1, $2)
     ON CONFLICT (join_code) DO UPDATE SET name = houses.name RETURNING *`,
    ['Our House', 'LOCAL'],
  );
  cachedDefaultHouseId = created.id;
  return cachedDefaultHouseId;
}

// Resolve who is calling and which house they're in.
// Modes: 'open' (no auth), 'guest' (auth, not signed in), 'needs_house', 'ready'.
async function getContext(req) {
  if (!authEnabled()) return { mode: 'open', houseId: await defaultHouseId(), user: null, me: null };
  const user = await userFromReq(req);
  if (!user) return { mode: 'guest', houseId: null, user: null, me: null };
  const me = await one('SELECT * FROM roommates WHERE user_id = $1 LIMIT 1', [user.id]);
  if (!me) return { mode: 'needs_house', houseId: null, user, me: null };
  return { mode: 'ready', houseId: me.house_id, user, me };
}

const publicRoommate = (r) => (r ? { id: r.id, name: r.name, color: r.color } : null);

// Returns houseId, or sends the right error and returns null.
function requireHouse(ctx, res) {
  if (ctx.mode === 'guest') { asHttpError(res, 401, 'Please sign in.'); return null; }
  if (ctx.mode === 'needs_house') { asHttpError(res, 403, 'Create or join a house first.'); return null; }
  return ctx.houseId;
}

async function sessionPayload(ctx) {
  const base = { auth_enabled: authEnabled() };
  if (!authEnabled()) return { ...base, ready: true };
  base.google_client_id = googleClientId();
  if (ctx.mode === 'guest') return { ...base, signed_in: false };
  const user = { name: ctx.user.name, email: ctx.user.email, picture: ctx.user.picture };
  if (ctx.mode === 'needs_house') return { ...base, signed_in: true, user, in_house: false };
  const house = await one('SELECT * FROM houses WHERE id = $1', [ctx.houseId]);
  return {
    ...base, signed_in: true, user, in_house: true,
    house: { name: house.name, join_code: house.join_code },
    me: publicRoommate(ctx.me),
  };
}

// ---- auth + house endpoints ----------------------------------------------
app.get('/api/session', h(async (req, res) => {
  res.json(await sessionPayload(await getContext(req)));
}));

app.post('/auth/google', h(async (req, res) => {
  if (!authEnabled()) return asHttpError(res, 400, 'Google sign-in is not configured.');
  const credential = req.body?.credential;
  if (!credential) return asHttpError(res, 400, 'Missing Google credential.');
  try {
    const profile = await verifyGoogleToken(credential);
    const user = await upsertUser(profile);
    setSessionCookie(req, res, await createSession(user.id));
    res.json(await sessionPayload(await getContext(req)));
  } catch (err) {
    asHttpError(res, 401, err.message || 'Sign-in failed.');
  }
}));

app.post('/auth/logout', h(async (req, res) => {
  await clearSessionCookie(req, res);
  res.status(204).end();
}));

app.post('/api/houses', h(async (req, res) => {
  if (!authEnabled()) return asHttpError(res, 400, 'Houses are managed by sign-in.');
  const ctx = await getContext(req);
  if (ctx.mode === 'guest') return asHttpError(res, 401, 'Please sign in.');
  if (ctx.mode === 'ready') return asHttpError(res, 409, "You're already in a house.");
  const name = (req.body?.name || '').trim().slice(0, 60) || 'Our House';
  const house = await one(
    'INSERT INTO houses (name, join_code) VALUES ($1, $2) RETURNING *',
    [name, await uniqueCode()],
  );
  await addRoommate(house.id, ctx.user.id, ctx.user.name);
  res.status(201).json(await sessionPayload(await getContext(req)));
}));

app.post('/api/houses/join', h(async (req, res) => {
  if (!authEnabled()) return asHttpError(res, 400, 'Houses are managed by sign-in.');
  const ctx = await getContext(req);
  if (ctx.mode === 'guest') return asHttpError(res, 401, 'Please sign in.');
  if (ctx.mode === 'ready') return asHttpError(res, 409, "You're already in a house.");
  const code = (req.body?.code || '').trim();
  if (!code) return asHttpError(res, 400, 'Enter a join code.');
  const house = await one('SELECT * FROM houses WHERE UPPER(join_code) = UPPER($1)', [code]);
  if (!house) return asHttpError(res, 404, 'No house found with that code.');
  await addRoommate(house.id, ctx.user.id, ctx.user.name);
  res.status(201).json(await sessionPayload(await getContext(req)));
}));

// ---- roommates -----------------------------------------------------------
app.get('/api/roommates', h(async (req, res) => {
  const ctx = await getContext(req);
  const houseId = requireHouse(ctx, res);
  if (houseId == null) return;
  res.json(await roommatesInHouse(houseId));
}));

// Only used in open mode (the name-picker).
app.post('/api/roommates', h(async (req, res) => {
  if (authEnabled()) return asHttpError(res, 400, 'Members join by signing in with Google.');
  const houseId = await defaultHouseId();
  const name = (req.body?.name || '').trim();
  if (!name) return asHttpError(res, 400, 'A name is required.');
  if (name.length > 40) return asHttpError(res, 400, 'That name is too long.');
  const existing = await one(
    'SELECT * FROM roommates WHERE house_id = $1 AND LOWER(name) = LOWER($2)', [houseId, name],
  );
  if (existing) return res.status(200).json(existing);
  res.status(201).json(await addRoommate(houseId, null, name));
}));

app.delete('/api/roommates/:id', h(async (req, res) => {
  if (authEnabled()) return asHttpError(res, 400, 'Members are managed by sign-in.');
  const houseId = await defaultHouseId();
  await q('DELETE FROM roommates WHERE id = $1 AND house_id = $2', [Number(req.params.id), houseId]);
  res.status(204).end();
}));

// ---- state ---------------------------------------------------------------
const itemsInHouse = (houseId) => q(`
  SELECT it.*,
         own.name AS owner_name,   own.color AS owner_color,
         add_.name AS added_by_name,
         clm.name AS claimed_by_name, clm.color AS claimed_by_color,
         bgt.name AS bought_by_name
  FROM items it
  LEFT JOIN roommates own  ON own.id  = it.owner_id
  LEFT JOIN roommates add_ ON add_.id = it.added_by
  LEFT JOIN roommates clm  ON clm.id  = it.claimed_by
  LEFT JOIN roommates bgt  ON bgt.id  = it.bought_by
  WHERE it.house_id = $1
  ORDER BY it.bought, it.created_at DESC, it.id DESC
`, [houseId]);

app.get('/api/state', h(async (req, res) => {
  const ctx = await getContext(req);
  const houseId = requireHouse(ctx, res);
  if (houseId == null) return;
  const [roommates, items] = await Promise.all([roommatesInHouse(houseId), itemsInHouse(houseId)]);
  res.json({
    roommates, items,
    parsing_enabled: parsingEnabled(),
    default_currency: DEFAULT_CURRENCY,
  });
}));

app.get('/api/items', h(async (req, res) => {
  const ctx = await getContext(req);
  const houseId = requireHouse(ctx, res);
  if (houseId == null) return;
  res.json(await itemsInHouse(houseId));
}));

// A roommate id is valid only if it belongs to this house.
async function houseRoommate(id, houseId) {
  if (!id) return null;
  return one('SELECT * FROM roommates WHERE id = $1 AND house_id = $2', [Number(id), houseId]);
}
// In Google mode "me" is the session roommate; in open mode fall back to a body id.
async function selfId(ctx, houseId, bodyId) {
  if (ctx.me) return ctx.me.id;
  const r = await houseRoommate(bodyId, houseId);
  return r ? r.id : null;
}

app.post('/api/items', h(async (req, res) => {
  const ctx = await getContext(req);
  const houseId = requireHouse(ctx, res);
  if (houseId == null) return;
  const b = req.body || {};
  const name = (b.name || '').trim();
  if (!name) return asHttpError(res, 400, 'Item name is required.');

  const listType = b.list_type === 'personal' ? 'personal' : 'house';
  let ownerId = null;
  if (listType === 'personal') {
    ownerId = await selfId(ctx, houseId, b.owner_id);
    if (!ownerId) return asHttpError(res, 400, 'Personal items need an owner.');
  }
  const addedBy = await selfId(ctx, houseId, b.added_by);
  const quantity = (b.quantity || '').trim() || null;
  const note = (b.note || '').trim() || null;

  const row = await one(
    `INSERT INTO items (house_id, name, quantity, note, list_type, owner_id, added_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [houseId, name, quantity, note, listType, ownerId, addedBy],
  );
  res.status(201).json(row);
}));

app.patch('/api/items/:id', h(async (req, res) => {
  const ctx = await getContext(req);
  const houseId = requireHouse(ctx, res);
  if (houseId == null) return;
  const item = await one('SELECT * FROM items WHERE id = $1 AND house_id = $2', [Number(req.params.id), houseId]);
  if (!item) return asHttpError(res, 404, 'Item not found.');

  const b = req.body || {};
  const next = { ...item };
  if ('name' in b) next.name = (b.name || '').trim() || item.name;
  if ('quantity' in b) next.quantity = (b.quantity || '').trim() || null;
  if ('note' in b) next.note = (b.note || '').trim() || null;
  if ('claimed_by' in b) {
    next.claimed_by = b.claimed_by == null ? null : ((await houseRoommate(b.claimed_by, houseId))?.id ?? null);
  }
  if ('bought' in b) {
    const bought = b.bought ? 1 : 0;
    next.bought = bought;
    if (bought) {
      next.bought_by = (await selfId(ctx, houseId, b.bought_by)) || next.claimed_by || null;
      next.bought_at = new Date().toISOString();
    } else {
      next.bought_by = null;
      next.bought_at = null;
    }
  }

  const row = await one(
    `UPDATE items SET name = $1, quantity = $2, note = $3, claimed_by = $4,
     bought = $5, bought_by = $6, bought_at = $7 WHERE id = $8 RETURNING *`,
    [next.name, next.quantity, next.note, next.claimed_by, next.bought, next.bought_by, next.bought_at, item.id],
  );
  res.json(row);
}));

app.delete('/api/items/:id', h(async (req, res) => {
  const ctx = await getContext(req);
  const houseId = requireHouse(ctx, res);
  if (houseId == null) return;
  await q('DELETE FROM items WHERE id = $1 AND house_id = $2', [Number(req.params.id), houseId]);
  res.status(204).end();
}));

// ---- receipts -------------------------------------------------------------
const receiptItems = (receiptId) => q(`
  SELECT ri.*, a.name AS assigned_name, a.color AS assigned_color
  FROM receipt_items ri
  LEFT JOIN roommates a ON a.id = ri.assigned_to
  WHERE ri.receipt_id = $1
  ORDER BY ri.created_at, ri.id
`, [receiptId]);

const receiptById = (id) => one(`
  SELECT r.*, b.name AS buyer_name, b.color AS buyer_color
  FROM receipts r LEFT JOIN roommates b ON b.id = r.buyer_id
  WHERE r.id = $1
`, [id]);

async function receiptWithItems(id) {
  const receipt = await receiptById(id);
  if (!receipt) return null;
  receipt.items = await receiptItems(id);
  return receipt;
}
// Fetch a receipt only if it belongs to this house.
async function houseReceipt(id, houseId) {
  const r = await receiptById(Number(id));
  return r && r.house_id === houseId ? r : null;
}

app.get('/api/receipts', h(async (req, res) => {
  const ctx = await getContext(req);
  const houseId = requireHouse(ctx, res);
  if (houseId == null) return;
  const list = await q(`
    SELECT r.*, b.name AS buyer_name, b.color AS buyer_color,
           (SELECT COUNT(*) FROM receipt_items ri WHERE ri.receipt_id = r.id) AS item_count
    FROM receipts r
    LEFT JOIN roommates b ON b.id = r.buyer_id
    WHERE r.house_id = $1
    ORDER BY r.created_at DESC, r.id DESC
  `, [houseId]);
  for (const r of list) r.items = await receiptItems(r.id);
  res.json(list);
}));

app.get('/api/receipts/:id', h(async (req, res) => {
  const ctx = await getContext(req);
  const houseId = requireHouse(ctx, res);
  if (houseId == null) return;
  if (!await houseReceipt(req.params.id, houseId)) return asHttpError(res, 404, 'Receipt not found.');
  res.json(await receiptWithItems(Number(req.params.id)));
}));

// Images live in Blob storage; redirect to the stored URL.
app.get('/api/receipts/:id/image', h(async (req, res) => {
  const ctx = await getContext(req);
  const houseId = requireHouse(ctx, res);
  if (houseId == null) return;
  const receipt = await houseReceipt(req.params.id, houseId);
  if (!receipt || !receipt.image_url) return asHttpError(res, 404, 'No image.');
  res.redirect(receipt.image_url);
}));

app.post('/api/receipts', h(async (req, res) => {
  const ctx = await getContext(req);
  const houseId = requireHouse(ctx, res);
  if (houseId == null) return;
  const b = req.body || {};
  const buyerId = await selfId(ctx, houseId, b.buyer_id);
  if (!buyerId) return asHttpError(res, 400, 'A valid buyer is required.');

  const mediaType = b.media_type || 'image/jpeg';
  const base64 = (b.image_base64 || '').replace(/^data:[^,]+,/, '');
  if (!base64) return asHttpError(res, 400, 'A receipt image is required.');

  const created = await one(
    `INSERT INTO receipts (house_id, buyer_id, currency, parse_status)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [houseId, buyerId, DEFAULT_CURRENCY, 'pending'],
  );
  const id = created.id;

  // Store the photo (no-op when Blob isn't configured — the receipt still works).
  let imageUrl = null;
  try {
    imageUrl = await putReceiptImage(id, Buffer.from(base64, 'base64'), mediaType);
    if (imageUrl) await q('UPDATE receipts SET image_url = $1 WHERE id = $2', [imageUrl, id]);
  } catch (err) {
    console.error('Receipt image upload failed:', err.message);
  }

  let parseStatus = 'disabled';
  if (parsingEnabled()) {
    try {
      const parsed = await parseReceipt({ base64, mediaType });
      await q(
        'UPDATE receipts SET store = $1, currency = $2, total = $3, purchased_at = $4 WHERE id = $5',
        [parsed.store || null, parsed.currency || DEFAULT_CURRENCY, parsed.total || null, parsed.purchased_at || null, id],
      );
      for (const it of parsed.items) {
        await q('INSERT INTO receipt_items (receipt_id, name, price) VALUES ($1, $2, $3)', [id, it.name, it.price]);
      }
      parseStatus = 'ok';
    } catch (err) {
      console.error('Receipt parse failed:', err.message);
      parseStatus = 'error';
    }
  }

  await q('UPDATE receipts SET parse_status = $1 WHERE id = $2', [parseStatus, id]);
  res.status(201).json(await receiptWithItems(id));
}));

app.patch('/api/receipts/:id', h(async (req, res) => {
  const ctx = await getContext(req);
  const houseId = requireHouse(ctx, res);
  if (houseId == null) return;
  const receipt = await houseReceipt(req.params.id, houseId);
  if (!receipt) return asHttpError(res, 404, 'Receipt not found.');

  const b = req.body || {};
  const next = { ...receipt };
  if ('buyer_id' in b) {
    next.buyer_id = b.buyer_id == null ? null : ((await houseRoommate(b.buyer_id, houseId))?.id ?? next.buyer_id);
  }
  if ('store' in b) next.store = (b.store || '').trim() || null;
  if ('currency' in b) next.currency = (b.currency || '').trim() || null;
  if ('total' in b) next.total = b.total == null || b.total === '' ? null : Number(b.total);
  if ('purchased_at' in b) next.purchased_at = (b.purchased_at || '').trim() || null;

  await q(
    'UPDATE receipts SET buyer_id = $1, store = $2, currency = $3, total = $4, purchased_at = $5 WHERE id = $6',
    [next.buyer_id, next.store, next.currency, next.total, next.purchased_at, receipt.id],
  );
  res.json(await receiptWithItems(receipt.id));
}));

app.delete('/api/receipts/:id', h(async (req, res) => {
  const ctx = await getContext(req);
  const houseId = requireHouse(ctx, res);
  if (houseId == null) return;
  const receipt = await houseReceipt(req.params.id, houseId);
  if (!receipt) return res.status(204).end();
  if (receipt.image_url) { try { await deleteReceiptImage(receipt.image_url); } catch { /* ignore */ } }
  await q('DELETE FROM receipts WHERE id = $1', [receipt.id]); // cascades to items
  res.status(204).end();
}));

app.post('/api/receipts/:id/items', h(async (req, res) => {
  const ctx = await getContext(req);
  const houseId = requireHouse(ctx, res);
  if (houseId == null) return;
  const receipt = await houseReceipt(req.params.id, houseId);
  if (!receipt) return asHttpError(res, 404, 'Receipt not found.');
  const name = (req.body?.name || '').trim();
  if (!name) return asHttpError(res, 400, 'Item name is required.');
  const price = Number(req.body?.price) || 0;
  const row = await one(
    'INSERT INTO receipt_items (receipt_id, name, price) VALUES ($1, $2, $3) RETURNING *',
    [receipt.id, name, price],
  );
  res.status(201).json(row);
}));

// A receipt line item is in-house if its parent receipt is.
async function houseReceiptItem(id, houseId) {
  const it = await one('SELECT * FROM receipt_items WHERE id = $1', [Number(id)]);
  if (!it) return null;
  return (await houseReceipt(it.receipt_id, houseId)) ? it : null;
}

app.patch('/api/receipt-items/:id', h(async (req, res) => {
  const ctx = await getContext(req);
  const houseId = requireHouse(ctx, res);
  if (houseId == null) return;
  const item = await houseReceiptItem(req.params.id, houseId);
  if (!item) return asHttpError(res, 404, 'Item not found.');

  const b = req.body || {};
  const next = { ...item };
  if ('name' in b) next.name = (b.name || '').trim() || item.name;
  if ('price' in b) next.price = Number(b.price) || 0;
  if ('shared' in b) next.shared = b.shared ? 1 : 0;
  if ('assigned_to' in b) {
    next.assigned_to = b.assigned_to == null ? null : ((await houseRoommate(b.assigned_to, houseId))?.id ?? null);
    if (next.assigned_to) next.shared = 0;
  }

  const row = await one(
    'UPDATE receipt_items SET name = $1, price = $2, assigned_to = $3, shared = $4 WHERE id = $5 RETURNING *',
    [next.name, next.price, next.assigned_to, next.shared, item.id],
  );
  res.json(row);
}));

app.delete('/api/receipt-items/:id', h(async (req, res) => {
  const ctx = await getContext(req);
  const houseId = requireHouse(ctx, res);
  if (houseId == null) return;
  const item = await houseReceiptItem(req.params.id, houseId);
  if (item) await q('DELETE FROM receipt_items WHERE id = $1', [item.id]);
  res.status(204).end();
}));

// SPA fallback.
app.get('*', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// Vercel imports this app as a serverless handler; only listen when run directly.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`House-cart running at http://localhost:${PORT}`);
    console.log(`  Google sign-in: ${authEnabled() ? 'enabled' : 'off (open name-picker mode)'}`);
    console.log(`  Receipt images: ${blobEnabled() ? 'Vercel Blob' : 'not configured (photos not stored)'}`);
  });
}

export default app;
