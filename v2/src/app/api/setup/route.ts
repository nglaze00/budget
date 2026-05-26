import { NextResponse } from "next/server";
import { db, schema } from "@/db";
import { claimSetupToken, sync } from "@/lib/simplefin";

export async function POST(req: Request) {
  const { setup_token } = await req.json();
  if (!setup_token) return NextResponse.json({ error: "setup_token required" }, { status: 400 });

  const accessUrl = await claimSetupToken(setup_token);
  await db.delete(schema.connection);
  await db.insert(schema.connection).values({ id: 1, accessUrl });

  // On initial setup, backfill 1 year. SimpleFIN has ~24 req/day quota; banks
  // typically expose only 3-12 months anyway. The chunked fetcher does this in ~4-5
  // 90-day requests per /accounts call. Older history comes from the v1 CSV backfill.
  const result = await sync(365);
  return NextResponse.json({ ok: true, ...result });
}
