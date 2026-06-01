// Display formatting helpers shared across screens.

export function money(n: number | null | undefined, opts: { sign?: boolean; cents?: boolean } = {}): string {
  const v = n ?? 0;
  const abs = Math.abs(v);
  const str = abs.toLocaleString("en-US", {
    minimumFractionDigits: opts.cents === false ? 0 : 2,
    maximumFractionDigits: opts.cents === false ? 0 : 2,
  });
  const sign = v < 0 ? "-" : opts.sign ? "+" : "";
  return `${sign}$${str}`;
}

export function compactMoney(n: number | null | undefined): string {
  const v = n ?? 0;
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
  return `${sign}$${abs.toFixed(0)}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function shortDate(iso: string): string {
  // iso = YYYY-MM-DD
  const [, m, d] = iso.split("-").map(Number);
  if (!m || !d) return iso;
  return `${MONTHS[m - 1]} ${d}`;
}

export function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  if (!m) return ym;
  return `${MONTHS[m - 1]} ${y}`;
}

export function shortMonthLabel(ym: string): string {
  const [, m] = ym.split("-").map(Number);
  return m ? MONTHS[m - 1] : ym;
}

export function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const diff = Date.now() - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function todayMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

export function shiftMonth(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
