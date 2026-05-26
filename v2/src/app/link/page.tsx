"use client";

import { useEffect, useState } from "react";

interface Account {
  accountId: string;
  orgName: string | null;
  name: string | null;
  accountType: string | null;
  balance: number | null;
}

export default function LinkPage() {
  const [token, setToken] = useState("");
  const [status, setStatus] = useState("");
  const [accounts, setAccounts] = useState<Account[]>([]);

  const loadAccounts = () =>
    fetch("/api/accounts").then((r) => r.json()).then((d) => setAccounts(d.accounts));

  useEffect(() => { loadAccounts(); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("Claiming setup token + syncing...");
    const res = await fetch("/api/setup", {
      method: "POST",
      body: JSON.stringify({ setup_token: token.trim() }),
    });
    const data = await res.json();
    if (!res.ok) { setStatus(`Error: ${data.error ?? res.statusText}`); return; }
    setStatus(`Synced ${data.accounts} accounts: +${data.added} added, ${data.updated} updated`);
    setToken("");
    loadAccounts();
  }

  async function resync() {
    setStatus("Re-syncing...");
    const res = await fetch("/api/sync", { method: "POST" });
    const data = await res.json();
    setStatus(`Synced ${data.accounts} accounts: +${data.added} added, ${data.updated} updated`);
    loadAccounts();
  }

  async function backfill() {
    setStatus("Backfilling from v1 CSV (this can take a minute, then categorizes)...");
    const res = await fetch("/api/backfill-csv", { method: "POST" });
    const data = await res.json();
    if (!res.ok) { setStatus(`Backfill error: ${data.error ?? res.statusText}`); return; }
    setStatus(`Backfilled ${data.totalImported} historical txns (${data.totalSkipped} skipped as duplicates of SimpleFIN data) + categorized ${data.categorized}`);
    loadAccounts();
  }

  async function updateType(accountId: string, accountType: string) {
    await fetch("/api/accounts", {
      method: "PATCH",
      body: JSON.stringify({ accountId, accountType }),
    });
    loadAccounts();
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <h1 className="text-2xl font-semibold">Connect accounts</h1>
      <p className="text-sm text-neutral-400">
        Sign up at <a href="https://bridge.simplefin.org" className="underline">bridge.simplefin.org</a>,
        add your banks there, then paste the one-time setup token below. The token gets exchanged for a
        long-lived access URL stored locally.
      </p>

      <form onSubmit={submit} className="space-y-2">
        <textarea
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Paste setup token (base64 string)..."
          className="w-full h-24 bg-neutral-900 rounded p-2 text-xs font-mono"
        />
        <div className="flex gap-2">
          <button className="px-4 py-2 bg-blue-600 rounded">Save + sync</button>
          <button type="button" onClick={resync} className="px-4 py-2 bg-neutral-700 rounded">
            Re-sync now
          </button>
          <button type="button" onClick={backfill} className="px-4 py-2 bg-amber-700 rounded">
            One-time backfill from v1 CSV
          </button>
        </div>
        <p className="text-sm text-neutral-400">{status}</p>
      </form>

      <section>
        <h2 className="text-lg mb-2">Accounts</h2>
        <p className="text-sm text-neutral-400 mb-2">
          Mark each as <strong>credit</strong> (credit card) or <strong>depository</strong> (checking/savings)
          so cash-flow vs spending classify correctly.
        </p>
        <table className="w-full text-sm">
          <thead className="text-left text-neutral-400">
            <tr><th className="py-2">Bank</th><th>Name</th><th>Balance</th><th>Type</th></tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.accountId} className="border-t border-neutral-800">
                <td className="py-2">{a.orgName}</td>
                <td>{a.name}</td>
                <td>{a.balance?.toFixed(2)}</td>
                <td>
                  <select
                    value={a.accountType ?? "depository"}
                    onChange={(e) => updateType(a.accountId, e.target.value)}
                    className="bg-neutral-900 rounded px-2 py-1"
                  >
                    <option value="depository">depository</option>
                    <option value="credit">credit</option>
                    <option value="investment">investment</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
