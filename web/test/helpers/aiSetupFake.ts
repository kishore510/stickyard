/*
 * Board setup from a prompt (10b, v0.43.0): canned streamed replies for the fake fetch. Generic
 * content only; fake keys only. Nothing here reaches the network.
 */

export const SETUP_KEY = "sk-ant-api03-FAKE-setup-test-key-0000stup";

const encoder = new TextEncoder();
const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** A retro with three frames and some notes, laid out in a grid by the "model". */
export const RETRO_REPLY = {
  frames: [
    { ref: "f1", title: "Went well", color: "green", x: 0, y: 0, w: 640, h: 440 },
    { ref: "f2", title: "To improve", color: "pink", x: 720, y: 0, w: 640, h: 440 },
    { ref: "f3", title: "Actions", color: "blue", x: 1440, y: 0, w: 640, h: 440 },
  ],
  notes: [
    { text: "Shipped on time", color: "green", frame: "f1", x: 24, y: 72 },
    { text: "Good pairing", color: "green", frame: "f1", x: 208, y: 72 },
    { text: "Fewer meetings", color: "pink", frame: "f2", x: 744, y: 72 },
    { text: "Clearer tickets", color: "pink", frame: "f2", x: 928, y: 72 },
    { text: "Book a demo slot", color: "blue", frame: "f3", x: 1464, y: 72 },
    { text: "Parking lot", color: "yellow", frame: null, x: 0, y: 520 },
  ],
};

/** The reply as SSE chunks: the JSON text split into a few deltas. */
export function setupStream(
  text: string,
  { stop = "end_turn", inputTokens = 900, outputTokens = 420, pieces = 3 }: { stop?: string; inputTokens?: number; outputTokens?: number; pieces?: number } = {},
): string[] {
  const size = Math.max(1, Math.ceil(text.length / pieces));
  const deltas: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    deltas.push(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(i, i + size) } }));
  }
  return [
    sse("message_start", { type: "message_start", message: { id: "msg_fake", type: "message", role: "assistant", content: [], model: "fake", stop_reason: null, usage: { input_tokens: inputTokens, output_tokens: 1 } } }),
    sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    ...deltas,
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: outputTokens } }),
    sse("message_stop", { type: "message_stop" }),
  ];
}

/** A streamed Response; `hold` keeps it open after the chunks until the request is aborted. */
export function streamResponse(chunks: string[], { hold = false }: { hold?: boolean } = {}, signal?: AbortSignal | null): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (!hold) controller.close();
      signal?.addEventListener("abort", () => controller.error(signal.reason ?? new DOMException("Aborted", "AbortError")));
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_fake_setup" } });
}
