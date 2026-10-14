/*
 * The load harness only ever talks to a local relay (`wrangler dev` on this machine). Every URL it
 * connects to goes through localTarget first, so a typo or an environment variable can never point
 * it at the deployed Worker or the Pages site.
 */

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const PLAIN = new Set(["http:", "ws:"]);

/** The URL, if it is plain http/ws on this machine with no credentials; throws otherwise. */
export function localTarget(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("The load harness only runs against a local relay (not a URL).");
  }
  if (!PLAIN.has(parsed.protocol) || !LOCAL_HOSTS.has(parsed.hostname) || parsed.username !== "" || parsed.password !== "") {
    throw new Error("The load harness only runs against a local relay (http://127.0.0.1 or localhost).");
  }
  return parsed;
}
