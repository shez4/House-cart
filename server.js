import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import db from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
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

// SPA fallback.
app.get('*', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`House-cart running at http://localhost:${PORT}`);
});
