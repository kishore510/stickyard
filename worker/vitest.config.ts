import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Obviously fake values, for tests only. Real ones exist only as Worker secrets.
      miniflare: {
        bindings: {
          CREATE_PASSCODE: "test-passcode",
          ROOM_SIGNING_KEY: "test-signing-key-not-a-real-secret",
          CREATION_ENABLED: "true",
        },
      },
    }),
  ],
});
