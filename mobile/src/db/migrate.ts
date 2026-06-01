import { expoDb } from "./index";

// On-device schema bootstrap. There's no drizzle-kit push on a phone, so we create
// every table with raw DDL at startup (idempotent). Column definitions match
// src/db/schema.ts exactly so snapshots from the desktop import cleanly.

const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS categories (
  name TEXT PRIMARY KEY,
  definition TEXT NOT NULL,
  is_paycheck_source INTEGER DEFAULT 0,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS connection (
  id INTEGER PRIMARY KEY,
  access_url TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY,
  org_name TEXT,
  org_domain TEXT,
  name TEXT,
  currency TEXT,
  balance REAL,
  available_balance REAL,
  balance_date TEXT,
  account_type TEXT DEFAULT 'depository',
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS raw_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id TEXT NOT NULL,
  source TEXT NOT NULL,
  account_id TEXT NOT NULL,
  fetched_at TEXT DEFAULT (datetime('now')),
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  transaction_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  date TEXT NOT NULL,
  amount REAL NOT NULL,
  description TEXT,
  payee TEXT,
  memo TEXT,
  pending INTEGER DEFAULT 0,
  flow_type TEXT,
  category TEXT,
  category_source TEXT,
  category_confidence TEXT,
  category_alternatives TEXT,
  is_paycheck INTEGER DEFAULT 0,
  user_note TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS paycheck_splits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id TEXT NOT NULL,
  portion TEXT NOT NULL,
  amount REAL NOT NULL,
  source TEXT DEFAULT 'auto',
  note TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS sync_state (
  id INTEGER PRIMARY KEY,
  last_synced_at TEXT
);

CREATE TABLE IF NOT EXISTS planning_store (
  id INTEGER PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_txn_category ON transactions(category);
CREATE INDEX IF NOT EXISTS idx_raw_txnid ON raw_transactions(transaction_id);
`;

let done = false;

// Idempotent. Safe to call on every app launch; runs the DDL once per process.
export function ensureSchema() {
  if (done) return;
  expoDb.execSync(DDL);
  // Upgrade path: if an older on-device DB predates the updated_at columns, add them.
  for (const table of ["categories", "accounts", "transactions", "paycheck_splits"]) {
    const cols = expoDb.getAllSync(`PRAGMA table_info(${table})`) as { name: string }[];
    if (!cols.some((c) => c.name === "updated_at")) {
      expoDb.execSync(`ALTER TABLE ${table} ADD COLUMN updated_at TEXT`);
      expoDb.execSync(`UPDATE ${table} SET updated_at = '1970-01-01T00:00:00.000Z' WHERE updated_at IS NULL`);
    }
  }
  done = true;
}
