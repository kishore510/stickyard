/** Secrets and the kill switch. Not in wrangler.jsonc, so not in the generated `Env`; any may be missing. */
export interface Secrets {
  CREATE_PASSCODE?: string | undefined;
  ROOM_SIGNING_KEY?: string | undefined;
  CREATION_ENABLED?: string | undefined;
}

export type WorkerEnv = Env & Secrets;

export type Config = { ok: true; passcode: string; signingKey: string } | { ok: false };

/** Slice 1 stub: tests first. */
export function readConfig(_env: Secrets): Config {
  throw new Error("not implemented");
}
