import { defineConfig } from "vitest/config";

// The load harness's own unit tests (no relay needed); run by the root `npm test`.
export default defineConfig({
  test: { root: import.meta.dirname, include: ["test/**/*.test.ts"], environment: "node" },
});
