/** Secrets and the kill switch. Not in wrangler.jsonc, so not in the generated `Env`; any may be missing. */
export interface Secrets {
  CREATE_PASSCODE?: string | undefined;
  ROOM_SIGNING_KEY?: string | undefined;
  CREATION_ENABLED?: string | undefined;
}

export type WorkerEnv = Env & Secrets;

export type Config = { ok: true; passcode: string; signingKey: string } | { ok: false };

/** Fails closed: both secrets must be present and non-empty. */
export function readConfig(env: Secrets): Config {
  const passcode = env.CREATE_PASSCODE;
  const signingKey = env.ROOM_SIGNING_KEY;
  if (!passcode || !signingKey) return { ok: false };
  return { ok: true, passcode, signingKey };
}

/** The kill switch: creation is on only when CREATION_ENABLED is exactly "true". */
export function creationEnabled(env: Secrets): boolean {
  return env.CREATION_ENABLED === "true";
}
