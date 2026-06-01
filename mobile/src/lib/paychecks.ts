import { and, eq, ne, asc, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db";

// Ported verbatim from the desktop app (src/lib/paychecks.ts).

const WINDOW = 3;
const BONUS_THRESHOLD = 1.1;
const TINY_THRESHOLD = 0.5;

function median(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export async function autoSplitPaychecks() {
  const paycheckCategories = (await db.query.categories.findMany())
    .filter((c) => c.isPaycheckSource === 1)
    .map((c) => c.name);
  if (paycheckCategories.length === 0) return { computed: 0 };

  const paychecks = await db.query.transactions.findMany({
    where: inArray(schema.transactions.category, paycheckCategories),
    orderBy: [asc(schema.transactions.date)],
  });

  const buckets = new Map<string, typeof paychecks>();
  for (const p of paychecks) {
    if (!p.category) continue;
    const list = buckets.get(p.category) ?? [];
    list.push(p);
    buckets.set(p.category, list);
  }

  await db.update(schema.transactions)
    .set({ isPaycheck: 1 })
    .where(inArray(schema.transactions.category, paycheckCategories));
  await db.update(schema.transactions)
    .set({ isPaycheck: 0 })
    .where(sql`(${schema.transactions.category} IS NULL OR ${schema.transactions.category} NOT IN (${sql.join(paycheckCategories.map((c) => sql`${c}`), sql`, `)})) AND ${schema.transactions.isPaycheck} = 1`);

  let computed = 0;

  for (const [, list] of buckets) {
    for (let i = 0; i < list.length; i++) {
      const tx = list[i];

      const existing = await db.query.paycheckSplits.findMany({
        where: eq(schema.paycheckSplits.transactionId, tx.transactionId),
      });
      if (existing.some((s) => s.source === "user")) continue;

      const peers = [
        ...list.slice(Math.max(0, i - WINDOW), i),
        ...list.slice(i + 1, i + 1 + WINDOW),
      ];
      const peerAmounts = peers.map((p) => Math.abs(p.amount));
      const baseline = median(peerAmounts);

      const total = Math.abs(tx.amount);
      let regular = total;
      let bonus = 0;
      if (baseline !== null) {
        if (total < baseline * TINY_THRESHOLD) {
          regular = 0;
          bonus = total;
        } else if (total > baseline * BONUS_THRESHOLD) {
          regular = baseline;
          bonus = total - baseline;
        }
      }

      await db
        .delete(schema.paycheckSplits)
        .where(
          and(
            eq(schema.paycheckSplits.transactionId, tx.transactionId),
            ne(schema.paycheckSplits.source, "user"),
          ),
        );
      await db.insert(schema.paycheckSplits).values([
        { transactionId: tx.transactionId, portion: "regular", amount: regular, source: "auto" },
        { transactionId: tx.transactionId, portion: "bonus", amount: bonus, source: "auto" },
      ]);
      computed++;
    }
  }

  return { computed };
}
