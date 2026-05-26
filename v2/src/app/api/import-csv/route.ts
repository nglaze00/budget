import { NextResponse } from "next/server";
import { importAllCsvDirect } from "@/lib/csv-direct-import";

// Direct-CSV importer route. Reads raw bank exports from data/{chase,capital_one,
// wells_fargo}/ and inserts any transactions that aren't already in the DB. Safe to
// re-run: dedup by (account, date, amount, description-prefix) means nothing already
// loaded is touched, and the new raw rows use content-hash IDs so a second run is
// idempotent.
export async function POST() {
  const result = await importAllCsvDirect();
  return NextResponse.json(result);
}
