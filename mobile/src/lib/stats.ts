import { sql } from "drizzle-orm";
import { db } from "@/db";

// Dashboard stats — ported from the desktop /api/stats route. Same SQL (CTEs + window
// functions, supported by expo-sqlite's bundled SQLite), exposed as a function instead
// of an HTTP endpoint.

export interface Stats {
  month: string;
  windowStart: string;
  windowEnd: string;
  monthlySpend: { month: string; total: number; income: number; net: number }[];
  yoySpend: { year: string; total: number }[];
  categorySpend: { category: string; current_month: number; txn_count: number }[];
  categoryMonthly: { category: string; month: string; total: number }[];
  anomalies: { transaction_id: string; date: string; description: string; payee: string; amount: number; category: string; category_p90: number; category_median: number; category_count: number }[];
  cashFlow: { direction: string; total: number }[];
  cashFlowDaily: { date: string; net: number; in_total: number; out_total: number }[];
  coverage: { org_name: string; org_domain: string; account_type: string; last_txn_date: string; txn_count: number }[];
  investmentAccounts: { account_id: string; name: string; balance: number; balance_date: string; contributions: number }[];
  netWorth: { cash: number; investments: number; credit: number; total: number } | null;
}

export async function computeStats(month?: string, before = 2, after = 2): Promise<Stats> {
  const today = new Date().toISOString().slice(0, 7);
  const anchor = month ?? today;

  const range = await db.get<{ min_month: string | null; max_month: string | null }>(sql`
    SELECT strftime('%Y-%m', MIN(date)) AS min_month, strftime('%Y-%m', MAX(date)) AS max_month
    FROM transactions WHERE flow_type = 'spend'
  `);
  const { windowStart, windowEnd } = resolveWindow(anchor, before, after, range?.min_month, range?.max_month);
  const windowStartDate = `${windowStart}-01`;
  const windowEndDate = `${windowEnd}-01`;

  const monthlySpend = await db.all<{ month: string; total: number; income: number; net: number }>(sql`
    WITH RECURSIVE months(m) AS (
      SELECT date(${windowStartDate})
      UNION ALL
      SELECT date(m, '+1 month') FROM months WHERE m < date(${windowEndDate})
    )
    SELECT
      strftime('%Y-%m', months.m) AS month,
      ROUND(COALESCE((SELECT SUM(ABS(amount)) FROM transactions
        WHERE flow_type = 'spend' AND category IS NOT NULL AND category != 'Credit card payments'
          AND strftime('%Y-%m', date) = strftime('%Y-%m', months.m)), 0), 2) AS total,
      ROUND(COALESCE((SELECT SUM(amount) FROM transactions
        WHERE flow_type = 'earn' AND category IS NOT NULL AND category != 'Credit card payments'
          AND strftime('%Y-%m', date) = strftime('%Y-%m', months.m)), 0), 2) AS income,
      ROUND(
        COALESCE((SELECT SUM(amount) FROM transactions
          WHERE flow_type = 'earn' AND category IS NOT NULL AND category != 'Credit card payments'
            AND strftime('%Y-%m', date) = strftime('%Y-%m', months.m)), 0)
        - COALESCE((SELECT SUM(ABS(amount)) FROM transactions
          WHERE flow_type = 'spend' AND category IS NOT NULL AND category != 'Credit card payments'
            AND strftime('%Y-%m', date) = strftime('%Y-%m', months.m)), 0)
      , 2) AS net
    FROM months ORDER BY month
  `);

  const anchorMonthNum = Number(anchor.slice(5, 7));
  const yoySpend = await db.all<{ year: string; total: number }>(sql`
    SELECT strftime('%Y', date) as year, ROUND(SUM(ABS(amount)), 2) as total
    FROM transactions
    WHERE CAST(strftime('%m', date) AS INTEGER) = ${anchorMonthNum}
      AND flow_type = 'spend' AND category IS NOT NULL AND category != 'Credit card payments'
    GROUP BY year ORDER BY year
  `);

  const categorySpend = await db.all<{ category: string; current_month: number; txn_count: number }>(sql`
    SELECT category, ROUND(SUM(ABS(amount)), 2) as current_month, COUNT(*) as txn_count
    FROM transactions
    WHERE flow_type = 'spend' AND category IS NOT NULL AND category != 'Credit card payments'
      AND strftime('%Y-%m', date) = ${anchor}
    GROUP BY category
  `);

  const cat12Start = `${shiftYM(anchor, -11)}-01`;
  const cat12End = `${anchor}-01`;
  const categoryMonthly = await db.all<{ category: string; month: string; total: number }>(sql`
    WITH RECURSIVE months(m) AS (
      SELECT date(${cat12Start})
      UNION ALL
      SELECT date(m, '+1 month') FROM months WHERE m < date(${cat12End})
    ),
    active_cats AS (
      SELECT DISTINCT category FROM transactions
      WHERE flow_type = 'spend' AND category IS NOT NULL AND category != 'Credit card payments'
        AND date >= date(${cat12Start}) AND date < date(${cat12End}, '+1 month')
    )
    SELECT c.category, strftime('%Y-%m', m.m) as month, ROUND(COALESCE(SUM(ABS(t.amount)), 0), 2) as total
    FROM active_cats c
    CROSS JOIN months m
    LEFT JOIN transactions t ON t.category = c.category AND t.flow_type = 'spend'
      AND strftime('%Y-%m', t.date) = strftime('%Y-%m', m.m)
    GROUP BY c.category, m.m ORDER BY c.category, m.m
  `);

  const anomalies = await db.all<Stats["anomalies"][number]>(sql`
    WITH cat_txns AS (
      SELECT category, ABS(amount) AS amt,
        ROW_NUMBER() OVER (PARTITION BY category ORDER BY ABS(amount)) AS rn,
        COUNT(*) OVER (PARTITION BY category) AS cnt
      FROM transactions
      WHERE flow_type = 'spend' AND category IS NOT NULL AND category != 'Credit card payments'
        AND date >= date(${windowEndDate}, '-12 month') AND date < date(${windowEndDate}, '+1 month')
    ),
    cat_stats AS (
      SELECT category,
        MIN(CASE WHEN rn * 100 >= cnt * 90 THEN amt END) AS p90,
        MAX(CASE WHEN rn IN ((cnt + 1) / 2, (cnt + 2) / 2) THEN amt END) AS med,
        MAX(cnt) AS cnt
      FROM cat_txns GROUP BY category HAVING MAX(cnt) >= 20
    )
    SELECT t.transaction_id, t.date, COALESCE(t.description, '') AS description, COALESCE(t.payee, '') AS payee,
      ABS(t.amount) AS amount, t.category, cs.p90 AS category_p90, cs.med AS category_median, cs.cnt AS category_count
    FROM transactions t
    JOIN cat_stats cs ON cs.category = t.category
    WHERE t.flow_type = 'spend' AND strftime('%Y-%m', t.date) = ${anchor}
      AND ABS(t.amount) > cs.p90 AND ABS(t.amount) >= 50
    ORDER BY ABS(t.amount) / cs.p90 DESC LIMIT 10
  `);

  const cashFlow = await db.all<{ direction: string; total: number }>(sql`
    SELECT CASE WHEN t.amount > 0 THEN 'in' ELSE 'out' END as direction, ROUND(SUM(ABS(t.amount)), 2) as total
    FROM transactions t JOIN accounts a ON a.account_id = t.account_id
    WHERE strftime('%Y-%m', t.date) = ${anchor} AND a.account_type = 'depository' AND a.org_name LIKE '%Chase%'
    GROUP BY direction
  `);

  const cashFlowDaily = await db.all<{ date: string; net: number; in_total: number; out_total: number }>(sql`
    SELECT t.date as date, ROUND(SUM(t.amount), 2) as net,
      ROUND(SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END), 2) as in_total,
      ROUND(SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END), 2) as out_total
    FROM transactions t JOIN accounts a ON a.account_id = t.account_id
    WHERE strftime('%Y-%m', t.date) = ${anchor} AND a.account_type = 'depository' AND a.org_name LIKE '%Chase%'
    GROUP BY t.date ORDER BY t.date
  `);

  const coverage = await db.all<{ org_name: string; org_domain: string; account_type: string; last_txn_date: string; txn_count: number }>(sql`
    SELECT a.org_name, a.org_domain, a.account_type, MAX(t.date) as last_txn_date, COUNT(t.transaction_id) as txn_count
    FROM accounts a
    LEFT JOIN transactions t ON t.account_id = a.account_id AND t.date >= date('now', '-30 day')
    GROUP BY a.org_domain, a.account_type
  `);

  const investmentAccounts = await db.all<{ account_id: string; name: string; balance: number; balance_date: string; contributions: number }>(sql`
    SELECT a.account_id, a.name, a.balance, a.balance_date,
      COALESCE((SELECT ROUND(SUM(t.amount), 2) FROM transactions t
        WHERE t.account_id = a.account_id AND strftime('%Y-%m', t.date) = ${anchor}), 0) as contributions
    FROM accounts a WHERE LOWER(a.org_name) LIKE '%fidelity%' ORDER BY a.balance DESC
  `);

  const netWorth = await db.get<{ cash: number; investments: number; credit: number; total: number }>(sql`
    SELECT
      ROUND(COALESCE(SUM(CASE WHEN account_type = 'depository' THEN balance ELSE 0 END), 0), 2) AS cash,
      ROUND(COALESCE(SUM(CASE WHEN account_type = 'investment' THEN balance ELSE 0 END), 0), 2) AS investments,
      ROUND(COALESCE(SUM(CASE WHEN account_type = 'credit' THEN balance ELSE 0 END), 0), 2) AS credit,
      ROUND(COALESCE(SUM(balance), 0), 2) AS total
    FROM accounts
  `);

  return {
    month: anchor, windowStart, windowEnd,
    monthlySpend, yoySpend, categorySpend, categoryMonthly,
    anomalies, cashFlow, cashFlowDaily, coverage, investmentAccounts,
    netWorth: netWorth ?? null,
  };
}

function resolveWindow(
  month: string, before: number, after: number,
  dataMin: string | null | undefined, dataMax: string | null | undefined,
): { windowStart: string; windowEnd: string } {
  let start = shiftYM(month, -before);
  let end = shiftYM(month, after);
  if (dataMax && diffYM(end, dataMax) > 0) {
    const overshoot = diffYM(end, dataMax);
    start = shiftYM(start, -overshoot);
    end = dataMax;
  }
  if (dataMin && diffYM(start, dataMin) < 0) {
    const undershoot = -diffYM(start, dataMin);
    end = shiftYM(end, undershoot);
    start = dataMin;
  }
  if (dataMax && diffYM(end, dataMax) > 0) end = dataMax;
  return { windowStart: start, windowEnd: end };
}

function shiftYM(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function diffYM(a: string, b: string): number {
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  return (ay - by) * 12 + (am - bm);
}
