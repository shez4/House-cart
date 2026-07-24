import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Keep the database file in ./data (gitignored). Allow override for deployment.
const dataDir = process.env.HOUSECART_DATA_DIR || join(__dirname, 'data');
mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(join(dataDir, 'house-cart.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
`);

// ---- migration ------------------------------------------------------------
// v1 stored a single global house with no auth. v2 adds houses/users/sessions
// and scopes data per house. Old databases (pre-deploy dev data) are reset.
const tableExists = (name) =>
  !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name);
const columns = (name) => {
  try { return db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name); }
  catch { return []; }
};

if (tableExists('items') && !columns('items').includes('house_id')) {
  console.warn('[house-cart] Upgrading database to the multi-house schema — existing dev data is being reset.');
  db.exec(`
    DROP TABLE IF EXISTS receipt_items;
    DROP TABLE IF EXISTS receipts;
    DROP TABLE IF EXISTS items;
    DROP TABLE IF EXISTS roommates;
  `);
}

// ---- schema ---------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS houses (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    join_code  TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    google_sub TEXT NOT NULL UNIQUE,
    email      TEXT,
    name       TEXT,
    picture    TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS roommates (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    house_id   INTEGER NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    name       TEXT NOT NULL,
    color      TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (house_id, name),
    UNIQUE (house_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    house_id   INTEGER NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    quantity   TEXT,
    note       TEXT,
    list_type  TEXT NOT NULL CHECK (list_type IN ('house','personal')),
    owner_id   INTEGER REFERENCES roommates(id) ON DELETE CASCADE,
    added_by   INTEGER REFERENCES roommates(id) ON DELETE SET NULL,
    claimed_by INTEGER REFERENCES roommates(id) ON DELETE SET NULL,
    bought     INTEGER NOT NULL DEFAULT 0,
    bought_by  INTEGER REFERENCES roommates(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    bought_at  TEXT
  );

  CREATE TABLE IF NOT EXISTS receipts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    house_id     INTEGER NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
    buyer_id     INTEGER REFERENCES roommates(id) ON DELETE SET NULL,
    store        TEXT,
    currency     TEXT,
    total        REAL,
    purchased_at TEXT,
    image_file   TEXT,
    parse_status TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS receipt_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_id  INTEGER NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    price       REAL NOT NULL DEFAULT 0,
    assigned_to INTEGER REFERENCES roommates(id) ON DELETE SET NULL,
    shared      INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

export { dataDir };
export default db;
