"use client";

import { useEffect, useState } from "react";

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
  postedAt: number | null;
  transactedAt: number | null;
}

// Format an epoch second as YYYY-MM-DD HH:MM. Banks usually only give us date-level
// precision (the value will be noon UTC), but when transacted_at differs from posted
// for a row that's a strong signal it's a distinct event.
function fmtTs(s: number | null): string {
  if (!s) return "—";
  const d = new Date(s * 1000);
  return d.toISOString().slice(0, 10);
}
interface DupeGroup {
  key: string;
  kind: "within-account" | "cross-account";
  date: string;
  amount: number;
  transactions: DupeTxn[];
  confidence: number;
  reason: string;
}

// Colour-code the confidence badge so high-likelihood dupes stand out at a glance.
function confidenceBadge(c: number): { label: string; cls: string } {
  if (c >= 0.8) return { label: "Very likely dup", cls: "bg-rose-950/70 text-rose-300 border-rose-900/60" };
  if (c >= 0.6) return { label: "Probably dup", cls: "bg-amber-950/70 text-amber-300 border-amber-900/60" };
  if (c >= 0.35) return { label: "Maybe — review", cls: "bg-neutral-800 text-neutral-300 border-neutral-700" };
  return { label: "Likely legit", cls: "bg-emerald-950/70 text-emerald-300 border-emerald-900/60" };
}

