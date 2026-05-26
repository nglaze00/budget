import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";

// GET /api/transactions
//   ?limit=N            — most recent N transactions (default 100)
//   ?month=YYYY-MM      — filter to one calendar month
//   ?category=Foo       — filter to one category
//   ?spendOnly=1        — only flow_type='spend' rows
//   ?positiveOnly=1     — only rows with amount > 0 (inflows)
//   ?accountId=ACT-...  — restrict to a specific account
//   ?start=YYYY-MM-DD   — inclusive lower bound on date
//   ?end=YYYY-MM-DD     — inclusive upper bound on date
// Includes joined account info so the caller (e.g. dashboard drilldown) can show which
// card a charge hit without a second roundtrip.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const limit = Number(searchParams.get("limit") ?? 100);
  const month = searchParams.get("month");
  const category = searchParams.get("category");
  const spendOnly = searchParams.get("spendOnly") === "1";
  const positiveOnly = searchParams.get("positiveOnly") === "1";
  const accountId = searchParams.get("accountId");
  const start = searchParams.get("start");
  const end = searchParams.get("end");

  const where = [];
  if (month) where.push(sql`strftime('%Y-%m', t.date) = ${month}`);
  if (category) where.push(sql`t.category = ${category}`);
  if (spendOnly) where.push(sql`t.flow_type = 'spend'`);
  if (positiveOnly) where.push(sql`t.amount > 0`);
  if (accountId) where.push(sql`t.account_id = ${accountId}`);
  if (start) where.push(sql`t.date >= ${start}`);
  if (end) where.push(sql`t.date <= ${end}`);
  const whereSql = where.length > 0 ? sql`WHERE ${sql.join(where, sql` AND `)}` : sql``;

  const rows = await db.all<{
    transactionId: string;
    date: string;
    amount: number;
    description: string | null;
    payee: string | null;
    category: string | null;
    categorySource: string | null;
    flowType: string | null;
    accountName: string | null;
    accountOrgName: string | null;
    accountType: string | null;
  }>(sql`
    SELECT t.transaction_id AS transactionId, t.date, t.amount, t.description, t.payee,
           t.category, t.category_source AS categorySource, t.flow_type AS flowType,
           a.name AS accountName, a.org_name AS accountOrgName, a.account_type AS accountType
    FROM transactions t
    LEFT JOIN accounts a ON a.account_id = t.account_id
    ${whereSql}
    ORDER BY t.date DESC, ABS(t.amount) DESC
    LIMIT ${limit}
  `);
  return NextResponse.json({ transactions: rows });
}
