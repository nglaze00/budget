"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "ai/react";
import ReactMarkdown from "react-markdown";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, ReferenceLine, Cell, AreaChart, Area, Brush, LabelList, Line, ComposedChart,
} from "recharts";

interface Stats {
  month: string;
  windowStart: string;
  windowEnd: string;
  monthlySpend: { month: string; total: number; income: number; net: number }[];
  yoySpend: { year: string; total: number }[];
  categorySpend: { category: string; current_month: number; txn_count: number }[];
  categoryMonthly: { category: string; month: string; total: number }[];
  anomalies: { transaction_id: string; date: string; description: string; payee: string; amount: number; category: string; category_p90: number; category_median: number; category_count: number }[];
  cashFlow: { direction: string; total: number }[];
  cashFlowDaily: { date: string; net: number; in_total: number; out_total: number }[];
  coverage: { org_name: string; org_domain: string; account_type: string; last_txn_date: string; txn_count: number }[];
  investmentAccounts: { account_id: string; name: string; balance: number; balance_date: string; contributions: number }[];
  netWorth: { cash: number; investments: number; credit: number; total: number };
}

function fmt(n: number) {
  return "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
function fmtSigned(n: number) {
  return (n >= 0 ? "+" : "−") + "$" + Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
}
function pct(n: number) {
  return (n >= 0 ? "+" : "") + n.toFixed(0) + "%";
}
// Color a category bar based on current-month vs median ratio.
// Below median ⇒ green (deeper green the further below); at median ⇒ neutral slate;
// above median ⇒ rose (deeper rose the further above). Interpolated through 4 anchor
// stops (Tailwind palette) for smooth, non-neon colors that match the rest of the UI.
function colorForRatio(current: number, median: number): string {
  if (median <= 0 || current <= 0) return "#3b82f6"; // no comparison possible
  const ratio = current / median;
  // Anchors as RGB triples. Picked to look right on a neutral-900 background.
  const deepGreen = [4, 120, 87];    // emerald-700
  const green = [52, 211, 153];      // emerald-400
  const neutral = [120, 113, 108];   // stone-500 — calm at the median
  const red = [244, 63, 94];         // rose-500
  const deepRed = [136, 19, 55];     // rose-900
  const lerp = (a: number[], b: number[], t: number) =>
    `rgb(${a.map((c, i) => Math.round(c + (b[i] - c) * t)).join(", ")})`;
  if (ratio < 0.5) return lerp(deepGreen, green, ratio / 0.5);
  if (ratio < 1.0) return lerp(green, neutral, (ratio - 0.5) / 0.5);
  if (ratio < 2.0) return lerp(neutral, red, (ratio - 1.0) / 1.0);
  return lerp(red, deepRed, Math.min(1, (ratio - 2.0) / 1.0));
}

// Median of a numeric array; 0 for empty input.
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [month, setMonth] = useState<string>(() => new Date().toISOString().slice(0, 7));
  const [drilldown, setDrilldown] = useState<string | null>(null);

  useEffect(() => {
    setStats(null);
    setDrilldown(null);
    fetch(`/api/stats?before=2&after=2&month=${month}`).then((r) => r.json()).then(setStats);
  }, [month]);

  const monthLabel = new Date(`${month}-01T00:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const monthShort = new Date(`${month}-01T00:00:00`).toLocaleDateString(undefined, { month: "short" });

  return (
    <div className="flex gap-6 max-w-[110rem] mx-auto">
      {/* Main dashboard column — fills remaining width when the chat pane is visible. */}
      <div className="flex-1 min-w-0 space-y-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Dashboard</h1>
            <p className="text-sm text-neutral-400 mt-0.5">{monthLabel}</p>
          </div>
          <MonthPicker month={month} monthLabel={monthLabel} onChange={setMonth} />
        </div>

        {!stats ? (
          <p className="text-neutral-400">Loading {monthLabel}...</p>
        ) : (
          <DashboardBody
            stats={stats}
            month={month}
            setMonth={setMonth}
            monthLabel={monthLabel}
            monthShort={monthShort}
            drilldown={drilldown}
            setDrilldown={setDrilldown}
          />
        )}
      </div>

      {/* Chat pane — sticky on the right, hidden on narrow screens. */}
      <aside className="hidden xl:block w-[360px] shrink-0">
        <div className="sticky top-4 h-[calc(100vh-2rem)]">
          <ChatPanel context={buildChatContext({ stats, month, monthLabel, drilldown })} />
        </div>
      </aside>
    </div>
  );
}

function DashboardBody({ stats, month, setMonth, monthLabel, monthShort, drilldown, setDrilldown }: {
  stats: Stats;
  month: string;
  setMonth: (s: string) => void;
  monthLabel: string;
  monthShort: string;
  drilldown: string | null;
  setDrilldown: (s: string | null) => void;
}) {
  // ---- Derived numbers ----------------------------------------------------
  const currentSpend = stats.monthlySpend.find((m) => m.month === month)?.total ?? 0;

  const priorMonthKey = (() => {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(y, m - 2, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  })();
  const priorMonthSpend = stats.monthlySpend.find((m) => m.month === priorMonthKey)?.total ?? null;
  const momDelta = priorMonthSpend && priorMonthSpend > 0
    ? ((currentSpend - priorMonthSpend) / priorMonthSpend) * 100
    : null;

  // Median across the visible window (excluding any synthetic zero-fill months
  // would be tempting, but the API only zero-fills the window itself — those months are
  // really months with no spend, so they're fair game for the median).
  const windowMedian = median(stats.monthlySpend.map((m) => m.total));
  const windowSize = stats.monthlySpend.length;

  const yoyCurrentYear = month.slice(0, 4);
  const yoyPrior = stats.yoySpend.filter((y) => y.year < yoyCurrentYear).slice(-1)[0];
  const yoyDelta = yoyPrior && yoyPrior.total > 0 ? ((currentSpend - yoyPrior.total) / yoyPrior.total) * 100 : null;

  const cashIn = stats.cashFlow.find((c) => c.direction === "in")?.total ?? 0;
  const cashOut = stats.cashFlow.find((c) => c.direction === "out")?.total ?? 0;
  const cashNet = cashIn - cashOut;

  const invTotal = stats.investmentAccounts.reduce((s, a) => s + a.balance, 0);
  const invContribThisMonth = stats.investmentAccounts.reduce((s, a) => s + a.contributions, 0);

  // Per-category median + current month + delta vs median.
  const categoryRows = useMemo(() => {
    const byCat = new Map<string, number[]>();
    for (const r of stats.categoryMonthly) {
      const list = byCat.get(r.category) ?? [];
      list.push(r.total);
      byCat.set(r.category, list);
    }
    const rows = stats.categorySpend.map((c) => {
      const med = median(byCat.get(c.category) ?? []);
      return {
        category: c.category,
        current_month: c.current_month,
        txn_count: c.txn_count,
        median_monthly: med,
        delta: c.current_month - med,
        pct: med > 0 ? ((c.current_month - med) / med) * 100 : null,
      };
    });
    // Pick up categories that have history this window but no current-month spend.
    for (const [cat, totals] of byCat.entries()) {
      if (!rows.find((r) => r.category === cat)) {
        const med = median(totals);
        if (med > 0) {
          rows.push({ category: cat, current_month: 0, txn_count: 0, median_monthly: med, delta: -med, pct: -100 });
        }
      }
    }
    return rows.sort((a, b) => b.median_monthly - a.median_monthly);
  }, [stats.categorySpend, stats.categoryMonthly]);

  // Income up / spend down so positive=in, negative=out — same visual idiom as cash flow.
  const monthlyTrend = stats.monthlySpend.map((m) => ({
    ...m,
    spend_negative: -m.total,
    isCurrent: m.month === month,
  }));
  const currentIncome = stats.monthlySpend.find((m) => m.month === month)?.income ?? 0;
  const currentNet = stats.monthlySpend.find((m) => m.month === month)?.net ?? 0;

  // Top movers: biggest absolute swing vs median.
  const movers = useMemo(() => {
    return categoryRows
      .filter((c) => c.median_monthly > 0 && c.pct != null)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 4);
  }, [categoryRows]);

  // ── Derived KPI inputs ───────────────────────────────────────────────────
  // Savings rate this month (clamped to [-100%, 100%] for display sanity).
  const savingsRate = currentIncome > 0 ? (currentNet / currentIncome) * 100 : null;
  // Median savings rate across the window — bench for "is my saving rate normal?"
  const medianSavingsRate = useMemo(() => {
    const ratios = stats.monthlySpend
      .filter((m) => m.income > 0)
      .map((m) => (m.net / m.income) * 100);
    if (ratios.length === 0) return null;
    return median(ratios);
  }, [stats.monthlySpend]);

  // Pace: only meaningful when the anchor month is the current calendar month.
  // For past months we just show the actual total without a "on pace" suffix.
  const today = new Date();
  const [yearNum, monthNum] = month.split("-").map(Number);
  const isCurrentCalMonth = today.getFullYear() === yearNum && (today.getMonth() + 1) === monthNum;
  const daysInMonth = new Date(yearNum, monthNum, 0).getDate();
  const daysElapsed = isCurrentCalMonth ? today.getDate() : daysInMonth;
  const dailySpend = daysElapsed > 0 ? currentSpend / daysElapsed : 0;
  const projectedSpend = isCurrentCalMonth ? dailySpend * daysInMonth : currentSpend;

  return (
    <div className="space-y-8">
      {/* ─── KPI strip ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi
          label="Saved this month"
          value={fmtSigned(currentNet)}
          valueColor={currentNet >= 0 ? "text-emerald-400" : "text-rose-400"}
          sub={
            savingsRate != null ? (
              <span className="text-neutral-400">
                <span className={savingsRate >= 0 ? "text-emerald-400" : "text-rose-400"}>{savingsRate.toFixed(0)}%</span> of income
                {medianSavingsRate != null && (
                  <span className="text-neutral-500"> · median {medianSavingsRate.toFixed(0)}%</span>
                )}
              </span>
            ) : (
              <span className="text-neutral-500">no income recorded</span>
            )
          }
        />
        <Kpi
          label={isCurrentCalMonth ? "On pace for" : "Spent"}
          value={fmt(projectedSpend)}
          valueColor={
            windowMedian > 0
              ? projectedSpend > windowMedian * 1.05 ? "text-rose-400"
              : projectedSpend < windowMedian * 0.95 ? "text-emerald-400"
              : ""
              : ""
          }
          sub={
            <span className="text-neutral-400">
              {isCurrentCalMonth
                ? <>${dailySpend.toFixed(0)}/day · day {daysElapsed} of {daysInMonth}</>
                : <>{windowMedian > 0 ? pct(((currentSpend - windowMedian) / windowMedian) * 100) + " vs " + windowSize + "-mo median" : ""}</>}
            </span>
          }
        />
        <Kpi
          label="Cash flow (Chase)"
          value={fmtSigned(cashNet)}
          valueColor={cashNet >= 0 ? "text-emerald-400" : "text-rose-400"}
          sub={<span className="text-neutral-400">{fmt(cashIn)} in · {fmt(cashOut)} out</span>}
        />
        <Kpi
          label="Net worth"
          value={fmt(stats.netWorth.total)}
          valueColor={stats.netWorth.total >= 0 ? "text-emerald-400" : "text-rose-400"}
          sub={
            <span className="text-neutral-400">
              <span className="text-neutral-300">{fmt(stats.netWorth.investments)}</span> invest
              <span className="mx-1 text-neutral-700">·</span>
              <span className="text-neutral-300">{fmt(stats.netWorth.cash)}</span> cash
              {stats.netWorth.credit < 0 && (
                <>
                  <span className="mx-1 text-neutral-700">·</span>
                  <span className="text-rose-300">{fmt(Math.abs(stats.netWorth.credit))}</span> debt
                </>
              )}
            </span>
          }
        />
      </div>

      {/* ─── Monthly income / spending / net ──────────────────────────── */}
      <Card title="Income, spending & net" subtitle={`${windowSize}-month window · income above zero, spending below · click a bar to jump`}>
        <div className="grid md:grid-cols-3 gap-6">
          <div className="md:col-span-2">
            <ResponsiveContainer width="100%" height={260}>
              <ComposedChart
                data={monthlyTrend}
                stackOffset="sign"
                onClick={(e: { activeLabel?: string }) => e?.activeLabel && setMonth(e.activeLabel)}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#262626" />
                <XAxis dataKey="month" tick={{ fill: "#999", fontSize: 12 }} />
                <YAxis
                  tick={{ fill: "#999", fontSize: 12 }}
                  tickFormatter={(v) => `$${Math.abs(v / 1000).toFixed(0)}k`}
                />
                <Tooltip content={<MonthlyFlowTooltip />} cursor={{ fill: "#1f2937", opacity: 0.3 }} />
                <ReferenceLine y={0} stroke="#525252" />
                <Bar dataKey="income" name="Income" stackId="flow" radius={[4, 4, 0, 0]} isAnimationActive={false} style={{ cursor: "pointer" }}>
                  {monthlyTrend.map((row) => (
                    <Cell key={row.month} fill={row.isCurrent ? "#10b981" : "#065f46"} />
                  ))}
                </Bar>
                <Bar dataKey="spend_negative" name="Spent" stackId="flow" radius={[0, 0, 4, 4]} isAnimationActive={false} style={{ cursor: "pointer" }}>
                  {monthlyTrend.map((row) => (
                    <Cell key={row.month} fill={row.isCurrent ? "#ef4444" : "#7f1d1d"} />
                  ))}
                </Bar>
                {/* Net line overlay — light gold so it reads as a distinct "result" of
                    the green/red bars without competing with them visually. */}
                <Line
                  type="monotone"
                  dataKey="net"
                  name="Net"
                  stroke="#fbbf24"
                  strokeWidth={2.5}
                  dot={{ fill: "#fbbf24", r: 4, strokeWidth: 0 }}
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div className="space-y-3 text-sm">
            {/* Income-vs-spent visual bar with dollar labels — replaces the redundant
                Income / Spent / Net rows since those are already in the KPI strip. */}
            <IncomeSpendBar income={currentIncome} spent={currentSpend} />
            <div className="pt-1 space-y-1.5">
              <Stat label={`${windowSize}-mo median spend`} value={fmt(windowMedian)} />
              {priorMonthSpend != null && (
                <DiffStat label="vs last month" diff={currentSpend - priorMonthSpend} percent={momDelta} />
              )}
              {yoyPrior && (
                <DiffStat label={`vs ${monthShort} last year`} diff={currentSpend - yoyPrior.total} percent={yoyDelta} />
              )}
            </div>
          </div>
        </div>
      </Card>

      {/* ─── Categories ───────────────────────────────────────────────── */}
      <Card
        title="Spending by category"
        subtitle="Bar color: green = under median, red = over · gray dot = 12-mo median · sorted by 12-mo median · click a row for transactions"
      >
        {movers.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-4">
            {movers.map((m) => (
              <button
                key={m.category}
                onClick={() => setDrilldown(m.category)}
                className={`text-xs rounded-full px-3 py-1.5 border ${
                  m.delta > 0
                    ? "border-rose-900/60 bg-rose-950/40 text-rose-200 hover:bg-rose-950/60"
                    : "border-emerald-900/60 bg-emerald-950/40 text-emerald-200 hover:bg-emerald-950/60"
                }`}
                title={`${fmt(m.current_month)} this month vs ${fmt(m.median_monthly)} median`}
              >
                <span className="font-medium">{m.category}</span>{" "}
                <span className="opacity-80">{pct(m.pct ?? 0)}</span>{" "}
                <span className="opacity-60">({fmtSigned(m.delta)})</span>
              </button>
            ))}
          </div>
        )}

        <ResponsiveContainer width="100%" height={Math.max(260, categoryRows.length * 42)}>
          <BarChart
            data={categoryRows}
            layout="vertical"
            margin={{ left: 170, right: 90 }}
            // Wider gap between category rows so the gray median dot clearly belongs to
            // the blue bar above it, with empty space separating it from the next row.
            barCategoryGap="40%"
            barGap={2}
            onClick={(e: { activeLabel?: string }) => e?.activeLabel && setDrilldown(e.activeLabel)}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#262626" horizontal={false} />
            <XAxis type="number" tick={{ fill: "#999", fontSize: 12 }} tickFormatter={(v) => `$${v}`} />
            <YAxis type="category" dataKey="category" tick={{ fill: "#d4d4d4", fontSize: 12 }} width={170} interval={0} />
            <Tooltip content={<CategoryTooltip />} cursor={{ fill: "#1f2937", opacity: 0.3 }} />
            <Bar dataKey="current_month" name="This month" radius={[0, 4, 4, 0]} barSize={16} style={{ cursor: "pointer" }}>
              {categoryRows.map((row) => (
                <Cell
                  key={row.category}
                  fill={row.category === drilldown ? "#60a5fa" : colorForRatio(row.current_month, row.median_monthly)}
                />
              ))}
              <LabelList
                dataKey="current_month"
                position="right"
                formatter={(v: number) => (v > 0 ? fmt(v) : "")}
                style={{ fill: "#d4d4d4", fontSize: 12, fontVariantNumeric: "tabular-nums" }}
              />
            </Bar>
            <Bar dataKey="median_monthly" name="12-mo median" fill="#525252" radius={[0, 4, 4, 0]} barSize={6} />
          </BarChart>
        </ResponsiveContainer>

        {/* Total across the visible categories, aligned with the chart's right edge. */}
        <div className="mt-2 flex items-center justify-between border-t border-neutral-800 pt-2 pr-[90px]">
          <span className="text-sm font-medium text-neutral-300 pl-[170px]">Total</span>
          <span className="text-sm font-semibold tabular-nums text-blue-300">
            {fmt(categoryRows.reduce((s, r) => s + r.current_month, 0))}
          </span>
        </div>

        {drilldown && (
          <CategoryDrilldown
            month={month}
            category={drilldown}
            monthLabel={monthLabel}
            onClose={() => setDrilldown(null)}
          />
        )}
      </Card>

      <InflowsCard month={month} monthLabel={monthLabel} />

      {/* ─── Unusual purchases ────────────────────────────────────────── */}
      {stats.anomalies.length > 0 && (
        <Card title="Unusual purchases" subtitle="Transactions in the top 10% of size for their category">
          <div className="space-y-2">
            {stats.anomalies.map((a) => (
              <div key={a.transaction_id} className="flex items-center justify-between bg-neutral-900/50 rounded px-3 py-2 text-sm">
                <div className="min-w-0 pr-3">
                  <div className="truncate font-medium">{a.payee || a.description}</div>
                  <div className="text-xs text-neutral-500">{a.category} · {a.date}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-rose-400 font-semibold tabular-nums">{fmt(a.amount)}</div>
                  <div className="text-xs text-neutral-500">
                    top 10% for {a.category.toLowerCase()} (≥ {fmt(a.category_p90)})
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ─── Cash flow history ───────────────────────────────────────── */}
      <CashFlowHistoryCard
        currentMonth={month}
        cashIn={cashIn}
        cashOut={cashOut}
        cashNet={cashNet}
        monthLabel={monthLabel}
      />

      {/* ─── Investments ──────────────────────────────────────────────── */}
      <div className="grid md:grid-cols-1 gap-4">
        <Card title="Investments" subtitle="Fidelity accounts · current market value">
          {stats.investmentAccounts.length === 0 ? (
            <p className="text-sm text-neutral-500 py-6 text-center">No Fidelity accounts connected.</p>
          ) : (
            <>
              <div className="flex items-baseline gap-3 mb-4">
                <span className="text-3xl font-semibold tabular-nums">{fmt(invTotal)}</span>
                {invContribThisMonth !== 0 && (
                  <span className={`text-sm ${invContribThisMonth > 0 ? "text-emerald-400" : "text-neutral-400"}`}>
                    {fmtSigned(invContribThisMonth)} contributed {monthShort}
                  </span>
                )}
              </div>
              <div className="space-y-2">
                {stats.investmentAccounts.map((a) => {
                  const share = invTotal > 0 ? (a.balance / invTotal) * 100 : 0;
                  return (
                    <div key={a.account_id} className="bg-neutral-900/50 rounded p-3">
                      <div className="flex items-center justify-between text-sm">
                        <span className="truncate pr-2" title={a.name}>{a.name}</span>
                        <span className="tabular-nums font-medium">{fmt(a.balance)}</span>
                      </div>
                      <div className="mt-1.5 flex items-center gap-2">
                        <div className="flex-1 h-1.5 bg-neutral-800 rounded-full overflow-hidden">
                          <div className="h-full bg-violet-500" style={{ width: `${share}%` }} />
                        </div>
                        <span className="text-xs text-neutral-500 tabular-nums w-10 text-right">{share.toFixed(0)}%</span>
                      </div>
                      {a.contributions !== 0 && (
                        <div className="mt-1 text-xs text-neutral-500">
                          {fmtSigned(a.contributions)} {monthShort}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <p className="mt-3 text-xs text-neutral-500">
                Market gains/losses aren&apos;t shown as activity — only contributions and withdrawals.
              </p>
            </>
          )}
        </Card>
      </div>

    </div>
  );
}

// ── Primitives ─────────────────────────────────────────────────────────────
// Each major dashboard section uses this card. Solid background + border + shadow give
// it real elevation so sections look distinct from each other and from the page bg.
function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 shadow-lg shadow-black/30 ring-1 ring-white/[0.02]">
      <div className="mb-5 pb-3 border-b border-neutral-800/70">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {subtitle && <p className="text-xs text-neutral-400 mt-1">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

// KPI cards stay lighter so they read as a strip of stats, not full sections.
function Kpi({ label, value, sub, valueColor }: { label: string; value: string; sub?: React.ReactNode; valueColor?: string }) {
  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 shadow-md shadow-black/20">
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className={`mt-1.5 text-2xl font-semibold tabular-nums ${valueColor ?? ""}`}>{value}</div>
      {sub && <div className="mt-1 text-xs">{sub}</div>}
    </div>
  );
}

// Income vs spent visual + dollar labels. Each bar is scaled relative to the larger
// of the two values, so you can eyeball whether you're saving or overspending. The
// dollar values sit inline so this block replaces the redundant Income/Spent/Net stat
// rows entirely.
function IncomeSpendBar({ income, spent }: { income: number; spent: number }) {
  const total = Math.max(income, spent, 1);
  const incomePct = (income / total) * 100;
  const spentPct = (spent / total) * 100;
  const saving = income >= spent;
  return (
    <div className="space-y-2 pb-3 border-b border-neutral-800">
      <div className="text-xs text-neutral-500 flex items-baseline justify-between">
        <span>Income vs spent</span>
        <span className={`text-[10px] uppercase tracking-wide font-medium ${saving ? "text-emerald-400" : "text-rose-400"}`}>
          {saving ? "saving" : "overspending"}
        </span>
      </div>
      <div className="space-y-1.5">
        <BarLine color="bg-emerald-500" label="Income" amount={income} pct={incomePct} accent="text-emerald-300" />
        <BarLine color="bg-rose-500" label="Spent" amount={spent} pct={spentPct} accent="text-rose-300" />
      </div>
    </div>
  );
}
function BarLine({ color, label, amount, pct, accent }: { color: string; label: string; amount: number; pct: number; accent: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-neutral-400 w-12 shrink-0">{label}</span>
      <div className="relative flex-1 h-2.5 bg-neutral-900 rounded overflow-hidden">
        <div className={`absolute inset-y-0 left-0 ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`text-xs tabular-nums w-16 text-right ${accent}`}>{fmt(amount)}</span>
    </div>
  );
}

