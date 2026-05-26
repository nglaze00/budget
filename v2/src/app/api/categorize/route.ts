import { NextResponse } from "next/server";
import { categorizeUncategorized, resetLlmCategories } from "@/lib/categorize";

// POST  -> categorize anything without a category
// POST?reset=1 -> wipe LLM-assigned categories first, then categorize
export async function POST(req: Request) {
  const { searchParams } = new URL(req.url);
  try {
    if (searchParams.get("reset") === "1") {
      await resetLlmCategories();
    }
    const result = await categorizeUncategorized();
    return NextResponse.json(result);
  } catch (err) {
    console.error("[/api/categorize] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
