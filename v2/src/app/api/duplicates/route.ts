import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";

// One-off triage endpoint for finding and resolving duplicate transactions.
//   GET     — returns groups of suspected duplicates (within-account + cross-account
//             matches between the Capital One placeholder and the real Venture X).
//             Groups dismissed via POST are filtered out.
//   POST    — { key } — mark a group's key as legitimate so it stops showing up.
//             Persisted to a `duplicate_dismissals` table.
//   DELETE  — { transactionId } — removes the transaction (plus its paycheck_splits
//             and raw_transactions rows so no FK leaks).

// Lazy-create the dismissals table — keeps the feature self-contained without
// requiring a drizzle migration for a one-off triage tool.
function ensureDismissalsTable() {
  db.run(sql`CREATE TABLE IF NOT EXISTS duplicate_dismissals (
    key TEXT PRIMARY KEY,
    dismissed_at TEXT DEFAULT (datetime('now'))
  )`);
}

interface DupeTxn {
  transactionId: string;
  accountId: string;
  accountName: string | null;
  date: string;
  amount: number;
  description: string | null;
  payee: string | null;
  category: string | null;
  source: string | null;
  // Posted timestamp from the raw payload. SimpleFIN payloads have a real epoch second
  // value (e.g., 1716057600 = May 18 14:40:00 UTC). CSV-sourced rows set this to noon
  // UTC of the posting date (no time info in the CSV), so identical noon timestamps
  // across two CSV rows are not informative.
  postedAt: number | null;
  transactedAt: number | null;
}
interface DupeGroup {
  key: string;
  kind: "within-account" | "cross-account";
  date: string;
  amount: number;
  transactions: DupeTxn[];
  confidence: number; // 0..1 — how confident we are this is a real duplicate
  reason: string;     // short human label for the confidence call
}

// Score how likely a group is a real duplicate vs legitimate same-day events.
// Signals (strongest first):
//   1. Shared bank/merchant reference numbers (4+ digit ID sequences). If both rows
//      reference the same ID, they're almost certainly the same transaction in
//      different export formats.
//   2. Identical descriptions (after stripping whitespace/punctuation).
//   3. One description fully contains the other (e.g. CSV vs SimpleFIN re-export).
//   4. Different reference numbers → very likely legitimate separate events.
//   5. Vendor patterns that commonly fire multiple times per day (Uber, Lyft Bike,
//      OpenAI, MBTA station tap-ins) drop confidence.
function scoreGroup(txns: DupeTxn[]): { confidence: number; reason: string } {
  if (txns.length < 2) return { confidence: 0, reason: "single row" };
  const descs = txns.map((t) => (t.description ?? t.payee ?? "").trim());
  const norms = descs.map((d) => d.toLowerCase().replace(/[^a-z0-9]/g, ""));

  // Strongest negative signal: transacted_at differs across rows. Banks only give us
  // date precision, but if Chase says one was initiated on the 16th and another on
  // the 18th, they are unambiguously different events.
  const txDates = new Set(txns.map((t) => t.transactedAt ?? 0));
  if (txDates.size > 1 && ![...txDates].includes(0)) {
    return { confidence: 0.05, reason: "transacted_at differs across rows — definitely separate events" };
  }

  // 1. Shared reference number → very high.
  const refs = descs.map((d) => new Set((d.match(/\d{4,}/g) ?? [])));
  const intersect = [...refs[0]].filter((r) => refs.slice(1).every((s) => s.has(r)));
  if (intersect.length > 0) {
    return { confidence: 0.95, reason: `shared ref #${intersect[0]} (likely same txn, two export formats)` };
  }
  // Both have refs but none in common → likely separate events.
  if (refs.every((s) => s.size > 0) && intersect.length === 0) {
    return { confidence: 0.15, reason: "different reference numbers — likely separate" };
  }

  // 2. Identical normalized descriptions.
  if (norms.every((n) => n === norms[0]) && norms[0].length > 3) {
    // Suspicious if vendor is one that commonly happens twice a day, lower confidence
    const vendorLike = /uber|lyft|mbta|bluebik|openai|amazon|spotify|chipotle|google|doordash|starbucks|venmo/i;
    if (vendorLike.test(descs[0])) {
      return { confidence: 0.45, reason: "identical desc, but common multi-event vendor" };
    }
    return { confidence: 0.85, reason: "identical descriptions" };
  }

  // 3. One description fully contains the other (export format variant).
  const sorted = [...norms].sort((a, b) => a.length - b.length);
  if (sorted[0].length >= 12 && sorted[sorted.length - 1].includes(sorted[0])) {
    return { confidence: 0.75, reason: "one description contains the other" };
  }

  // 4. Default: mid confidence; flag for manual review.
  return { confidence: 0.4, reason: "ambiguous — review manually" };
}