// Like Stat but for "vs prior period" — shows just the delta dollars (signed) with
// the percent in tiny text. Positive diff (current spent more than prior) is rose;
// negative is emerald. Used for the historical comparisons in the side panel where
// the raw prior-period value isn't useful on its own.
function DiffStat({ label, diff, percent }: { label: string; diff: number; percent: number | null }) {
  const isUp = diff > 0;
  const isFlat = diff === 0;
  return (
    <div className="flex items-baseline justify-between border-b border-neutral-800 py-1.5 last:border-0">
      <span className="text-neutral-400">{label}</span>
      <span className="flex items-baseline gap-2">
        <span className={`tabular-nums ${isFlat ? "text-neutral-400" : isUp ? "text-rose-400" : "text-emerald-400"}`}>
          {fmtSigned(diff)}
        </span>
        {percent != null && (
          <span className={`text-xs ${isUp ? "text-rose-400" : "text-emerald-400"}`}>{pct(percent)}</span>
        )}
      </span>
    </div>
  );
}

function Stat({ label, value, delta }: { label: string; value: string; delta?: number | null }) {
  return (
    <div className="flex items-baseline justify-between border-b border-neutral-800 py-1.5 last:border-0">
      <span className="text-neutral-400">{label}</span>
      <span className="flex items-baseline gap-2">
        <span className="tabular-nums">{value}</span>
        {delta != null && (
          <span className={`text-xs ${delta > 0 ? "text-rose-400" : "text-emerald-400"}`}>{pct(delta)}</span>
        )}
      </span>
    </div>
  );
}

