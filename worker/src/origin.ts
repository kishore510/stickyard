/**
 * Browser Origin allow-list for the WebSocket endpoint.
 *
 * This stops *other websites* from using our relay from a visitor's browser,
 * because browsers always send a truthful Origin header on WebSocket upgrades.
 * It does NOT stop non-browser clients (curl, scripts), which can send any
 * Origin they like. Abuse limits elsewhere have to cover those.
 */

const DEV_HOSTS = new Set(["localhost", "127.0.0.1"]);

function toURL(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** A "bare origin" is exactly scheme://host[:port] with nothing else. */
function isBareOrigin(value: string, url: URL): boolean {
  return url.origin === value;
}

/** Parse the ALLOWED_ORIGINS env var (comma-separated). Entries that are not bare origins are dropped. */
export function parseAllowedOrigins(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => {
      const url = toURL(entry);
      return url !== null && isBareOrigin(entry, url);
    });
}

export function isAllowedOrigin(origin: string | null, allowed: readonly string[]): boolean {
  if (!origin) return false;
  const url = toURL(origin);
  if (!url || !isBareOrigin(origin, url)) return false;
  if (allowed.includes(origin)) return true;
  // Local dev: plain http on localhost / 127.0.0.1, any port.
  return url.protocol === "http:" && DEV_HOSTS.has(url.hostname);
}
