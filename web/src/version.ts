import { PROTOCOL_VERSION } from "@stickyard/shared";

/*
 * Which build this is. Values are injected at build time (vite.config.ts);
 * nothing here makes a network request.
 */

const injected = (value: string | undefined, fallback: string) => (value ? value : fallback);

export interface VersionInfo {
  /** Semver from package.json, e.g. "0.2.0". */
  version: string;
  /** Short git commit SHA, or "dev" when git wasn't available at build time. */
  commit: string;
  /** ISO date and time of the build, or "" if unknown. */
  buildDate: string;
  /** The relay protocol this build speaks (shared PROTOCOL_VERSION). */
  protocolVersion: number;
}

export const VERSION_INFO: VersionInfo = {
  version: injected(typeof __APP_VERSION__ === "undefined" ? undefined : __APP_VERSION__, "0.0.0"),
  commit: injected(typeof __APP_COMMIT__ === "undefined" ? undefined : __APP_COMMIT__, "dev"),
  buildDate: injected(typeof __APP_BUILD_DATE__ === "undefined" ? undefined : __APP_BUILD_DATE__, ""),
  protocolVersion: PROTOCOL_VERSION,
};

export const APP_VERSION = VERSION_INFO.version;

/**
 * Plain text for bug reports ("Copy details" in About): version, build, protocol and
 * browser, and nothing else. Never add names, room codes or anything typed by a person.
 */
export function formatDetails(info: VersionInfo, userAgent: string): string {
  return [
    `Stickyard ${info.version}`,
    `Build: ${info.commit}`,
    `Protocol: v${info.protocolVersion}`,
    `Browser: ${userAgent || "unknown"}`,
  ].join("\n");
}