function MiniStat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="bg-neutral-900/50 rounded p-2.5">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className={`text-base font-semibold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}

// Custom tooltip for the category chart. Reads current-month + median + delta directly
// off the row so the values are always present, even when one of the bars happens to be
// zero (which would otherwise drop that entry from the default tooltip payload).
function CategoryTooltip({ active, payload }: { active?: boolean; payload?: { payload: { category: string; current_month: number; median_monthly: number; delta: number; pct: number | null; txn_count: number } }[] }) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0].payload;
  return (
    <div className="bg-neutral-950 border border-neutral-700 rounded px-3 py-2 text-xs space-y-1 min-w-[180px]">
      <div className="font-medium text-neutral-200 mb-1">{row.category}</div>
      <div className="flex justify-between gap-4 text-blue-300"><span>This month</span><span className="tabular-nums">{fmt(row.current_month)}</span></div>
      <div className="flex justify-between gap-4 text-neutral-400"><span>12-mo median</span><span className="tabular-nums">{fmt(row.median_monthly)}</span></div>
      {row.pct != null && (
        <div className={`flex justify-between gap-4 border-t border-neutral-800 pt-1 ${row.delta > 0 ? "text-rose-300" : "text-emerald-300"}`}>
          <span>vs median</span>
          <span className="tabular-nums">{fmtSigned(row.delta)} ({(row.pct >= 0 ? "+" : "") + row.pct.toFixed(0)}%)</span>
        </div>
      )}
      {row.txn_count > 0 && (
        <div className="text-neutral-500 text-[10px] pt-1">{row.txn_count} txn{row.txn_count === 1 ? "" : "s"} this month</div>
      )}
    </div>
  );
}

// Custom tooltip for the monthly income/spend/net chart. Pulls all three values from
// the single data row so we can show net without needing a phantom Bar (which would
// otherwise steal x-axis slot width from the real bars).
function MonthlyFlowTooltip({ active, payload, label }: { active?: boolean; payload?: { payload: { month: string; income: number; total: number; net: number } }[]; label?: string }) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0].payload;
  const [y, mo] = (label ?? row.month).split("-");
  const monthName = new Date(Number(y), Number(mo) - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  return (
    <div className="bg-neutral-950 border border-neutral-700 rounded px-3 py-2 text-xs space-y-1">
      <div className="font-medium text-neutral-200 mb-1">{monthName}</div>
      <div className="flex justify-between gap-4 text-emerald-400"><span>Income</span><span className="tabular-nums">{fmt(row.income)}</span></div>
      <div className="flex justify-between gap-4 text-rose-400"><span>Spent</span><span className="tabular-nums">{fmt(row.total)}</span></div>
      <div className={`flex justify-between gap-4 border-t border-neutral-800 pt-1 ${row.net >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
        <span>Net</span><span className="tabular-nums font-medium">{fmtSigned(row.net)}</span>
      </div>
    </div>
  );
}

