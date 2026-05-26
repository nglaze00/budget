import { openai } from "@ai-sdk/openai";
import { streamText, tool } from "ai";
import { z } from "zod";
import { and, eq, isNull, like, or, sql } from "drizzle-orm";
import { db, schema } from "@/db";

// Categorization assistant. The user chats with it to bulk-categorize pending
// transactions using natural-language rules like "MBTA is always Transit".
// Tools:
//   findPending(matchText?)    -> list transactions needing categorization (optionally filtered)
//   previewMatches(matchText)  -> show transactions matching a rule before applying it
//   bulkCategorize(matchText, category)  -> assign category to all matching pending+LLM rows
//   listCategories()           -> list valid category names + definitions
export async function POST(req: Request) {
  const { messages } = await req.json();

  // Build a `needs review` filter: transactions still uncategorized OR LLM-assigned
  // and not yet user-confirmed. User-confirmed rows are protected.
  const needsReviewClause = sql`(${schema.transactions.category} IS NULL OR ${schema.transactions.categorySource} = 'llm')`;

  const result = streamText({
    model: openai("gpt-5.5"),
    // gpt-5.5 only accepts temperature=1; the SDK default of 0.7 returns 400.
    temperature: 1,
    system: [
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
    ].join("\n"),
    messages,
    tools: {
      listCategories: tool({
        description: "List all valid spending categories.",
        parameters: z.object({}),
        execute: async () => {
          const cats = await db.query.categories.findMany();
          return { categories: cats.map((c) => ({ name: c.name, definition: c.definition })) };
        },
      }),
      findPending: tool({
        description: "List transactions still needing categorization (uncategorized OR LLM-assigned not yet confirmed). Optionally filter by a substring match against description/payee.",
        parameters: z.object({
          matchText: z.string().describe("Substring filter; pass empty string to list all pending."),
          limit: z.number().describe("Max rows to return (default 30, max 100)."),
        }),
        execute: async ({ matchText, limit }) => {
          const effLimit = limit && limit > 0 ? Math.min(limit, 100) : 30;
          const effMatch = matchText && matchText.trim().length > 0 ? matchText : undefined;
          const where = effMatch
            ? and(needsReviewClause, or(like(sql`LOWER(${schema.transactions.description})`, `%${effMatch.toLowerCase()}%`), like(sql`LOWER(${schema.transactions.payee})`, `%${effMatch.toLowerCase()}%`)))
            : needsReviewClause;
          const rows = await db.query.transactions.findMany({
            where,
            limit: effLimit,
            orderBy: [sql`date DESC`],
          });
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
      }),
      previewMatches: tool({
        description: "Preview which pending transactions a categorization rule would affect. ALWAYS use this before bulkCategorize so the user can confirm.",
        parameters: z.object({
          matchText: z.string().describe("Substring to match against description and payee (case-insensitive)."),
        }),
        execute: async ({ matchText }) => {
          const m = matchText.toLowerCase();
          const where = and(
            needsReviewClause,
            or(
              like(sql`LOWER(${schema.transactions.description})`, `%${m}%`),
              like(sql`LOWER(${schema.transactions.payee})`, `%${m}%`),
            ),
          );
          const rows = await db.query.transactions.findMany({ where, orderBy: [sql`date DESC`], limit: 50 });
          return {
            totalMatching: rows.length,
            samples: rows.slice(0, 10).map((r) => ({
              date: r.date,
              amount: r.amount,
              description: r.description,
              currentCategory: r.category,
            })),
          };
        },
      }),
      bulkCategorize: tool({
        description: "Assign a category to all pending transactions matching a substring. Marks them as user-confirmed so they won't be re-categorized.",
        parameters: z.object({
          matchText: z.string().describe("Substring to match against description and payee (case-insensitive)."),
          category: z.string().describe("Exact category name from listCategories."),
        }),
        execute: async ({ matchText, category }) => {
          const validCats = new Set((await db.query.categories.findMany()).map((c) => c.name));
          if (!validCats.has(category)) {
            return { error: `Unknown category '${category}'. Valid categories: ${[...validCats].join(", ")}` };
          }
          const m = matchText.toLowerCase();
          const where = and(
            needsReviewClause,
            or(
              like(sql`LOWER(${schema.transactions.description})`, `%${m}%`),
              like(sql`LOWER(${schema.transactions.payee})`, `%${m}%`),
            ),
          );
          const result = await db
            .update(schema.transactions)
            .set({ category, categorySource: "user", categoryConfidence: "completely_sure" })
            .where(where);
          return { updated: result.changes, category, matchText };
        },
      }),
    },
    maxSteps: 8,
    onError: ({ error }) => {
      console.error("[categorize/chat] streamText error:", error);
    },
  });

  return result.toDataStreamResponse({
    getErrorMessage: (err) => {
      console.error("[categorize/chat] stream error:", err);
      return err instanceof Error ? err.message : String(err);
    },
  });
}
