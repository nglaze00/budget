import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";

export async function GET() {
  const categories = await db.query.categories.findMany();
  return NextResponse.json({ categories });
}

// Manual override for a single transaction. category_source='user' protects it
// from re-classification AND from showing up in the review queue again. We also
// clear the confidence flag so the row isn't re-surfaced by the review query.
export async function PATCH(req: Request) {
  const { transactionId, category } = await req.json();
  await db
    .update(schema.transactions)
    .set({ category, categorySource: "user", categoryConfidence: "completely_sure" })
    .where(eq(schema.transactions.transactionId, transactionId));
  return NextResponse.json({ ok: true });
}
