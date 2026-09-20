import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    // Tests share one emulator database, so they must not run concurrently
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
