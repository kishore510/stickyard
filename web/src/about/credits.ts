import type { Credit } from "../build/buildInfo";
import { CREDIT_LIST } from "./creditList";

/* Open-source credits, generated at build time from package metadata (vite.config.ts). */

const NAMED: Credit[] = typeof __APP_CREDITS__ === "undefined" ? [] : __APP_CREDITS__;

/** Every package bundled into the app, for the full list. */
export const BUNDLED: Credit[] = typeof __APP_BUNDLED__ === "undefined" ? [] : __APP_BUNDLED__;

export interface CreditRow {
  name: string;
  title: string;
  role: string;
  version: string;
  license: string;
}

/** The named credits with their purpose, licence and version. */
export const CREDITS: CreditRow[] = CREDIT_LIST.map((c) => {
  const found = NAMED.find((n) => n.name === c.name);
  return { ...c, version: found?.version ?? "", license: found?.license ?? "See package" };
});
