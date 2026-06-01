import { eq, isNull, and, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { topMatches } from "./similarity";
import { generateObject, JsonSchema } from "./openai";

// Ported from the desktop app (src/lib/categorize.ts). The LLM call uses our fetch-based
// OpenAI client with a json_schema response format instead of the `ai` SDK.

const BATCH_SIZE = 50;
const EXAMPLES_PER_TXN = 2;

type Confidence = "unsure" | "somewhat_sure" | "mostly_sure" | "completely_sure";

interface Assignment {
  transaction_id: string;
  category: string;
  confidence: Confidence;
  alternatives: string[];
}

const RESULT_SCHEMA: JsonSchema = {
  name: "categorization",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      assignments: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            transaction_id: { type: "string" },
            category: { type: "string" },
            confidence: { type: "string", enum: ["unsure", "somewhat_sure", "mostly_sure", "completely_sure"] },
            alternatives: { type: "array", items: { type: "string" } },
          },
          required: ["transaction_id", "category", "confidence", "alternatives"],
        },
      },
    },
    required: ["assignments"],
  },
};

async function findExamples(batch: { transactionId: string; description: string | null; payee: string | null }[]) {
  const priorRows = await db.query.transactions.findMany({
    where: isNotNull(schema.transactions.category),
    orderBy: [sql`CASE WHEN category_source = 'user' THEN 0 ELSE 1 END`, sql`date DESC`],
    limit: 500,
  });

  const priors = priorRows.map((r) => ({
    text: `${r.description ?? ""} ${r.payee ?? ""}`.trim(),
    category: r.category!,
    source: r.categorySource,
    description: r.description,
    payee: r.payee,
    amount: r.amount,
  }));

  const examplesMap = new Map<string, typeof priors>();
  for (const t of batch) {
    const query = `${t.description ?? ""} ${t.payee ?? ""}`.trim();
    if (!query) { examplesMap.set(t.transactionId, []); continue; }
    const matches = topMatches(query, priors, (p) => p.text, EXAMPLES_PER_TXN, 0.25);
    examplesMap.set(t.transactionId, matches.map((m) => m.item));
  }
  return examplesMap;
}

export interface CategorizeProgress {
  done: number;
  total: number;
  batchSize: number;
  justCategorized: {
    transactionId: string;
    date: string;
    amount: number;
    description: string | null;
    payee: string | null;
    category: string;
    confidence: Confidence;
    needsReview: boolean;
    alternatives: string[];
  }[];
}

export async function categorizeUncategorized(
  onProgress?: (p: CategorizeProgress) => void | Promise<void>,
) {
  const categories = await db.query.categories.findMany();
  const validNames = new Set(categories.map((c) => c.name));
  const categoryDescription = categories.map((c) => `- ${c.name}: ${c.definition}`).join("\n");

  const pending = await db.query.transactions.findMany({
    where: isNull(schema.transactions.category),
  });
  if (pending.length === 0) return { categorized: 0, batches: 0, total: 0 };

  const total = pending.length;
  let categorized = 0;
  let batches = 0;

  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    const batchById = new Map(batch.map((t) => [t.transactionId, t]));

    const examplesMap = await findExamples(batch);

    const items = batch.map((t) => {
      const examples = examplesMap.get(t.transactionId) ?? [];
      return {
        transaction_id: t.transactionId,
        date: t.date,
        amount: t.amount,
        description: t.description,
        payee: t.payee,
        flow_type: t.flowType,
        similar_past_transactions: examples.map((e) => ({
          description: e.description,
          payee: e.payee,
          amount: e.amount,
          category: e.category,
          confirmed_by: e.source === "user" ? "user" : "auto",
        })),
      };
    });

    const object = await generateObject<{ assignments: Assignment[] }>({
      system:
        "You categorize personal-finance transactions. For each row pick the single best category " +
        "(use ONLY names from the list, verbatim, or 'Misc' if nothing fits) AND rate your confidence on a 4-level scale:\n" +
        "  - completely_sure: description clearly identifies a merchant/use-case matching the category\n" +
        "  - mostly_sure: pretty clear from context, only minor ambiguity\n" +
        "  - somewhat_sure: best guess but real ambiguity — the user will review these\n" +
        "  - unsure: description is too vague or ambiguous to tell — the user will review these\n\n" +
        "Use somewhat_sure when you have a plausible top pick but >1 category is genuinely reasonable. " +
        "Use mostly_sure when you're fairly confident and don't need the user to verify.\n" +
        "For unsure/somewhat_sure/mostly_sure rows, also return EXACTLY 2 plausible runner-up categories in `alternatives` " +
        "(in priority order, NOT including the primary `category`). Pick the 2 best alternatives even if you're " +
        "not super confident in them — the user wants 3 options total to click. For completely_sure rows, return [].\n" +
        "Each transaction may include `similar_past_transactions` — these are previously categorized " +
        "transactions with similar descriptions. Use them as strong hints, especially when confirmed_by='user'. " +
        "If a similar transaction was confirmed by the user into a category, prefer that category unless " +
        "the new transaction clearly belongs elsewhere.\n\n" +
        "Categories:\n" + categoryDescription,
      prompt:
        "Categorize each transaction. Amount sign: positive = money received, negative = money spent.\n\n" +
        JSON.stringify(items, null, 2),
      jsonSchema: RESULT_SCHEMA,
    });

    const justCategorized: CategorizeProgress["justCategorized"] = [];
    for (const a of object.assignments ?? []) {
      const category = validNames.has(a.category) ? a.category : "Misc";
      const alternatives = (a.alternatives ?? [])
        .filter((n) => validNames.has(n) && n !== category)
        .slice(0, 2);
      await db
        .update(schema.transactions)
        .set({
          category,
          categorySource: "llm",
          categoryConfidence: a.confidence,
          categoryAlternatives: alternatives.length > 0 ? JSON.stringify(alternatives) : null,
        })
        .where(and(
          eq(schema.transactions.transactionId, a.transaction_id),
          isNull(schema.transactions.category),
        ));
      categorized++;
      const t = batchById.get(a.transaction_id);
      if (t) {
        justCategorized.push({
          transactionId: t.transactionId,
          date: t.date,
          amount: t.amount,
          description: t.description,
          payee: t.payee,
          category,
          confidence: a.confidence,
          needsReview: a.confidence === "unsure" || a.confidence === "somewhat_sure",
          alternatives,
        });
      }
    }
    batches++;
    if (onProgress) await onProgress({ done: categorized, total, batchSize: batch.length, justCategorized });
  }

  return { categorized, batches, total };
}

export async function resetLlmCategories() {
  await db
    .update(schema.transactions)
    .set({ category: null, categorySource: null, categoryConfidence: null })
    .where(eq(schema.transactions.categorySource, "llm"));
}
