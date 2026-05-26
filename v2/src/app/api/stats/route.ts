import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";

// SimpleFIN sign convention: positive = money in, negative = money out.
// `month` query param (YYYY-MM) anchors the dashboard.
//
// Trend window: a 5-month band centered on the anchor (2 before, 2 after by default).
// If part of that band lies outside the available data range, the window slides — e.g.
// looking at the most recent month shows 4 behind + that month. We compute the window
// server-side so client logic stays simple.
//
// Aggregation choice: we use the MEDIAN of monthly spend, not the mean. Median is more
// robust to one-off big months (annual subscriptions, vacations). For anomaly detection
// we compare each transaction to the per-category median transaction size.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const before = Number(searchParams.get("before") ?? 2);
  const after = Number(searchParams.get("after") ?? 2);
  const today = new Date().toISOString().slice(0, 7);
  const month = searchParams.get("month") ?? today;

  // Resolve the trend window — slide it to fit the data range, but never exceed
  // before+after+1 months total.
  const range = await db.get<{ min_month: string | null; max_month: string | null }>(sql`
    SELECT
      strftime('%Y-%m', MIN(date)) AS min_month,
      strftime('%Y-%m', MAX(date)) AS max_month
    FROM transactions WHERE flow_type = 'spend'
  `);
  const { windowStart, windowEnd } = resolveWindow(month, before, after, range?.min_month, range?.max_month);
  const windowStartDate = `${windowStart}-01`;
  const windowEndDate = `${windowEnd}-01`;

  // 1. Per-month spend, income, and net across the resolved window. Zero-filled so a
  //    quiet month still has a row. `net` is income − spend, matching what the user
  //    actually saved (or burned) in that month.
  //
  //    Both spend and income are filtered to exclude the same "non-spending" categories
  //    the category breakdown excludes — Credit card payments and Investments. Those
  //    aren't real spend/income; they're internal movements between the user's own
  //    accounts. The DB has some of these tagged with flow_type='spend' / 'earn' due
  //    to historical misclassification, so the category filter is what actually keeps
  //    the numbers honest and the trend bar in sync with the category breakdown sum.
  //    Uncategorized transactions are excluded too so this total always matches the
  //    sum of visible category bars.
  const monthlySpend = await db.all<{ month: string; total: number; income: number; net: number }>(sql`
    WITH RECURSIVE months(m) AS (
      SELECT date(${windowStartDate})
      UNION ALL
      SELECT date(m, '+1 month') FROM months WHERE m < date(${windowEndDate})
    )
    SELECT
      strftime('%Y-%m', months.m) AS month,
      ROUND(COALESCE((
        SELECT SUM(ABS(amount)) FROM transactions
        WHERE flow_type = 'spend'
          AND category IS NOT NULL
          AND category != 'Credit card payments'
          AND strftime('%Y-%m', date) = strftime('%Y-%m', months.m)
      ), 0), 2) AS total,
      ROUND(COALESCE((
        SELECT SUM(amount) FROM transactions
        WHERE flow_type = 'earn'
          AND category IS NOT NULL
          AND category != 'Credit card payments'
          AND strftime('%Y-%m', date) = strftime('%Y-%m', months.m)
      ), 0), 2) AS income,
      ROUND(
        COALESCE((
          SELECT SUM(amount) FROM transactions
          WHERE flow_type = 'earn'
            AND category IS NOT NULL
            AND category != 'Credit card payments'
            AND strftime('%Y-%m', date) = strftime('%Y-%m', months.m)
        ), 0)
        - COALESCE((
          SELECT SUM(ABS(amount)) FROM transactions
          WHERE flow_type = 'spend'
            AND category IS NOT NULL
            AND category != 'Credit card payments'
            AND strftime('%Y-%m', date) = strftime('%Y-%m', months.m)
        ), 0)
      , 2) AS net
    FROM months
    ORDER BY month
  `);

  // 2. Same month in prior years (year-over-year comparison). Same category filter as
  //    the monthly trend so the YoY number reconciles with the bar height.
  const anchorMonthNum = Number(month.slice(5, 7));
  const yoySpend = await db.all<{ year: string; total: number }>(sql`
    SELECT strftime('%Y', date) as year, ROUND(SUM(ABS(amount)), 2) as total
    FROM transactions
    WHERE CAST(strftime('%m', date) AS INTEGER) = ${anchorMonthNum}
      AND flow_type = 'spend'
      AND category IS NOT NULL
      AND category != 'Credit card payments'
    GROUP BY year
    ORDER BY year
  `);

  // 3. Spending by category — current-month total + txn count.
  //    Per-category median across the window comes from `categoryMonthly` below.
  const categorySpend = await db.all<{ category: string; current_month: number; txn_count: number }>(sql`
    SELECT
      category,
      ROUND(SUM(ABS(amount)), 2) as current_month,
      COUNT(*) as txn_count
    FROM transactions
    WHERE flow_type = 'spend'
      AND category IS NOT NULL
      AND category != 'Credit card payments'
      AND strftime('%Y-%m', date) = ${month}
    GROUP BY category
  `);

  // 3b. Per-(category, month) totals across a fixed 12-month trailing window ending at
  //     the anchor month, zero-filled. We use a 12-month window (rather than the same
  //     5-month window that powers the trend chart) so the per-category median has
  //     enough history to be stable and isn't whipsawed by short-term spikes.
  const cat12Start = `${shiftYM(month, -11)}-01`;
  const cat12End = `${month}-01`;
  const categoryMonthly = await db.all<{ category: string; month: string; total: number }>(sql`
    WITH RECURSIVE months(m) AS (
      SELECT date(${cat12Start})
      UNION ALL
      SELECT date(m, '+1 month') FROM months WHERE m < date(${cat12End})
    ),
    active_cats AS (
      SELECT DISTINCT category FROM transactions
      WHERE flow_type = 'spend' AND category IS NOT NULL
        AND category != 'Credit card payments'
        AND date >= date(${cat12Start})
        AND date < date(${cat12End}, '+1 month')
    )
    SELECT
      c.category,
      strftime('%Y-%m', m.m) as month,
      ROUND(COALESCE(SUM(ABS(t.amount)), 0), 2) as total
    FROM active_cats c
    CROSS JOIN months m
    LEFT JOIN transactions t
      ON t.category = c.category
      AND t.flow_type = 'spend'
      AND strftime('%Y-%m', t.date) = strftime('%Y-%m', m.m)
    GROUP BY c.category, m.m
    ORDER BY c.category, m.m
  `);

  // 4. Anomalies: transactions in the anchor month that sit at the top of the
  //    distribution for their category. Each transaction is compared against the 90th
  //    percentile of that category's transactions over the trailing 12 months — so
  //    "unusually large for this category" is judged against the actual right tail.
  //
  //    Filters:
  //      - need ≥ 20 historical transactions in the category for the percentile to be
  //        meaningful
  //      - amount ≥ category 90th percentile (top ~10%)
  //      - amount ≥ $50 (don't surface trivial-dollar outliers in tiny categories)
  //
  //    SQLite percentile via window-function trick: rank rows by amount, take the
  //    smallest amount whose rank is ≥ ceil(cnt * 0.90).
  const anomalies = await db.all<{ transaction_id: string; date: string; description: string; payee: string; amount: number; category: string; category_p90: number; category_median: number; category_count: number }>(sql`
    WITH cat_txns AS (
      SELECT
        category,
        ABS(amount) AS amt,
        ROW_NUMBER() OVER (PARTITION BY category ORDER BY ABS(amount)) AS rn,
        COUNT(*) OVER (PARTITION BY category) AS cnt
      FROM transactions
      WHERE flow_type = 'spend'
        AND category IS NOT NULL
        AND category != 'Credit card payments'
        AND date >= date(${windowEndDate}, '-12 month')
        AND date < date(${windowEndDate}, '+1 month')
    ),
    cat_stats AS (
      SELECT
        category,
        MIN(CASE WHEN rn * 100 >= cnt * 90 THEN amt END) AS p90,
        MAX(CASE WHEN rn IN ((cnt + 1) / 2, (cnt + 2) / 2) THEN amt END) AS med,
        MAX(cnt) AS cnt
      FROM cat_txns
      GROUP BY category
      HAVING MAX(cnt) >= 20
    )
    SELECT
      t.transaction_id,
      t.date,
      COALESCE(t.description, '') AS description,
      COALESCE(t.payee, '') AS payee,
      ABS(t.amount) AS amount,
      t.category,
      cs.p90 AS category_p90,
      cs.med AS category_median,
      cs.cnt AS category_count
    FROM transactions t
    JOIN cat_stats cs ON cs.category = t.category
    WHERE t.flow_type = 'spend'
      AND strftime('%Y-%m', t.date) = ${month}
      AND ABS(t.amount) > cs.p90
      AND ABS(t.amount) >= 50
    ORDER BY ABS(t.amount) / cs.p90 DESC
    LIMIT 10
  `);

  // 5. Cash flow totals for the anchor month — scoped to the Chase debit account.
  const cashFlow = await db.all<{ direction: string; total: number }>(sql`
    SELECT
      CASE WHEN t.amount > 0 THEN 'in' ELSE 'out' END as direction,
      ROUND(SUM(ABS(t.amount)), 2) as total
    FROM transactions t
    JOIN accounts a ON a.account_id = t.account_id
    WHERE strftime('%Y-%m', t.date) = ${month}
      AND a.account_type = 'depository'
      AND a.org_name LIKE '%Chase%'
    GROUP BY direction
  `);

  // 5b. Daily net cash flow on the Chase debit account — drives the in-month chart.
  const cashFlowDaily = await db.all<{ date: string; net: number; in_total: number; out_total: number }>(sql`
    SELECT
      t.date as date,
      ROUND(SUM(t.amount), 2) as net,
      ROUND(SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END), 2) as in_total,
      ROUND(SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END), 2) as out_total
    FROM transactions t
    JOIN accounts a ON a.account_id = t.account_id
    WHERE strftime('%Y-%m', t.date) = ${month}
      AND a.account_type = 'depository'
      AND a.org_name LIKE '%Chase%'
    GROUP BY t.date
    ORDER BY t.date
  `);

  // 6. Per-institution coverage (always recent — independent of the picked month).
  const coverage = await db.all<{ org_name: string; org_domain: string; account_type: string; last_txn_date: string; txn_count: number }>(sql`
    SELECT
      a.org_name,
      a.org_domain,
      a.account_type,
      MAX(t.date) as last_txn_date,
      COUNT(t.transaction_id) as txn_count
    FROM accounts a
    LEFT JOIN transactions t ON t.account_id = a.account_id AND t.date >= date('now', '-30 day')
    GROUP BY a.org_domain, a.account_type
  `);

  // 7. Investments — Fidelity only.
  const investmentAccounts = await db.all<{ account_id: string; name: string; balance: number; balance_date: string; contributions: number }>(sql`
    SELECT
      a.account_id,
      a.name,
      a.balance,
      a.balance_date,
      COALESCE((
        SELECT ROUND(SUM(t.amount), 2)
        FROM transactions t
        WHERE t.account_id = a.account_id
          AND strftime('%Y-%m', t.date) = ${month}
      ), 0) as contributions
    FROM accounts a
    WHERE LOWER(a.org_name) LIKE '%fidelity%'
    ORDER BY a.balance DESC
  `);

  // 8. Net worth — totals across account types. Credit card balances are stored as
  //    negative (debt), so SUM(balance) naturally nets them out.
  const netWorth = await db.get<{ cash: number; investments: number; credit: number; total: number }>(sql`
    SELECT
      ROUND(COALESCE(SUM(CASE WHEN account_type = 'depository' THEN balance ELSE 0 END), 0), 2) AS cash,
      ROUND(COALESCE(SUM(CASE WHEN account_type = 'investment' THEN balance ELSE 0 END), 0), 2) AS investments,
      ROUND(COALESCE(SUM(CASE WHEN account_type = 'credit' THEN balance ELSE 0 END), 0), 2) AS credit,
      ROUND(COALESCE(SUM(balance), 0), 2) AS total
    FROM accounts
  `);

  return NextResponse.json({
    month, windowStart, windowEnd,
    monthlySpend, yoySpend, categorySpend, categoryMonthly,
    anomalies, cashFlow, cashFlowDaily, coverage, investmentAccounts,
    netWorth,
  });
}

// Resolve the trend window. Want [anchor-before, anchor+after]. If that range extends
// past the available data on either side, slide it (preserving total span) until it
// fits — but never grow past dataMin..dataMax.
function resolveWindow(
  month: string,
  before: number,
  after: number,
  dataMin: string | null | undefined,
  dataMax: string | null | undefined,
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
