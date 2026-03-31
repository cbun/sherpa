import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@sherpa/core": path.resolve(__dirname, "packages/core/src/index.ts"),
      "@sherpa/sdk": path.resolve(__dirname, "packages/sdk/src/index.ts")
    }
  },
  test: {
    include: ["packages/*/src/**/*.test.ts"]
  }
});
