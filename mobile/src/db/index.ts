import { drizzle } from "drizzle-orm/expo-sqlite";
import * as SQLite from "expo-sqlite";
import * as schema from "./schema";

// Single on-device SQLite database. Mirrors the desktop's better-sqlite3 file so the
// same Drizzle queries and the same sync snapshot format work unchanged.
export const expoDb = SQLite.openDatabaseSync("budget.db");

export const db = drizzle(expoDb, { schema });
export { schema };
