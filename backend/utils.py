import base64
import json
import sqlite3
from contextlib import contextmanager
from io import BytesIO
from typing import Iterator, Optional

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from agents import Agent, RunContextWrapper, Runner, function_tool


class TransactionsAnalysisContextSQL:
    def __init__(self, source_data_path: str, db_path: Optional[str] = None):
        # Database attributes
        self.source_data_path: str = source_data_path
        self.db_path: str = db_path or f"{source_data_path}transactions.db"

        # Initialize database connection
        self.init_database()

        # Agent attributes
        self.transaction_description_embeddings: Optional[dict] = None
        self.transactions_table_intermediate = None
        self.uncategorized_transactions: Optional[Iterator] = None
        self.uncategorized_transactions_category_examples: Optional[dict] = None
        self.current_uncategorized_transaction: Optional[str] = None

    def get_connection(self):
        """Get a connection to the SQLite database"""
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row  # Enable column access by name
        return connection

    def init_database(self):
        """Initialize the SQLite database and create tables if they don't exist"""
        with self.get_connection() as connection:
            # Create transactions table
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS transactions (
                    transaction_key TEXT PRIMARY KEY,
                    account TEXT,
                    posting_date DATE,
                    description TEXT,
                    amount REAL,
                    category TEXT
                )
            """
            )

            # Create categories reference table
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS category_definitions (
                    category_name TEXT PRIMARY KEY,
                    definition TEXT
                )
            """
            )

            # Insert category definitions
            categories = {
                "Income": "Money received from work, investments, or other sources",
                "Bills": "Mandatory, recurring payments",
                "Credit card payments": "Payments made to credit card accounts (or the received income version of those payments)",
                "Grocery": "Payments at grocery stores",
                "Solo necessary meals": "Meals I eat by myself, usually cheap/takeout",
                "Social food/drinks": "Restaurants / bars with friends",
                "Transit": "Getting around -- Rideshare, metro, bikeshare, etc.",
                "Travel": "Flights, Amtrak, hotels, etc.",
                "Entertainment": "Concerts, sports games, movies, etc.",
                "Venmo/ATM": "Venmo or ATM transactions",
                "Clothing": "Purchases at clothing stores / that are probably of clothing",
                "Shopping": "Non-clothing shopping",
                "Medical": "Medical expenses",
                "Exercise": "Gym, sports leagues, etc.",
                "Subscriptions": "Elective subscription payments",
                "Investments": "Transactions with investment accounts",
                "Misc": "Transactions that don't fit into any other category",
            }

            for category, definition in categories.items():
                connection.execute(
                    "INSERT OR REPLACE INTO category_definitions (category_name, definition) VALUES (?, ?)",
                    (category, definition),
                )

            connection.commit()

    @contextmanager
    def get_cursor(self):
        """Context manager for database operations"""
        connection = self.get_connection()
        cursor = connection.cursor()
        try:
            yield cursor
        finally:
            cursor.close()
            connection.close()

    def execute_query(self, query: str, params: Optional[tuple] = None) -> pd.DataFrame:
        """Execute a SELECT query and return results"""
        with self.get_connection() as connection:
            cursor = connection.cursor()
            if params:
                cursor.execute(query, params)
            else:
                cursor.execute(query)
            query_result = cursor.fetchall()
            return pd.DataFrame.from_records(
                query_result,
                columns=query_result[0].keys() if query_result else [],
            )

    def execute_update(self, query: str, params: Optional[tuple] = None, max_retries: int = 3) -> int:
        """Execute an UPDATE/INSERT/DELETE query with retry on busy database"""
        import time

        for attempt in range(max_retries):
            try:
                with self.get_connection() as connection:
                    cursor = connection.cursor()
                    if params:
                        cursor.execute(query, params)
                    else:
                        cursor.execute(query)
                    connection.commit()
                    return cursor.rowcount
            except sqlite3.OperationalError as e:
                if "database is locked" in str(e) and attempt < max_retries - 1:
                    time.sleep(0.1 * (2**attempt))  # Exponential backoff
                    continue
                raise