function fmt(n: number) {
  const s = n >= 0 ? "" : "−";
  return s + "$" + Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export default function DuplicatesPage() {
  const [groups, setGroups] = useState<DupeGroup[] | null>(null);
  const [counts, setCounts] = useState<{ within: number; cross: number } | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [resolved, setResolved] = useState<Set<string>>(new Set());

  const load = () => {
    setGroups(null);
    fetch("/api/duplicates").then((r) => r.json()).then((d) => {
      setGroups(d.groups);
      setCounts(d.counts);
      setResolved(new Set());
    });
  };
  useEffect(() => { load(); }, []);

  async function deleteTx(txId: string) {
    setPending((p) => new Set(p).add(txId));
    await fetch("/api/duplicates", {
      method: "DELETE",
      body: JSON.stringify({ transactionId: txId }),
    });
    setPending((p) => { const n = new Set(p); n.delete(txId); return n; });
    // Optimistically remove the row from the local state.
    setGroups((cur) => {
      if (!cur) return cur;
      return cur
        .map((g) => ({ ...g, transactions: g.transactions.filter((t) => t.transactionId !== txId) }))
        .map((g) => g.transactions.length <= 1 ? { ...g, _resolved: true } as DupeGroup & { _resolved?: boolean } : g);
    });
  }

  // Mark group resolved without deleting anything (legitimate dupes). Persisted to
  // the duplicate_dismissals table so it won't reappear on reload.
  async function markResolved(key: string) {
    setResolved((r) => new Set(r).add(key));
    await fetch("/api/duplicates", { method: "POST", body: JSON.stringify({ key }) });
  }

  if (!groups) {
    return <p className="text-neutral-400 p-6">Loading duplicates...</p>;
  }

  const visibleGroups = groups.filter((g) => g.transactions.length > 1 && !resolved.has(g.key));

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Duplicate triage</h1>
          <p className="text-sm text-neutral-400 mt-1">
            For each group, click <span className="text-rose-400 font-medium">Delete</span> on rows that
            are wrong duplicates, or <span className="text-emerald-400 font-medium">Keep all</span> if the
            group is legitimate (real same-day duplicate purchases, etc.).
          </p>
        </div>
        <button
          onClick={load}
          className="text-xs px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 rounded-md text-neutral-300"
        >
          Reload
        </button>
      </div>

      {counts && (
        <div className="flex gap-3 text-sm">
          <div className="bg-neutral-900 border border-neutral-800 rounded-lg px-3 py-2">
            <span className="text-neutral-500">Within-account: </span>
            <span className="text-neutral-200 font-medium tabular-nums">{counts.within}</span>
          </div>
          <div className="bg-neutral-900 border border-neutral-800 rounded-lg px-3 py-2">
            <span className="text-neutral-500">Cross-account (Cap One ⇄ Venture X): </span>
            <span className="text-neutral-200 font-medium tabular-nums">{counts.cross}</span>
          </div>
          <div className="bg-neutral-900 border border-neutral-800 rounded-lg px-3 py-2 ml-auto">
            <span className="text-neutral-500">Visible: </span>
            <span className="text-neutral-200 font-medium tabular-nums">{visibleGroups.length}</span>
          </div>
        </div>
      )}

      {visibleGroups.length === 0 && (
        <div className="text-sm text-neutral-500 bg-neutral-900/40 border border-neutral-800 rounded-xl p-8 text-center">
          No duplicate groups left to triage.
        </div>
      )}

      <div className="space-y-4">
        {visibleGroups.map((g) => (
          <div key={g.key} className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 shadow-md shadow-black/20">
            <div className="flex items-baseline justify-between mb-3 gap-3">
              <div className="text-sm flex items-baseline gap-2 flex-wrap">
                {(() => {
                  const b = confidenceBadge(g.confidence);
                  return (
                    <span className={`text-xs uppercase font-semibold px-2 py-0.5 rounded border ${b.cls}`} title={`confidence ${(g.confidence * 100).toFixed(0)}%`}>
                      {b.label}
                    </span>
                  );
                })()}
                <span className={`text-xs uppercase font-medium px-2 py-0.5 rounded ${g.kind === "cross-account" ? "bg-amber-950 text-amber-300" : "bg-blue-950 text-blue-300"}`}>
                  {g.kind === "cross-account" ? "Cross-acct" : "Within-acct"}
                </span>
                <span className="text-neutral-400">{g.date}</span>
                <span className={`font-medium tabular-nums ${g.amount >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                  {fmt(g.amount)}
                </span>
                <span className="text-neutral-500">· {g.transactions.length} rows</span>
                <span className="text-neutral-500 italic w-full text-xs">{g.reason}</span>
              </div>
              <button
                onClick={() => markResolved(g.key)}
                className="text-xs px-3 py-1 bg-emerald-950/60 hover:bg-emerald-900/60 text-emerald-300 rounded-md border border-emerald-900/50 shrink-0"
              >
                ✓ Keep all
              </button>
            </div>
            <table className="w-full text-sm">
              <thead className="text-left text-neutral-500 text-xs uppercase tracking-wide">
                <tr>
                  <th className="py-1.5 pr-2 w-32">Account</th>
                  <th className="pr-2">Description</th>
                  <th className="pr-2 w-28">Category</th>
                  <th className="pr-2 w-20">Source</th>
                  <th className="pr-2 w-24" title="When the bank initiated the transaction. Differing values across rows = different events.">Transacted</th>
                  <th className="w-24"></th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  // Highlight transacted_at differences across the group — a strong "they're different" signal.
                  const txDates = new Set(g.transactions.map((t) => fmtTs(t.transactedAt)));
                  const txDiffer = txDates.size > 1;
                  return g.transactions.map((t) => (
                    <tr key={t.transactionId} className={`border-t border-neutral-800/60 ${pending.has(t.transactionId) ? "opacity-40" : ""}`}>
                      <td className="py-2 pr-2 text-xs text-neutral-400 truncate" title={t.accountName ?? ""}>{t.accountName}</td>
                      <td className="pr-2 truncate" title={t.description ?? t.payee ?? ""}>{t.description ?? t.payee}</td>
                      <td className="pr-2 text-xs text-neutral-400">{t.category ?? <span className="text-neutral-600">—</span>}</td>
                      <td className="pr-2 text-xs text-neutral-500">{t.source ?? "?"}</td>
                      <td className={`pr-2 text-xs tabular-nums ${txDiffer ? "text-amber-400 font-medium" : "text-neutral-500"}`}>
                        {fmtTs(t.transactedAt)}
                      </td>
                      <td className="text-right">
                        <button
                          disabled={pending.has(t.transactionId)}
                          onClick={() => deleteTx(t.transactionId)}
                          className="text-xs px-3 py-1 bg-rose-950/60 hover:bg-rose-900/60 text-rose-300 rounded-md border border-rose-900/50 disabled:opacity-50"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ));
                })()}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}
