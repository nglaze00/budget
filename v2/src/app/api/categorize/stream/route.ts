import { categorizeUncategorized } from "@/lib/categorize";

// Streams categorization progress as Server-Sent Events. Each event is JSON:
//   { type: "start", total }
//   { type: "progress", done, total, justCategorized: [...] }
//   { type: "done", total, categorized }
//   { type: "error", message }
// The review page subscribes to this so it can show a live progress bar AND
// surface low-confidence rows for the user to fix while categorization runs.
export const dynamic = "force-dynamic";

export async function GET() {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };
      try {
        let sentStart = false;
        const result = await categorizeUncategorized(async (p) => {
          if (!sentStart) {
            send({ type: "start", total: p.total });
            sentStart = true;
          }
          send({
            type: "progress",
            done: p.done,
            total: p.total,
            justCategorized: p.justCategorized,
          });
        });
        send({ type: "done", categorized: result.categorized, total: result.total });
      } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
