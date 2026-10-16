/*
 * Redaction (v0.42.0): the one place every error detail, console call and thrown message under
 * src/ai goes through before it reaches the page. It removes every key seen this visit (registered
 * with rememberSecret), anything shaped like an Anthropic key (sk-ant-...), and any x-api-key value
 * in header, JSON or query form. Kept in memory only; a reload forgets the list (and the key).
 */

export const REDACTED = "[redacted]";

/** Shorter values are never registered, so redaction can't eat ordinary words. */
const MIN_SECRET = 8;

const secrets = new Set<string>();

/** Remembers a key seen this visit so redact removes it wherever it appears. */
export function rememberSecret(value: string): void {
  if (value.length >= MIN_SECRET) secrets.add(value);
}

const KEY_SHAPE = /sk-ant-[A-Za-z0-9_-]+/g;
// x-api-key: v / "x-api-key":"v" / 'x-api-key': 'v' / x-api-key=v (also x_api_key, any case).
const HEADER_VALUE = /(x[-_]api[-_]key["']?\s*[:=]\s*["']?)[^"'\s,&;}]+/gi;

export function redact(text: string): string {
  let out = text;
  for (const secret of secrets) {
    out = out.split(secret).join(REDACTED);
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) out = out.split(encoded).join(REDACTED);
  }
  return out.replace(KEY_SHAPE, REDACTED).replace(HEADER_VALUE, `$1${REDACTED}`);
}
