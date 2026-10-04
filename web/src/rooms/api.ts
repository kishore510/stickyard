import { apiErrorSchema, createRoomResponseSchema } from "@stickyard/shared";
import { apiUrl } from "../config";

/*
 * The relay's HTTP API for rooms. The create passcode goes only in the POST body,
 * never in a URL or header, and is never stored.
 */

export type CreateError =
  | "invalid_passcode"
  | "rate_limited"
  | "creation_disabled"
  | "not_configured"
  | "bad_request"
  | "forbidden_origin"
  | "unreachable";

/** `hostToken` (protocol v12): kept on this device only, sent only in claimHost. */
export type CreateResult = { ok: true; code: string; hostToken: string } | { ok: false; error: CreateError; retryAfterSeconds?: number };

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** The browser's fetch, looked up when called (tests replace it). */
export const browserFetch: FetchFn = (input, init) => fetch(input, init);

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export async function createRoom(workerUrl: string, passcode: string, fetchFn: FetchFn): Promise<CreateResult> {
  let res: Response;
  try {
    res = await fetchFn(apiUrl(workerUrl, "/rooms").toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode }),
      credentials: "omit",
      cache: "no-store",
    });
  } catch {
    return { ok: false, error: "unreachable" };
  }

  const body = await readJson(res);
  if (res.status === 200) {
    const parsed = createRoomResponseSchema.safeParse(body);
    return parsed.success ? { ok: true, code: parsed.data.code, hostToken: parsed.data.hostToken } : { ok: false, error: "unreachable" };
  }

  const parsed = apiErrorSchema.safeParse(body);
  if (!parsed.success) return { ok: false, error: "unreachable" };
  switch (parsed.data.error) {
    case "rate_limited": {
      const retry = Number(res.headers.get("retry-after"));
      return Number.isInteger(retry) && retry > 0
        ? { ok: false, error: "rate_limited", retryAfterSeconds: retry }
        : { ok: false, error: "rate_limited" };
    }
    case "invalid_passcode":
    case "creation_disabled":
    case "not_configured":
    case "bad_request":
    case "forbidden_origin":
      return { ok: false, error: parsed.data.error };
    case "too_large":
      return { ok: false, error: "bad_request" };
    case "not_found":
      return { ok: false, error: "unreachable" };
  }
}

function waitText(seconds: number): string {
  if (seconds < 3600) {
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }
  const hours = Math.ceil(seconds / 3600);
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

/** Friendly text for a failed creation. Says no more than the relay's response did. */
export function createErrorMessage(result: Extract<CreateResult, { ok: false }>): string {
  switch (result.error) {
    case "invalid_passcode":
      return "That passcode didn’t work. Check it and try again.";
    case "rate_limited":
      return result.retryAfterSeconds
        ? `Too many attempts. Try again in ${waitText(result.retryAfterSeconds)}.`
        : "Too many attempts. Try again later.";
    case "creation_disabled":
      return "Starting new sessions is switched off at the moment. Joining an existing session still works.";
    case "not_configured":
      return "The relay isn’t set up to start sessions yet.";
    case "bad_request":
      return "That passcode couldn’t be sent. Check it and try again.";
    case "forbidden_origin":
      return "This copy of Stickyard isn’t allowed to start sessions.";
    case "unreachable":
      return "Couldn’t reach the Stickyard relay. Check your connection and try again.";
  }
}

export type CodeCheck = "valid" | "invalid" | "unreachable";

/** Asks the relay whether a code is validly signed (no room is touched). */
export async function checkRoom(workerUrl: string, code: string, fetchFn: FetchFn): Promise<CodeCheck> {
  const url = apiUrl(workerUrl, "/rooms/check");
  url.searchParams.set("room", code);
  try {
    const res = await fetchFn(url.toString(), { credentials: "omit", cache: "no-store" });
    if (res.status === 200) return "valid";
    return res.status === 404 ? "invalid" : "unreachable";
  } catch {
    return "unreachable";
  }
}
