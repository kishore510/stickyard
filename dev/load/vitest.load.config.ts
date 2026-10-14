import { defineConfig } from "vitest/config";

// The load scenarios (npm run load): they start a local relay (wrangler dev, fake secrets,
// throwaway storage) and drive simulated pages against it. Never the deployed Worker.
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ["scenarios/**/*.load.ts"],
    environment: "node",
    globalSetup: ["./setup.ts"],
    testTimeout: 600_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
  define: { __APP_VERSION__: '"load"', __APP_COMMIT__: '"load"', __APP_BUILD_DATE__: '""', __APP_CREDITS__: "[]", __APP_BUNDLED__: "[]" },
});
