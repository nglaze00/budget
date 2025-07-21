import asyncio
import datetime
import json
import random

from agents import RunContextWrapper, function_tool
from openai import OpenAI
from pydantic import BaseModel
from utils import TransactionsAnalysisContextSQL, get_table_schema, query_table

# TODO mypy


def query_answering_agent_instructions() -> str:
    """
    Instructions for the query answering agent.

    Returns:
        A string containing the instructions for the query answering agent.
    """
    return (
        "You are the Query Answering Agent, part of the Transactions Analysis agent system. Your role is to answer the user's query about their transactions, prioritizing mathematical accuracy and going above and beyond to infer what information might be useful to the user.\n"
        "\n"
        f"The current date is {datetime.datetime.now().strftime('%Y-%m-%d')}\n"
        "When you are invoked, perform the following steps to answer the user's query:\n"
        "1. If the user's question is ambiguous, ask for clarification before answering.\n"
        "2. If you haven't already, get the `transactions` table's schema using `get_table_schema`, and inspect the schema.\n"
        "3. If the query requires a subset of transactions within a topic not covered by the existing table columns, use `get_semantically_relevant_transactions`.\n"
        "   - The LIKE clause is not supported by the `relevant_transactions` table.\n"
        "   - If the query refers to a specific merchant who could probably be lexically matched in transaction descriptions, try that first before calling `get_semantically_relevant_transactions`.\n"
        "4. Use `query_table` to write SQL queries to help answer the user's query\n"
        "   - Prefer incremental queries producing non-aggregated intermediate tables, for better reasoning & explainability.\n"
        "   - Make all queries serially so that you can inspect the outcome of each one before continuing\n"
        "   - Before answering, make sure you use a `query_table` call without `output_table_name` so the user can read the final results of your queries.\n"
        "       - Make sure this last table is nicely formatted, including clear column names and decimal rounding\n"
        "5. Use the `plot` tool whenever feasible to visualize your answer to the user's query.\n"
        "   - e.g. Line plots for trends over time, bar plots for category comparisons, etc.\n"
        "6. Provide as your answer a summary of key findings, and suggest some follow-up questions the user might want to ask based on your capabilities\n"
        "   - Don't include raw data, tables or plots from `query_table` or `plot` outputs in your answer; the user can already see `query_table` results (when `output_table_name` is not used) and `plot` plots.\n"
        '       - Instead, summarize the key findings and refer the user to the relevant tables or plots "above" (not below) for details.\n'
        "   - Don't do arithmetic on your own; use the `math` tool to perform any necessary calculations on the results of your queries\n"
        "   - Don't over-explain the table contents, since they're usually self-explanatory.\n"
        "   - Use Markdown formatting to make your answer more readable (bold, underlines, etc.).\n"
    )


class RelevantTransactionsResponse(BaseModel):
    definitely_relevant_transaction_descriptions: list[str]
    # potentially_relevant_transactions: list[str]


class PotentiallyRelevantTransactionsResponse(BaseModel):
    potentially_relevant_transaction_descriptions: list[str]


