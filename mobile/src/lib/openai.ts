import { getOpenAiKey, getModel } from "./settings";

// Minimal OpenAI client over plain fetch (works in React Native / Hermes, unlike the
// Node-oriented `ai` SDK). Covers the two things the app needs: structured-output
// generation (categorization) and tool-calling chat (the categorize assistant).

const ENDPOINT = "https://api.openai.com/v1/chat/completions";

export interface JsonSchema {
  name: string;
  schema: Record<string, unknown>;
}

// Structured output: returns the model's JSON parsed against a json_schema response format.
export async function generateObject<T>(opts: {
  system: string;
  prompt: string;
  jsonSchema: JsonSchema;
  model?: string;
}): Promise<T> {
  const key = await getOpenAiKey();
  const model = opts.model ?? (await getModel());
  const resp = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 1,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.prompt },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: opts.jsonSchema.name, schema: opts.jsonSchema.schema, strict: false },
      },
    }),
  });
  if (!resp.ok) throw new Error(`OpenAI error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const content: string = data.choices?.[0]?.message?.content ?? "{}";
  return JSON.parse(content) as T;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface ChatStep {
  type: "tool_call" | "tool_result" | "assistant";
  name?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  text?: string;
}

// Runs a tool-calling loop to completion (non-streaming). Returns the final assistant
// text plus a step log so the UI can show what tools ran. maxSteps caps the loop.
export async function chatWithTools(opts: {
  system: string;
  messages: ChatMessage[];
  tools: ToolDef[];
  model?: string;
  maxSteps?: number;
}): Promise<{ text: string; steps: ChatStep[] }> {
  const key = await getOpenAiKey();
  const model = opts.model ?? (await getModel());
  const maxSteps = opts.maxSteps ?? 8;
  const toolSpec = opts.tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  const byName = new Map(opts.tools.map((t) => [t.name, t]));

  const convo: ChatMessage[] = [{ role: "system", content: opts.system }, ...opts.messages];
  const steps: ChatStep[] = [];

  for (let i = 0; i < maxSteps; i++) {
    const resp = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, temperature: 1, messages: convo, tools: toolSpec }),
    });
    if (!resp.ok) throw new Error(`OpenAI error ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    const msg = data.choices?.[0]?.message;
    convo.push(msg);

    if (msg?.tool_calls?.length) {
      for (const call of msg.tool_calls) {
        const tool = byName.get(call.function.name);
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* ignore */ }
        steps.push({ type: "tool_call", name: call.function.name, args });
        let result: unknown;
        try {
          result = tool ? await tool.execute(args) : { error: `Unknown tool ${call.function.name}` };
        } catch (e) {
          result = { error: e instanceof Error ? e.message : String(e) };
        }
        steps.push({ type: "tool_result", name: call.function.name, result });
        convo.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }
      continue;
    }

    const text: string = msg?.content ?? "";
    steps.push({ type: "assistant", text });
    return { text, steps };
  }
  return { text: "(Stopped after reaching the step limit.)", steps };
}
