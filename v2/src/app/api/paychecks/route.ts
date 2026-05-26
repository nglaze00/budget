import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";

export async function GET() {
  const paychecks = await db.query.transactions.findMany({
    where: eq(schema.transactions.isPaycheck, 1),
    orderBy: [desc(schema.transactions.date)],
  });
  const splits = await db.query.paycheckSplits.findMany();
  const splitsByTx = new Map<string, typeof splits>();
  for (const s of splits) {
    const list = splitsByTx.get(s.transactionId) ?? [];
    list.push(s);
    splitsByTx.set(s.transactionId, list);
  }
  return NextResponse.json({
    paychecks: paychecks.map((p) => ({ ...p, splits: splitsByTx.get(p.transactionId) ?? [] })),
  });
}

// POST { transactionId, regular, bonus, note? } — replaces any existing splits with user-locked ones.
export async function POST(req: Request) {
  const { transactionId, regular, bonus, note } = await req.json();
  await db.delete(schema.paycheckSplits).where(eq(schema.paycheckSplits.transactionId, transactionId));
  await db.insert(schema.paycheckSplits).values([
    { transactionId, portion: "regular", amount: Number(regular), source: "user", note: note ?? null },
    { transactionId, portion: "bonus", amount: Number(bonus), source: "user", note: note ?? null },
  ]);
  return NextResponse.json({ ok: true });
}
