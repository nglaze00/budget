import { openai } from "@ai-sdk/openai";
import { streamText, tool, type CoreMessage } from "ai";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@/db";

// Chat agent with read-only SQL access to the budget DB.
export async function POST(req: Request) {
  const { messages, dashboardContext } = (await req.json()) as {
    messages: CoreMessage[];
    dashboardContext?: string | null;
  };

  const systemLines = [
    "You answer questions about the user's personal finances.",
    "You have one tool: queryDb, which runs a single read-only SQLite SELECT.",
    "Tables: connection, accounts, transactions, paycheck_splits, sync_state.",
    "SimpleFIN sign convention: transactions.amount > 0 means money IN, < 0 means money OUT.",
    "transactions.flow_type ∈ {spend, earn, transfer, cc_payment, unknown}.",
    "For 'spending', filter flow_type='spend' (amounts will be negative).",
    "For 'income', filter flow_type='earn' (or is_paycheck=1 for paychecks).",
    "For 'cash flow', JOIN accounts and filter accounts.account_type='depository'.",
  ];
  if (dashboardContext) {
    systemLines.push(
      "",
      "—— CURRENT DASHBOARD CONTEXT (what the user is looking at right now) ——",
      dashboardContext,
      "—— END DASHBOARD CONTEXT ——",
      "",
      "Use this context to resolve ambiguous references (e.g. \"this month\", \"top category\", \"that category I'm looking at\").",
      "But ALWAYS verify the actual numbers by querying the DB — the context above is a stale snapshot and only covers a few summary stats. For anything beyond simple confirmation of the visible numbers, use the queryDb tool.",
    );
  }

  const result = streamText({
    model: openai("gpt-5.5"),
    // gpt-5.5 only accepts temperature=1; the SDK default of 0.7 returns 400.
    temperature: 1,
    system: systemLines.join("\n"),
    messages,
    tools: {
      queryDb: tool({
        description: "Run a read-only SQLite SELECT against the budget DB.",
        parameters: z.object({ query: z.string().describe("A single SELECT statement.") }),
        execute: async ({ query }) => {
          const trimmed = query.trim().replace(/;+\s*$/, "");
          if (!/^select\b/i.test(trimmed) || /[;]/.test(trimmed)) {
            return { error: "Only a single SELECT statement is allowed." };
          }
          try {
            const rows = await db.all(sql.raw(trimmed));
            return { rows: rows.slice(0, 200) };
          } catch (e) {
            return { error: String(e) };
          }
        },
      }),
    },
    maxSteps: 5,
  });

  return result.toDataStreamResponse();
}