@function_tool
async def get_semantically_relevant_transactions(
    context: RunContextWrapper[TransactionsAnalysisContextSQL], query: str
) -> str:
    """
    Get transactions semantically relevant to the query, based on their descriptions.
    Produces a `relevant_transactions` table that is already filtered by your query

    Args:
        query: The natural language query to search for relevant transactions, excluding all filters besides topic/description

    Returns:
        str: `relevant_transactions` table schema (if successful) or error message.
    """

    # 1) Split unique transaction descriptions+amounts into groups of 50
    transactions_df = context.context.execute_query(
        "SELECT transaction_key, amount, description FROM transactions ORDER BY description"
    )
    transaction_descriptions = list(transactions_df["description"].unique())
    random.shuffle(transaction_descriptions)

    transaction_description_groups = [
        transaction_descriptions[i : i + 400] for i in range(0, len(transaction_descriptions), 400)
    ]

    # 2) LLM call on each group to output {"definitely_relevant_transactions": [...], "potentially_relevant_transactions": [...]}
    llm_client = OpenAI()

    potentially_relevant_transaction_descriptions = set()
    # Run LLM calls for each group asynchronously

    async def get_potentially_relevant_keys(group, group_idx, total_groups):
        print(f"Group {group_idx + 1} / {total_groups}")
        response = llm_client.responses.parse(
            model="gpt-4.1",
            input=[
                {
                    "role": "system",
                    "content": "You are an expert financial analyst.",
                },
                {
                    "role": "user",
                    "content": f"Given the following transaction descriptions, identify the ones that are potentially relevant to include in the table that will answer the query: {query}\n- If you're not sure about a transaction, include it, since a final processing step will narrow down your output into the final set.\n- If no transactions are relevant, output an empty list.\nQuery: {query}\nTransactions: {group}.",
                },
            ],
            text_format=PotentiallyRelevantTransactionsResponse,
        )
        return response.output_parsed.potentially_relevant_transaction_descriptions

    tasks = [
        get_potentially_relevant_keys(group, i, len(transaction_description_groups))
        for i, group in enumerate(transaction_description_groups)
    ]
    results = await asyncio.gather(*tasks)
    for keys in results:
        potentially_relevant_transaction_descriptions.update(keys)

    potentially_relevant_transaction_descriptions = sorted(potentially_relevant_transaction_descriptions)

    # 3) Final LLM call to select the relevant transactions from the potentially relevant ones
    prompt = f"The following are transaction descriptions from a table of all of a user's personal transactions that were individually identified as potentially relevant to this query: {query}. Now, given the whole set of potentially relevant transactions, you can conclusively identify those that are necessary to include in the subset of transactions that will be aggregated to answer the query.\n\nRecall that this is the query: {query}\n\nNow, indicate the transactions from this list that are necessary to answer the query: {potentially_relevant_transaction_descriptions}."

    print(prompt)
    response = llm_client.responses.parse(
        model="gpt-4.1",
        input=[
            {
                "role": "system",
                "content": "You are an expert financial analyst.",
            },
            {
                "role": "user",
                "content": prompt,
            },
        ],
        text_format=RelevantTransactionsResponse,
    )

    # Parse response
    relevant_transaction_descriptions = response.output_parsed.definitely_relevant_transaction_descriptions

    # 4) Ask the user to confirm whether the potentially relevant transactions are actually relevant
    # TODO

    relevant_transaction_keys = [
        row["transaction_key"]
        for _, row in transactions_df.iterrows()
        if row.description in relevant_transaction_descriptions
    ]

    # 5) Produce table with relevant transactions
    # Properly escape the transaction keys for SQL
    escaped_keys = [key.replace("'", "''") for key in relevant_transaction_keys]
    quoted_keys = [f"'{key}'" for key in escaped_keys]
    relevant_transactions_query = f"SELECT * FROM transactions WHERE transaction_key IN ({', '.join(quoted_keys)})"

    print(f"Found {len(relevant_transaction_keys)} relevant transaction keys")
    print(f"Executing query: {relevant_transactions_query}")

    # Create the JSON payload with proper escaping
    json_payload = json.dumps({"sql_query": relevant_transactions_query, "output_table_name": "relevant_transactions"})

    result = await query_table.on_invoke_tool(context, json_payload)
    print(f"Query result: {result}")

    schema_result = await get_table_schema.on_invoke_tool(context, '{"table_name": "relevant_transactions"}')
    print(f"Schema result: {schema_result}")
    return f'{{"name": "get_semantically_relevant_transactions", "schema_result": {schema_result}}}'


# async def run_agent(agent, input):

#     # TODO make this
#     r = Runner.run_streamed(
#         starting_agent=agent,
#         context=context,
#         input=input,
#         session=session,
#         max_turns=2000,
#     )
#     async for event in r.stream_events():
#         # We'll ignore the raw responses event deltas
#         if event.type == "raw_response_event":
#             continue
#         # When the agent updates, print that
#         elif event.type == "agent_updated_stream_event":
#             print(f"Agent updated: {event.new_agent.name}")
#             continue
#         # When items are generated, print them
#         elif event.type == "run_item_stream_event":
#             if event.item.type == "tool_call_item":
#                 print(f"-- Tool was called: {event.item.raw_item}")
#             elif event.item.type == "tool_call_output_item":
#                 print(f"-- Tool output: {event.item.output}")
#             elif event.item.type == "message_output_item":
#                 print(f"-- Message output:\n {ItemHelpers.text_message_output(event.item)}")
#             else:
#                 pass  # Ignore other event types

#     return session

# Top-Line Summary
# • Total Income
# • Total Expenses
# • Net Cashflow (Income – Expenses)
# • Month-over-Month % change in each

# Income Detail
# • Breakdown by source (e.g. salary, refunds, interest)
# • Year-over-Year comparison (same month last year)

# Expense Detail
# • Pie chart or bar-chart by category (e.g. “Rent,” “Grocery,” “Subscriptions”)
# • Top 5 vendors/merchants by spend
# • Trend vs. prior month in each major category

# Cashflow & Balance Trends
# • Daily or weekly running-balance line chart
# • Weeks or days you dipped below your target buffer

# Variance vs. Budget (if you set one)
# • Where you overshot or underspent against planned limits

# Anomalies & Opportunities
# • Any unusually large or one-off charges to review
# • Subscriptions you didn’t use or could cancel
# • Categories where small savings could add up

# Key Take-Home Insights
# • “You spent 15% more on Dining than last month.”
# • “Your rent + utilities now eat up 42% of net income.”
# • “You had two big inflows mid-month that kept you afloat.”

# Next-Month Action Items
# • Recommendations (e.g. “Cap entertainment at $200,” “Automate a $500/month transfer to savings”)
# • Questions to ask yourself (“Was that Amazon charge expected?”)

# Adding simple visuals—those bar/pie charts and a net-balance line—helps it all stick. This one-pager then becomes your quick “health check” each month
