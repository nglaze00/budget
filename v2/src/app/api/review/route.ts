import { NextResponse } from "next/server";
import { desc, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";

// Everything pending the user's verification:
//   - transactions whose LLM category came back unsure / somewhat_sure AND haven't been
//     user-confirmed yet (categorySource != 'user'). mostly_sure/completely_sure are
//     trusted and don't surface here.
//   - paychecks whose auto-computed split hasn't been confirmed yet (source='auto')
export async function GET() {
  const transactions = await db.all<{
    transactionId: string;
    date: string;
    amount: number;
    description: string | null;
    payee: string | null;
    category: string | null;
    categoryConfidence: string | null;
    categoryAlternatives: string | null;
    accountId: string;
    accountName: string | null;
    accountOrgName: string | null;
    accountType: string | null;
  }>(sql`
    SELECT t.transaction_id AS transactionId, t.date, t.amount, t.description, t.payee,
           t.category, t.category_confidence AS categoryConfidence,
           t.category_alternatives AS categoryAlternatives,
           t.account_id AS accountId,
           a.name AS accountName, a.org_name AS accountOrgName, a.account_type AS accountType
    FROM transactions t
    LEFT JOIN accounts a ON a.account_id = t.account_id
    WHERE t.category_confidence IN ('unsure', 'somewhat_sure')
      AND (t.category_source IS NULL OR t.category_source != 'user')
    ORDER BY t.date DESC
  `);

  const allPaychecks = await db.query.transactions.findMany({
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

  // For each paycheck, attach ±2 neighbours from the same category (sorted by date
  // ascending so "prev" is older and "next" is newer — matches what the user expects
  // when comparing recent paychecks). Use this as context when manually overriding a
  // split: see what regular/bonus looked like just before and after.
  const byCategory = new Map<string, typeof allPaychecks>();
  for (const p of allPaychecks) {
    if (!p.category) continue;
    const list = byCategory.get(p.category) ?? [];
    list.push(p);
    byCategory.set(p.category, list);
  }
  // Sort ascending within each category.
  for (const list of byCategory.values()) {
    list.sort((a, b) => a.date.localeCompare(b.date));
  }

  interface NeighbourTxn { transactionId: string; date: string; amount: number; description: string | null; splits: { portion: string; amount: number; source: string | null }[] }
  function neighboursOf(txId: string, category: string | null): { prev: NeighbourTxn[]; next: NeighbourTxn[] } {
    if (!category) return { prev: [], next: [] };
    const list = byCategory.get(category) ?? [];
    const idx = list.findIndex((p) => p.transactionId === txId);
    if (idx < 0) return { prev: [], next: [] };
    const pick = (p: typeof allPaychecks[number]): NeighbourTxn => ({
      transactionId: p.transactionId,
      date: p.date,
      amount: p.amount,
      description: p.description,
      splits: (splitsByTx.get(p.transactionId) ?? []).map((s) => ({ portion: s.portion, amount: s.amount, source: s.source })),
    });
    return {
      prev: list.slice(Math.max(0, idx - 2), idx).map(pick),
      next: list.slice(idx + 1, idx + 3).map(pick),
    };
  }

  const paychecksToConfirm = allPaychecks
    .map((p) => ({ ...p, splits: splitsByTx.get(p.transactionId) ?? [] }))
    .filter((p) => p.splits.length > 0 && p.splits.every((s) => s.source !== "user"))
    .map((p) => ({ ...p, neighbours: neighboursOf(p.transactionId, p.category) }));

  return NextResponse.json({ transactions, paychecks: paychecksToConfirm });
}