export async function GET() {
  ensureDismissalsTable();
  const dismissed = new Set<string>(
    (await db.all<{ key: string }>(sql`SELECT key FROM duplicate_dismissals`)).map((r) => r.key),
  );

  // 1. Within-account exact duplicates: same account, same date, same amount.
  const within = await db.all<DupeTxn & { dup_key: string }>(sql`
    WITH latest_raw AS (
      SELECT rt.transaction_id, rt.source, rt.payload_json
      FROM raw_transactions rt
      JOIN (
        SELECT transaction_id, MAX(fetched_at) AS m FROM raw_transactions GROUP BY transaction_id
      ) mx ON mx.transaction_id = rt.transaction_id AND mx.m = rt.fetched_at
    ),
    dupes AS (
      SELECT account_id, date, amount FROM transactions
      GROUP BY account_id, date, amount HAVING COUNT(*) > 1
    )
    SELECT t.transaction_id AS transactionId, t.account_id AS accountId, a.name AS accountName,
      t.date, t.amount, t.description, t.payee, t.category,
      lr.source AS source,
      json_extract(lr.payload_json, '$.posted') AS postedAt,
      json_extract(lr.payload_json, '$.transacted_at') AS transactedAt,
      (t.account_id || '|' || t.date || '|' || t.amount) AS dup_key
    FROM dupes d
    JOIN transactions t ON t.account_id=d.account_id AND t.date=d.date AND t.amount=d.amount
    JOIN accounts a ON a.account_id=t.account_id
    LEFT JOIN latest_raw lr ON lr.transaction_id = t.transaction_id
    ORDER BY ABS(t.amount) DESC, t.date DESC, t.transaction_id
  `);
  const groupMap = new Map<string, DupeGroup>();
  for (const r of within) {
    let g = groupMap.get(r.dup_key);
    if (!g) {
      g = { key: `within:${r.dup_key}`, kind: "within-account", date: r.date, amount: r.amount, transactions: [], confidence: 0, reason: "" };
      groupMap.set(r.dup_key, g);
    }
    g.transactions.push({
      transactionId: r.transactionId, accountId: r.accountId, accountName: r.accountName,
      date: r.date, amount: r.amount, description: r.description, payee: r.payee,
      category: r.category, source: r.source,
      postedAt: r.postedAt, transactedAt: r.transactedAt,
    });
  }
  for (const g of groupMap.values()) {
    const s = scoreGroup(g.transactions);
    g.confidence = s.confidence;
    g.reason = s.reason;
  }
  const withinGroups = [...groupMap.values()].filter((g) => !dismissed.has(g.key));

  // 2. Cross-account matches between Cap One historical placeholder and Venture X 3709
  //    (the SimpleFIN backfill overlapped with the v1 CSV import).
  const cross = await db.all<DupeTxn>(sql`
    WITH latest_raw AS (
      SELECT rt.transaction_id, rt.source, rt.payload_json
      FROM raw_transactions rt
      JOIN (
        SELECT transaction_id, MAX(fetched_at) AS m FROM raw_transactions GROUP BY transaction_id
      ) mx ON mx.transaction_id = rt.transaction_id AND mx.m = rt.fetched_at
    )
    SELECT t.transaction_id AS transactionId, t.account_id AS accountId, a.name AS accountName,
      t.date, t.amount, t.description, t.payee, t.category,
      lr.source AS source,
      json_extract(lr.payload_json, '$.posted') AS postedAt,
      json_extract(lr.payload_json, '$.transacted_at') AS transactedAt
    FROM transactions t
    JOIN accounts a ON a.account_id=t.account_id
    LEFT JOIN latest_raw lr ON lr.transaction_id = t.transaction_id
    WHERE t.account_id IN ('placeholder:venturex', (SELECT account_id FROM accounts WHERE name LIKE '%Venture X (3709)%'))
      AND EXISTS (
        SELECT 1 FROM transactions t2
        WHERE t2.date = t.date AND ABS(t2.amount - t.amount) < 0.01 AND t2.account_id != t.account_id
          AND t2.account_id IN ('placeholder:venturex', (SELECT account_id FROM accounts WHERE name LIKE '%Venture X (3709)%'))
      )
    ORDER BY t.date DESC, ABS(t.amount) DESC, t.account_id
  `);
  const crossMap = new Map<string, DupeGroup>();
  for (const r of cross) {
    const k = `${r.date}|${r.amount}`;
    let g = crossMap.get(k);
    if (!g) {
      g = { key: `cross:${k}`, kind: "cross-account", date: r.date, amount: r.amount, transactions: [], confidence: 0, reason: "" };
      crossMap.set(k, g);
    }
    g.transactions.push(r);
  }
  for (const g of crossMap.values()) {
    const s = scoreGroup(g.transactions);
    g.confidence = s.confidence;
    g.reason = s.reason;
  }
  const crossGroups = [...crossMap.values()].filter((g) => g.transactions.length > 1 && !dismissed.has(g.key));

  // Sort high-confidence (most likely true duplicates) first so the user can
  // burn through the easy wins, then descend into ambiguous ones.
  const all = [...withinGroups, ...crossGroups].sort((a, b) => b.confidence - a.confidence);
  return NextResponse.json({
    groups: all,
    counts: { within: withinGroups.length, cross: crossGroups.length },
  });
}

export async function POST(req: Request) {
  ensureDismissalsTable();
  const { key } = (await req.json()) as { key: string };
  if (!key) return NextResponse.json({ error: "key required" }, { status: 400 });
  await db.run(sql`INSERT OR IGNORE INTO duplicate_dismissals (key) VALUES (${key})`);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const { transactionId } = (await req.json()) as { transactionId: string };
  if (!transactionId) return NextResponse.json({ error: "transactionId required" }, { status: 400 });
  // Splits first (FK), then transaction, then raw rows.
  await db.delete(schema.paycheckSplits).where(eq(schema.paycheckSplits.transactionId, transactionId));
  await db.delete(schema.transactions).where(eq(schema.transactions.transactionId, transactionId));
  await db.delete(schema.rawTransactions).where(eq(schema.rawTransactions.transactionId, transactionId));
  return NextResponse.json({ ok: true });
}
