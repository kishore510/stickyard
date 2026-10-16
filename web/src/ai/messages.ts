import { redact } from "./redact";

/*
 * Every AI error the page can show (v0.42.0), in one table: a title, a message, a next step and
 * whether Retry is offered. Kinds mirror Chalkline's, with these changes: an empty credit balance
 * (a 400 from the API) is billing; "model unavailable" is only a 404 about the model; "blocked" is a
 * guess (CORS, ad blockers and DNS failures look the same); a cancelled or timed-out request that was
 * already sent can still be billed. Nothing here ever includes the key: Details go through redact.
 */

export const AI_ERROR_KINDS = [
  "no_key",
  "invalid_key",
  "permission",
  "billing",
  "rate_limited",
  "spend_limit",
  "overloaded",
  "server",
  "timeout",
  "too_large",
  "model_unavailable",
  "bad_request",
  "offline",
  "blocked",
  "cancelled",
  "malformed",
  "refused",
  "truncated",
] as const;

export type AiErrorKind = (typeof AI_ERROR_KINDS)[number];

/** What went wrong, from the client. API text is untrusted: shown only through errorDetails. */
export interface AiError {
  kind: AiErrorKind;
  status?: number | undefined;
  /** The API's error type, e.g. "authentication_error". */
  type?: string | undefined;
  apiMessage?: string | undefined;
  requestId?: string | undefined;
  /** From retry-after on a 429, in seconds. */
  retryAfterSeconds?: number | undefined;
}

export interface ErrorText {
  title: string;
  message: string;
  next: string;
  retry: boolean;
}

const UNCHANGED = "Nothing was changed on the board.";
const MAY_BILL = "A request that was already sent can still be billed.";

export const AI_ERRORS: Record<AiErrorKind, ErrorText> = {
  no_key: {
    title: "No key saved",
    message: "AI features need your own Anthropic API key.",
    next: "Add one in Settings, under AI (your own key).",
    retry: false,
  },
  invalid_key: {
    title: "Key not accepted",
    message: `Anthropic didn't accept this key. It may be mistyped, revoked or expired. ${UNCHANGED}`,
    next: "Check the key in the Claude Console, then replace it here.",
    retry: false,
  },
  permission: {
    title: "Not allowed for this key",
    message: `This key isn't allowed to use this model or feature. ${UNCHANGED}`,
    next: "Check the key's workspace and access settings in the Claude Console.",
    retry: false,
  },
  billing: {
    title: "Billing problem",
    message: `Anthropic refused the request because of billing: the account's credit balance may be too low, or a payment failed. ${UNCHANGED}`,
    next: "Check Billing in the Claude Console, then try again.",
    retry: true,
  },
  rate_limited: {
    title: "Too many requests",
    message: `Your Anthropic account hit a rate limit. ${UNCHANGED}`,
    next: "Wait a moment, then try again.",
    retry: true,
  },
  spend_limit: {
    title: "Spend limit reached",
    message: `Your Anthropic account or workspace has reached a spend limit. ${UNCHANGED}`,
    next: "Raise the limit in the Claude Console, or wait until it resets.",
    retry: true,
  },
  overloaded: {
    title: "Anthropic is busy",
    message: `Anthropic's API is overloaded right now. ${UNCHANGED}`,
    next: "Try again in a minute.",
    retry: true,
  },
  server: {
    title: "Anthropic had a problem",
    message: `Anthropic's API had an error of its own. ${UNCHANGED}`,
    next: "Try again in a minute.",
    retry: true,
  },
  timeout: {
    title: "No reply in time",
    message: `Nothing arrived from Anthropic for too long, so the page stopped waiting. ${MAY_BILL} ${UNCHANGED}`,
    next: "Try again; if it keeps happening, check your connection.",
    retry: true,
  },
  too_large: {
    title: "Too much to send",
    message: `The request was bigger than Anthropic accepts. ${UNCHANGED}`,
    next: "Send less, then try again.",
    retry: false,
  },
  model_unavailable: {
    title: "Model not available",
    message: `Anthropic says this model isn't available to your key. It may be retired, or not enabled for your organisation. ${UNCHANGED}`,
    next: "Check the models your organisation can use in the Claude Console.",
    retry: false,
  },
  bad_request: {
    title: "Request refused",
    message: `Anthropic couldn't use this request. ${UNCHANGED}`,
    next: "Try again; if it keeps happening, report it with the details below.",
    retry: true,
  },
  offline: {
    title: "You're offline",
    message: `This device isn't connected to the internet, so nothing was sent. ${UNCHANGED}`,
    next: "Reconnect, then try again.",
    retry: true,
  },
  blocked: {
    title: "Couldn't connect",
    message: "Could not reach the API. Your network or browser may be blocking it.",
    next: `Check that api.anthropic.com isn't blocked by an extension, a firewall or your network, then try again. ${UNCHANGED}`,
    retry: true,
  },
  cancelled: {
    title: "Cancelled",
    message: `You cancelled the request. ${MAY_BILL} ${UNCHANGED}`,
    next: "Send it again when you're ready.",
    retry: true,
  },
  malformed: {
    title: "Unexpected reply",
    message: `Anthropic's reply wasn't what the page expected, or it stopped part way. ${UNCHANGED}`,
    next: "Try again.",
    retry: true,
  },
  refused: {
    title: "Declined",
    message: `The model declined this request. ${UNCHANGED}`,
    next: "Change what you send, then try again.",
    retry: true,
  },
  truncated: {
    title: "Reply cut short",
    message: `The reply reached its length limit before it finished. ${UNCHANGED}`,
    next: "Send less, then try again.",
    retry: true,
  },
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The table's text for an error, with the wait from retry-after when there is one. */
export function describeError(error: AiError): ErrorText & { details: string } {
  const text = AI_ERRORS[error.kind];
  const wait =
    error.kind === "rate_limited" && error.retryAfterSeconds !== undefined
      ? `Try again in ${plural(Math.max(1, Math.ceil(error.retryAfterSeconds)), "second")}.`
      : null;
  return { ...text, next: wait ?? text.next, details: errorDetails(error) };
}

/** The Details line: HTTP status, error type, API message and request id, redacted. */
export function errorDetails(error: AiError): string {
  const parts: string[] = [];
  if (error.status !== undefined) parts.push(`HTTP ${error.status}`);
  if (error.type) parts.push(error.type);
  if (error.apiMessage) parts.push(error.apiMessage.slice(0, 300));
  if (error.requestId) parts.push(`request ${error.requestId}`);
  return redact(parts.length > 0 ? parts.join(" · ") : `No response (${error.kind})`);
}
