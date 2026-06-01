import { sql } from "drizzle-orm";
import { db } from "@/db";
import { ensureSyncSchema } from "./migrate";
import { replayFromRaw } from "./process";
import { autoSplitPaychecks } from "./paychecks";

// Cross-device sync — IDENTICAL contract to the desktop's src/lib/sync.ts so the two
// devices converge to the same state. This device is always the PHONE (role "phone"),
// which wins exact LWW ties (it's the primary device).

export const SNAPSHOT_VERSION = 1 as const;
export type DeviceRole = "phone" | "desktop";

export interface Snapshot {
  version: typeof SNAPSHOT_VERSION;
  generatedAt: string;
  role: DeviceRole;
  categories: { name: string; definition: string; isPaycheckSource: number | null; updatedAt: string | null }[];
  connection: { accessUrl: string; createdAt: string | null } | null;
  accounts: {
    accountId: string; orgName: string | null; orgDomain: string | null; name: string | null;
    currency: string | null; balance: number | null; availableBalance: number | null;
    balanceDate: string | null; accountType: string | null; updatedAt: string | null;
  }[];
  rawTransactions: { transactionId: string; source: string; accountId: string; fetchedAt: string | null; payloadJson: string }[];
  txnOverrides: {
    transactionId: string; category: string | null; categorySource: string | null;
    categoryConfidence: string | null; categoryAlternatives: string | null; userNote: string | null; updatedAt: string | null;
  }[];
  paycheckSplits: { transactionId: string; portion: string; amount: number; source: string | null; note: string | null; updatedAt: string | null }[];
  planning: { data: string; updatedAt: string | null } | null;
}

function ts(v: string | null | undefined): number {
  if (!v) return 0;
  const t = Date.parse(v);
  if (!Number.isNaN(t)) return t;
  const t2 = Date.parse(v.replace(" ", "T") + "Z");
  return Number.isNaN(t2) ? 0 : t2;
}

function incomingWins(localUpdatedAt: string | null, incomingUpdatedAt: string | null, incomingIsPhone: boolean): boolean {
  const l = ts(localUpdatedAt);
  const i = ts(incomingUpdatedAt);
  if (i > l) return true;
  if (i < l) return false;
  return incomingIsPhone;
}

// A manual ('user') categorization beats a machine ('llm') one, which beats no
// categorization at all (null source). A higher tier always wins regardless of
// timestamps — many historical rows carry an epoch-0 (1970-01-01) updated_at, so
// cross-tier ties can't be broken on time. In particular an incoming llm category
// must always land on a locally-uncategorized row even though both report
// updated_at = 0. Within the same tier it's last-writer-wins (phone wins exact ties).
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

