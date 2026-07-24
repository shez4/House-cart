import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import db, { dataDir } from './db.js';
import { parseReceipt, parsingEnabled } from './receipt-parser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const DEFAULT_CURRENCY = process.env.HOUSECART_CURRENCY || '£';

const uploadsDir = join(dataDir, 'uploads');
mkdirSync(uploadsDir, { recursive: true });

// Receipt images arrive as base64 JSON, so allow a larger body.
app.use(express.json({ limit: '15mb' }));
app.use(express.static(join(__dirname, 'public')));

// A friendly palette so each roommate gets a distinct colour dot.
const PALETTE = [
  '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4',
  '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#f43f5e',
];

// ---- prepared statements -------------------------------------------------
const stmts = {
  allRoommates: db.prepare('SELECT * FROM roommates ORDER BY created_at'),
  roommateById: db.prepare('SELECT * FROM roommates WHERE id = ?'),
  roommateByName: db.prepare('SELECT * FROM roommates WHERE name = ? COLLATE NOCASE'),
  insertRoommate: db.prepare('INSERT INTO roommates (name, color) VALUES (?, ?)'),
  deleteRoommate: db.prepare('DELETE FROM roommates WHERE id = ?'),

  allItems: db.prepare(`
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
    ORDER BY it.bought, it.created_at DESC
  `),
  itemById: db.prepare('SELECT * FROM items WHERE id = ?'),
  insertItem: db.prepare(`
    INSERT INTO items (name, quantity, note, list_type, owner_id, added_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  deleteItem: db.prepare('DELETE FROM items WHERE id = ?'),
};

// ---- helpers -------------------------------------------------------------
function asHttpError(res, code, message) {
  return res.status(code).json({ error: message });
}

// ---- roommates -----------------------------------------------------------
app.get('/api/roommates', (_req, res) => {
  res.json(stmts.allRoommates.all());
});

app.post('/api/roommates', (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return asHttpError(res, 400, 'A name is required.');
  if (name.length > 40) return asHttpError(res, 400, 'That name is too long.');

  const existing = stmts.roommateByName.get(name);
  if (existing) return res.status(200).json(existing); // idempotent join

  const count = stmts.allRoommates.all().length;
  const color = PALETTE[count % PALETTE.length];
  const { lastInsertRowid } = stmts.insertRoommate.run(name, color);
  res.status(201).json(stmts.roommateById.get(lastInsertRowid));
});

app.delete('/api/roommates/:id', (req, res) => {
  stmts.deleteRoommate.run(Number(req.params.id));
  res.status(204).end();
});

// ---- items ---------------------------------------------------------------
app.get('/api/items', (_req, res) => {
  res.json(stmts.allItems.all());
});

// Single call the client polls to render everything.
app.get('/api/state', (_req, res) => {
  res.json({
    roommates: stmts.allRoommates.all(),
    items: stmts.allItems.all(),
    parsing_enabled: parsingEnabled(),
    default_currency: DEFAULT_CURRENCY,
  });
});

app.post('/api/items', (req, res) => {
  const b = req.body || {};
  const name = (b.name || '').trim();
  if (!name) return asHttpError(res, 400, 'Item name is required.');

  const listType = b.list_type === 'personal' ? 'personal' : 'house';
  let ownerId = null;
  if (listType === 'personal') {
    ownerId = Number(b.owner_id) || null;
    if (!ownerId) return asHttpError(res, 400, 'Personal items need an owner.');
    if (!stmts.roommateById.get(ownerId)) return asHttpError(res, 400, 'Unknown owner.');
  }

  const addedBy = Number(b.added_by) || null;
  const quantity = (b.quantity || '').trim() || null;
  const note = (b.note || '').trim() || null;

  const { lastInsertRowid } = stmts.insertItem.run(
    name, quantity, note, listType, ownerId, addedBy,
  );
  res.status(201).json(stmts.itemById.get(lastInsertRowid));
});

// Patch supports editing fields and the claim / bought actions.
app.patch('/api/items/:id', (req, res) => {
  const id = Number(req.params.id);
  const item = stmts.itemById.get(id);
  if (!item) return asHttpError(res, 404, 'Item not found.');

  const b = req.body || {};
  const next = { ...item };

  if ('name' in b) next.name = (b.name || '').trim() || item.name;
  if ('quantity' in b) next.quantity = (b.quantity || '').trim() || null;
  if ('note' in b) next.note = (b.note || '').trim() || null;
  if ('claimed_by' in b) next.claimed_by = b.claimed_by == null ? null : Number(b.claimed_by);

  if ('bought' in b) {
    const bought = b.bought ? 1 : 0;
    next.bought = bought;
    if (bought) {
      next.bought_by = Number(b.bought_by) || next.claimed_by || null;
      next.bought_at = new Date().toISOString();
    } else {
      next.bought_by = null;
      next.bought_at = null;
    }
  }

  db.prepare(`
    UPDATE items
    SET name = ?, quantity = ?, note = ?, claimed_by = ?, bought = ?, bought_by = ?, bought_at = ?
    WHERE id = ?
  `).run(
    next.name, next.quantity, next.note, next.claimed_by,
    next.bought, next.bought_by, next.bought_at, id,
  );

  res.json(stmts.itemById.get(id));
});

app.delete('/api/items/:id', (req, res) => {
  stmts.deleteItem.run(Number(req.params.id));
  res.status(204).end();
});

// ---- receipts -------------------------------------------------------------
const rstmts = {
  list: db.prepare(`
    SELECT r.*, b.name AS buyer_name, b.color AS buyer_color,
           (SELECT COUNT(*) FROM receipt_items ri WHERE ri.receipt_id = r.id) AS item_count
    FROM receipts r
    LEFT JOIN roommates b ON b.id = r.buyer_id
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
    INSERT INTO receipts (buyer_id, store, currency, total, purchased_at, image_file, parse_status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  insertItem: db.prepare(`
    INSERT INTO receipt_items (receipt_id, name, price) VALUES (?, ?, ?)
  `),
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

app.get('/api/receipts', (_req, res) => {
  const list = rstmts.list.all();
  for (const r of list) r.items = rstmts.items.all(r.id); // needed for per-card split
  res.json(list);
});

app.get('/api/receipts/:id', (req, res) => {
  const receipt = receiptWithItems(Number(req.params.id));
  if (!receipt) return asHttpError(res, 404, 'Receipt not found.');
  res.json(receipt);
});

app.get('/api/receipts/:id/image', (req, res) => {
  const receipt = rstmts.byId.get(Number(req.params.id));
  if (!receipt || !receipt.image_file) return asHttpError(res, 404, 'No image.');
  const path = join(uploadsDir, receipt.image_file);
  if (!existsSync(path)) return asHttpError(res, 404, 'No image.');
  res.sendFile(path);
});

// Create a receipt from a base64 image, then (if enabled) auto-parse line items.
app.post('/api/receipts', async (req, res) => {
  const b = req.body || {};
  const buyerId = Number(b.buyer_id) || null;
  if (!buyerId || !stmts.roommateById.get(buyerId)) {
    return asHttpError(res, 400, 'A valid buyer is required.');
  }

  const mediaType = b.media_type || 'image/jpeg';
  const base64 = (b.image_base64 || '').replace(/^data:[^,]+,/, '');
  if (!base64) return asHttpError(res, 400, 'A receipt image is required.');

  // Create the row first so we can key the image file by receipt id.
  const { lastInsertRowid: id } = rstmts.insert.run(
    buyerId, null, DEFAULT_CURRENCY, null, null, null, 'pending',
  );

  const filename = `${id}${IMG_EXT[mediaType] || '.jpg'}`;
  try {
    writeFileSync(join(uploadsDir, filename), Buffer.from(base64, 'base64'));
    db.prepare('UPDATE receipts SET image_file = ? WHERE id = ?').run(filename, id);
  } catch {
    /* keep the receipt even if the image can't be written */
  }

  let parseStatus = 'disabled';
  if (parsingEnabled()) {
    try {
      const parsed = await parseReceipt({ base64, mediaType });
      db.prepare('UPDATE receipts SET store = ?, currency = ?, total = ?, purchased_at = ? WHERE id = ?')
        .run(parsed.store || null, parsed.currency || DEFAULT_CURRENCY,
             parsed.total || null, parsed.purchased_at || null, id);
      const insertMany = db.transaction((rows) => {
        for (const it of rows) rstmts.insertItem.run(id, it.name, it.price);
      });
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
  const id = Number(req.params.id);
  const receipt = rstmts.byId.get(id);
  if (!receipt) return asHttpError(res, 404, 'Receipt not found.');

  const b = req.body || {};
  const next = { ...receipt };
  if ('buyer_id' in b) next.buyer_id = b.buyer_id == null ? null : Number(b.buyer_id);
  if ('store' in b) next.store = (b.store || '').trim() || null;
  if ('currency' in b) next.currency = (b.currency || '').trim() || null;
  if ('total' in b) next.total = b.total == null || b.total === '' ? null : Number(b.total);
  if ('purchased_at' in b) next.purchased_at = (b.purchased_at || '').trim() || null;

  db.prepare('UPDATE receipts SET buyer_id = ?, store = ?, currency = ?, total = ?, purchased_at = ? WHERE id = ?')
    .run(next.buyer_id, next.store, next.currency, next.total, next.purchased_at, id);
  res.json(receiptWithItems(id));
});

app.delete('/api/receipts/:id', (req, res) => {
  const id = Number(req.params.id);
  const receipt = rstmts.byId.get(id);
  if (receipt?.image_file) {
    const path = join(uploadsDir, receipt.image_file);
    if (existsSync(path)) { try { unlinkSync(path); } catch { /* ignore */ } }
  }
  db.prepare('DELETE FROM receipts WHERE id = ?').run(id); // cascades to items
  res.status(204).end();
});

app.post('/api/receipts/:id/items', (req, res) => {
  const id = Number(req.params.id);
  if (!rstmts.byId.get(id)) return asHttpError(res, 404, 'Receipt not found.');
  const name = (req.body?.name || '').trim();
  if (!name) return asHttpError(res, 400, 'Item name is required.');
  const price = Number(req.body?.price) || 0;
  const { lastInsertRowid } = rstmts.insertItem.run(id, name, price);
  res.status(201).json(rstmts.itemById.get(lastInsertRowid));
});

app.patch('/api/receipt-items/:id', (req, res) => {
  const id = Number(req.params.id);
  const item = rstmts.itemById.get(id);
  if (!item) return asHttpError(res, 404, 'Item not found.');

  const b = req.body || {};
  const next = { ...item };
  if ('name' in b) next.name = (b.name || '').trim() || item.name;
  if ('price' in b) next.price = Number(b.price) || 0;
  if ('shared' in b) next.shared = b.shared ? 1 : 0;
  if ('assigned_to' in b) {
    next.assigned_to = b.assigned_to == null ? null : Number(b.assigned_to);
    if (next.assigned_to) next.shared = 0; // assigning to a person clears "shared"
  }

  db.prepare('UPDATE receipt_items SET name = ?, price = ?, assigned_to = ?, shared = ? WHERE id = ?')
    .run(next.name, next.price, next.assigned_to, next.shared, id);
  res.json(rstmts.itemById.get(id));
});

app.delete('/api/receipt-items/:id', (req, res) => {
  rstmts.deleteItem.run(Number(req.params.id));
  res.status(204).end();
});

// SPA fallback.
app.get('*', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`House-cart running at http://localhost:${PORT}`);
});
