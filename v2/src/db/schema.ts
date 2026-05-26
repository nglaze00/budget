import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// User's spending categories, ported from v1.
// `isPaycheckSource` flags categories whose transactions should be treated as paychecks
// (driving paycheck splits, etc.). Add new employers by adding categories with this flag.
export const categories = sqliteTable("categories", {
  name: text("name").primaryKey(),
  definition: text("definition").notNull(),
  isPaycheckSource: integer("is_paycheck_source").default(0),
});

// Singleton-ish: one row holds the SimpleFIN access URL.
export const connection = sqliteTable("connection", {
  id: integer("id").primaryKey(),
  accessUrl: text("access_url").notNull(),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

// SimpleFIN doesn't tell us if an account is depository vs credit, so we ask the user.
export const accounts = sqliteTable("accounts", {
  accountId: text("account_id").primaryKey(),
  orgName: text("org_name"),                  // e.g. "Chase", "Capital One"
  orgDomain: text("org_domain"),
  name: text("name"),
  currency: text("currency"),
  balance: real("balance"),
  availableBalance: real("available_balance"),
  balanceDate: text("balance_date"),
  // user-set, drives cash-flow vs spending classification:
  accountType: text("account_type").default("depository"), // depository | credit | investment
});

// RAW LAYER: append-only log of every transaction payload we've ever fetched.
// One row per (transaction_id, fetched_at). Never updated.
export const rawTransactions = sqliteTable("raw_transactions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  transactionId: text("transaction_id").notNull(),
  source: text("source").notNull(),           // 'simplefin' (future: 'csv', 'manual', ...)
  accountId: text("account_id").notNull(),
  fetchedAt: text("fetched_at").default(sql`(datetime('now'))`),
  payloadJson: text("payload_json").notNull(),
});

// PROCESSED LAYER: derived from the latest raw payload per transaction_id.
// Rebuildable from raw_transactions alone (modulo user_note / user category / user splits).
// SimpleFIN convention: positive amount = money IN, negative = money OUT.
export const transactions = sqliteTable("transactions", {
  transactionId: text("transaction_id").primaryKey(),
  accountId: text("account_id").notNull().references(() => accounts.accountId),
  date: text("date").notNull(),               // YYYY-MM-DD (from posted timestamp)
  amount: real("amount").notNull(),
  description: text("description"),
  payee: text("payee"),
  memo: text("memo"),
  pending: integer("pending").default(0),
  flowType: text("flow_type"),                // spend | earn | transfer | cc_payment | unknown
  category: text("category"),                 // FK-ish to categories.name; nullable until classified
  categorySource: text("category_source"),    // 'llm' | 'user' | null
  categoryConfidence: text("category_confidence"), // 'unsure' | 'somewhat_sure' | 'mostly_sure' | 'completely_sure' | null
  categoryAlternatives: text("category_alternatives"), // JSON string array of up to 2 runner-up category names (LLM-suggested) — surfaced in review UI as quick-pick chips
  isPaycheck: integer("is_paycheck").default(0),
  userNote: text("user_note"),
});

export const paycheckSplits = sqliteTable("paycheck_splits", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  transactionId: text("transaction_id").notNull().references(() => transactions.transactionId),
  portion: text("portion").notNull(),         // regular | bonus
  amount: real("amount").notNull(),
  source: text("source").default("auto"),     // auto | user — user-set splits are immune to re-computation
  note: text("note"),
});

export const syncState = sqliteTable("sync_state", {
  id: integer("id").primaryKey(),
  lastSyncedAt: text("last_synced_at"),
});
