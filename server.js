import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import crypto from 'node:crypto';
import db, { dataDir } from './db.js';
import { parseReceipt, parsingEnabled } from './receipt-parser.js';
import {
  authEnabled, googleClientId, verifyGoogleToken, upsertUser,
  createSession, setSessionCookie, clearSessionCookie, userFromReq,
} from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const DEFAULT_CURRENCY = process.env.HOUSECART_CURRENCY || '$';

const uploadsDir = join(dataDir, 'uploads');
mkdirSync(uploadsDir, { recursive: true });

app.use(express.json({ limit: '15mb' }));
app.use(express.static(join(__dirname, 'public')));

const PALETTE = [
  '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4',
  '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#f43f5e',
];
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no easily-confused chars

function asHttpError(res, code, message) { return res.status(code).json({ error: message }); }

// ---- prepared statements -------------------------------------------------
const stmts = {
  houseById: db.prepare('SELECT * FROM houses WHERE id = ?'),
  houseByCode: db.prepare('SELECT * FROM houses WHERE join_code = ? COLLATE NOCASE'),
  insertHouse: db.prepare('INSERT INTO houses (name, join_code) VALUES (?, ?)'),

  roommatesInHouse: db.prepare('SELECT * FROM roommates WHERE house_id = ? ORDER BY created_at'),
  roommateById: db.prepare('SELECT * FROM roommates WHERE id = ?'),
  roommateByName: db.prepare('SELECT * FROM roommates WHERE house_id = ? AND name = ? COLLATE NOCASE'),
  roommateByUser: db.prepare('SELECT * FROM roommates WHERE user_id = ? LIMIT 1'),
  insertRoommate: db.prepare('INSERT INTO roommates (house_id, user_id, name, color) VALUES (?, ?, ?, ?)'),
  deleteRoommate: db.prepare('DELETE FROM roommates WHERE id = ?'),

  itemsInHouse: db.prepare(`
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
    WHERE it.house_id = ?
    ORDER BY it.bought, it.created_at DESC
  `),
  itemById: db.prepare('SELECT * FROM items WHERE id = ?'),
  insertItem: db.prepare(`
    INSERT INTO items (house_id, name, quantity, note, list_type, owner_id, added_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  deleteItem: db.prepare('DELETE FROM items WHERE id = ?'),
};

// ---- house / roommate helpers --------------------------------------------
function genCode() {
  let code = '';
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return code;
}
function uniqueCode() {
  for (let i = 0; i < 20; i++) { const c = genCode(); if (!stmts.houseByCode.get(c)) return c; }
  return genCode() + crypto.randomInt(9);
}

// Give a roommate a unique-per-house name and a palette colour, then insert.
function addRoommate(houseId, userId, wantedName) {
  const count = stmts.roommatesInHouse.all(houseId).length;
  const color = PALETTE[count % PALETTE.length];
  let name = (wantedName || 'Roommate').trim().slice(0, 40) || 'Roommate';
  if (stmts.roommateByName.get(houseId, name)) {
    let n = 2;
    while (stmts.roommateByName.get(houseId, `${name} ${n}`)) n++;
    name = `${name} ${n}`;
  }
  const { lastInsertRowid } = stmts.insertRoommate.run(houseId, userId, name, color);
  return stmts.roommateById.get(lastInsertRowid);
}

let cachedDefaultHouseId = null;
function defaultHouseId() {
  if (cachedDefaultHouseId) return cachedDefaultHouseId;
  const existing = stmts.houseByCode.get('LOCAL');
  cachedDefaultHouseId = existing ? existing.id : stmts.insertHouse.run('Our House', 'LOCAL').lastInsertRowid;
  return cachedDefaultHouseId;
}

// Resolve who is calling and which house they're in.
// Modes: 'open' (no auth), 'guest' (auth, not signed in), 'needs_house', 'ready'.
function getContext(req) {
  if (!authEnabled()) return { mode: 'open', houseId: defaultHouseId(), user: null, me: null };
  const user = userFromReq(req);
  if (!user) return { mode: 'guest', houseId: null, user: null, me: null };
  const me = stmts.roommateByUser.get(user.id);
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

function sessionPayload(ctx) {
  const base = { auth_enabled: authEnabled() };
  if (!authEnabled()) return { ...base, ready: true };
  base.google_client_id = googleClientId();
  if (ctx.mode === 'guest') return { ...base, signed_in: false };
  const user = { name: ctx.user.name, email: ctx.user.email, picture: ctx.user.picture };
  if (ctx.mode === 'needs_house') return { ...base, signed_in: true, user, in_house: false };
  const house = stmts.houseById.get(ctx.houseId);
  return {
    ...base, signed_in: true, user, in_house: true,
    house: { name: house.name, join_code: house.join_code },
    me: publicRoommate(ctx.me),
  };
}

// ---- auth + house endpoints ----------------------------------------------
app.get('/api/session', (req, res) => res.json(sessionPayload(getContext(req))));

app.post('/auth/google', async (req, res) => {
  if (!authEnabled()) return asHttpError(res, 400, 'Google sign-in is not configured.');
  const credential = req.body?.credential;
  if (!credential) return asHttpError(res, 400, 'Missing Google credential.');
  try {
    const profile = await verifyGoogleToken(credential);
    const user = upsertUser(profile);
    setSessionCookie(req, res, createSession(user.id));
    res.json(sessionPayload(getContext(req)));
  } catch (err) {
    asHttpError(res, 401, err.message || 'Sign-in failed.');
  }
});

app.post('/auth/logout', (req, res) => {
  clearSessionCookie(req, res);
  res.status(204).end();
});

app.post('/api/houses', (req, res) => {
  if (!authEnabled()) return asHttpError(res, 400, 'Houses are managed by sign-in.');
  const ctx = getContext(req);
  if (ctx.mode === 'guest') return asHttpError(res, 401, 'Please sign in.');
  if (ctx.mode === 'ready') return asHttpError(res, 409, "You're already in a house.");
  const name = (req.body?.name || '').trim().slice(0, 60) || 'Our House';
  const { lastInsertRowid: houseId } = stmts.insertHouse.run(name, uniqueCode());
  addRoommate(houseId, ctx.user.id, ctx.user.name);
  res.status(201).json(sessionPayload(getContext(req)));
});

app.post('/api/houses/join', (req, res) => {
  if (!authEnabled()) return asHttpError(res, 400, 'Houses are managed by sign-in.');
  const ctx = getContext(req);
  if (ctx.mode === 'guest') return asHttpError(res, 401, 'Please sign in.');
  if (ctx.mode === 'ready') return asHttpError(res, 409, "You're already in a house.");
  const code = (req.body?.code || '').trim();
  if (!code) return asHttpError(res, 400, 'Enter a join code.');
  const house = stmts.houseByCode.get(code);
  if (!house) return asHttpError(res, 404, 'No house found with that code.');
  addRoommate(house.id, ctx.user.id, ctx.user.name);
  res.status(201).json(sessionPayload(getContext(req)));
});

// ---- roommates -----------------------------------------------------------
app.get('/api/roommates', (req, res) => {
  const ctx = getContext(req);
  const houseId = requireHouse(ctx, res);
  if (houseId == null) return;
  res.json(stmts.roommatesInHouse.all(houseId));
});

// Only used in open mode (the name-picker). With Google auth, members come from
// signing in, so this is rejected.
app.post('/api/roommates', (req, res) => {
  if (authEnabled()) return asHttpError(res, 400, 'Members join by signing in with Google.');
  const houseId = defaultHouseId();
  const name = (req.body?.name || '').trim();
  if (!name) return asHttpError(res, 400, 'A name is required.');
  if (name.length > 40) return asHttpError(res, 400, 'That name is too long.');
  const existing = stmts.roommateByName.get(houseId, name);
  if (existing) return res.status(200).json(existing);
  res.status(201).json(addRoommate(houseId, null, name));
});

app.delete('/api/roommates/:id', (req, res) => {
  if (authEnabled()) return asHttpError(res, 400, 'Members are managed by sign-in.');
  const houseId = defaultHouseId();
  const r = stmts.roommateById.get(Number(req.params.id));
  if (r && r.house_id === houseId) stmts.deleteRoommate.run(r.id);
  res.status(204).end();
});

// ---- state ---------------------------------------------------------------
app.get('/api/state', (req, res) => {
  const ctx = getContext(req);
  const houseId = requireHouse(ctx, res);
  if (houseId == null) return;
  res.json({
    roommates: stmts.roommatesInHouse.all(houseId),
    items: stmts.itemsInHouse.all(houseId),
    parsing_enabled: parsingEnabled(),
    default_currency: DEFAULT_CURRENCY,
  });
});

app.get('/api/items', (req, res) => {
  const ctx = getContext(req);
  const houseId = requireHouse(ctx, res);
  if (houseId == null) return;
  res.json(stmts.itemsInHouse.all(houseId));
});

// A roommate id is valid only if it belongs to this house.
function houseRoommate(id, houseId) {
  const r = stmts.roommateById.get(Number(id));
  return r && r.house_id === houseId ? r : null;
}
// In Google mode "me" is the session roommate; in open mode fall back to a body id.
function selfId(ctx, houseId, bodyId) {
  if (ctx.me) return ctx.me.id;
  const r = houseRoommate(bodyId, houseId);
  return r ? r.id : null;
}

app.post('/api/items', (req, res) => {
  const ctx = getContext(req);
  const houseId = requireHouse(ctx, res);
  if (houseId == null) return;
  const b = req.body || {};
  const name = (b.name || '').trim();
  if (!name) return asHttpError(res, 400, 'Item name is required.');

  const listType = b.list_type === 'personal' ? 'personal' : 'house';
  let ownerId = null;
  if (listType === 'personal') {
    ownerId = selfId(ctx, houseId, b.owner_id);
    if (!ownerId) return asHttpError(res, 400, 'Personal items need an owner.');
  }
  const addedBy = selfId(ctx, houseId, b.added_by);
  const quantity = (b.quantity || '').trim() || null;
  const note = (b.note || '').trim() || null;

  const { lastInsertRowid } = stmts.insertItem.run(
    houseId, name, quantity, note, listType, ownerId, addedBy,
  );
  res.status(201).json(stmts.itemById.get(lastInsertRowid));
});

app.patch('/api/items/:id', (req, res) => {
  const ctx = getContext(req);
  const houseId = requireHouse(ctx, res);
  if (houseId == null) return;
  const item = stmts.itemById.get(Number(req.params.id));
  if (!item || item.house_id !== houseId) return asHttpError(res, 404, 'Item not found.');

  const b = req.body || {};
  const next = { ...item };
  if ('name' in b) next.name = (b.name || '').trim() || item.name;
  if ('quantity' in b) next.quantity = (b.quantity || '').trim() || null;
  if ('note' in b) next.note = (b.note || '').trim() || null;
  if ('claimed_by' in b) {
    next.claimed_by = b.claimed_by == null ? null : (houseRoommate(b.claimed_by, houseId)?.id ?? null);
  }
  if ('bought' in b) {
    const bought = b.bought ? 1 : 0;
    next.bought = bought;
    if (bought) {
      next.bought_by = selfId(ctx, houseId, b.bought_by) || next.claimed_by || null;
      next.bought_at = new Date().toISOString();
    } else {
      next.bought_by = null;
      next.bought_at = null;
    }
  }

  db.prepare(`
    UPDATE items SET name = ?, quantity = ?, note = ?, claimed_by = ?, bought = ?, bought_by = ?, bought_at = ?
    WHERE id = ?
  `).run(next.name, next.quantity, next.note, next.claimed_by, next.bought, next.bought_by, next.bought_at, item.id);

  res.json(stmts.itemById.get(item.id));
});

app.delete('/api/items/:id', (req, res) => {
  const ctx = getContext(req);
  const houseId = requireHouse(ctx, res);
  if (houseId == null) return;
  const item = stmts.itemById.get(Number(req.params.id));
  if (item && item.house_id === houseId) stmts.deleteItem.run(item.id);
  res.status(204).end();
});

// ---- receipts -------------------------------------------------------------
const rstmts = {
  listInHouse: db.prepare(`
    SELECT r.*, b.name AS buyer_name, b.color AS buyer_color,
           (SELECT COUNT(*) FROM receipt_items ri WHERE ri.receipt_id = r.id) AS item_count
    FROM receipts r
    LEFT JOIN roommates b ON b.id = r.buyer_id
    WHERE r.house_id = ?
    ORDER BY r.created_at DESC
  `),
  byId: db.prepare(`
    SELECT r.*, b.name AS buyer_name, b.color AS buyer_color
    FROM receipts r LEFT JOIN roommates b ON b.id = r.buyer_id
    WHERE r.id = ?
  `),
  items: db.prepare(`
    SELECT ri.*, a.name AS assigned_name, a.color AS assigned_color
    FROM receipt_items ri
    LEFT JOIN roommates a ON a.id = ri.assigned_to
    WHERE ri.receipt_id = ?
    ORDER BY ri.created_at, ri.id
  `),
  insert: db.prepare(`
    INSERT INTO receipts (house_id, buyer_id, store, currency, total, purchased_at, image_file, parse_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  insertItem: db.prepare('INSERT INTO receipt_items (receipt_id, name, price) VALUES (?, ?, ?)'),
  itemById: db.prepare('SELECT * FROM receipt_items WHERE id = ?'),
  deleteItem: db.prepare('DELETE FROM receipt_items WHERE id = ?'),
};

const IMG_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

function receiptWithItems(id) {
  const receipt = rstmts.byId.get(id);
  if (!receipt) return null;
  receipt.items = rstmts.items.all(id);
  return receipt;
}
// Fetch a receipt only if it belongs to this house.
function houseReceipt(id, houseId) {
  const r = rstmts.byId.get(Number(id));
  return r && r.house_id === houseId ? r : null;
}

app.get('/api/receipts', (req, res) => {
  const ctx = getContext(req);
  const houseId = requireHouse(ctx, res);
  if (houseId == null) return;
  const list = rstmts.listInHouse.all(houseId);
  for (const r of list) r.items = rstmts.items.all(r.id);
  res.json(list);
});

app.get('/api/receipts/:id', (req, res) => {
  const ctx = getContext(req);
  const houseId = requireHouse(ctx, res);
  if (houseId == null) return;
  if (!houseReceipt(req.params.id, houseId)) return asHttpError(res, 404, 'Receipt not found.');
  res.json(receiptWithItems(Number(req.params.id)));
});

app.get('/api/receipts/:id/image', (req, res) => {
  const ctx = getContext(req);
  const houseId = requireHouse(ctx, res);
  if (houseId == null) return;
  const receipt = houseReceipt(req.params.id, houseId);
  if (!receipt || !receipt.image_file) return asHttpError(res, 404, 'No image.');
  const path = join(uploadsDir, receipt.image_file);
  if (!existsSync(path)) return asHttpError(res, 404, 'No image.');
  res.sendFile(path);
});

app.post('/api/receipts', async (req, res) => {
  const ctx = getContext(req);
  const houseId = requireHouse(ctx, res);
  if (houseId == null) return;
  const b = req.body || {};
  const buyerId = selfId(ctx, houseId, b.buyer_id);
  if (!buyerId) return asHttpError(res, 400, 'A valid buyer is required.');

  const mediaType = b.media_type || 'image/jpeg';
  const base64 = (b.image_base64 || '').replace(/^data:[^,]+,/, '');
  if (!base64) return asHttpError(res, 400, 'A receipt image is required.');

  const { lastInsertRowid: id } = rstmts.insert.run(
    houseId, buyerId, null, DEFAULT_CURRENCY, null, null, null, 'pending',
  );

  const filename = `${id}${IMG_EXT[mediaType] || '.jpg'}`;
  try {
    writeFileSync(join(uploadsDir, filename), Buffer.from(base64, 'base64'));
    db.prepare('UPDATE receipts SET image_file = ? WHERE id = ?').run(filename, id);
  } catch { /* keep the receipt even if the image can't be written */ }

  let parseStatus = 'disabled';
  if (parsingEnabled()) {
    try {
      const parsed = await parseReceipt({ base64, mediaType });
      db.prepare('UPDATE receipts SET store = ?, currency = ?, total = ?, purchased_at = ? WHERE id = ?')
        .run(parsed.store || null, parsed.currency || DEFAULT_CURRENCY, parsed.total || null, parsed.purchased_at || null, id);
      const insertMany = db.transaction((rows) => { for (const it of rows) rstmts.insertItem.run(id, it.name, it.price); });
      insertMany(parsed.items);
      parseStatus = 'ok';
    } catch (err) {
      console.error('Receipt parse failed:', err.message);
      parseStatus = 'error';
    }
  }

  db.prepare('UPDATE receipts SET parse_status = ? WHERE id = ?').run(parseStatus, id);
  res.status(201).json(receiptWithItems(id));
});

app.patch('/api/receipts/:id', (req, res) => {
  const ctx = getContext(req);
  const houseId = requireHouse(ctx, res);
  if (houseId == null) return;
  const receipt = houseReceipt(req.params.id, houseId);
  if (!receipt) return asHttpError(res, 404, 'Receipt not found.');

  const b = req.body || {};
  const next = { ...receipt };
  if ('buyer_id' in b) next.buyer_id = b.buyer_id == null ? null : (houseRoommate(b.buyer_id, houseId)?.id ?? next.buyer_id);
  if ('store' in b) next.store = (b.store || '').trim() || null;
  if ('currency' in b) next.currency = (b.currency || '').trim() || null;
  if ('total' in b) next.total = b.total == null || b.total === '' ? null : Number(b.total);
  if ('purchased_at' in b) next.purchased_at = (b.purchased_at || '').trim() || null;

  db.prepare('UPDATE receipts SET buyer_id = ?, store = ?, currency = ?, total = ?, purchased_at = ? WHERE id = ?')
    .run(next.buyer_id, next.store, next.currency, next.total, next.purchased_at, receipt.id);
  res.json(receiptWithItems(receipt.id));
});

app.delete('/api/receipts/:id', (req, res) => {
  const ctx = getContext(req);
  const houseId = requireHouse(ctx, res);
  if (houseId == null) return;
  const receipt = houseReceipt(req.params.id, houseId);
  if (!receipt) return res.status(204).end();
  if (receipt.image_file) {
    const path = join(uploadsDir, receipt.image_file);
    if (existsSync(path)) { try { unlinkSync(path); } catch { /* ignore */ } }
  }
  db.prepare('DELETE FROM receipts WHERE id = ?').run(receipt.id); // cascades to items
  res.status(204).end();
});

app.post('/api/receipts/:id/items', (req, res) => {
  const ctx = getContext(req);
  const houseId = requireHouse(ctx, res);
  if (houseId == null) return;
  const receipt = houseReceipt(req.params.id, houseId);
  if (!receipt) return asHttpError(res, 404, 'Receipt not found.');
  const name = (req.body?.name || '').trim();
  if (!name) return asHttpError(res, 400, 'Item name is required.');
  const price = Number(req.body?.price) || 0;
  const { lastInsertRowid } = rstmts.insertItem.run(receipt.id, name, price);
  res.status(201).json(rstmts.itemById.get(lastInsertRowid));
});

// A receipt line item is in-house if its parent receipt is.
function houseReceiptItem(id, houseId) {
  const it = rstmts.itemById.get(Number(id));
  if (!it) return null;
  return houseReceipt(it.receipt_id, houseId) ? it : null;
}

app.patch('/api/receipt-items/:id', (req, res) => {
  const ctx = getContext(req);
  const houseId = requireHouse(ctx, res);
  if (houseId == null) return;
  const item = houseReceiptItem(req.params.id, houseId);
  if (!item) return asHttpError(res, 404, 'Item not found.');

  const b = req.body || {};
  const next = { ...item };
  if ('name' in b) next.name = (b.name || '').trim() || item.name;
  if ('price' in b) next.price = Number(b.price) || 0;
  if ('shared' in b) next.shared = b.shared ? 1 : 0;
  if ('assigned_to' in b) {
    next.assigned_to = b.assigned_to == null ? null : (houseRoommate(b.assigned_to, houseId)?.id ?? null);
    if (next.assigned_to) next.shared = 0;
  }

  db.prepare('UPDATE receipt_items SET name = ?, price = ?, assigned_to = ?, shared = ? WHERE id = ?')
    .run(next.name, next.price, next.assigned_to, next.shared, item.id);
  res.json(rstmts.itemById.get(item.id));
});

app.delete('/api/receipt-items/:id', (req, res) => {
  const ctx = getContext(req);
  const houseId = requireHouse(ctx, res);
  if (houseId == null) return;
  const item = houseReceiptItem(req.params.id, houseId);
  if (item) rstmts.deleteItem.run(item.id);
  res.status(204).end();
});

// SPA fallback.
app.get('*', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`House-cart running at http://localhost:${PORT}`);
  console.log(`  Google sign-in: ${authEnabled() ? 'enabled' : 'off (open name-picker mode)'}`);
});
