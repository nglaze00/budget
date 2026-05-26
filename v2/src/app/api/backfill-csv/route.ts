import { NextResponse } from "next/server";
import { backfillFromV1Csv } from "@/lib/csv-backfill";
import { categorizeUncategorized } from "@/lib/categorize";

// One-time historical backfill from the v1 transactions.csv. Idempotent — re-running
// is safe because raw_transactions uses (transaction_id, fetched_at) as the key and
// replay picks the latest row per transaction_id. After running once successfully,
// you shouldn't need to run it again.
export async function POST() {
  const result = await backfillFromV1Csv();
  const cat = await categorizeUncategorized();
  return NextResponse.json({ ...result, categorized: cat.categorized });
}
