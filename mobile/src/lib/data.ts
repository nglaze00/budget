import { desc, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";

// Thin data-access layer used by the screens. Mirrors the desktop API routes
// (/api/review, /api/paychecks, /api/transactions, /api/categories, /api/accounts,
// /api/planning) but runs directly against the on-device SQLite.

export interface CategoryRow { name: string; definition: string; isPaycheckSource: number | null }

export async function listCategories(): Promise<CategoryRow[]> {
  const cats = await db.query.categories.findMany();
  return cats.map((c) => ({ name: c.name, definition: c.definition, isPaycheckSource: c.isPaycheckSource ?? 0 }));
}

export interface ReviewTxn {
  transactionId: string; date: string; amount: number; description: string | null; payee: string | null;
  category: string | null; categoryConfidence: string | null; categoryAlternatives: string | null;
  accountName: string | null; accountOrgName: string | null; accountType: string | null;
}

export interface SplitRow { portion: string; amount: number; source: string | null }
export interface PaycheckRow {
  transactionId: string; date: string; amount: number; description: string | null;
  category: string | null; splits: SplitRow[];
}

export async function getReviewData(): Promise<{ transactions: ReviewTxn[]; paychecks: PaycheckRow[] }> {
  const transactions = await db.all<ReviewTxn>(sql`
    SELECT t.transaction_id AS transactionId, t.date, t.amount, t.description, t.payee,
           t.category, t.category_confidence AS categoryConfidence, t.category_alternatives AS categoryAlternatives,
           a.name AS accountName, a.org_name AS accountOrgName, a.account_type AS accountType
    FROM transactions t
    LEFT JOIN accounts a ON a.account_id = t.account_id
    WHERE t.category_confidence IN ('unsure', 'somewhat_sure')
      AND (t.category_source IS NULL OR t.category_source != 'user')
    ORDER BY t.date DESC
  `);

  const allPaychecks = await db.query.transactions.findMany({
    where: eq(schema.transactions.isPaycheck, 1),
    orderBy: [desc(schema.transactions.date)],
  });
  const splits = await db.query.paycheckSplits.findMany();
  const splitsByTx = new Map<string, SplitRow[]>();
  for (const s of splits) {
    const list = splitsByTx.get(s.transactionId) ?? [];
    list.push({ portion: s.portion, amount: s.amount, source: s.source });
    splitsByTx.set(s.transactionId, list);
  }

  const paychecks: PaycheckRow[] = allPaychecks
    .map((p) => ({
      transactionId: p.transactionId, date: p.date, amount: p.amount, description: p.description,
      category: p.category, splits: splitsByTx.get(p.transactionId) ?? [],
    }))
    .filter((p) => p.splits.length > 0 && p.splits.every((s) => s.source !== "user"));

  return { transactions, paychecks };
}

// User confirms / overrides a category. Marks it user-sourced so it's protected and synced.
export async function setUserCategory(transactionId: string, category: string): Promise<void> {
  await db
    .update(schema.transactions)
    .set({ category, categorySource: "user", categoryConfidence: "completely_sure", updatedAt: new Date().toISOString() })
    .where(eq(schema.transactions.transactionId, transactionId));
}

export async function setUserNote(transactionId: string, note: string): Promise<void> {
  await db
    .update(schema.transactions)
    .set({ userNote: note, updatedAt: new Date().toISOString() })
    .where(eq(schema.transactions.transactionId, transactionId));
}

// User locks a paycheck split. Replaces auto splits with user-sourced ones.
export async function confirmSplit(transactionId: string, regular: number, bonus: number, note?: string): Promise<void> {
  const now = new Date().toISOString();
  await db.delete(schema.paycheckSplits).where(eq(schema.paycheckSplits.transactionId, transactionId));
  await db.insert(schema.paycheckSplits).values([
    { transactionId, portion: "regular", amount: regular, source: "user", note: note ?? null, updatedAt: now },
    { transactionId, portion: "bonus", amount: bonus, source: "user", note: note ?? null, updatedAt: now },
  ]);
}

export interface TxnRow {
  transactionId: string; date: string; amount: number; description: string | null; payee: string | null;
  category: string | null; categorySource: string | null; flowType: string | null;
  accountName: string | null; accountOrgName: string | null;
}

export async function listTransactions(opts: {
  month?: string; category?: string; search?: string; limit?: number; offset?: number;
} = {}): Promise<TxnRow[]> {
  const limit = opts.limit ?? 200;
  const offset = opts.offset ?? 0;
  const conds = [sql`1 = 1`];
  if (opts.month) conds.push(sql`strftime('%Y-%m', t.date) = ${opts.month}`);
  if (opts.category) conds.push(sql`t.category = ${opts.category}`);
  if (opts.search && opts.search.trim()) {
    const m = `%${opts.search.toLowerCase()}%`;
    conds.push(sql`(LOWER(t.description) LIKE ${m} OR LOWER(t.payee) LIKE ${m})`);
  }
  const where = conds.reduce((acc, c) => sql`${acc} AND ${c}`);
  return db.all<TxnRow>(sql`
    SELECT t.transaction_id AS transactionId, t.date, t.amount, t.description, t.payee,
           t.category, t.category_source AS categorySource, t.flow_type AS flowType,
           a.name AS accountName, a.org_name AS accountOrgName
    FROM transactions t
    LEFT JOIN accounts a ON a.account_id = t.account_id
    WHERE ${where}
    ORDER BY t.date DESC
    LIMIT ${limit} OFFSET ${offset}
  `);
}

export interface AccountRow {
  accountId: string; orgName: string | null; name: string | null; accountType: string | null;
  balance: number | null; balanceDate: string | null;
}

export async function listAccounts(): Promise<AccountRow[]> {
  const rows = await db.query.accounts.findMany();
  return rows.map((a) => ({
    accountId: a.accountId, orgName: a.orgName, name: a.name, accountType: a.accountType,
    balance: a.balance, balanceDate: a.balanceDate,
  }));
}

export async function setAccountType(accountId: string, accountType: string): Promise<void> {
  await db
    .update(schema.accounts)
    .set({ accountType, updatedAt: new Date().toISOString() })
    .where(eq(schema.accounts.accountId, accountId));
}

export async function getConnection(): Promise<{ accessUrl: string } | null> {
  const c = await db.query.connection.findFirst();
  return c ? { accessUrl: c.accessUrl } : null;
}

export async function getLastSyncedAt(): Promise<string | null> {
  const rows = await db.all<{ lastSyncedAt: string | null }>(sql`SELECT last_synced_at AS lastSyncedAt FROM sync_state WHERE id = 1`);
  return rows[0]?.lastSyncedAt ?? null;
}

export async function getPlanning(): Promise<string | null> {
  const rows = await db.all<{ data: string }>(sql`SELECT data FROM planning_store WHERE id = 1`);
  return rows[0]?.data ?? null;
}

export async function setPlanning(data: string): Promise<void> {
  await db.run(sql`
    INSERT INTO planning_store (id, data, updated_at) VALUES (1, ${data}, ${new Date().toISOString()})
    ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `);
}

// ── Inflows (dashboard) ──────────────────────────────────────────────────────
export interface InflowTxn {
  transactionId: string; date: string; amount: number; description: string | null; payee: string | null;
  category: string | null; accountOrgName: string | null; accountName: string | null;
}

// All positive (money-in) transactions for a month, excluding credit-card payments
// (those are positive on the credit account but just settle earlier spend, not real inflows).
export async function listInflows(month: string): Promise<InflowTxn[]> {
  return db.all<InflowTxn>(sql`
    SELECT t.transaction_id AS transactionId, t.date, t.amount, t.description, t.payee,
           t.category, a.org_name AS accountOrgName, a.name AS accountName
    FROM transactions t
    LEFT JOIN accounts a ON a.account_id = t.account_id
    WHERE strftime('%Y-%m', t.date) = ${month}
      AND t.amount > 0
      AND (t.category IS NULL OR t.category != 'Credit card payments')
    ORDER BY t.amount DESC
  `);
}

export interface InflowSplit { portion: string; amount: number }

// Paycheck regular/bonus splits for the month's paycheck transactions, keyed by txn id.
export async function getPaycheckSplits(month: string): Promise<Map<string, InflowSplit[]>> {
  const rows = await db.all<{ transactionId: string; portion: string; amount: number }>(sql`
    SELECT ps.transaction_id AS transactionId, ps.portion, ps.amount
    FROM paycheck_splits ps
    JOIN transactions t ON t.transaction_id = ps.transaction_id
    WHERE strftime('%Y-%m', t.date) = ${month}
  `);
  const map = new Map<string, InflowSplit[]>();
  for (const r of rows) {
    const list = map.get(r.transactionId) ?? [];
    list.push({ portion: r.portion, amount: r.amount });
    map.set(r.transactionId, list);
  }
  return map;
}

// Spending transactions for one category in one month (category drilldown).
export async function categorySpendTxns(month: string, category: string): Promise<TxnRow[]> {
  return db.all<TxnRow>(sql`
    SELECT t.transaction_id AS transactionId, t.date, t.amount, t.description, t.payee,
           t.category, t.category_source AS categorySource, t.flow_type AS flowType,
           a.name AS accountName, a.org_name AS accountOrgName
    FROM transactions t
    LEFT JOIN accounts a ON a.account_id = t.account_id
    WHERE strftime('%Y-%m', t.date) = ${month} AND t.category = ${category} AND t.flow_type = 'spend'
    ORDER BY ABS(t.amount) DESC
  `);
}

// ── Cash-flow history (Chase debit balance over time) ───────────────────────
export interface CashPoint {
  date: string; balance: number; net: number; in_total: number; out_total: number; flagged: boolean;
}
export interface CashFlowHistory {
  account: { accountId: string; name: string | null; orgName: string | null; balance: number } | null;
  series: CashPoint[];
}

// Reconstruct the Chase debit daily balance by walking back from the live balance.
// Mirrors desktop /api/cashflow-history, incl. the "flagged inflow" detection
// (Investments-category inflows or Zelle deposits ≥ $1k that boosted the balance).
export async function cashFlowHistory(): Promise<CashFlowHistory> {
  const account = await db.get<{ accountId: string; name: string | null; orgName: string | null; balance: number }>(sql`
    SELECT account_id AS accountId, name, org_name AS orgName, balance FROM accounts
    WHERE account_type = 'depository' AND org_name LIKE '%Chase%'
    ORDER BY balance DESC LIMIT 1
  `);
  if (!account) return { account: null, series: [] };

  const daily = await db.all<{ date: string; net: number; in_total: number; out_total: number; flagged_inflow: number }>(sql`
    SELECT date,
      ROUND(SUM(amount), 2) AS net,
      ROUND(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 2) AS in_total,
      ROUND(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 2) AS out_total,
      ROUND(SUM(CASE
        WHEN amount > 0 AND category = 'Investments' THEN amount
        WHEN amount >= 1000 AND (description LIKE '%Zelle%' OR description LIKE '%ZELLE%') THEN amount
        ELSE 0
      END), 2) AS flagged_inflow
    FROM transactions
    WHERE account_id = ${account.accountId}
    GROUP BY date ORDER BY date
  `);

  const points: CashPoint[] = [];
  let running = account.balance;
  for (let i = daily.length - 1; i >= 0; i--) {
    points.push({
      date: daily[i].date,
      balance: Number(running.toFixed(2)),
      net: daily[i].net,
      in_total: daily[i].in_total,
      out_total: daily[i].out_total,
      flagged: daily[i].flagged_inflow > 0,
    });
    running -= daily[i].net;
  }
  points.reverse();
  return { account, series: points };
}

export async function pendingCount(): Promise<number> {
  const rows = await db.all<{ n: number }>(sql`
    SELECT COUNT(*) AS n FROM transactions WHERE category IS NULL
  `);
  return rows[0]?.n ?? 0;
}