@function_tool
async def query_table(
    context: RunContextWrapper[TransactionsAnalysisContextSQL],
    sql_query: str,
    output_table_name: Optional[str] = None,
    output_table_column_types: Optional[list[list[str]]] = None,
) -> str:
    """
    Execute SQLite query on any of the available tables

    sql_query: SQLite query to run, with best-practice newlines and formatting
    output_table_name: Optional name for an output table to store results; if None, returns results directly.
        - Instead of starting with "CREATE TABLE", just supply `output_table_name` and this tool will handle table creation
    output_table_column_types: Provide whenever creating a new table as static column types for the output table
        - [["column_name", "column_type"], ...]
    """
    if output_table_name == "transactions":
        return json.dumps(
            {
                "name": "query_table",
                "error": "You cannot update the transactions table directly. Please use a different target table name.",
            }
        )

    try:
        if output_table_name:
            drop_table_query = f"DROP TABLE IF EXISTS {output_table_name}"

            if output_table_column_types:
                if sql_query.startswith(f"CREATE TABLE {output_table_name} ("):
                    # If the query already creates the table with specified column types, just execute it
                    create_table_query = sql_query
                elif sql_query.startswith(f"CREATE TABLE {output_table_name} AS"):
                    # if no column types, add them in from the argument
                    columns_definition = ", ".join(f"{col} {col_type}" for col, col_type in output_table_column_types)
                    create_table_statement = f"CREATE TABLE {output_table_name} ({columns_definition}) AS"
                    create_table_query = f"{create_table_statement}\n{sql_query}\n"
                else:
                    # if doesn't start with "CREATE TABLE", create the table with the specified column types
                    columns_definition = ", ".join(f"{col} {col_type}" for col, col_type in output_table_column_types)
                    create_table_statement = f"CREATE TABLE {output_table_name} ({columns_definition}) AS"
                    create_table_query = f"{create_table_statement}\n{sql_query}\n"
            else:
                if sql_query.startswith(f"CREATE TABLE"):
                    create_table_query = sql_query
                else:
                    # If the query doesn't create the table, create it with the schema of the query result
                    create_table_query = f"CREATE TABLE {output_table_name} AS\n{sql_query}\n"

            context.context.execute_update(drop_table_query)
            context.context.execute_update(create_table_query)

            # handle if table is empty
            if context.context.execute_query(f"SELECT COUNT(*) FROM {output_table_name}").iloc[0, 0] == 0:
                return json.dumps({"name": "query_table", "type": "empty_result"})

            new_schema = await get_table_schema.on_invoke_tool(context, f'{{"table_name": "{output_table_name}"}}')
            schema_data = json.loads(new_schema)
            return json.dumps({"name": "query_table", "type": "new_table_schema", "schema": schema_data["schema"]})
        else:
            # Execute the query and return results directly
            result_df = context.context.execute_query(sql_query)
            if result_df.empty:
                return json.dumps({"name": "query_table", "type": "empty_result"})

            # Replace NaNs with None for JSON compatibility
            result_df = result_df.replace({pd.NaT: None, pd.NA: None, np.nan: None})
            return json.dumps({"name": "query_table", "type": "result", "data": result_df.to_dict(orient="records")})
    except Exception as e:
        return json.dumps({"name": "query_table", "error": f"SQL Error: {str(e)}"})


@function_tool
def get_table_schema(context: RunContextWrapper[TransactionsAnalysisContextSQL], table_name: str) -> str:
    """
    Get the schema of the transactions table in dict format

    table_name: The name of the table to get the schema for
    """
    schema_query = f"PRAGMA table_info({table_name})"
    schema_info = context.context.execute_query(schema_query)

    schema_dict = {"table_name": table_name, "columns": []}
    for _, column in schema_info.iterrows():
        col_info = {
            "name": column["name"],
            "type": column["type"],
            "primary_key": bool(column["pk"]),
            "not_null": bool(column["notnull"]),
        }
        if column["name"] == "category":
            category_query = f"SELECT DISTINCT category FROM {table_name}"
            categories = context.context.execute_query(category_query)
            col_info["values"] = categories["category"].fillna("N/A").tolist()
        schema_dict["columns"].append(col_info)

    return json.dumps({"name": "get_table_schema", "schema": schema_dict})


