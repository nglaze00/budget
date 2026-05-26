import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";

// Daily reconstructed Chase balance, anchored to the live balance.
//
// Caveat we already know about: lifetime SUM(amount) on Chase is ~$128k while the
// real balance is ~$5k, so walking backward forces the earliest date to ~−$120k.
// We're showing it anyway per user request — the right edge is honest (matches the
// live balance) and the brush lets the user focus on recent months where the
// reconstruction is meaningful.
export async function GET() {
  const account = await db.get<{ account_id: string; name: string; org_name: string; balance: number }>(sql`
    SELECT account_id, name, org_name, balance FROM accounts
    WHERE account_type = 'depository' AND org_name LIKE '%Chase%'
    ORDER BY balance DESC LIMIT 1
  `);
  if (!account) return NextResponse.json({ account: null, series: [] });

  // `flagged_inflow` = sum of "shouldn't-be-relying-on-this" inflows for the day:
  //   - any inflow categorized as Investments (selling stocks / brokerage transfers in)
  //   - any Zelle inflow ≥ $1,000 (treated as a one-off boost, not normal income)
  // The chart paints any segment ending on a day with a positive flagged_inflow red,
  // so the user can visually spot dependencies on these one-shot boosts.
  const daily = await db.all<{ date: string; net: number; in_total: number; out_total: number; flagged_inflow: number }>(sql`
    SELECT
      date,
      ROUND(SUM(amount), 2) AS net,
      ROUND(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 2) AS in_total,
      ROUND(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 2) AS out_total,
      ROUND(SUM(CASE
        WHEN amount > 0 AND category = 'Investments' THEN amount
        WHEN amount >= 1000 AND (description LIKE '%Zelle%' OR description LIKE '%ZELLE%') THEN amount
        ELSE 0
      END), 2) AS flagged_inflow
    FROM transactions
    WHERE account_id = ${account.account_id}
    GROUP BY date
    ORDER BY date
  `);

  // Walk newest → oldest, recording end-of-day balance.
  const points: { date: string; balance: number; net: number; in_total: number; out_total: number; flagged_inflow: number }[] = [];
  let running = account.balance;
  for (let i = daily.length - 1; i >= 0; i--) {
    points.push({
      date: daily[i].date,
      balance: Number(running.toFixed(2)),
      net: daily[i].net,
      in_total: daily[i].in_total,
      out_total: daily[i].out_total,
      flagged_inflow: daily[i].flagged_inflow,
    });
    running -= daily[i].net;
  }
  points.reverse();

  return NextResponse.json({
    account: { accountId: account.account_id, name: account.name, orgName: account.org_name, balance: account.balance },
    series: points,
  });
}