// Custom tooltip for the cash-flow chart. Shows date, balance, day-over-day change,
// and (if the brushed range covers this date) the individual transactions that caused
// the change. Pulls all data from the row + the in-memory series/txns arrays, so it's
// purely client-side with no extra fetch on hover.
function CashFlowTooltip({ active, payload, series, txns }: {
  active?: boolean;
  payload?: { payload: CashFlowPoint }[];
  series: CashFlowPoint[];
  txns: RangeTxn[] | null;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0].payload;
  const idx = series.findIndex((p) => p.date === row.date);
  const prior = idx > 0 ? series[idx - 1] : null;
  const change = prior ? row.balance - prior.balance : 0;
  const dayTxns = txns?.filter((t) => t.date === row.date) ?? [];

  return (
    <div className="bg-neutral-950 border border-neutral-700 rounded-md px-3 py-2 text-xs min-w-[260px] max-w-[520px] shadow-xl">
      <div className="font-medium text-neutral-200 mb-1.5">
        {new Date(row.date).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
      </div>
      <div className="flex justify-between gap-4 text-blue-300">
        <span>Balance</span>
        <span className="tabular-nums">{fmtSigned(row.balance)}</span>
      </div>
      {prior && (
        <div className={`flex justify-between gap-4 mt-0.5 ${change > 0 ? "text-emerald-400" : change < 0 ? "text-rose-400" : "text-neutral-500"}`}>
          <span>Change</span>
          <span className="tabular-nums">{fmtSigned(change)}</span>
        </div>
      )}
      {dayTxns.length > 0 ? (
        <div className="mt-2 pt-2 border-t border-neutral-800 space-y-0.5">
          {dayTxns.map((t) => (
            <div key={t.transactionId} className="flex justify-between gap-3">
              <span className="text-neutral-300 flex-1" title={t.description ?? t.payee ?? ""}>{t.payee || t.description}</span>
              <span className={`tabular-nums shrink-0 ${t.amount >= 0 ? "text-emerald-400" : "text-rose-300"}`}>
                {fmtSigned(t.amount)}
              </span>
            </div>
          ))}
        </div>
      ) : change !== 0 ? (
        <div className="mt-1.5 text-neutral-500 text-[10px]">No transactions recorded this day</div>
      ) : null}
    </div>
  );
}

// ── Cash flow history (daily reconstructed balance line + brush zoom) ──────
interface CashFlowPoint { date: string; balance: number; net: number; in_total: number; out_total: number; flagged_inflow: number }
interface CashFlowResp { account: { accountId: string; name: string; orgName: string; balance: number } | null; series: CashFlowPoint[] }
interface RangeTxn {
  transactionId: string;
  date: string;
  amount: number;
  description: string | null;
  payee: string | null;
  category: string | null;
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

function CashFlowHistoryCard({ currentMonth, cashIn, cashOut, cashNet, monthLabel }: {
  currentMonth: string;
  cashIn: number;
  cashOut: number;
  cashNet: number;
  monthLabel: string;
}) {
  const [data, setData] = useState<CashFlowResp | null>(null);

  useEffect(() => {
    fetch("/api/cashflow-history").then((r) => r.json()).then(setData);
  }, []);

  // Memoize series so its reference stays stable while data is unchanged — otherwise
  // brushBounds re-memoizes every render and resets the user-controlled brush position.
  //
  // Enrich each point with `balance_flagged_segment` — non-null only on points that
  // bound a red segment. A segment from day i-1 → i is red when day i had a "flagged"
  // inflow (an Investments-category transfer or a Zelle deposit ≥ $1k) AND the
  // balance actually rose into that day. We skip flat/down days that happen to
  // coincide with a flagged inflow (e.g. a Fidelity transfer absorbed by same-day
  // spending) — the user only cares about the rises that came from these sources.
  const series = useMemo<(CashFlowPoint & { balance_flagged_segment: number | null })[]>(() => {
    const raw = data?.series ?? [];
    return raw.map((p, i) => {
      const incomingFlagged = i > 0 && p.flagged_inflow > 0 && p.balance > raw[i - 1].balance;
      const outgoingFlagged =
        i < raw.length - 1 && raw[i + 1].flagged_inflow > 0 && raw[i + 1].balance > p.balance;
      const onRedSegment = incomingFlagged || outgoingFlagged;
      return { ...p, balance_flagged_segment: onRedSegment ? p.balance : null };
    });
  }, [data]);
  const accountName = data?.account?.name ?? "Chase debit";
  const accountId = data?.account?.accountId;
  const currentBalance = data?.account?.balance ?? 0;

  // The brush is controlled — we own the indices so dragging actually sticks.
  const [brushIndex, setBrushIndex] = useState<{ start: number; end: number } | null>(null);
  // All Chase transactions, fetched once. Used by both the hover tooltip and the
  // transactions table below — single fetch means the tooltip can show day-level
  // detail regardless of brush width, no 92-day cap needed.
  const [allTxns, setAllTxns] = useState<RangeTxn[] | null>(null);

  // Brush default: a ~3-month window around the selected dashboard month — small
  // enough that the transactions table loads immediately (cap is 92 days).
  const brushBounds = useMemo(() => {
    if (series.length === 0) return { startIndex: 0, endIndex: 0 };
    const [y, m] = currentMonth.split("-").map(Number);
    const winStart = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
    const winEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    let startIndex = series.findIndex((p) => p.date >= winStart);
    let endIndex = series.findIndex((p) => p.date > winEnd);
    if (startIndex < 0) startIndex = 0;
    if (endIndex < 0) endIndex = series.length - 1;
    if (endIndex <= startIndex) endIndex = Math.min(series.length - 1, startIndex + 30);
    return { startIndex, endIndex };
  }, [series, currentMonth]);

  const dataStart = series[0]?.date;

  // Seed brushIndex from brushBounds once series loads, and re-seed whenever the
  // dashboard's anchor month changes (so the brush jumps with the month picker).
  useEffect(() => {
    if (series.length === 0) return;
    setBrushIndex((prev) => {
      if (prev?.start === brushBounds.startIndex && prev?.end === brushBounds.endIndex) return prev;
      return { start: brushBounds.startIndex, end: brushBounds.endIndex };
    });
  }, [series, brushBounds]);

  // Visible range derived synchronously from brushIndex — updates instantly while
  // dragging so the header date and "N days" badge feel live.
  const visibleRange = useMemo(() => {
    if (!brushIndex || series.length === 0) return null;
    const start = series[brushIndex.start]?.date;
    const end = series[brushIndex.end]?.date;
    return start && end ? { start, end } : null;
  }, [brushIndex, series]);

  const rangeDays = visibleRange ? daysBetween(visibleRange.start, visibleRange.end) : 0;

  // Fetch every Chase transaction once. ~1500 rows total, ~200KB, well within reason
  // for a single-page payload — and means the tooltip and the table never need to wait
  // on a follow-up fetch when the user hovers or scrubs.
  useEffect(() => {
    if (!accountId) return;
    let canceled = false;
    fetch(`/api/transactions?accountId=${accountId}&limit=10000`)
      .then((r) => r.json())
      .then((d) => { if (!canceled) setAllTxns(d.transactions); });
    return () => { canceled = true; };
  }, [accountId]);

  // Derive the transactions that fall inside the current brush window, on the client.
  const rangeTxns = useMemo(() => {
    if (!allTxns || !visibleRange) return null;
    return allTxns.filter((t) => t.date >= visibleRange.start && t.date <= visibleRange.end);
  }, [allTxns, visibleRange]);

  const onBrushChange = (e: { startIndex?: number; endIndex?: number } | null) => {
    if (!e || e.startIndex == null || e.endIndex == null) return;
    setBrushIndex({ start: e.startIndex, end: e.endIndex });
  };

  return (
    <Card
      title="Chase debit · balance over time"
      subtitle="Red segments = days the balance rose because of an Investments-account transfer or a Zelle deposit ≥ $1k (one-off boosts you want to spot)"
    >
      <div className="grid grid-cols-4 gap-3 mb-4 text-sm">
        <MiniStat label={`In · ${monthLabel}`} value={fmt(cashIn)} color="text-emerald-400" />
        <MiniStat label={`Out · ${monthLabel}`} value={fmt(cashOut)} color="text-rose-400" />
        <MiniStat label={`Net · ${monthLabel}`} value={fmtSigned(cashNet)} color={cashNet >= 0 ? "text-emerald-400" : "text-rose-400"} />
        <MiniStat label="Current balance" value={fmt(currentBalance)} color={currentBalance >= 0 ? "text-emerald-400" : "text-rose-400"} />
      </div>

      {!data ? (
        <p className="text-sm text-neutral-500 py-6 text-center">Loading…</p>
      ) : series.length === 0 ? (
        <p className="text-sm text-neutral-500 py-6 text-center">No activity yet on {accountName}.</p>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={340}>
            <ComposedChart data={series} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="cashHistoryGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.45} />
                  <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#262626" />
              <XAxis
                dataKey="date"
                tick={{ fill: "#999", fontSize: 11 }}
                minTickGap={50}
                tickFormatter={(d: string) => {
                  const dt = new Date(d);
                  return dt.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
                }}
              />
              <YAxis
                tick={{ fill: "#999", fontSize: 11 }}
                tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
              />
              <Tooltip content={<CashFlowTooltip series={series} txns={allTxns} />} />
              <ReferenceLine y={0} stroke="#525252" />
              {/* Base balance line (blue area with gradient). Linear interpolation —
                  must match the red overlay below exactly, or the two lines won't
                  align on the segments they share. */}
              <Area
                type="linear"
                dataKey="balance"
                name="Balance"
                stroke="#3b82f6"
                fill="url(#cashHistoryGrad)"
                strokeWidth={2}
                isAnimationActive={false}
              />
              {/* Red overlay — only renders on segments where the balance rose due to
                  an Investments-account inflow OR a Zelle deposit ≥ $1k. Nulls
                  elsewhere break the line so red paints only those rises. */}
              <Line
                type="linear"
                dataKey="balance_flagged_segment"
                name="From investments / big Zelle"
                stroke="#ef4444"
                strokeWidth={3}
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
              <Brush
                dataKey="date"
                height={28}
                stroke="#3b82f6"
                fill="#0a0a0a"
                travellerWidth={8}
                startIndex={brushIndex?.start ?? brushBounds.startIndex}
                endIndex={brushIndex?.end ?? brushBounds.endIndex}
                onChange={onBrushChange}
                tickFormatter={(d) => {
                  const dt = new Date(d);
                  return dt.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
                }}
              />
            </ComposedChart>
          </ResponsiveContainer>
          {dataStart && (
            <p className="mt-3 text-xs text-neutral-500">
              {accountName} · data since{" "}
              {new Date(dataStart).toLocaleDateString(undefined, { month: "long", year: "numeric" })}.
              Balance is reconstructed by walking back from today, so the right edge matches your live balance.
              The early end can drift negative because some past outflows aren&apos;t in the imported transaction history.
            </p>
          )}

          {/* Transactions in the brushed range */}
          {visibleRange && (
            <div className="mt-6 border-t border-neutral-800 pt-4">
              <div className="flex items-baseline justify-between mb-3">
                <h3 className="text-sm font-semibold">
                  Transactions · {new Date(visibleRange.start).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                  {" → "}
                  {new Date(visibleRange.end).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                </h3>
                <span className="text-xs text-neutral-500">{rangeDays} days</span>
              </div>
              {!rangeTxns ? (
                <p className="text-sm text-neutral-500 py-4">Loading…</p>
              ) : rangeTxns.length === 0 ? (
                <p className="text-sm text-neutral-500 py-4">No transactions in this range.</p>
              ) : (
                <div className="max-h-[480px] overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="text-left text-neutral-500 text-xs uppercase tracking-wide sticky top-0 bg-neutral-900/95 backdrop-blur">
                      <tr>
                        <th className="py-2 w-24">Date</th>
                        <th>Description</th>
                        <th className="w-36">Category</th>
                        <th className="text-right pr-2 w-28">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rangeTxns.map((t) => (
                        <tr key={t.transactionId} className="border-t border-neutral-800/60">
                          <td className="py-1.5 text-neutral-400 tabular-nums">{t.date}</td>
                          <td className="truncate pr-3" title={t.description ?? t.payee ?? ""}>{t.payee || t.description}</td>
                          <td className="text-xs text-neutral-400 truncate pr-2">{t.category ?? <span className="text-neutral-600">—</span>}</td>
                          <td className={`text-right pr-2 tabular-nums ${t.amount >= 0 ? "text-emerald-400" : "text-rose-300"}`}>
                            {fmtSigned(t.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

// Build a compact snapshot of what the user is currently looking at on the dashboard.
// This is a HINT for the chat agent — it primes the model with the user's current
// frame ("currently on May 2026, top spend categories are X/Y/Z") but the agent is
// still expected to use its queryDb tool for anything it needs to verify or expand on.
function buildChatContext({ stats, month, monthLabel, drilldown }: {
  stats: Stats | null;
  month: string;
  monthLabel: string;
  drilldown: string | null;
}): string | null {
  if (!stats) return null;
  const current = stats.monthlySpend.find((m) => m.month === month);
  const top = [...stats.categorySpend]
    .sort((a, b) => b.current_month - a.current_month)
    .slice(0, 5)
    .map((c) => {
      const m = stats.categoryMonthly.filter((r) => r.category === c.category).map((r) => r.total);
      const med = m.length ? [...m].sort((a, b) => a - b)[Math.floor(m.length / 2)] : 0;
      return `  - ${c.category}: $${c.current_month.toFixed(0)} this month (12-mo median: $${med.toFixed(0)})`;
    })
    .join("\n");
  const cashIn = stats.cashFlow.find((c) => c.direction === "in")?.total ?? 0;
  const cashOut = stats.cashFlow.find((c) => c.direction === "out")?.total ?? 0;
  const cashNet = cashIn - cashOut;
  const invTotal = stats.investmentAccounts.reduce((s, a) => s + a.balance, 0);
  const money = (n: number) => (n < 0 ? "−$" : "$") + Math.abs(n).toFixed(0);
  const signedMoney = (n: number) => (n < 0 ? "−$" : "+$") + Math.abs(n).toFixed(0);
  const lines = [
    `User is viewing the dashboard for ${monthLabel} (YYYY-MM = ${month}).`,
    `This month — Income: ${money(current?.income ?? 0)}, Spent: ${money(current?.total ?? 0)}, Net: ${signedMoney(current?.net ?? 0)}.`,
    `Chase debit cash flow this month — In: ${money(cashIn)}, Out: ${money(cashOut)}, Net: ${signedMoney(cashNet)}.`,
    `Fidelity investments total balance: ${money(invTotal)}.`,
    `Top spend categories this month:\n${top}`,
  ];
  if (drilldown) lines.push(`User has drilled into the "${drilldown}" category — they're inspecting its transactions.`);
  return lines.join("\n");
}

// Render a single chat message — handles both plain content and tool-call parts.
// The AI SDK exposes `parts` for streamed messages: a sequence of text + tool-invocation
// chunks. We render each so the user can watch the agent's SQL fly by.
type ChatPart =
  | { type: "text"; text: string }
  | { type: "tool-invocation"; toolInvocation: ToolInvocation };
interface ToolInvocation {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  state: "partial-call" | "call" | "result";
  result?: unknown;
}
// The AI SDK's UIMessage type covers more part kinds than we need (reasoning, source,
// file, step-start) — those are streaming-internal and not worth surfacing. We accept
// any UIMessage-shaped object and filter to the parts we know how to render.
type ChatMessageInput = { id: string; role: string; content?: string; parts?: unknown[] };

function ChatMessage({ message: m }: { message: ChatMessageInput }) {
  const rawParts: unknown[] = m.parts ?? (m.content ? [{ type: "text", text: m.content }] : []);
  const parts = rawParts.filter((p): p is ChatPart => {
    const o = p as { type?: string };
    return o.type === "text" || o.type === "tool-invocation";
  });
  return (
    <div className="space-y-1.5">
      <div className="text-[10px] uppercase tracking-wide text-neutral-500">{m.role}</div>
      {parts.map((part, i) => {
        if (part.type === "text") {
          if (!part.text) return null;
          return (
            <div key={i} className={`text-sm ${m.role === "user" ? "text-blue-300" : "text-neutral-100"}`}>
              <Markdown text={part.text} />
            </div>
          );
        }
        if (part.type === "tool-invocation") return <ToolCallBlock key={part.toolInvocation.toolCallId ?? i} ti={part.toolInvocation} />;
        return null;
      })}
    </div>
  );
}

// Compact, styled-from-scratch markdown renderer. We don't ship Tailwind typography,
// so each element gets its own utility classes.
function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      components={{
        p: (props) => <p className="my-1.5 leading-relaxed" {...props} />,
        h1: (props) => <h1 className="text-base font-semibold mt-2 mb-1.5" {...props} />,
        h2: (props) => <h2 className="text-sm font-semibold mt-2 mb-1" {...props} />,
        h3: (props) => <h3 className="text-sm font-medium mt-1.5 mb-1" {...props} />,
        ul: (props) => <ul className="list-disc pl-5 my-1.5 space-y-0.5" {...props} />,
        ol: (props) => <ol className="list-decimal pl-5 my-1.5 space-y-0.5" {...props} />,
        li: (props) => <li className="leading-snug" {...props} />,
        code: ({ className, children, ...rest }) => {
          const isInline = !className?.includes("language-");
          return isInline ? (
            <code className="bg-neutral-800 text-amber-300 px-1 py-0.5 rounded text-[12px] tabular-nums" {...rest}>{children}</code>
          ) : (
            <code className="block bg-neutral-950 border border-neutral-800 rounded p-2 text-[12px] overflow-x-auto tabular-nums whitespace-pre" {...rest}>{children}</code>
          );
        },
        pre: ({ children }) => <pre className="my-1.5">{children}</pre>,
        strong: (props) => <strong className="font-semibold text-neutral-50" {...props} />,
        em: (props) => <em className="italic" {...props} />,
        a: (props) => <a className="text-blue-400 underline" target="_blank" rel="noopener noreferrer" {...props} />,
        table: (props) => <table className="border-collapse my-2 text-xs" {...props} />,
        th: (props) => <th className="border border-neutral-800 px-1.5 py-0.5 bg-neutral-900 font-medium text-left" {...props} />,
        td: (props) => <td className="border border-neutral-800 px-1.5 py-0.5 tabular-nums" {...props} />,
        hr: () => <hr className="my-2 border-neutral-800" />,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

// Render a tool invocation as a collapsible-looking block — name, args, and (when
// available) a short result summary. Lets the user see the SQL the agent ran live.
function ToolCallBlock({ ti }: { ti: ToolInvocation }) {
  const args = ti.args as { query?: string } | undefined;
  const query = args?.query;
  const rows = ti.state === "result" && ti.result && typeof ti.result === "object"
    ? ((ti.result as { rows?: unknown[]; error?: string }).rows ?? null)
    : null;
  const err = ti.state === "result" && ti.result && typeof ti.result === "object"
    ? (ti.result as { error?: string }).error
    : null;
  return (
    <div className="my-1.5 rounded-md border border-neutral-800 bg-neutral-950/70 overflow-hidden">
      <div className="flex items-center gap-2 px-2.5 py-1.5 bg-neutral-900/70 border-b border-neutral-800">
        <span className={`text-[10px] uppercase tracking-wide font-medium ${ti.state === "result" ? "text-emerald-400" : "text-amber-300"}`}>
          {ti.state === "result" ? "✓" : ti.state === "partial-call" ? "…" : "▶"} {ti.toolName}
        </span>
        {ti.state === "result" && rows && (
          <span className="text-[10px] text-neutral-500">{rows.length} row{rows.length === 1 ? "" : "s"}</span>
        )}
        {ti.state === "result" && err && (
          <span className="text-[10px] text-rose-400">error</span>
        )}
      </div>
      {query && (
        <pre className="px-2.5 py-1.5 text-[11px] text-neutral-300 whitespace-pre-wrap break-all">{query}</pre>
      )}
      {err && (
        <pre className="px-2.5 py-1.5 text-[11px] text-rose-300 whitespace-pre-wrap border-t border-neutral-800">{err}</pre>
      )}
    </div>
  );
}

// ── Chat pane (lives on the right of the dashboard) ───────────────────────
function ChatPanel({ context }: { context: string | null }) {
  // Pass the dashboard context as a custom body field on every chat request. The server
  // reads it and folds it into the system prompt.
  const { messages, input, handleInputChange, handleSubmit, isLoading } = useChat({
    api: "/api/chat",
    body: { dashboardContext: context },
  });
  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-xl flex flex-col h-full shadow-lg shadow-black/30">
      <div className="px-4 py-3 border-b border-neutral-800">
        <h2 className="text-sm font-semibold tracking-tight">Ask</h2>
        <p className="text-xs text-neutral-500 mt-0.5">Natural-language questions about your spending.</p>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 && !isLoading && (
          <p className="text-xs text-neutral-500 italic">
            “how much did I spend on groceries last month?”
          </p>
        )}
        {messages.map((m) => (
          <ChatMessage key={m.id} message={m} />
        ))}
        {isLoading && <div className="text-neutral-500 text-xs">…</div>}
      </div>
      <form onSubmit={handleSubmit} className="flex gap-2 p-3 border-t border-neutral-800">
        <input
          value={input}
          onChange={handleInputChange}
          placeholder="Ask anything…"
          className="flex-1 bg-neutral-950 border border-neutral-800 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-blue-600"
        />
        <button className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-sm">Send</button>
      </form>
    </div>
  );
}

// ── Month picker ───────────────────────────────────────────────────────────
function MonthPicker({ month, monthLabel, onChange }: {
  month: string;
  monthLabel: string;
  onChange: (m: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // All months from Sept 2022 (earliest data) through next month, grouped by year.
  const byYear = useMemo(() => {
    const all: { ym: string; label: string; year: string }[] = [];
    const now = new Date();
    let y = now.getFullYear();
    let m = now.getMonth() + 2; // include next month
    if (m > 12) { m = 1; y += 1; }
    while (y > 2022 || (y === 2022 && m >= 9)) {
      const ym = `${y}-${String(m).padStart(2, "0")}`;
      const date = new Date(y, m - 1, 1);
      all.push({ ym, label: date.toLocaleDateString(undefined, { month: "short" }), year: String(y) });
      m -= 1;
      if (m === 0) { m = 12; y -= 1; }
    }
    const map = new Map<string, { ym: string; label: string; year: string }[]>();
    for (const r of all) {
      const list = map.get(r.year) ?? [];
      list.push(r);
      map.set(r.year, list);
    }
    return [...map.entries()]; // newest year first
  }, []);

  const today = new Date().toISOString().slice(0, 7);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-1.5 bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 rounded-lg text-sm transition"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-neutral-500">
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
        <span className="text-neutral-100">{monthLabel}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`text-neutral-500 transition ${open ? "rotate-180" : ""}`}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 mt-2 bg-neutral-900 border border-neutral-800 rounded-lg shadow-xl p-3 z-20 w-72 max-h-[28rem] overflow-y-auto">
          <button
            onClick={() => { onChange(today); setOpen(false); }}
            className="w-full mb-3 text-xs px-2 py-1.5 bg-neutral-800 hover:bg-neutral-700 rounded text-neutral-200"
          >
            Jump to current month
          </button>
          {byYear.map(([year, items]) => (
            <div key={year} className="mb-3 last:mb-0">
              <div className="text-xs text-neutral-500 uppercase tracking-wide mb-1.5">{year}</div>
              <div className="grid grid-cols-4 gap-1">
                {items.slice().reverse().map((it) => (
                  <button
                    key={it.ym}
                    onClick={() => { onChange(it.ym); setOpen(false); }}
                    className={`text-xs px-2 py-1.5 rounded transition ${
                      it.ym === month
                        ? "bg-blue-600 text-white font-medium"
                        : it.ym === today
                          ? "bg-neutral-800 hover:bg-neutral-700 text-blue-300"
                          : "bg-neutral-800/60 hover:bg-neutral-700 text-neutral-300"
                    }`}
                  >
                    {it.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Inflows card (all positive transactions for the selected month) ────────
interface InflowTxn {
  transactionId: string;
  date: string;
  amount: number;
  description: string | null;
  payee: string | null;
  category: string | null;
  accountOrgName: string | null;
  accountName: string | null;
}

interface PaycheckSplit { transactionId: string; portion: string; amount: number }
function InflowsCard({ month, monthLabel }: { month: string; monthLabel: string }) {
  const [txns, setTxns] = useState<InflowTxn[] | null>(null);
  const [splitsByTx, setSplitsByTx] = useState<Map<string, PaycheckSplit[]>>(new Map());
  useEffect(() => {
    setTxns(null);
    fetch(`/api/transactions?month=${month}&positiveOnly=1&limit=500`)
      .then((r) => r.json())
      // Hide credit-card payments — they're positive on the credit account (paying
      // down debt) but aren't real inflows, just settling earlier credit spend.
      .then((d) =>
        setTxns((d.transactions as InflowTxn[]).filter((t) => t.category !== "Credit card payments")),
      );
    // Also fetch paycheck splits so we can present regular vs bonus separately.
    fetch("/api/paychecks")
      .then((r) => r.json())
      .then((d) => {
        const map = new Map<string, PaycheckSplit[]>();
        for (const p of d.paychecks as { transactionId: string; splits: PaycheckSplit[] }[]) {
          if (p.splits.length > 0) map.set(p.transactionId, p.splits);
        }
        setSplitsByTx(map);
      });
  }, [month]);

  // Split paychecks into the regular and bonus portions; bonus rows get treated as
  // "other inflows" since they're one-off boosts, not recurring base income.
  const { paychecks, other } = useMemo(() => {
    const all = txns ?? [];
    const paychecks: InflowTxn[] = [];
    const other: InflowTxn[] = [];
    for (const t of all) {
      if (t.category !== "Microsoft Paycheck") {
        other.push(t);
        continue;
      }
      const splits = splitsByTx.get(t.transactionId);
      if (!splits || splits.length === 0) {
        // No split info — treat the whole thing as regular.
        paychecks.push(t);
        continue;
      }
      const regular = splits.find((s) => s.portion === "regular")?.amount ?? 0;
      const bonus = splits.find((s) => s.portion === "bonus")?.amount ?? 0;
      if (regular > 0) {
        paychecks.push({ ...t, amount: regular, description: (t.description ?? "") + " (regular)" });
      }
      if (bonus > 0) {
        other.push({
          ...t,
          transactionId: t.transactionId + ":bonus",
          amount: bonus,
          description: (t.description ?? "") + " (bonus / stock)",
        });
      }
    }
    paychecks.sort((a, b) => b.amount - a.amount);
    other.sort((a, b) => b.amount - a.amount);
    return { paychecks, other };
  }, [txns, splitsByTx]);

  const total = (txns ?? []).reduce((s, t) => s + t.amount, 0);
  const paycheckTotal = paychecks.reduce((s, t) => s + t.amount, 0);
  const otherTotal = other.reduce((s, t) => s + t.amount, 0);

  return (
    <Card
      title="Inflows"
      subtitle={`All deposits, paychecks, refunds, and transfers in for ${monthLabel}`}
    >
      {!txns ? (
        <p className="text-sm text-neutral-500 py-4">Loading…</p>
      ) : txns.length === 0 ? (
        <p className="text-sm text-neutral-500 py-4">No inflows recorded in {monthLabel}.</p>
      ) : (
        <>
          <div className="flex items-baseline justify-between mb-3">
            <span className="text-sm text-neutral-400">{txns.length} transaction{txns.length === 1 ? "" : "s"}</span>
            <span className="text-lg font-semibold tabular-nums text-emerald-400">{fmt(total)}</span>
          </div>
          <div className="max-h-[600px] overflow-y-auto space-y-5">
            {paychecks.length > 0 && (
              <InflowSection title="Microsoft paychecks" count={paychecks.length} total={paycheckTotal} rows={paychecks} />
            )}
            {other.length > 0 && (
              <InflowSection title="Other inflows" count={other.length} total={otherTotal} rows={other} />
            )}
          </div>
        </>
      )}
    </Card>
  );
}

function InflowSection({ title, count, total, rows }: { title: string; count: number; total: number; rows: InflowTxn[] }) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2 px-1">
        <span className="text-xs uppercase tracking-wide text-neutral-400 font-medium">
          {title} <span className="text-neutral-600">· {count}</span>
        </span>
        <span className="text-sm tabular-nums text-emerald-400 font-medium">{fmt(total)}</span>
      </div>
      <table className="w-full text-sm">
        <thead className="text-left text-neutral-500 text-xs uppercase tracking-wide">
          <tr>
            <th className="py-1.5 w-24">Date</th>
            <th>Description</th>
            <th className="w-32">Category</th>
            <th className="w-36">Account</th>
            <th className="text-right pr-2 w-24">Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.transactionId} className="border-t border-neutral-800/60">
              <td className="py-1.5 text-neutral-400 tabular-nums">{t.date}</td>
              <td className="truncate pr-3" title={t.description ?? t.payee ?? ""}>{t.payee || t.description}</td>
              <td className="text-xs text-neutral-400 truncate pr-2" title={t.category ?? ""}>
                {t.category ?? <span className="text-neutral-600">—</span>}
              </td>
              <td className="text-xs text-neutral-500 truncate" title={`${t.accountOrgName ?? ""} · ${t.accountName ?? ""}`}>
                {t.accountOrgName ?? ""}
              </td>
              <td className="text-right pr-2 tabular-nums text-emerald-400">{fmt(t.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Drilldown ──────────────────────────────────────────────────────────────
interface DrillTxn {
  transactionId: string;
  date: string;
  amount: number;
  description: string | null;
  payee: string | null;
  categorySource: string | null;
  accountOrgName: string | null;
  accountName: string | null;
}

function CategoryDrilldown({ month, category, monthLabel, onClose }: {
  month: string;
  category: string;
  monthLabel: string;
  onClose: () => void;
}) {
  const [txns, setTxns] = useState<DrillTxn[] | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [pendingId, setPendingId] = useState<string | null>(null);

  useEffect(() => {
    setTxns(null);
    const url = `/api/transactions?month=${month}&category=${encodeURIComponent(category)}&spendOnly=1&limit=500`;
    fetch(url)
      .then((r) => r.json())
      // Sort by amount descending (largest charges at top) — these are spend rows so
      // amounts are negative; sort by ABS(amount) desc to put the biggest hits first.
      .then((d) => setTxns((d.transactions as DrillTxn[]).slice().sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))));
  }, [month, category]);

  // Fetch category list once for the recategorize dropdown.
  useEffect(() => {
    fetch("/api/categories")
      .then((r) => r.json())
      .then((d) => setCategories((d.categories as { name: string }[]).map((c) => c.name).sort()));
  }, []);

  async function recategorize(t: DrillTxn, newCat: string) {
    if (!newCat || newCat === category) return;
    setPendingId(t.transactionId);
    await fetch("/api/categories", {
      method: "PATCH",
      body: JSON.stringify({ transactionId: t.transactionId, category: newCat }),
    });
    // The row no longer belongs in this drilldown — drop it from the list.
    setTxns((cur) => (cur ?? []).filter((x) => x.transactionId !== t.transactionId));
    setPendingId(null);
  }

  const total = txns?.reduce((s, t) => s + Math.abs(t.amount), 0) ?? 0;

  return (
    <div className="mt-5 bg-neutral-950/60 border border-neutral-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold">{category} · {monthLabel}</h3>
          {txns && (
            <p className="text-xs text-neutral-500">{txns.length} transactions · {fmt(total)} total · pick a new category from the dropdown to recategorize</p>
          )}
        </div>
        <button onClick={onClose} className="text-xs text-neutral-400 hover:text-neutral-200 px-2 py-1 rounded hover:bg-neutral-800">✕ close</button>
      </div>
      {!txns ? (
        <p className="text-sm text-neutral-500">Loading...</p>
      ) : txns.length === 0 ? (
        <p className="text-sm text-neutral-500">No spending transactions in this category for {monthLabel}.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-neutral-500 text-xs uppercase tracking-wide">
            <tr>
              <th className="py-1.5 w-24">Date</th>
              <th>Description</th>
              <th className="w-32">Account</th>
              <th className="text-right pr-2 w-24">Amount</th>
              <th className="w-44">Category</th>
            </tr>
          </thead>
          <tbody>
            {txns.map((t) => (
              <tr key={t.transactionId} className={`border-t border-neutral-800/60 ${pendingId === t.transactionId ? "opacity-50" : ""}`}>
                <td className="py-1.5 text-neutral-400">{t.date}</td>
                <td className="truncate pr-3" title={t.description ?? t.payee ?? ""}>{t.description ?? t.payee}</td>
                <td className="text-xs text-neutral-500 truncate" title={`${t.accountOrgName ?? ""} · ${t.accountName ?? ""}`}>
                  {t.accountOrgName ?? ""}
                </td>
                <td className="text-right pr-2 tabular-nums">{fmt(Math.abs(t.amount))}</td>
                <td className="pl-2 pr-1">
                  <select
                    disabled={pendingId === t.transactionId || categories.length === 0}
                    value={category}
                    onChange={(e) => recategorize(t, e.target.value)}
                    className="w-full bg-neutral-900 border border-neutral-800 rounded px-1.5 py-1 text-xs focus:outline-none focus:border-blue-600 disabled:opacity-50"
                  >
                    {/* Current category always selected; picking another triggers the PATCH. */}
                    {!categories.includes(category) && <option value={category}>{category}</option>}
                    {categories.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
