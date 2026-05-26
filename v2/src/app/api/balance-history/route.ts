import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";

// Historical balance per account, walked backwards from the current balance.
// For each date with activity: balance_at_eod = current_balance - SUM(amount of txns after date).
// We pick one row per (account, date) so the chart sees clean daily snapshots.
export async function GET() {
  const accounts = await db.all<{ account_id: string; org_name: string; name: string; account_type: string; balance: number; balance_date: string }>(sql`
    SELECT account_id, org_name, name, account_type, balance, balance_date FROM accounts
  `);

  // Distinct (account, date) pairs that have any activity.
  const points = await db.all<{ account_id: string; date: string; daily_change: number }>(sql`
    SELECT account_id, date, ROUND(SUM(amount), 2) as daily_change
    FROM transactions
    GROUP BY account_id, date
    ORDER BY account_id, date
  `);

  // Group activity by account.
  const byAcct = new Map<string, { date: string; dailyChange: number }[]>();
  for (const p of points) {
    const list = byAcct.get(p.account_id) ?? [];
    list.push({ date: p.date, dailyChange: p.daily_change });
    byAcct.set(p.account_id, list);
  }

  // Walk backwards from current balance to produce end-of-day balance per date.
  // SimpleFIN convention: positive amount = money IN, negative = OUT. So eod(d) =
  // eod(d+1) - dailyChange(d+1). We're walking from latest -> earliest, so:
  //   balance_after_day = current_balance (for dates >= balance_date)
  //   balance_after_day(d) = balance_after_day(d+1) - dailyChange of day d+1
  const result = accounts.map((a) => {
    const activity = byAcct.get(a.account_id) ?? [];
    const series: { date: string; balance: number }[] = [];
    let running = a.balance;
    // Iterate from newest to oldest, recording running balance *after* each day's activity.
    for (let i = activity.length - 1; i >= 0; i--) {
      series.push({ date: activity[i].date, balance: Number(running.toFixed(2)) });
      running -= activity[i].dailyChange;
    }
    // We have a "starting" balance before the earliest activity too.
    if (activity.length > 0) {
      const firstDate = activity[0].date;
      const dayBefore = new Date(firstDate);
      dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
      series.push({ date: dayBefore.toISOString().slice(0, 10), balance: Number(running.toFixed(2)) });
    }
    series.reverse();
    return {
      accountId: a.account_id,
      orgName: a.org_name,
      name: a.name,
      accountType: a.account_type,
      currentBalance: a.balance,
      series,
    };
  });

  return NextResponse.json({ accounts: result });
}
