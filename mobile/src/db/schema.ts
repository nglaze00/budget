import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Schema is a 1:1 port of the desktop app's src/db/schema.ts (including the sync
// `updated_at` columns) so snapshots round-trip cleanly between devices.

export const categories = sqliteTable("categories", {
  name: text("name").primaryKey(),
  definition: text("definition").notNull(),
  isPaycheckSource: integer("is_paycheck_source").default(0),
  updatedAt: text("updated_at"),
});

export const connection = sqliteTable("connection", {
  id: integer("id").primaryKey(),
  accessUrl: text("access_url").notNull(),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

export const accounts = sqliteTable("accounts", {
  accountId: text("account_id").primaryKey(),
  orgName: text("org_name"),
  orgDomain: text("org_domain"),
  name: text("name"),
  currency: text("currency"),
  balance: real("balance"),
  availableBalance: real("available_balance"),
  balanceDate: text("balance_date"),
  accountType: text("account_type").default("depository"), // depository | credit | investment
  updatedAt: text("updated_at"),
});

export const rawTransactions = sqliteTable("raw_transactions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  transactionId: text("transaction_id").notNull(),
  source: text("source").notNull(),
  accountId: text("account_id").notNull(),
  fetchedAt: text("fetched_at").default(sql`(datetime('now'))`),
  payloadJson: text("payload_json").notNull(),
});

export const transactions = sqliteTable("transactions", {
  transactionId: text("transaction_id").primaryKey(),
  accountId: text("account_id").notNull(),
  date: text("date").notNull(),
  amount: real("amount").notNull(),
  description: text("description"),
  payee: text("payee"),
  memo: text("memo"),
  pending: integer("pending").default(0),
  flowType: text("flow_type"),
  category: text("category"),
  categorySource: text("category_source"),
  categoryConfidence: text("category_confidence"),
  categoryAlternatives: text("category_alternatives"),
  isPaycheck: integer("is_paycheck").default(0),
  userNote: text("user_note"),
  updatedAt: text("updated_at"),
});

export const paycheckSplits = sqliteTable("paycheck_splits", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  transactionId: text("transaction_id").notNull(),
  portion: text("portion").notNull(),
  amount: real("amount").notNull(),
  source: text("source").default("auto"),
  note: text("note"),
  updatedAt: text("updated_at"),
});

export const syncState = sqliteTable("sync_state", {
  id: integer("id").primaryKey(),
  lastSyncedAt: text("last_synced_at"),
});
