"use client";

import { useEffect, useRef, useState } from "react";
import { useChat } from "ai/react";

interface Txn {
  transactionId: string;
  date: string;
  amount: number;
  description: string | null;
  payee: string | null;
  category: string | null;
  categoryConfidence: string | null;
  categoryAlternatives: string | null; // JSON-encoded string[]
  accountName?: string | null;
  accountOrgName?: string | null;
  accountType?: string | null;
}

interface PaycheckSplit { portion: string; amount: number; source: string | null }
interface NeighbourPaycheck { transactionId: string; date: string; amount: number; description: string | null; splits: PaycheckSplit[] }
interface Paycheck {
  transactionId: string;
  date: string;
  amount: number;
  description: string | null;
  splits: PaycheckSplit[];
  neighbours?: { prev: NeighbourPaycheck[]; next: NeighbourPaycheck[] };
}

interface Category { name: string; definition: string }

interface Progress {
  running: boolean;
  done: number;
  total: number;
  error?: string;
}

export default function ReviewPage() {
  const [txns, setTxns] = useState<Txn[]>([]);
  const [paychecks, setPaychecks] = useState<Paycheck[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [progress, setProgress] = useState<Progress>({ running: false, done: 0, total: 0 });
  const seenIds = useRef(new Set<string>());

  const load = async () => {
    const [rev, cats] = await Promise.all([
      fetch("/api/review").then((r) => r.json()),
      fetch("/api/categories").then((r) => r.json()),
    ]);
    setTxns(rev.transactions);
    rev.transactions.forEach((t: Txn) => seenIds.current.add(t.transactionId));
    setPaychecks(rev.paychecks);
    setCategories(cats.categories);
  };

  useEffect(() => { load(); }, []);

  function startCategorize() {
    setProgress({ running: true, done: 0, total: 0 });
    const es = new EventSource("/api/categorize/stream");
    es.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "start") {
        setProgress({ running: true, done: 0, total: msg.total });
      } else if (msg.type === "progress") {
        setProgress({ running: true, done: msg.done, total: msg.total });
        // Append any new low-confidence rows so the user can start verifying immediately.
        const newOnes: Txn[] = msg.justCategorized
          .filter((t: { needsReview: boolean; transactionId: string }) => t.needsReview && !seenIds.current.has(t.transactionId))
          .map((t: { transactionId: string; date: string; amount: number; description: string | null; payee: string | null; category: string; confidence: string; alternatives?: string[] }) => ({
            transactionId: t.transactionId,
            date: t.date,
            amount: t.amount,
            description: t.description,
            payee: t.payee,
            category: t.category,
            categoryConfidence: t.confidence,
            categoryAlternatives: t.alternatives && t.alternatives.length > 0 ? JSON.stringify(t.alternatives) : null,
          }));
        if (newOnes.length > 0) {
          newOnes.forEach((t) => seenIds.current.add(t.transactionId));
          setTxns((cur) => [...newOnes, ...cur]);
        }
      } else if (msg.type === "done") {
        setProgress({ running: false, done: msg.categorized, total: msg.total });
        es.close();
      } else if (msg.type === "error") {
        setProgress((p) => ({ ...p, running: false, error: msg.message }));
        es.close();
      }
    };
    es.onerror = () => {
      setProgress((p) => ({ ...p, running: false, error: "Stream disconnected" }));
      es.close();
    };
  }

  async function assignCategory(transactionId: string, category: string) {
    await fetch("/api/categories", {
      method: "PATCH",
      body: JSON.stringify({ transactionId, category }),
    });
    setTxns((cur) => cur.filter((t) => t.transactionId !== transactionId));
  }

  // Promote the LLM's guess to user-confirmed without changing the category.
  async function confirmLlmGuess(t: Txn) {
    if (!t.category) return;
    await assignCategory(t.transactionId, t.category);
  }

  // Confirm every visible row's LLM guess in one shot. Rows without a guess are skipped.
  async function confirmAllVisible() {
    const confirmable = txns.filter((t) => t.category);
    if (confirmable.length === 0) return;
    await Promise.all(confirmable.map((t) =>
      fetch("/api/categories", {
        method: "PATCH",
        body: JSON.stringify({ transactionId: t.transactionId, category: t.category }),
      })
    ));
    const confirmedIds = new Set(confirmable.map((t) => t.transactionId));
    setTxns((cur) => cur.filter((t) => !confirmedIds.has(t.transactionId)));
  }

  async function confirmSplit(p: Paycheck, regular: number, bonus: number) {
    await fetch("/api/paychecks", {
      method: "POST",
      body: JSON.stringify({ transactionId: p.transactionId, regular, bonus }),
    });
    setPaychecks((cur) => cur.filter((x) => x.transactionId !== p.transactionId));
  }

  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="space-y-10 max-w-6xl">
      {/* Categorization status + control */}
      <section className="bg-neutral-900 rounded p-4 flex items-center gap-4">
        <button
          onClick={startCategorize}
          disabled={progress.running}
          className="px-4 py-2 bg-blue-600 rounded disabled:opacity-50"
        >
          {progress.running ? "Categorizing..." : "Start categorization"}
        </button>
        <div className="flex-1">
          {(progress.running || progress.total > 0) && (
            <>
              <div className="text-sm text-neutral-400 mb-1">
                {progress.done} / {progress.total} ({pct}%)
                {progress.error && <span className="text-red-400 ml-2">— {progress.error}</span>}
              </div>
              <div className="w-full bg-neutral-800 rounded h-2 overflow-hidden">
                <div className="bg-blue-500 h-full transition-all" style={{ width: `${pct}%` }} />
              </div>
            </>
          )}
        </div>
      </section>

      {/* Categorization chat assistant — isolated to bulk-categorization tools only. */}
      <CategorizationAssistant onApplied={load} />

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Categorization ({txns.length})</h1>
          {txns.some((t) => t.category) && (
            <button
              onClick={confirmAllVisible}
              className="px-3 py-1.5 text-sm bg-green-700 hover:bg-green-600 rounded"
            >
              ✓ Confirm all visible LLM guesses
            </button>
          )}
        </div>
        <p className="text-sm text-neutral-400">
          Transactions the LLM was <strong>unsure</strong> or only <strong>somewhat sure</strong> about.
          Hit <strong>✓ Keep</strong> if the guess is right, or pick a different category.
          New ones appear live as categorization runs.
        </p>
        <table className="w-full text-sm table-fixed">
          <colgroup>
            <col className="w-24" />
            <col />
            <col className="w-36" />
            <col className="w-24" />
            <col className="w-24" />
            <col />
            <col className="w-40" />
          </colgroup>
          <thead className="text-left text-neutral-400">
            <tr><th className="py-2">Date</th><th>Description</th><th>Account</th><th className="text-right pr-3">Amount</th><th>Confidence</th><th>LLM guesses (click to confirm)</th><th>Or change to</th></tr>
          </thead>
          <tbody>
            {txns.map((t) => {
              const alts: string[] = t.categoryAlternatives ? JSON.parse(t.categoryAlternatives) : [];
              const guesses = [t.category, ...alts].filter((c): c is string => !!c).slice(0, 3);
              const acctLabel = [t.accountOrgName, t.accountName].filter(Boolean).join(" · ");
              return (
                <tr key={t.transactionId} className="border-t border-neutral-800 align-top">
                  <td className="py-2">{t.date}</td>
                  <td className="truncate pr-3 py-2" title={t.description ?? t.payee ?? ""}>{t.description ?? t.payee}</td>
                  <td className="truncate pr-3 py-2 text-xs text-neutral-400" title={acctLabel}>
                    {t.accountOrgName ?? ""}
                    {t.accountType === "credit" && <span className="ml-1 text-amber-400">cc</span>}
                    {t.accountName && <div className="truncate text-[10px] text-neutral-500">{t.accountName}</div>}
                  </td>
                  <td className="text-right pr-3 tabular-nums py-2">{t.amount.toFixed(2)}</td>
                  <td className={`py-2 ${t.categoryConfidence === "unsure" ? "text-amber-300" : "text-neutral-400"}`}>
                    {t.categoryConfidence?.replace("_", " ")}
                  </td>
                  <td className="py-2">
                    <div className="flex flex-wrap gap-1">
                      {guesses.map((g, idx) => (
                        <button
                          key={g}
                          onClick={() => assignCategory(t.transactionId, g)}
                          className={`px-2 py-1 rounded text-xs ${idx === 0 ? "bg-green-700 hover:bg-green-600 text-white" : "bg-neutral-800 hover:bg-neutral-700 text-neutral-200"}`}
                          title={idx === 0 ? `LLM's top guess: ${g}` : `Alternative #${idx}: ${g}`}
                        >
                          {idx === 0 ? "✓ " : ""}{g}
                        </button>
                      ))}
                    </div>
                  </td>
                  <td className="py-2">
                    <select
                      defaultValue=""
                      onChange={(e) => e.target.value && assignCategory(t.transactionId, e.target.value)}
                      className="bg-neutral-900 rounded px-2 py-1 w-full"
                    >
                      <option value="" disabled>pick...</option>
                      {categories.map((c) => (
                        <option key={c.name} value={c.name}>{c.name}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="space-y-3">
        <h2 className="text-2xl font-semibold">Paycheck splits ({paychecks.length})</h2>
        <p className="text-sm text-neutral-400">
          Auto-split based on the median of nearby same-source paychecks. Each pending row is shown with
          ±2 neighbours from the same category for context — use them to decide what the regular vs bonus
          split should be.
        </p>
        <div className="space-y-4">
          {paychecks.map((p) => (
            <PaycheckGroup key={p.transactionId} p={p} onConfirm={confirmSplit} />
          ))}
        </div>
      </section>
    </div>
  );
}

function PaycheckGroup({ p, onConfirm }: { p: Paycheck; onConfirm: (p: Paycheck, r: number, b: number) => void }) {
  const total = Math.abs(p.amount);
  const reg0 = p.splits.find((s) => s.portion === "regular")?.amount ?? total;
  const bon0 = p.splits.find((s) => s.portion === "bonus")?.amount ?? 0;
  // Single state so a setVals always writes both at once — no risk of one update
  // getting dropped or a stale closure capturing the wrong total.
  const [vals, setVals] = useState({ reg: reg0, bon: bon0 });
  const round2 = (n: number) => Math.max(0, Number(n.toFixed(2)));

  function handleReg(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value === "" ? 0 : Number(e.target.value);
    if (Number.isNaN(v)) return;
    setVals({ reg: v, bon: round2(total - v) });
  }
  function handleBon(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value === "" ? 0 : Number(e.target.value);
    if (Number.isNaN(v)) return;
    setVals({ reg: round2(total - v), bon: v });
  }

  const prev = p.neighbours?.prev ?? [];
  const next = p.neighbours?.next ?? [];

  return (
    <div className="border border-neutral-800 rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead className="text-left text-neutral-500 text-xs uppercase tracking-wide bg-neutral-900/60">
          <tr>
            <th className="px-3 py-1.5 w-28">Date</th>
            <th className="py-1.5">Description</th>
            <th className="py-1.5 w-24 text-right">Total</th>
            <th className="py-1.5 w-24 text-right">Regular</th>
            <th className="py-1.5 w-24 text-right">Bonus</th>
            <th className="px-3 py-1.5 w-28"></th>
          </tr>
        </thead>
        <tbody>
          {prev.map((n) => <ContextRow key={n.transactionId} n={n} />)}
          <tr className="border-t border-neutral-800 bg-blue-950/20">
            <td className="px-3 py-2 text-neutral-200 font-medium">{p.date}</td>
            <td className="text-neutral-200 truncate">{p.description}</td>
            <td className="text-right tabular-nums font-medium">{total.toFixed(2)}</td>
            <td className="text-right">
              <input type="number" value={vals.reg} onChange={handleReg}
                className="w-24 bg-neutral-900 border border-neutral-700 px-2 py-1 rounded tabular-nums text-right focus:outline-none focus:border-blue-500" />
            </td>
            <td className="text-right">
              <input type="number" value={vals.bon} onChange={handleBon}
                className="w-24 bg-neutral-900 border border-neutral-700 px-2 py-1 rounded tabular-nums text-right focus:outline-none focus:border-blue-500" />
            </td>
            <td className="px-3 text-right">
              <button onClick={() => onConfirm(p, vals.reg, vals.bon)}
                className="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-xs">Confirm</button>
            </td>
          </tr>
          {next.map((n) => <ContextRow key={n.transactionId} n={n} />)}
        </tbody>
      </table>
    </div>
  );
}

// Read-only neighbour row, dimmed so the user knows which one is editable.
function ContextRow({ n }: { n: NeighbourPaycheck }) {
  const total = Math.abs(n.amount);
  const reg = n.splits.find((s) => s.portion === "regular")?.amount ?? total;
  const bon = n.splits.find((s) => s.portion === "bonus")?.amount ?? 0;
  const userSet = n.splits.some((s) => s.source === "user");
  return (
    <tr className="border-t border-neutral-800/60 text-neutral-500">
      <td className="px-3 py-1.5 text-xs">{n.date}</td>
      <td className="text-xs truncate" title={n.description ?? ""}>{n.description}</td>
      <td className="text-right tabular-nums text-xs">{total.toFixed(2)}</td>
      <td className="text-right tabular-nums text-xs">{reg.toFixed(2)}</td>
      <td className="text-right tabular-nums text-xs">{bon.toFixed(2)}</td>
      <td className="px-3 text-right text-[10px]">{userSet ? <span className="text-blue-400">user-set</span> : <span>auto</span>}</td>
    </tr>
  );
}

// Chat tied to /api/categorize/chat. Tools are scoped to bulk-categorization only:
// findPending, previewMatches, bulkCategorize, listCategories. Whenever the model
// applies a bulkCategorize, we refresh the parent table so categorized rows disappear.
function CategorizationAssistant({ onApplied }: { onApplied: () => void }) {
  const { messages, input, handleInputChange, handleSubmit, isLoading } = useChat({
    api: "/api/categorize/chat",
    onFinish: (msg) => {
      // If the model invoked bulkCategorize this turn, refresh the table.
      const usedBulk = (msg as unknown as { toolInvocations?: { toolName: string }[] }).toolInvocations
        ?.some((t) => t.toolName === "bulkCategorize");
      if (usedBulk) onApplied();
    },
  });

  // Auto-scroll the message list to the bottom as new messages stream in.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, isLoading]);

  return (
    <section className="bg-neutral-900 rounded p-4 space-y-3">
      <h2 className="text-lg font-semibold">Bulk-categorize with rules</h2>
      <p className="text-sm text-neutral-400">
        Say things like <em>&quot;MBTA is always Transit&quot;</em> or <em>&quot;CVS is always Medical&quot;</em>.
        The assistant will preview matches and apply on your confirmation.
      </p>
      <div ref={scrollRef} className="max-h-80 overflow-y-auto space-y-3 text-sm">
        {messages.map((m) => (
          <div key={m.id} className={m.role === "user" ? "text-blue-300" : "text-neutral-100"}>
            <div className="text-xs uppercase opacity-60">{m.role}</div>
            <div className="whitespace-pre-wrap">{m.content}</div>
          </div>
        ))}
        {isLoading && <div className="text-neutral-500">…</div>}
      </div>
      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          value={input}
          onChange={handleInputChange}
          placeholder="Example: 'CVS is always Medical'"
          className="flex-1 bg-neutral-800 rounded px-3 py-2"
        />
        <button className="px-4 py-2 bg-blue-600 rounded">Send</button>
      </form>
    </section>
  );
}
