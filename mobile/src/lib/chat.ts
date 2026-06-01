import { and, like, or, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { chatWithTools, ChatMessage, ChatStep, ToolDef } from "./openai";

// Categorization assistant, ported from the desktop /api/categorize/chat route.
// Same tools (listCategories, findPending, previewMatches, bulkCategorize) and system
// prompt; runs the tool loop on-device and returns the final text + a step log.

const needsReviewClause = sql`(${schema.transactions.category} IS NULL OR ${schema.transactions.categorySource} = 'llm')`;

const SYSTEM = [
  "You help the user categorize their transactions quickly using natural-language rules.",
  "Workflow:",
  "  1. When the user gives a rule like 'MBTA is always Transit', first call previewMatches to confirm what will be affected.",
  "  2. Show the count + a few sample descriptions.",
  "  3. Ask for confirmation, then call bulkCategorize.",
  "  4. After applying, briefly summarize: '✓ Categorized 8 MBTA transactions as Transit'.",
  "If the user asks 'what's left?' call findPending with no filter.",
  "If a rule could be ambiguous (e.g. 'Amazon'), preview first and ask before committing.",
  "ONLY use valid category names — call listCategories if unsure.",
  "Match text is treated as a case-insensitive substring match against description and payee.",
].join("\n");

const tools: ToolDef[] = [
  {
    name: "listCategories",
    description: "List all valid spending categories.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      const cats = await db.query.categories.findMany();
      return { categories: cats.map((c) => ({ name: c.name, definition: c.definition })) };
    },
  },
  {
    name: "findPending",
    description: "List transactions still needing categorization (uncategorized OR LLM-assigned not yet confirmed). Optionally filter by a substring match against description/payee.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        matchText: { type: "string", description: "Substring filter; pass empty string to list all pending." },
        limit: { type: "number", description: "Max rows to return (default 30, max 100)." },
      },
      required: ["matchText", "limit"],
    },
    execute: async (args) => {
      const matchText = (args.matchText as string) ?? "";
      const limit = (args.limit as number) ?? 30;
      const effLimit = limit && limit > 0 ? Math.min(limit, 100) : 30;
      const effMatch = matchText && matchText.trim().length > 0 ? matchText : undefined;
      const where = effMatch
        ? and(needsReviewClause, or(like(sql`LOWER(${schema.transactions.description})`, `%${effMatch.toLowerCase()}%`), like(sql`LOWER(${schema.transactions.payee})`, `%${effMatch.toLowerCase()}%`)))
        : needsReviewClause;
      const rows = await db.query.transactions.findMany({ where, limit: effLimit, orderBy: [sql`date DESC`] });
      const total = await db.all<{ n: number }>(sql`
        SELECT COUNT(*) as n FROM transactions
        WHERE (category IS NULL OR category_source = 'llm')
        ${effMatch ? sql`AND (LOWER(description) LIKE ${`%${effMatch.toLowerCase()}%`} OR LOWER(payee) LIKE ${`%${effMatch.toLowerCase()}%`})` : sql``}
      `);
      return {
        totalMatching: total[0]?.n ?? 0,
        shown: rows.length,
        rows: rows.map((r) => ({
          transactionId: r.transactionId,
          date: r.date,
          amount: r.amount,
          description: r.description,
          payee: r.payee,
          currentCategory: r.category,
          confidence: r.categoryConfidence,
        })),
      };
    },
  },
  {
    name: "previewMatches",
    description: "Preview which pending transactions a categorization rule would affect. ALWAYS use this before bulkCategorize so the user can confirm.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { matchText: { type: "string", description: "Substring to match against description and payee (case-insensitive)." } },
      required: ["matchText"],
    },
    execute: async (args) => {
      const m = ((args.matchText as string) ?? "").toLowerCase();
      const where = and(
        needsReviewClause,
        or(like(sql`LOWER(${schema.transactions.description})`, `%${m}%`), like(sql`LOWER(${schema.transactions.payee})`, `%${m}%`)),
      );
      const rows = await db.query.transactions.findMany({ where, orderBy: [sql`date DESC`], limit: 50 });
      return {
        totalMatching: rows.length,
        samples: rows.slice(0, 10).map((r) => ({ date: r.date, amount: r.amount, description: r.description, currentCategory: r.category })),
      };
    },
  },
  {
    name: "bulkCategorize",
    description: "Assign a category to all pending transactions matching a substring. Marks them as user-confirmed so they won't be re-categorized.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        matchText: { type: "string", description: "Substring to match against description and payee (case-insensitive)." },
        category: { type: "string", description: "Exact category name from listCategories." },
      },
      required: ["matchText", "category"],
    },
    execute: async (args) => {
      const matchText = (args.matchText as string) ?? "";
      const category = (args.category as string) ?? "";
      const validCats = new Set((await db.query.categories.findMany()).map((c) => c.name));
      if (!validCats.has(category)) {
        return { error: `Unknown category '${category}'. Valid categories: ${[...validCats].join(", ")}` };
      }
      const m = matchText.toLowerCase();
      const where = and(
        needsReviewClause,
        or(like(sql`LOWER(${schema.transactions.description})`, `%${m}%`), like(sql`LOWER(${schema.transactions.payee})`, `%${m}%`)),
      );
      const result = await db
        .update(schema.transactions)
        .set({ category, categorySource: "user", categoryConfidence: "completely_sure", updatedAt: new Date().toISOString() })
        .where(where);
      return { updated: (result as { changes?: number }).changes ?? 0, category, matchText };
    },
  },
];

export interface ChatTurn {
  text: string;
  steps: ChatStep[];
}

export async function runCategorizeChat(messages: ChatMessage[]): Promise<ChatTurn> {
  return chatWithTools({ system: SYSTEM, messages, tools, maxSteps: 8 });
}
