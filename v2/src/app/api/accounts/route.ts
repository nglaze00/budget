import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";

export async function GET() {
  const accounts = await db.query.accounts.findMany();
  return NextResponse.json({ accounts });
}

// PATCH { accountId, accountType } — used to mark an account as credit vs depository.
export async function PATCH(req: Request) {
  const { accountId, accountType } = await req.json();
  await db.update(schema.accounts).set({ accountType }).where(eq(schema.accounts.accountId, accountId));
  return NextResponse.json({ ok: true });
}
