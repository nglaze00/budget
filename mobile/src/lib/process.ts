import { desc, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { classify } from "./classify";

// Ported from the desktop app (src/lib/process.ts). Identical logic; the only
// difference is the underlying Drizzle driver (expo-sqlite vs better-sqlite3).

interface SfTxn {
  id: string;
  posted: number;
  transacted_at?: number;
  amount: string;
  description?: string;
  payee?: string;
  memo?: string;
  pending?: boolean;
}

function isoDate(epochSeconds: number) {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

function effectiveDate(payload: SfTxn): string | null {
  if (payload.posted && payload.posted > 0) return isoDate(payload.posted);
  if (payload.transacted_at && payload.transacted_at > 0) return isoDate(payload.transacted_at);
  return null;
}

function deriveFromSimplefinPayload(payload: SfTxn, accountId: string, accountType: string | null) {
  const date = effectiveDate(payload);
  if (!date) return null;
  const amount = Number(payload.amount);
  const { flowType, isPaycheck } = classify({
    accountType,
    amount,
    description: payload.description ?? null,
    payee: payload.payee ?? null,
  });
  return {
    transactionId: payload.id,
    accountId,
    date,
    amount,
    description: payload.description ?? null,
    payee: payload.payee ?? null,
    memo: payload.memo ?? null,
    pending: payload.pending ? 1 : 0,
    flowType,
    isPaycheck: isPaycheck ? 1 : 0,
  };
}

export async function replayFromRaw() {
  const latest = await db.all<{
    transaction_id: string;
    account_id: string;
    source: string;
    payload_json: string;
  }>(sql`
    SELECT r.transaction_id, r.account_id, r.source, r.payload_json
    FROM raw_transactions r
    JOIN (
      SELECT transaction_id, MAX(fetched_at) AS max_at
      FROM raw_transactions
      GROUP BY transaction_id
    ) m ON m.transaction_id = r.transaction_id AND m.max_at = r.fetched_at
  `);

  const accountTypes = new Map<string, string | null>();
  for (const a of await db.query.accounts.findMany()) {
    accountTypes.set(a.accountId, a.accountType);
  }

  let processed = 0;
  for (const row of latest) {
    if (row.source !== "simplefin" && row.source !== "csv_v1" && row.source !== "csv_backfill" && row.source !== "csv_direct") continue;
    if (accountTypes.get(row.account_id) === "investment") continue;
    const payload = JSON.parse(row.payload_json) as SfTxn;
    const derived = deriveFromSimplefinPayload(payload, row.account_id, accountTypes.get(row.account_id) ?? null);
    if (!derived) continue;

    const existing = await db.query.transactions.findFirst({
      where: eq(schema.transactions.transactionId, derived.transactionId),
    });

    const set =
      existing?.category != null || existing?.categorySource === "user"
        ? {
            ...derived,
            category: existing.category,
            categorySource: existing.categorySource,
            categoryConfidence: existing.categoryConfidence,
            categoryAlternatives: existing.categoryAlternatives,
            userNote: existing.userNote,
          }
        : { ...derived, userNote: existing?.userNote ?? null };

    if (existing) {
      await db.update(schema.transactions).set(set).where(eq(schema.transactions.transactionId, derived.transactionId));
    } else {
      await db.insert(schema.transactions).values(set);
    }
    processed++;
  }

  return { processed };
}

export async function appendRaw(source: string, items: { transactionId: string; accountId: string; payload: unknown }[]) {
  if (items.length === 0) return;
  await db.insert(schema.rawTransactions).values(
    items.map((i) => ({
      transactionId: i.transactionId,
      source,
      accountId: i.accountId,
      payloadJson: JSON.stringify(i.payload),
    })),
  );
}

export async function rawStats() {
  const total = await db.all<{ n: number }>(sql`SELECT COUNT(*) as n FROM raw_transactions`);
  const distinct = await db.all<{ n: number }>(sql`SELECT COUNT(DISTINCT transaction_id) as n FROM raw_transactions`);
  return { total: total[0]?.n ?? 0, distinct: distinct[0]?.n ?? 0 };
}

export { desc };
