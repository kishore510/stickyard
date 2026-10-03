import { DurableObject } from "cloudflare:workers";
import type { WorkerEnv } from "./env";

/** The one limiter instance's name. */
export const LIMITER_NAME = "global";

export type Decision = { outcome: "created" } | { outcome: "invalid" } | { outcome: "limited"; retryAfterSeconds: number };

/* Slice 1 stub: tests first. Implemented in the next commit. */
export async function clientKey(_ip: string, _signingKey: string): Promise<string> {
  throw new Error("not implemented");
}

export class Limiter extends DurableObject<WorkerEnv> {
  attempt(_client: string, _passcodeOk: boolean, _now: number): Decision {
    throw new Error("not implemented");
  }
}
