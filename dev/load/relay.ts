import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { localTarget } from "./target";

/*
 * A local relay for the load harness: `wrangler dev` on 127.0.0.1 with obviously fake secrets and
 * throwaway storage. Never the deployed Worker: every URL goes through localTarget, and nothing here
 * reads a real secret (.dev.vars is not used: --var values win).
 */

const WORKER_DIR = resolve(import.meta.dirname, "../../worker");
/** Obviously fake, local only. The harness signs room codes and host tokens with this key itself. */
export const FAKE_SIGNING_KEY = "load-signing-key-not-a-secret";
export const FAKE_PASSCODE = "load-passcode";
/** A browser origin the relay allows for local dev (any localhost port is allowed). */
export const LOCAL_ORIGIN = "http://localhost:5173";

export interface LocalRelay {
  url: URL;
  persist: string;
  /** Stops wrangler (the storage stays until `dispose`). */
  stop(): Promise<void>;
  /** Starts it again on the same storage (a "deploy"). */
  restart(): Promise<void>;
  dispose(): Promise<void>;
}

async function waitHealthy(url: URL, ms: number, log: () => string): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const res = await fetch(new URL("/health", url));
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`local relay did not start\n${log().slice(-3000)}`);
}

/** Starts `wrangler dev` on 127.0.0.1:`port`. */
export async function startLocalRelay(port = Number(process.env.LOAD_PORT ?? 8799)): Promise<LocalRelay> {
  const url = localTarget(`http://127.0.0.1:${port}`);
  const persist = mkdtempSync(join(tmpdir(), "stickyard-load-"));
  let child: ChildProcess | null = null;
  let log = "";
  const launch = async () => {
    log = "";
    child = spawn(
      "npx",
      [
        "wrangler",
        "dev",
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--persist-to",
        persist,
        "--var",
        `CREATE_PASSCODE:${FAKE_PASSCODE}`,
        "--var",
        `ROOM_SIGNING_KEY:${FAKE_SIGNING_KEY}`,
        "--var",
        "CREATION_ENABLED:true",
        "--show-interactive-dev-session=false",
      ],
      { cwd: WORKER_DIR, stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
    );
    child.stdout?.on("data", (d) => (log += d));
    child.stderr?.on("data", (d) => (log += d));
    await waitHealthy(url, 120_000, () => log);
  };
  const stop = async () => {
    const running = child;
    child = null;
    if (!running?.pid) return;
    const exited = new Promise<void>((done) => running.once("exit", () => done()));
    try {
      process.kill(-running.pid, "SIGTERM");
    } catch {
      return;
    }
    await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
    try {
      process.kill(-running.pid, "SIGKILL");
    } catch {
      // gone
    }
  };
  await launch();
  return {
    url,
    persist,
    stop,
    restart: launch,
    dispose: async () => {
      await stop();
      rmSync(persist, { recursive: true, force: true });
    },
  };
}
