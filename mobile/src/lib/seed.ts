import { db, schema } from "@/db";

// Categories ported from the desktop app (src/lib/seed.ts).
interface CategoryDef {
  definition: string;
  isPaycheckSource?: boolean;
}

export const DEFAULT_CATEGORIES: Record<string, CategoryDef> = {
  "Microsoft Paycheck": { definition: "Biweekly paycheck from Microsoft (description typically 'MICROSOFT EDIPAYMENT')", isPaycheckSource: true },
  "Level Paycheck": { definition: "Regular salary paycheck from Level — always plain cash (no bonuses or stock). Look for 'LEVEL' in the description/payee.", isPaycheckSource: true },
  "Utilities": { definition: "Electric, gas, water, internet, phone bills" },
  "Credit card payments": { definition: "Payments made to credit card accounts (or the received income version of those payments)" },
  "Grocery": { definition: "Payments at grocery stores" },
  "Solo necessary meals": { definition: "Meals I eat by myself, usually cheap/takeout" },
  "Social food/drinks": { definition: "Restaurants / bars with friends" },
  "Transit": { definition: "Getting around -- Rideshare, metro, bikeshare, etc." },
  "Travel": { definition: "Flights, Amtrak, hotels, etc." },
  "Entertainment": { definition: "Concerts, sports games, movies, etc." },
  "Venmo/ATM": { definition: "Venmo or ATM transactions" },
  "Clothing": { definition: "Purchases at clothing stores / that are probably of clothing" },
  "Shopping": { definition: "Non-clothing shopping" },
  "Medical": { definition: "Medical expenses" },
  "Exercise": { definition: "Gym, sports leagues, etc." },
  "Subscriptions": { definition: "Elective subscription payments" },
  "Investments": { definition: "Transactions with investment accounts" },
  "Rent": { definition: "Monthly rent or housing payment" },
  "Misc": { definition: "Transactions that don't fit into any other category" },
};

export async function seedCategoriesIfEmpty() {
  await db
    .insert(schema.categories)
    .values(
      Object.entries(DEFAULT_CATEGORIES).map(([name, def]) => ({
        name,
        definition: def.definition,
        isPaycheckSource: def.isPaycheckSource ? 1 : 0,
      })),
    )
    .onConflictDoNothing();
}
