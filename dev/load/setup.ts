import type { TestProject } from "vitest/node";
import { startLocalRelay, type LocalRelay } from "./relay";

/* Starts one local relay for every scenario file, and stops it (and its storage) at the end. */
let relay: LocalRelay | null = null;

declare module "vitest" {
  export interface ProvidedContext {
    relayUrl: string;
    relayPersist: string;
  }
}

export async function setup(project: TestProject): Promise<void> {
  relay = await startLocalRelay();
  project.provide("relayUrl", relay.url.href);
  project.provide("relayPersist", relay.persist);
}

export async function teardown(): Promise<void> {
  await relay?.dispose();
}
