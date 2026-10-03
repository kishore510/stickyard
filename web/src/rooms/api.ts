/* Slice 1 stub: tests first. Implemented in the next commit. */
export type CreateError =
  | "invalid_passcode"
  | "rate_limited"
  | "creation_disabled"
  | "not_configured"
  | "bad_request"
  | "forbidden_origin"
  | "unreachable";

export type CreateResult = { ok: true; code: string } | { ok: false; error: CreateError; retryAfterSeconds?: number };

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export async function createRoom(_workerUrl: string, _passcode: string, _fetchFn: FetchFn): Promise<CreateResult> {
  throw new Error("not implemented");
}

export function createErrorMessage(_result: Extract<CreateResult, { ok: false }>): string {
  throw new Error("not implemented");
}

export type CodeCheck = "valid" | "invalid" | "unreachable";

export async function checkRoom(_workerUrl: string, _code: string, _fetchFn: FetchFn): Promise<CodeCheck> {
  throw new Error("not implemented");
}
