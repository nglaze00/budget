"use client";

import { useEffect, useState } from "react";

const STALE_HOURS = 24;

function timeAgo(iso: string | null) {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const hours = ms / (1000 * 60 * 60);
  if (hours < 1) return `${Math.round(hours * 60)}m ago`;
  if (hours < 48) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default function SyncBanner() {
  const [status, setStatus] = useState<{ connected: boolean; lastSyncedAt: string | null; reviewCount: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState("");

  const refresh = () =>
    fetch("/api/sync-status").then((r) => r.json()).then(setStatus);

  useEffect(() => { refresh(); }, []);

  async function sync() {
    setRunning(true);
    setMsg("Fetching latest transactions...");
    const res = await fetch("/api/sync", { method: "POST" });
    const data = await res.json();
    setMsg(`+${data.added} new, ${data.updated} updated, ${data.categorized ?? 0} categorized`);
    setRunning(false);
    refresh();
  }

  if (!status?.connected) return null;

  const last = status.lastSyncedAt;
  const stale = !last || (Date.now() - new Date(last).getTime()) / 3600000 > STALE_HOURS;

  return (
    <div className={`flex items-center gap-3 px-6 py-2 text-sm border-b border-neutral-800 ${stale ? "bg-amber-950/40" : ""}`}>
      <span className="text-neutral-400">Last sync: {timeAgo(last)}</span>
      <button
        onClick={sync}
        disabled={running}
        className="px-3 py-1 bg-blue-600 rounded disabled:opacity-50"
      >
        {running ? "Fetching..." : "Fetch latest transactions"}
      </button>
      {status.reviewCount > 0 && (
        <a href="/review" className="text-amber-300 underline">
          {status.reviewCount} need review
        </a>
      )}
      {msg && <span className="text-neutral-400">{msg}</span>}
    </div>
  );
}
