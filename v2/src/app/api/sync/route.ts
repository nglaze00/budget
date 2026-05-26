import { NextResponse } from "next/server";
import { sync } from "@/lib/simplefin";

export async function POST(req: Request) {
  const { searchParams } = new URL(req.url);
  const days = Number(searchParams.get("days") ?? 90);
  const result = await sync(days);

  // If any institution had errors/was missing, return 207 (multi-status) so callers know
  // the sync partially succeeded but some institutions couldn't be reached.
  const hasIssues = result.institutions.some((i) => i.status !== "ok");
  return NextResponse.json(result, { status: hasIssues ? 207 : 200 });
}
