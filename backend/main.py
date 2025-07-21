import json
import os
from collections.abc import AsyncGenerator

import uvicorn
from agents import SQLiteSession
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from openai.types.responses import ResponseFunctionToolCall, ResponseOutputItemDoneEvent, ResponseTextDeltaEvent
from pydantic import BaseModel
from query_answering_agent import get_semantically_relevant_transactions, query_answering_agent_instructions
from requests import Response
from utils import TransactionsAgent, TransactionsAnalysisContextSQL, get_table_schema, math, plot, query_table

# Load environment variables from .env file
load_dotenv()

# Get OpenAI API key from environment variable
openai_api_key = os.getenv("OPENAI_API_KEY")
if not openai_api_key:
    raise ValueError("OPENAI_API_KEY environment variable is not set. Please check your .env file.")

app = FastAPI()

# Configure CORS to allow requests from your Next.js frontend
origins = [
    "http://localhost:3000",  # Your Next.js frontend URL
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Load your LLM model and related functions here
# Example:
# from your_llm_module import get_llm_response


chat_session = SQLiteSession("transactions")
context = TransactionsAnalysisContextSQL("../data/")

query_answering_agent = TransactionsAgent(
    name="query-answering-agent",
    instructions=query_answering_agent_instructions(),
    tools=[query_table, get_semantically_relevant_transactions, get_table_schema, math, plot],
    model="o4-mini",
    context=context,
)


class ChatRequest(BaseModel):
    user_message: str


@app.post("/chat")
async def chat(request: ChatRequest):
    result = await query_answering_agent.run(session=chat_session, input=request.user_message)

    return {
        "message": result.final_output,
        "new_items": result.new_items,
        "raw_responses": result.raw_responses[0].output,
    }


@app.post("/chatStream")
async def chat_stream(request: ChatRequest) -> StreamingResponse:
    runner = query_answering_agent.run_streamed(session=chat_session, input=request.user_message)

    async def event_stream() -> AsyncGenerator[str, None]:
        async for event in runner:
            # Debug: Print all event types to understand the flow
            print(f"DEBUG: Event type: {event.type}")
            if hasattr(event, "item"):
                print(f"DEBUG: Item type: {event.item.type if event.item else 'None'}")

            if event.type == "agent_updated_stream_event":
                pass
            elif event.type == "run_item_stream_event" and event.item.type == "tool_call_output_item":
                print("DEBUG: Tool call output received")
                yield f'{json.dumps({"type": "tool_call_output",
                                        "data": event.item.output})}\n'
            elif event.type == "raw_response_event":
                if isinstance(event.data, ResponseTextDeltaEvent):
                    yield f"{json.dumps({'type': 'message_chunk', 'data': event.data.delta})}\n"
                elif isinstance(event.data, ResponseOutputItemDoneEvent) and event.data.item.type == "function_call":
                    yield f"{json.dumps({
                        "type": "tool_call",
                        "name": event.data.item.name,
                        "arguments": event.data.item.arguments
                    })}\n"
                else:
                    # Debug: log all raw response events
                    print(f"DEBUG: Raw response event: {type(event.data)}, {event.data}")
                    yield f"{json.dumps({
                        'type': 'debug_raw_event',
                        'event_class': str(type(event.data)),
                        'data': str(event.data)[:200]  # Truncate long data
                    })}\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.post("/newChat")
async def new_chat():
    global chat_session
    chat_session = SQLiteSession("chat")
    return {"response": "New chat session started."}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)  # Run on port 8000, or any other port
