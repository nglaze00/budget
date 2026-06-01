import * as FileSystem from "expo-file-system";
import * as Sharing from "expo-sharing";
import { buildSnapshot, mergeSnapshot, MergeStats, Snapshot } from "./syncEngine";
import { getSetting } from "./settings";

// The two sync buttons the user cares about most. The phone is always the active party
// (it has no always-on server), so BOTH directions are phone-initiated HTTP calls to the
// desktop's endpoints. Nothing runs in the background → zero idle battery.

function normalizePeerUrl(raw: string): string {
  let u = raw.trim();
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  return u.replace(/\/+$/, "");
}

async function resolvePeer(peerUrl?: string): Promise<string> {
  const p = peerUrl ?? (await getSetting("desktop_peer_url"));
  if (!p) throw new Error("No desktop address set. Enter your laptop's host:port in Settings.");
  return normalizePeerUrl(p);
}

// "Sync from desktop": pull the laptop's snapshot and merge it into this phone.
export async function syncFromDesktop(peerUrl?: string): Promise<MergeStats> {
  const base = await resolvePeer(peerUrl);
  const resp = await fetch(`${base}/api/sync-pull`, { method: "GET" });
  if (!resp.ok) throw new Error(`Desktop responded ${resp.status}. Is the laptop app running with -H 0.0.0.0?`);
  const snap = (await resp.json()) as Snapshot;
  return mergeSnapshot(snap, "phone");
}

// "Send to desktop": push this phone's snapshot to the laptop, which merges it.
export async function sendToDesktop(peerUrl?: string): Promise<MergeStats> {
  const base = await resolvePeer(peerUrl);
  const snap = await buildSnapshot("phone");
  const resp = await fetch(`${base}/api/sync-merge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(snap),
  });
  if (!resp.ok) throw new Error(`Desktop responded ${resp.status}. Is the laptop app running with -H 0.0.0.0?`);
  const body = await resp.json();
  return (body.stats ?? body) as MergeStats;
}

// Two-way sync in one tap: pull from desktop first (phone gets desktop's latest),
// then push the merged state back so desktop ends up with the same union.
export async function syncBothWays(peerUrl?: string): Promise<{ pulled: MergeStats; pushed: MergeStats }> {
  const pulled = await syncFromDesktop(peerUrl);
  const pushed = await sendToDesktop(peerUrl);
  return { pulled, pushed };
}

// Ping the desktop health endpoint to check reachability.
export async function pingDesktop(peerUrl?: string): Promise<boolean> {
  try {
    const base = await resolvePeer(peerUrl);
    const r = await fetch(`${base}/api/health`, { method: "GET" });
    return r.ok;
  } catch {
    return false;
  }
}

// Offline fallback: write a snapshot file and open the Android share sheet.
export async function exportSnapshotFile(): Promise<string> {
  const snap = await buildSnapshot("phone");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = `${FileSystem.documentDirectory}budget-snapshot-${stamp}.json`;
  await FileSystem.writeAsStringAsync(path, JSON.stringify(snap), { encoding: FileSystem.EncodingType.UTF8 });
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(path, { mimeType: "application/json", dialogTitle: "Export budget snapshot" });
  }
  return path;
}

// Offline fallback: merge a snapshot pasted/loaded as raw JSON text.
export async function importSnapshotJson(text: string): Promise<MergeStats> {
  const snap = JSON.parse(text) as Snapshot;
  return mergeSnapshot(snap, "phone");
}