@function_tool
def plot(
    context: RunContextWrapper[TransactionsAnalysisContextSQL],
    data_sql_query: str,
    type: str,
    x_col: str,
    y_cols: list[str],
    x_label: str,
    y_label: str,
    title: str,
    x_ticks: Optional[list[str]] = None,
    y_range: Optional[list[float]] = None,
) -> str:
    """
    Returns a plot of the data returned by the provided sql query

    Args:
        data_sql_query: SQLite query to run to get the data for the plot
        type: Type of matplotlib plot to create. "bar", "line", "scatter", etc.
        x_col: Column name (from query result) to use for the x-axis
        y_cols: List of column names (from query result) to use for the y-axis (y_cols[i] is plotted against x_cols[i])
        x_label: Label for the x-axis
        y_label: Label for the y-axis
        title: Title of the plot
        x_ticks: Optional; list of tick labels for the x-axis
        y_range: Optional; range of values for the y-axis
    """
    plot_df = context.context.execute_query(data_sql_query)
    if isinstance(y_cols, str):
        y_cols = [y_cols]

    x = plot_df[x_col]
    y_all = [plot_df[y_col] for y_col in y_cols]

    plt.figure(figsize=(10, 6))
    for y in y_all:
        if type == "bar":
            plt.bar(x, y, label=y.name if isinstance(y, pd.Series) else y)
        elif type == "line":
            plt.plot(x, y, label=y.name if isinstance(y, pd.Series) else y)
        elif type == "scatter":
            plt.scatter(x, y, label=y.name if isinstance(y, pd.Series) else y)
        else:
            return json.dumps({"name": "plot", "error": f"Unsupported plot type: {type}"})

    plt.xlabel(x_label)
    plt.ylabel(y_label)
    plt.title(title)

    # Set x-axis ticks and labels
    if x_ticks is not None:
        plt.xticks(ticks=range(len(x_ticks)), labels=x_ticks, rotation=45)
    else:
        # Use the actual x_data values as labels
        plt.xticks(ticks=range(len(x)), labels=x, rotation=45)

    if y_range is not None:
        plt.ylim(y_range)
    plt.legend()

    # return base64 string of the plot image
    buf = BytesIO()
    plt.savefig(buf, format="png")
    buf.seek(0)
    plot_base64 = base64.b64encode(buf.read()).decode("utf-8")
    plt.close()

    return json.dumps({"name": "plot", "plot_base64": plot_base64, "data": plot_df.to_dict(orient="records")})


@function_tool
def math(expr: str, round_to: Optional[int] = None) -> float:
    """
    Evaluate a mathematical expression and return the result.

    expr: The mathematical expression to evaluate, with Python syntax.
    round_to: Optional; if provided, the result will be rounded to this many decimal places.
    """
    try:
        result = eval(expr, {"__builtins__": None}, {})
        if isinstance(result, (int, float)):
            final_result = round(result, round_to) if round_to is not None else float(result)
            return json.dumps({"name": "math", "result": final_result})
        else:
            return json.dumps({"name": "math", "error": "Expression did not evaluate to a number."})
    except Exception as e:
        return json.dumps({"name": "math", "error": f"Error evaluating expression '{expr}': {e}"})


class TransactionsAgent(Agent):
    def __init__(self, name, instructions, tools, model, context):
        super().__init__(name=name, instructions=instructions, tools=tools, model=model)
        self.context = context

    async def run(self, session, input):
        """
        Run the agent with the given session and input.
        This method can be overridden to customize the agent's run behavior.
        """
        return await Runner.run(
            starting_agent=self,
            context=self.context,
            input=input,
            session=session,
            max_turns=100,
        )

    async def run_streamed(self, session, input):
        # This method can be overridden to customize the agent's run behavior
        runner = Runner.run_streamed(
            starting_agent=self,
            context=self.context,
            input=input,
            session=session,
            max_turns=100,
        )
        async for event in runner.stream_events():
            yield event
