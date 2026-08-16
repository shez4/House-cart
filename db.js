// Postgres data layer. Works with Vercel Postgres / Neon / any Postgres URL.
// Serverless-friendly: a small shared pool, lazily created per warm instance.
import pg from 'pg';

const { Pool } = pg;

const connectionString =
  process.env.POSTGRES_URL ||
  process.env.DATABASE_URL ||
  process.env.POSTGRES_PRISMA_URL ||
  '';

if (!connectionString) {
  console.warn('[house-cart] No POSTGRES_URL/DATABASE_URL set — the app cannot store data.');
}

// Hosted Postgres (Vercel/Neon/Supabase) requires TLS; a local dev server doesn't.
const isLocal = /@(localhost|127\.0\.0\.1)/.test(connectionString);

let pool = null;
export function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString,
      ssl: isLocal ? false : { rejectUnauthorized: false },
      max: Number(process.env.PGPOOL_MAX || 3), // keep small for serverless
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on('error', (err) => console.error('[house-cart] idle pg client error:', err.message));
  }
  return pool;
}

// Query helper: sql`...` style is overkill here, so a plain function.
export async function q(text, params = []) {
  const res = await getPool().query(text, params);
  return res.rows;
}
export async function one(text, params = []) {
  const rows = await q(text, params);
  return rows[0] || null;
}

// ---- schema ---------------------------------------------------------------
let initPromise = null;
export function initDb() {
  if (!initPromise) initPromise = createSchema();
  return initPromise;
}

async function createSchema() {
  await q(`
    CREATE TABLE IF NOT EXISTS houses (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      join_code  TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      id         SERIAL PRIMARY KEY,
      google_sub TEXT NOT NULL UNIQUE,
      email      TEXT,
      name       TEXT,
      picture    TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await q(`
    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);
  await q(`
    CREATE TABLE IF NOT EXISTS roommates (
      id         SERIAL PRIMARY KEY,
      house_id   INTEGER NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
      user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      name       TEXT NOT NULL,
      color      TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (house_id, name),
      UNIQUE (house_id, user_id)
    );
  `);
  await q(`
    CREATE TABLE IF NOT EXISTS items (
      id         SERIAL PRIMARY KEY,
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      bought_at  TIMESTAMPTZ
    );
  `);
  await q(`
    CREATE TABLE IF NOT EXISTS receipts (
      id           SERIAL PRIMARY KEY,
      house_id     INTEGER NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
      buyer_id     INTEGER REFERENCES roommates(id) ON DELETE SET NULL,
      store        TEXT,
      currency     TEXT,
      total        REAL,
      purchased_at TEXT,
      image_url    TEXT,
      parse_status TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await q(`
    CREATE TABLE IF NOT EXISTS receipt_items (
      id          SERIAL PRIMARY KEY,
      receipt_id  INTEGER NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      price       REAL NOT NULL DEFAULT 0,
      assigned_to INTEGER REFERENCES roommates(id) ON DELETE SET NULL,
      shared      INTEGER NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}
