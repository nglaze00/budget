import { and, eq, ne, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { ensureSyncSchema } from "./migrate";
import { replayFromRaw } from "./process";
import { autoSplitPaychecks } from "./paychecks";

// ---------------------------------------------------------------------------
// Cross-device sync: build a portable JSON snapshot of this device's data and
// merge a peer's snapshot into the local DB. Used by both the desktop Next.js
// app (/api/sync-pull, /api/sync-merge) and the mobile app, which run the SAME
// merge logic against their own SQLite so the two converge to an identical state.
//
// Merge model:
//   - raw_transactions is append-only → union by (transaction_id, source, fetched_at).
//   - processed `transactions` is rebuilt from raw via replay (never conflicts).
//   - user-authored data uses last-writer-wins on `updated_at`. The PHONE wins exact
//     ties (it's the primary device). Each side is exactly one of phone|desktop, so
//     "incoming wins a tie iff the incoming snapshot is from the phone" is unambiguous.
// ---------------------------------------------------------------------------

export const SNAPSHOT_VERSION = 1 as const;
export type DeviceRole = "phone" | "desktop";

export interface Snapshot {
  version: typeof SNAPSHOT_VERSION;
  generatedAt: string;
  role: DeviceRole;
  categories: {
    name: string;
    definition: string;
    isPaycheckSource: number | null;
    updatedAt: string | null;
  }[];
  connection: { accessUrl: string; createdAt: string | null } | null;
  accounts: {
    accountId: string;
    orgName: string | null;
    orgDomain: string | null;
    name: string | null;
    currency: string | null;
    balance: number | null;
    availableBalance: number | null;
    balanceDate: string | null;
    accountType: string | null;
    updatedAt: string | null;
  }[];
  rawTransactions: {
    transactionId: string;
    source: string;
    accountId: string;
    fetchedAt: string | null;
    payloadJson: string;
  }[];
  // Transaction categorizations + notes travel between devices so the LLM only has to
  // run once (on whichever device categorized) and the result syncs. Sent for any row
  // that has a category (llm or user) or a user note. Replay preserves these locally.
  txnOverrides: {
    transactionId: string;
    category: string | null;
    categorySource: string | null;
    categoryConfidence: string | null;
    categoryAlternatives: string | null;
    userNote: string | null;
    updatedAt: string | null;
  }[];
  // Only user-locked paycheck splits (source='user'); auto splits are recomputed locally.
  paycheckSplits: {
    transactionId: string;
    portion: string;
    amount: number;
    source: string | null;
    note: string | null;
    updatedAt: string | null;
  }[];
  planning: { data: string; updatedAt: string | null } | null;
}

// Parse a timestamp to epoch millis for comparison. Missing/blank → 0 (loses every
// real edit). Handles both ISO-8601 and legacy "YYYY-MM-DD HH:MM:SS" (UTC) values.
function ts(v: string | null | undefined): number {
  if (!v) return 0;
  const t = Date.parse(v);
  if (!Number.isNaN(t)) return t;
  // Legacy SQLite datetime('now') format is UTC but lacks a 'Z'.
  const t2 = Date.parse(v.replace(" ", "T") + "Z");
  return Number.isNaN(t2) ? 0 : t2;
}

// Should the incoming value replace the local one?
//   newer wins; on an exact tie the phone wins. `incomingIsPhone` = snapshot.role==='phone'.
function incomingWins(localUpdatedAt: string | null, incomingUpdatedAt: string | null, incomingIsPhone: boolean): boolean {
  const l = ts(localUpdatedAt);
  const i = ts(incomingUpdatedAt);
  if (i > l) return true;
  if (i < l) return false;
  return incomingIsPhone;
}

// Resolve a categorization conflict using a priority tier, then last-writer-wins.
// Tier: a manual ('user') categorization beats a machine ('llm') one, which beats
// no categorization at all (null source). A higher tier always wins regardless of
// timestamps — this matters because many historical rows carry an epoch-0
// (1970-01-01) updated_at, so cross-tier ties can't be broken on time. In
// particular, an incoming llm category must always land on a locally-uncategorized
// row even though both sides report updated_at = 0. Within the SAME tier it's
// last-writer-wins (phone wins exact ties).
function overrideWins(
  localSource: string | null,
  localUpdatedAt: string | null,
  incomingSource: string | null,
  incomingUpdatedAt: string | null,
  incomingIsPhone: boolean,
): boolean {
  const tier = (s: string | null) => (s === "user" ? 2 : s ? 1 : 0);
  const localTier = tier(localSource);
  const incomingTier = tier(incomingSource);
  if (incomingTier !== localTier) return incomingTier > localTier;
  return incomingWins(localUpdatedAt, incomingUpdatedAt, incomingIsPhone);
}

// Build a snapshot of this device's syncable data.
export async function buildSnapshot(role: DeviceRole): Promise<Snapshot> {
  ensureSyncSchema();

  const categories = db.all<Snapshot["categories"][number]>(sql`
    SELECT name, definition, is_paycheck_source AS isPaycheckSource, updated_at AS updatedAt
    FROM categories
  `);

  const connRow = db.all<{ accessUrl: string; createdAt: string | null }>(sql`
    SELECT access_url AS accessUrl, created_at AS createdAt FROM connection ORDER BY id LIMIT 1
  `)[0];

  const accounts = db.all<Snapshot["accounts"][number]>(sql`
    SELECT account_id AS accountId, org_name AS orgName, org_domain AS orgDomain, name,
           currency, balance, available_balance AS availableBalance, balance_date AS balanceDate,
           account_type AS accountType, updated_at AS updatedAt
    FROM accounts
  `);

  const rawTransactions = db.all<Snapshot["rawTransactions"][number]>(sql`
    SELECT transaction_id AS transactionId, source, account_id AS accountId,
           fetched_at AS fetchedAt, payload_json AS payloadJson
    FROM raw_transactions
  `);

  const txnOverrides = db.all<Snapshot["txnOverrides"][number]>(sql`
    SELECT transaction_id AS transactionId, category, category_source AS categorySource,
           category_confidence AS categoryConfidence, category_alternatives AS categoryAlternatives,
           user_note AS userNote, updated_at AS updatedAt
    FROM transactions
    WHERE category IS NOT NULL OR user_note IS NOT NULL
  `);

  const paycheckSplits = db.all<Snapshot["paycheckSplits"][number]>(sql`
    SELECT transaction_id AS transactionId, portion, amount, source, note, updated_at AS updatedAt
    FROM paycheck_splits
    WHERE source = 'user'
  `);

  const planning = db.all<{ data: string; updatedAt: string | null }>(sql`
    SELECT data, updated_at AS updatedAt FROM planning_store WHERE id = 1
  `)[0] ?? null;

  return {
    version: SNAPSHOT_VERSION,
    generatedAt: new Date().toISOString(),
    role,
    categories,
    connection: connRow ?? null,
    accounts,
    rawTransactions,
    txnOverrides,
    paycheckSplits,
    planning,
  };
}

export interface MergeStats {
  rawAppended: number;
  accountsUpserted: number;
  categoriesUpserted: number;
  overridesApplied: number;
  splitsApplied: number;
  planningUpdated: boolean;
  connectionAdopted: boolean;
  processed: number;
  paychecksSplit: number;
}

// Merge a peer snapshot into the local DB, then replay so derived state converges.
// `localRole` is this device's role; combined with the snapshot's role it resolves ties.
export async function mergeSnapshot(snap: Snapshot, localRole: DeviceRole): Promise<MergeStats> {
  ensureSyncSchema();
  if (snap.version !== SNAPSHOT_VERSION) {
    throw new Error(`Unsupported snapshot version ${snap.version} (expected ${SNAPSHOT_VERSION}).`);
  }
  const incomingIsPhone = snap.role === "phone";
  const stats: MergeStats = {
    rawAppended: 0, accountsUpserted: 0, categoriesUpserted: 0, overridesApplied: 0,
    splitsApplied: 0, planningUpdated: false, connectionAdopted: false, processed: 0, paychecksSplit: 0,
  };

  // 1. Categories — LWW by updated_at.
  for (const c of snap.categories) {
    const local = db.all<{ updatedAt: string | null }>(
      sql`SELECT updated_at AS updatedAt FROM categories WHERE name = ${c.name}`,
    )[0];
    if (!local) {
      db.run(sql`
        INSERT INTO categories (name, definition, is_paycheck_source, updated_at)
        VALUES (${c.name}, ${c.definition}, ${c.isPaycheckSource ?? 0}, ${c.updatedAt})
      `);
      stats.categoriesUpserted++;
    } else if (incomingWins(local.updatedAt, c.updatedAt, incomingIsPhone)) {
      db.run(sql`
        UPDATE categories SET definition = ${c.definition},
          is_paycheck_source = ${c.isPaycheckSource ?? 0}, updated_at = ${c.updatedAt}
        WHERE name = ${c.name}
      `);
      stats.categoriesUpserted++;
    }
  }

  // 2. Connection — adopt the peer's SimpleFIN access URL only if we have none (lets the
  //    second device inherit access without claiming a fresh, single-use setup token).
  if (snap.connection) {
    const haveConn = db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM connection`)[0]?.n ?? 0;
    if (haveConn === 0) {
      db.run(sql`
        INSERT INTO connection (access_url, created_at)
        VALUES (${snap.connection.accessUrl}, ${snap.connection.createdAt ?? new Date().toISOString()})
      `);
      stats.connectionAdopted = true;
    }
  }

  // 3. Accounts — balance/metadata: newer balance_date wins. account_type: LWW.
  for (const a of snap.accounts) {
    const local = db.all<{ accountType: string | null; updatedAt: string | null; balanceDate: string | null }>(
      sql`SELECT account_type AS accountType, updated_at AS updatedAt, balance_date AS balanceDate FROM accounts WHERE account_id = ${a.accountId}`,
    )[0];
    if (!local) {
      db.run(sql`
        INSERT INTO accounts (account_id, org_name, org_domain, name, currency, balance,
          available_balance, balance_date, account_type, updated_at)
        VALUES (${a.accountId}, ${a.orgName}, ${a.orgDomain}, ${a.name}, ${a.currency}, ${a.balance},
          ${a.availableBalance}, ${a.balanceDate}, ${a.accountType ?? "depository"}, ${a.updatedAt})
      `);
      stats.accountsUpserted++;
      continue;
    }
    // Newer balance snapshot wins for balance fields.
    if (ts(a.balanceDate) > ts(local.balanceDate)) {
      db.run(sql`
        UPDATE accounts SET org_name = ${a.orgName}, org_domain = ${a.orgDomain}, name = ${a.name},
          currency = ${a.currency}, balance = ${a.balance}, available_balance = ${a.availableBalance},
          balance_date = ${a.balanceDate}
        WHERE account_id = ${a.accountId}
      `);
    }
    // account_type is user-set → LWW.
    if (incomingWins(local.updatedAt, a.updatedAt, incomingIsPhone)) {
      db.run(sql`UPDATE accounts SET account_type = ${a.accountType ?? "depository"}, updated_at = ${a.updatedAt} WHERE account_id = ${a.accountId}`);
      stats.accountsUpserted++;
    }
  }

  // 4. raw_transactions — union by (transaction_id, source, fetched_at).
  for (const r of snap.rawTransactions) {
    const exists = db.all<{ n: number }>(sql`
      SELECT COUNT(*) AS n FROM raw_transactions
      WHERE transaction_id = ${r.transactionId} AND source = ${r.source}
        AND IFNULL(fetched_at, '') = IFNULL(${r.fetchedAt}, '')
    `)[0]?.n ?? 0;
    if (exists === 0) {
      db.run(sql`
        INSERT INTO raw_transactions (transaction_id, source, account_id, fetched_at, payload_json)
        VALUES (${r.transactionId}, ${r.source}, ${r.accountId}, ${r.fetchedAt}, ${r.payloadJson})
      `);
      stats.rawAppended++;
    }
  }

  // 5. Replay processed `transactions` from the now-merged raw layer. Replay preserves
  //    any local user category/note, so we apply incoming overrides afterwards (LWW).
  const replay = await replayFromRaw();
  stats.processed = replay.processed;

  // 6. Transaction categorizations + notes — LWW with manual (user) edits protected.
  //    Only touches rows that exist (replay made them). Carries llm + user categories.
  for (const o of snap.txnOverrides) {
    const local = db.all<{ updatedAt: string | null; categorySource: string | null }>(
      sql`SELECT updated_at AS updatedAt, category_source AS categorySource FROM transactions WHERE transaction_id = ${o.transactionId}`,
    )[0];
    if (!local) continue; // no raw for this txn on either side → nothing to attach to
    if (overrideWins(local.categorySource, local.updatedAt, o.categorySource, o.updatedAt, incomingIsPhone)) {
      db.run(sql`
        UPDATE transactions SET category = ${o.category}, category_source = ${o.categorySource},
          category_confidence = ${o.categoryConfidence}, category_alternatives = ${o.categoryAlternatives},
          user_note = ${o.userNote}, updated_at = ${o.updatedAt}
        WHERE transaction_id = ${o.transactionId}
      `);
      stats.overridesApplied++;
    }
  }

  // 7. User paycheck splits — LWW per transaction. Replace the local pair when incoming wins.
  const incomingByTxn = new Map<string, Snapshot["paycheckSplits"]>();
  for (const s of snap.paycheckSplits) {
    const list = incomingByTxn.get(s.transactionId) ?? [];
    list.push(s);
    incomingByTxn.set(s.transactionId, list);
  }
  for (const [txnId, splits] of incomingByTxn) {
    // Only attach if the transaction exists locally after replay.
    const txnExists = db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM transactions WHERE transaction_id = ${txnId}`)[0]?.n ?? 0;
    if (txnExists === 0) continue;
    const localUpdated = db.all<{ updatedAt: string | null }>(
      sql`SELECT MAX(updated_at) AS updatedAt FROM paycheck_splits WHERE transaction_id = ${txnId} AND source = 'user'`,
    )[0]?.updatedAt ?? null;
    const incomingUpdated = splits.reduce<string | null>((acc, s) => (ts(s.updatedAt) > ts(acc) ? s.updatedAt : acc), null);
    if (incomingWins(localUpdated, incomingUpdated, incomingIsPhone)) {
      db.run(sql`DELETE FROM paycheck_splits WHERE transaction_id = ${txnId}`);
      for (const s of splits) {
        db.run(sql`
          INSERT INTO paycheck_splits (transaction_id, portion, amount, source, note, updated_at)
          VALUES (${txnId}, ${s.portion}, ${s.amount}, ${"user"}, ${s.note}, ${s.updatedAt})
        `);
      }
      stats.splitsApplied++;
    }
  }

  // 8. Planning blob — newest wins.
  if (snap.planning) {
    const local = db.all<{ updatedAt: string | null }>(sql`SELECT updated_at AS updatedAt FROM planning_store WHERE id = 1`)[0];
    if (!local || incomingWins(local.updatedAt, snap.planning.updatedAt, incomingIsPhone)) {
      db.run(sql`
        INSERT INTO planning_store (id, data, updated_at)
        VALUES (1, ${snap.planning.data}, ${snap.planning.updatedAt ?? new Date().toISOString()})
        ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
      `);
      stats.planningUpdated = true;
    }
  }

  // 9. Recompute auto paycheck splits (user splits from step 7 are protected inside).
  const splits = await autoSplitPaychecks();
  stats.paychecksSplit = splits.computed;

  // Stamp last sync time.
  db.run(sql`
    INSERT INTO sync_state (id, last_synced_at) VALUES (1, ${new Date().toISOString()})
    ON CONFLICT(id) DO UPDATE SET last_synced_at = excluded.last_synced_at
  `);

  return stats;
}