export async function buildSnapshot(role: DeviceRole): Promise<Snapshot> {
  ensureSyncSchema();

  const categories = await db.all<Snapshot["categories"][number]>(sql`
    SELECT name, definition, is_paycheck_source AS isPaycheckSource, updated_at AS updatedAt FROM categories
  `);
  const connRow = (await db.all<{ accessUrl: string; createdAt: string | null }>(sql`
    SELECT access_url AS accessUrl, created_at AS createdAt FROM connection ORDER BY id LIMIT 1
  `))[0];
  const accounts = await db.all<Snapshot["accounts"][number]>(sql`
    SELECT account_id AS accountId, org_name AS orgName, org_domain AS orgDomain, name,
           currency, balance, available_balance AS availableBalance, balance_date AS balanceDate,
           account_type AS accountType, updated_at AS updatedAt FROM accounts
  `);
  const rawTransactions = await db.all<Snapshot["rawTransactions"][number]>(sql`
    SELECT transaction_id AS transactionId, source, account_id AS accountId,
           fetched_at AS fetchedAt, payload_json AS payloadJson FROM raw_transactions
  `);
  const txnOverrides = await db.all<Snapshot["txnOverrides"][number]>(sql`
    SELECT transaction_id AS transactionId, category, category_source AS categorySource,
           category_confidence AS categoryConfidence, category_alternatives AS categoryAlternatives,
           user_note AS userNote, updated_at AS updatedAt
    FROM transactions WHERE category IS NOT NULL OR user_note IS NOT NULL
  `);
  const paycheckSplits = await db.all<Snapshot["paycheckSplits"][number]>(sql`
    SELECT transaction_id AS transactionId, portion, amount, source, note, updated_at AS updatedAt
    FROM paycheck_splits WHERE source = 'user'
  `);
  const planning = (await db.all<{ data: string; updatedAt: string | null }>(sql`
    SELECT data, updated_at AS updatedAt FROM planning_store WHERE id = 1
  `))[0] ?? null;

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

  for (const c of snap.categories) {
    const local = (await db.all<{ updatedAt: string | null }>(sql`SELECT updated_at AS updatedAt FROM categories WHERE name = ${c.name}`))[0];
    if (!local) {
      await db.run(sql`INSERT INTO categories (name, definition, is_paycheck_source, updated_at) VALUES (${c.name}, ${c.definition}, ${c.isPaycheckSource ?? 0}, ${c.updatedAt})`);
      stats.categoriesUpserted++;
    } else if (incomingWins(local.updatedAt, c.updatedAt, incomingIsPhone)) {
      await db.run(sql`UPDATE categories SET definition = ${c.definition}, is_paycheck_source = ${c.isPaycheckSource ?? 0}, updated_at = ${c.updatedAt} WHERE name = ${c.name}`);
      stats.categoriesUpserted++;
    }
  }

  if (snap.connection) {
    const haveConn = (await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM connection`))[0]?.n ?? 0;
    if (haveConn === 0) {
      await db.run(sql`INSERT INTO connection (access_url, created_at) VALUES (${snap.connection.accessUrl}, ${snap.connection.createdAt ?? new Date().toISOString()})`);
      stats.connectionAdopted = true;
    }
  }

  for (const a of snap.accounts) {
    const local = (await db.all<{ accountType: string | null; updatedAt: string | null; balanceDate: string | null }>(
      sql`SELECT account_type AS accountType, updated_at AS updatedAt, balance_date AS balanceDate FROM accounts WHERE account_id = ${a.accountId}`,
    ))[0];
    if (!local) {
      await db.run(sql`
        INSERT INTO accounts (account_id, org_name, org_domain, name, currency, balance, available_balance, balance_date, account_type, updated_at)
        VALUES (${a.accountId}, ${a.orgName}, ${a.orgDomain}, ${a.name}, ${a.currency}, ${a.balance}, ${a.availableBalance}, ${a.balanceDate}, ${a.accountType ?? "depository"}, ${a.updatedAt})
      `);
      stats.accountsUpserted++;
      continue;
    }
    if (ts(a.balanceDate) > ts(local.balanceDate)) {
      await db.run(sql`
        UPDATE accounts SET org_name = ${a.orgName}, org_domain = ${a.orgDomain}, name = ${a.name},
          currency = ${a.currency}, balance = ${a.balance}, available_balance = ${a.availableBalance}, balance_date = ${a.balanceDate}
        WHERE account_id = ${a.accountId}
      `);
    }
    if (incomingWins(local.updatedAt, a.updatedAt, incomingIsPhone)) {
      await db.run(sql`UPDATE accounts SET account_type = ${a.accountType ?? "depository"}, updated_at = ${a.updatedAt} WHERE account_id = ${a.accountId}`);
      stats.accountsUpserted++;
    }
  }

  for (const r of snap.rawTransactions) {
    const exists = (await db.all<{ n: number }>(sql`
      SELECT COUNT(*) AS n FROM raw_transactions
      WHERE transaction_id = ${r.transactionId} AND source = ${r.source} AND IFNULL(fetched_at, '') = IFNULL(${r.fetchedAt}, '')
    `))[0]?.n ?? 0;
    if (exists === 0) {
      await db.run(sql`INSERT INTO raw_transactions (transaction_id, source, account_id, fetched_at, payload_json) VALUES (${r.transactionId}, ${r.source}, ${r.accountId}, ${r.fetchedAt}, ${r.payloadJson})`);
      stats.rawAppended++;
    }
  }

  const replay = await replayFromRaw();
  stats.processed = replay.processed;

  for (const o of snap.txnOverrides) {
    const local = (await db.all<{ updatedAt: string | null; categorySource: string | null }>(sql`SELECT updated_at AS updatedAt, category_source AS categorySource FROM transactions WHERE transaction_id = ${o.transactionId}`))[0];
    if (!local) continue;
    if (overrideWins(local.categorySource, local.updatedAt, o.categorySource, o.updatedAt, incomingIsPhone)) {
      await db.run(sql`
        UPDATE transactions SET category = ${o.category}, category_source = ${o.categorySource},
          category_confidence = ${o.categoryConfidence}, category_alternatives = ${o.categoryAlternatives},
          user_note = ${o.userNote}, updated_at = ${o.updatedAt}
        WHERE transaction_id = ${o.transactionId}
      `);
      stats.overridesApplied++;
    }
  }

  const incomingByTxn = new Map<string, Snapshot["paycheckSplits"]>();
  for (const s of snap.paycheckSplits) {
    const list = incomingByTxn.get(s.transactionId) ?? [];
    list.push(s);
    incomingByTxn.set(s.transactionId, list);
  }
  for (const [txnId, splits] of incomingByTxn) {
    const txnExists = (await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM transactions WHERE transaction_id = ${txnId}`))[0]?.n ?? 0;
    if (txnExists === 0) continue;
    const localUpdated = (await db.all<{ updatedAt: string | null }>(sql`SELECT MAX(updated_at) AS updatedAt FROM paycheck_splits WHERE transaction_id = ${txnId} AND source = 'user'`))[0]?.updatedAt ?? null;
    const incomingUpdated = splits.reduce<string | null>((acc, s) => (ts(s.updatedAt) > ts(acc) ? s.updatedAt : acc), null);
    if (incomingWins(localUpdated, incomingUpdated, incomingIsPhone)) {
      await db.run(sql`DELETE FROM paycheck_splits WHERE transaction_id = ${txnId}`);
      for (const s of splits) {
        await db.run(sql`INSERT INTO paycheck_splits (transaction_id, portion, amount, source, note, updated_at) VALUES (${txnId}, ${s.portion}, ${s.amount}, ${"user"}, ${s.note}, ${s.updatedAt})`);
      }
      stats.splitsApplied++;
    }
  }

  if (snap.planning) {
    const local = (await db.all<{ updatedAt: string | null }>(sql`SELECT updated_at AS updatedAt FROM planning_store WHERE id = 1`))[0];
    if (!local || incomingWins(local.updatedAt, snap.planning.updatedAt, incomingIsPhone)) {
      await db.run(sql`
        INSERT INTO planning_store (id, data, updated_at) VALUES (1, ${snap.planning.data}, ${snap.planning.updatedAt ?? new Date().toISOString()})
        ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
      `);
      stats.planningUpdated = true;
    }
  }

  const splits = await autoSplitPaychecks();
  stats.paychecksSplit = splits.computed;

  await db.run(sql`
    INSERT INTO sync_state (id, last_synced_at) VALUES (1, ${new Date().toISOString()})
    ON CONFLICT(id) DO UPDATE SET last_synced_at = excluded.last_synced_at
  `);

  return stats;
}
