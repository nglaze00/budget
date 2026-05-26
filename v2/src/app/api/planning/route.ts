import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";

// Disk-persisted planning store. Single-row blob (id=1) holding the entire
// ScenarioStore JSON (scenarios + activeId + baselineId). Lazy CREATE TABLE so
// existing budget.db files without a migration still work.
const ensureTable = () => {
  db.run(sql`
    CREATE TABLE IF NOT EXISTS planning_store (
      id INTEGER PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
};

export async function GET() {
  ensureTable();
  const row = db
    .all<{ data: string }>(sql`SELECT data FROM planning_store WHERE id = 1`)[0];
  if (!row) return NextResponse.json({ store: null });
  try {
    return NextResponse.json({ store: JSON.parse(row.data) });
  } catch {
    return NextResponse.json({ store: null });
  }
}

export async function POST(req: Request) {
  ensureTable();
  const body = await req.json();
  const data = JSON.stringify(body);
  db.run(sql`
    INSERT INTO planning_store (id, data, updated_at)
    VALUES (1, ${data}, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `);
  return NextResponse.json({ ok: true });
}
