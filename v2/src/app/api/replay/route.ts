import { NextResponse } from "next/server";
import { replayFromRaw, rawStats } from "@/lib/process";
import { categorizeUncategorized, resetLlmCategories } from "@/lib/categorize";
import { autoSplitPaychecks } from "@/lib/paychecks";

// Rebuild the processed layer from raw_transactions. Useful after changing classify.ts,
// the categorize prompt, or the paycheck split heuristic. User-set fields are preserved.
//
// POST ?recategorize=1 -> also wipe LLM-assigned categories so they get redone.
export async function POST(req: Request) {
  const { searchParams } = new URL(req.url);
  if (searchParams.get("recategorize") === "1") {
    await resetLlmCategories();
  }
  const stats = await rawStats();
  const { processed } = await replayFromRaw();
  const cat = await categorizeUncategorized();
  const splits = await autoSplitPaychecks();
  return NextResponse.json({
    raw: stats,
    processed,
    categorized: cat.categorized,
    paychecks_split: splits.computed,
  });
}
