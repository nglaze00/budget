import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";

export async function GET() {
  const state = await db.query.syncState.findFirst();
  const connection = await db.query.connection.findFirst();
  const categoryCount = await db.all<{ n: number }>(sql`
    SELECT COUNT(*) as n FROM transactions
    WHERE category_confidence IN ('unsure', 'somewhat_sure')
      AND (category_source IS NULL OR category_source != 'user')
  `);
  const paycheckCount = await db.all<{ n: number }>(sql`
    SELECT COUNT(*) as n FROM transactions t
    WHERE t.is_paycheck = 1
      AND EXISTS (SELECT 1 FROM paycheck_splits s WHERE s.transaction_id = t.transaction_id)
      AND NOT EXISTS (SELECT 1 FROM paycheck_splits s WHERE s.transaction_id = t.transaction_id AND s.source = 'user')
  `);
  const reviewCount = (categoryCount[0]?.n ?? 0) + (paycheckCount[0]?.n ?? 0);
  return NextResponse.json({
    connected: !!connection,
    lastSyncedAt: state?.lastSyncedAt ?? null,
    reviewCount,
  });
}
