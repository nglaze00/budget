import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { categorizeUncategorized } from "./categorize";
import { autoSplitPaychecks } from "./paychecks";
import { seedCategoriesIfEmpty } from "./seed";
import { appendRaw, replayFromRaw } from "./process";
import { base64Encode, base64Decode } from "./base64";

// Ported from the desktop app (src/lib/simplefin.ts). Node's Buffer is replaced with a
// pure-JS base64 util; everything else (chunked fetch, append-only raw, replay) is identical.

export async function claimSetupToken(setupToken: string): Promise<string> {
  const claimUrl = base64Decode(setupToken).trim();
  const resp = await fetch(claimUrl, { method: "POST" });
  if (!resp.ok) throw new Error(`SimpleFIN claim failed: ${resp.status} ${await resp.text()}`);
  const accessUrl = (await resp.text()).trim();
  if (!/^https?:\/\//.test(accessUrl)) throw new Error(`Unexpected claim response: ${accessUrl}`);
  return accessUrl;
}

interface SfAccount {
  id: string;
  name: string;
  currency: string;
  balance: string;
  "available-balance"?: string;
  "balance-date": number;
  org: { name?: string; domain?: string };
  transactions: SfTxn[];
}
interface SfTxn {
  id: string;
  posted: number;
  amount: string;
  description?: string;
  payee?: string;
  memo?: string;
  pending?: boolean;
}

function isoDate(epochSeconds: number) {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

export interface InstitutionStatus {
  orgName: string;
  orgDomain: string | null;
  accountCount: number;
  transactionCount: number;
  status: "ok" | "error" | "missing";
  error?: string;
}

const EXPECTED_INSTITUTIONS = [
  { key: "chase", label: "Chase" },
  { key: "capitalone", label: "Capital One" },
  { key: "wellsfargo", label: "Wells Fargo" },
];

// Split an access URL (inline Basic-Auth per the SimpleFIN spec) into (bareUrl, authHeader).
function splitAuth(accessUrl: string): { bareUrl: string; authHeader: string } {
  const u = new URL(accessUrl);
  const auth = base64Encode(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`);
  u.username = "";
  u.password = "";
  return { bareUrl: u.toString().replace(/\/$/, ""), authHeader: `Basic ${auth}` };
}

export type ProgressFn = (message: string) => void;

async function fetchAccountsChunked(
  accessUrl: string,
  startEpoch: number,
  endEpoch: number,
  onProgress: ProgressFn = () => {},
) {
  const { bareUrl, authHeader } = splitAuth(accessUrl);
  const CHUNK_DAYS = 90;
  const chunkSecs = CHUNK_DAYS * 86400;
  const accountMap = new Map<string, SfAccount>();
  const allErrors: string[] = [];

  const totalChunks = Math.max(1, Math.ceil((endEpoch - startEpoch) / chunkSecs));
  let cursor = startEpoch;
  let chunkCount = 0;
  while (cursor < endEpoch) {
    const chunkEnd = Math.min(cursor + chunkSecs, endEpoch);
    onProgress(
      totalChunks > 1
        ? `Contacting your banks (batch ${chunkCount + 1} of ${totalChunks})…`
        : "Contacting your banks…",
    );
    const url = `${bareUrl}/accounts?start-date=${cursor}&end-date=${chunkEnd}&pending=1`;
    const resp = await fetch(url, { headers: { Authorization: authHeader } });
    if (!resp.ok) throw new Error(`SimpleFIN /accounts failed: ${resp.status}`);
    const data = (await resp.json()) as { errors: string[]; accounts: SfAccount[] };
    chunkCount++;

    for (const err of data.errors ?? []) {
      if (!allErrors.includes(err)) allErrors.push(err);
    }

    for (const a of data.accounts) {
      const existing = accountMap.get(a.id);
      if (existing) {
        existing.transactions = existing.transactions.concat(a.transactions);
        if (chunkEnd > startEpoch + chunkSecs * (chunkCount - 1)) {
          existing.balance = a.balance;
          existing["available-balance"] = a["available-balance"];
          existing["balance-date"] = a["balance-date"];
        }
      } else {
        accountMap.set(a.id, { ...a, transactions: [...a.transactions] });
      }
    }
    cursor = chunkEnd;
  }

  return { accounts: Array.from(accountMap.values()), errors: allErrors, chunks: chunkCount };
}

export async function sync(daysBack = 90, onProgress: ProgressFn = () => {}) {
  onProgress("Preparing…");
  await seedCategoriesIfEmpty();
  const conn = await db.query.connection.findFirst();
  if (!conn) throw new Error("No SimpleFIN connection — set one up in Settings first.");

  const now = Math.floor(Date.now() / 1000);
  const start = now - daysBack * 86400;
  const data = await fetchAccountsChunked(conn.accessUrl, start, now, onProgress);
  onProgress(`Received ${data.accounts.length} account(s) from your banks.`);

  const institutionMap = new Map<string, InstitutionStatus>();
  for (const a of data.accounts) {
    const domain = a.org.domain ?? "unknown";
    const existing = institutionMap.get(domain);
    if (existing) {
      existing.accountCount++;
      existing.transactionCount += a.transactions.length;
    } else {
      institutionMap.set(domain, {
        orgName: a.org.name ?? domain,
        orgDomain: domain,
        accountCount: 1,
        transactionCount: a.transactions.length,
        status: "ok",
      });
    }
  }

  for (const errMsg of data.errors) {
    const matched = EXPECTED_INSTITUTIONS.find((d) => errMsg.toLowerCase().includes(d.key));
    if (matched) {
      const existing = Array.from(institutionMap.values()).find((i) => i.orgDomain?.toLowerCase().includes(matched.key));
      if (existing) {
        existing.status = "error";
        existing.error = errMsg;
      } else {
        institutionMap.set(matched.key, {
          orgName: matched.label,
          orgDomain: matched.key,
          accountCount: 0,
          transactionCount: 0,
          status: "error",
          error: errMsg,
        });
      }
    }
  }

  for (const expected of EXPECTED_INSTITUTIONS) {
    const seen = Array.from(institutionMap.values()).some((i) => i.orgDomain?.toLowerCase().includes(expected.key));
    if (!seen) {
      institutionMap.set(expected.key, {
        orgName: expected.label,
        orgDomain: expected.key,
        accountCount: 0,
        transactionCount: 0,
        status: "missing",
        error: `No accounts returned for ${expected.label} — connection may not be set up or auth may have expired.`,
      });
    }
  }

  const institutions = Array.from(institutionMap.values());

  onProgress("Updating account balances…");
  for (const a of data.accounts) {
    await db
      .insert(schema.accounts)
      .values({
        accountId: a.id,
        orgName: a.org.name ?? null,
        orgDomain: a.org.domain ?? null,
        name: a.name,
        currency: a.currency,
        balance: Number(a.balance),
        availableBalance: a["available-balance"] ? Number(a["available-balance"]) : null,
        balanceDate: isoDate(a["balance-date"]),
      })
      .onConflictDoUpdate({
        target: schema.accounts.accountId,
        set: {
          orgName: a.org.name ?? null,
          orgDomain: a.org.domain ?? null,
          name: a.name,
          balance: Number(a.balance),
          availableBalance: a["available-balance"] ? Number(a["available-balance"]) : null,
          balanceDate: isoDate(a["balance-date"]),
        },
      });
  }

  const rawItems = data.accounts.flatMap((a) =>
    a.transactions.map((t) => ({ transactionId: t.id, accountId: a.id, payload: t })),
  );
  onProgress(`Saving ${rawItems.length} transaction(s)…`);
  await appendRaw("simplefin", rawItems);

  onProgress("Processing transactions…");
  const { processed } = await replayFromRaw();

  await db
    .insert(schema.syncState)
    .values({ id: 1, lastSyncedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: schema.syncState.id, set: { lastSyncedAt: new Date().toISOString() } });

  onProgress("Categorizing new transactions…");
  const cat = await categorizeUncategorized();
  onProgress("Splitting paychecks…");
  const splits = await autoSplitPaychecks();
  onProgress("Wrapping up…");

  return {
    accounts: data.accounts.length,
    raw_appended: rawItems.length,
    processed,
    categorized: cat.categorized,
    paychecks_split: splits.computed,
    errors: data.errors,
    institutions,
  };
}

// Persist a freshly-claimed access URL into the connection table.
export async function saveConnection(accessUrl: string) {
  const existing = await db.query.connection.findFirst();
  if (existing) {
    await db.update(schema.connection).set({ accessUrl }).where(eq(schema.connection.id, existing.id));
  } else {
    await db.insert(schema.connection).values({ accessUrl });
  }
}
