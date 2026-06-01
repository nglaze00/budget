// Mobile shim so ported lib files can `import { ensureSyncSchema } from "./migrate"`
// exactly like the desktop. The real DDL bootstrap lives in src/db/migrate.ts.
import { ensureSchema } from "@/db/migrate";

export function ensureSyncSchema() {
  ensureSchema();
}
