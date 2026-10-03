import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { CREDIT_LIST } from "./src/about/creditList.ts";
import { bundledCredits, creditsFor, readCommit, type PackageJson } from "./src/build/buildInfo.ts";

// GitHub Pages serves the app under /<repo>/. CI sets BASE_PATH=/stickyard/; local dev uses "/".
const base = process.env.BASE_PATH ?? "/";

const readJson = (path: string): PackageJson => JSON.parse(readFileSync(path, "utf8")) as PackageJson;
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** A package's package.json from web/node_modules or the workspace root's (npm hoists most there). */
const installed = (name: string): PackageJson | undefined => {
  for (const dir of ["./node_modules/", "../node_modules/"]) {
    const path = here(`${dir}${name}/package.json`);
    if (existsSync(path)) return readJson(path);
  }
  return undefined;
};

// The app version is the repo's (root package.json). Read once per build; no runtime requests.
const rootPkg = readJson(here("../package.json"));
const webPkg = readJson(here("./package.json"));

const buildInfo = {
  __APP_VERSION__: JSON.stringify(rootPkg.version),
  __APP_COMMIT__: JSON.stringify(
    readCommit((command) => execSync(command, { stdio: ["ignore", "pipe", "ignore"] }).toString()),
  ),
  __APP_BUILD_DATE__: JSON.stringify(new Date().toISOString()),
  __APP_CREDITS__: JSON.stringify(creditsFor(CREDIT_LIST.map((c) => c.name), installed)),
  __APP_BUNDLED__: JSON.stringify(bundledCredits(webPkg, installed)),
};

export default defineConfig({
  base,
  plugins: [react(), tailwindcss()],
  define: buildInfo,
  test: { environment: "node" },
});
