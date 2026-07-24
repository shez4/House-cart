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

  CREATE TABLE IF NOT EXISTS roommates (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    color      TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
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

  -- A scanned/photographed receipt paid for by one roommate.
  CREATE TABLE IF NOT EXISTS receipts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    buyer_id     INTEGER REFERENCES roommates(id) ON DELETE SET NULL,
    store        TEXT,
    currency     TEXT,
    total        REAL,
    purchased_at TEXT,
    image_file   TEXT,
    parse_status TEXT,          -- 'ok' | 'disabled' | 'error'
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- One line item on a receipt, assignable to a roommate or shared.
  CREATE TABLE IF NOT EXISTS receipt_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_id  INTEGER NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    price       REAL NOT NULL DEFAULT 0,
    assigned_to INTEGER REFERENCES roommates(id) ON DELETE SET NULL,
    shared      INTEGER NOT NULL DEFAULT 0,   -- 1 = split evenly among everyone
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

export { dataDir };
export default db;
