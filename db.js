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
`);

export default db;
