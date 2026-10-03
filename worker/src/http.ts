import type { ApiErrorCode } from "@stickyard/shared";

/** CORS headers for an allowed browser origin (none for curl or a refused origin). */
export function corsHeaders(origin: string | null): Record<string, string> {
  return origin ? { "access-control-allow-origin": origin, vary: "Origin" } : { vary: "Origin" };
}

export function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

/** API errors carry only a fixed code: never any of the request's input. */
export function apiError(error: ApiErrorCode, status: number, headers: Record<string, string> = {}): Response {
  return json({ error }, status, headers);
}

/** The single generic 404, identical for unknown paths and every invalid room code. */
export function notFound(): Response {
  return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
}

/** Reads at most `max` bytes of the body; null if it is (or claims to be) larger. */
export async function readCappedBody(request: Request, max: number): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > max) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
